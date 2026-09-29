import type { IncomingMessage } from 'node:http';
import type { Prisma, VpnProfile } from '@prisma/client';
import { prisma } from '../database';
import { config } from '../config';
import { checkSession, consumeSessionProof, type BoundClaims } from './mobile-session-security';
import { verifyMobileProof } from './mobile-proof';
import { deviceAccessStatus, subscriptionAccessStatus } from './access-lifecycle';
import { refusAccesProprietaireClient } from './reseller-access';
import { configHashForProfile } from './config-hash';
import { decryptCanonical, verifyCanonicalHash, engineConfigFromCanonical } from './canonical-config';
import { issueRelayTicket, relayProfileEnabled, verifyRelayTicket, type RelayIdentity } from './ssh-relay-ticket';
import { TLSSocket } from 'node:tls';
import { relayUpstream } from './ssh-relay-transport';
import type { RelayGrant } from './ssh-relay';
import { MAINTENANCE_KEY, MAINTENANCE_ENABLED_VALUE, RESET_EXECUTION_KEY } from './reset-state';

export function readRelayProfile(profile: Pick<VpnProfile, 'canonicalConfig' | 'canonicalConfigHash'>) {
  if (!profile.canonicalConfig || !profile.canonicalConfigHash) throw new Error('RELAY_CANONICAL_REQUIRED');
  const plain = decryptCanonical(profile.canonicalConfig);
  if (!plain) throw new Error('RELAY_CONFIG_INVALID');
  const canonical = JSON.parse(plain);
  if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical) ||
      !verifyCanonicalHash(canonical, profile.canonicalConfigHash)) throw new Error('RELAY_CONFIG_INVALID');
  return relayUpstream(engineConfigFromCanonical(canonical));
}

async function entitlement(tx: Prisma.TransactionClient, identity: RelayIdentity) {
  if (identity.exp * 1000 <= Date.now()) throw new Error('RELAY_EXPIRED');
  const maintenance = await tx.setting.findMany({ where: { key: { in: [MAINTENANCE_KEY, RESET_EXECUTION_KEY] } } });
  if (maintenance.some(row => row.key === RESET_EXECUTION_KEY || row.value === MAINTENANCE_ENABLED_VALUE)) {
    throw new Error('RELAY_MAINTENANCE');
  }
  if (!await checkSession(identity, tx)) throw new Error('RELAY_SESSION_REQUIRED');
  const sub = await tx.subscription.findUnique({
    where: { id: identity.subscriptionId }, include: { profile: true, client: { include: { user: true } } },
  });
  if (!sub || sub.clientId !== identity.clientId || sub.client.userId !== identity.userId ||
      sub.deviceId !== identity.deviceId || sub.client.deviceId !== identity.deviceId ||
      deviceAccessStatus(sub.client) !== 'active' || subscriptionAccessStatus(sub) !== 'active' ||
      await refusAccesProprietaireClient(tx, sub.client) || !sub.profile ||
      !relayProfileEnabled(sub.profile) || configHashForProfile(sub.profile) !== identity.configHash) {
    throw new Error('RELAY_ACCESS_DENIED');
  }
  return sub;
}

export async function authorizeRelayBinding(
  tx: Prisma.TransactionClient, token: string, claims: BoundClaims, subscriptionId: string | null,
): Promise<string> {
  const identity = verifyRelayTicket(token, config.JWT_SECRET);
  if (identity.userId !== claims.userId || identity.clientId !== claims.clientId ||
      identity.deviceId !== claims.deviceId || identity.sid !== claims.sid || identity.sg !== claims.sg ||
      identity.kid !== claims.kid || identity.subscriptionId !== subscriptionId) throw new Error('RELAY_BINDING_MISMATCH');
  await entitlement(tx, identity);
  return identity.configHash;
}

export async function renewRelayTicket(tx: Prisma.TransactionClient, token: string, claims: BoundClaims) {
  const identity = verifyRelayTicket(token, config.JWT_SECRET, true);
  if (identity.userId !== claims.userId || identity.clientId !== claims.clientId ||
      identity.deviceId !== claims.deviceId || identity.sid !== claims.sid || identity.sg !== claims.sg ||
      identity.kid !== claims.kid) throw new Error('RELAY_BINDING_MISMATCH');
  const bound = await checkSession(identity, tx);
  if (!bound?.session.authExpiresAt) throw new Error('RELAY_SESSION_REQUIRED');
  await entitlement(tx, { ...identity, exp: Math.floor(bound.session.authExpiresAt.getTime() / 1000) });
  return issueRelayTicket(identity, config.JWT_SECRET, bound.session.authExpiresAt.getTime());
}

export async function authorizeSshRelay(req: IncomingMessage): Promise<RelayGrant> {
  if (!prisma) throw new Error('RELAY_DATABASE_REQUIRED');
  if (!(req.socket instanceof TLSSocket) &&
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '')) {
    throw new Error('RELAY_TLS_PROXY_REQUIRED');
  }
  const token = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/.exec(req.headers.authorization || '')?.[1];
  if (!token) throw new Error('RELAY_TICKET_REQUIRED');
  const identity = verifyRelayTicket(token, config.JWT_SECRET);
  const get = (name: string) => {
    const value = req.headers[name.toLowerCase()];
    return typeof value === 'string' ? value : undefined;
  };
  if (get('X-SXB-Device-ID') !== identity.deviceId) throw new Error('RELAY_DEVICE_MISMATCH');
  const url = new URL(req.url || '/', 'http://relay.invalid');
  const connectionId = url.searchParams.get('connectionId') || '';
  if (!/^[0-9a-f-]{36}$/i.test(connectionId) || [...url.searchParams.keys()].join(',') !== 'connectionId') {
    throw new Error('RELAY_CONNECTION_REQUIRED');
  }
  const binding = async (tx: Prisma.TransactionClient) => {
    const row = await tx.mobileConnection.findUnique({ where: { id: connectionId } });
    if (!row || row.closedAt || row.clientId !== identity.clientId || row.deviceId !== identity.deviceId ||
        row.authSessionId !== identity.sid || row.authGeneration !== identity.sg ||
        row.subscriptionId !== identity.subscriptionId || row.relayConfigHash !== identity.configHash) {
      throw new Error('RELAY_BINDING_MISMATCH');
    }
  };
  const bound = await checkSession(identity);
  if (!bound?.client.devicePublicKey) throw new Error('RELAY_DEVICE_KEY_REQUIRED');
  const proof = verifyMobileProof({
    method: req.method || '', originalUrl: req.url || '', rawBody: Buffer.alloc(0), get,
  }, bound.client.devicePublicKey, token, identity);
  const sub = await prisma.$transaction(async tx => {
    await consumeSessionProof(tx, identity, proof);
    await binding(tx);
    return entitlement(tx, identity);
  }, { maxWait: 2000, timeout: 5000 });
  const upstream = readRelayProfile(sub.profile);
  return {
    clientId: identity.clientId, upstream, expiresAt: identity.exp * 1000,
    revalidate: async () => {
      if (!prisma) throw new Error('RELAY_DATABASE_REQUIRED');
      await prisma.$transaction(async tx => {
        await binding(tx);
        await entitlement(tx, identity);
      }, { maxWait: 2000, timeout: 5000 });
      return true;
    },
    account: async (upload, download) => {
      if (!prisma || !Number.isSafeInteger(upload) || !Number.isSafeInteger(download) ||
          upload < 0 || download < 0 || upload + download > 1024 * 1024) throw new Error('RELAY_USAGE_INVALID');
      const bytes = BigInt(upload + download);
      if (!bytes) return;
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM vpn_clients WHERE id = ${identity.clientId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM activation_sessions WHERE id = ${identity.sid} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM subscriptions WHERE id = ${identity.subscriptionId} FOR UPDATE`;
        await binding(tx);
        const current = await entitlement(tx, identity);
        if (current.quotaBytes > 0n && current.quotaUsed + bytes > current.quotaBytes) throw new Error('RELAY_QUOTA_EXHAUSTED');
        await tx.subscription.update({ where: { id: current.id }, data: { quotaUsed: { increment: bytes } } });
        await tx.vpnClient.update({ where: { id: identity.clientId }, data: { quotaUsed: { increment: bytes } } });
        await tx.trafficUsage.upsert({
          where: { reportKey: `relay:${connectionId}` },
          create: {
            reportKey: `relay:${connectionId}`, clientId: identity.clientId, accountId: current.id,
            deviceId: identity.deviceId, accountType: 'subscription',
            upload: BigInt(upload), download: BigInt(download),
          },
          update: {
            upload: { increment: BigInt(upload) }, download: { increment: BigInt(download) }, timestamp: new Date(),
          },
        });
      }, { maxWait: 2000, timeout: 5000 });
    },
  };
}

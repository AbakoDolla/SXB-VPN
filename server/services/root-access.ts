import { sign } from 'node:crypto';
import { rootSigningIdentity } from '../../scripts/root-approval-key.cjs';
import type { Prisma, RootDeviceApproval } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../database';
import { consumeProof, publicDeviceKey, verifyMobileProof, type ProofRequest } from './mobile-proof';
import { porteeClients, type Requerant } from './portee-donnees';
import { persistSecurityEvent } from './security-events';

export const ROOT_ACCESS_CREDENTIAL = 'SXB-ROOT-ACCESS-1';
export const ROOT_ACCESS_LEASE_MS = 24 * 60 * 60 * 1000;
export const ROOT_ACCESS_VERSION = 1;
export const rootObservationSchema = z.object({
  publicKey: z.string().min(100).max(256),
  rooted: z.literal(true),
  deviceModel: z.string().trim().max(80).optional(),
  appVersion: z.string().trim().max(40).optional(),
}).strict();
export const rootDecisionSchema = z.object({
  status: z.enum(['approved', 'denied']),
  revision: z.number().int().positive(),
}).strict();

export class RootAccessError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}

function signingIdentity() {
  return rootSigningIdentity(process.env.ROOT_APPROVAL_SECRET);
}

export function rootReceipt(row: Pick<RootDeviceApproval, 'keyId' | 'status' | 'revision'>, now = Date.now()) {
  const payload = JSON.stringify({
    scope: ROOT_ACCESS_CREDENTIAL, version: ROOT_ACCESS_VERSION, keyId: row.keyId,
    status: row.status, revision: row.revision, issuedAt: now, expiresAt: now + ROOT_ACCESS_LEASE_MS,
  });
  const signer = signingIdentity();
  return { payload, signature: sign('sha256', Buffer.from(payload), signer.key).toString('base64'),
    publicKey: signer.publicKey };
}

export function rootAuthorityKeyId(): string {
  return rootSigningIdentity(process.env.ROOT_APPROVAL_SECRET).keyId;
}

export async function observeRootDevice(request: ProofRequest, input: unknown) {
  if (!prisma) throw new RootAccessError(503, 'ROOT_ACCESS_UNAVAILABLE');
  const body = rootObservationSchema.parse(input);
  const { key, keyId } = publicDeviceKey(body.publicKey);
  const encodedKey = key.export({ format: 'der', type: 'spki' }).toString('base64');
  const proof = verifyMobileProof(request, body.publicKey, ROOT_ACCESS_CREDENTIAL, { kid: keyId });
  if (proof.keyId !== keyId) throw new RootAccessError(403, 'ROOT_KEY_CONFLICT');
  return prisma.$transaction(async tx => {
    await consumeProof(tx, proof);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`root:${keyId}`}))::text`;
    const clients = await tx.vpnClient.findMany({
      where: { deviceKeyId: keyId }, select: { id: true, userId: true, deviceId: true }, take: 2,
    });
    const client = clients.length === 1 ? clients[0] : null;
    const previous = await tx.rootDeviceApproval.findUnique({ where: { keyId } });
    if (previous && previous.publicKey !== encodedKey) throw new RootAccessError(409, 'ROOT_KEY_CONFLICT');
    const row = await tx.rootDeviceApproval.upsert({
      where: { keyId },
      create: { keyId, publicKey: encodedKey, clientId: client?.id, deviceModel: body.deviceModel,
        appVersion: body.appVersion, status: 'pending' },
      update: { lastSeenAt: new Date(), clientId: client?.id ?? null,
        deviceModel: body.deviceModel, appVersion: body.appVersion },
    });
    if (!previous && client) await persistSecurityEvent(tx, {
      eventType: 'ROOT_ACCESS_REQUESTED', severity: 'warning', userId: client?.userId,
      deviceId: client?.deviceId, actionTaken: 'ROOT_APPROVAL_REQUIRED',
      metadata: { target: keyId, deviceModel: body.deviceModel, evidence: 'client_observation' },
    });
    return rootReceipt(row);
  }, { maxWait: 2000, timeout: 5000 });
}

async function rootScope(tx: Prisma.TransactionClient, actor: Requerant): Promise<Prisma.RootDeviceApprovalWhereInput> {
  if (!actor.userId) throw new RootAccessError(404, 'NOT_FOUND');
  if (actor.role === 'OWNER') return {};
  if (actor.role !== 'SUPER_ADMIN') throw new RootAccessError(404, 'NOT_FOUND');
  const scope = await porteeClients(tx, actor);
  return { client: { is: scope as Prisma.VpnClientWhereInput } };
}

export async function listRootDevices(actor: Requerant, query: unknown) {
  if (!prisma) throw new RootAccessError(503, 'ROOT_ACCESS_UNAVAILABLE');
  const { status, search, limit, offset } = z.object({
    status: z.enum(['pending', 'approved', 'denied']).optional(),
    search: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).max(1000000).default(0),
  }).parse(query);
  return prisma.$transaction(async tx => {
    const where: Prisma.RootDeviceApprovalWhereInput = { AND: [
      await rootScope(tx, actor), ...(status ? [{ status }] : []),
      ...(search ? [{ OR: [
        { keyId: { startsWith: search.toLowerCase() } },
        { deviceModel: { contains: search, mode: 'insensitive' as const } },
        { client: { is: { user: { name: { contains: search, mode: 'insensitive' as const } } } } },
      ] }] : []),
    ] };
    const [devices, total] = await Promise.all([
      tx.rootDeviceApproval.findMany({
        where, take: limit, skip: offset, orderBy: [{ lastSeenAt: 'desc' }, { keyId: 'asc' }],
        select: { keyId: true, status: true, revision: true, deviceModel: true, appVersion: true,
          firstSeenAt: true, lastSeenAt: true, decidedAt: true,
          client: { select: { id: true, deviceId: true, user: { select: { name: true } } } } },
      }),
      tx.rootDeviceApproval.count({ where }),
    ]);
    return { devices, total, limit, offset, offlineHours: ROOT_ACCESS_LEASE_MS / 3600000,
      canApproveUnassigned: actor.role === 'OWNER' };
  });
}

export async function decideRootDevice(actor: Requerant, keyId: string, input: unknown) {
  if (!prisma) throw new RootAccessError(503, 'ROOT_ACCESS_UNAVAILABLE');
  if (!/^[a-f0-9]{64}$/.test(keyId)) throw new RootAccessError(400, 'ROOT_KEY_INVALID');
  const decision = rootDecisionSchema.parse(input);
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`root:${keyId}`}))::text`;
    const captured = await tx.rootDeviceApproval.findUnique({ where: { keyId }, select: { clientId: true } });
    if (captured?.clientId) {
      await tx.$queryRaw`SELECT id FROM vpn_clients WHERE id = ${captured.clientId} FOR SHARE`;
    }
    const row = await tx.rootDeviceApproval.findFirst({ where: { keyId, ...await rootScope(tx, actor) } });
    if (!row) throw new RootAccessError(404, 'NOT_FOUND');
    if (row.revision !== decision.revision) throw new RootAccessError(409, 'ROOT_DECISION_CHANGED');
    const updated = await tx.rootDeviceApproval.update({
      where: { keyId }, data: { status: decision.status, revision: { increment: 1 },
        decidedAt: new Date(), decidedById: actor.userId },
    });
    await tx.auditLog.create({ data: { userId: actor.userId,
      action: `Root device ${keyId}: ${decision.status}`, type: 'warning', visibleOwnerOnly: actor.role === 'OWNER' } });
    await persistSecurityEvent(tx, {
      eventType: decision.status === 'approved' ? 'ROOT_ACCESS_APPROVED' : 'ROOT_ACCESS_DENIED',
      severity: 'warning', userId: actor.userId,
      actionTaken: decision.status === 'approved' ? 'ROOT_DEVICE_APPROVED' : 'ROOT_APPROVAL_REQUIRED',
      metadata: { target: keyId, role: actor.role, evidence: 'dashboard_decision' },
    });
    return { keyId: updated.keyId, status: updated.status, revision: updated.revision };
  }, { maxWait: 2000, timeout: 5000 });
}

export async function clientRootAccessAllowed(keyId: string | null | undefined): Promise<boolean> {
  if (!keyId) return true;
  if (!prisma) throw new RootAccessError(503, 'ROOT_ACCESS_UNAVAILABLE');
  const row = await prisma.rootDeviceApproval.findUnique({ where: { keyId }, select: { status: true } });
  return !row || row.status === 'approved';
}

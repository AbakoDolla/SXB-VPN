import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Request } from 'express';
import type { ActivationSession, Prisma, PrismaClient, VpnClient } from '@prisma/client';
import { prisma } from '../database';
import { config } from '../config';
import { consumeProof, digest, publicDeviceKey, securityFailure, verifyMobileProof, type SecurityClaims, type VerifiedProof } from './mobile-proof';
import { accessStateHub } from './access-state-events';
import { MobileAccessError } from './access-lifecycle';
import { recordSecurityEvent, type SecurityEventType } from './security-events';
import { lockActivationClaim } from './device-activation';

export type BoundClaims = SecurityClaims & { userId: string; clientId?: string; deviceId?: string };
export const REFRESH_RETRY_MS = 120_000;

export async function recordMobileSecurityRefusal(error: unknown, claims: Partial<BoundClaims> | undefined) {
  if (!(error instanceof MobileAccessError) || !claims?.userId || !error.body.reason) return;
  const reason = error.body.reason;
  const duplicate = reason === 'NONCE_REUSED' || reason === 'REFRESH_RETRY_EXPIRED';
  const eventType: SecurityEventType | null = duplicate ? 'TOKEN_REPLAY'
    : reason === 'SESSION_REPLAY' ? 'SESSION_REPLAY'
    : ['DEVICE_MISMATCH', 'DEVICE_PROOF_REQUIRED', 'DEVICE_PROOF_INVALID'].includes(reason) ? 'DEVICE_MISMATCH' : null;
  if (!eventType) return;
  // A refused request is not proof that the legitimate key holder is hostile.
  // In particular an attacker with only a bearer must not gain a revoke oracle.
  await recordSecurityEvent({
    eventType, severity: duplicate ? 'info' : 'warning', userId: claims.userId,
    deviceId: claims.deviceId, sessionId: claims.sid, sessionGeneration: claims.sg,
    riskLevel: duplicate ? 'LOW' : 'MEDIUM', actionTaken: 'REQUEST_DENIED',
    metadata: { reason, evidence: duplicate ? 'duplicate_or_late_request' : 'authority_not_established' },
  });
}

export async function checkSession(claims: BoundClaims, tx: PrismaClient | Prisma.TransactionClient | null = prisma) {
  if (!tx) {
    if (claims.sid || claims.kid) throw new Error('SECURITY_DATABASE_REQUIRED');
    return null;
  }

  const client = claims.clientId ? await tx.vpnClient.findUnique({ where: { id: claims.clientId } }) : null;
  if (!client?.deviceKeyId) {
    if (claims.sid || claims.kid) securityFailure('SESSION_REPLAY');
    return null; // Explicit legacy cohort: no enrolled key, no security claims.
  }
  if (!claims.sid || !Number.isSafeInteger(claims.sg) || !claims.kid ||
      client.userId !== claims.userId || client.deviceId !== claims.deviceId ||
      client.deviceKeyId !== claims.kid) securityFailure('DEVICE_MISMATCH');
  const session = await tx.activationSession.findUnique({ where: { id: claims.sid } });
  if (!session || session.clientId !== client.id || session.deviceId !== client.deviceId ||
      session.authGeneration !== claims.sg || session.authRevokedAt ||
      !session.authExpiresAt || session.authExpiresAt.getTime() <= Date.now()) securityFailure('SESSION_REPLAY');
  return { client, session };
}

export async function consumeSessionProof(tx: Prisma.TransactionClient, claims: BoundClaims, proof?: VerifiedProof) {
  if (!claims.sid) return null;
  if (!proof || !claims.clientId) securityFailure('DEVICE_PROOF_REQUIRED');
  // Every authenticated mutation takes locks in the same order as enrollment.
  await tx.$queryRaw`SELECT id FROM vpn_clients WHERE id = ${claims.clientId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM activation_sessions WHERE id = ${claims.sid} FOR UPDATE`;
  const current = await checkSession(claims, tx);
  if (!current) securityFailure('SESSION_REPLAY');
  await consumeProof(tx, proof);
  return current;
}

export function sessionTokens(client: VpnClient, session: ActivationSession) {
  if (!session.refreshJti || !session.refreshIssuedAt || !session.authExpiresAt) throw new Error('SESSION_STATE_INVALID');
  const iat = Math.floor(session.refreshIssuedAt.getTime() / 1000);
  const exp = Math.floor(session.authExpiresAt.getTime() / 1000);
  const claims = {
    userId: client.userId, clientId: client.id, deviceId: client.deviceId,
    role: 'CLIENT', permissions: [], sid: session.id, sg: session.authGeneration,
    kid: client.deviceKeyId, rg: session.refreshGeneration, jti: session.refreshJti, iat,
  };
  return {
    accessToken: jwt.sign({ ...claims, exp: Math.min(iat + 900, exp) }, config.JWT_SECRET, { algorithm: 'HS256' }),
    refreshToken: jwt.sign({ ...claims, exp }, config.REFRESH_SECRET, { algorithm: 'HS256' }),
    security: { version: 1, sessionId: session.id, generation: session.authGeneration,
      keyId: client.deviceKeyId, clientId: client.id },
  };
}

export interface ActivationProofBody {
  token: string; deviceId?: string; publicKey?: string; activationRequestId?: string; enrollmentGrant?: string;
}

export async function activateBoundSession(req: Request, original: VpnClient, body: ActivationProofBody) {
  if (!prisma) throw new Error('SECURITY_DATABASE_REQUIRED');
  if (!body.deviceId || !body.publicKey || !body.activationRequestId ||
      !/^[0-9a-f-]{36}$/i.test(body.activationRequestId)) securityFailure('DEVICE_ENROLLMENT_REQUIRED', 409);
  const { deviceId, publicKey, activationRequestId } = body;
  const { keyId } = publicDeviceKey(body.publicKey);
  const proof = verifyMobileProof(req, body.publicKey, body.token, {});
  return prisma.$transaction(async tx => {
    await lockActivationClaim(tx, original, deviceId);
    const client = await tx.vpnClient.findUniqueOrThrow({ where: { id: original.id } });
    if (client.managedById !== original.managedById || client.resellerId !== original.resellerId ||
        client.userId !== original.userId) securityFailure('ACTIVATION_CONFLICT', 409);
    if (client.status !== 'active' || (client.activatedAt && client.deviceId !== deviceId)) securityFailure('DEVICE_MISMATCH');
    if (!client.activatedAt) {
      const scope = client.managedById ? { managedById: client.managedById }
        : client.resellerId ? { managedById: null, resellerId: client.resellerId }
        : { managedById: null, resellerId: null, userId: client.userId };
      const conflict = await tx.vpnClient.findFirst({
        where: { ...scope, deviceId, id: { not: client.id } }, select: { id: true },
      });
      if (conflict) securityFailure('DEVICE_CLAIMED_BY_ANOTHER_ACCOUNT', 409);
    }
    if (client.deviceKeyId !== keyId && client.activatedAt) {
      if (!client.enrollmentGrantHash || digest(keyId) !== client.enrollmentGrantHash ||
          !client.enrollmentGrantExpiresAt || client.enrollmentGrantExpiresAt.getTime() <= Date.now()) {
        securityFailure('DEVICE_ENROLLMENT_AUTHORIZATION_REQUIRED', 409);
      }
    }
    await consumeProof(tx, proof);
    const bound = await tx.vpnClient.update({
      where: { id: client.id },
      data: { deviceId, activatedAt: client.activatedAt ?? new Date(),
        devicePublicKey: publicKey, deviceKeyId: keyId, keyEnrolledAt: client.keyEnrolledAt ?? new Date(),
        enrollmentGrantHash: null, enrollmentGrantExpiresAt: null },
    });
    const previous = await tx.activationSession.findUnique({
      where: { clientId_deviceId: { clientId: client.id, deviceId } },
    });
    if (previous && previous.activationRequestId === activationRequestId && client.deviceKeyId === keyId) {
      if (previous.authRevokedAt || !previous.authExpiresAt || previous.authExpiresAt.getTime() <= Date.now()) {
        securityFailure('SESSION_REPLAY');
      }
      return sessionTokens(bound, previous);
    }
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const values = { status: 'active', authIssuedAt: now, authExpiresAt: new Date(now.getTime() + 7 * 86_400_000),
      authRevokedAt: null, activationRequestId, refreshGeneration: 0,
      refreshJti: randomUUID(), refreshIssuedAt: now, previousRefreshJti: null, refreshRetryUntil: null };
    const session = await tx.activationSession.upsert({
      where: { clientId_deviceId: { clientId: client.id, deviceId } },
      create: { clientId: client.id, deviceId, authGeneration: 1, ...values },
      update: { ...values, authGeneration: { increment: 1 } },
    });
    return sessionTokens(bound, session);
  });
}

export async function rotateBoundSession(req: Request, claims: BoundClaims & { exp?: number }) {
  const initial = await checkSession(claims);
  if (!initial) return null;
  const credential = req.body?.refreshToken;
  if (typeof credential !== 'string') securityFailure('REFRESH_REQUIRED');
  const proof = verifyMobileProof(req, initial.client.devicePublicKey!, credential, claims);
  if (!prisma) throw new Error('SECURITY_DATABASE_REQUIRED');
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM vpn_clients WHERE id = ${initial.client.id} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM activation_sessions WHERE id = ${claims.sid!} FOR UPDATE`;
    const current = await checkSession(claims, tx);
    if (!current) securityFailure('SESSION_REPLAY');
    await consumeProof(tx, proof);
    const { client, session } = current;
    if (claims.jti === session.previousRefreshJti && claims.rg === session.refreshGeneration - 1 &&
        session.refreshRetryUntil && session.refreshRetryUntil.getTime() > Date.now()) {
      return sessionTokens(client, session);
    }
    if (claims.jti !== session.refreshJti || claims.rg !== session.refreshGeneration) {
      // Reject a stale token, not an account. A delayed legitimate retry is not
      // evidence that the user is an attacker and never resurrects the family.
      securityFailure('REFRESH_RETRY_EXPIRED');
    }
    const next = await tx.activationSession.update({
      where: { id: session.id },
      data: { previousRefreshJti: session.refreshJti, refreshJti: randomUUID(),
        refreshGeneration: { increment: 1 }, refreshIssuedAt: new Date(Math.floor(Date.now() / 1000) * 1000),
        refreshRetryUntil: new Date(Date.now() + REFRESH_RETRY_MS), lastSync: new Date() },
    });
    return sessionTokens(client, next);
  });
}

export async function revokeSecuritySession(
  tx: Prisma.TransactionClient, id: string, generation: number, scope: Prisma.ActivationSessionWhereInput = {},
) {
  const result = await tx.activationSession.updateMany({
    where: { id, authGeneration: generation, authRevokedAt: null, AND: scope },
    data: { authRevokedAt: new Date() },
  });
  return result.count === 1;
}

export function notifySessionRevoked(clientId: string) {
  accessStateHub.invalidate({ clientId });
}

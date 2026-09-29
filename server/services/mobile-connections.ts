import type { Request } from 'express';
import { z } from 'zod';
import { prisma } from '../database';
import { consumeSessionProof, type BoundClaims } from './mobile-session-security';
import { proofFor, securityFailure } from './mobile-proof';
import { subscriptionAccessStatus } from './access-lifecycle';
import { authorizeRelayBinding } from './ssh-relay-auth';
import { relayProfileEnabled } from './ssh-relay-ticket';

const connectionSchema = z.object({
  action: z.enum(['connect', 'disconnect']),
  connectionId: z.string().uuid(),
  sessionId: z.string().regex(/^sess_[0-9a-f-]{36}$/i),
  subscriptionId: z.string().max(200).nullable(),
  configId: z.string().max(200).nullable(),
  relayTicket: z.string().max(4096).optional(),
}).strict();

export async function updateMobileConnection(req: Request, claims: BoundClaims) {
  if (!prisma || !claims.sid || !claims.clientId || !claims.deviceId) securityFailure('SESSION_REQUIRED');
  const input = connectionSchema.parse(req.body);
  return prisma.$transaction(async tx => {
    await consumeSessionProof(tx, claims, proofFor(req));
    if (input.action === 'connect' && input.subscriptionId) {
      const subscription = await tx.subscription.findFirst({
        where: { id: input.subscriptionId, clientId: claims.clientId },
        include: { profile: { select: { id: true, protocol: true, status: true, createdAt: true } } },
      });
      if (!subscription || subscriptionAccessStatus(subscription) !== 'active' ||
          (subscription.deviceId && subscription.deviceId !== claims.deviceId)) securityFailure('OWNERSHIP_FORBIDDEN', 403);
      if (!input.relayTicket && relayProfileEnabled(subscription.profile)) {
        securityFailure('RELAY_REQUIRED', 409);
      }
    }
    const previous = await tx.mobileConnection.findUnique({ where: { id: input.connectionId } });
    if (previous) {
      if (previous.clientId !== claims.clientId || previous.deviceId !== claims.deviceId ||
          previous.authSessionId !== claims.sid || previous.authGeneration !== claims.sg ||
          previous.usageSessionId !== input.sessionId || previous.subscriptionId !== input.subscriptionId ||
          previous.configId !== input.configId) securityFailure('USAGE_ATTRIBUTION_CONFLICT', 409);
      if (input.action === 'connect') {
        const requestedHash = input.relayTicket
          ? await authorizeRelayBinding(tx, input.relayTicket, claims, input.subscriptionId) : null;
        if (previous.closedAt || (previous.relayConfigHash ?? null) !== requestedHash) {
          securityFailure('USAGE_ATTRIBUTION_CONFLICT', 409);
        }
      }
      if (input.action === 'disconnect') {
        await tx.mobileConnection.update({ where: { id: previous.id }, data: { closedAt: new Date(), closeReason: 'USER_STOP' } });
      }
      return previous;
    }
    if (input.action !== 'connect') securityFailure('CONNECTION_NOT_FOUND', 404);
    const relayConfigHash = input.relayTicket
      ? await authorizeRelayBinding(tx, input.relayTicket, claims, input.subscriptionId) : null;
    // Explicit null denotes a manual profile. Once issued, it cannot be
    // substituted for an existing managed connection's accounting identity.
    return tx.mobileConnection.create({ data: {
      id: input.connectionId, clientId: claims.clientId!, deviceId: claims.deviceId!,
      authSessionId: claims.sid!, authGeneration: claims.sg!, usageSessionId: input.sessionId,
      subscriptionId: input.subscriptionId, configId: input.configId,
      relayConfigHash,
    } });
  });
}

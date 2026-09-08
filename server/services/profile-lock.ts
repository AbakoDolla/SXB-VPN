import { createHmac } from 'node:crypto';
import type { Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit, { ipKeyGenerator, type RateLimitExceededEventHandler } from 'express-rate-limit';
import { config } from '../config';
import type { AuthenticatedRequest } from '../middleware/auth';

export interface LockableProfile {
  id: string;
  lockPasswordHash?: string | null;
  lockVersion?: number | null;
}

export const PROFILE_UNLOCK_SECONDS = 600;
const audience = 'sxb:profile-unlock';
const signingKey = () => createHmac('sha256', config.JWT_SECRET).update(audience).digest();

export class ProfileLockError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

export function handleProfileLockError(error: unknown, res: Response): boolean {
  if (error instanceof ProfileLockError) {
    res.status(error.status).json({ error: error.code, code: error.code });
    return true;
  }
  return false;
}

export function validateLockPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length > 72 || [...value].length < 8 ||
      Buffer.byteLength(value, 'utf8') > 72 || value.includes('\0') || !value.trim()) {
    throw new ProfileLockError(400, 'PROFILE_LOCK_PASSWORD_INVALID');
  }
  return value;
}

export async function createProfileLock(password: unknown) {
  return { lockPasswordHash: await bcrypt.hash(validateLockPassword(password), 12), lockVersion: 1 };
}

export async function verifyProfilePassword(profile: LockableProfile, password: unknown): Promise<void> {
  const valid = validateLockPassword(password);
  if (!profile.lockPasswordHash || !await bcrypt.compare(valid, profile.lockPasswordHash)) {
    throw new ProfileLockError(403, 'PROFILE_UNLOCK_FAILED');
  }
}

export function issueProfileUnlock(profile: LockableProfile, userId: string) {
  const exp = Math.floor(Date.now() / 1000) + PROFILE_UNLOCK_SECONDS;
  const unlockToken = jwt.sign({
    sub: userId, profileId: profile.id, version: profile.lockVersion ?? 0, exp,
  }, signingKey(), { algorithm: 'HS256', audience });
  return { unlockToken, expiresAt: new Date(exp * 1000).toISOString() };
}

export function profileUnlockExpiry(profile: LockableProfile, req?: AuthenticatedRequest): number | null {
  const token = req?.get('X-VPN-Profile-Unlock');
  if (!profile.lockPasswordHash || !req?.user || typeof token !== 'string' || token.length > 2048) return null;
  try {
    const payload = jwt.verify(token, signingKey(), { algorithms: ['HS256'], audience });
    if (typeof payload === 'string' || payload.sub !== req.user.userId ||
        payload.profileId !== profile.id || payload.version !== (profile.lockVersion ?? 0) ||
        typeof payload.exp !== 'number' || typeof payload.iat !== 'number' ||
        payload.exp - payload.iat > PROFILE_UNLOCK_SECONDS) return null;
    return payload.exp * 1000;
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) return null;
    throw error;
  }
}

export function assertProfileUnlocked(profile: LockableProfile, req: AuthenticatedRequest): void {
  if (profile.lockPasswordHash && !profileUnlockExpiry(profile, req)) {
    throw new ProfileLockError(423, 'PROFILE_LOCKED');
  }
}

// Include the observed lock in the write predicate: adding/rotating a lock
// between the permission check and the write cannot authorize a stale proof.
export function profileLockWhere(profile: LockableProfile) {
  return {
    id: profile.id,
    lockVersion: profile.lockVersion ?? 0,
    lockPasswordHash: profile.lockPasswordHash ?? null,
  };
}

const metadataFields = [
  'id', 'name', 'description', 'displayProtocol', 'offlineValidDays', 'status',
  'createdAt', 'updatedAt', '_count',
] as const;
const technicalFields = [
  'protocol', 'host', 'port', 'username', 'uuid', 'path', 'network', 'tls', 'sni',
  'dns', 'payloadId', 'method', 'canonicalConfigHash', 'configVersion', 'sourceFormat',
  'validationStatus', 'validationMessage', 'validatedAt', 'importedAt',
] as const;

export function serializeLockedProfile(
  profile: LockableProfile & Record<string, any>,
  req?: AuthenticatedRequest,
  canSeeTechnical = true,
): Record<string, any> {
  const expires = canSeeTechnical ? profileUnlockExpiry(profile, req) : null;
  const hasLock = !!profile.lockPasswordHash;
  const isLocked = hasLock && !expires;
  const out: Record<string, any> = { hasLock, isLocked };
  for (const key of metadataFields) if (profile[key] !== undefined) out[key] = profile[key];
  if (canSeeTechnical && !isLocked) {
    for (const key of technicalFields) if (profile[key] !== undefined) out[key] = profile[key];
    out.password = profile.password ? '********' : null;
    out.jsonConfig = profile.jsonConfig ? '(encrypted)' : null;
    out.hasCanonicalConfig = !!profile.canonicalConfig;
    if (expires) out.unlockExpiresAt = new Date(expires).toISOString();
  }
  return out;
}

const rateLimitHandler: RateLimitExceededEventHandler = (_req, res) => {
  res.status(429).json({
    error: 'PROFILE_UNLOCK_RATE_LIMITED', code: 'PROFILE_UNLOCK_RATE_LIMITED',
    retryAfterSeconds: Number(res.getHeader('Retry-After')) || 900,
  });
};

// Independent budgets prevent rotating users, profiles or IPs from resetting
// every counter. No password or proof participates in a limiter key.
export const profileUnlockLimiters = [
  rateLimit({
    windowMs: 900_000, limit: 50, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => ipKeyGenerator(req.ip || 'unknown'),
    handler: rateLimitHandler,
  }),
  rateLimit({
    windowMs: 900_000, limit: 20, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => `profile:${req.params.id}`,
    handler: rateLimitHandler,
  }),
  rateLimit({
    windowMs: 900_000, limit: 5, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req: AuthenticatedRequest) => `user:${req.user!.userId}:profile:${req.params.id}`,
    handler: rateLimitHandler,
  }),
];

import { createHash, createPublicKey, verify } from 'node:crypto';
import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { MobileAccessError, sessionInvalidFailure } from './access-lifecycle';

export interface SecurityClaims { sid?: string; sg?: number; kid?: string; jti?: string; rg?: number; }
export interface VerifiedProof { keyId: string; nonce: string; expiresAt: Date; }
const proofs = new WeakMap<Request, VerifiedProof>();
let lastPrunedAt = 0;
export const proofFor = (req: Request) => proofs.get(req);
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function securityFailure(code: string, status = 401): never {
  throw new MobileAccessError(status, {
    ...sessionInvalidFailure(), code: 'SESSION_INVALID', reason: code,
    preserveLocalData: true,
  });
}

export function publicDeviceKey(encoded: string) {
  if (!/^[A-Za-z0-9+/=]{100,256}$/.test(encoded)) securityFailure('DEVICE_KEY_INVALID', 400);
  let key: ReturnType<typeof createPublicKey>;
  try { key = createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' }); }
  catch { securityFailure('DEVICE_KEY_INVALID', 400); }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    securityFailure('DEVICE_KEY_INVALID', 400);
  }
  return { key, keyId: digest(key.export({ format: 'der', type: 'spki' })) };
}

export function verifyMobileProof(
  req: Request, publicKey: string, credential: string, claims: SecurityClaims,
): VerifiedProof {
  const cached = proofs.get(req);
  if (cached) return cached;
  const nonce = req.get('X-SXB-Nonce') ?? '';
  const timestamp = req.get('X-SXB-Time') ?? '';
  const signature = req.get('X-SXB-Proof') ?? '';
  if (!/^[A-Za-z0-9_-]{32,86}$/.test(nonce) || !/^\d{13}$/.test(timestamp) ||
      !/^[A-Za-z0-9+/=]{80,112}$/.test(signature)) securityFailure('DEVICE_PROOF_REQUIRED');
  const issuedAt = Number(timestamp);
  if (Math.abs(Date.now() - issuedAt) > 90_000) securityFailure('PROOF_EXPIRED');
  const { key, keyId } = publicDeviceKey(publicKey);
  if (claims.kid && claims.kid !== keyId) securityFailure('DEVICE_MISMATCH');
  // Hash the exact bytes, not a parsed/re-serialized approximation.
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (raw === undefined && req.body && Object.keys(req.body).length > 0) {
    throw new Error('MOBILE_PROOF_RAW_BODY_REQUIRED');
  }
  const canonical = [
    'SXB-PROOF-1', req.method.toUpperCase(), req.originalUrl,
    digest(raw ?? Buffer.alloc(0)), claims.sid ?? '-', String(claims.sg ?? 0),
    digest(credential), timestamp, nonce,
  ].join('\n');
  let valid: boolean;
  try { valid = verify('sha256', Buffer.from(canonical), key, Buffer.from(signature, 'base64')); }
  catch { securityFailure('DEVICE_PROOF_INVALID'); }
  if (!valid) securityFailure('DEVICE_PROOF_INVALID');
  const proof = { keyId, nonce, expiresAt: new Date(issuedAt + 90_001) };
  proofs.set(req, proof);
  return proof;
}

export async function consumeProof(tx: Prisma.TransactionClient, proof: VerifiedProof | undefined) {
  if (!proof) return;
  if (proof.expiresAt.getTime() <= Date.now()) securityFailure('PROOF_EXPIRED');
  // ON CONFLICT does not abort the PostgreSQL transaction; domain decisions
  // remain explicit and the caller commits nonce + authorized mutation together.
  const result = await tx.mobileProofNonce.createMany({ data: [proof], skipDuplicates: true });
  if (result.count !== 1) securityFailure('NONCE_REUSED', 409);
  if (Date.now() - lastPrunedAt > 60_000) {
    await tx.mobileProofNonce.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    lastPrunedAt = Date.now();
  }
}

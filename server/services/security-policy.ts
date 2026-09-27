import { z } from 'zod';
import { prisma } from '../database';
import { DEFAULT_RISK_POLICY, SIGNAUX_MOBILES } from './mobile-risk';

export const OFFICIAL_SIGNER = '0140c97e6ba6e9bab0d0ce86935562fbdedd80a026de49642764c49dce56f726';
export const SECURITY_POLICY_KEY = 'mobile.security.policy.v1';
export const securityPolicySchema = z.object({
  version: z.number().int().positive(),
  medium: z.number().int().min(11).max(64),
  high: z.number().int().min(65).max(89),
  weights: z.record(z.enum(SIGNAUX_MOBILES), z.number().int().min(0).max(89)),
  certificates: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(8),
  packageName: z.literal('com.sxbvpn.mobile'),
}).strict();
export type SecurityPolicy = z.infer<typeof securityPolicySchema>;
export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  ...DEFAULT_RISK_POLICY, certificates: [OFFICIAL_SIGNER], packageName: 'com.sxbvpn.mobile',
};

export async function readSecurityPolicy(): Promise<SecurityPolicy> {
  if (!prisma) return DEFAULT_SECURITY_POLICY;
  const row = await prisma.setting.findUnique({ where: { key: SECURITY_POLICY_KEY } });
  return row ? securityPolicySchema.parse(JSON.parse(row.value)) : DEFAULT_SECURITY_POLICY;
}

export async function writeSecurityPolicy(value: unknown) {
  if (!prisma) throw new Error('SECURITY_DATABASE_REQUIRED');
  const next = securityPolicySchema.parse(value);
  return prisma.$transaction(async tx => {
    await tx.setting.upsert({
      where: { key: SECURITY_POLICY_KEY },
      create: { key: SECURITY_POLICY_KEY, value: JSON.stringify(DEFAULT_SECURITY_POLICY) }, update: {},
    });
    await tx.$queryRaw`SELECT key FROM settings WHERE key = ${SECURITY_POLICY_KEY} FOR UPDATE`;
    const previous = await tx.setting.findUniqueOrThrow({ where: { key: SECURITY_POLICY_KEY } });
    const current = securityPolicySchema.parse(JSON.parse(previous.value));
    if (next.version !== current.version + 1) throw new Error('SECURITY_POLICY_VERSION_CONFLICT');
    await tx.setting.update({ where: { key: SECURITY_POLICY_KEY }, data: { value: JSON.stringify(next) } });
    return next;
  });
}

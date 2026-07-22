/**
 * VPN Provisioning Routes — SXB VPN Core
 * Mobile-facing endpoints. Validates SXB-DATA tokens, returns encrypted configs.
 * The user never sees raw credentials — only a device-bound encrypted blob.
 */
import { Router, Response } from 'express';
import { prisma } from '../database';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth';
import { logDbActivity } from '../database';
import crypto from 'crypto';

const router = Router();

const ALGO    = 'aes-256-cbc';
const ENC_KEY = process.env.ENCRYPTION_KEY || 'sxb-vpn-32-byte-encryption-key-!';

function decrypt(enc: string): string {
  const [ivHex, encHex] = enc.split(':');
  const k = crypto.createHash('sha256').update(ENC_KEY).digest();
  const d = crypto.createDecipheriv(ALGO, k, Buffer.from(ivHex, 'hex'));
  return Buffer.concat([d.update(Buffer.from(encHex, 'hex')), d.final()]).toString();
}

/** Encrypt config payload with a device-specific key (device-bound, non-portable) */
function encryptForDevice(plaintext: string, deviceId: string, accountToken: string): {
  encryptedBlob: string;
  configKey: string;
} {
  // Per-device key: HMAC-SHA256(deviceId + accountToken, MASTER_SECRET)
  const masterSecret = process.env.PROVISION_SECRET || process.env.ENCRYPTION_KEY || 'sxb-provision-secret';
  const configKey = crypto.createHmac('sha256', masterSecret)
    .update(`${deviceId}:${accountToken}`)
    .digest('hex');
  
  const iv   = crypto.randomBytes(16);
  const k    = Buffer.from(configKey, 'hex').slice(0, 32);
  const cipher = crypto.createCipheriv(ALGO, k, iv);
  const encryptedBlob = iv.toString('hex') + ':' +
    Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('hex');

  return { encryptedBlob, configKey };
}

function normalizeToken(t: string): string {
  return t.trim().toUpperCase();
}

// ─── POST /api/provision/activate ────────────────────────────────────────────
// Step 2 of mobile activation: validate DATA token → provision encrypted config
router.post('/activate', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { dataToken, deviceId } = req.body;
    if (!dataToken || !deviceId) {
      return res.status(400).json({ error: 'dataToken and deviceId are required' });
    }

    const normalToken = normalizeToken(dataToken);

    // Find subscription by data token
    const sub = await (prisma as any).subscription.findFirst({
      where: { dataToken: normalToken },
      include: {
        profile: { include: { payload: true } },
        client:  { include: { user: true } },
        devices: true,
      },
    });

    if (!sub) {
      return res.status(404).json({ error: 'Token invalide ou introuvable' });
    }

    // Validate subscription
    if (sub.status === 'revoked') {
      return res.status(403).json({ error: 'Cet abonnement a été révoqué' });
    }
    if (sub.status === 'expired' || (sub.expireAt && new Date(sub.expireAt) < new Date())) {
      await (prisma as any).subscription.update({ where: { id: sub.id }, data: { status: 'expired' } });
      return res.status(403).json({ error: 'Abonnement expiré' });
    }

    // Device limit check
    const existingDevices: string[] = sub.devices ? sub.devices.map((d: any) => d.deviceId) : [];
    const isExistingDevice = existingDevices.includes(deviceId);
    if (!isExistingDevice && existingDevices.length >= sub.deviceLimit) {
      return res.status(403).json({
        error: `Limite d'appareils atteinte (${sub.deviceLimit} max)`,
        currentDevices: existingDevices.length,
        limit: sub.deviceLimit,
      });
    }

    // Register device if new
    if (!isExistingDevice) {
      await (prisma as any).subscriptionDevice.create({
        data: {
          subscriptionId: sub.id,
          deviceId,
          activatedAt: new Date(),
          lastSeenAt: new Date(),
        },
      });
    } else {
      await (prisma as any).subscriptionDevice.updateMany({
        where: { subscriptionId: sub.id, deviceId },
        data: { lastSeenAt: new Date() },
      });
    }

    const profile = sub.profile;
    const client  = sub.client;

    // Build the raw config object (NEVER sent directly to mobile)
    const rawConfig: Record<string, any> = {
      protocol:    profile.protocol,
      host:        profile.host,
      port:        profile.port,
      network:     profile.network,
      tls:         profile.tls,
      sni:         profile.sni,
      dns:         profile.dns,
      path:        profile.path,
    };

    if (profile.protocol === 'ssh') {
      rawConfig.username = profile.username;
      rawConfig.password = profile.password ? decrypt(profile.password) : '';
      if (profile.payload) {
        rawConfig.payload = {
          content: profile.payload.content,
          sni:     profile.payload.sni,
          host:    profile.payload.host,
          port:    profile.payload.port,
        };
      }
    }

    // Encrypt for this specific device
    const { encryptedBlob, configKey } = encryptForDevice(
      JSON.stringify(rawConfig),
      deviceId,
      client.token,
    );

    const quotaGB     = Number(sub.quotaBytes) / (1024 ** 3);
    const quotaUsedGB = Number(sub.quotaUsed)  / (1024 ** 3);

    // Mark subscription as provisioned
    await (prisma as any).subscription.update({
      where: { id: sub.id },
      data: { lastProvisionAt: new Date() },
    });

    await logDbActivity(
      req.user!.userId,
      `Provisioned config for subscription ${sub.name} → device ${deviceId}`,
      'info',
      req.ip || '',
    );

    return res.json({
      success: true,
      config: {
        subscriptionId:  sub.id,
        profileId:       profile.id,
        profileName:     profile.name,
        protocol:        profile.protocol,
        encryptedBlob,
        configKey,
        offlineValidDays: profile.offlineValidDays,
        quotaGB:         parseFloat(quotaGB.toFixed(4)),
        quotaUsedGB:     parseFloat(quotaUsedGB.toFixed(4)),
        expireAt:        sub.expireAt,
        deviceLimit:     sub.deviceLimit,
        provisionedAt:   new Date().toISOString(),
        lastSyncAt:      null,
      },
    });
  } catch (err: any) {
    console.error('provision error:', err);
    return res.status(500).json({ error: err.message || 'Provision failed' });
  }
});

// ─── POST /api/provision/sync ─────────────────────────────────────────────────
// Sync traffic stats + receive backend updates (expiration, revocation, new quota)
router.post('/sync', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { subscriptionId, downloadBytes, uploadBytes, deviceId } = req.body;
    if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' });

    const sub = await (prisma as any).subscription.findUnique({
      where: { id: subscriptionId },
    });
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });

    const addedBytes = (BigInt(downloadBytes || 0) + BigInt(uploadBytes || 0));
    const newQuotaUsed = sub.quotaUsed + addedBytes;

    // Check if quota exceeded
    const isExpired  = sub.expireAt && new Date(sub.expireAt) < new Date();
    const isOverQuota = newQuotaUsed >= sub.quotaBytes;

    let newStatus = sub.status;
    if (sub.status === 'active' && (isExpired || isOverQuota)) {
      newStatus = 'expired';
    }

    const updated = await (prisma as any).subscription.update({
      where: { id: subscriptionId },
      data: {
        quotaUsed:    newQuotaUsed,
        status:       newStatus,
        lastSyncAt:   new Date(),
      },
    });

    // Update device lastSeen
    if (deviceId) {
      await (prisma as any).subscriptionDevice.updateMany({
        where: { subscriptionId, deviceId },
        data: { lastSeenAt: new Date() },
      });
    }

    // Log traffic
    await (prisma as any).trafficUsage.create({
      data: {
        accountId:   subscriptionId,
        accountType: 'subscription',
        download:    BigInt(downloadBytes || 0),
        upload:      BigInt(uploadBytes   || 0),
      },
    });

    const quotaGB     = Number(updated.quotaBytes) / (1024 ** 3);
    const quotaUsedGB = Number(updated.quotaUsed)  / (1024 ** 3);

    return res.json({
      success: true,
      status:       updated.status,
      expireAt:     updated.expireAt,
      quotaGB:      parseFloat(quotaGB.toFixed(4)),
      quotaUsedGB:  parseFloat(quotaUsedGB.toFixed(4)),
      revoked:      updated.status === 'revoked',
    });
  } catch (err: any) {
    console.error('sync error:', err);
    return res.status(500).json({ error: 'Sync failed' });
  }
});

// ─── GET /api/provision/status ────────────────────────────────────────────────
// Quick status check for a subscription (online validation)
router.get('/status/:subscriptionId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const sub = await (prisma as any).subscription.findUnique({
      where: { id: req.params.subscriptionId },
    });
    if (!sub) return res.status(404).json({ error: 'Not found' });

    const quotaGB     = Number(sub.quotaBytes) / (1024 ** 3);
    const quotaUsedGB = Number(sub.quotaUsed)  / (1024 ** 3);

    return res.json({
      success:     true,
      status:      sub.status,
      expireAt:    sub.expireAt,
      quotaGB:     parseFloat(quotaGB.toFixed(4)),
      quotaUsedGB: parseFloat(quotaUsedGB.toFixed(4)),
      revoked:     sub.status === 'revoked',
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'Status check failed' });
  }
});

export default router;

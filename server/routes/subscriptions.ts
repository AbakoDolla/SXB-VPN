/**
 * Subscriptions Routes — SXB VPN Core
 * A Subscription links a VpnClient to a VpnProfile with quota/duration/devices.
 * Generating a subscription automatically creates or links a SXB-DATA token.
 */
import { Router, Response } from 'express';
import { prisma } from '../database';
import { requireAuth, requirePermission, AuthenticatedRequest } from '../middleware/auth';
import { logDbActivity } from '../database';
import crypto from 'crypto';

const router = Router();

function generateDataToken(): string {
  const part = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `SXB-DATA-${part()}-${part()}-${part()}`;
}

// ─── GET /api/subscriptions ───────────────────────────────────────────────────
router.get('/', requireAuth, requirePermission('subscription.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const subs = await (prisma as any).subscription.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        client:  { include: { user: true } },
        profile: true,
      },
    });
    return res.json({ success: true, subscriptions: subs });
  } catch (err) {
    console.error('subscriptions list error:', err);
    return res.status(500).json({ error: 'Failed to list subscriptions' });
  }
});

// ─── GET /api/subscriptions/stats ────────────────────────────────────────────
router.get('/stats', requireAuth, requirePermission('subscription.view'), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const total   = await (prisma as any).subscription.count();
    const active  = await (prisma as any).subscription.count({ where: { status: 'active' } });
    const expired = await (prisma as any).subscription.count({ where: { status: 'expired' } });
    return res.json({ success: true, total, active, expired });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get stats' });
  }
});

// ─── GET /api/subscriptions/:id ──────────────────────────────────────────────
router.get('/:id', requireAuth, requirePermission('subscription.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const sub = await (prisma as any).subscription.findUnique({
      where: { id: req.params.id },
      include: { client: { include: { user: true } }, profile: true },
    });
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });
    // Link subscription to a registered device if provided
    return res.json({ success: true, subscription: sub });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get subscription' });
  }
});

// ─── POST /api/subscriptions ──────────────────────────────────────────────────
// Creates a subscription and auto-generates a SXB-DATA token linked to the profile.
router.post('/', requireAuth, requirePermission('subscription.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { clientId, profileId, name, quotaGB, durationDays, deviceLimit, deviceId } = req.body;

    if (!clientId || !profileId || !quotaGB || !durationDays) {
      return res.status(400).json({ error: 'clientId, profileId, quotaGB and durationDays are required' });
    }

    // Verify client and profile exist
    const [client, profile] = await Promise.all([
      prisma.vpnClient.findUnique({ where: { id: clientId } }),
      (prisma as any).vpnProfile.findUnique({ where: { id: profileId } }),
    ]);
    if (!client) return res.status(404).json({ error: 'VPN client not found' });
    if (!profile) return res.status(404).json({ error: 'VPN profile not found' });

    const quotaBytes = BigInt(Math.round(Number(quotaGB) * 1024 * 1024 * 1024));
    const startAt    = new Date();
    const expireAt   = new Date(startAt.getTime() + Number(durationDays) * 24 * 3600 * 1000);
    const dataToken  = generateDataToken();

    const sub = await (prisma as any).subscription.create({
      data: {
        name:        name || `${profile.name} — ${Number(durationDays)}j`,
        clientId,
        profileId,
        dataToken,
        quotaBytes,
        quotaUsed:   BigInt(0),
        durationDays: Number(durationDays),
        deviceLimit:  Number(deviceLimit) || profile.deviceLimit || 1,
        startAt,
        expireAt,
        status:       'active',
        createdBy:    req.user!.userId,
      },
      include: { client: { include: { user: true } }, profile: true },
    });

    await logDbActivity(req.user!.userId, `Created subscription "${sub.name}" for client ${clientId}`, 'info', req.ip || '');
    return res.status(201).json({ success: true, subscription: sub });
  } catch (err: any) {
    console.error('subscription create error:', err);
    return res.status(500).json({ error: err.message || 'Failed to create subscription' });
  }
});

// ─── PUT /api/subscriptions/:id ──────────────────────────────────────────────
router.put('/:id', requireAuth, requirePermission('subscription.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const existing = await (prisma as any).subscription.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Subscription not found' });

    const { name, quotaGB, durationDays, deviceLimit, status } = req.body;

    const updated = await (prisma as any).subscription.update({
      where: { id: req.params.id },
      data: {
        ...(name        !== undefined && { name }),
        ...(quotaGB     !== undefined && { quotaBytes: BigInt(Math.round(Number(quotaGB) * 1024 ** 3)) }),
        ...(durationDays !== undefined && {
          durationDays: Number(durationDays),
          expireAt: new Date(existing.startAt.getTime() + Number(durationDays) * 86400000),
        }),
        ...(deviceLimit !== undefined && { deviceLimit: Number(deviceLimit) }),
        ...(status      !== undefined && { status }),
      },
      include: { client: { include: { user: true } }, profile: true },
    });

    await logDbActivity(req.user!.userId, `Updated subscription: ${updated.name}`, 'info', req.ip || '');
    return res.json({ success: true, subscription: updated });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to update subscription' });
  }
});

// ─── DELETE /api/subscriptions/:id ───────────────────────────────────────────
router.delete('/:id', requireAuth, requirePermission('subscription.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const existing = await (prisma as any).subscription.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Subscription not found' });
    await (prisma as any).subscription.delete({ where: { id: req.params.id } });
    await logDbActivity(req.user!.userId, `Deleted subscription: ${existing.name}`, 'warning', req.ip || '');
    return res.json({ success: true, message: 'Subscription deleted' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to delete subscription' });
  }
});

// ─── POST /api/subscriptions/:id/revoke ──────────────────────────────────────
router.post('/:id/revoke', requireAuth, requirePermission('subscription.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const sub = await (prisma as any).subscription.update({
      where: { id: req.params.id },
      data: { status: 'revoked', revokedAt: new Date(), revokeReason: req.body.reason || 'Admin revoked' },
    });
    await logDbActivity(req.user!.userId, `Revoked subscription: ${sub.name}`, 'danger', req.ip || '');
    return res.json({ success: true, message: 'Subscription revoked' });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to revoke subscription' });
  }
});

export default router;

/**
 * Subscriptions Routes — SXB VPN Core v2
 *
 * CORRECTIF v2 :
 *  - BigInt JSON : toutes les réponses passent par serializeSub()
 *    qui convertit quotaBytes/quotaUsed en Number avant JSON.stringify
 *  - Évite les crash 500 "Cannot serialize a BigInt value"
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

// ── BigInt → Number avant sérialisation JSON ──────────────────────────────────
// JSON.stringify plante avec "Cannot serialize a BigInt value" si on laisse
// les champs BigInt de Prisma bruts.
function serializeSub(sub: any): any {
  if (!sub) return sub;
  const s = { ...sub };
  if (typeof s.quotaBytes === 'bigint') s.quotaBytes = Number(s.quotaBytes);
  if (typeof s.quotaUsed  === 'bigint') s.quotaUsed  = Number(s.quotaUsed);
  // Champs imbriqués (profile, client)
  if (s.client) s.client = serializeClient(s.client);
  if (s.profile) s.profile = serializeProfile(s.profile);
  return s;
}

function serializeClient(c: any): any {
  if (!c) return c;
  const r = { ...c };
  if (typeof r.quotaTotal === 'bigint') r.quotaTotal = Number(r.quotaTotal);
  if (typeof r.quotaUsed  === 'bigint') r.quotaUsed  = Number(r.quotaUsed);
  return r;
}

function serializeProfile(p: any): any {
  if (!p) return p;
  return { ...p };
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
    return res.json({ success: true, subscriptions: subs.map(serializeSub) });
  } catch (err: any) {
    console.error('subscriptions list error:', err);
    return res.status(500).json({ error: err.message || 'Failed to list subscriptions' });
  }
});

// ─── GET /api/subscriptions/stats ────────────────────────────────────────────
router.get('/stats', requireAuth, requirePermission('subscription.view'), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const total   = await (prisma as any).subscription.count();
    const active  = await (prisma as any).subscription.count({ where: { status: 'active' } });
    const expired = await (prisma as any).subscription.count({ where: { status: 'expired' } });
    return res.json({ success: true, total, active, expired });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to get stats' });
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
    return res.json({ success: true, subscription: serializeSub(sub) });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to get subscription' });
  }
});

// ─── POST /api/subscriptions ──────────────────────────────────────────────────
router.post('/', requireAuth, requirePermission('subscription.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { clientId, profileId, name, quotaGB, durationDays, deviceLimit, deviceId } = req.body;

    if (!clientId || !profileId || !quotaGB || !durationDays) {
      return res.status(400).json({ error: 'clientId, profileId, quotaGB et durationDays sont requis' });
    }

    const [client, profile] = await Promise.all([
      prisma.vpnClient.findUnique({ where: { id: clientId } }),
      (prisma as any).vpnProfile.findUnique({ where: { id: profileId } }),
    ]);
    if (!client) return res.status(404).json({ error: 'Client VPN introuvable' });
    if (!profile) return res.status(404).json({ error: 'Profil VPN introuvable' });

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
        quotaUsed:    BigInt(0),
        durationDays: Number(durationDays),
        deviceLimit:  Number(deviceLimit) || 1,
        deviceId:     deviceId || null,
        startAt,
        expireAt,
        status:       'active',
        createdBy:    req.user!.userId,
      },
      include: { client: { include: { user: true } }, profile: true },
    });

    await logDbActivity(req.user!.userId, `Forfait créé : "${sub.name}" pour client ${clientId}`, 'info', req.ip || '');
    return res.status(201).json({ success: true, subscription: serializeSub(sub) });
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
        ...(name         !== undefined && { name }),
        ...(quotaGB      !== undefined && { quotaBytes: BigInt(Math.round(Number(quotaGB) * 1024 ** 3)) }),
        ...(durationDays !== undefined && {
          durationDays: Number(durationDays),
          expireAt: new Date(existing.startAt.getTime() + Number(durationDays) * 86400000),
        }),
        ...(deviceLimit  !== undefined && { deviceLimit: Number(deviceLimit) }),
        ...(status       !== undefined && { status }),
      },
      include: { client: { include: { user: true } }, profile: true },
    });

    await logDbActivity(req.user!.userId, `Forfait mis à jour : ${updated.name}`, 'info', req.ip || '');
    return res.json({ success: true, subscription: serializeSub(updated) });
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
    await logDbActivity(req.user!.userId, `Forfait supprimé : ${existing.name}`, 'warning', req.ip || '');
    return res.json({ success: true, message: 'Forfait supprimé' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to delete subscription' });
  }
});

// ─── POST /api/subscriptions/:id/revoke ──────────────────────────────────────
router.post('/:id/revoke', requireAuth, requirePermission('subscription.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const sub = await (prisma as any).subscription.update({
      where: { id: req.params.id },
      data: { status: 'revoked', revokedAt: new Date(), revokeReason: req.body.reason || 'Révoqué par admin' },
    });
    await logDbActivity(req.user!.userId, `Forfait révoqué : ${sub.name}`, 'danger', req.ip || '');
    return res.json({ success: true, message: 'Forfait révoqué' });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to revoke subscription' });
  }
});

export default router;

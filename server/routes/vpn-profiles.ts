/**
 * VPN Profiles Routes — SXB VPN Core
 * Manages reusable VPN configuration templates (profiles).
 * A profile defines protocol, server, credentials, payload, SNI, DNS, etc.
 * It is then attached to Subscriptions delivered to clients.
 */
import { Router, Response } from 'express';
import { prisma } from '../database';
import { requireAuth, requirePermission, AuthenticatedRequest } from '../middleware/auth';
import { logDbActivity } from '../database';
import crypto from 'crypto';

const router = Router();

const ALGO = 'aes-256-cbc';
const ENC_KEY = process.env.ENCRYPTION_KEY || 'sxb-vpn-32-byte-encryption-key-!';

function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const k  = crypto.createHash('sha256').update(ENC_KEY).digest();
  const c  = crypto.createCipheriv(ALGO, k, iv);
  return iv.toString('hex') + ':' + Buffer.concat([c.update(text), c.final()]).toString('hex');
}
function decrypt(enc: string): string {
  const [ivHex, encHex] = enc.split(':');
  const k = crypto.createHash('sha256').update(ENC_KEY).digest();
  const d = crypto.createDecipheriv(ALGO, k, Buffer.from(ivHex, 'hex'));
  return Buffer.concat([d.update(Buffer.from(encHex, 'hex')), d.final()]).toString();
}

function maskProfile(p: any) {
  return { ...p, password: p.password ? '••••••••' : null };
}

// ─── GET /api/vpn-profiles ────────────────────────────────────────────────────
router.get('/', requireAuth, requirePermission('vpnprofile.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const profiles = await (prisma as any).vpnProfile.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { subscriptions: true } } },
    });
    return res.json({ success: true, profiles: profiles.map(maskProfile) });
  } catch (err) {
    console.error('vpn-profiles list error:', err);
    return res.status(500).json({ error: 'Failed to list VPN profiles' });
  }
});


// GET /api/vpn-profiles/unified — agrège les profils SSH SXB VPN
router.get("/unified", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "DB unavailable" });
    const [sshAccs, xrayAccs, singboxAccs] = await Promise.all([
      (prisma as any).sshAccount.findMany({ where: { status: "active" }, orderBy: { createdAt: "desc" } }),
      (prisma as any).xrayAccount.findMany({ where: { status: "active" }, orderBy: { createdAt: "desc" } }),
      (prisma as any).singboxAccount.findMany({ where: { status: "active" }, orderBy: { createdAt: "desc" } }),
    ]);
    const configs: any[] = [];
    async function syncProfile(data: any, namePrefix: string, proto: string) {
      const profileName = namePrefix + data.name;
      let p = await (prisma as any).vpnProfile.findFirst({ where: { name: profileName } });
      if (!p) p = await (prisma as any).vpnProfile.create({ data: {
          name: profileName, description: namePrefix.replace(/[\[\]]/g, "").trim() + " — " + data.name,
          protocol: proto, host: data.host, port: data.port,
          username: data.username || null, password: data.password || null, uuid: data.uuid || null,
          path: data.path || null, network: data.network || (proto === "ssh" ? "tcp" : "ws"),
          tls: data.tls || false, sni: data.sni || null, method: data.method || null, offlineValidDays: 7, status: "active",
      }});
      return p;
    }
    for (const a of sshAccs) { const p = await syncProfile(a, "[SSH] ", "ssh"); configs.push({ id: p.id, name: p.name, protocol: "ssh", host: a.host, port: a.port, sourceType: "ssh", status: a.status }); }
    for (const a of xrayAccs) { const pfx = "[" + a.protocol.toUpperCase() + "] "; const p = await syncProfile(a, pfx, a.protocol); configs.push({ id: p.id, name: p.name, protocol: a.protocol, host: a.host, port: a.port, sourceType: "xray", status: a.status }); }
    for (const a of singboxAccs) { const pfx = "[" + a.protocol.toUpperCase() + "-SB] "; const p = await syncProfile(a, pfx, a.protocol); configs.push({ id: p.id, name: p.name, protocol: a.protocol, host: a.host, port: a.port, sourceType: "singbox", status: a.status }); }
    return res.json({ configs });
  } catch (err) { console.error("Unified configs error:", err); return res.status(500).json({ error: "Server error" }); }
});

// ─── GET /api/vpn-profiles/:id ───────────────────────────────────────────────
router.get('/:id', requireAuth, requirePermission('vpnprofile.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const p = await (prisma as any).vpnProfile.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { subscriptions: true } } },
    });
    if (!p) return res.status(404).json({ error: 'Profile not found' });
    return res.json({ success: true, profile: maskProfile(p) });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get VPN profile' });
  }
});

// ─── POST /api/vpn-profiles ───────────────────────────────────────────────────
router.post('/', requireAuth, requirePermission('vpnprofile.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      name, description, protocol,
      host, port, username, password,
      uuid, path, network, tls, sni, dns,
      payloadId, offlineValidDays, status,
      method,
    } = req.body;

    if (!name || !protocol || !host || !port) {
      return res.status(400).json({ error: 'name, protocol, host and port are required' });
    }

    const encPassword = password ? encrypt(password) : null;

    const profile = await (prisma as any).vpnProfile.create({
      data: {
        name, description, protocol,
        host, port: Number(port),
        username: username || null,
        password: encPassword,
        uuid: uuid || (protocol !== 'ssh' ? crypto.randomUUID() : null),
        path: path || null,
        network: network || 'ws',
        tls: !!tls,
        sni: sni || null,
        dns: dns || null,
        payloadId: payloadId || null,
        offlineValidDays: offlineValidDays ? Number(offlineValidDays) : 7,
        method: method || null,
        status: status || 'active',
      },
    });

    await logDbActivity(req.user!.userId, `Created VPN profile: ${name}`, 'info', req.ip || '');
    return res.status(201).json({ success: true, profile: maskProfile(profile) });
  } catch (err: any) {
    console.error('vpn-profile create error:', err);
    return res.status(500).json({ error: err.message || 'Failed to create VPN profile' });
  }
});

// ─── PUT /api/vpn-profiles/:id ───────────────────────────────────────────────
router.put('/:id', requireAuth, requirePermission('vpnprofile.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const existing = await (prisma as any).vpnProfile.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Profile not found' });

    const {
      name, description, protocol,
      host, port, username, password,
      uuid, path, network, tls, sni, dns,
      payloadId, offlineValidDays, status, method,
    } = req.body;

    const encPassword = password ? encrypt(password) : existing.password;

    const updated = await (prisma as any).vpnProfile.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(protocol !== undefined && { protocol }),
        ...(host !== undefined && { host }),
        ...(port !== undefined && { port: Number(port) }),
        ...(username !== undefined && { username }),
        password: encPassword,
        ...(uuid !== undefined && { uuid }),
        ...(path !== undefined && { path }),
        ...(network !== undefined && { network }),
        ...(tls !== undefined && { tls: !!tls }),
        ...(sni !== undefined && { sni }),
        ...(dns !== undefined && { dns }),
        ...(payloadId !== undefined && { payloadId }),
        ...(offlineValidDays !== undefined && { offlineValidDays: Number(offlineValidDays) }),
        ...(method !== undefined && { method }),
        ...(status !== undefined && { status }),
      },
    });

    await logDbActivity(req.user!.userId, `Updated VPN profile: ${updated.name}`, 'info', req.ip || '');
    return res.json({ success: true, profile: maskProfile(updated) });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to update VPN profile' });
  }
});

// ─── DELETE /api/vpn-profiles/:id ────────────────────────────────────────────
router.delete('/:id', requireAuth, requirePermission('vpnprofile.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const existing = await (prisma as any).vpnProfile.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { subscriptions: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Profile not found' });
    if (existing._count.subscriptions > 0) {
      return res.status(409).json({ error: `Cannot delete: profile has ${existing._count.subscriptions} active subscription(s)` });
    }

    await (prisma as any).vpnProfile.delete({ where: { id: req.params.id } });
    await logDbActivity(req.user!.userId, `Deleted VPN profile: ${existing.name}`, 'warning', req.ip || '');
    return res.json({ success: true, message: 'Profile deleted' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to delete VPN profile' });
  }
});

// ─── GET /api/vpn-profiles/:id/stats ─────────────────────────────────────────
router.get('/:id/stats', requireAuth, requirePermission('vpnprofile.view'), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const total     = await (prisma as any).vpnProfile.count();
    const active    = await (prisma as any).vpnProfile.count({ where: { status: 'active' } });
    const byProtocol = await (prisma as any).vpnProfile.groupBy({ by: ['protocol'], _count: { id: true } });
    return res.json({ success: true, total, active, byProtocol });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get stats' });
  }
});

// ─── GET /api/vpn-profiles/stats/all ─────────────────────────────────────────
router.get('/stats/all', requireAuth, requirePermission('vpnprofile.view'), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const total      = await (prisma as any).vpnProfile.count();
    const active     = await (prisma as any).vpnProfile.count({ where: { status: 'active' } });
    const byProtocol = await (prisma as any).vpnProfile.groupBy({ by: ['protocol'], _count: { id: true } });
    return res.json({ success: true, total, active, byProtocol });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get stats' });
  }
});

export default router;

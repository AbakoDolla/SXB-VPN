/**
 * Xray Manager Routes — SXB VPN
 * Supports: VLESS, VMess, Trojan, Shadowsocks
 */
import { Router, Response } from 'express';
import { prisma } from '../database';
import { requireAuth, requirePermission, AuthenticatedRequest } from '../middleware/auth';
import { logDbActivity } from '../database';
import crypto from 'crypto';

const router = Router();

const PROTOCOLS = ['vless', 'vmess', 'trojan', 'shadowsocks'];
const SS_METHODS = ['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', '2022-blake3-aes-128-gcm'];

function generateLink(acc: any): string {
  const { protocol, uuid, host, port, path, tls, sni, network, name, password, method } = acc;
  try {
    if (protocol === 'vless') {
      const params = new URLSearchParams({
        type: network || 'ws',
        security: tls ? 'tls' : 'none',
        ...(sni && { sni }),
        ...(path && { path }),
      });
      return `vless://${uuid}@${host}:${port}?${params.toString()}#${encodeURIComponent(name)}`;
    }
    if (protocol === 'vmess') {
      const obj = { v: '2', ps: name, add: host, port: String(port), id: uuid, net: network || 'ws', path: path || '/', tls: tls ? 'tls' : '', sni: sni || '' };
      return 'vmess://' + Buffer.from(JSON.stringify(obj)).toString('base64');
    }
    if (protocol === 'trojan') {
      const p = new URLSearchParams({ security: tls ? 'tls' : 'none', ...(sni && { sni }), ...(path && { path }), type: network || 'ws' });
      return `trojan://${password || uuid}@${host}:${port}?${p.toString()}#${encodeURIComponent(name)}`;
    }
    if (protocol === 'shadowsocks') {
      const userInfo = Buffer.from(`${method || 'aes-256-gcm'}:${password}`).toString('base64');
      return `ss://${userInfo}@${host}:${port}#${encodeURIComponent(name)}`;
    }
  } catch { /* */ }
  return '';
}

// ─── GET /api/xray/accounts ───────────────────────────────────────────────────
router.get('/accounts', requireAuth, requirePermission('xray.view'), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const accounts = await prisma.xrayAccount.findMany({
      orderBy: { createdAt: 'desc' },
      include: { client: { select: { id: true, token: true, user: { select: { name: true, email: true } } } } },
    });
    const result = accounts.map(a => ({ ...a, link: generateLink(a) }));
    return res.json({ success: true, accounts: result });
  } catch (err) {
    console.error('Xray list error:', err);
    return res.status(500).json({ error: 'Failed to list Xray accounts' });
  }
});

// ─── POST /api/xray/accounts ─────────────────────────────────────────────────
router.post('/accounts', requireAuth, requirePermission('xray.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      name, protocol, host, port, path,
      tls = false, sni, network = 'ws',
      quotaGB, expireAt, maxDevices = 1,
      serverId, clientId, password, method,
    } = req.body;

    if (!name || !protocol || !host || !port) {
      return res.status(400).json({ error: 'name, protocol, host, port are required' });
    }
    if (!PROTOCOLS.includes(protocol)) {
      return res.status(400).json({ error: `protocol must be one of: ${PROTOCOLS.join(', ')}` });
    }

    const uuid = crypto.randomUUID();
    const quotaTotal = quotaGB ? BigInt(Math.round(quotaGB * 1024 * 1024 * 1024)) : null;

    const account = await prisma.xrayAccount.create({
      data: {
        name,
        protocol,
        uuid,
        host,
        port: Number(port),
        path: path || null,
        tls,
        sni: sni || null,
        network,
        quotaTotal,
        expireAt: expireAt ? new Date(expireAt) : null,
        maxDevices: Number(maxDevices),
        serverId: serverId || null,
        clientId: clientId || null,
        password: password || null,
        method: method || (protocol === 'shadowsocks' ? 'aes-256-gcm' : null),
        status: 'active',
      },
    });

    await logDbActivity(req.user?.userId || null, `Xray ${protocol} account "${name}" created`, 'success', req.ip);
    return res.status(201).json({ success: true, account: { ...account, link: generateLink(account) } });
  } catch (err) {
    console.error('Xray create error:', err);
    return res.status(500).json({ error: 'Failed to create Xray account' });
  }
});

// ─── PUT /api/xray/accounts/:id ──────────────────────────────────────────────
router.put('/accounts/:id', requireAuth, requirePermission('xray.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, host, port, path, tls, sni, network, quotaGB, expireAt, maxDevices, status, password, method } = req.body;
    const data: any = {};
    if (name !== undefined) data.name = name;
    if (host !== undefined) data.host = host;
    if (port !== undefined) data.port = Number(port);
    if (path !== undefined) data.path = path;
    if (tls !== undefined) data.tls = tls;
    if (sni !== undefined) data.sni = sni;
    if (network !== undefined) data.network = network;
    if (quotaGB !== undefined) data.quotaTotal = quotaGB ? BigInt(Math.round(quotaGB * 1024 * 1024 * 1024)) : null;
    if (expireAt !== undefined) data.expireAt = expireAt ? new Date(expireAt) : null;
    if (maxDevices !== undefined) data.maxDevices = Number(maxDevices);
    if (status !== undefined) data.status = status;
    if (password !== undefined) data.password = password;
    if (method !== undefined) data.method = method;

    const updated = await prisma.xrayAccount.update({ where: { id: req.params.id }, data });
    await logDbActivity(req.user?.userId || null, `Xray account "${updated.name}" updated`, 'success', req.ip);
    return res.json({ success: true, account: { ...updated, link: generateLink(updated) } });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update Xray account' });
  }
});

// ─── DELETE /api/xray/accounts/:id ───────────────────────────────────────────
router.delete('/accounts/:id', requireAuth, requirePermission('xray.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const acc = await prisma.xrayAccount.findUnique({ where: { id: req.params.id } });
    if (!acc) return res.status(404).json({ error: 'Xray account not found' });
    await prisma.xrayAccount.delete({ where: { id: req.params.id } });
    await logDbActivity(req.user?.userId || null, `Xray account "${acc.name}" deleted`, 'danger', req.ip);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete Xray account' });
  }
});

// ─── PATCH /api/xray/accounts/:id/suspend ────────────────────────────────────
router.patch('/accounts/:id/suspend', requireAuth, requirePermission('xray.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const acc = await prisma.xrayAccount.findUnique({ where: { id: req.params.id } });
    if (!acc) return res.status(404).json({ error: 'Not found' });
    const newStatus = acc.status === 'suspended' ? 'active' : 'suspended';
    await prisma.xrayAccount.update({ where: { id: req.params.id }, data: { status: newStatus } });
    return res.json({ success: true, status: newStatus });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to toggle status' });
  }
});

// ─── GET /api/xray/accounts/:id/link ─────────────────────────────────────────
router.get('/accounts/:id/link', requireAuth, requirePermission('xray.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const acc = await prisma.xrayAccount.findUnique({ where: { id: req.params.id } });
    if (!acc) return res.status(404).json({ error: 'Not found' });
    return res.json({ success: true, link: generateLink(acc), protocol: acc.protocol });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to generate link' });
  }
});

// ─── GET /api/xray/stats ─────────────────────────────────────────────────────
router.get('/stats', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const byProtocol = await prisma.xrayAccount.groupBy({
      by: ['protocol'],
      _count: { id: true },
    });
    const [total, active] = await Promise.all([
      prisma.xrayAccount.count(),
      prisma.xrayAccount.count({ where: { status: 'active' } }),
    ]);
    return res.json({ success: true, stats: { total, active, byProtocol } });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get Xray stats' });
  }
});

// ─── GET /api/xray/protocols ─────────────────────────────────────────────────
router.get('/protocols', requireAuth, (_req, res) => {
  res.json({ protocols: PROTOCOLS, methods: SS_METHODS, networks: ['ws', 'grpc', 'tcp', 'h2'] });
});

export default router;

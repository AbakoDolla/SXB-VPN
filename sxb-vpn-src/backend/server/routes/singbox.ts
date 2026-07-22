/**
 * Sing-box Manager Routes — SXB VPN
 * Supports: VLESS, Trojan, Shadowsocks, and more
 */
import { Router, Response } from 'express';
import { prisma } from '../database';
import { requireAuth, requirePermission, AuthenticatedRequest } from '../middleware/auth';
import { logDbActivity } from '../database';
import crypto from 'crypto';

const router = Router();
const PROTOCOLS = ['vless', 'trojan', 'shadowsocks', 'hysteria2', 'tuic'];

function generateSingboxConfig(acc: any): object {
  const base = {
    tag: acc.name,
    server: acc.host,
    server_port: acc.port,
  };

  if (acc.protocol === 'vless') {
    return {
      type: 'vless',
      ...base,
      uuid: acc.uuid,
      tls: acc.tls ? { enabled: true, server_name: acc.sni || acc.host } : undefined,
      transport: acc.network === 'ws' ? { type: 'ws', path: acc.path || '/' } : undefined,
    };
  }
  if (acc.protocol === 'trojan') {
    return {
      type: 'trojan',
      ...base,
      password: acc.password || acc.uuid,
      tls: { enabled: true, server_name: acc.sni || acc.host },
      transport: acc.network === 'ws' ? { type: 'ws', path: acc.path || '/' } : undefined,
    };
  }
  if (acc.protocol === 'shadowsocks') {
    return {
      type: 'shadowsocks',
      ...base,
      method: acc.method || 'aes-256-gcm',
      password: acc.password || '',
    };
  }
  return { type: acc.protocol, ...base };
}

// ─── GET /api/singbox/accounts ────────────────────────────────────────────────
router.get('/accounts', requireAuth, requirePermission('singbox.view'), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const accounts = await prisma.singboxAccount.findMany({
      orderBy: { createdAt: 'desc' },
      include: { client: { select: { id: true, token: true, user: { select: { name: true, email: true } } } } },
    });
    const result = accounts.map(a => ({ ...a, config: generateSingboxConfig(a) }));
    return res.json({ success: true, accounts: result });
  } catch (err) {
    console.error('Singbox list error:', err);
    return res.status(500).json({ error: 'Failed to list Sing-box accounts' });
  }
});

// ─── POST /api/singbox/accounts ──────────────────────────────────────────────
router.post('/accounts', requireAuth, requirePermission('singbox.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      name, protocol, host, port, path,
      tls = true, sni, network = 'ws',
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
    const finalPassword = password || (protocol === 'trojan' ? crypto.randomBytes(16).toString('hex') : null);

    const account = await prisma.singboxAccount.create({
      data: {
        name, protocol, uuid, host,
        port: Number(port),
        path: path || null,
        tls, sni: sni || null, network,
        quotaTotal,
        expireAt: expireAt ? new Date(expireAt) : null,
        maxDevices: Number(maxDevices),
        serverId: serverId || null,
        clientId: clientId || null,
        password: finalPassword,
        method: method || (protocol === 'shadowsocks' ? 'aes-256-gcm' : null),
        status: 'active',
      },
    });

    await logDbActivity(req.user?.userId || null, `Sing-box ${protocol} account "${name}" created`, 'success', req.ip);
    return res.status(201).json({ success: true, account: { ...account, config: generateSingboxConfig(account) } });
  } catch (err) {
    console.error('Singbox create error:', err);
    return res.status(500).json({ error: 'Failed to create Sing-box account' });
  }
});

// ─── PUT /api/singbox/accounts/:id ───────────────────────────────────────────
router.put('/accounts/:id', requireAuth, requirePermission('singbox.manage'), async (req: AuthenticatedRequest, res: Response) => {
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

    const updated = await prisma.singboxAccount.update({ where: { id: req.params.id }, data });
    await logDbActivity(req.user?.userId || null, `Sing-box account "${updated.name}" updated`, 'success', req.ip);
    return res.json({ success: true, account: { ...updated, config: generateSingboxConfig(updated) } });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update Sing-box account' });
  }
});

// ─── DELETE /api/singbox/accounts/:id ────────────────────────────────────────
router.delete('/accounts/:id', requireAuth, requirePermission('singbox.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const acc = await prisma.singboxAccount.findUnique({ where: { id: req.params.id } });
    if (!acc) return res.status(404).json({ error: 'Not found' });
    await prisma.singboxAccount.delete({ where: { id: req.params.id } });
    await logDbActivity(req.user?.userId || null, `Sing-box account "${acc.name}" deleted`, 'danger', req.ip);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete Sing-box account' });
  }
});

// ─── PATCH /api/singbox/accounts/:id/suspend ─────────────────────────────────
router.patch('/accounts/:id/suspend', requireAuth, requirePermission('singbox.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const acc = await prisma.singboxAccount.findUnique({ where: { id: req.params.id } });
    if (!acc) return res.status(404).json({ error: 'Not found' });
    const newStatus = acc.status === 'suspended' ? 'active' : 'suspended';
    await prisma.singboxAccount.update({ where: { id: req.params.id }, data: { status: newStatus } });
    return res.json({ success: true, status: newStatus });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to toggle status' });
  }
});

// ─── GET /api/singbox/accounts/:id/config ────────────────────────────────────
router.get('/accounts/:id/config', requireAuth, requirePermission('singbox.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const acc = await prisma.singboxAccount.findUnique({ where: { id: req.params.id } });
    if (!acc) return res.status(404).json({ error: 'Not found' });
    const config = {
      log: { level: 'info' },
      outbounds: [generateSingboxConfig(acc), { type: 'direct', tag: 'direct' }],
      route: { final: acc.name },
    };
    return res.json({ success: true, config });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to generate config' });
  }
});

// ─── GET /api/singbox/stats ───────────────────────────────────────────────────
router.get('/stats', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const byProtocol = await prisma.singboxAccount.groupBy({ by: ['protocol'], _count: { id: true } });
    const [total, active] = await Promise.all([
      prisma.singboxAccount.count(),
      prisma.singboxAccount.count({ where: { status: 'active' } }),
    ]);
    return res.json({ success: true, stats: { total, active, byProtocol } });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get Sing-box stats' });
  }
});

// ─── GET /api/singbox/protocols ──────────────────────────────────────────────
router.get('/protocols', requireAuth, (_req, res) => {
  res.json({ protocols: PROTOCOLS, networks: ['ws', 'grpc', 'tcp', 'h2'] });
});

export default router;

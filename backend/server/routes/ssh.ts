/**
 * SSH Manager Routes — SXB VPN
 * Supports Mode 1 (create) and Mode 2 (import existing SSH accounts)
 */
import { Router, Response } from 'express';
import { prisma } from '../database';
import { requireAuth, requirePermission, AuthenticatedRequest } from '../middleware/auth';
import { logDbActivity } from '../database';
import crypto from 'crypto';

const router = Router();

// Encryption helpers for SSH passwords
const ALGO = 'aes-256-cbc';
function encrypt(text: string, key: string): string {
  const iv = crypto.randomBytes(16);
  const k = crypto.createHash('sha256').update(key).digest();
  const cipher = crypto.createCipheriv(ALGO, k, iv);
  return iv.toString('hex') + ':' + Buffer.concat([cipher.update(text), cipher.final()]).toString('hex');
}
function decrypt(encrypted: string, key: string): string {
  const [ivHex, encHex] = encrypted.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const k = crypto.createHash('sha256').update(key).digest();
  const decipher = crypto.createDecipheriv(ALGO, k, iv);
  return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString();
}
const ENC_KEY = process.env.ENCRYPTION_KEY || 'sxb-vpn-32-byte-encryption-key-!';

// ─── GET /api/ssh/accounts ───────────────────────────────────────────────────
router.get('/accounts', requireAuth, requirePermission('ssh.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const accounts = await prisma.sshAccount.findMany({
      orderBy: { createdAt: 'desc' },
      include: { payload: true },
    });
    // Mask passwords in response
    const safe = accounts.map(a => ({ ...a, password: '••••••••' }));
    return res.json({ success: true, accounts: safe });
  } catch (err) {
    console.error('SSH list error:', err);
    return res.status(500).json({ error: 'Failed to list SSH accounts' });
  }
});

// ─── GET /api/ssh/accounts/:id ───────────────────────────────────────────────
router.get('/accounts/:id', requireAuth, requirePermission('ssh.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const acc = await prisma.sshAccount.findUnique({
      where: { id: req.params.id },
      include: { payload: true },
    });
    if (!acc) return res.status(404).json({ error: 'SSH account not found' });
    return res.json({ success: true, account: { ...acc, password: '••••••••' } });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get SSH account' });
  }
});

// ─── POST /api/ssh/accounts ──────────────────────────────────────────────────
// Mode 1: Create new SSH account on server
// Mode 2: Import existing SSH credentials
router.post('/accounts', requireAuth, requirePermission('ssh.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      name, host, port = 22, username, password,
      mode = 'create',
      expireAt, quotaGB, connectionLimit = 1,
      compression = false, tcpNodelay = true, slowDns = false,
      payloadId, dns, sni,
    } = req.body;

    if (!name || !host || !username || !password) {
      return res.status(400).json({ error: 'name, host, username, password are required' });
    }

    const encPwd = encrypt(password, ENC_KEY);
    const quotaTotal = quotaGB ? BigInt(Math.round(quotaGB * 1024 * 1024 * 1024)) : null;

    const account = await prisma.sshAccount.create({
      data: {
        name,
        host,
        port: Number(port),
        username,
        password: encPwd,
        mode,
        expireAt: expireAt ? new Date(expireAt) : null,
        quotaTotal,
        connectionLimit: Number(connectionLimit),
        compression,
        tcpNodelay,
        slowDns,
        payloadId: payloadId || null,
        dns: dns || null,
        sni: sni || null,
        status: 'active',
        createdBy: req.user?.userId,
      },
    });

    await logDbActivity(req.user?.userId || null, `SSH account "${name}" created (mode: ${mode})`, 'success', req.ip);
    return res.status(201).json({ success: true, account: { ...account, password: '••••••••' } });
  } catch (err) {
    console.error('SSH create error:', err);
    return res.status(500).json({ error: 'Failed to create SSH account' });
  }
});

// ─── PUT /api/ssh/accounts/:id ───────────────────────────────────────────────
router.put('/accounts/:id', requireAuth, requirePermission('ssh.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      name, host, port, username, password,
      expireAt, quotaGB, connectionLimit,
      compression, tcpNodelay, slowDns,
      payloadId, dns, sni, status,
    } = req.body;

    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (host !== undefined) updateData.host = host;
    if (port !== undefined) updateData.port = Number(port);
    if (username !== undefined) updateData.username = username;
    if (password !== undefined && password !== '••••••••') updateData.password = encrypt(password, ENC_KEY);
    if (expireAt !== undefined) updateData.expireAt = expireAt ? new Date(expireAt) : null;
    if (quotaGB !== undefined) updateData.quotaTotal = quotaGB ? BigInt(Math.round(quotaGB * 1024 * 1024 * 1024)) : null;
    if (connectionLimit !== undefined) updateData.connectionLimit = Number(connectionLimit);
    if (compression !== undefined) updateData.compression = compression;
    if (tcpNodelay !== undefined) updateData.tcpNodelay = tcpNodelay;
    if (slowDns !== undefined) updateData.slowDns = slowDns;
    if (payloadId !== undefined) updateData.payloadId = payloadId || null;
    if (dns !== undefined) updateData.dns = dns;
    if (sni !== undefined) updateData.sni = sni;
    if (status !== undefined) updateData.status = status;

    const updated = await prisma.sshAccount.update({
      where: { id: req.params.id },
      data: updateData,
    });

    await logDbActivity(req.user?.userId || null, `SSH account "${updated.name}" updated`, 'success', req.ip);
    return res.json({ success: true, account: { ...updated, password: '••••••••' } });
  } catch (err) {
    console.error('SSH update error:', err);
    return res.status(500).json({ error: 'Failed to update SSH account' });
  }
});

// ─── DELETE /api/ssh/accounts/:id ────────────────────────────────────────────
router.delete('/accounts/:id', requireAuth, requirePermission('ssh.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const acc = await prisma.sshAccount.findUnique({ where: { id: req.params.id } });
    if (!acc) return res.status(404).json({ error: 'SSH account not found' });
    await prisma.sshAccount.delete({ where: { id: req.params.id } });
    await logDbActivity(req.user?.userId || null, `SSH account "${acc.name}" deleted`, 'danger', req.ip);
    return res.json({ success: true, message: 'SSH account deleted' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete SSH account' });
  }
});

// ─── PATCH /api/ssh/accounts/:id/suspend ─────────────────────────────────────
router.patch('/accounts/:id/suspend', requireAuth, requirePermission('ssh.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const acc = await prisma.sshAccount.findUnique({ where: { id: req.params.id } });
    if (!acc) return res.status(404).json({ error: 'SSH account not found' });
    const newStatus = acc.status === 'suspended' ? 'active' : 'suspended';
    await prisma.sshAccount.update({ where: { id: req.params.id }, data: { status: newStatus } });
    await logDbActivity(req.user?.userId || null, `SSH account "${acc.name}" ${newStatus}`, 'warning', req.ip);
    return res.json({ success: true, status: newStatus });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to toggle SSH account status' });
  }
});

// ─── POST /api/ssh/accounts/:id/test ─────────────────────────────────────────
router.post('/accounts/:id/test', requireAuth, requirePermission('ssh.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const acc = await prisma.sshAccount.findUnique({ where: { id: req.params.id } });
    if (!acc) return res.status(404).json({ error: 'SSH account not found' });

    const password = decrypt(acc.password, ENC_KEY);
    const { execSync } = await import('child_process');

    try {
      // Test SSH connectivity with a 10-second timeout
      execSync(
        `sshpass -p ${JSON.stringify(password)} ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=no -p ${acc.port} ${acc.username}@${acc.host} "echo SXB_OK" 2>&1`,
        { timeout: 15000 }
      );
      return res.json({ success: true, reachable: true, message: 'SSH connection successful' });
    } catch {
      return res.json({ success: true, reachable: false, message: 'SSH connection failed — check credentials or host' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to test SSH connection' });
  }
});

// ─── GET /api/ssh/stats ───────────────────────────────────────────────────────
router.get('/stats', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const [total, active, suspended, expired] = await Promise.all([
      prisma.sshAccount.count(),
      prisma.sshAccount.count({ where: { status: 'active' } }),
      prisma.sshAccount.count({ where: { status: 'suspended' } }),
      prisma.sshAccount.count({ where: { status: 'expired' } }),
    ]);
    return res.json({ success: true, stats: { total, active, suspended, expired } });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get SSH stats' });
  }
});

export default router;

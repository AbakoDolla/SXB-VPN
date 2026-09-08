/**
 * SSH Manager Routes — SXB VPN
 * Supports Mode 1 (create) and Mode 2 (import existing SSH accounts)
 */
import { Router, Response } from 'express';
import { prisma } from '../database';
import { requireAuth, requirePermission, AuthenticatedRequest } from '../middleware/auth';
import { logDbActivity } from '../database';
import crypto from 'crypto';
import { createLockedEngineAccount, serializeEngineAccount, serializePayload, withUnlockedEngine } from '../services/profile-engines';
import { handleProfileLockError } from '../services/profile-lock';

const router = Router();

// ── Chiffrement AES-256-GCM (Phase 2) ─────────────────────────────────────────
const ENC_KEY = (() => {
  const k = process.env.ENCRYPTION_KEY;
  if (!k || k.startsWith('CHANGE_ME')) console.error('[SECURITY] ENCRYPTION_KEY non configurée dans ssh.ts!');
  return k || '';
})();

function getKey(rawKey: string): Buffer {
  return crypto.createHash('sha256').update(rawKey).digest();
}

/** Chiffrement AES-256-GCM — format : "gcm:<iv_hex>:<ciphertext_hex>:<tag_hex>" */
function encrypt(text: string, key: string): string {
  if (typeof text !== 'string' || !text) throw new TypeError('encrypt: text doit être une chaîne non vide');
  const k  = getKey(key);
  const iv = crypto.randomBytes(12);
  const c  = crypto.createCipheriv('aes-256-gcm', k, iv) as crypto.CipherGCM;
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return `gcm:${iv.toString('hex')}:${enc.toString('hex')}:${tag.toString('hex')}`;
}

/** Déchiffrement — supporte GCM (v2) et CBC (v1 legacy pour anciens mots de passe) */
function decrypt(encrypted: string, key: string): string {
  if (!encrypted) return '';
  const k = getKey(key);
  if (encrypted.startsWith('gcm:')) {
    const parts = encrypted.slice(4).split(':');
    if (parts.length !== 3) throw new Error('Format GCM invalide');
    const iv  = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[2], 'hex');
    const d   = crypto.createDecipheriv('aes-256-gcm', k, iv) as crypto.DecipherGCM;
    d.setAuthTag(tag);
    return Buffer.concat([d.update(Buffer.from(parts[1], 'hex')), d.final()]).toString();
  }
  // Rétro-compatibilité CBC v1
  const [ivHex, encHex] = encrypted.split(':');
  if (!ivHex || !encHex) return encrypted;
  const d = crypto.createDecipheriv('aes-256-cbc', k, Buffer.from(ivHex, 'hex'));
  return Buffer.concat([d.update(Buffer.from(encHex, 'hex')), d.final()]).toString();
}

// ─── GET /api/ssh/accounts ───────────────────────────────────────────────────
router.get('/accounts', requireAuth, requirePermission('ssh.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const accounts = await prisma.sshAccount.findMany({
      orderBy: { createdAt: 'desc' },
    });
    // Fetch payloads separately (Prisma client missing payload relation in generated client)
    const payloadIds = [...new Set(accounts.map((a: any) => a.payloadId).filter(Boolean))];
    const payloads = payloadIds.length > 0
      ? await (prisma as any).sshPayload.findMany({ where: { id: { in: payloadIds } } }).catch(() => [])
      : [];
    const payloadMap = Object.fromEntries(payloads.map((p: any) => [p.id, p]));
    // Mask passwords in response
    const safe = await Promise.all(accounts.map(async (a: any) => serializeEngineAccount('ssh', {
      ...a, password: '••••••••', payload: payloadMap[a.payloadId] ? await serializePayload(payloadMap[a.payloadId]) : null,
    })));
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, accounts: safe });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list SSH accounts' });
  }
});

// ─── GET /api/ssh/accounts/:id ───────────────────────────────────────────────
router.get('/accounts/:id', requireAuth, requirePermission('ssh.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const acc = await prisma.sshAccount.findUnique({
      where: { id: req.params.id },
    });
    // Fetch payload separately
    let accPayload = null;
    if ((acc as any)?.payloadId) {
      accPayload = await (prisma as any).sshPayload.findUnique({ where: { id: (acc as any).payloadId } }).catch(() => null);
    }
    if (!acc) return res.status(404).json({ error: 'SSH account not found' });
    if (req.get('X-VPN-Profile-Unlock')) {
      await withUnlockedEngine('ssh', req.params.id, req, async () => undefined);
    }
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, account: await serializeEngineAccount('ssh', { ...acc, password: '••••••••', payload: accPayload ? await serializePayload(accPayload, req) : null }, req) });
  } catch (err) {
    if (handleProfileLockError(err, res)) return;
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

    const account = await createLockedEngineAccount('ssh', req.body.lockPassword, db => db.sshAccount.create({
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
    }));

    await logDbActivity(req.user?.userId || null, `SSH account "${name}" created (mode: ${mode})`, 'success', req.ip);
    return res.status(201).json({ success: true, account: await serializeEngineAccount('ssh', { ...account, password: '••••••••' }) });
  } catch (err) {
    if (handleProfileLockError(err, res)) return;
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

    const updated = await withUnlockedEngine('ssh', req.params.id, req, db => db.sshAccount.update({
      where: { id: req.params.id },
      data: updateData,
    }));

    await logDbActivity(req.user?.userId || null, `SSH account "${updated.name}" updated`, 'success', req.ip);
    return res.json({ success: true, account: await serializeEngineAccount('ssh', { ...updated, password: '••••••••' }) });
  } catch (err) {
    if (handleProfileLockError(err, res)) return;
    return res.status(500).json({ error: 'Failed to update SSH account' });
  }
});

// ─── DELETE /api/ssh/accounts/:id ────────────────────────────────────────────
router.delete('/accounts/:id', requireAuth, requirePermission('ssh.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const acc = await prisma.sshAccount.findUnique({ where: { id: req.params.id } });
    if (!acc) return res.status(404).json({ error: 'SSH account not found' });
    await withUnlockedEngine('ssh', req.params.id, req, db => db.sshAccount.delete({ where: { id: req.params.id } }));
    await logDbActivity(req.user?.userId || null, `SSH account "${acc.name}" deleted`, 'danger', req.ip);
    return res.json({ success: true, message: 'SSH account deleted' });
  } catch (err) {
    if (handleProfileLockError(err, res)) return;
    return res.status(500).json({ error: 'Failed to delete SSH account' });
  }
});

// ─── PATCH /api/ssh/accounts/:id/suspend ─────────────────────────────────────
router.patch('/accounts/:id/suspend', requireAuth, requirePermission('ssh.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const acc = await prisma.sshAccount.findUnique({ where: { id: req.params.id } });
    if (!acc) return res.status(404).json({ error: 'SSH account not found' });
    const newStatus = acc.status === 'suspended' ? 'active' : 'suspended';
    await withUnlockedEngine('ssh', req.params.id, req, db => db.sshAccount.update({ where: { id: req.params.id }, data: { status: newStatus } }));
    await logDbActivity(req.user?.userId || null, `SSH account "${acc.name}" ${newStatus}`, 'warning', req.ip);
    return res.json({ success: true, status: newStatus });
  } catch (err) {
    if (handleProfileLockError(err, res)) return;
    return res.status(500).json({ error: 'Failed to toggle SSH account status' });
  }
});

// ─── POST /api/ssh/accounts/:id/test ─────────────────────────────────────────
router.post('/accounts/:id/test', requireAuth, requirePermission('ssh.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reachable = await withUnlockedEngine('ssh', req.params.id, req, async (_db, acc) => {
      const password = decrypt(acc.password || '', ENC_KEY);
      const { execFile } = await import('node:child_process');
      return new Promise<boolean>(resolve => {
        execFile('sshpass', ['-e', 'ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10',
          '-o', 'BatchMode=no', '-p', String(acc.port), `${acc.username}@${acc.host}`, 'echo SXB_OK'],
        { timeout: 15000, env: { ...process.env, SSHPASS: password } }, error => resolve(!error));
      });
    });
    return res.json({ success: true, reachable, message: reachable ? 'SSH connection successful' : 'SSH connection failed' });
  } catch (err) {
    if (handleProfileLockError(err, res)) return;
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

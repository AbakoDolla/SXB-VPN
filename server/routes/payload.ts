/**
 * Payload Manager Routes — SXB VPN
 */
import { Router, Response } from 'express';
import { prisma } from '../database';
import { requireAuth, requirePermission, AuthenticatedRequest } from '../middleware/auth';
import { logDbActivity } from '../database';

const router = Router();

// ─── GET /api/payload ─────────────────────────────────────────────────────────
router.get('/', requireAuth, requirePermission('payload.view'), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const payloads = await prisma.sshPayload.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { sshAccounts: true } } },
    });
    return res.json({ success: true, payloads });
  } catch (err) {
    console.error('Payload list error:', err);
    return res.status(500).json({ error: 'Failed to list payloads' });
  }
});

// ─── GET /api/payload/:id ─────────────────────────────────────────────────────
router.get('/:id', requireAuth, requirePermission('payload.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const payload = await prisma.sshPayload.findUnique({
      where: { id: req.params.id },
      include: { sshAccounts: { select: { id: true, name: true, host: true, status: true } } },
    });
    if (!payload) return res.status(404).json({ error: 'Payload not found' });
    return res.json({ success: true, payload });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get payload' });
  }
});

// ─── POST /api/payload ────────────────────────────────────────────────────────
router.post('/', requireAuth, requirePermission('payload.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, host, sni, port, headers, content } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const payload = await prisma.sshPayload.create({
      data: {
        name,
        host: host || null,
        sni: sni || null,
        port: port ? Number(port) : null,
        headers: headers || null,
        content: content || 'GET / HTTP/1.1\r\nHost: [host_port]\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
        status: 'active',
      },
    });

    await logDbActivity(req.user?.userId || null, `Payload "${name}" created`, 'success', req.ip);
    return res.status(201).json({ success: true, payload });
  } catch (err) {
    console.error('Payload create error:', err);
    return res.status(500).json({ error: 'Failed to create payload' });
  }
});

// ─── PUT /api/payload/:id ─────────────────────────────────────────────────────
router.put('/:id', requireAuth, requirePermission('payload.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, host, sni, port, headers, content, status } = req.body;
    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (host !== undefined) updateData.host = host;
    if (sni !== undefined) updateData.sni = sni;
    if (port !== undefined) updateData.port = port ? Number(port) : null;
    if (headers !== undefined) updateData.headers = headers;
    if (content !== undefined) updateData.content = content;
    if (status !== undefined) updateData.status = status;

    const updated = await prisma.sshPayload.update({ where: { id: req.params.id }, data: updateData });
    await logDbActivity(req.user?.userId || null, `Payload "${updated.name}" updated`, 'success', req.ip);
    return res.json({ success: true, payload: updated });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update payload' });
  }
});

// ─── DELETE /api/payload/:id ──────────────────────────────────────────────────
router.delete('/:id', requireAuth, requirePermission('payload.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const p = await prisma.sshPayload.findUnique({ where: { id: req.params.id } });
    if (!p) return res.status(404).json({ error: 'Payload not found' });
    // Unlink from SSH accounts before deleting
    await prisma.sshAccount.updateMany({ where: { payloadId: req.params.id }, data: { payloadId: null } });
    await prisma.sshPayload.delete({ where: { id: req.params.id } });
    await logDbActivity(req.user?.userId || null, `Payload "${p.name}" deleted`, 'danger', req.ip);
    return res.json({ success: true, message: 'Payload deleted' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete payload' });
  }
});

// ─── POST /api/payload/:id/attach ─────────────────────────────────────────────
// Associate a payload to an SSH account
router.post('/:id/attach', requireAuth, requirePermission('payload.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sshAccountId } = req.body;
    if (!sshAccountId) return res.status(400).json({ error: 'sshAccountId is required' });

    const updated = await prisma.sshAccount.update({
      where: { id: sshAccountId },
      data: { payloadId: req.params.id },
    });
    return res.json({ success: true, message: `Payload attached to SSH account ${updated.name}` });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to attach payload' });
  }
});

// ─── POST /api/payload/:id/test ───────────────────────────────────────────────
router.post('/:id/test', requireAuth, requirePermission('payload.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const payload = await prisma.sshPayload.findUnique({ where: { id: req.params.id } });
    if (!payload) return res.status(404).json({ error: 'Payload not found' });

    const host = payload.host || req.body.testHost;
    if (!host) return res.status(400).json({ error: 'No host configured for this payload' });

    const port = payload.port || 80;
    const net = await import('net');

    await new Promise<void>((resolve, reject) => {
      const socket = new net.Socket();
      socket.setTimeout(8000);
      socket.connect(port, host, () => { socket.destroy(); resolve(); });
      socket.on('error', reject);
      socket.on('timeout', () => { socket.destroy(); reject(new Error('Timeout')); });
    });

    return res.json({ success: true, reachable: true, host, port, message: 'Host is reachable' });
  } catch {
    return res.json({ success: true, reachable: false, message: 'Host not reachable' });
  }
});

export default router;

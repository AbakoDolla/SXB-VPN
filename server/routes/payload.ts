/**
 * Payload Manager Routes — SXB VPN
 */
import { Router, Response } from 'express';
import { prisma } from '../database';
import { requireAuth, requirePermission, AuthenticatedRequest } from '../middleware/auth';
import { logDbActivity } from '../database';
import { serializePayload, withUnlockedPayload, withUnlockedEngine } from '../services/profile-engines';
import { handleProfileLockError } from '../services/profile-lock';
import { auteurAInscrire, porteeCharges, porteeComptesSsh } from '../services/portee-donnees';

const router = Router();

// ═══════════════════════════════════════════════════════════════════════════
// PORTÉE DES CHARGES UTILES — MESURÉ EN PRODUCTION
// ═══════════════════════════════════════════════════════════════════════════
// Une charge utile SSH est l'en-tête d'injection qui fait passer le tunnel
// chez un opérateur donné : c'est le savoir-faire commercial de l'exploitant.
// Aucune route de ce fichier n'appliquait de portée — ni la liste, ni les cinq
// routes à identifiant. Mesuré avec un administrateur créé à l'instant :
//
//   GET /api/payload  ->  200, sans aucune restriction
//
// La table est VIDE en production (0 charge, y compris pour le haut
// privilège) : la fuite était donc LATENTE. C'est la raison pour laquelle la
// propriété est posée maintenant — aucune ligne à rattacher, donc aucun
// réglage en service ne peut disparaître d'un tableau de bord.
//
// 404 et non 403 : un refus explicite confirmerait l'existence de la charge et
// permettrait d'énumérer le catalogue identifiant par identifiant.
const CHARGE_INTROUVABLE = { error: 'Payload not found' };

async function chargerChargeVisible(req: AuthenticatedRequest, id: string): Promise<any | null> {
  const portee = await porteeCharges(prisma, req.user);
  return prisma.sshPayload.findFirst({
    where: portee ? ({ AND: [{ id }, portee] } as any) : { id },
  });
}

// ─── GET /api/payload ─────────────────────────────────────────────────────────
router.get('/', requireAuth, requirePermission('payload.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const portee = await porteeCharges(prisma, req.user);
    const payloads = await prisma.sshPayload.findMany({
      ...(portee ? { where: portee as any } : {}),
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { sshAccounts: true } } },
    });
    return res.json({ success: true, payloads: await Promise.all(payloads.map(p => serializePayload(p))) });
  } catch (err) {
    console.error('Payload list error:', err);
    return res.status(500).json({ error: 'Failed to list payloads' });
  }
});

// ─── GET /api/payload/:id ─────────────────────────────────────────────────────
router.get('/:id', requireAuth, requirePermission('payload.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!(await chargerChargeVisible(req, req.params.id))) {
      return res.status(404).json(CHARGE_INTROUVABLE);
    }
    const payload = await prisma.sshPayload.findUnique({
      where: { id: req.params.id },
      include: { sshAccounts: { select: { id: true, name: true, host: true, status: true } } },
    });
    if (!payload) return res.status(404).json(CHARGE_INTROUVABLE);
    if (req.get('X-VPN-Profile-Unlock')) await withUnlockedPayload(payload.id, req, async () => undefined);
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, payload: await serializePayload(payload, req) });
  } catch (err) {
    if (handleProfileLockError(err, res)) return;
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
        // Estampille d'auteur : c'est elle qui rendra cette charge à son
        // créateur, et à lui seul, dans un tableau de bord cloisonné.
        createdBy: auteurAInscrire(req.user),
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

    if (!(await chargerChargeVisible(req, req.params.id))) {
      return res.status(404).json(CHARGE_INTROUVABLE);
    }
    const updated = await withUnlockedPayload(req.params.id, req, db =>
      db.sshPayload.update({ where: { id: req.params.id }, data: updateData }));
    await logDbActivity(req.user?.userId || null, `Payload "${updated.name}" updated`, 'success', req.ip);
    return res.json({ success: true, payload: await serializePayload(updated) });
  } catch (err) {
    if (handleProfileLockError(err, res)) return;
    return res.status(500).json({ error: 'Failed to update payload' });
  }
});

// ─── DELETE /api/payload/:id ──────────────────────────────────────────────────
router.delete('/:id', requireAuth, requirePermission('payload.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const p = await chargerChargeVisible(req, req.params.id);
    if (!p) return res.status(404).json(CHARGE_INTROUVABLE);
    // Unlink from SSH accounts before deleting
    await withUnlockedPayload(req.params.id, req, async db => {
      await db.sshAccount.updateMany({ where: { payloadId: req.params.id }, data: { payloadId: null } });
      await db.sshPayload.delete({ where: { id: req.params.id } });
    });
    await logDbActivity(req.user?.userId || null, `Payload "${p.name}" deleted`, 'danger', req.ip);
    return res.json({ success: true, message: 'Payload deleted' });
  } catch (err) {
    if (handleProfileLockError(err, res)) return;
    return res.status(500).json({ error: 'Failed to delete payload' });
  }
});

// ─── POST /api/payload/:id/attach ─────────────────────────────────────────────
// Associate a payload to an SSH account
router.post('/:id/attach', requireAuth, requirePermission('payload.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sshAccountId } = req.body;
    if (!sshAccountId) return res.status(400).json({ error: 'sshAccountId is required' });

    // Deux propriétés à vérifier, pas une : la charge rattachée ET le compte
    // SSH qui la reçoit. Sans le second contrôle, un administrateur écrivait
    // sur le compte d'un autre exploitant en passant par cette route.
    if (!(await chargerChargeVisible(req, req.params.id))) {
      return res.status(404).json(CHARGE_INTROUVABLE);
    }
    const porteeSsh = await porteeComptesSsh(prisma, req.user);
    const compteVisible = await prisma.sshAccount.findFirst({
      where: porteeSsh ? ({ AND: [{ id: sshAccountId }, porteeSsh] } as any) : { id: sshAccountId },
    });
    if (!compteVisible) return res.status(404).json({ error: 'SSH account not found' });

    const updated = await withUnlockedEngine('ssh', sshAccountId, req, db => db.sshAccount.update({
      where: { id: sshAccountId },
      data: { payloadId: req.params.id },
    }));
    return res.json({ success: true, message: `Payload attached to SSH account ${updated.name}` });
  } catch (err) {
    if (handleProfileLockError(err, res)) return;
    return res.status(500).json({ error: 'Failed to attach payload' });
  }
});

// ─── POST /api/payload/:id/test ───────────────────────────────────────────────
router.post('/:id/test', requireAuth, requirePermission('payload.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!(await chargerChargeVisible(req, req.params.id))) {
      return res.status(404).json(CHARGE_INTROUVABLE);
    }
    const payload = await withUnlockedPayload(req.params.id, req, db =>
      db.sshPayload.findUnique({ where: { id: req.params.id } }));
    if (!payload) return res.status(404).json(CHARGE_INTROUVABLE);

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
  } catch (err) {
    if (handleProfileLockError(err, res)) return;
    return res.json({ success: true, reachable: false, message: 'Host not reachable' });
  }
});

export default router;

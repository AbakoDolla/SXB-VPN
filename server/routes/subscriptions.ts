/**
 * Subscriptions Routes — SXB VPN Core v2
 *
 * CORRECTIF v2 :
 *  - BigInt JSON : toutes les réponses passent par serializeSub()
 *    qui convertit quotaBytes/quotaUsed en Number avant JSON.stringify
 *  - Évite les crash 500 "Cannot serialize a BigInt value"
 */
import { Router, Response } from 'express';
import { prisma, inMemoryDb } from '../database';
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
// `canSeeTechnical` est volontairement OBLIGATOIRE : une valeur par défaut
// permissive rouvrirait la fuite au premier appel où on l'oublierait.
function serializeSub(sub: any, canSeeTechnical: boolean): any {
  if (!sub) return sub;
  const s = { ...sub };
  if (typeof s.quotaBytes === 'bigint') s.quotaBytes = Number(s.quotaBytes);
  if (typeof s.quotaUsed  === 'bigint') s.quotaUsed  = Number(s.quotaUsed);
  // Champs imbriqués (profile, client)
  if (s.client) s.client = serializeClient(s.client);
  if (s.profile) s.profile = serializeProfile(s.profile, canSeeTechnical);
  return s;
}

function serializeClient(c: any): any {
  if (!c) return c;
  const r = { ...c };
  if (typeof r.quotaTotal === 'bigint') r.quotaTotal = Number(r.quotaTotal);
  if (typeof r.quotaUsed  === 'bigint') r.quotaUsed  = Number(r.quotaUsed);
  return r;
}

/**
 * Vue d'un profil VPN adaptée au demandeur.
 *
 * FAILLE CORRIGÉE — cette fonction renvoyait `{ ...p }`, donc l'intégralité du
 * profil : `host`, `port`, `username`, `uuid`, `sni`, `path` et jusqu'au blob
 * `canonicalConfig`. Or un RESELLER possède `subscription.view` mais AUCUNE
 * permission `vpnprofile.view` : il ne peut pas lister les profils par leur
 * route dédiée, mais les recevait intégralement par ce chemin détourné. Il
 * pouvait ainsi relever l'infrastructure technique de tous les profils.
 *
 * Le contrat est désormais explicite : sans `vpnprofile.view`, seuls le nom
 * commercial et l'identifiant sont exposés — de quoi attribuer un profil à un
 * appareil client, jamais de quoi le reconstituer.
 */
function serializeProfile(p: any, canSeeTechnical: boolean): any {
  if (!p) return p;
  if (!canSeeTechnical) {
    return {
      id: p.id,
      name: p.name,
      displayProtocol: p.displayProtocol ?? null,
      status: p.status ?? null,
    };
  }
  // Un rôle habilité voit les champs techniques, jamais les secrets.
  // `delete` est indispensable : affecter `undefined` ne supprime pas la clé
  // pour Prisma, et JSON.stringify la conserve dès qu'elle a été copiée par le
  // spread — le blob chiffré continuait donc de sortir.
  const out: any = { ...p };
  delete out.canonicalConfig;
  out.password = p.password ? '••••••••' : null;
  out.jsonConfig = p.jsonConfig ? '(chiffré — non exposé)' : null;
  out.hasCanonicalConfig = !!p.canonicalConfig;
  return out;
}

/** true si le demandeur est habilité à voir les champs techniques d'un profil. */
function canViewTechnicalProfile(req: AuthenticatedRequest): boolean {
  if (req.user?.role === 'OWNER') return true;
  return req.user?.permissions?.includes('vpnprofile.view') === true;
}

async function assertResellerCanAssignQuota(req: AuthenticatedRequest, clientId: string, quotaBytes: bigint, previousQuotaBytes = BigInt(0)) {
  if (req.user?.role !== 'RESELLER') return null;
  const client = await prisma.vpnClient.findUnique({ where: { id: clientId }, select: { userId: true } });
  if (!client || client.userId !== req.user.userId) {
    return { status: 404, body: { error: 'errors.clients.not_found', message: 'Client VPN introuvable' } };
  }

  const reseller = await (prisma as any).reseller.findUnique({ where: { userId: req.user.userId } });
  if (!reseller) {
    return { status: 404, body: { error: 'errors.resellers.not_found', message: 'Revendeur introuvable' } };
  }
  const quotaLimit = reseller.quotaBytes ?? BigInt(0);
  if (quotaLimit === BigInt(0)) return null;

  const aggregate = await (prisma as any).subscription.aggregate({
    where: { client: { userId: req.user.userId } },
    _sum: { quotaBytes: true },
  });
  const currentUsed = aggregate._sum.quotaBytes ?? BigInt(0);
  const nextUsed = currentUsed - previousQuotaBytes + quotaBytes;
  if (nextUsed > quotaLimit) {
    return {
      status: 409,
      body: {
        error: 'errors.resellers.quota_exceeded',
        message: 'Quota revendeur insuffisant : impossible de créer ou d’attribuer ce forfait data.',
      },
    };
  }
  return null;
}

// Un revendeur ne peut construire un forfait qu'avec une configuration que
// l'administrateur lui a attribuée. Sans ce contrôle, la page d'attribution
// n'était qu'un affichage : l'API acceptait n'importe quel profileId, et un
// revendeur pouvait revendre une configuration réservée à un concurrent.
//
// Un profil SANS aucune attribution reste ouvert à tous : c'est la convention
// retenue pour les profils historiques, antérieurs à cette fonctionnalité.
async function assertResellerCanUseProfile(req: AuthenticatedRequest, profileId: string) {
  if (req.user?.role !== 'RESELLER') return null;

  const reseller = await (prisma as any).reseller.findUnique({
    where: { userId: req.user.userId },
    select: { id: true },
  });
  if (!reseller) {
    return { status: 404, body: { error: 'errors.resellers.not_found', message: 'Revendeur introuvable' } };
  }

  try {
    const liens = await (prisma as any).vpnProfileReseller.findMany({
      where: { profileId },
      select: { resellerId: true },
    });
    if (liens.length === 0) return null; // profil ouvert à tous
    if (liens.some((l: any) => l.resellerId === reseller.id)) return null;
  } catch {
    // La table d'attribution peut manquer si le schéma n'a pas encore été
    // poussé. Refuser ici bloquerait tous les revendeurs sur une base saine :
    // on laisse alors passer, le cloisonnement des clients restant assuré.
    return null;
  }

  return {
    status: 403,
    body: {
      error: 'errors.vpnprofile.not_assigned',
      message: 'Cette configuration ne vous est pas attribuée.',
    },
  };
}

// ─── GET /api/subscriptions ───────────────────────────────────────────────────
router.get('/', requireAuth, requirePermission('subscription.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const canSeeTechnical = canViewTechnicalProfile(req);
    // Un revendeur ne doit voir que les abonnements de SES clients. La requête
    // ne portait aucun filtre : il recevait l'intégralité du parc, y compris
    // les abonnements des autres revendeurs.
    const isReseller = req.user?.role === 'RESELLER';

    if (!prisma) {
      const all = inMemoryDb.subscriptions || [];
      const scoped = isReseller
        ? all.filter((s: any) => s.client?.userId === req.user?.userId)
        : all;
      return res.json({ success: true, subscriptions: scoped.map((s: any) => serializeSub(s, canSeeTechnical)) });
    }
    const subs = await (prisma as any).subscription.findMany({
      where: isReseller ? { client: { userId: req.user?.userId } } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        client:  { include: { user: true } },
        profile: true,
      },
    });
    return res.json({ success: true, subscriptions: subs.map((s: any) => serializeSub(s, canSeeTechnical)) });
  } catch (err: any) {
    console.error('subscriptions list error:', err);
    return res.status(500).json({ error: err.message || 'Failed to list subscriptions' });
  }
});

// ─── GET /api/subscriptions/stats ────────────────────────────────────────────
router.get('/stats', requireAuth, requirePermission('subscription.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const isReseller = req.user?.role === 'RESELLER';
    if (!prisma) {
      const subs = isReseller
        ? (inMemoryDb.subscriptions || []).filter((s: any) => s.client?.userId === req.user?.userId)
        : inMemoryDb.subscriptions || [];
      const total   = subs.length;
      const active  = subs.filter(s => s.status === 'active').length;
      const expired = subs.filter(s => s.status === 'expired').length;
      return res.json({ success: true, total, active, expired });
    }
    const scope = isReseller ? { client: { userId: req.user?.userId } } : undefined;
    const total   = await (prisma as any).subscription.count({ where: scope });
    const active  = await (prisma as any).subscription.count({ where: { ...(scope || {}), status: 'active' } });
    const expired = await (prisma as any).subscription.count({ where: { ...(scope || {}), status: 'expired' } });
    return res.json({ success: true, total, active, expired });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to get stats' });
  }
});

// ─── GET /api/subscriptions/:id ──────────────────────────────────────────────
router.get('/:id', requireAuth, requirePermission('subscription.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const canSeeTechnical = canViewTechnicalProfile(req);
    const isReseller = req.user?.role === 'RESELLER';
    if (!prisma) {
      const sub = (inMemoryDb.subscriptions || []).find((s) => s.id === req.params.id);
      if (!sub) return res.status(404).json({ error: 'Subscription not found' });
      return res.json({ success: true, subscription: serializeSub(sub, canSeeTechnical) });
    }
    const sub = await (prisma as any).subscription.findUnique({
      where: { id: req.params.id },
      include: { client: { include: { user: true } }, profile: true },
    });
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });
    // Un revendeur ne doit pas pouvoir consulter l'abonnement d'un autre en
    // devinant son identifiant : la réponse est un 404, pas un 403, afin de ne
    // pas confirmer l'existence de la ressource.
    if (isReseller && sub.client?.userId !== req.user?.userId) {
      return res.status(404).json({ error: 'Subscription not found' });
    }
    return res.json({ success: true, subscription: serializeSub(sub, canSeeTechnical) });
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
    const quotaError = await assertResellerCanAssignQuota(req, clientId, quotaBytes);
    if (quotaError) return res.status(quotaError.status).json(quotaError.body);
    const profileError = await assertResellerCanUseProfile(req, profileId);
    if (profileError) return res.status(profileError.status).json(profileError.body);
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
    return res.status(201).json({ success: true, subscription: serializeSub(sub, canViewTechnicalProfile(req)) });
  } catch (err: any) {
    console.error('subscription create error:', err);
    return res.status(500).json({ error: err.message || 'Failed to create subscription' });
  }
});

// ─── POST /api/subscriptions/bulk ────────────────────────────────────────────
//
// Opérations groupées. L'exploitation porte sur des centaines de clients :
// les éditer un par un n'est pas tenable.
//
// Quatre actions dont la sémantique ne doit JAMAIS être confondue :
//   deploy          — crée un forfait (profil + quota + durée) pour N clients
//   set             — REMPLACE quota et/ou durée des forfaits visés
//   add_data        — AJOUTE du quota au solde existant (ne l'écrase pas)
//   extend_duration — AJOUTE des jours à l'échéance existante
//
// « set » et « add » restent deux actions distinctes et nommées : c'est la
// confusion entre les deux qui fait perdre le solde d'un client.
router.post('/bulk', requireAuth, requirePermission('subscription.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { action, clientIds, subscriptionIds, profileId, quotaGB, durationDays } = req.body ?? {};
    const ACTIONS = ['deploy', 'set', 'add_data', 'extend_duration'];
    if (!ACTIONS.includes(String(action))) {
      return res.status(400).json({ error: 'errors.bulk.invalid_action', message: `action doit valoir : ${ACTIONS.join(', ')}` });
    }
    if (!prisma) return res.status(503).json({ error: 'errors.db.unavailable', message: 'Base de données indisponible' });

    const isReseller = req.user?.role === 'RESELLER';
    const gbToBytes = (gb: any) => BigInt(Math.round(Number(gb) * 1024 ** 3));
    const details: Array<{ id: string; status: string; reason?: string }> = [];
    let succeeded = 0, skipped = 0, failed = 0;

    // ── Cibles ──────────────────────────────────────────────────────────────
    // `deploy` crée des forfaits : il vise des CLIENTS. Les autres actions
    // modifient l'existant : elles visent des ABONNEMENTS.
    const targetIds: string[] = (action === 'deploy' ? clientIds : subscriptionIds) ?? [];
    if (!Array.isArray(targetIds) || targetIds.length === 0) {
      return res.status(400).json({
        error: 'errors.bulk.no_target',
        message: action === 'deploy' ? 'clientIds est requis' : 'subscriptionIds est requis',
      });
    }

    // ── Contrôle du quota revendeur sur le CUMUL ────────────────────────────
    // Vérifier client par client laisserait passer 100 × 5 Go pour un
    // revendeur qui n'a que 100 Go : chaque appel isolé serait valide. Le
    // total est donc évalué AVANT toute écriture, et l'opération entière est
    // refusée plutôt qu'appliquée à moitié.
    if (isReseller && (action === 'deploy' || action === 'set' || action === 'add_data')) {
      const reseller = await (prisma as any).reseller.findUnique({ where: { userId: req.user!.userId } });
      if (!reseller) return res.status(404).json({ error: 'errors.resellers.not_found', message: 'Revendeur introuvable' });
      const quotaLimit: bigint = reseller.quotaBytes ?? BigInt(0);
      if (quotaLimit > BigInt(0)) {
        const aggregate = await (prisma as any).subscription.aggregate({
          where: { client: { userId: req.user!.userId } },
          _sum: { quotaBytes: true },
        });
        const currentUsed: bigint = aggregate._sum.quotaBytes ?? BigInt(0);
        const unit = quotaGB !== undefined ? gbToBytes(quotaGB) : BigInt(0);

        let projected = currentUsed;
        if (action === 'deploy') {
          projected = currentUsed + unit * BigInt(targetIds.length);
        } else if (action === 'add_data') {
          projected = currentUsed + unit * BigInt(targetIds.length);
        } else if (action === 'set' && quotaGB !== undefined) {
          // « set » remplace : on retire les quotas actuels des forfaits visés
          // avant d'ajouter les nouveaux, sinon on compterait deux fois.
          const current = await (prisma as any).subscription.aggregate({
            where: { id: { in: targetIds }, client: { userId: req.user!.userId } },
            _sum: { quotaBytes: true },
          });
          projected = currentUsed - (current._sum.quotaBytes ?? BigInt(0)) + unit * BigInt(targetIds.length);
        }
        if (projected > quotaLimit) {
          const toGb = (b: bigint) => (Number(b) / 1024 ** 3).toFixed(2);
          return res.status(409).json({
            error: 'errors.resellers.quota_exceeded',
            message: `Quota revendeur insuffisant : cette opération porterait le total à ${toGb(projected)} Go pour une limite de ${toGb(quotaLimit)} Go.`,
          });
        }
      }
    }

    // ── deploy ──────────────────────────────────────────────────────────────
    if (action === 'deploy') {
      if (!profileId || quotaGB === undefined || durationDays === undefined) {
        return res.status(400).json({ error: 'errors.bulk.missing_fields', message: 'profileId, quotaGB et durationDays sont requis' });
      }
      const profile = await (prisma as any).vpnProfile.findUnique({ where: { id: profileId } });
      if (!profile) return res.status(404).json({ error: 'Profil VPN introuvable' });

      const quotaBytes = gbToBytes(quotaGB);
      for (const clientId of targetIds) {
        try {
          const client = await prisma.vpnClient.findUnique({ where: { id: clientId }, select: { id: true, userId: true } });
          // 404 et non 403 : ne pas confirmer l'existence d'une ressource
          // appartenant à autrui (convention du dépôt).
          if (!client || (isReseller && client.userId !== req.user!.userId)) {
            failed++; details.push({ id: clientId, status: 'failed', reason: 'Client introuvable' });
            continue;
          }
          const startAt  = new Date();
          const expireAt = new Date(startAt.getTime() + Number(durationDays) * 24 * 3600 * 1000);
          await (prisma as any).subscription.create({
            data: {
              name: `${profile.name} — ${Number(durationDays)}j`,
              clientId, profileId,
              dataToken: generateDataToken(),
              quotaBytes, quotaUsed: BigInt(0),
              durationDays: Number(durationDays),
              deviceLimit: 1,
              startAt, expireAt,
              status: 'active',
              createdBy: req.user!.userId,
            },
          });
          succeeded++; details.push({ id: clientId, status: 'ok' });
        } catch (e: any) {
          // Un échec isolé ne doit pas interrompre les autres : sur 150 clients,
          // l'opérateur veut le maximum de réussites et la liste des échecs.
          failed++; details.push({ id: clientId, status: 'failed', reason: e?.message || 'Erreur inconnue' });
        }
      }
    } else {
      // ── set / add_data / extend_duration ──────────────────────────────────
      for (const subId of targetIds) {
        try {
          const sub = await (prisma as any).subscription.findUnique({
            where: { id: subId },
            include: { client: { select: { userId: true } } },
          });
          if (!sub || (isReseller && sub.client?.userId !== req.user!.userId)) {
            failed++; details.push({ id: subId, status: 'failed', reason: 'Forfait introuvable' });
            continue;
          }

          const data: Record<string, any> = {};
          if (action === 'set') {
            if (quotaGB !== undefined) data.quotaBytes = gbToBytes(quotaGB);
            if (durationDays !== undefined) {
              data.durationDays = Number(durationDays);
              data.expireAt = new Date(Date.now() + Number(durationDays) * 24 * 3600 * 1000);
            }
          } else if (action === 'add_data') {
            if (quotaGB === undefined) {
              failed++; details.push({ id: subId, status: 'failed', reason: 'quotaGB requis' });
              continue;
            }
            data.quotaBytes = (sub.quotaBytes ?? BigInt(0)) + gbToBytes(quotaGB);
          } else {
            if (durationDays === undefined) {
              failed++; details.push({ id: subId, status: 'failed', reason: 'durationDays requis' });
              continue;
            }
            // Prolonger un forfait DÉJÀ EXPIRÉ doit le réactiver : repartir de
            // son ancienne échéance laisserait la nouvelle date dans le passé.
            const base = sub.expireAt && new Date(sub.expireAt) > new Date() ? new Date(sub.expireAt) : new Date();
            data.expireAt = new Date(base.getTime() + Number(durationDays) * 24 * 3600 * 1000);
            data.durationDays = Number(sub.durationDays ?? 0) + Number(durationDays);
            if (sub.status === 'expired') data.status = 'active';
          }

          if (Object.keys(data).length === 0) {
            skipped++; details.push({ id: subId, status: 'skipped', reason: 'Aucune modification demandée' });
            continue;
          }
          await (prisma as any).subscription.update({ where: { id: subId }, data });
          succeeded++; details.push({ id: subId, status: 'ok' });
        } catch (e: any) {
          failed++; details.push({ id: subId, status: 'failed', reason: e?.message || 'Erreur inconnue' });
        }
      }
    }

    await logDbActivity(
      req.user!.userId,
      `Opération groupée "${action}" : ${succeeded} réussis, ${skipped} ignorés, ${failed} échoués (${targetIds.length} sélectionnés)`,
      failed > 0 ? 'warning' : 'info',
      req.ip || '',
    );
    return res.json({ success: true, action, selected: targetIds.length, succeeded, skipped, failed, details });
  } catch (err: any) {
    console.error('subscription bulk error:', err);
    return res.status(500).json({ error: err.message || 'Échec de l’opération groupée' });
  }
});

// ─── PUT /api/subscriptions/:id ──────────────────────────────────────────────
router.put('/:id', requireAuth, requirePermission('subscription.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const existing = await (prisma as any).subscription.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Subscription not found' });
    const { name, quotaGB, durationDays, deviceLimit, status, profileId } = req.body;
    if (req.user?.role === 'RESELLER') {
      const quotaBytes = quotaGB !== undefined
        ? BigInt(Math.round(Number(quotaGB) * 1024 ** 3))
        : existing.quotaBytes;
      const quotaError = await assertResellerCanAssignQuota(req, existing.clientId, quotaBytes, existing.quotaBytes);
      if (quotaError) return res.status(quotaError.status).json(quotaError.body);
    }

    // Changer la configuration d'un forfait existant évitait jusqu'ici de passer
    // par une suppression puis une recréation — laquelle change le jeton data et
    // oblige le client à réactiver son appareil. Le revendeur reste tenu de
    // choisir parmi les configurations qui lui sont attribuées.
    if (profileId !== undefined && profileId !== existing.profileId) {
      const profil = await (prisma as any).vpnProfile.findUnique({ where: { id: profileId } });
      if (!profil) return res.status(404).json({ error: 'Profil VPN introuvable' });
      const profileError = await assertResellerCanUseProfile(req, profileId);
      if (profileError) return res.status(profileError.status).json(profileError.body);
    }

    const updated = await (prisma as any).subscription.update({
      where: { id: req.params.id },
      data: {
        ...(name         !== undefined && { name }),
        ...(profileId    !== undefined && { profileId }),
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
    return res.json({ success: true, subscription: serializeSub(updated, canViewTechnicalProfile(req)) });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to update subscription' });
  }
});

// ─── DELETE /api/subscriptions/:id ───────────────────────────────────────────
router.delete('/:id', requireAuth, requirePermission('subscription.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const existing = await (prisma as any).subscription.findUnique({
      where: { id: req.params.id },
      include: req.user?.role === 'RESELLER' ? { client: true } : undefined,
    });
    if (!existing) return res.status(404).json({ error: 'Subscription not found' });
    if (req.user?.role === 'RESELLER' && existing.client?.userId !== req.user.userId) {
      return res.status(404).json({ error: 'Subscription not found' });
    }
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
    if (req.user?.role === 'RESELLER') {
      const existing = await (prisma as any).subscription.findUnique({ where: { id: req.params.id }, include: { client: true } });
      if (!existing || existing.client?.userId !== req.user.userId) {
        return res.status(404).json({ error: 'Subscription not found' });
      }
    }
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

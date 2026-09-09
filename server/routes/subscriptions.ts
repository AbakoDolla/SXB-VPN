/**
 * Subscriptions Routes — SXB VPN Core v2
 *
 * CORRECTIF v2 :
 *  - BigInt JSON : toutes les réponses passent par serializeSub()
 *    qui convertit quotaBytes/quotaUsed en chaînes exactes avant JSON.stringify
 *  - Évite les crash 500 "Cannot serialize a BigInt value"
 */
import { Router, Response } from 'express';
import { accessStateHub } from '../services/access-state-events';
import { z } from 'zod';
import { prisma, inMemoryDb } from '../database';
import { requireAuth, requirePermission, AuthenticatedRequest } from '../middleware/auth';
import { logDbActivity } from '../database';
import {
  calculerAllocation,
  estIllimite,
  executerMutationQuota,
  PlafondQuotaDepasse,
  verifierAllocation,
} from '../services/reseller-quota';
import {
  chargerFicheRevendeur,
  refusAccesProprietaireClient,
  exigerAccesRevendeur,
  interdireMutationSupport,
  porteeClientsRevendeur,
  possedeClient,
  refusPropriete,
  refusSiPlafondAtteint,
  reponsePlafondDepasse,
} from '../services/reseller-access';
import crypto from 'crypto';

const router = Router();
const GIB = 1024 ** 3;

const identifiantSchema = z.string().trim().min(1).max(100);
const quotaGbSchema = z.coerce.number().finite()
  .positive('Le quota doit être supérieur à 0 Go.')
  .max(1_000_000, 'Le quota ne peut pas dépasser 1 000 000 Go.');
const durationDaysSchema = z.coerce.number()
  .int('La durée doit être un nombre entier de jours.')
  .min(1, 'La durée doit être d’au moins 1 jour.')
  .max(3650, 'La durée ne peut pas dépasser 3650 jours.');
const deviceLimitSchema = z.coerce.number()
  .int('Le nombre d’appareils doit être entier.')
  .min(1, 'Au moins 1 appareil est requis.')
  .max(100, 'Le nombre d’appareils ne peut pas dépasser 100.');
const subscriptionStatusSchema = z.enum(['active', 'suspended', 'expired', 'revoked']);

const createSubscriptionSchema = z.object({
  clientId: identifiantSchema,
  profileId: identifiantSchema,
  // Un nom vide demande le nom automatique, y compris depuis un ancien dashboard.
  name: z.string().trim().max(160, 'Le nom ne peut pas dépasser 160 caractères.').optional(),
  quotaGB: quotaGbSchema,
  durationDays: durationDaysSchema,
  deviceLimit: deviceLimitSchema.default(1),
  deviceId: z.string().trim().min(1).max(255).optional(),
}).strict();

const updateSubscriptionSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  profileId: identifiantSchema.optional(),
  quotaGB: quotaGbSchema.optional(),
  durationDays: durationDaysSchema.optional(),
  deviceLimit: deviceLimitSchema.optional(),
  status: subscriptionStatusSchema.optional(),
}).strict().refine((body) => Object.keys(body).length > 0, {
  message: 'Au moins une modification est requise',
});

const bulkSubscriptionSchema = z.object({
  action: z.enum(['deploy', 'set', 'add_data', 'extend_duration']),
  clientIds: z.array(identifiantSchema).max(1000).optional(),
  subscriptionIds: z.array(identifiantSchema).max(1000).optional(),
  profileId: identifiantSchema.optional(),
  quotaGB: quotaGbSchema.optional(),
  durationDays: durationDaysSchema.optional(),
}).strict().superRefine((body, ctx) => {
  const cibles = body.action === 'deploy' ? body.clientIds : body.subscriptionIds;
  if (!cibles?.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: body.action === 'deploy' ? 'clientIds est requis' : 'subscriptionIds est requis' });
  }
  if (body.action === 'deploy') {
    if (!body.profileId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'profileId est requis' });
    if (body.quotaGB === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'quotaGB est requis' });
    if (body.durationDays === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'durationDays est requis' });
  }
  if (body.action === 'set' && body.quotaGB === undefined && body.durationDays === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'quotaGB ou durationDays est requis' });
  }
  if (body.action === 'add_data' && body.quotaGB === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'quotaGB est requis' });
  }
  if (body.action === 'extend_duration' && body.durationDays === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'durationDays est requis' });
  }
});

const revokeSubscriptionSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();

function gigabytesToBytes(gigabytes: number): bigint {
  return BigInt(Math.round(gigabytes * GIB));
}

function formatGigabytes(bytes: bigint): string {
  const hundredths = (bytes * BigInt(100)) / BigInt(GIB);
  return `${hundredths / BigInt(100)}.${(hundredths % BigInt(100)).toString().padStart(2, '0')}`;
}

function generateDataToken(): string {
  const part = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `SXB-DATA-${part()}-${part()}-${part()}`;
}

// ── BigInt → chaîne exacte avant sérialisation JSON ───────────────────────────
// JSON.stringify plante avec "Cannot serialize a BigInt value" si on laisse
// les champs BigInt de Prisma bruts.
// `canSeeTechnical` est volontairement OBLIGATOIRE : une valeur par défaut
// permissive rouvrirait la fuite au premier appel où on l'oublierait.
function serializeSub(sub: any, canSeeTechnical: boolean): any {
  if (!sub) return sub;
  const s = { ...sub };
  if (typeof s.quotaBytes === 'bigint') s.quotaBytes = s.quotaBytes.toString();
  if (typeof s.quotaUsed  === 'bigint') s.quotaUsed  = s.quotaUsed.toString();
  // Champs imbriqués (profile, client)
  if (s.client) s.client = serializeClient(s.client);
  if (s.profile) s.profile = serializeProfile(s.profile, canSeeTechnical);
  if (!canSeeTechnical || s.profile?.isLocked) delete s.technicalProtocol;
  // Identité du revendeur remontée au niveau du forfait : le client imbriqué
  // ne la portait nulle part, si bien qu'un administrateur lisant la liste des
  // forfaits ne pouvait pas dire de quel revendeur relevait chaque ligne.
  s.resellerId = s.client?.resellerId ?? null;
  s.resellerName = s.client?.reseller?.name ?? null;
  return s;
}

function serializeClient(c: any): any {
  if (!c) return c;
  const r = { ...c };
  if (typeof r.quotaTotal === 'bigint') r.quotaTotal = r.quotaTotal.toString();
  if (typeof r.quotaUsed  === 'bigint') r.quotaUsed  = r.quotaUsed.toString();
  if (r.user && r.user.passwordHash) {
    r.user = { ...r.user };
    delete r.user.passwordHash;
  }
  // Revendeur imbriqué réduit à son identité : ni quota, ni secret.
  if (r.reseller) {
    r.reseller = {
      id: r.reseller.id,
      name: r.reseller.user?.name ?? null,
      email: r.reseller.user?.email ?? null,
      status: r.reseller.status ?? null,
      accessExpiresAt: r.reseller.accessExpiresAt ?? null,
    };
  } else {
    r.reseller = null;
  }
  r.resellerId = c.resellerId ?? r.reseller?.id ?? null;
  return r;
}

/** Include commun : le forfait, son client et l'identité de son revendeur. */
const INCLUDE_FORFAIT = {
  client: { include: { user: true, reseller: { include: { user: { select: { id: true, name: true, email: true } } } } } },
  profile: true,
} as const;

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
import { serializeLockedProfile } from '../services/profile-lock';

function serializeProfile(p: any, canSeeTechnical: boolean): any {
  return p ? serializeLockedProfile(p, undefined, canSeeTechnical) : p;
}

/** true si le demandeur est habilité à voir les champs techniques d'un profil. */
function canViewTechnicalProfile(req: AuthenticatedRequest): boolean {
  if (req.user?.role === 'OWNER') return true;
  if (req.user?.role !== 'SUPER_ADMIN' && req.user?.role !== 'ADMIN') return false;
  return req.user.permissions?.includes('vpnprofile.view') === true;
}

async function assertResellerCanAssignQuota(req: AuthenticatedRequest, clientId: string, quotaBytes: bigint, previousQuotaBytes = BigInt(0), subscriptionId?: string) {
  if (req.user?.role !== 'RESELLER') return null;
  const client = await prisma.vpnClient.findUnique({
    where: { id: clientId },
    select: { userId: true, resellerId: true, subscriptions: { select: { id: true } } },
  });
  const fiche = (req as any).reseller ?? (await chargerFicheRevendeur(prisma, req.user.userId));
  // 404 et non 403 quand le client n'existe pas ; refus de propriété explicite
  // quand il appartient à un autre revendeur — les deux cas sont distincts et
  // le second doit être nommé pour être diagnostiquable.
  if (!client) {
    return { status: 404, body: { error: 'errors.clients.not_found', message: 'Client VPN introuvable' } };
  }
  if (!possedeClient(client, fiche)) {
    return refusPropriete();
  }
  // Le forfait en cours de modification est retiré du cumul, sinon son ancien
  // volume serait compté en plus du nouveau.
  return verifierAllocation(prisma, {
    role: req.user.role,
    userId: req.user.userId,
    demande: quotaBytes,
    exclureSubscriptionId: subscriptionId,
    exclureClientId: !subscriptionId && client.subscriptions.length === 0 ? clientId : undefined,
  });
}

// Un revendeur ne peut construire un forfait qu'avec une configuration que
// l'administrateur lui a attribuée. Sans ce contrôle, la page d'attribution
// n'était qu'un affichage : l'API acceptait n'importe quel profileId, et un
// revendeur pouvait revendre une configuration réservée à un concurrent.
//
// La règle est la même que celle de `/vpn-profiles/assigned` : seule une
// attribution explicite ouvre l'accès. L'API ne doit jamais être plus
// permissive que l'écran qui la précède, sinon la restriction n'est qu'une
// convention d'affichage contournable par un appel direct.
async function assertResellerCanUseProfile(req: AuthenticatedRequest, profileId: string) {
  const profile = await (prisma as any).vpnProfile.findUnique({
    where: { id: profileId },
    select: { id: true, status: true },
  });
  if (!profile) {
    return { status: 404, body: { error: 'errors.vpnprofile.not_found', message: 'Profil VPN introuvable' } };
  }
  if (profile.status !== 'active') {
    return {
      status: 409,
      body: { error: 'errors.vpnprofile.archived', message: 'Cette configuration VPN est archivée.' },
    };
  }
  if (req.user?.role !== 'RESELLER') return null;

  const reseller = await (prisma as any).reseller.findUnique({
    where: { userId: req.user.userId },
    select: { id: true },
  });
  if (!reseller) {
    return { status: 404, body: { error: 'errors.resellers.not_found', message: 'Revendeur introuvable' } };
  }

  const lien = await (prisma as any).vpnProfileReseller.findFirst({
    where: { profileId, resellerId: reseller.id },
    select: { profileId: true },
  });
  if (lien) return null;

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
      const ficheMemoire = isReseller ? await chargerFicheRevendeur(null, req.user?.userId) : null;
      const scoped = isReseller
        ? all.filter((s: any) => possedeClient(s.client, ficheMemoire))
        : all;
      return res.json({ success: true, subscriptions: scoped.map((s: any) => serializeSub(s, canSeeTechnical)) });
    }
    const subs = await (prisma as any).subscription.findMany({
      where: isReseller ? { client: porteeClientsRevendeur(await chargerFicheRevendeur(prisma, req.user?.userId)) } : undefined,
      orderBy: { createdAt: 'desc' },
      include: INCLUDE_FORFAIT,
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
      const ficheMemoire = isReseller ? await chargerFicheRevendeur(null, req.user?.userId) : null;
      const subs = isReseller
        ? (inMemoryDb.subscriptions || []).filter((s: any) => possedeClient(s.client, ficheMemoire))
        : inMemoryDb.subscriptions || [];
      const total   = subs.length;
      const active  = subs.filter(s => s.status === 'active').length;
      const expired = subs.filter(s => s.status === 'expired').length;
      return res.json({ success: true, total, active, expired });
    }
    const scope = isReseller
      ? { client: porteeClientsRevendeur(await chargerFicheRevendeur(prisma, req.user?.userId)) }
      : undefined;
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
      include: INCLUDE_FORFAIT,
    });
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });
    // Un revendeur ne doit pas pouvoir consulter l'abonnement d'un autre en
    // devinant son identifiant : la réponse est un 404, pas un 403, afin de ne
    // pas confirmer l'existence de la ressource.
    if (isReseller && !possedeClient(sub.client, await chargerFicheRevendeur(prisma, req.user?.userId))) {
      return res.status(404).json({ error: 'Subscription not found' });
    }
    return res.json({ success: true, subscription: serializeSub(sub, canSeeTechnical) });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to get subscription' });
  }
});

// ─── POST /api/subscriptions ──────────────────────────────────────────────────
//
// SEUL point d'attribution d'un plan. Il est explicite et exige les deux
// choix : UN client possédé et UN profil VPN attribué au revendeur. Aucune
// autre route ne crée de forfait — ni l'activation d'un appareil, ni la
// création d'un client.
router.post(
  '/',
  requireAuth,
  interdireMutationSupport(),
  requirePermission('subscription.manage'),
  exigerAccesRevendeur(),
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = createSubscriptionSchema.parse(req.body);
    const { clientId, profileId, name, quotaGB, durationDays, deviceLimit, deviceId } = body;

    const [client, profile] = await Promise.all([
      prisma.vpnClient.findUnique({ where: { id: clientId } }),
      (prisma as any).vpnProfile.findUnique({ where: { id: profileId } }),
    ]);
    if (!client) return res.status(404).json({ error: 'Client VPN introuvable' });
    if (!profile) return res.status(404).json({ error: 'Profil VPN introuvable' });
    const accessError = await refusAccesProprietaireClient(prisma, client);
    if (accessError) return res.status(accessError.status).json(accessError.body);

    const quotaBytes = gigabytesToBytes(quotaGB);
    // Plafond déjà atteint : refus nommé avant même le calcul détaillé, pour
    // que l'interface puisse afficher l'état plutôt qu'une erreur générique.
    const plafondAtteint = await refusSiPlafondAtteint(prisma, {
      role: req.user?.role,
      userId: req.user?.userId,
      fiche: (req as any).reseller,
    });
    if (plafondAtteint) return res.status(plafondAtteint.status).json(plafondAtteint.body);
    const quotaError = await assertResellerCanAssignQuota(req, clientId, quotaBytes);
    if (quotaError) return res.status(quotaError.status).json(quotaError.body);
    const profileError = await assertResellerCanUseProfile(req, profileId);
    if (profileError) return res.status(profileError.status).json(profileError.body);
    const startAt    = new Date();
    const expireAt   = new Date(startAt.getTime() + durationDays * 24 * 3600 * 1000);
    const dataToken  = generateDataToken();

    const sub: any = await executerMutationQuota(prisma, {
      resellerUserId: client.userId,
      resellerId: client.resellerId ?? null,
      auteur: { userId: req.user?.userId, email: req.user?.email },
      reason: `Creation du forfait ${name || profile.name}`,
      referenceType: 'subscription',
    }, (tx) => (tx as any).subscription.create({
      data: {
        name:        name || `${profile.name} — ${durationDays}j`,
        clientId,
        profileId,
        dataToken,
        quotaBytes,
        quotaUsed:    BigInt(0),
        durationDays,
        deviceLimit,
        deviceId:     deviceId || null,
        startAt,
        expireAt,
        status:       'active',
        createdBy:    req.user!.userId,
      },
      include: INCLUDE_FORFAIT,
    }));

    await logDbActivity(req.user!.userId, `Forfait créé : "${sub.name}" pour client ${clientId}`, 'info', req.ip || '');
    return res.status(201).json({ success: true, subscription: serializeSub(sub, canViewTechnicalProfile(req)) });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'errors.validation', details: err.issues });
    }
    if (err instanceof PlafondQuotaDepasse) {
      return res.status(409).json(reponsePlafondDepasse(err.alloue, err.plafond));
    }
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
router.post(
  '/bulk',
  requireAuth,
  interdireMutationSupport(),
  requirePermission('subscription.manage'),
  exigerAccesRevendeur(),
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = bulkSubscriptionSchema.parse(req.body);
    const { action, clientIds, subscriptionIds, profileId, quotaGB, durationDays } = body;
    if (!prisma) return res.status(503).json({ error: 'errors.db.unavailable', message: 'Base de données indisponible' });

    const isReseller = req.user?.role === 'RESELLER';
    const details: Array<{ id: string; status: string; reason?: string }> = [];
    let succeeded = 0, skipped = 0, failed = 0;

    // ── Cibles ──────────────────────────────────────────────────────────────
    // `deploy` crée des forfaits : il vise des CLIENTS. Les autres actions
    // modifient l'existant : elles visent des ABONNEMENTS.
    const targetIds = [...new Set((action === 'deploy' ? clientIds : subscriptionIds) ?? [])];

    // ── Contrôle du quota revendeur sur le CUMUL ────────────────────────────
    // Vérifier client par client laisserait passer 100 × 5 Go pour un
    // revendeur qui n'a que 100 Go : chaque appel isolé serait valide. Le
    // total est donc évalué AVANT toute écriture, et l'opération entière est
    // refusée plutôt qu'appliquée à moitié.
    if (isReseller && (action === 'deploy' || action === 'set' || action === 'add_data')) {
      const reseller = (req as any).reseller ?? (await (prisma as any).reseller.findUnique({ where: { userId: req.user!.userId } }));
      if (!reseller) return res.status(403).json({ error: 'errors.resellers.not_found', code: 'RESELLER_ACCOUNT_REQUIRED', message: 'Aucune fiche revendeur : impossible d’attribuer du quota.' });
      const quotaLimit: bigint = BigInt(reseller.quotaBytes ?? 0);
      // Un plafond négatif vaut « illimité ». Un plafond nul interdit toute
      // allocation : c'est l'inverse de l'ancien comportement, où 0 laissait
      // tout passer et vidait la notion même de quota attribué.
      if (!estIllimite(quotaLimit)) {
        const detail = await calculerAllocation(prisma, reseller);
        const alloue = detail.alloue;
        const unit = quotaGB !== undefined ? gigabytesToBytes(quotaGB) : BigInt(0);
        let projected = alloue;
        if (action === 'deploy') {
          const ownedTargets = await (prisma as any).vpnClient.count({
            where: { id: { in: targetIds }, ...porteeClientsRevendeur(reseller) },
          });
          projected += unit * BigInt(ownedTargets);
        } else if (quotaGB !== undefined) {
          const activeTargets = await (prisma as any).subscription.findMany({
            where: {
              id: { in: targetIds },
              client: porteeClientsRevendeur(reseller),
              status: 'active',
              OR: [{ expireAt: null }, { expireAt: { gt: new Date() } }],
            },
            select: { quotaBytes: true },
          });
          if (action === 'add_data') {
            projected += unit * BigInt(activeTargets.length);
          } else {
            for (const target of activeTargets) {
              projected += unit - BigInt(target.quotaBytes ?? 0);
            }
          }
        }
        if (projected > quotaLimit && projected > alloue) {
          return res.status(409).json({
            ...reponsePlafondDepasse(alloue, quotaLimit),
            message: quotaLimit === BigInt(0)
              ? 'Aucun quota ne vous a encore été attribué par l’administrateur.'
              : `Quota revendeur insuffisant : cette opération porterait le total à ${formatGigabytes(projected)} Go pour une limite de ${formatGigabytes(quotaLimit)} Go.`,
          });
        }
      }
    }

    // ── deploy ──────────────────────────────────────────────────────────────
    if (action === 'deploy') {
      const profile = await (prisma as any).vpnProfile.findUnique({ where: { id: profileId! } });
      if (!profile) return res.status(404).json({ error: 'Profil VPN introuvable' });

      const quotaBytes = gigabytesToBytes(quotaGB!);
      // Le profil doit être attribué au revendeur, exactement comme en création
      // unitaire : sans ce contrôle, l'opération groupée était la porte dérobée
      // permettant de revendre la configuration d'un concurrent.
      const profilRefus = await assertResellerCanUseProfile(req, profileId!);
      if (profilRefus) return res.status(profilRefus.status).json(profilRefus.body);
      const ficheBulk = isReseller
        ? ((req as any).reseller ?? (await chargerFicheRevendeur(prisma, req.user!.userId)))
        : null;
      for (const clientId of targetIds) {
        try {
          const client = await prisma.vpnClient.findUnique({ where: { id: clientId }, select: { id: true, userId: true, resellerId: true } });
          // 404 et non 403 : ne pas confirmer l'existence d'une ressource
          // appartenant à autrui (convention du dépôt).
          if (!client || (isReseller && !possedeClient(client, ficheBulk))) {
            failed++; details.push({ id: clientId, status: 'failed', reason: 'Client introuvable' });
            continue;
          }
          const accessError = await refusAccesProprietaireClient(prisma, client);
          if (accessError) {
            failed++; details.push({ id: clientId, status: 'failed', reason: accessError.body.message });
            continue;
          }
          const startAt  = new Date();
          const expireAt = new Date(startAt.getTime() + durationDays! * 24 * 3600 * 1000);
          await executerMutationQuota(prisma, {
            resellerUserId: client.userId,
            resellerId: client.resellerId ?? null,
            auteur: { userId: req.user?.userId, email: req.user?.email },
            reason: `Deploiement groupe du forfait ${profile.name}`,
            referenceType: 'subscription',
          }, (tx) => (tx as any).subscription.create({
            data: {
              name: `${profile.name} — ${durationDays!}j`,
              clientId, profileId: profileId!,
              dataToken: generateDataToken(),
              quotaBytes, quotaUsed: BigInt(0),
              durationDays: durationDays!,
              deviceLimit: 1,
              startAt, expireAt,
              status: 'active',
              createdBy: req.user!.userId,
            },
          }));
          accessStateHub.invalidate({ clientId });
          succeeded++; details.push({ id: clientId, status: 'ok' });
        } catch (e: any) {
          // Un échec isolé ne doit pas interrompre les autres : sur 150 clients,
          // l'opérateur veut le maximum de réussites et la liste des échecs.
          failed++; details.push({ id: clientId, status: 'failed', reason: e?.message || 'Erreur inconnue' });
        }
      }
    } else {
      // ── set / add_data / extend_duration ──────────────────────────────────
      const ficheBulk = isReseller
        ? ((req as any).reseller ?? (await chargerFicheRevendeur(prisma, req.user!.userId)))
        : null;
      for (const subId of targetIds) {
        try {
          const sub = await (prisma as any).subscription.findUnique({
            where: { id: subId },
            include: { client: { select: { userId: true, resellerId: true } } },
          });
          if (!sub || (isReseller && !possedeClient(sub.client, ficheBulk))) {
            failed++; details.push({ id: subId, status: 'failed', reason: 'Forfait introuvable' });
            continue;
          }

          const data: Record<string, any> = {};
          if (action === 'set') {
            if (quotaGB !== undefined) {
              const nextQuota = gigabytesToBytes(quotaGB);
              if (nextQuota < BigInt(sub.quotaUsed ?? 0)) {
                failed++; details.push({ id: subId, status: 'failed', reason: 'Le quota ne peut pas être inférieur aux données déjà consommées' });
                continue;
              }
              data.quotaBytes = nextQuota;
            }
            if (durationDays !== undefined) {
              data.durationDays = durationDays;
              data.expireAt = new Date(Date.now() + durationDays * 24 * 3600 * 1000);
            }
          } else if (action === 'add_data') {
            data.quotaBytes = BigInt(sub.quotaBytes ?? 0) + gigabytesToBytes(quotaGB!);
          } else {
            // Prolonger un forfait DÉJÀ EXPIRÉ doit le réactiver : repartir de
            // son ancienne échéance laisserait la nouvelle date dans le passé.
            const base = sub.expireAt && new Date(sub.expireAt) > new Date() ? new Date(sub.expireAt) : new Date();
            data.expireAt = new Date(base.getTime() + durationDays! * 24 * 3600 * 1000);
            data.durationDays = Number(sub.durationDays ?? 0) + durationDays!;
            if (sub.status === 'expired') data.status = 'active';
          }

          if (Object.keys(data).length === 0) {
            skipped++; details.push({ id: subId, status: 'skipped', reason: 'Aucune modification demandée' });
            continue;
          }
          await executerMutationQuota(prisma, {
            resellerUserId: sub.client.userId,
            resellerId: sub.client.resellerId ?? null,
            auteur: { userId: req.user?.userId, email: req.user?.email },
            reason: `Operation groupee ${action} sur un forfait`,
            referenceType: 'subscription',
            referenceId: subId,
            autoriserReductionAuDessusDuPlafond: action === 'set',
          }, async (tx) => {
            const current = await tx.subscription.findUnique({ where: { id: subId } });
            if (action === 'add_data') {
              data.quotaBytes = { increment: gigabytesToBytes(quotaGB!) };
              if (current.status === 'exhausted' &&
                  BigInt(current.quotaUsed ?? 0) < BigInt(current.quotaBytes ?? 0) + gigabytesToBytes(quotaGB!) &&
                  (!current.expireAt || new Date(current.expireAt).getTime() > Date.now())) {
                data.status = 'active';
              }
            } else if (action === 'extend_duration') {
              const base = current.expireAt && new Date(current.expireAt) > new Date() ? new Date(current.expireAt) : new Date();
              data.expireAt = new Date(base.getTime() + durationDays! * 86_400_000);
              data.durationDays = Number(current.durationDays ?? 0) + durationDays!;
              data.status = current.status === 'expired' ? 'active' : current.status;
            }
            return tx.subscription.update({ where: { id: subId }, data });
          });
          accessStateHub.invalidate({ clientId: sub.clientId });
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
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'errors.validation', details: err.issues });
    }
    if (err instanceof PlafondQuotaDepasse) {
      return res.status(409).json(reponsePlafondDepasse(err.alloue, err.plafond));
    }
    console.error('subscription bulk error:', err);
    return res.status(500).json({ error: err.message || 'Échec de l’opération groupée' });
  }
});

// ─── PUT /api/subscriptions/:id ──────────────────────────────────────────────
//
// Sémantique conservée : suspendre (`status: 'suspended'`), réactiver
// (`status: 'active'`) et ajuster quota/durée passent tous par ici. Réduire ou
// suspendre reste possible même quand le plafond est atteint ; seule
// l'augmentation est arrêtée, par le contrôle d'allocation ci-dessous.
router.put(
  '/:id',
  requireAuth,
  interdireMutationSupport(),
  requirePermission('subscription.manage'),
  exigerAccesRevendeur(),
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = updateSubscriptionSchema.parse(req.body);
    const existing = await (prisma as any).subscription.findUnique({
      where: { id: req.params.id },
      include: { client: { select: { userId: true, resellerId: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Subscription not found' });
    const { name, quotaGB, durationDays, deviceLimit, status, profileId } = body;
    const quotaBytes = quotaGB !== undefined
      ? gigabytesToBytes(quotaGB)
      : BigInt(existing.quotaBytes ?? 0);
    if (quotaGB !== undefined && quotaBytes < BigInt(existing.quotaUsed ?? 0)) {
      return res.status(409).json({
        error: 'errors.subscriptions.quota_below_usage',
        message: 'Le quota ne peut pas être inférieur aux données déjà consommées.',
      });
    }

    const nextExpireAt = durationDays !== undefined
      ? new Date(new Date(existing.startAt).getTime() + durationDays * 86400000)
      : existing.expireAt;
    const isEngaged = (subscriptionStatus: string, expireAt: Date | string | null) =>
      subscriptionStatus === 'active' && (!expireAt || new Date(expireAt).getTime() > Date.now());
    const allocationAvant = isEngaged(existing.status, existing.expireAt)
      ? BigInt(existing.quotaBytes ?? 0)
      : BigInt(0);
    const allocationApres = isEngaged(status ?? existing.status, nextExpireAt)
      ? quotaBytes
      : BigInt(0);
    const reduitExposition = allocationApres <= allocationAvant;

    if (req.user?.role === 'RESELLER') {
      const fiche = (req as any).reseller ?? (await chargerFicheRevendeur(prisma, req.user.userId));
      if (!possedeClient(existing.client, fiche)) {
        return res.status(404).json({ error: 'Subscription not found' });
      }
      if (!reduitExposition) {
        const accessError = await refusAccesProprietaireClient(prisma, existing.client);
        if (accessError) return res.status(accessError.status).json(accessError.body);
        const quotaError = await assertResellerCanAssignQuota(req, existing.clientId, quotaBytes, existing.quotaBytes, existing.id);
        if (quotaError) return res.status(quotaError.status).json(quotaError.body);
      }
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

    const updated: any = await executerMutationQuota(prisma, {
      resellerUserId: existing.client.userId,
      resellerId: existing.client.resellerId ?? null,
      auteur: { userId: req.user?.userId, email: req.user?.email },
      reason: `Modification du forfait ${existing.name}`,
      referenceType: 'subscription',
      referenceId: req.params.id,
      autoriserReductionAuDessusDuPlafond: reduitExposition,
    }, (tx) => (tx as any).subscription.update({
      where: { id: req.params.id },
      data: {
        ...(name         !== undefined && { name }),
        ...(profileId    !== undefined && { profileId }),
        ...(quotaGB      !== undefined && { quotaBytes }),
        ...(durationDays !== undefined && {
          durationDays,
          expireAt: nextExpireAt,
        }),
        ...(deviceLimit  !== undefined && { deviceLimit }),
        ...(status       !== undefined && { status }),
      },
      include: INCLUDE_FORFAIT,
    }));

    accessStateHub.invalidate({ clientId: existing.clientId });
    await logDbActivity(req.user!.userId, `Forfait mis à jour : ${updated.name}`, 'info', req.ip || '');
    return res.json({ success: true, subscription: serializeSub(updated, canViewTechnicalProfile(req)) });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'errors.validation', details: err.issues });
    }
    if (err instanceof PlafondQuotaDepasse) {
      return res.status(409).json(reponsePlafondDepasse(err.alloue, err.plafond));
    }
    return res.status(500).json({ error: err.message || 'Failed to update subscription' });
  }
});

// ─── DELETE /api/subscriptions/:id ───────────────────────────────────────────
// Action RÉDUCTRICE : elle libère du volume, donc elle reste ouverte quand le
// plafond est atteint.
router.delete(
  '/:id',
  requireAuth,
  interdireMutationSupport(),
  requirePermission('subscription.manage'),
  exigerAccesRevendeur({ autoriserReduction: true }),
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const existing = await (prisma as any).subscription.findUnique({
      where: { id: req.params.id },
      include: { client: true },
    });
    if (!existing) return res.status(404).json({ error: 'Subscription not found' });
    if (req.user?.role === 'RESELLER'
      && !possedeClient(existing.client, (req as any).reseller ?? (await chargerFicheRevendeur(prisma, req.user.userId)))) {
      return res.status(404).json({ error: 'Subscription not found' });
    }
    await executerMutationQuota(prisma, {
      resellerUserId: existing.client.userId,
      resellerId: existing.client.resellerId ?? null,
      auteur: { userId: req.user?.userId, email: req.user?.email },
      reason: `Suppression du forfait ${existing.name}`,
      referenceType: 'subscription',
      referenceId: req.params.id,
      autoriserReductionAuDessusDuPlafond: true,
    }, (tx) => (tx as any).subscription.delete({ where: { id: req.params.id } }));
    accessStateHub.invalidate({ clientId: existing.clientId });
    await logDbActivity(req.user!.userId, `Forfait supprimé : ${existing.name}`, 'warning', req.ip || '');
    return res.json({ success: true, message: 'Forfait supprimé' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to delete subscription' });
  }
});

// ─── POST /api/subscriptions/:id/revoke ──────────────────────────────────────
// Action RÉDUCTRICE : même règle que la suppression.
router.post(
  '/:id/revoke',
  requireAuth,
  interdireMutationSupport(),
  requirePermission('subscription.manage'),
  exigerAccesRevendeur({ autoriserReduction: true }),
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { reason } = revokeSubscriptionSchema.parse(req.body ?? {});
    const existing = await (prisma as any).subscription.findUnique({
      where: { id: req.params.id },
      include: { client: true },
    });
    if (!existing) return res.status(404).json({ error: 'Subscription not found' });
    if (req.user?.role === 'RESELLER'
      && !possedeClient(existing.client, (req as any).reseller ?? (await chargerFicheRevendeur(prisma, req.user.userId)))) {
      return res.status(404).json({ error: 'Subscription not found' });
    }
    const sub: any = await executerMutationQuota(prisma, {
      resellerUserId: existing.client.userId,
      resellerId: existing.client.resellerId ?? null,
      auteur: { userId: req.user?.userId, email: req.user?.email },
      reason: reason || 'Revocation du forfait',
      referenceType: 'subscription',
      referenceId: req.params.id,
      autoriserReductionAuDessusDuPlafond: true,
    }, (tx) => (tx as any).subscription.update({
      where: { id: req.params.id },
      data: { status: 'revoked', revokedAt: new Date(), revokeReason: reason || 'Révoqué par admin' },
    }));
    accessStateHub.invalidate({ clientId: existing.clientId });
    await logDbActivity(req.user!.userId, `Forfait révoqué : ${sub.name}`, 'danger', req.ip || '');
    return res.json({ success: true, message: 'Forfait révoqué' });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'errors.validation', details: err.issues });
    }
    return res.status(500).json({ error: 'Failed to revoke subscription' });
  }
});

export default router;

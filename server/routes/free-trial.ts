/**
 * free-trial.ts — Essai gratuit SXB : jeton d'invitation, demandes, déploiement.
 *
 * SÉPARATION STRICTE EN DEUX TEMPS, imposée par le propriétaire :
 *
 *   Étape 1-2  Jeton → Nom + Identifiant d'appareil → EN ATTENTE
 *              Le jeton est un CODE D'INVITATION. Il ne contient et ne permet
 *              d'obtenir AUCUNE configuration VPN, aucun serveur, aucun quota,
 *              aucune date. Aucune route de ce fichier ne lit une configuration
 *              à partir d'un jeton d'essai — la seule route qui accepte un
 *              jeton est `POST /enroll`, et elle n'écrit qu'une demande.
 *
 *   Étape 3-5  Approbation admin → Go + Serveur + Dates → déploiement interne
 *              → l'accès apparaît dans l'application de l'utilisateur.
 *
 * RÈGLE DE SÉCURITÉ CAPITALE : personne ne doit pouvoir se servir du même
 * jeton pour voir la configuration d'un autre. Le jeton crée une demande, rien
 * de plus. Chaque inscription est une demande SÉPARÉE, identifiée par son
 * propre appareil et protégée par un secret de réclamation propre. La lecture
 * du statut n'est donc jamais indexée par le jeton : elle exige l'identifiant
 * de demande ET l'appareil ET le secret.
 *
 * Le déploiement réel ne réinvente rien : il réutilise le mécanisme de compte
 * appareil (`makeUserToken`, comme /api/devices/generate-token) et le modèle
 * `Subscription` (comme /api/subscriptions), puis laisse l'application suivre
 * le chemin d'activation mobile déjà éprouvé.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { config } from '../config';
import { prisma, logDbActivity } from '../database';
import { accessStateHub } from '../services/access-state-events';
import { requireAuth, requirePermission, AuthenticatedRequest } from '../middleware/auth';
import { isOwnerRequest } from '../middleware/rbac/owner';
import {
  interdireAccesRevendeur,
  interdireMutationSupport,
  reponsePlafondDepasse,
} from '../services/reseller-access';
import { executerMutationQuota, PlafondQuotaDepasse } from '../services/reseller-quota';
import { makeUserToken } from '../services/device-token';
import { CODES_PAYS, normaliserCodePays } from '../services/countries';
import {
  listerConnectes,
  PRESENCE_HEARTBEAT_MINUTES,
  PRESENCE_WINDOW_MINUTES,
} from '../services/vpn-presence';
import {
  CODES_ESSAI,
  MAX_LOT_ESSAI,
  MOTIF_JETON_ESSAI,
  RAISONS_LOT_ESSAI,
  STATUT_DEMANDE,
  STATUT_JETON,
  calculerFenetreEssai,
  deciderInscriptionParEmpreinte,
  demandeAppartientAuJeton,
  etatJetonEssai,
  genererJetonEssai,
  genererSecretReclamation,
  hacherEmpreinteAppareil,
  hacherSecretReclamation,
  intervalleVerificationEssai,
  normaliserConfigsEssai,
  normaliserJetonEssai,
  normaliserLotEssai,
  refusConfigsEssai,
  refusDeploiement,
  refusEmpreinteManquante,
  refusEssaiDejaConsomme,
  refusJetonEssai,
  refusLotEssai,
  refusPaysInvalide,
  refusReclamationEssai,
  resumerEssais,
  statistiquesParPays,
  totauxParPays,
  verifierProduitEssai,
  vueAccesEssai,
  vueDemandePourAdmin,
  vueInscriptionEssai,
  vueJetonPourAdmin,
  vueStatutEssaiPourAppareil,
  type AccesEssaiVue,
  type MesurePresenceEssai,
} from '../services/free-trial';
import {
  ETATS_GROUPES,
  RAISONS_GROUPEES,
  aucunChampRenseigne,
  planifierApplication,
  planifierEtat,
  type ChangementsGroupes,
  type EtatGroupe,
} from '../services/subscription-bulk';

const router = Router();
const GIB = 1024 ** 3;

/**
 * Secret de pseudonymisation de la présence — strictement celui de
 * `/api/presence`, sinon aucun rapprochement ne pourrait aboutir. Sa lecture
 * est volontairement recopiée telle quelle : un second secret, ou un repli
 * différent, produirait un compteur « connectés » divergent de la vue de suivi.
 */
function secretPresence(): string | null {
  return config.MOBILE_HEALTH_PSEUDONYM_SECRET
    || (config.NODE_ENV !== 'production' ? config.JWT_SECRET : null);
}

/**
 * Intervalle de vérification automatique renvoyé à l'application.
 * Réglable par l'exploitant sans reconstruire l'APK, mais toujours ramené dans
 * la fenêtre 2–10 minutes demandée par le propriétaire.
 */
const INTERVALLE_VERIFICATION_S = intervalleVerificationEssai(process.env.FREE_TRIAL_POLL_SECONDS);

// ─────────────────────────────────────────────────────────────────────────────
// Schémas zod
// ─────────────────────────────────────────────────────────────────────────────

const identifiantSchema = z.string().trim().min(1).max(100);
const deviceIdSchema = z.string().trim().min(1).max(255);

const creerJetonSchema = z.object({
  label: z.string().trim().max(160).optional(),
  // `null` = illimité, et le dit explicitement plutôt que par omission.
  maxUses: z.coerce.number().int().min(1).max(10_000).nullable().optional(),
  expiresAt: z.coerce.date().optional(),
}).strict();

/**
 * Pays DÉCLARÉ, validé contre une liste FERMÉE de codes ISO 3166-1 alpha-2.
 *
 * Liste fermée et non `z.string().length(2)` : sans elle, « XX », « ZZ » ou
 * « AA » entreraient en base et le récapitulatif « d'où viennent nos clients »
 * mélangerait des pays réels et du bruit.
 *
 * C'est une SAISIE, jamais une mesure : aucune route de ce fichier ne lit
 * l'adresse IP de l'appelant ni n'interroge un service de géolocalisation.
 */
const paysSchema = z.string()
  .trim()
  .transform((valeur) => normaliserCodePays(valeur))
  .refine((code) => (CODES_PAYS as readonly string[]).includes(code), {
    message: 'Pays invalide : choisissez un pays dans la liste.',
  });

const inscriptionSchema = z.object({
  token: z.string().trim().min(1).max(64),
  // Le nom est OBLIGATOIRE : c'est la seule information d'identification que
  // l'admin aura pour instruire la demande.
  name: z.string().trim().min(2, 'Le nom est obligatoire.').max(120),
  // Le pays est OBLIGATOIRE au même titre que le nom, à la demande du
  // propriétaire : c'est ce qui permet de savoir d'où viennent les clients.
  country: paysSchema,
  // Empreinte d'appareil STABLE À TRAVERS UNE RÉINSTALLATION, distincte de
  // `deviceId`. Elle est OBLIGATOIRE : sans elle, un essai serait accordé sans
  // qu'aucun mécanisme n'empêche le suivant après désinstallation. La valeur
  // brute ne quitte jamais cette fonction : elle est immédiatement hachée.
  deviceFingerprint: z.string().trim().min(1).max(255),
  deviceId: deviceIdSchema.optional(),
  platform: z.string().trim().max(40).optional(),
  appVersion: z.string().trim().max(40).optional(),
}).strict();

const statutSchema = z.object({
  requestId: identifiantSchema,
  claimSecret: z.string().trim().min(1).max(200),
  deviceId: deviceIdSchema.optional(),
}).strict();

const deployerSchema = z.object({
  // Sélection MULTIPLE : l'admin choisit un ou plusieurs inscrits, puis
  // seulement ensuite ce qu'ils reçoivent.
  requestIds: z.array(identifiantSchema).min(1).max(MAX_LOT_ESSAI),
  // Jeton SOUS LEQUEL l'action est lancée. Le tableau de bord agit toujours
  // dans le contexte d'un jeton ; le serveur revérifie chaque demande plutôt
  // que de faire confiance à la liste reçue.
  tokenId: identifiantSchema.optional(),
  // Une SEULE configuration (contrat historique, toujours accepté)…
  profileId: identifiantSchema.optional(),
  // …ou PLUSIEURS : chaque inscrit retenu reçoit alors un forfait par
  // configuration choisie, comme un client principal peut détenir plusieurs
  // forfaits. Les deux champs coexistent pour ne casser aucun appelant ; les
  // valeurs sont fusionnées puis dédoublonnées.
  //
  // La borne métier (`MAX_CONFIGS_ESSAI`) n'est volontairement PAS posée ici :
  // un `.max()` de schéma rendrait un « errors.validation » muet, alors que
  // `normaliserConfigsEssai` rend un refus MOTIVÉ qui annonce la limite. Le
  // plafond de schéma ne sert qu'à borner la taille du corps reçu.
  profileIds: z.array(identifiantSchema).max(100).optional(),
  quotaGB: z.coerce.number().finite().positive('Le quota doit être supérieur à 0 Go.').max(100_000),
  // Dates ET heures : `z.coerce.date()` accepte l'ISO complet envoyé par le
  // tableau de bord, donc « 2026-09-12T18:30:00Z » aussi bien qu'une date nue.
  startAt: z.coerce.date().optional(),
  expireAt: z.coerce.date(),
  deviceLimit: z.coerce.number().int().min(1).max(100).optional(),
  note: z.string().trim().max(500).optional(),
}).strict().superRefine((corps, ctx) => {
  if (!corps.profileId && !(corps.profileIds?.length)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'profileId ou profileIds est requis' });
  }
});

/**
 * Gestion groupée des essais DÉJÀ DÉPLOYÉS.
 *
 * Tous les champs d'accès sont indépendamment facultatifs — ce qui n'est pas
 * renseigné n'est pas réécrit —, exactement comme l'action « apply » des
 * forfaits, dont la mécanique est RÉUTILISÉE et non recopiée. `state` s'y
 * ajoute parce que suspendre, réactiver ou révoquer n'est pas un champ mais un
 * geste, et que le mélanger aux valeurs rendrait le récapitulatif illisible.
 */
const gererSchema = z.object({
  requestIds: z.array(identifiantSchema).min(1).max(MAX_LOT_ESSAI),
  tokenId: identifiantSchema.optional(),
  profileId: identifiantSchema.optional(),
  // Même raison qu'au déploiement : la borne métier est appliquée par
  // `normaliserConfigsEssai`, qui annonce la limite dans son refus.
  profileIds: z.array(identifiantSchema).max(100).optional(),
  quotaGB: z.coerce.number().finite().positive().max(100_000).optional(),
  quotaMode: z.enum(['set', 'add']).optional(),
  startAt: z.coerce.date().optional(),
  expireAt: z.coerce.date().optional(),
  durationDays: z.coerce.number().int().min(1).max(3650).optional(),
  durationMode: z.enum(['set', 'add']).optional(),
  state: z.enum([ETATS_GROUPES.SUSPENDRE, ETATS_GROUPES.REACTIVER, ETATS_GROUPES.REVOQUER]).optional(),
  note: z.string().trim().max(500).optional(),
}).strict().superRefine((corps, ctx) => {
  const changements = {
    ...(corps.profileId !== undefined ? { profileId: corps.profileId } : {}),
    ...(corps.quotaGB !== undefined ? { quotaGB: corps.quotaGB } : {}),
    ...(corps.startAt !== undefined ? { startAt: corps.startAt } : {}),
    ...(corps.expireAt !== undefined ? { expireAt: corps.expireAt } : {}),
    ...(corps.durationDays !== undefined ? { durationDays: corps.durationDays } : {}),
  } as ChangementsGroupes;
  const attribue = Boolean(corps.profileIds?.length);
  if (aucunChampRenseigne(changements) && !attribue && corps.state === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Au moins un champ ou un geste est requis' });
  }
  // Échéance explicite et durée sont deux façons contradictoires de fixer la
  // même borne : accepter les deux reviendrait à en ignorer une en silence.
  if (corps.expireAt !== undefined && corps.durationDays !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'expireAt et durationDays s’excluent' });
  }
  // Attribuer de NOUVELLES configurations et remplacer celle des forfaits
  // existants sont deux gestes distincts : les confondre dans une même requête
  // rendrait l'aperçu avant confirmation faux.
  if (attribue && corps.profileId !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'profileId et profileIds s’excluent' });
  }
});

const refuserSchema = z.object({
  requestIds: z.array(identifiantSchema).min(1).max(MAX_LOT_ESSAI),
  tokenId: identifiantSchema.optional(),
  note: z.string().trim().max(500).optional(),
}).strict();

/** Filtres de lecture des demandes : par statut, par jeton, page par page. */
const listeDemandesSchema = z.object({
  status: z.enum([STATUT_DEMANDE.PENDING, STATUT_DEMANDE.DEPLOYED, STATUT_DEMANDE.REJECTED]).optional(),
  tokenId: identifiantSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
}).strip();

// ─────────────────────────────────────────────────────────────────────────────
// Utilitaires
// ─────────────────────────────────────────────────────────────────────────────

function baseIndisponible(res: Response) {
  return res.status(503).json({
    error: 'errors.db.unavailable',
    message: 'Base de données indisponible',
  });
}

/**
 * L'identifiant d'appareil est enregistré AUTOMATIQUEMENT : il vient de
 * l'en-tête que l'application pose déjà sur toutes ses requêtes, avec repli
 * sur le corps pour les clients qui ne la posent pas encore. L'utilisateur ne
 * le saisit jamais, conformément à l'étape 2.
 */
function appareilDeLaRequete(req: Request, corps?: { deviceId?: string }): string | null {
  const entete = req.headers['x-sxb-device-id'];
  if (typeof entete === 'string' && entete.trim() && entete.trim().length <= 255) return entete.trim();
  return corps?.deviceId?.trim() || null;
}

function erreurValidation(res: Response, err: z.ZodError) {
  return res.status(400).json({
    error: 'errors.validation',
    message: 'Requête invalide',
    details: err.issues,
  });
}

/**
 * Forfaits d'UNE demande d'essai, quel qu'en soit le nombre.
 *
 * Deux rattachements coexistent, et c'est volontaire :
 *   • `subscription.freeTrialRequestId` — posé à chaque forfait créé par un
 *     déploiement d'essai, y compris quand plusieurs configurations sont
 *     attribuées d'un coup ;
 *   • `freeTrialRequest.subscriptionId` — le forfait PRINCIPAL, qui existait
 *     avant le multi-configurations. Les essais déployés auparavant n'ont que
 *     celui-là : les lire par les deux chemins évite toute reprise de données.
 */
function conditionForfaitsEssai(demandes: ReadonlyArray<{ id?: unknown; subscriptionId?: unknown }>) {
  const demandeIds = [...new Set(demandes.map((d) => String(d.id ?? '')).filter(Boolean))];
  const forfaitIds = [...new Set(demandes.map((d) => String(d.subscriptionId ?? '')).filter(Boolean))];
  const clauses: Record<string, unknown>[] = [];
  if (demandeIds.length) clauses.push({ freeTrialRequestId: { in: demandeIds } });
  if (forfaitIds.length) clauses.push({ id: { in: forfaitIds } });
  return clauses.length ? { OR: clauses } : null;
}

/** Rattache chaque forfait lu à la demande dont il provient. */
function demandeDuForfait(
  forfait: { id?: unknown; freeTrialRequestId?: unknown },
  parForfaitPrincipal: Map<string, string>,
): string | null {
  if (forfait.freeTrialRequestId) return String(forfait.freeTrialRequestId);
  return parForfaitPrincipal.get(String(forfait.id)) ?? null;
}

/** Accès courant de chaque demande déployée, en UNE lecture pour toute la page. */
async function accesParDemande(
  demandes: ReadonlyArray<{ id?: unknown; status?: unknown; subscriptionId?: unknown }>,
): Promise<Map<string, AccesEssaiVue>> {
  const acces = new Map<string, AccesEssaiVue>();
  const deployees = demandes.filter((d) => d.status === STATUT_DEMANDE.DEPLOYED);
  const condition = conditionForfaitsEssai(deployees);
  if (!prisma || !condition) return acces;

  const parForfaitPrincipal = new Map<string, string>();
  for (const demande of deployees) {
    if (demande.subscriptionId) parForfaitPrincipal.set(String(demande.subscriptionId), String(demande.id));
  }
  try {
    const forfaits = await (prisma as any).subscription.findMany({
      where: condition,
      include: { profile: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const groupes = new Map<string, any[]>();
    for (const forfait of forfaits as any[]) {
      const demandeId = demandeDuForfait(forfait, parForfaitPrincipal);
      if (!demandeId) continue;
      const liste = groupes.get(demandeId) ?? [];
      liste.push(forfait);
      groupes.set(demandeId, liste);
    }
    for (const [demandeId, liste] of groupes) acces.set(demandeId, vueAccesEssai(liste));
  } catch (erreur) {
    // L'accès est une LECTURE d'appoint : son échec ne doit pas priver
    // l'exploitant de la liste des demandes elle-même.
    console.error('free-trial access read error:', erreur);
  }
  return acces;
}

// ═════════════════════════════════════════════════════════════════════════════
// ÉTAPE 1 — Création du jeton d'essai par l'admin
// ═════════════════════════════════════════════════════════════════════════════

// ─── POST /api/free-trial/tokens ─────────────────────────────────────────────
// Génère « STUFF-X8K4-P92M ». Le corps n'accepte AUCUN champ de quota, de
// serveur ni de date d'accès : ces choix n'existent qu'à l'étape 3, une fois
// l'inscrit connu. Le schéma `.strict()` rejette donc toute tentative d'en
// glisser un dans le jeton.
router.post(
  '/tokens',
  requireAuth,
  interdireAccesRevendeur(),
  interdireMutationSupport(),
  requirePermission('tokens.create'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!prisma) return baseIndisponible(res);
      const body = creerJetonSchema.parse(req.body);

      let token = genererJetonEssai();
      for (let essai = 0; essai < 10; essai += 1) {
        const pris = await (prisma as any).freeTrialToken.findUnique({ where: { token } });
        if (!pris) break;
        token = genererJetonEssai();
        if (essai === 9) {
          return res.status(503).json({
            error: 'errors.free_trial.token_generation',
            message: 'Impossible de générer un jeton unique pour le moment.',
          });
        }
      }

      const cree = await (prisma as any).freeTrialToken.create({
        data: {
          token,
          label: body.label || null,
          maxUses: body.maxUses ?? null,
          expiresAt: body.expiresAt ?? null,
          createdBy: req.user?.userId ?? null,
        },
      });

      await logDbActivity(
        req.user?.userId || null,
        `Jeton d'essai gratuit créé : ${token}`,
        'success',
        req.ip || '',
      );
      return res.status(201).json({ success: true, token: vueJetonPourAdmin(cree) });
    } catch (err: any) {
      if (err instanceof z.ZodError) return erreurValidation(res, err);
      console.error('free-trial token create error:', err);
      return res.status(500).json({ error: 'errors.server', message: 'Création du jeton impossible' });
    }
  },
);

// ─── GET /api/free-trial/tokens ──────────────────────────────────────────────
router.get(
  '/tokens',
  requireAuth,
  interdireAccesRevendeur(),
  requirePermission('tokens.view'),
  async (_req: AuthenticatedRequest, res: Response) => {
    try {
      if (!prisma) return baseIndisponible(res);
      const jetons = await (prisma as any).freeTrialToken.findMany({
        orderBy: { createdAt: 'desc' },
        take: 500,
        include: { _count: { select: { requests: true } } },
      });
      // Compteurs par statut : deux colonnes seulement, jamais les demandes
      // elles-mêmes. C'est ce qui permet d'annoncer « 12 en attente ·
      // 3 déployées » sur chaque ligne sans charger 200 inscriptions par jeton.
      const repartition = new Map<string, { pending: number; deployed: number; rejected: number }>();
      const projections = await (prisma as any).freeTrialRequest.findMany({
        select: { tokenId: true, status: true },
        take: 20_000,
      });
      for (const ligne of projections as any[]) {
        const compteurs = repartition.get(ligne.tokenId)
          ?? { pending: 0, deployed: 0, rejected: 0 };
        if (ligne.status === STATUT_DEMANDE.PENDING) compteurs.pending += 1;
        else if (ligne.status === STATUT_DEMANDE.DEPLOYED) compteurs.deployed += 1;
        else if (ligne.status === STATUT_DEMANDE.REJECTED) compteurs.rejected += 1;
        repartition.set(ligne.tokenId, compteurs);
      }
      return res.json({
        tokens: jetons.map((jeton: any) => {
          const compteurs = repartition.get(jeton.id) ?? { pending: 0, deployed: 0, rejected: 0 };
          return vueJetonPourAdmin({
            ...jeton,
            requestCount: jeton._count?.requests ?? 0,
            pendingCount: compteurs.pending,
            deployedCount: compteurs.deployed,
            rejectedCount: compteurs.rejected,
          });
        }),
      });
    } catch (err: any) {
      console.error('free-trial token list error:', err);
      return res.status(500).json({ error: 'errors.server', message: 'Lecture des jetons impossible' });
    }
  },
);

// ─── POST /api/free-trial/tokens/:id/revoke ──────────────────────────────────
// Révoquer coupe les inscriptions FUTURES. Les demandes déjà déposées et les
// accès déjà déployés ne sont pas touchés : on ne retire pas un essai en cours
// à quelqu'un parce que la campagne est close.
router.post(
  '/tokens/:id/revoke',
  requireAuth,
  interdireAccesRevendeur(),
  interdireMutationSupport(),
  requirePermission('tokens.revoke'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!prisma) return baseIndisponible(res);
      const jeton = await (prisma as any).freeTrialToken.findUnique({ where: { id: req.params.id } });
      if (!jeton) {
        return res.status(404).json({
          error: 'errors.free_trial.token_invalid',
          code: CODES_ESSAI.TOKEN_NOT_FOUND,
          message: 'Jeton d’essai introuvable.',
        });
      }
      const misAJour = await (prisma as any).freeTrialToken.update({
        where: { id: jeton.id },
        data: { status: STATUT_JETON.REVOKED },
      });
      await logDbActivity(
        req.user?.userId || null,
        `Jeton d'essai gratuit révoqué : ${jeton.token}`,
        'warning',
        req.ip || '',
      );
      return res.json({ success: true, token: vueJetonPourAdmin(misAJour) });
    } catch (err: any) {
      console.error('free-trial token revoke error:', err);
      return res.status(500).json({ error: 'errors.server', message: 'Révocation impossible' });
    }
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ÉTAPE 2 — Inscription depuis l'application mobile
// ═════════════════════════════════════════════════════════════════════════════

// ─── POST /api/free-trial/enroll ─────────────────────────────────────────────
//
// Route ouverte : l'appareil n'a pas encore de compte, c'est justement l'objet
// de la demande. Elle est donc délibérément AVARE — elle n'écrit qu'une ligne
// « en attente » et ne lit jamais la moindre donnée d'accès.
//
// RIEN n'est déployé ici. La réponse ne contient ni serveur, ni quota, ni
// date, ni configuration, ni identifiants : `vueInscriptionEssai` passe par le
// garde-fou anti-fuite qui rejetterait un tel champ.
router.post('/enroll', async (req: Request, res: Response) => {
  try {
    if (!prisma) return baseIndisponible(res);
    const body = inscriptionSchema.parse(req.body);

    const deviceId = appareilDeLaRequete(req, body);
    if (!deviceId) {
      return res.status(400).json({
        error: 'errors.free_trial.device_required',
        message: 'Identifiant d’appareil manquant.',
      });
    }

    // ── UN SEUL ESSAI PAR APPAREIL, RÉINSTALLATION COMPRISE ─────────────────
    //
    // L'empreinte est hachée AVANT toute écriture et la valeur brute n'est
    // reprise nulle part ensuite : ni dans une variable persistée, ni dans un
    // journal, ni dans une réponse. Une inscription sans empreinte exploitable
    // est refusée plutôt qu'accordée « en confiance » — un essai que rien ne
    // rattache à un appareil est exactement ce que le propriétaire refuse.
    const empreinte = hacherEmpreinteAppareil(body.deviceFingerprint);
    if (!empreinte) {
      const refusEmpreinte = refusEmpreinteManquante();
      return res.status(refusEmpreinte.status).json(refusEmpreinte.body);
    }

    // Lecture INDEXÉE sur `(deviceFingerprint, status)`. Volontairement placée
    // AVANT la lecture du jeton : la règle du propriétaire est absolue, elle ne
    // dépend « ni du jeton présenté, ni du deviceId ». Présenter un second
    // jeton depuis un appareil déjà servi ne doit donc même pas révéler si ce
    // jeton existe.
    const memeAppareil = await (prisma as any).freeTrialRequest.findMany({
      where: { deviceFingerprint: empreinte },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const decision = deciderInscriptionParEmpreinte(memeAppareil);
    if (decision.type === 'refuse') {
      // Le corps du refus ne contient ni nom, ni pays, ni date, ni demande :
      // le porteur actuel de l'appareil n'apprend rien du précédent.
      return res.status(decision.refus.status).json(decision.refus.body);
    }

    /**
     * Reprise d'une demande EXISTANTE — jamais un doublon.
     *
     * Un secret de réclamation NEUF est émis et son condensat écrit dans la
     * même opération : la valeur remise à l'appareil correspond donc toujours
     * à ce qui est stocké. C'est aussi ce qui permet à quelqu'un qui a
     * réinstallé l'application de reprendre la main sur sa demande — et qui
     * invalide l'ancien secret du même coup.
     *
     * L'identifiant d'appareil est réaligné sur celui qui parle maintenant :
     * après une réinstallation il a changé, et la lecture de statut exige
     * qu'il corresponde.
     */
    const reprendre = async (existante: any) => {
      const secret = genererSecretReclamation();
      const rafraichie = await (prisma as any).freeTrialRequest.update({
        where: { id: existante.id },
        data: {
          name: body.name,
          country: body.country,
          deviceId,
          deviceFingerprint: empreinte,
          claimSecretHash: hacherSecretReclamation(secret),
          platform: body.platform ?? existante.platform ?? null,
          appVersion: body.appVersion ?? existante.appVersion ?? null,
        },
      });
      return res.status(200).json(vueInscriptionEssai({
        demande: rafraichie,
        claimSecret: secret,
        pollIntervalSeconds: INTERVALLE_VERIFICATION_S,
      }));
    };

    // Demande encore EN ATTENTE sur cet appareil : on la retrouve au lieu d'en
    // créer une deuxième, y compris si l'application a été réinstallée entre
    // temps (l'identifiant d'appareil a changé, l'empreinte non).
    if (decision.type === 'reprise') return reprendre(decision.demande);

    const token = normaliserJetonEssai(body.token);
    if (!MOTIF_JETON_ESSAI.test(token)) {
      // Format invalide : même refus qu'un jeton inconnu, pour ne pas confirmer
      // qu'un format donné correspond à une campagne existante.
      const refus = refusJetonEssai('not_found')!;
      return res.status(refus.status).json(refus.body);
    }

    const jeton = await (prisma as any).freeTrialToken.findUnique({ where: { token } });
    const refus = refusJetonEssai(etatJetonEssai(jeton));
    if (refus) return res.status(refus.status).json(refus.body);

    // Réinscription du MÊME appareil sous le MÊME jeton : on ne crée pas de
    // doublon et on ne consomme pas une seconde place.
    //
    // Ce chemin reste nécessaire pour les demandes HISTORIQUES, déposées avant
    // l'ajout de l'empreinte : elles n'ont pas d'empreinte, donc la lecture
    // ci-dessus ne les voit pas. Les retrouver ici évite de casser une demande
    // en cours et en profite pour renseigner l'empreinte manquante.
    const existante = await (prisma as any).freeTrialRequest.findUnique({
      where: { tokenId_deviceId: { tokenId: jeton.id, deviceId } },
    });
    if (existante) return reprendre(existante);

    const claimSecret = genererSecretReclamation();
    const claimSecretHash = hacherSecretReclamation(claimSecret);

    // Création + incrément du compteur dans la MÊME transaction : sans cela,
    // deux inscriptions simultanées passeraient toutes les deux le contrôle de
    // `maxUses`.
    const demande = await prisma.$transaction(async (tx: any) => {
      const frais = await tx.freeTrialToken.findUnique({ where: { id: jeton.id } });
      const etat = etatJetonEssai(frais);
      if (etat !== 'active') return { conflit: etat } as const;
      // Dernier contrôle d'empreinte, DANS la transaction : deux inscriptions
      // simultanées depuis le même appareil ne doivent pas produire deux
      // demandes, ce que la lecture initiale seule n'empêche pas.
      const concurrentes = await tx.freeTrialRequest.findMany({
        where: { deviceFingerprint: empreinte },
        take: 50,
      });
      const verdict = deciderInscriptionParEmpreinte(concurrentes);
      if (verdict.type !== 'autorise') return { empreinteConflit: true } as const;
      const creee = await tx.freeTrialRequest.create({
        data: {
          tokenId: jeton.id,
          name: body.name,
          country: body.country,
          deviceId,
          deviceFingerprint: empreinte,
          platform: body.platform ?? null,
          appVersion: body.appVersion ?? null,
          claimSecretHash,
          status: STATUT_DEMANDE.PENDING,
        },
      });
      await tx.freeTrialToken.update({
        where: { id: jeton.id },
        data: { usedCount: { increment: 1 } },
      });
      return creee;
    });

    if ((demande as any).conflit) {
      const tardif = refusJetonEssai((demande as any).conflit)!;
      return res.status(tardif.status).json(tardif.body);
    }
    // Course perdue contre une inscription simultanée du même appareil : on
    // rejoue la décision sur l'état réel, puis on refuse ou on reprend la
    // demande gagnante — jamais on n'en crée une seconde.
    if ((demande as any).empreinteConflit) {
      const tardif = deciderInscriptionParEmpreinte(
        await (prisma as any).freeTrialRequest.findMany({ where: { deviceFingerprint: empreinte }, take: 50 }),
      );
      if (tardif.type === 'refuse') return res.status(tardif.refus.status).json(tardif.refus.body);
      if (tardif.type === 'reprise') return reprendre(tardif.demande);
      const refusCourse = refusEssaiDejaConsomme();
      return res.status(refusCourse.status).json(refusCourse.body);
    }

    // Journal d'exploitation : identifiant d'appareil TRONQUÉ, jamais
    // l'empreinte — même hachée — et jamais le pays associé à un appareil.
    await logDbActivity(
      null,
      `Demande d'essai gratuit déposée pour l'appareil ${deviceId.slice(0, 12)}…`,
      'info',
      req.ip || '',
    );

    return res.status(201).json(vueInscriptionEssai({
      demande: demande as any,
      claimSecret,
      pollIntervalSeconds: INTERVALLE_VERIFICATION_S,
    }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      // Deux refus méritent un message précis plutôt qu'une erreur de
      // validation générique : ils correspondent à une action concrète de
      // l'utilisateur (choisir un pays) ou à un appareil non identifiable.
      if (err.issues.some((probleme) => probleme.path[0] === 'country')) {
        const refusPays = refusPaysInvalide();
        return res.status(refusPays.status).json(refusPays.body);
      }
      if (err.issues.some((probleme) => probleme.path[0] === 'deviceFingerprint')) {
        const refusEmpreinte = refusEmpreinteManquante();
        return res.status(refusEmpreinte.status).json(refusEmpreinte.body);
      }
      return erreurValidation(res, err);
    }
    console.error('free-trial enroll error:', err);
    return res.status(500).json({ error: 'errors.server', message: 'Inscription impossible' });
  }
});

// ─── POST /api/free-trial/status ─────────────────────────────────────────────
//
// « ↻ Vérifier le statut ». C'est la route la plus sensible du fichier, et
// c'est pourquoi elle délègue toute la décision à `vueStatutEssaiPourAppareil`,
// testée séparément.
//
// Trois verrous cumulatifs : l'identifiant de demande, l'identifiant
// d'appareil, et le secret de réclamation remis à l'inscription. Le jeton
// d'essai n'intervient PAS — le connaître ne donne donc aucun accès ici.
//
// Tant que l'admin n'a pas déployé, la réponse est « en attente » et rien
// d'autre. Aucune information de serveur, de quota, de date ou de
// configuration n'est chargée : la requête ne lit même pas le forfait.
router.post('/status', async (req: Request, res: Response) => {
  try {
    if (!prisma) return baseIndisponible(res);
    const body = statutSchema.parse(req.body);

    const deviceId = appareilDeLaRequete(req, body);
    if (!deviceId) {
      const refus = refusReclamationEssai();
      return res.status(refus.status).json(refus.body);
    }

    const demande = await (prisma as any).freeTrialRequest.findUnique({
      where: { id: body.requestId },
    });

    // Le jeton de compte n'est chargé QUE pour une demande effectivement
    // déployée dont l'appareil correspond. Un dossier en attente ne déclenche
    // aucune lecture de compte.
    let accountToken: string | null = null;
    if (demande?.status === STATUT_DEMANDE.DEPLOYED && demande.deviceId === deviceId && demande.clientId) {
      const compte = await (prisma as any).vpnClient.findUnique({
        where: { id: demande.clientId },
        select: { token: true, deviceId: true, status: true },
      });
      // Dernier contrôle : le compte doit être celui de CET appareil. Une
      // demande mal déployée ne remet jamais le jeton d'un autre compte.
      if (compte && compte.status === 'active' && compte.deviceId === deviceId) {
        accountToken = compte.token;
      }
    }

    const reponse = vueStatutEssaiPourAppareil({
      demande,
      deviceId,
      claimSecret: body.claimSecret,
      accountToken,
      pollIntervalSeconds: INTERVALLE_VERIFICATION_S,
    });

    // Horodatage de courtoisie pour le tableau de bord (« vu pour la dernière
    // fois »). Écrit seulement quand l'appelant est légitime.
    if (reponse.ok && demande) {
      await (prisma as any).freeTrialRequest
        .update({ where: { id: demande.id }, data: { lastCheckedAt: new Date() } })
        .catch(() => undefined);
    }

    return res.status(reponse.status).json(reponse.body);
  } catch (err: any) {
    if (err instanceof z.ZodError) return erreurValidation(res, err);
    console.error('free-trial status error:', err);
    return res.status(500).json({ error: 'errors.server', message: 'Vérification impossible' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ÉTAPE 3-4 — Instruction et déploiement par l'admin
// ═════════════════════════════════════════════════════════════════════════════

// ─── GET /api/free-trial/requests ────────────────────────────────────────────
// « Nom | Identifiant d'appareil | Jeton | Statut | Action ».
router.get(
  '/requests',
  requireAuth,
  // Le vivier des inscriptions est GLOBAL : un revendeur n'a rien à y voir,
  // même avec `clients.view`. Ses propres clients issus d'un essai lui
  // parviennent par /api/clients et /api/devices, avec la mention « période
  // d'essai » et le pays.
  interdireAccesRevendeur(),
  requirePermission('clients.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!prisma) return baseIndisponible(res);
      const query = listeDemandesSchema.parse(req.query);
      // Le regroupement par jeton est la lecture NORMALE : le tableau de bord
      // n'ouvre qu'un volet à la fois, donc ne demande que les demandes de ce
      // jeton, page par page. La liste globale reste possible pour la
      // recherche transversale.
      const filtre: Record<string, unknown> = {};
      if (query.status) filtre.status = query.status;
      if (query.tokenId) filtre.tokenId = query.tokenId;
      const limite = query.limit ?? 100;
      const decalage = query.offset ?? 0;
      const [total, demandes] = await Promise.all([
        (prisma as any).freeTrialRequest.count({ where: filtre }),
        (prisma as any).freeTrialRequest.findMany({
          where: filtre,
          orderBy: { createdAt: 'desc' },
          skip: decalage,
          take: limite,
          include: { trialToken: { select: { token: true, label: true } } },
        }),
      ]);

      // ACCÈS COURANT des demandes déployées : serveur(s) attribué(s), volume
      // accordé ET consommé, échéance, état. C'est ce que l'exploitant doit
      // voir AVANT d'agir, et il ne doit plus avoir à quitter cette section
      // pour l'obtenir. Une seule lecture indexée pour toute la page, jamais
      // une requête par ligne.
      const acces = await accesParDemande(demandes as any[]);
      return res.json({
        requests: (demandes as any[]).map((demande) => ({
          ...vueDemandePourAdmin(demande),
          access: acces.get(String(demande.id)) ?? null,
        })),
        total: Number(total ?? demandes.length),
        limit: limite,
        offset: decalage,
      });
    } catch (err: any) {
      if (err instanceof z.ZodError) return erreurValidation(res, err);
      console.error('free-trial request list error:', err);
      return res.status(500).json({ error: 'errors.server', message: 'Lecture des demandes impossible' });
    }
  },
);

// ─── GET /api/free-trial/stats/countries ─────────────────────────────────────
//
// « Savoir d'où viennent nos clients » : nombre de clients et de demandes par
// pays, du plus gros volume au plus petit.
//
// Le pays agrégé est celui que l'inscrit a DÉCLARÉ dans l'application. Aucune
// adresse IP n'est lue, aucun service de géolocalisation n'est appelé : ce
// récapitulatif ne sait rien de plus que ce que les gens ont saisi.
//
// Statistique GLOBALE, donc fermée aux revendeurs : elle agrège le parc de
// tout le monde. Le lecteur ne voit que des compteurs — jamais un nom, un
// appareil, un jeton ni une empreinte.
router.get(
  '/stats/countries',
  requireAuth,
  interdireAccesRevendeur(),
  requirePermission('clients.view'),
  async (_req: AuthenticatedRequest, res: Response) => {
    try {
      if (!prisma) return baseIndisponible(res);
      // Projection minimale : trois colonnes suffisent à compter, et rien de
      // nominatif ne remonte donc en mémoire pour produire un total.
      const demandes = await (prisma as any).freeTrialRequest.findMany({
        select: { country: true, status: true, clientId: true },
      });
      const countries = statistiquesParPays(demandes);
      return res.json({ countries, totals: totauxParPays(countries) });
    } catch (err: any) {
      console.error('free-trial country stats error:', err);
      return res.status(500).json({ error: 'errors.server', message: 'Lecture des statistiques impossible' });
    }
  },
);

// ─── GET /api/free-trial/stats/overview ──────────────────────────────────────
//
// Indicateurs de la SECTION ESSAI, et d'elle seule. Ils ne partagent aucune
// source avec les compteurs des comptes principaux : tout dérive des demandes
// d'essai, si bien qu'un chiffre d'ici ne peut structurellement pas contenir un
// client ordinaire, ni l'inverse.
//
// « Connectés maintenant » réutilise LA mesure de présence existante
// (`vpn-presence`, fenêtre de 15 min, battement de 5 min) : aucun second calcul
// de présence n'a été écrit, sinon deux écrans finiraient par annoncer deux
// vérités. Quand la présence n'est pas mesurable, la réponse le DIT
// (`presence.measured = false`, `connectedNow = null`) au lieu de renvoyer un
// zéro qui se lirait « personne n'est connecté ».
//
// Statistique GLOBALE, donc fermée aux revendeurs, comme le récapitulatif par
// pays. Le lecteur ne voit que des compteurs — jamais un nom ni un appareil.
router.get(
  '/stats/overview',
  requireAuth,
  interdireAccesRevendeur(),
  requirePermission('clients.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!prisma) return baseIndisponible(res);
      // Projection minimale : trois colonnes suffisent à compter.
      const demandes = await (prisma as any).freeTrialRequest.findMany({
        select: { status: true, clientId: true, subscriptionId: true },
      });

      // Échéances lues sur les forfaits d'essai : « actif » se décide sur
      // l'accès réel, pas sur la date figée au moment du déploiement.
      const forfaitIds = [...new Set(
        (demandes as any[])
          .filter((d) => d.status === STATUT_DEMANDE.DEPLOYED && d.subscriptionId)
          .map((d) => String(d.subscriptionId)),
      )];
      const forfaits = new Map<string, { status?: string | null; expireAt?: Date | string | null; quotaBytes?: bigint | null; quotaUsed?: bigint | null }>();
      if (forfaitIds.length) {
        const lignes = await (prisma as any).subscription.findMany({
          where: { id: { in: forfaitIds } },
          select: { id: true, status: true, expireAt: true, quotaBytes: true, quotaUsed: true },
        });
        for (const ligne of lignes as any[]) {
          forfaits.set(String(ligne.id), {
            status: ligne.status,
            expireAt: ligne.expireAt,
            quotaBytes: ligne.quotaBytes,
            quotaUsed: ligne.quotaUsed,
          });
        }
      }

      // Présence : même service, même fenêtre, même secret que /api/presence.
      const secret = secretPresence();
      let clientsConnectes: Set<string> | null = null;
      let presence: MesurePresenceEssai = {
        measured: false,
        reason: 'not_configured',
        windowMinutes: PRESENCE_WINDOW_MINUTES,
        heartbeatMinutes: PRESENCE_HEARTBEAT_MINUTES,
      };
      if (secret) {
        try {
          const vue = await listerConnectes(prisma as any, secret, {
            // Furtivité identique au reste de la plateforme : hors OWNER, les
            // comptes OWNER n'existent pas.
            masquerProprietaire: !isOwnerRequest(req),
            sansDatation: true,
          });
          clientsConnectes = new Set(vue.lignes.map((ligne) => ligne.clientId));
          presence = {
            measured: true,
            reason: null,
            windowMinutes: vue.presenceWindowMinutes,
            heartbeatMinutes: vue.heartbeatMinutes,
            // La lecture des signaux est bornée : au-delà du plafond, un essai
            // connecté peut se trouver hors de la tranche lue. Le dire vaut
            // mieux que laisser croire à un total.
            truncated: vue.devicesTruncated,
          };
        } catch (erreurPresence: any) {
          console.error('free-trial presence error:', erreurPresence?.message || erreurPresence);
          presence = { ...presence, reason: 'unavailable' };
        }
      }

      return res.json(resumerEssais({ demandes, forfaits, clientsConnectes, presence }));
    } catch (err: any) {
      console.error('free-trial overview error:', err);
      return res.status(500).json({ error: 'errors.server', message: 'Lecture des indicateurs impossible' });
    }
  },
);

// ─── POST /api/free-trial/requests/deploy ────────────────────────────────────
//
// Étape 4. L'admin a sélectionné un ou plusieurs inscrits, puis choisi ce
// qu'ils reçoivent : quota, serveur(s), dates (heures comprises).
//
// Pour CHAQUE demande, l'association est : Utilisateur → Identifiant
// d'appareil → Serveur(s) attribué(s) → Go attribués → Dates attribuées.
//
// PLUSIEURS CONFIGURATIONS, PLUSIEURS INSCRITS : `profileIds` attribue en une
// fois N configurations à M inscrits ; chaque inscrit retenu reçoit alors UN
// forfait par configuration, comme un client principal peut détenir plusieurs
// forfaits. Le quota et les dates s'appliquent à CHAQUE forfait créé. Le
// produit M × N est borné (`MAX_FORFAITS_ESSAI`) et le refus est explicite :
// une sélection large ne fabrique jamais des milliers de forfaits d'un clic.
//
// RÉTROCOMPATIBILITÉ : `profileId` seul continue de fonctionner à l'identique.
//
// La configuration réelle n'est jamais recopiée ici : on crée le compte
// appareil et les forfaits, exactement comme le fait l'exploitation ordinaire,
// et l'application récupère ensuite sa configuration par le canal VPN normal.
router.post(
  '/requests/deploy',
  requireAuth,
  interdireAccesRevendeur(),
  interdireMutationSupport(),
  requirePermission('subscription.manage'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!prisma) return baseIndisponible(res);
      const body = deployerSchema.parse(req.body);

      // Bornage EXPLICITE du lot : doublons retirés (deux fois le même
      // identifiant vaudrait deux déploiements sur la même demande) et refus
      // motivé au-delà de la limite, jamais une troncature silencieuse.
      const lot = normaliserLotEssai(body.requestIds);
      if (!lot.ok) {
        const refusLot = refusLotEssai(lot.raison, lot.limite);
        return res.status(refusLot.status).json(refusLot.body);
      }

      // Les deux écritures de la demande — historique et multiple — sont
      // fusionnées puis dédoublonnées : un même serveur choisi deux fois ne
      // fabrique pas deux forfaits identiques.
      const configs = normaliserConfigsEssai([...(body.profileIds ?? []), ...(body.profileId ? [body.profileId] : [])]);
      if (!configs.ok) {
        const refus = refusConfigsEssai(configs.raison, configs.limite);
        return res.status(refus.status).json(refus.body);
      }

      // Le produit est contrôlé AVANT toute écriture : mieux vaut un refus
      // motivé qu'un lot appliqué à moitié puis coupé en cours de route.
      const produit = verifierProduitEssai(lot.ids.length, configs.ids.length);
      if (!produit.ok) return res.status(produit.refus.status).json(produit.refus.body);

      const fenetre = calculerFenetreEssai({ startAt: body.startAt, expireAt: body.expireAt });
      if (!fenetre.ok) return res.status(fenetre.refus!.status).json(fenetre.refus!.body);
      const { startAt, expireAt, durationDays } = fenetre.fenetre!;

      // Toutes les configurations sont validées d'un coup : un serveur
      // introuvable doit arrêter l'opération avant la première écriture,
      // plutôt que produire N échecs identiques.
      const profils: any[] = [];
      for (const profileId of configs.ids) {
        const profil = await (prisma as any).vpnProfile.findUnique({ where: { id: profileId } });
        if (!profil) {
          return res.status(404).json({
            error: 'errors.free_trial.profile_not_found',
            code: 'FREE_TRIAL_PROFILE_NOT_FOUND',
            message: 'Serveur (profil VPN) introuvable.',
            profileId,
          });
        }
        profils.push(profil);
      }

      const quotaBytes = BigInt(Math.round(body.quotaGB * GIB));
      const clientRole =
        (await prisma.role.findFirst({ where: { name: 'CLIENT' } })) ??
        (await prisma.role.findFirst({ where: { name: 'USER' } }));
      if (!clientRole) {
        return res.status(500).json({ error: 'errors.server', message: 'Rôle CLIENT introuvable' });
      }

      const resultats: Array<{ id: string; status: string; reason?: string; subscriptions?: number }> = [];
      let deployees = 0;
      let forfaitsCrees = 0;

      for (const requestId of lot.ids) {
        const demande = await (prisma as any).freeTrialRequest.findUnique({ where: { id: requestId } });
        // Le jeton du contexte est revérifié demande par demande : un
        // identifiant glissé dans le corps de la requête ne fait pas agir le
        // lot sur la campagne d'un autre jeton.
        if (!demandeAppartientAuJeton(demande, body.tokenId)) {
          resultats.push({ id: requestId, status: 'skipped', reason: RAISONS_LOT_ESSAI.TOKEN_MISMATCH });
          continue;
        }
        const refus = refusDeploiement(demande);
        if (refus) {
          resultats.push({ id: requestId, status: 'skipped', reason: String(refus.body.code || refus.body.error) });
          continue;
        }

        try {
          const deploiement = await executerMutationQuota(prisma, {
            auteur: { userId: req.user?.userId, email: req.user?.email },
            reason: `Déploiement d'essai gratuit pour ${demande.name}`,
            referenceType: 'free_trial_request',
            referenceId: demande.id,
          }, async (tx: any) => {
            // 1. Compte appareil. Un appareil déjà enrôlé garde SON compte :
            //    on ne recrée pas un second compte sur le même téléphone.
            let compte = await tx.vpnClient.findFirst({ where: { deviceId: demande.deviceId } });
            if (!compte) {
              const empreinte = crypto.createHash('sha256').update(demande.deviceId).digest('hex').slice(0, 32);
              const email = `device.${empreinte}@sxbvpn.local`;
              let utilisateur = await tx.user.findUnique({ where: { email } });
              if (!utilisateur) {
                utilisateur = await tx.user.create({
                  data: {
                    name: demande.name,
                    email,
                    passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12),
                    roleId: clientRole.id,
                    status: 'active',
                  },
                });
              }
              let jetonCompte = makeUserToken();
              for (let essai = 0; essai < 10; essai += 1) {
                const pris = await tx.vpnClient.findUnique({ where: { token: jetonCompte } });
                if (!pris) break;
                jetonCompte = makeUserToken();
              }
              compte = await tx.vpnClient.create({
                data: {
                  userId: utilisateur.id,
                  token: jetonCompte,
                  // L'appareil est lié dès la création : c'est CE téléphone,
                  // et aucun autre, qui pourra activer ce jeton de compte.
                  deviceId: demande.deviceId,
                  expireAt,
                  status: 'active',
                },
              });
            } else if (compte.status !== 'active' || (compte.expireAt && compte.expireAt < expireAt)) {
              // Réactivation / prolongation d'un compte existant, sans jamais
              // raccourcir une échéance déjà plus lointaine.
              compte = await tx.vpnClient.update({
                where: { id: compte.id },
                data: {
                  status: 'active',
                  expireAt: compte.expireAt && compte.expireAt > expireAt ? compte.expireAt : expireAt,
                },
              });
            }

            // 2. UN forfait PAR CONFIGURATION retenue : serveur, Go et dates
            //    choisis par l'admin, appliqués à chacun. Chaque forfait porte
            //    `freeTrialRequestId` — c'est ce marqueur STRUCTUREL qui le
            //    tient hors de « Forfaits Data », quel que soit son nom.
            const part = () => crypto.randomBytes(2).toString('hex').toUpperCase();
            const crees: any[] = [];
            for (const profil of profils) {
              crees.push(await tx.subscription.create({
                data: {
                  name: `Essai gratuit — ${profil.name}`,
                  clientId: compte.id,
                  profileId: profil.id,
                  dataToken: `SXB-DATA-${part()}-${part()}-${part()}`,
                  quotaBytes,
                  quotaUsed: BigInt(0),
                  durationDays,
                  deviceLimit: body.deviceLimit ?? 1,
                  deviceId: demande.deviceId,
                  startAt,
                  expireAt,
                  status: 'active',
                  createdBy: req.user?.userId ?? null,
                  freeTrialRequestId: demande.id,
                },
              }));
            }

            // 3. La demande passe « déployée ». Le passage est conditionné à
            //    `status: pending` : deux admins qui déploient la même demande
            //    en même temps ne créent pas deux forfaits.
            //    `subscriptionId` reste le forfait PRINCIPAL — le premier créé —
            //    pour ne changer le contrat d'aucun appelant existant ; les
            //    autres se lisent par `freeTrialRequestId`.
            const bascule = await tx.freeTrialRequest.updateMany({
              where: { id: demande.id, status: STATUT_DEMANDE.PENDING },
              data: {
                status: STATUT_DEMANDE.DEPLOYED,
                clientId: compte.id,
                subscriptionId: crees[0].id,
                deployedAt: new Date(),
                deployedBy: req.user?.userId ?? null,
                reviewNote: body.note ?? null,
              },
            });
            if (bascule.count !== 1) {
              throw new Error('FREE_TRIAL_CONCURRENT_DEPLOY');
            }
            return { clientId: compte.id, subscriptionIds: crees.map((forfait: any) => forfait.id) };
          });

          deployees += 1;
          forfaitsCrees += profils.length;
          resultats.push({ id: requestId, status: 'deployed', subscriptions: profils.length });
          await logDbActivity(
            req.user?.userId || null,
            `Essai gratuit déployé pour ${demande.name} (${body.quotaGB} Go, ${profils.map((p: any) => p.name).join(' + ')}, expire ${expireAt.toISOString()})`,
            'success',
            req.ip || '',
          );
          void deploiement;
        } catch (erreurDemande: any) {
          const concurrent = erreurDemande?.message === 'FREE_TRIAL_CONCURRENT_DEPLOY';
          resultats.push({
            id: requestId,
            status: concurrent ? 'skipped' : 'failed',
            reason: concurrent ? CODES_ESSAI.ALREADY_DEPLOYED : 'errors.server',
          });
          if (!concurrent) console.error('free-trial deploy error:', erreurDemande);
        }
      }

      return res.json({
        success: true,
        deployed: deployees,
        total: lot.ids.length,
        // Ce que l'exploitant a réellement fabriqué : l'interface l'annonce
        // avant la confirmation, la réponse le confirme après.
        profiles: configs.ids.length,
        subscriptionsCreated: forfaitsCrees,
        results: resultats,
      });
    } catch (err: any) {
      if (err instanceof z.ZodError) return erreurValidation(res, err);
      console.error('free-trial deploy error:', err);
      return res.status(500).json({ error: 'errors.server', message: 'Déploiement impossible' });
    }
  },
);

// ─── POST /api/free-trial/requests/reject ────────────────────────────────────
// Refus explicite : l'inscrit voit « refusée » plutôt que d'attendre sans fin.
router.post(
  '/requests/reject',
  requireAuth,
  interdireAccesRevendeur(),
  interdireMutationSupport(),
  requirePermission('subscription.manage'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!prisma) return baseIndisponible(res);
      const body = refuserSchema.parse(req.body);
      const lot = normaliserLotEssai(body.requestIds);
      if (!lot.ok) {
        const refusLot = refusLotEssai(lot.raison, lot.limite);
        return res.status(refusLot.status).json(refusLot.body);
      }
      const refusees = await (prisma as any).freeTrialRequest.updateMany({
        // Le jeton du contexte fait partie du filtre : un identifiant étranger
        // à la campagne ne peut pas être refusé par ce lot.
        where: {
          id: { in: lot.ids },
          status: STATUT_DEMANDE.PENDING,
          ...(body.tokenId ? { tokenId: body.tokenId } : {}),
        },
        data: {
          status: STATUT_DEMANDE.REJECTED,
          rejectedAt: new Date(),
          rejectedBy: req.user?.userId ?? null,
          reviewNote: body.note ?? null,
        },
      });
      await logDbActivity(
        req.user?.userId || null,
        `${refusees.count} demande(s) d'essai gratuit refusée(s)`,
        'warning',
        req.ip || '',
      );
      return res.json({ success: true, rejected: refusees.count, total: lot.ids.length });
    } catch (err: any) {
      if (err instanceof z.ZodError) return erreurValidation(res, err);
      console.error('free-trial reject error:', err);
      return res.status(500).json({ error: 'errors.server', message: 'Refus impossible' });
    }
  },
);

// ─── POST /api/free-trial/requests/manage ────────────────────────────────────
//
// TOUT SE GÈRE ICI. Les trois écrans d'exploitation n'offrent plus aucune prise
// sur un essai ; c'est donc cette route qui porte les gestes qu'ils portaient :
// attribuer ou remplacer un serveur, modifier le quota, prolonger ou raccourcir
// l'échéance, suspendre, réactiver, révoquer — sur UNE SÉLECTION d'essais
// déployés, comme le déploiement groupé.
//
// LA MÉCANIQUE N'EST PAS RÉÉCRITE : chaque forfait est planifié par
// `planifierApplication` / `planifierEtat` de `subscription-bulk.ts`, les mêmes
// fonctions que l'action « apply » des forfaits. Mêmes propriétés, donc :
// champs indépendamment facultatifs, rien de renseigné = rien de réécrit,
// résultat rapporté élément par élément, échec isolé sans annuler les
// réussites.
//
// Réservée à l'exploitation interne, comme le déploiement : un revendeur est
// refusé avant toute lecture.
router.post(
  '/requests/manage',
  requireAuth,
  interdireAccesRevendeur(),
  interdireMutationSupport(),
  requirePermission('subscription.manage'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!prisma) return baseIndisponible(res);
      const body = gererSchema.parse(req.body);

      const lot = normaliserLotEssai(body.requestIds);
      if (!lot.ok) {
        const refusLot = refusLotEssai(lot.raison, lot.limite);
        return res.status(refusLot.status).json(refusLot.body);
      }

      // Attribution de NOUVELLES configurations : chaque essai retenu reçoit un
      // forfait de plus par configuration. Même borne de produit que le
      // déploiement — une sélection large ne fabrique pas des milliers de
      // forfaits d'un clic.
      const attribution = body.profileIds?.length ? normaliserConfigsEssai(body.profileIds) : null;
      if (attribution && !attribution.ok) {
        const refus = refusConfigsEssai(attribution.raison, attribution.limite);
        return res.status(refus.status).json(refus.body);
      }
      const configsAjoutees = attribution && attribution.ok ? attribution.ids : [];
      if (configsAjoutees.length) {
        const produit = verifierProduitEssai(lot.ids.length, configsAjoutees.length);
        if (!produit.ok) return res.status(produit.refus.status).json(produit.refus.body);
      }

      const changements: ChangementsGroupes = {
        ...(body.profileId !== undefined ? { profileId: body.profileId } : {}),
        ...(body.quotaGB !== undefined ? { quotaGB: body.quotaGB, quotaMode: body.quotaMode ?? 'set' } : {}),
        ...(body.startAt !== undefined ? { startAt: body.startAt } : {}),
        ...(body.expireAt !== undefined ? { expireAt: body.expireAt } : {}),
        ...(body.durationDays !== undefined ? { durationDays: body.durationDays, durationMode: body.durationMode ?? 'set' } : {}),
      };
      const modifie = !aucunChampRenseigne(changements);
      const etat = body.state as EtatGroupe | undefined;

      // Les configurations demandées sont validées UNE fois : elles sont les
      // mêmes pour tout le lot, et un refus doit arrêter l'opération avant
      // toute écriture plutôt que produire N échecs identiques.
      const profilsAjoutes: any[] = [];
      for (const profileId of [...configsAjoutees, ...(body.profileId ? [body.profileId] : [])]) {
        const profil = await (prisma as any).vpnProfile.findUnique({ where: { id: profileId } });
        if (!profil) {
          return res.status(404).json({
            error: 'errors.free_trial.profile_not_found',
            code: 'FREE_TRIAL_PROFILE_NOT_FOUND',
            message: 'Serveur (profil VPN) introuvable.',
            profileId,
          });
        }
        if (configsAjoutees.includes(profileId)) profilsAjoutes.push(profil);
      }

      const resultats: Array<{ id: string; status: string; reason?: string; updated?: number; created?: number }> = [];
      let reussies = 0;
      let forfaitsTouches = 0;
      let forfaitsCrees = 0;

      for (const requestId of lot.ids) {
        const demande = await (prisma as any).freeTrialRequest.findUnique({ where: { id: requestId } });
        // Même contrôle qu'au déploiement : le jeton du contexte est revérifié
        // demande par demande, jamais déduit de la liste reçue.
        if (!demandeAppartientAuJeton(demande, body.tokenId)) {
          resultats.push({ id: requestId, status: 'skipped', reason: RAISONS_LOT_ESSAI.TOKEN_MISMATCH });
          continue;
        }
        if (!demande) {
          resultats.push({ id: requestId, status: 'failed', reason: CODES_ESSAI.REQUEST_NOT_FOUND });
          continue;
        }
        if (demande.status !== STATUT_DEMANDE.DEPLOYED) {
          // Un essai non déployé n'a aucun accès à gérer : le dire vaut mieux
          // que compter une réussite sur un dossier qui n'a rien reçu.
          resultats.push({ id: requestId, status: 'skipped', reason: CODES_ESSAI.NOT_PENDING });
          continue;
        }

        const condition = conditionForfaitsEssai([demande]);
        const forfaits = condition
          ? await (prisma as any).subscription.findMany({
              where: condition,
              include: { client: { select: { userId: true, resellerId: true } } },
            })
          : [];
        if (!forfaits.length && !profilsAjoutes.length) {
          resultats.push({ id: requestId, status: 'skipped', reason: 'errors.free_trial.no_access' });
          continue;
        }

        let touches = 0;
        let crees = 0;
        let echec: string | null = null;

        // ── Modifications et gestes d'état sur les forfaits EXISTANTS ───────
        for (const forfait of forfaits as any[]) {
          try {
            const data: Record<string, unknown> = {};
            let reduit = true;

            if (modifie) {
              const plan = planifierApplication(forfait, changements);
              if (plan.statut === 'failed') { echec = plan.raison; continue; }
              if (plan.statut === 'ok') {
                Object.assign(data, plan.data);
                const avant = plan.engageAvant ? plan.quotaAvant : BigInt(0);
                const apres = plan.engageApres ? plan.quotaApres : BigInt(0);
                if (apres > avant) reduit = false;
              }
            }
            if (etat) {
              const planEtat = planifierEtat(forfait, etat, new Date(), body.note);
              if (planEtat.statut === 'failed') { echec = planEtat.raison; continue; }
              if (planEtat.statut === 'ok') {
                // Le geste d'état a le dernier mot sur `status` : il est
                // explicite, là où `planifierApplication` ne fait que déduire.
                Object.assign(data, planEtat.data);
                if (!planEtat.reduitExposition) reduit = false;
              }
            }
            if (Object.keys(data).length === 0) continue;

            await executerMutationQuota(prisma, {
              resellerUserId: forfait.client?.userId,
              resellerId: forfait.client?.resellerId ?? null,
              auteur: { userId: req.user?.userId, email: req.user?.email },
              reason: `Gestion d'essai gratuit pour ${demande.name}`,
              referenceType: 'subscription',
              referenceId: forfait.id,
              autoriserReductionAuDessusDuPlafond: reduit,
            }, (tx: any) => tx.subscription.update({ where: { id: forfait.id }, data }));
            accessStateHub.invalidate({ clientId: forfait.clientId });
            touches += 1;
          } catch (erreurForfait: any) {
            echec = erreurForfait?.message || 'errors.server';
            console.error('free-trial manage error:', erreurForfait);
          }
        }

        // ── Attribution de configurations SUPPLÉMENTAIRES ──────────────────
        // L'échéance et le volume viennent de la requête quand ils y sont, et
        // de l'accès existant sinon : un serveur ajouté doit courir jusqu'à la
        // même date que les autres, pas jusqu'à une date inventée.
        if (profilsAjoutes.length && demande.clientId) {
          const reference = (forfaits as any[])[0] ?? null;
          const debut = body.startAt ?? new Date();
          const echeance = body.expireAt
            ?? (body.durationDays ? new Date(debut.getTime() + body.durationDays * 86_400_000) : null)
            ?? (reference?.expireAt ? new Date(reference.expireAt) : null);
          if (!echeance) {
            echec = 'errors.free_trial.window_invalid';
          } else {
            const fenetre = calculerFenetreEssai({ startAt: debut, expireAt: echeance });
            if (!fenetre.ok) {
              echec = String(fenetre.refus!.body.code || fenetre.refus!.body.error);
            } else {
              const volume = body.quotaGB !== undefined
                ? BigInt(Math.round(body.quotaGB * GIB))
                : BigInt(reference?.quotaBytes ?? 0);
              const part = () => crypto.randomBytes(2).toString('hex').toUpperCase();
              for (const profil of profilsAjoutes) {
                try {
                  await executerMutationQuota(prisma, {
                    resellerUserId: reference?.client?.userId,
                    resellerId: reference?.client?.resellerId ?? null,
                    auteur: { userId: req.user?.userId, email: req.user?.email },
                    reason: `Attribution d'un serveur d'essai pour ${demande.name}`,
                    referenceType: 'subscription',
                  }, (tx: any) => tx.subscription.create({
                    data: {
                      name: `Essai gratuit — ${profil.name}`,
                      clientId: demande.clientId,
                      profileId: profil.id,
                      dataToken: `SXB-DATA-${part()}-${part()}-${part()}`,
                      quotaBytes: volume,
                      quotaUsed: BigInt(0),
                      durationDays: fenetre.fenetre!.durationDays,
                      deviceLimit: reference?.deviceLimit ?? 1,
                      deviceId: demande.deviceId,
                      startAt: fenetre.fenetre!.startAt,
                      expireAt: fenetre.fenetre!.expireAt,
                      status: 'active',
                      createdBy: req.user?.userId ?? null,
                      // Le marqueur STRUCTUREL suit le forfait dès sa création :
                      // il ne peut pas apparaître une seule seconde dans
                      // « Forfaits Data ».
                      freeTrialRequestId: demande.id,
                    },
                  }));
                  accessStateHub.invalidate({ clientId: demande.clientId });
                  crees += 1;
                } catch (erreurAjout: any) {
                  echec = erreurAjout?.message || 'errors.server';
                  console.error('free-trial assign error:', erreurAjout);
                }
              }
            }
          }
        }

        forfaitsTouches += touches;
        forfaitsCrees += crees;
        if (touches + crees > 0) {
          reussies += 1;
          resultats.push({ id: requestId, status: 'ok', updated: touches, created: crees });
        } else {
          resultats.push({
            id: requestId,
            status: echec ? 'failed' : 'skipped',
            reason: echec ?? RAISONS_GROUPEES.AUCUN_CHANGEMENT,
          });
        }
      }

      await logDbActivity(
        req.user?.userId || null,
        `Gestion groupée d'essais gratuits : ${reussies} essai(s) sur ${lot.ids.length}, ${forfaitsTouches} forfait(s) modifié(s), ${forfaitsCrees} créé(s)`,
        resultats.some((ligne) => ligne.status === 'failed') ? 'warning' : 'info',
        req.ip || '',
      );

      return res.json({
        success: true,
        total: lot.ids.length,
        succeeded: reussies,
        updated: forfaitsTouches,
        created: forfaitsCrees,
        results: resultats,
      });
    } catch (err: any) {
      if (err instanceof z.ZodError) return erreurValidation(res, err);
      if (err instanceof PlafondQuotaDepasse) {
        return res.status(409).json(reponsePlafondDepasse(err.alloue, err.plafond));
      }
      console.error('free-trial manage error:', err);
      return res.status(500).json({ error: 'errors.server', message: 'Gestion impossible' });
    }
  },
);

export default router;

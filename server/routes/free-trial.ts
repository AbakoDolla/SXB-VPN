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
import { prisma, logDbActivity } from '../database';
import { requireAuth, requirePermission, AuthenticatedRequest } from '../middleware/auth';
import { interdireMutationSupport } from '../services/reseller-access';
import { executerMutationQuota } from '../services/reseller-quota';
import { makeUserToken } from '../services/device-token';
import {
  CODES_ESSAI,
  MOTIF_JETON_ESSAI,
  STATUT_DEMANDE,
  STATUT_JETON,
  calculerFenetreEssai,
  etatJetonEssai,
  genererJetonEssai,
  genererSecretReclamation,
  hacherSecretReclamation,
  intervalleVerificationEssai,
  normaliserJetonEssai,
  refusDeploiement,
  refusJetonEssai,
  refusReclamationEssai,
  vueDemandePourAdmin,
  vueInscriptionEssai,
  vueJetonPourAdmin,
  vueStatutEssaiPourAppareil,
} from '../services/free-trial';

const router = Router();
const GIB = 1024 ** 3;

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

const inscriptionSchema = z.object({
  token: z.string().trim().min(1).max(64),
  // Le nom est OBLIGATOIRE : c'est la seule information d'identification que
  // l'admin aura pour instruire la demande.
  name: z.string().trim().min(2, 'Le nom est obligatoire.').max(120),
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
  requestIds: z.array(identifiantSchema).min(1).max(200),
  profileId: identifiantSchema,
  quotaGB: z.coerce.number().finite().positive('Le quota doit être supérieur à 0 Go.').max(100_000),
  // Dates ET heures : `z.coerce.date()` accepte l'ISO complet envoyé par le
  // tableau de bord, donc « 2026-09-12T18:30:00Z » aussi bien qu'une date nue.
  startAt: z.coerce.date().optional(),
  expireAt: z.coerce.date(),
  deviceLimit: z.coerce.number().int().min(1).max(100).optional(),
  note: z.string().trim().max(500).optional(),
}).strict();

const refuserSchema = z.object({
  requestIds: z.array(identifiantSchema).min(1).max(200),
  note: z.string().trim().max(500).optional(),
}).strict();

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
  requirePermission('tokens.view'),
  async (_req: AuthenticatedRequest, res: Response) => {
    try {
      if (!prisma) return baseIndisponible(res);
      const jetons = await (prisma as any).freeTrialToken.findMany({
        orderBy: { createdAt: 'desc' },
        take: 500,
        include: { _count: { select: { requests: true } } },
      });
      return res.json({
        tokens: jetons.map((jeton: any) =>
          vueJetonPourAdmin({ ...jeton, requestCount: jeton._count?.requests ?? 0 })),
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
    // doublon et on ne consomme pas une seconde place. Un nouveau secret est
    // remis, ce qui permet à l'utilisateur qui a réinstallé l'application de
    // retrouver sa demande — et invalide l'ancien secret du même coup.
    const existante = await (prisma as any).freeTrialRequest.findUnique({
      where: { tokenId_deviceId: { tokenId: jeton.id, deviceId } },
    });

    const claimSecret = genererSecretReclamation();
    const claimSecretHash = hacherSecretReclamation(claimSecret);

    if (existante) {
      const rafraichie = await (prisma as any).freeTrialRequest.update({
        where: { id: existante.id },
        data: {
          name: body.name,
          claimSecretHash,
          platform: body.platform ?? existante.platform ?? null,
          appVersion: body.appVersion ?? existante.appVersion ?? null,
        },
      });
      return res.status(200).json(vueInscriptionEssai({
        demande: rafraichie,
        claimSecret,
        pollIntervalSeconds: INTERVALLE_VERIFICATION_S,
      }));
    }

    // Création + incrément du compteur dans la MÊME transaction : sans cela,
    // deux inscriptions simultanées passeraient toutes les deux le contrôle de
    // `maxUses`.
    const demande = await prisma.$transaction(async (tx: any) => {
      const frais = await tx.freeTrialToken.findUnique({ where: { id: jeton.id } });
      const etat = etatJetonEssai(frais);
      if (etat !== 'active') return { conflit: etat } as const;
      const creee = await tx.freeTrialRequest.create({
        data: {
          tokenId: jeton.id,
          name: body.name,
          deviceId,
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
    if (err instanceof z.ZodError) return erreurValidation(res, err);
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
  requirePermission('clients.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!prisma) return baseIndisponible(res);
      const statut = typeof req.query.status === 'string' ? req.query.status : undefined;
      const filtre = statut && Object.values(STATUT_DEMANDE).includes(statut as any)
        ? { status: statut }
        : {};
      const demandes = await (prisma as any).freeTrialRequest.findMany({
        where: filtre,
        orderBy: { createdAt: 'desc' },
        take: 500,
        include: { trialToken: { select: { token: true, label: true } } },
      });
      return res.json({ requests: demandes.map(vueDemandePourAdmin) });
    } catch (err: any) {
      console.error('free-trial request list error:', err);
      return res.status(500).json({ error: 'errors.server', message: 'Lecture des demandes impossible' });
    }
  },
);

// ─── POST /api/free-trial/requests/deploy ────────────────────────────────────
//
// Étape 4. L'admin a sélectionné un ou plusieurs inscrits, puis choisi ce
// qu'ils reçoivent : quota, serveur, dates (heures comprises).
//
// Pour CHAQUE demande, l'association est : Utilisateur → Identifiant
// d'appareil → Serveur attribué → Go attribués → Dates attribuées.
//
// La configuration réelle n'est jamais recopiée ici : on crée le compte
// appareil et le forfait, exactement comme le fait l'exploitation ordinaire,
// et l'application récupère ensuite sa configuration par le canal VPN normal.
router.post(
  '/requests/deploy',
  requireAuth,
  interdireMutationSupport(),
  requirePermission('subscription.manage'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!prisma) return baseIndisponible(res);
      const body = deployerSchema.parse(req.body);

      const fenetre = calculerFenetreEssai({ startAt: body.startAt, expireAt: body.expireAt });
      if (!fenetre.ok) return res.status(fenetre.refus!.status).json(fenetre.refus!.body);
      const { startAt, expireAt, durationDays } = fenetre.fenetre!;

      const profil = await (prisma as any).vpnProfile.findUnique({ where: { id: body.profileId } });
      if (!profil) {
        return res.status(404).json({
          error: 'errors.free_trial.profile_not_found',
          message: 'Serveur (profil VPN) introuvable.',
        });
      }

      const quotaBytes = BigInt(Math.round(body.quotaGB * GIB));
      const clientRole =
        (await prisma.role.findFirst({ where: { name: 'CLIENT' } })) ??
        (await prisma.role.findFirst({ where: { name: 'USER' } }));
      if (!clientRole) {
        return res.status(500).json({ error: 'errors.server', message: 'Rôle CLIENT introuvable' });
      }

      const resultats: Array<{ id: string; status: string; reason?: string }> = [];
      let deployees = 0;

      for (const requestId of body.requestIds) {
        const demande = await (prisma as any).freeTrialRequest.findUnique({ where: { id: requestId } });
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

            // 2. Forfait : serveur, Go et dates choisis par l'admin.
            const part = () => crypto.randomBytes(2).toString('hex').toUpperCase();
            const forfait = await tx.subscription.create({
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
              },
            });

            // 3. La demande passe « déployée ». Le passage est conditionné à
            //    `status: pending` : deux admins qui déploient la même demande
            //    en même temps ne créent pas deux forfaits.
            const bascule = await tx.freeTrialRequest.updateMany({
              where: { id: demande.id, status: STATUT_DEMANDE.PENDING },
              data: {
                status: STATUT_DEMANDE.DEPLOYED,
                clientId: compte.id,
                subscriptionId: forfait.id,
                deployedAt: new Date(),
                deployedBy: req.user?.userId ?? null,
                reviewNote: body.note ?? null,
              },
            });
            if (bascule.count !== 1) {
              throw new Error('FREE_TRIAL_CONCURRENT_DEPLOY');
            }
            return { clientId: compte.id, subscriptionId: forfait.id };
          });

          deployees += 1;
          resultats.push({ id: requestId, status: 'deployed' });
          await logDbActivity(
            req.user?.userId || null,
            `Essai gratuit déployé pour ${demande.name} (${body.quotaGB} Go, ${profil.name}, expire ${expireAt.toISOString()})`,
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
        total: body.requestIds.length,
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
  interdireMutationSupport(),
  requirePermission('subscription.manage'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!prisma) return baseIndisponible(res);
      const body = refuserSchema.parse(req.body);
      const refusees = await (prisma as any).freeTrialRequest.updateMany({
        where: { id: { in: body.requestIds }, status: STATUT_DEMANDE.PENDING },
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
      return res.json({ success: true, rejected: refusees.count, total: body.requestIds.length });
    } catch (err: any) {
      if (err instanceof z.ZodError) return erreurValidation(res, err);
      console.error('free-trial reject error:', err);
      return res.status(500).json({ error: 'errors.server', message: 'Refus impossible' });
    }
  },
);

export default router;

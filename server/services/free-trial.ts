/**
 * free-trial.ts — Logique pure de l'essai gratuit SXB.
 *
 * PRINCIPE CENTRAL, ET RAISON D'ÊTRE DE CE FICHIER :
 * le jeton d'essai N'EST PAS une configuration VPN. C'est un code
 * d'invitation, rien de plus. La chaîne est strictement séparée en deux :
 *
 *   1) Jeton  →  Nom + Identifiant d'appareil  →  EN ATTENTE
 *   2) Approbation admin  →  Go + Serveur + Dates  →  déploiement interne
 *                        →  configuration visible dans l'app de l'utilisateur
 *
 * Toutes les décisions sont ici, sous forme de fonctions PURES et testables
 * sans base de données : les routes ne font que charger des lignes et
 * appliquer ces décisions. C'est ce qui permet de prouver par des tests de
 * régression qu'aucune information de serveur, de quota, de dates ou de
 * configuration ne peut sortir avant — ni en dehors de — l'appareil autorisé.
 *
 * Aucune fonction de ce fichier ne recopie une ligne de base telle quelle :
 * chaque vue est construite champ par champ (liste blanche). Une fuite ne
 * peut donc pas apparaître « par accident » en ajoutant une colonne.
 */
import crypto from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Codes métier stables (jamais de texte libre comme discriminant)
// ─────────────────────────────────────────────────────────────────────────────
export const CODES_ESSAI = {
  TOKEN_NOT_FOUND: "FREE_TRIAL_TOKEN_NOT_FOUND",
  TOKEN_REVOKED: "FREE_TRIAL_TOKEN_REVOKED",
  TOKEN_EXPIRED: "FREE_TRIAL_TOKEN_EXPIRED",
  TOKEN_EXHAUSTED: "FREE_TRIAL_TOKEN_EXHAUSTED",
  REQUEST_NOT_FOUND: "FREE_TRIAL_REQUEST_NOT_FOUND",
  CLAIM_INVALID: "FREE_TRIAL_CLAIM_INVALID",
  ALREADY_DEPLOYED: "FREE_TRIAL_ALREADY_DEPLOYED",
  NOT_PENDING: "FREE_TRIAL_NOT_PENDING",
  WINDOW_INVALID: "FREE_TRIAL_WINDOW_INVALID",
} as const;

export const STATUT_DEMANDE = {
  PENDING: "pending",
  DEPLOYED: "deployed",
  REJECTED: "rejected",
} as const;

export const STATUT_JETON = {
  ACTIVE: "active",
  REVOKED: "revoked",
} as const;

export type StatutDemande = (typeof STATUT_DEMANDE)[keyof typeof STATUT_DEMANDE];

/** État calculé d'un jeton d'invitation au moment où on le présente. */
export type EtatJetonEssai = "active" | "not_found" | "revoked" | "expired" | "exhausted";

// ─────────────────────────────────────────────────────────────────────────────
// Format du jeton d'invitation
// ─────────────────────────────────────────────────────────────────────────────

/** Préfixe imposé par le propriétaire : « STUFF-X8K4-P92M ». */
export const PREFIXE_JETON_ESSAI = "STUFF";

/**
 * Alphabet sans caractères ambigus (ni O/0 ni I/1) : le jeton est dicté à
 * l'oral ou recopié depuis un message, la confusion coûte un appel au support.
 */
const ALPHABET_JETON = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const MOTIF_JETON_ESSAI = /^STUFF-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

/**
 * Génère un jeton d'essai ALÉATOIRE.
 *
 * Le jeton ne dérive de RIEN : ni du quota, ni du serveur, ni des dates, ni de
 * l'identité du destinataire. Il n'encode donc aucune information exploitable
 * et ne peut rien révéler, même déchiffré ou analysé.
 */
export function genererJetonEssai(): string {
  const bloc = () =>
    Array.from({ length: 4 }, () => ALPHABET_JETON[crypto.randomInt(ALPHABET_JETON.length)]).join("");
  return `${PREFIXE_JETON_ESSAI}-${bloc()}-${bloc()}`;
}

/** Normalise la saisie utilisateur (espaces, minuscules, tirets manquants). */
export function normaliserJetonEssai(brut: unknown): string {
  if (typeof brut !== "string") return "";
  return brut.trim().toUpperCase().replace(/\s+/g, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// Secret de réclamation — ce qui empêche de lire la demande d'autrui
// ─────────────────────────────────────────────────────────────────────────────
//
// Le jeton d'essai peut être partagé à dix personnes : il ne doit donc JAMAIS
// suffire à lire un statut. À l'inscription, le serveur remet à l'appareil un
// secret aléatoire, conservé uniquement HACHÉ en base. Sans ce secret, même
// quelqu'un qui connaît le jeton ET l'identifiant d'appareil d'une victime ne
// peut rien lire de sa demande.

export function genererSecretReclamation(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function hacherSecretReclamation(secret: string): string {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Comparaison à temps constant : une comparaison naïve fuit le secret. */
export function secretCorrespond(secret: unknown, hachage: unknown): boolean {
  if (typeof secret !== "string" || typeof hachage !== "string") return false;
  if (!secret || hachage.length !== 64) return false;
  const attendu = Buffer.from(hachage, "hex");
  const calcule = Buffer.from(hacherSecretReclamation(secret), "hex");
  if (attendu.length !== calcule.length || attendu.length === 0) return false;
  return crypto.timingSafeEqual(attendu, calcule);
}

// ─────────────────────────────────────────────────────────────────────────────
// État du jeton d'invitation
// ─────────────────────────────────────────────────────────────────────────────

export interface JetonEssai {
  id?: string;
  token?: string;
  status?: string | null;
  maxUses?: number | null;
  usedCount?: number | null;
  expiresAt?: Date | string | null;
}

function depassee(echeance: Date | string | null | undefined, maintenant: Date): boolean {
  if (!echeance) return false;
  const date = echeance instanceof Date ? echeance : new Date(echeance);
  return !Number.isNaN(date.getTime()) && date.getTime() <= maintenant.getTime();
}

export function etatJetonEssai(jeton: JetonEssai | null | undefined, maintenant = new Date()): EtatJetonEssai {
  if (!jeton) return "not_found";
  if (jeton.status && jeton.status !== STATUT_JETON.ACTIVE) return "revoked";
  if (depassee(jeton.expiresAt, maintenant)) return "expired";
  const plafond = jeton.maxUses;
  if (typeof plafond === "number" && plafond > 0 && Number(jeton.usedCount ?? 0) >= plafond) {
    return "exhausted";
  }
  return "active";
}

/**
 * Refus normalisé pour un jeton inutilisable.
 *
 * Volontairement peu bavard : un jeton révoqué, expiré ou épuisé répond de la
 * même façon qu'un jeton inconnu du point de vue des données exposées — aucune
 * information sur un quelconque déploiement, serveur ou bénéficiaire.
 */
export function refusJetonEssai(etat: EtatJetonEssai): { status: number; body: Record<string, unknown> } | null {
  switch (etat) {
    case "active":
      return null;
    case "not_found":
      return {
        status: 404,
        body: {
          error: "errors.free_trial.token_invalid",
          code: CODES_ESSAI.TOKEN_NOT_FOUND,
          message: "Jeton d’essai invalide.",
        },
      };
    case "revoked":
      return {
        status: 403,
        body: {
          error: "errors.free_trial.token_revoked",
          code: CODES_ESSAI.TOKEN_REVOKED,
          message: "Ce jeton d’essai a été révoqué.",
        },
      };
    case "expired":
      return {
        status: 410,
        body: {
          error: "errors.free_trial.token_expired",
          code: CODES_ESSAI.TOKEN_EXPIRED,
          message: "Ce jeton d’essai a expiré.",
        },
      };
    case "exhausted":
      return {
        status: 409,
        body: {
          error: "errors.free_trial.token_exhausted",
          code: CODES_ESSAI.TOKEN_EXHAUSTED,
          message: "Ce jeton d’essai a atteint son nombre maximal d’inscriptions.",
        },
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Vérification automatique du statut (étape 2)
// ─────────────────────────────────────────────────────────────────────────────
//
// Le propriétaire demande une vérification automatique « toutes les 2 à 10
// minutes ». L'intervalle est donc CONFIGURABLE mais BORNÉ : en deçà de deux
// minutes on réveille la radio du téléphone pour rien, au-delà de dix minutes
// l'utilisateur attend son accès alors qu'il est déjà déployé.

export const INTERVALLE_VERIFICATION_MIN_S = 120;
export const INTERVALLE_VERIFICATION_MAX_S = 600;
export const INTERVALLE_VERIFICATION_DEFAUT_S = 180;

/** Ramène un réglage développeur dans la fenêtre 2–10 minutes. */
export function intervalleVerificationEssai(brut?: unknown): number {
  const valeur = typeof brut === "string" ? Number(brut) : typeof brut === "number" ? brut : Number.NaN;
  if (!Number.isFinite(valeur) || valeur <= 0) return INTERVALLE_VERIFICATION_DEFAUT_S;
  return Math.min(INTERVALLE_VERIFICATION_MAX_S, Math.max(INTERVALLE_VERIFICATION_MIN_S, Math.round(valeur)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Garde-fou anti-fuite
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Champs qui ne doivent JAMAIS apparaître dans une réponse destinée à
 * l'application mobile côté essai gratuit. La liste couvre les noms employés
 * dans tout le dépôt pour désigner un serveur, un quota, une échéance d'accès
 * ou une configuration.
 */
export const CHAMPS_INTERDITS_MOBILE: readonly string[] = [
  "host", "port", "server", "serverId", "serverName", "ip", "sni", "path",
  "username", "password", "uuid", "payload", "payloadId", "dns",
  "profile", "profileId", "profileName", "protocol", "displayProtocol",
  "technicalProtocol", "canonicalConfig", "canonicalConfigHash", "jsonConfig",
  "config", "encryptedBlob", "configKey", "dataToken", "subscription",
  "subscriptionId", "quota", "quotaGB", "quotaBytes", "quotaUsed", "quotaTotal",
  "expireAt", "expiresAt", "startAt", "durationDays", "clientId",
  "claimSecretHash", "reviewNote", "deployedBy", "rejectedBy", "label",
];

/** Erreur interne : une vue mobile a été construite avec un champ interdit. */
export class FuiteConfigurationEssai extends Error {
  constructor(public readonly champs: string[]) {
    super(`Vue d’essai gratuit refusée : champs interdits ${champs.join(", ")}`);
    this.name = "FuiteConfigurationEssai";
  }
}

/** Repère récursivement les champs interdits d'une valeur sérialisable. */
export function champsInterditsPresents(valeur: unknown, profondeur = 0): string[] {
  if (profondeur > 6 || valeur === null || typeof valeur !== "object") return [];
  if (Array.isArray(valeur)) return valeur.flatMap((item) => champsInterditsPresents(item, profondeur + 1));
  const trouves: string[] = [];
  for (const [cle, sousValeur] of Object.entries(valeur as Record<string, unknown>)) {
    if (CHAMPS_INTERDITS_MOBILE.includes(cle)) trouves.push(cle);
    trouves.push(...champsInterditsPresents(sousValeur, profondeur + 1));
  }
  return trouves;
}

/** Invariant appliqué à chaque vue mobile avant renvoi. */
export function verifierAucuneFuite<T>(vue: T): T {
  const champs = champsInterditsPresents(vue);
  if (champs.length) throw new FuiteConfigurationEssai(champs);
  return vue;
}

// ─────────────────────────────────────────────────────────────────────────────
// Demandes d'essai
// ─────────────────────────────────────────────────────────────────────────────

export interface DemandeEssai {
  id: string;
  tokenId?: string;
  name: string;
  deviceId: string;
  claimSecretHash: string;
  status: string;
  clientId?: string | null;
  subscriptionId?: string | null;
  createdAt?: Date | string | null;
  deployedAt?: Date | string | null;
  rejectedAt?: Date | string | null;
  [autre: string]: unknown;
}

export interface ReponseStatutEssai {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

function isoOuNull(valeur: Date | string | null | undefined): string | null {
  if (!valeur) return null;
  const date = valeur instanceof Date ? valeur : new Date(valeur);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Refus unique et INDISTINCT pour « demande inconnue » et « secret invalide ».
 *
 * Deux refus différents transformeraient l'endpoint en oracle : on pourrait
 * énumérer les identifiants d'appareil inscrits sous un jeton donné. Le même
 * 404 dans les deux cas ne dit rien.
 */
export function refusReclamationEssai(): ReponseStatutEssai {
  return {
    ok: false,
    status: 404,
    body: {
      error: "errors.free_trial.request_not_found",
      code: CODES_ESSAI.REQUEST_NOT_FOUND,
      message: "Aucune demande d’essai ne correspond à cet appareil.",
    },
  };
}

/**
 * LE point de contrôle de l'étape 2 → 5.
 *
 * Construit la réponse de « ↻ Vérifier le statut » pour UN appareil précis.
 * Trois issues seulement :
 *   • demande absente ou secret invalide  → 404 indistinct
 *   • demande en attente ou refusée       → statut nu, RIEN d'autre
 *   • demande déployée + secret valide    → statut + jeton de compte appareil
 *
 * Le jeton de compte (`SXB-USER-…`) n'est PAS une configuration : il permet à
 * l'application de lancer l'activation mobile standard, laquelle refera
 * elle-même tous les contrôles d'appareil. Aucun serveur, quota, date ni
 * fichier de configuration ne transite par cette réponse ; ils arrivent
 * ensuite par le canal VPN normal, déjà éprouvé.
 */
export function vueStatutEssaiPourAppareil(params: {
  demande: DemandeEssai | null | undefined;
  deviceId: string;
  claimSecret: string;
  /** Jeton de compte appareil, chargé par la route UNIQUEMENT si déployée. */
  accountToken?: string | null;
  /** Rappel de l'intervalle de vérification automatique côté application. */
  pollIntervalSeconds?: number;
}): ReponseStatutEssai {
  const { demande, deviceId, claimSecret, accountToken, pollIntervalSeconds } = params;

  // 1. L'appareil doit être CELUI de la demande. Un identifiant d'appareil
  //    différent ne consulte jamais la ligne d'un autre, quel que soit le
  //    jeton présenté.
  if (!demande || !deviceId || demande.deviceId !== deviceId) return refusReclamationEssai();

  // 2. Le secret de réclamation prouve que l'appelant est bien l'appareil qui
  //    s'est inscrit — et pas un tiers qui connaît le jeton et l'identifiant.
  if (!secretCorrespond(claimSecret, demande.claimSecretHash)) return refusReclamationEssai();

  const base = {
    requestId: demande.id,
    name: demande.name,
    device: demande.deviceId,
    submittedAt: isoOuNull(demande.createdAt),
    ...(pollIntervalSeconds ? { pollIntervalSeconds } : {}),
  };

  if (demande.status === STATUT_DEMANDE.DEPLOYED) {
    // Un déploiement sans jeton de compte utilisable est une incohérence
    // interne : on répond « toujours en attente » plutôt que de laisser
    // l'application dans un état approuvé mais inutilisable.
    if (!accountToken) {
      return {
        ok: true,
        status: 200,
        body: verifierAucuneFuite({ ...base, status: STATUT_DEMANDE.PENDING, message: "free_trial.status.pending" }),
      };
    }
    return {
      ok: true,
      status: 200,
      body: verifierAucuneFuite({
        ...base,
        status: STATUT_DEMANDE.DEPLOYED,
        message: "free_trial.status.deployed",
        // Seul élément « sensible » de la réponse, remis exclusivement à
        // l'appareil authentifié par son secret de réclamation.
        accountToken,
        reloadRequired: true,
      }),
    };
  }

  if (demande.status === STATUT_DEMANDE.REJECTED) {
    return {
      ok: true,
      status: 200,
      body: verifierAucuneFuite({ ...base, status: STATUT_DEMANDE.REJECTED, message: "free_trial.status.rejected" }),
    };
  }

  // Vérification trop tôt : « Toujours en attente », et strictement rien
  // d'autre. Pas de serveur, pas de quota, pas de date, pas de configuration,
  // pas même l'indication qu'un déploiement serait en préparation.
  return {
    ok: true,
    status: 200,
    body: verifierAucuneFuite({ ...base, status: STATUT_DEMANDE.PENDING, message: "free_trial.status.pending" }),
  };
}

/** Réponse d'inscription (étape 2). Contient le secret, remis UNE SEULE fois. */
export function vueInscriptionEssai(params: {
  demande: DemandeEssai;
  claimSecret: string;
  pollIntervalSeconds?: number;
}): Record<string, unknown> {
  const { demande, claimSecret, pollIntervalSeconds } = params;
  return verifierAucuneFuite({
    success: true,
    requestId: demande.id,
    name: demande.name,
    device: demande.deviceId,
    // Toute inscription part EN ATTENTE, sans exception : rien n'est déployé
    // sur l'appareil à ce stade.
    status: STATUT_DEMANDE.PENDING,
    message: "free_trial.status.submitted",
    claimSecret,
    submittedAt: isoOuNull(demande.createdAt),
    ...(pollIntervalSeconds ? { pollIntervalSeconds } : {}),
  });
}

/**
 * Vue administrateur : « Nom | Identifiant d'appareil | Jeton | Statut |
 * Action ». Le tableau de bord est une surface authentifiée et habilitée ;
 * elle voit l'instruction du dossier, jamais le secret de réclamation.
 */
export function vueDemandePourAdmin(demande: DemandeEssai & { trialToken?: { token?: string; label?: string | null } }) {
  return {
    id: demande.id,
    name: demande.name,
    deviceId: demande.deviceId,
    trialToken: demande.trialToken?.token ?? null,
    trialLabel: demande.trialToken?.label ?? null,
    platform: (demande.platform as string | null) ?? null,
    appVersion: (demande.appVersion as string | null) ?? null,
    status: demande.status,
    clientId: demande.clientId ?? null,
    subscriptionId: demande.subscriptionId ?? null,
    submittedAt: isoOuNull(demande.createdAt),
    deployedAt: isoOuNull(demande.deployedAt),
    rejectedAt: isoOuNull(demande.rejectedAt),
    lastCheckedAt: isoOuNull(demande.lastCheckedAt as Date | string | null),
    reviewNote: (demande.reviewNote as string | null) ?? null,
  };
}

/** Vue administrateur d'un jeton d'invitation — sans aucun champ technique. */
export function vueJetonPourAdmin(jeton: JetonEssai & { label?: string | null; createdAt?: Date | string | null; requestCount?: number }) {
  return {
    id: jeton.id,
    token: jeton.token,
    label: jeton.label ?? null,
    maxUses: jeton.maxUses ?? null,
    usedCount: Number(jeton.usedCount ?? 0),
    status: jeton.status ?? STATUT_JETON.ACTIVE,
    expiresAt: isoOuNull(jeton.expiresAt),
    createdAt: isoOuNull(jeton.createdAt),
    state: etatJetonEssai(jeton),
    requestCount: Number(jeton.requestCount ?? 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Étape 3 — fenêtre d'accès choisie par l'admin APRÈS sélection
// ─────────────────────────────────────────────────────────────────────────────

export interface FenetreEssai {
  startAt: Date;
  expireAt: Date;
  durationDays: number;
}

/**
 * Valide la fenêtre « date de début / date d'expiration » (heures comprises)
 * et en déduit la durée en jours attendue par le modèle `Subscription`.
 *
 * `durationDays` est arrondi À LA HAUSSE : une fenêtre de 36 heures vaut 2
 * jours de forfait, jamais 1 — le forfait ne doit pas se fermer avant la date
 * d'expiration annoncée à l'utilisateur.
 */
export function calculerFenetreEssai(params: {
  startAt?: Date | string | null;
  expireAt: Date | string;
  maintenant?: Date;
}): { ok: boolean; fenetre?: FenetreEssai; refus?: { status: number; body: Record<string, unknown> } } {
  const maintenant = params.maintenant ?? new Date();
  const debut = params.startAt ? new Date(params.startAt) : maintenant;
  const fin = new Date(params.expireAt);
  const invalide = (message: string) => ({
    ok: false,
    refus: {
      status: 400,
      body: { error: "errors.free_trial.window_invalid", code: CODES_ESSAI.WINDOW_INVALID, message },
    },
  });

  if (Number.isNaN(debut.getTime())) return invalide("Date de début invalide.");
  if (Number.isNaN(fin.getTime())) return invalide("Date d’expiration invalide.");
  if (fin.getTime() <= debut.getTime()) {
    return invalide("La date d’expiration doit être postérieure à la date de début.");
  }
  if (fin.getTime() <= maintenant.getTime()) {
    return invalide("La date d’expiration doit être dans le futur.");
  }

  const durationDays = Math.max(1, Math.ceil((fin.getTime() - debut.getTime()) / 86_400_000));
  return { ok: true, fenetre: { startAt: debut, expireAt: fin, durationDays } };
}

/**
 * Une demande n'est déployable qu'une fois, et seulement depuis « en
 * attente » : re-déployer une demande déjà servie créerait un second forfait
 * sur le même appareil.
 */
export function refusDeploiement(demande: DemandeEssai | null | undefined): { status: number; body: Record<string, unknown> } | null {
  if (!demande) {
    return {
      status: 404,
      body: {
        error: "errors.free_trial.request_not_found",
        code: CODES_ESSAI.REQUEST_NOT_FOUND,
        message: "Demande d’essai introuvable.",
      },
    };
  }
  if (demande.status === STATUT_DEMANDE.DEPLOYED) {
    return {
      status: 409,
      body: {
        error: "errors.free_trial.already_deployed",
        code: CODES_ESSAI.ALREADY_DEPLOYED,
        message: "Cette demande a déjà été déployée.",
      },
    };
  }
  if (demande.status !== STATUT_DEMANDE.PENDING) {
    return {
      status: 409,
      body: {
        error: "errors.free_trial.not_pending",
        code: CODES_ESSAI.NOT_PENDING,
        message: "Seule une demande en attente peut être déployée.",
      },
    };
  }
  return null;
}

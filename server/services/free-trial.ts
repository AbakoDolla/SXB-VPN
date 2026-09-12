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
import { estCodePaysValide, normaliserCodePays } from "./countries";

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
  /** Cet APPAREIL a déjà consommé son unique essai — réinstallation comprise. */
  DEVICE_ALREADY_USED: "FREE_TRIAL_DEVICE_ALREADY_USED",
  /** L'application n'a pas pu produire d'empreinte d'appareil exploitable. */
  FINGERPRINT_REQUIRED: "FREE_TRIAL_FINGERPRINT_REQUIRED",
  /** Pays absent ou hors de la liste ISO 3166-1 alpha-2. */
  COUNTRY_INVALID: "FREE_TRIAL_COUNTRY_INVALID",
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
// Empreinte d'appareil — UN SEUL essai, même après désinstallation
// ─────────────────────────────────────────────────────────────────────────────
//
// LE DÉFAUT CORRIGÉ ICI : l'identifiant d'appareil habituel (`@sxb_device_id`)
// est un aléa écrit dans le stockage de l'application. Désinstaller efface ce
// stockage ; l'application se réinstalle avec un identifiant NEUF, et un second
// essai gratuit devenait possible indéfiniment.
//
// L'application transmet donc, à l'inscription seulement, une empreinte
// SÉPARÉE qui survit à une réinstallation (sur Android :
// `Settings.Secure.ANDROID_ID`, remis à zéro uniquement par une
// réinitialisation d'usine). L'identifiant d'appareil historique n'est ni
// modifié ni remplacé : les appareils déjà activés en production gardent
// exactement le leur.
//
// CE QUI EST STOCKÉ : un condensat SHA-256 salé, et rien d'autre. La valeur
// brute ne touche ni la base, ni un journal, ni une réponse d'API. Le sel
// serveur empêche de reconstituer la table des empreintes possibles par
// simple force brute, l'espace des ANDROID_ID étant trop petit pour résister
// à un SHA-256 non salé.

/**
 * Sel serveur. `FREE_TRIAL_FINGERPRINT_SALT` s'il est fourni, sinon la clé de
 * chiffrement déjà en place — un secret d'exploitation, pas une valeur
 * publique. Le repli final n'existe que pour les environnements de test ; il
 * n'affaiblit rien en production où `ENCRYPTION_KEY` est toujours défini.
 *
 * Conséquence à connaître : changer ce sel remet TOUS les compteurs d'essai à
 * zéro, puisque les condensats déjà stockés ne correspondront plus.
 */
function selEmpreinte(): string {
  return (
    process.env.FREE_TRIAL_FINGERPRINT_SALT ||
    process.env.ENCRYPTION_KEY ||
    "sxb-free-trial-fingerprint-salt"
  );
}

/** Longueur minimale exigée : un « 0 » ou un « null » stringifié ne passe pas. */
const LONGUEUR_MIN_EMPREINTE = 8;

/**
 * Valeurs qu'Android renvoie quand il n'a rien de fiable à donner. Les laisser
 * passer reviendrait à donner la MÊME empreinte à tous les appareils concernés,
 * donc à refuser l'essai à tout le monde après le premier.
 */
const EMPREINTES_INEXPLOITABLES = new Set([
  "null", "undefined", "unknown", "0", "9774d56d682e549c",
]);

/** Vrai si l'application a fourni une empreinte réellement exploitable. */
export function empreinteExploitable(brut: unknown): boolean {
  if (typeof brut !== "string") return false;
  const propre = brut.trim().toLowerCase();
  if (propre.length < LONGUEUR_MIN_EMPREINTE || propre.length > 255) return false;
  if (EMPREINTES_INEXPLOITABLES.has(propre)) return false;
  // Une empreinte entièrement composée du même caractère (« 0000000000 ») est
  // un remplissage, pas une identité.
  return !/^(.)\1*$/.test(propre);
}

/**
 * Condensat salé de l'empreinte. Renvoie null si l'empreinte est inexploitable :
 * l'appelant doit alors REFUSER l'inscription plutôt que d'accorder un essai
 * que plus rien ne rattacherait à un appareil.
 */
export function hacherEmpreinteAppareil(brut: unknown, sel = selEmpreinte()): string | null {
  if (!empreinteExploitable(brut)) return null;
  return crypto
    .createHmac("sha256", sel)
    .update(String(brut).trim().toLowerCase(), "utf8")
    .digest("hex");
}

/** Refus quand l'application n'a pas su produire d'empreinte. */
export function refusEmpreinteManquante(): { status: number; body: Record<string, unknown> } {
  return {
    status: 400,
    body: {
      error: "errors.free_trial.fingerprint_required",
      code: CODES_ESSAI.FINGERPRINT_REQUIRED,
      message: "Cet appareil n’a pas pu être identifié de façon fiable.",
    },
  };
}

/**
 * Refus quand l'appareil a DÉJÀ consommé son essai.
 *
 * Le corps ne contient ni nom, ni pays, ni date, ni identifiant de demande, ni
 * jeton : il dit seulement « cet appareil a déjà eu son essai ». Quelqu'un qui
 * rachèterait un téléphone d'occasion ne doit rien apprendre de son ancien
 * propriétaire, et un curieux ne doit pas pouvoir sonder l'historique d'un
 * appareil qui n'est pas le sien.
 */
export function refusEssaiDejaConsomme(): { status: number; body: Record<string, unknown> } {
  return {
    status: 409,
    body: {
      error: "errors.free_trial.device_already_used",
      code: CODES_ESSAI.DEVICE_ALREADY_USED,
      message: "Un essai gratuit a déjà été utilisé sur cet appareil.",
    },
  };
}

/** Refus quand le pays est absent ou hors de la liste ISO fermée. */
export function refusPaysInvalide(): { status: number; body: Record<string, unknown> } {
  return {
    status: 400,
    body: {
      error: "errors.free_trial.country_invalid",
      code: CODES_ESSAI.COUNTRY_INVALID,
      message: "Veuillez choisir votre pays dans la liste.",
    },
  };
}

/**
 * Statuts qui CONSOMMENT définitivement l'unique essai d'un appareil.
 *
 * Seul « déployé » consomme : l'essai a réellement été accordé, qu'il soit
 * encore en cours ou déjà terminé — c'est exactement la règle du propriétaire
 * (« quand l'essai est fini, il n'y en a plus une deuxième fois »).
 *
 * « refusé » ne consomme PAS : la personne n'a jamais reçu d'accès, lui fermer
 * la porte à vie serait une punition, pas une protection. « en attente » ne
 * consomme pas non plus — la demande est simplement retrouvée.
 */
export const STATUTS_ESSAI_CONSOMME: readonly string[] = [STATUT_DEMANDE.DEPLOYED];

/** Issue du contrôle d'empreinte, avant toute écriture. */
export type DecisionEmpreinte =
  | { type: "autorise" }
  | { type: "refuse"; refus: { status: number; body: Record<string, unknown> } }
  | { type: "reprise"; demande: DemandeEssai };

/**
 * LE contrôle « un seul essai par appareil, réinstallation comprise ».
 *
 * Entrée : toutes les demandes portant la MÊME empreinte, quel que soit leur
 * jeton et quel que soit leur identifiant d'appareil — c'est précisément ce
 * qui rend le contrôle insensible à une réinstallation, qui change l'un et
 * permet de présenter l'autre.
 *
 * Fonction PURE : aucune base, aucune horloge, aucun aléa. La route se contente
 * de charger les lignes et d'appliquer la décision.
 */
export function deciderInscriptionParEmpreinte(
  demandes: ReadonlyArray<DemandeEssai | null | undefined>,
): DecisionEmpreinte {
  const connues = demandes.filter((demande): demande is DemandeEssai => Boolean(demande));
  if (connues.some((demande) => STATUTS_ESSAI_CONSOMME.includes(String(demande.status)))) {
    return { type: "refuse", refus: refusEssaiDejaConsomme() };
  }
  // Plusieurs demandes en attente ne devraient pas coexister ; si cela arrive,
  // on retient la plus récente plutôt que d'en créer une de plus.
  const enAttente = connues
    .filter((demande) => demande.status === STATUT_DEMANDE.PENDING)
    .sort((a, b) => horodatage(b.createdAt) - horodatage(a.createdAt));
  if (enAttente.length) return { type: "reprise", demande: enAttente[0] };
  return { type: "autorise" };
}

function horodatage(valeur: Date | string | null | undefined): number {
  if (!valeur) return 0;
  const date = valeur instanceof Date ? valeur : new Date(valeur);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
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
  // L'empreinte d'appareil est un secret d'exploitation : elle ne sort jamais,
  // même hachée. La renvoyer permettrait de tester hors ligne si un appareil
  // donné a déjà consommé son essai.
  "deviceFingerprint", "fingerprint", "androidId",
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
  /** Pays DÉCLARÉ (ISO 3166-1 alpha-2). Absent sur les demandes historiques. */
  country?: string | null;
  /** Condensat de l'empreinte. Jamais renvoyé, jamais journalisé. */
  deviceFingerprint?: string | null;
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
    // Le pays est renvoyé tel qu'il a été ENREGISTRÉ : l'application affiche
    // ainsi ce que l'exploitation voit, sans écart possible entre les deux.
    country: normaliserCodePays(demande.country) || null,
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
 * Vue administrateur : « Nom | Pays | Identifiant d'appareil | Jeton | Statut |
 * Action ». Le tableau de bord est une surface authentifiée et habilitée ;
 * elle voit l'instruction du dossier, jamais le secret de réclamation ni
 * l'empreinte d'appareil.
 */
export function vueDemandePourAdmin(demande: DemandeEssai & { trialToken?: { token?: string; label?: string | null } }) {
  return {
    id: demande.id,
    name: demande.name,
    deviceId: demande.deviceId,
    // Pays SAISI par l'inscrit : « d'où viennent nos clients ». Jamais déduit
    // d'une adresse IP ni d'une position — une déclaration, pas une mesure.
    country: normaliserCodePays(demande.country) || null,
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

// ─────────────────────────────────────────────────────────────────────────────
// Statistiques par pays — « savoir d'où viennent nos clients »
// ─────────────────────────────────────────────────────────────────────────────

/** Une ligne du récapitulatif par pays. */
export interface StatistiquePays {
  /** Code ISO, ou null pour les demandes déposées avant l'ajout du champ. */
  country: string | null;
  /** Demandes reçues depuis ce pays, tous statuts confondus. */
  requests: number;
  /** Demandes encore en attente d'instruction. */
  pending: number;
  /** Demandes refusées. */
  rejected: number;
  /**
   * Clients issus d'un essai déployé depuis ce pays. Comptés par CLIENT
   * distinct : deux demandes déployées sur le même compte ne font pas deux
   * clients, sinon le tableau de bord surévaluerait la base installée.
   */
  clients: number;
}

/**
 * Agrège les demandes par pays, du plus gros volume au plus petit.
 *
 * Fonction PURE : la route charge les lignes, cette fonction décide. Le tri est
 * TOTAL (clients, puis demandes, puis code) pour que deux appels sur les mêmes
 * données rendent toujours le même ordre — un tableau de bord qui se réordonne
 * tout seul entre deux rafraîchissements est illisible.
 */
export function statistiquesParPays(
  demandes: ReadonlyArray<{ country?: string | null; status?: string | null; clientId?: string | null }>,
): StatistiquePays[] {
  const parPays = new Map<string, { ligne: StatistiquePays; clients: Set<string> }>();
  for (const demande of demandes) {
    const code = normaliserCodePays(demande?.country) || "";
    const cle = estCodePaysValide(code) ? code : "";
    let entree = parPays.get(cle);
    if (!entree) {
      entree = {
        ligne: { country: cle || null, requests: 0, pending: 0, rejected: 0, clients: 0 },
        clients: new Set<string>(),
      };
      parPays.set(cle, entree);
    }
    entree.ligne.requests += 1;
    if (demande?.status === STATUT_DEMANDE.PENDING) entree.ligne.pending += 1;
    if (demande?.status === STATUT_DEMANDE.REJECTED) entree.ligne.rejected += 1;
    if (demande?.status === STATUT_DEMANDE.DEPLOYED && demande.clientId) {
      entree.clients.add(String(demande.clientId));
    }
  }
  return [...parPays.values()]
    .map(({ ligne, clients }) => ({ ...ligne, clients: clients.size }))
    .sort((a, b) =>
      b.clients - a.clients ||
      b.requests - a.requests ||
      (a.country ?? "ZZZZ").localeCompare(b.country ?? "ZZZZ"));
}

/** Totaux du récapitulatif, pour l'en-tête du tableau de bord. */
export function totauxParPays(lignes: ReadonlyArray<StatistiquePays>) {
  return {
    countries: lignes.filter((ligne) => ligne.country !== null).length,
    requests: lignes.reduce((somme, ligne) => somme + ligne.requests, 0),
    clients: lignes.reduce((somme, ligne) => somme + ligne.clients, 0),
    pending: lignes.reduce((somme, ligne) => somme + ligne.pending, 0),
    rejected: lignes.reduce((somme, ligne) => somme + ligne.rejected, 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tableau de bord PROPRE aux essais — jamais mélangé aux comptes principaux
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Un accès d'essai est-il encore ouvert ?
 *
 * « Déployé » est un fait d'HISTOIRE : la demande a été instruite, elle le
 * reste pour toujours. « Actif » est un fait de MAINTENANT : le forfait existe,
 * n'a pas été suspendu ou révoqué, son échéance n'est pas passée et son volume
 * n'est pas épuisé. Les deux chiffres doivent coexister, sinon le propriétaire
 * lit « 40 déployés » et croit avoir 40 personnes sous essai alors que 35 sont
 * terminées.
 *
 * Un forfait absent (supprimé depuis) n'est PAS actif : on ne suppose jamais
 * l'existence d'un accès qu'on ne peut plus lire.
 *
 * LIMITE ASSUMÉE : la décision porte sur le FORFAIT. Un compte suspendu par
 * ailleurs reste compté actif tant que son forfait d'essai l'est ; l'écran des
 * comptes VPN reste la source de vérité sur l'état d'un compte.
 */
export function estEssaiActif(
  forfait: {
    status?: string | null;
    expireAt?: Date | string | null;
    quotaBytes?: bigint | number | string | null;
    quotaUsed?: bigint | number | string | null;
  } | null | undefined,
  maintenant = new Date(),
): boolean {
  if (!forfait) return false;
  if (String(forfait.status ?? "active").toLowerCase() !== "active") return false;
  if (forfait.expireAt !== null && forfait.expireAt !== undefined) {
    const fin = new Date(forfait.expireAt as any).getTime();
    if (Number.isFinite(fin) && fin <= maintenant.getTime()) return false;
  }
  // Quota épuisé : l'accès existe encore sur le papier, mais il ne transporte
  // plus rien. Le compter « actif » gonflerait le chiffre d'essais en cours.
  const total = versEntier(forfait.quotaBytes);
  const consomme = versEntier(forfait.quotaUsed);
  if (total !== null && total > BigInt(0) && consomme !== null && consomme >= total) return false;
  return true;
}

function versEntier(valeur: bigint | number | string | null | undefined): bigint | null {
  if (valeur === null || valeur === undefined) return null;
  try {
    return typeof valeur === "bigint" ? valeur : BigInt(Math.trunc(Number(valeur)));
  } catch {
    return null;
  }
}

/** Ce que la plateforme a pu mesurer de la présence, et ce qu'elle n'a pas pu. */
export interface MesurePresenceEssai {
  /** false quand la présence n'a PAS pu être calculée — jamais un zéro trompeur. */
  measured: boolean;
  /** Pourquoi la mesure manque, quand elle manque. */
  reason: string | null;
  windowMinutes: number;
  heartbeatMinutes: number;
  /**
   * true quand la lecture des signaux a été bornée : au-delà du plafond de la
   * mesure de présence, un essai connecté peut se trouver hors de la tranche
   * lue. Le compteur reste alors un minimum — ce qu'il est déjà par nature.
   */
  truncated?: boolean;
}

/** Indicateurs de la section « Essai gratuit », et d'elle seule. */
export interface ResumeEssais {
  /** Inscrits, tous statuts confondus. */
  total: number;
  pending: number;
  deployed: number;
  rejected: number;
  /** Essais déployés dont l'accès est encore ouvert aujourd'hui. */
  active: number;
  /**
   * Comptes dont l'essai est ENCORE OUVERT et qui sont vus en ligne dans la
   * fenêtre de présence. `null` quand la présence n'a pas pu être mesurée :
   * zéro voudrait dire « personne », ce qui serait un mensonge.
   */
  connectedNow: number | null;
  presence: MesurePresenceEssai;
}

/**
 * Résume les essais — fonction PURE, la route ne fait que charger les lignes.
 *
 * Les compteurs de cette section ne partagent AUCUNE source avec ceux des
 * comptes principaux : ils dérivent tous des demandes d'essai, et rien d'autre.
 *
 * `connectedNow` compte des COMPTES distincts dont l'essai est ENCORE OUVERT.
 * Deux appareils d'un même compte ne font pas deux personnes connectées, et un
 * ancien essayeur devenu client payant n'est plus un essai : le compter ici
 * gonflerait la section d'essai avec du parc principal, ce que le propriétaire
 * veut précisément éviter.
 */
export function resumerEssais(params: {
  demandes: ReadonlyArray<{ status?: string | null; clientId?: string | null; subscriptionId?: string | null }>;
  /** Forfaits nés d'un essai, indexés par identifiant. Absent = accès introuvable. */
  forfaits?: ReadonlyMap<string, {
    status?: string | null;
    expireAt?: Date | string | null;
    quotaBytes?: bigint | number | string | null;
    quotaUsed?: bigint | number | string | null;
  }> | null;
  /** Comptes actuellement connectés, tous parcs confondus. */
  clientsConnectes?: ReadonlySet<string> | null;
  presence: MesurePresenceEssai;
  maintenant?: Date;
}): ResumeEssais {
  const maintenant = params.maintenant ?? new Date();
  const forfaits = params.forfaits ?? new Map();
  let pending = 0;
  let deployed = 0;
  let rejected = 0;
  let active = 0;
  const comptesEnEssai = new Set<string>();

  for (const demande of params.demandes) {
    if (demande?.status === STATUT_DEMANDE.PENDING) pending += 1;
    else if (demande?.status === STATUT_DEMANDE.REJECTED) rejected += 1;
    else if (demande?.status === STATUT_DEMANDE.DEPLOYED) {
      deployed += 1;
      if (demande.subscriptionId && estEssaiActif(forfaits.get(String(demande.subscriptionId)), maintenant)) {
        active += 1;
        if (demande.clientId) comptesEnEssai.add(String(demande.clientId));
      }
    }
  }

  let connectedNow: number | null = null;
  if (params.presence.measured && params.clientsConnectes) {
    let vus = 0;
    for (const clientId of comptesEnEssai) if (params.clientsConnectes.has(clientId)) vus += 1;
    connectedNow = vus;
  }

  return {
    total: params.demandes.length,
    pending,
    deployed,
    rejected,
    active,
    connectedNow,
    presence: params.presence,
  };
}

/**
 * Mention « période d'essai » attachée à un client.
 *
 * C'est ce que le tableau de bord affiche sur un appareil ou un client dont
 * l'accès provient d'un essai gratuit — y compris chez un REVENDEUR, qui voit
 * la mention et le pays de SES clients, mais jamais les demandes, jetons ou
 * statistiques globales (le cloisonnement se fait à la requête, pas ici).
 */
export interface MarqueEssai {
  trial: true;
  country: string | null;
  trialEndsAt: string | null;
  trialStartedAt: string | null;
}

/** Construit la mention depuis une demande déployée et sa fenêtre d'accès. */
export function marqueEssaiPourClient(params: {
  demande: { country?: string | null; deployedAt?: Date | string | null } | null | undefined;
  expireAt?: Date | string | null;
}): MarqueEssai | null {
  if (!params.demande) return null;
  return {
    trial: true,
    country: normaliserCodePays(params.demande.country) || null,
    trialEndsAt: isoOuNull(params.expireAt ?? null),
    trialStartedAt: isoOuNull(params.demande.deployedAt ?? null),
  };
}

/** Vue administrateur d'un jeton d'invitation — sans aucun champ technique. */
export function vueJetonPourAdmin(jeton: JetonEssai & {
  label?: string | null;
  createdAt?: Date | string | null;
  requestCount?: number;
  pendingCount?: number;
  deployedCount?: number;
  rejectedCount?: number;
}) {
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
    // Compteurs par statut : ils permettent d'afficher « 12 en attente ·
    // 3 déployées » sur la ligne du jeton SANS ouvrir le volet, donc sans
    // charger les demandes de tous les jetons pour dessiner la page.
    pendingCount: Number(jeton.pendingCount ?? 0),
    deployedCount: Number(jeton.deployedCount ?? 0),
    rejectedCount: Number(jeton.rejectedCount ?? 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lots de déploiement — mêmes règles que les forfaits groupés
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Taille maximale d'un lot de déploiement.
 *
 * Même borne que `MAX_BULK_APPLY` pour les forfaits : au-delà, une seule
 * requête tiendrait la base ouverte trop longtemps et un échec en milieu de
 * parcours deviendrait illisible. La borne est explicite côté utilisateur,
 * jamais une troncature silencieuse de la sélection.
 */
export const MAX_LOT_ESSAI = 200;

export const RAISONS_LOT_ESSAI = {
  LOT_VIDE: "errors.free_trial.batch_empty",
  LOT_TROP_GRAND: "errors.free_trial.batch_too_large",
  /** La demande ne relève pas du jeton sous lequel l'action a été lancée. */
  TOKEN_MISMATCH: "FREE_TRIAL_TOKEN_MISMATCH",
} as const;

/**
 * Normalise un lot d'identifiants : doublons retirés, ordre conservé, bornes
 * appliquées. Fonction PURE, donc testable sans base.
 *
 * Les doublons ne sont pas une coquetterie : deux fois le même identifiant
 * dans un lot signifierait deux déploiements sur la même demande.
 */
export function normaliserLotEssai(
  identifiants: ReadonlyArray<unknown>,
  maximum = MAX_LOT_ESSAI,
): { ok: true; ids: string[] } | { ok: false; raison: string; limite: number } {
  const uniques: string[] = [];
  for (const brut of identifiants ?? []) {
    if (typeof brut !== "string") continue;
    const propre = brut.trim();
    if (propre && !uniques.includes(propre)) uniques.push(propre);
  }
  if (!uniques.length) return { ok: false, raison: RAISONS_LOT_ESSAI.LOT_VIDE, limite: maximum };
  if (uniques.length > maximum) return { ok: false, raison: RAISONS_LOT_ESSAI.LOT_TROP_GRAND, limite: maximum };
  return { ok: true, ids: uniques };
}

/** Refus explicite d'un lot hors bornes — jamais une troncature muette. */
export function refusLotEssai(raison: string, limite: number): { status: number; body: Record<string, unknown> } {
  return {
    status: 400,
    body: {
      error: raison,
      code: raison === RAISONS_LOT_ESSAI.LOT_TROP_GRAND ? "FREE_TRIAL_BATCH_TOO_LARGE" : "FREE_TRIAL_BATCH_EMPTY",
      message: raison === RAISONS_LOT_ESSAI.LOT_TROP_GRAND
        ? `Un lot ne peut pas dépasser ${limite} inscrits.`
        : "Sélectionnez au moins un inscrit.",
      limit: limite,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Plusieurs configurations pour plusieurs inscrits
// ─────────────────────────────────────────────────────────────────────────────
//
// Un inscrit peut recevoir PLUSIEURS configurations VPN d'un seul geste,
// exactement comme un client principal peut détenir plusieurs forfaits. Le
// déploiement crée alors un forfait par couple (inscrit, configuration).
//
// C'est un PRODUIT, et un produit se borne : 200 inscrits × 10 configurations
// feraient 2 000 forfaits d'un clic. Deux bornes le contiennent, toutes deux
// annoncées à l'interface plutôt que devinées.

/** Nombre maximal de configurations VPN retenues pour un même déploiement. */
export const MAX_CONFIGS_ESSAI = 10;

/**
 * Nombre maximal de forfaits qu'UN déploiement peut créer.
 *
 * Le lot est écrit demande par demande, configuration par configuration,
 * chacune avec ses propres contrôles : sans cette borne, une sélection large
 * tiendrait la connexion ouverte assez longtemps pour être coupée, et
 * l'exploitant se retrouverait sans compte rendu.
 */
export const MAX_FORFAITS_ESSAI = 400;

export const RAISONS_CONFIGS_ESSAI = {
  AUCUNE_CONFIG: "errors.free_trial.no_profile",
  TROP_DE_CONFIGS: "errors.free_trial.too_many_profiles",
  TROP_DE_FORFAITS: "errors.free_trial.too_many_subscriptions",
} as const;

/**
 * Normalise la liste des configurations choisies : doublons retirés, ordre
 * conservé, borne appliquée.
 *
 * Le dédoublonnage évite qu'un même serveur sélectionné deux fois fabrique
 * deux forfaits identiques au même inscrit.
 */
export function normaliserConfigsEssai(
  identifiants: ReadonlyArray<unknown>,
  maximum = MAX_CONFIGS_ESSAI,
): { ok: true; ids: string[] } | { ok: false; raison: string; limite: number } {
  const uniques: string[] = [];
  for (const brut of identifiants ?? []) {
    if (typeof brut !== "string") continue;
    const propre = brut.trim();
    if (propre && !uniques.includes(propre)) uniques.push(propre);
  }
  if (!uniques.length) return { ok: false, raison: RAISONS_CONFIGS_ESSAI.AUCUNE_CONFIG, limite: maximum };
  if (uniques.length > maximum) return { ok: false, raison: RAISONS_CONFIGS_ESSAI.TROP_DE_CONFIGS, limite: maximum };
  return { ok: true, ids: uniques };
}

/**
 * Combien de forfaits ce déploiement créerait — et le refus motivé si c'est
 * trop. Le chiffre est rendu tel quel pour que l'interface l'annonce AVANT la
 * confirmation : « 12 inscrits × 3 serveurs = 36 forfaits ».
 */
export function verifierProduitEssai(
  demandes: number,
  configurations: number,
  maximum = MAX_FORFAITS_ESSAI,
): { ok: true; total: number } | { ok: false; total: number; refus: { status: number; body: Record<string, unknown> } } {
  const total = demandes * configurations;
  if (total > maximum) {
    return {
      ok: false,
      total,
      refus: {
        status: 400,
        body: {
          error: RAISONS_CONFIGS_ESSAI.TROP_DE_FORFAITS,
          code: "FREE_TRIAL_TOO_MANY_SUBSCRIPTIONS",
          message: `Ce déploiement créerait ${total} forfaits ; la limite est de ${maximum} par opération.`,
          limit: maximum,
          projected: total,
        },
      },
    };
  }
  return { ok: true, total };
}

/** Refus motivé d'une sélection de configurations hors bornes. */
export function refusConfigsEssai(raison: string, limite: number): { status: number; body: Record<string, unknown> } {
  return {
    status: 400,
    body: {
      error: raison,
      code: raison === RAISONS_CONFIGS_ESSAI.TROP_DE_CONFIGS ? "FREE_TRIAL_TOO_MANY_PROFILES" : "FREE_TRIAL_NO_PROFILE",
      message: raison === RAISONS_CONFIGS_ESSAI.TROP_DE_CONFIGS
        ? `Un déploiement ne peut pas retenir plus de ${limite} configurations.`
        : "Choisissez au moins une configuration VPN.",
      limit: limite,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Accès courant d'un essai déployé
// ─────────────────────────────────────────────────────────────────────────────
//
// TOUT se gère dans la section « Essais gratuits » : pour agir sur un essai
// déjà déployé, l'exploitant doit d'abord VOIR ce qu'il a. Ces vues ne sont
// jamais renvoyées à l'application mobile — elles n'existent que pour l'écran
// d'administration, comme `vueDemandePourAdmin`.

/** Un forfait d'essai, tel que la section Essais l'affiche. */
export interface ForfaitEssaiVue {
  id: string;
  name: string;
  profileId: string | null;
  profileName: string | null;
  status: string;
  /** Volume accordé, en octets, `"0"` pour un accès sans plafond. */
  quotaBytes: string;
  /** Volume CONSOMMÉ, en octets : c'est ce que le propriétaire veut voir. */
  quotaUsed: string;
  deviceLimit: number | null;
  startAt: string | null;
  expireAt: string | null;
}

/** L'accès complet d'une demande déployée. */
export interface AccesEssaiVue {
  subscriptions: ForfaitEssaiVue[];
  /** Total accordé et total consommé sur l'ensemble des forfaits d'essai. */
  quotaBytes: string;
  quotaUsed: string;
  /** Échéance la plus lointaine : jusqu'à quand l'essai reste ouvert. */
  expireAt: string | null;
  /** Vrai dès qu'un des forfaits transporte encore quelque chose. */
  active: boolean;
}

/**
 * Agrège les forfaits d'un essai en une vue lisible d'un coup d'œil.
 *
 * `active` réutilise `estEssaiActif`, la mesure déjà en place : un second
 * calcul divergerait tôt ou tard de l'indicateur « essais actifs ».
 */
export function vueAccesEssai(
  forfaits: ReadonlyArray<{
    id: string;
    name?: string | null;
    profileId?: string | null;
    profile?: { name?: string | null } | null;
    status?: string | null;
    quotaBytes?: bigint | number | string | null;
    quotaUsed?: bigint | number | string | null;
    deviceLimit?: number | null;
    startAt?: Date | string | null;
    expireAt?: Date | string | null;
  }>,
  maintenant = new Date(),
): AccesEssaiVue {
  let total = BigInt(0);
  let consomme = BigInt(0);
  let echeance: number | null = null;
  let active = false;

  const subscriptions = forfaits.map((forfait) => {
    total += versEntier(forfait.quotaBytes) ?? BigInt(0);
    consomme += versEntier(forfait.quotaUsed) ?? BigInt(0);
    const fin = forfait.expireAt ? new Date(forfait.expireAt as any).getTime() : null;
    if (fin !== null && Number.isFinite(fin) && (echeance === null || fin > echeance)) echeance = fin;
    if (estEssaiActif(forfait, maintenant)) active = true;
    return {
      id: String(forfait.id),
      name: String(forfait.name ?? ""),
      profileId: forfait.profileId ? String(forfait.profileId) : null,
      profileName: forfait.profile?.name ? String(forfait.profile.name) : null,
      status: String(forfait.status ?? "active"),
      quotaBytes: String(versEntier(forfait.quotaBytes) ?? BigInt(0)),
      quotaUsed: String(versEntier(forfait.quotaUsed) ?? BigInt(0)),
      deviceLimit: forfait.deviceLimit ?? null,
      startAt: isoOuNull(forfait.startAt ?? null),
      expireAt: isoOuNull(forfait.expireAt ?? null),
    };
  });

  return {
    subscriptions,
    quotaBytes: String(total),
    quotaUsed: String(consomme),
    expireAt: echeance === null ? null : new Date(echeance).toISOString(),
    active,
  };
}

/**
 * Cohérence jeton ↔ demande.
 *
 * Le tableau de bord agit TOUJOURS dans le contexte d'un jeton ; le serveur ne
 * fait pas confiance à la liste d'identifiants reçue et revérifie, demande par
 * demande, qu'elle relève bien de ce jeton. Sans ce contrôle, un identifiant
 * glissé dans le corps de la requête ferait agir le lot sur la demande d'une
 * autre campagne.
 */
export function demandeAppartientAuJeton(demande: DemandeEssai | null | undefined, tokenId?: string | null): boolean {
  if (!tokenId) return true;
  return Boolean(demande) && String(demande!.tokenId ?? "") === tokenId;
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

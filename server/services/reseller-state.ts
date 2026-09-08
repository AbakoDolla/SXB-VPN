/**
 * État revendeur — calculs purs du cycle de vie d'un revendeur.
 *
 * Aucun import de base ni d'Express : ce module est importable depuis un test
 * unitaire comme depuis une route.
 *
 * Trois notions distinctes, longtemps confondues dans les routes :
 *
 *   1. PROPRIÉTÉ      — quel revendeur possède ce client / cet appareil ?
 *   2. VALIDITÉ       — le revendeur a-t-il encore le droit d'agir ?
 *   3. PLAFOND        — lui reste-t-il du quota à engager ?
 *
 * Chacune répond par un code stable, jamais par un 403 générique : côté mobile
 * comme côté tableau de bord, un refus indistinct était affiché « expiré », ce
 * qui envoyait l'exploitant renouveler un accès parfaitement valide.
 *
 * Les lectures restent accessibles. Au plafond, les actions réductrices
 * restent ouvertes ; à expiration de l'agrément, toutes les écritures ferment.
 */
import { estIllimite } from "./reseller-quota";

export const MESSAGE_ACCES_EXPIRE = "Accès expiré — veuillez renouveler";
export const MESSAGE_ACCES_SUSPENDU = "Accès suspendu — contactez l'administrateur";

/** Codes de refus stables : le client les teste, jamais le message. */
export const CODES_REVENDEUR = {
  ACCOUNT_REQUIRED: "RESELLER_ACCOUNT_REQUIRED",
  EXPIRED: "RESELLER_EXPIRED",
  SUSPENDED: "RESELLER_SUSPENDED",
  QUOTA_REACHED: "RESELLER_QUOTA_REACHED",
  OWNERSHIP_FORBIDDEN: "OWNERSHIP_FORBIDDEN",
  SUPPORT_READ_ONLY: "SUPPORT_READ_ONLY",
} as const;

export type EtatAccesRevendeur = "active" | "expired" | "suspended";
export type EtatQuotaRevendeur = "available" | "reached" | "unlimited";

export type ResumeAccesRevendeur = {
  resellerId: string | null;
  resellerName: string | null;
  accessState: EtatAccesRevendeur;
  accessExpiresAt: string | null;
  quotaState: EtatQuotaRevendeur;
  quotaBytes: string;
  quotaAllocatedBytes: string;
  quotaRemainingBytes: string | null;
  quotaUnlimited: boolean;
};

export type RefusRevendeur = {
  status: number;
  body: {
    error: string;
    code: string;
    message: string;
    resellerAccess?: ResumeAccesRevendeur;
  };
};

/** Rôles autorisés à voir l'identité revendeur et à administrer les fiches. */
export const ROLES_SUPERIEURS = ["OWNER", "SUPER_ADMIN", "ADMIN"] as const;

export function estRoleSuperieur(role: string | undefined | null): boolean {
  return ROLES_SUPERIEURS.includes(String(role) as (typeof ROLES_SUPERIEURS)[number]);
}

/**
 * Comparaison de dates, jamais de chaînes.
 *
 * `expireAt > new Date().toISOString()` — la forme qui traînait dans le code —
 * dépend du fuseau et de la présence du suffixe Z : un horodatage local
 * « 2026-09-07 14:00 » se compare alphabétiquement à « 2026-09-07T13:00:00Z »
 * et sort faux. Un `Date` invalide est traité comme « pas d'échéance » plutôt
 * que comme une échéance dépassée.
 */
export function estDateDepassee(valeur: Date | string | null | undefined, maintenant: Date = new Date()): boolean {
  if (valeur === null || valeur === undefined) return false;
  const date = valeur instanceof Date ? valeur : new Date(valeur);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return false;
  return ms <= maintenant.getTime();
}

/**
 * État d'accès d'une fiche revendeur.
 * `accessExpiresAt` nul = fiche antérieure à la colonne, accès hérité illimité.
 */
export function calculerEtatAcces(fiche: any, maintenant: Date = new Date()): EtatAccesRevendeur {
  if (!fiche) return "suspended";
  if (fiche.user?.status && fiche.user.status !== "active") return "suspended";
  if (fiche.status && fiche.status !== "active") return "suspended";
  if (estDateDepassee(fiche.accessExpiresAt, maintenant)) return "expired";
  return "active";
}

/**
 * État du plafond.
 * Un plafond négatif vaut « illimité » ; **zéro n'est pas illimité** — c'est
 * un revendeur qui n'a encore rien reçu, et donc un plafond déjà atteint.
 */
export function calculerEtatQuota(
  quotaBytes: bigint | number | null | undefined,
  alloueBytes: bigint | number | null | undefined
): EtatQuotaRevendeur {
  const plafond = BigInt(quotaBytes ?? 0);
  if (estIllimite(plafond)) return "unlimited";
  const alloue = BigInt(alloueBytes ?? 0);
  return alloue >= plafond ? "reached" : "available";
}

/** Résumé structuré, tous les BigInt en chaînes pour préserver la précision. */
export function resumerAccesRevendeur(
  fiche: any,
  alloueBytes: bigint | number | null | undefined = null,
  maintenant: Date = new Date()
): ResumeAccesRevendeur {
  const plafond = BigInt(fiche?.quotaBytes ?? 0);
  const alloue = BigInt(alloueBytes ?? fiche?.quotaUsedBytes ?? 0);
  const illimite = estIllimite(plafond);
  const restant = illimite ? null : (plafond - alloue > BigInt(0) ? plafond - alloue : BigInt(0));
  return {
    resellerId: fiche?.id ?? null,
    resellerName: fiche?.user?.name || fiche?.user?.email || fiche?.resellerName || null,
    accessState: calculerEtatAcces(fiche, maintenant),
    accessExpiresAt: fiche?.accessExpiresAt ? new Date(fiche.accessExpiresAt).toISOString() : null,
    quotaState: calculerEtatQuota(plafond, alloue),
    quotaBytes: plafond.toString(),
    quotaAllocatedBytes: alloue.toString(),
    quotaRemainingBytes: restant === null ? null : restant.toString(),
    quotaUnlimited: illimite,
  };
}

/** Refus correspondant à un état d'accès, ou null si l'accès est valide. */
export function refusPourEtatAcces(resume: ResumeAccesRevendeur): RefusRevendeur | null {
  if (resume.accessState === "expired") {
    return {
      status: 403,
      body: {
        error: "errors.resellers.access_expired",
        code: CODES_REVENDEUR.EXPIRED,
        message: MESSAGE_ACCES_EXPIRE,
        resellerAccess: resume,
      },
    };
  }
  if (resume.accessState === "suspended") {
    return {
      status: 403,
      body: {
        error: "errors.resellers.suspended",
        code: CODES_REVENDEUR.SUSPENDED,
        message: MESSAGE_ACCES_SUSPENDU,
        resellerAccess: resume,
      },
    };
  }
  return null;
}

/** Refus quand le plafond est déjà atteint et que l'action l'augmenterait. */
export function refusPourQuotaAtteint(resume: ResumeAccesRevendeur): RefusRevendeur | null {
  if (resume.quotaState !== "reached") return null;
  return {
    status: 409,
    body: {
      error: "errors.resellers.quota_reached",
      code: CODES_REVENDEUR.QUOTA_REACHED,
      message: "Plafond de quota atteint — libérez du volume ou demandez une extension.",
      resellerAccess: resume,
    },
  };
}

export function refusPropriete(): RefusRevendeur {
  return {
    status: 403,
    body: {
      error: "errors.auth.forbidden",
      code: CODES_REVENDEUR.OWNERSHIP_FORBIDDEN,
      message: "Cette ressource appartient à un autre revendeur.",
    },
  };
}

/**
 * Portée de lecture/écriture des clients d'un revendeur.
 *
 * Deux rattachements coexistent volontairement : `resellerId` (explicite,
 * écrit depuis l'ajout de la colonne) et `userId` (implicite, hérité des 84
 * appareils déjà en production). Ignorer le second ferait disparaître le parc
 * historique de l'écran du revendeur ; ignorer le premier empêcherait un
 * revendeur de posséder un client porté par un autre compte utilisateur.
 */
export function porteeClientsRevendeur(fiche: any): Record<string, unknown> {
  const conditions: Record<string, unknown>[] = [];
  if (fiche?.id) conditions.push({ resellerId: fiche.id });
  if (fiche?.userId) conditions.push({ resellerId: null, userId: fiche.userId });
  // Aucun identifiant exploitable : refuser toute portée plutôt que renvoyer
  // un filtre vide, qui exposerait l'intégralité du parc.
  if (conditions.length === 0) return { id: "__aucun__" };
  return { OR: conditions };
}

/**
 * Le revendeur possède-t-il ce client ?
 *
 * `resellerId` fait autorité dès qu'il est renseigné : un client explicitement
 * attribué à un revendeur n'appartient pas à un autre, même si le compte
 * utilisateur porteur coïncide. Sans cette colonne, on retombe sur le
 * rattachement historique par `userId`.
 */
export function possedeClient(client: any, fiche: any): boolean {
  if (!client || !fiche) return false;
  if (client.resellerId) return client.resellerId === fiche.id;
  return !!fiche.userId && client.userId === fiche.userId;
}

/**
 * Étiquette revendeur exposée aux rôles supérieurs.
 * Accepte un client chargé avec `reseller.user`, ou une fiche fournie à part.
 */
export function etiquetteRevendeur(
  client: any,
  fiche?: any
): { resellerId: string | null; resellerName: string | null } {
  const source = client?.reseller ?? fiche ?? null;
  return {
    resellerId: source?.id ?? client?.resellerId ?? null,
    resellerName: source?.user?.name || source?.user?.email || null,
  };
}

/**
 * Accès revendeur — lecture unique des trois notions que le serveur distingue.
 *
 *   1. PROPRIÉTÉ — de quel revendeur relève un client, un appareil, un forfait.
 *   2. VALIDITÉ  — l'agrément est-il encore en cours (`accessState`) ?
 *   3. PLAFOND   — reste-t-il du volume à engager (`quotaState`) ?
 *
 * Les trois étaient jusqu'ici confondues sous un message d'erreur générique :
 * un revendeur au plafond lisait « accès expiré » et allait demander un
 * renouvellement parfaitement inutile. Les codes de refus du serveur sont
 * stables ; ce module les traduit, et lui seul.
 *
 * Règle de fond, identique à celle du serveur : ni l'expiration ni le plafond
 * ne bloquent une LECTURE, ni une action qui RÉDUIT l'exposition (suspendre,
 * révoquer, supprimer, diminuer un volume). Bloquer ces gestes enfermerait
 * l'exploitant avec un parc qu'il ne pourrait plus contenir.
 */
import { ResellerAccessSummary, ResellerAccessState, ResellerQuotaState, UserRole } from "../types";

/** Codes de refus du serveur. On teste le code, jamais le message. */
export const RESELLER_CODES = {
  ACCOUNT_REQUIRED: "RESELLER_ACCOUNT_REQUIRED",
  EXPIRED: "RESELLER_EXPIRED",
  SUSPENDED: "RESELLER_SUSPENDED",
  QUOTA_REACHED: "RESELLER_QUOTA_REACHED",
  OWNERSHIP_FORBIDDEN: "OWNERSHIP_FORBIDDEN",
  SUPPORT_READ_ONLY: "SUPPORT_READ_ONLY",
  RESELLER_ACCESS_REQUIRED: "RESELLER_ACCESS_REQUIRED",
} as const;

export type ResellerCode = (typeof RESELLER_CODES)[keyof typeof RESELLER_CODES];

export const MESSAGE_ACCES_EXPIRE = "Accès expiré — veuillez renouveler";
export const MESSAGE_ACCES_SUSPENDU = "Accès suspendu — contactez l'administrateur";

const MESSAGES: Record<string, string> = {
  [RESELLER_CODES.ACCOUNT_REQUIRED]: "Aucune fiche revendeur n'est associée à ce compte.",
  [RESELLER_CODES.EXPIRED]: MESSAGE_ACCES_EXPIRE,
  [RESELLER_CODES.SUSPENDED]: MESSAGE_ACCES_SUSPENDU,
  [RESELLER_CODES.QUOTA_REACHED]: "Plafond de quota atteint — libérez du volume ou demandez une extension.",
  [RESELLER_CODES.OWNERSHIP_FORBIDDEN]: "Cette ressource appartient à un autre revendeur.",
  [RESELLER_CODES.SUPPORT_READ_ONLY]: "Le rôle SUPPORT est en lecture seule sur ce domaine.",
  [RESELLER_CODES.RESELLER_ACCESS_REQUIRED]: "Une date d'expiration future est requise pour un compte revendeur.",
};

/** Message lisible d'un refus, ou null si le code n'en est pas un. */
export function messageForCode(code: string | null | undefined): string | null {
  if (!code) return null;
  return MESSAGES[code] ?? null;
}

const UNITS = ["o", "Ko", "Mo", "Go", "To", "Po"];

/**
 * Conversion tolérante vers BigInt.
 *
 * Les volumes arrivent en chaînes précisément pour ne PAS passer par Number :
 * `Number("9007199254740993")` perd le dernier chiffre. On ne convertit donc
 * jamais avant le formatage — le calcul se fait en BigInt, l'arrondi à la fin.
 */
export function toBigInt(value: string | number | bigint | null | undefined): bigint | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return null;
      return BigInt(Math.trunc(value));
    }
    const trimmed = String(value).trim();
    if (!/^-?\d+$/.test(trimmed)) {
      const asNumber = Number(trimmed);
      if (!Number.isFinite(asNumber)) return null;
      return BigInt(Math.trunc(asNumber));
    }
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

/**
 * Formate un volume d'octets sans jamais passer la valeur brute par Number.
 * Un plafond négatif signifie « illimité », jamais « zéro ».
 */
export function formatBytes(value: string | number | bigint | null | undefined, fallback = "—"): string {
  const bytes = toBigInt(value);
  if (bytes === null) return fallback;
  if (bytes < BigInt(0)) return "Illimité";
  if (bytes === BigInt(0)) return "0 o";

  let unit = 0;
  let scale = BigInt(1);
  while (unit < UNITS.length - 1 && bytes / scale >= BigInt(1024)) {
    scale *= BigInt(1024);
    unit += 1;
  }
  // Un chiffre après la virgule, calculé en entiers pour rester exact.
  const tenths = (bytes * BigInt(10)) / scale;
  const whole = tenths / BigInt(10);
  const decimal = tenths % BigInt(10);
  const formatted = unit === 0 || decimal === BigInt(0) ? `${whole}` : `${whole},${decimal}`;
  return `${formatted} ${UNITS[unit]}`;
}

/** Pourcentage d'occupation d'un plafond, calculé en BigInt puis arrondi. */
export function percentOf(used: string | number | bigint | null | undefined, total: string | number | bigint | null | undefined): number {
  const usedBytes = toBigInt(used);
  const totalBytes = toBigInt(total);
  if (usedBytes === null || totalBytes === null || totalBytes <= BigInt(0)) return 0;
  const pct = Number((usedBytes * BigInt(1000)) / totalBytes) / 10;
  return Math.max(0, Math.min(100, pct));
}

export function isResellerRole(role: UserRole | string | null | undefined): boolean {
  return role === UserRole.RESELLER;
}

/** Rôles qui voient l'ensemble du parc et l'étiquette « Client de … ». */
export function isUpperRole(role: UserRole | string | null | undefined): boolean {
  return role === UserRole.OWNER || role === UserRole.SUPER_ADMIN || role === UserRole.ADMIN;
}

/** L'agrément est-il hors service (expiré ou suspendu) ? */
export function isAccessBlocked(access: ResellerAccessSummary | null | undefined): boolean {
  if (!access) return false;
  return access.accessState === "expired" || access.accessState === "suspended";
}

export function isQuotaReached(access: ResellerAccessSummary | null | undefined): boolean {
  return access?.quotaState === "reached";
}

/**
 * Une action est-elle permise dans l'état courant ?
 *
 * `reducesExposure` marque les gestes qui LIBÈRENT du volume (suspendre,
 * révoquer, supprimer, diminuer). Ils restent ouverts quand le plafond est
 * atteint — c'est par eux qu'on en sort — mais pas quand l'accès est expiré
 * ou suspendu, où plus aucune écriture n'est acceptée par le serveur.
 */
export function canPerform(
  access: ResellerAccessSummary | null | undefined,
  options: { reducesExposure?: boolean } = {}
): boolean {
  if (!access) return true;
  if (isAccessBlocked(access)) return false;
  if (isQuotaReached(access) && !options.reducesExposure) return false;
  return true;
}

/** Motif de blocage à afficher sur un bouton désactivé. */
export function blockReason(
  access: ResellerAccessSummary | null | undefined,
  options: { reducesExposure?: boolean } = {}
): string | null {
  if (canPerform(access, options)) return null;
  if (access?.accessState === "expired") return MESSAGE_ACCES_EXPIRE;
  if (access?.accessState === "suspended") return MESSAGE_ACCES_SUSPENDU;
  return MESSAGES[RESELLER_CODES.QUOTA_REACHED];
}

export const ACCESS_LABELS: Record<ResellerAccessState, string> = {
  active: "Accès actif",
  expired: "Accès expiré",
  suspended: "Accès suspendu",
};

export const ACCESS_BADGES: Record<ResellerAccessState, string> = {
  active: "bg-emerald-500/10 text-emerald-400 border border-emerald-500/25",
  expired: "bg-rose-500/10 text-rose-300 border border-rose-500/40",
  suspended: "bg-amber-500/10 text-amber-300 border border-amber-500/30",
};

export const QUOTA_LABELS: Record<ResellerQuotaState, string> = {
  available: "Quota disponible",
  reached: "Plafond atteint",
  unlimited: "Quota illimité",
};

export const QUOTA_BADGES: Record<ResellerQuotaState, string> = {
  available: "bg-cyan-500/10 text-cyan-300 border border-cyan-500/25",
  reached: "bg-rose-500/10 text-rose-300 border border-rose-500/40",
  unlimited: "bg-violet-500/10 text-violet-300 border border-violet-500/25",
};

/** Jours restants avant l'échéance, négatif si elle est passée. */
export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return null;
  return Math.ceil((time - Date.now()) / 86_400_000);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

/** Valeur `datetime-local` par défaut : maintenant + n jours, sans décalage UTC. */
export function defaultExpiryInput(days = 365): string {
  const date = new Date(Date.now() + days * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Borne minimale d'un champ date : demain, pour interdire une échéance passée. */
export function minExpiryInput(): string {
  return defaultExpiryInput(1);
}

/**
 * Une saisie `datetime-local` est-elle une échéance future exploitable ?
 * Le serveur refuse toute date non future : autant le dire avant l'envoi.
 */
export function isFutureExpiry(value: string | null | undefined): boolean {
  if (!value) return false;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return false;
  return time > Date.now();
}

/** Conversion en ISO, seule forme acceptée par le serveur. */
export function toIsoExpiry(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Étiquette de propriété affichée aux rôles supérieurs.
 * Un client sans revendeur est un client direct de la plateforme — le dire
 * explicitement évite de le prendre pour une donnée manquante.
 */
export function ownerLabel(resellerName: string | null | undefined): string {
  return resellerName ? `Client de ${resellerName}` : "Client direct (plateforme)";
}

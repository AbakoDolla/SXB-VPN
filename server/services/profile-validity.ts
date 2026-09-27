/**
 * Échéance d'une configuration VPN du tableau de bord.
 *
 * C'est la date de fin du compte acheté chez le fournisseur (SSH, VLESS…),
 * une information d'exploitation : elle ne change ni le transport ni les
 * identifiants, n'entre pas dans l'empreinte de configuration et se prolonge
 * donc sans déverrouiller la configuration.
 */

// Dix ans bornent une saisie aberrante sans gêner un abonnement annuel
// renouvelé plusieurs fois.
export const MAX_PROFILE_VALIDITY_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Jours entiers 1‥3650 ; `null` pour un champ absent ou vide ; `NaN` si invalide. */
export function profileValidityDays(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > MAX_PROFILE_VALIDITY_DAYS) return NaN;
  return days;
}

/**
 * Nouvelle échéance après prolongation : les jours s'ajoutent à ce qui reste,
 * jamais à une date déjà passée — une configuration expirée repart
 * d'aujourd'hui, comme un forfait prolongé.
 */
export function extendedProfileExpiry(
  current: Date | string | null | undefined,
  days: number,
  now: Date = new Date(),
): Date {
  const previous = current ? new Date(current).getTime() : NaN;
  const base = Number.isFinite(previous) && previous > now.getTime() ? previous : now.getTime();
  return new Date(base + days * DAY_MS);
}

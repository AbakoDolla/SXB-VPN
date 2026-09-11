/**
 * trial.ts — Mention « Période d'essai » côté tableau de bord.
 *
 * Un client ou un appareil dont l'accès provient d'un essai gratuit porte cette
 * mention partout où il apparaît, avec sa date de fin et le pays déclaré à
 * l'inscription.
 *
 * VISIBILITÉ : la mention accompagne le client, donc un REVENDEUR la voit sur
 * SES clients — et seulement sur les siens, puisque le serveur ne lui envoie
 * que les siens. Elle ne donne accès ni au vivier des demandes, ni aux jetons
 * d'invitation, ni aux statistiques globales, qui restent internes.
 */

/** Mention d'essai telle que l'API la renvoie, ou null pour un accès ordinaire. */
export interface TrialMark {
  trial: true;
  /** Pays DÉCLARÉ à l'inscription (ISO 3166-1 alpha-2), ou null. */
  country: string | null;
  /** Fin de la période d'essai, lue sur le forfait en cours. */
  trialEndsAt: string | null;
  /** Début de la période d'essai (déploiement admin). */
  trialStartedAt: string | null;
}

/** Vrai si la valeur reçue est bien une mention d'essai exploitable. */
export function isTrialMark(value: unknown): value is TrialMark {
  return Boolean(value) && typeof value === 'object' && (value as TrialMark).trial === true;
}

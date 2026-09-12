/**
 * Application groupée sur des forfaits — logique pure et testable.
 *
 * POURQUOI CE MODULE EXISTE
 * -------------------------
 * L'écran des forfaits n'offrait qu'UNE action à la fois (« remplacer », ou
 * « ajouter des données », ou « prolonger »…). Pour attribuer un serveur, un
 * volume ET une échéance à cent clients, l'exploitant devait enchaîner trois
 * opérations groupées successives, sans jamais voir l'ensemble de ce qu'il
 * appliquait. Pire : le sélecteur de configuration VPN n'était rendu que par
 * l'action « déployer », donc invisible dans tous les autres cas.
 *
 * Ce module décrit une seule opération — « appliquer » — dont CHAQUE champ est
 * indépendamment facultatif : ce qui n'est pas renseigné n'est pas réécrit.
 * La règle est ici, hors d'Express et hors de Prisma, pour être vérifiable par
 * des tests sans base de données.
 *
 * CE QUE CE MODULE NE FAIT PAS
 * ----------------------------
 * Il ne décide ni des droits, ni de la propriété revendeur, ni du plafond de
 * quota : ces contrôles restent à la charge de la route, qui les applique
 * élément par élément, exactement comme l'action unitaire. Ce module fournit
 * seulement la projection d'allocation dont le contrôle de plafond a besoin.
 */

/** Un gigaoctet binaire, en octets. Aligné sur `GIB` de la route. */
export const GIB = 1024 ** 3;

/** Millisecondes dans une journée. */
export const JOUR_MS = 86_400_000;

/**
 * Taille maximale d'un lot « appliquer ».
 *
 * Le lot est appliqué forfait par forfait, chacun avec ses propres contrôles :
 * sans borne, une sélection de plusieurs milliers d'éléments tiendrait la
 * connexion ouverte assez longtemps pour être coupée en cours de route, et
 * laisserait l'exploitant sans compte rendu. La borne est volontairement plus
 * basse que celle des anciennes actions (1000), qui reste inchangée pour ne
 * rien casser des intégrations existantes.
 */
export const MAX_BULK_APPLY = 200;

/** `set` remplace la valeur ; `add` s'ajoute à l'existant. */
export type ModeQuota = "set" | "add";
export type ModeDuree = "set" | "add";

/** Ce que l'exploitant a effectivement renseigné. Tout est facultatif. */
export interface ChangementsGroupes {
  /** Configuration VPN / serveur de rattachement. */
  profileId?: string;
  /** Volume en gigaoctets, interprété selon `quotaMode`. */
  quotaGB?: number;
  quotaMode?: ModeQuota;
  /** Date (et heure) de début du forfait. */
  startAt?: Date;
  /** Échéance explicite. Exclusive de `durationDays`. */
  expireAt?: Date;
  /** Durée en jours, interprétée selon `durationMode`. */
  durationDays?: number;
  durationMode?: ModeDuree;
}

/** Vue minimale d'un forfait, telle que lue en base. */
export interface ForfaitCible {
  id?: string;
  profileId?: string | null;
  quotaBytes?: bigint | number | string | null;
  quotaUsed?: bigint | number | string | null;
  durationDays?: number | null;
  startAt?: Date | string | null;
  expireAt?: Date | string | null;
  status?: string | null;
}

/**
 * Motifs d'échec ou d'exclusion, en clés i18n.
 *
 * Ce sont des clés et non des phrases : le tableau de bord les traduit, et le
 * même motif reste comparable d'un test à l'autre.
 */
export const RAISONS_GROUPEES = {
  AUCUN_CHANGEMENT: "errors.subscriptions.bulk.no_change",
  AUCUN_CHAMP: "errors.subscriptions.bulk.no_field",
  QUOTA_SOUS_CONSOMMATION: "errors.subscriptions.quota_below_usage",
  ECHEANCE_AVANT_DEBUT: "errors.subscriptions.bulk.expiry_before_start",
  ECHEANCE_ET_DUREE: "errors.subscriptions.bulk.expiry_conflict",
  LOT_TROP_GRAND: "errors.subscriptions.bulk.too_many",
  LOT_VIDE: "errors.subscriptions.bulk.empty",
} as const;

export type PlanForfait =
  | {
      statut: "ok";
      /** Champs à écrire — uniquement ceux qui changent réellement. */
      data: Record<string, unknown>;
      quotaAvant: bigint;
      quotaApres: bigint;
      /** Le forfait pesait-il sur l'enveloppe du revendeur avant / après ? */
      engageAvant: boolean;
      engageApres: boolean;
    }
  | { statut: "skipped"; raison: string }
  | { statut: "failed"; raison: string };

/** Statuts qui relâchent l'enveloppe du revendeur (cf. `calculerAllocation`). */
const STATUTS_RELACHES = ["revoked", "suspended", "expired"];

function versBigInt(valeur: bigint | number | string | null | undefined): bigint {
  if (valeur === null || valeur === undefined || valeur === "") return BigInt(0);
  try {
    return BigInt(valeur as any);
  } catch {
    return BigInt(0);
  }
}

function versDate(valeur: Date | string | null | undefined): Date | null {
  if (valeur === null || valeur === undefined || valeur === "") return null;
  const date = valeur instanceof Date ? valeur : new Date(valeur);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Conversion Go → octets, identique à celle de la route unitaire. */
export function gigaoctetsEnOctets(gigaoctets: number): bigint {
  return BigInt(Math.round(gigaoctets * GIB));
}

/** Aucun champ renseigné : il n'y a rien à appliquer, et rien à confirmer. */
export function aucunChampRenseigne(changements: ChangementsGroupes): boolean {
  return (
    changements.profileId === undefined &&
    changements.quotaGB === undefined &&
    changements.startAt === undefined &&
    changements.expireAt === undefined &&
    changements.durationDays === undefined
  );
}

/**
 * Un forfait pèse-t-il sur l'enveloppe du revendeur ?
 *
 * La définition duplique volontairement celle de `calculerAllocation` : si les
 * deux divergeaient, la projection annoncerait un dépassement que le calcul
 * réel ne constaterait pas, ou l'inverse — et le plafond deviendrait
 * contournable par une opération groupée.
 */
export function estEngage(
  statut: string | null | undefined,
  echeance: Date | string | null | undefined,
  maintenant: number,
): boolean {
  if (STATUTS_RELACHES.includes(String(statut ?? "active"))) return false;
  const date = versDate(echeance);
  return date === null || date.getTime() >= maintenant;
}

/**
 * Statut après application.
 *
 * Une suspension et une révocation sont des gestes explicites : aucune
 * opération groupée ne les lève, sinon recharger un lot entier rouvrirait
 * silencieusement des accès fermés à dessein. En revanche un forfait épuisé ou
 * expiré redevient actif dès que la recharge le remet dans ses droits — c'est
 * précisément le geste commercial attendu.
 */
export function statutApresApplication(
  statutActuel: string,
  quotaApres: bigint,
  consomme: bigint,
  echeanceApres: Date | null,
  maintenant: number,
): string {
  if (statutActuel === "suspended" || statutActuel === "revoked") return statutActuel;
  const dansLesTemps = echeanceApres === null || echeanceApres.getTime() > maintenant;
  const volumeRestant = quotaApres > consomme;
  if (statutActuel === "expired" || statutActuel === "exhausted") {
    return dansLesTemps && volumeRestant ? "active" : statutActuel;
  }
  if (statutActuel === "active" && !dansLesTemps) return "expired";
  return statutActuel;
}

/**
 * Traduit une sélection de champs en écritures pour UN forfait.
 *
 * Contrat : un champ absent des `changements` n'apparaît jamais dans `data`.
 * Un champ renseigné mais identique à l'existant n'y apparaît pas non plus —
 * réécrire une valeur inchangée ferait remonter une réussite là où rien n'a
 * bougé, et brouillerait le compte rendu.
 */
export function planifierApplication(
  forfait: ForfaitCible,
  changements: ChangementsGroupes,
  maintenant: Date = new Date(),
): PlanForfait {
  if (aucunChampRenseigne(changements)) {
    return { statut: "skipped", raison: RAISONS_GROUPEES.AUCUN_CHAMP };
  }
  if (changements.expireAt !== undefined && changements.durationDays !== undefined) {
    return { statut: "failed", raison: RAISONS_GROUPEES.ECHEANCE_ET_DUREE };
  }

  const instant = maintenant.getTime();
  const quotaAvant = versBigInt(forfait.quotaBytes);
  const consomme = versBigInt(forfait.quotaUsed);
  const debutAvant = versDate(forfait.startAt) ?? maintenant;
  const echeanceAvant = versDate(forfait.expireAt);
  const statutAvant = String(forfait.status ?? "active");
  const data: Record<string, unknown> = {};

  // ── Configuration VPN / serveur ─────────────────────────────────────────
  if (changements.profileId !== undefined && changements.profileId !== forfait.profileId) {
    data.profileId = changements.profileId;
  }

  // ── Volume ──────────────────────────────────────────────────────────────
  // `set` remplace le total, `add` complète le solde : les confondre ferait
  // perdre à un client ce qu'il n'a pas encore consommé.
  let quotaApres = quotaAvant;
  if (changements.quotaGB !== undefined) {
    const volume = gigaoctetsEnOctets(changements.quotaGB);
    quotaApres = (changements.quotaMode ?? "set") === "add" ? quotaAvant + volume : volume;
    if (quotaApres < consomme) {
      return { statut: "failed", raison: RAISONS_GROUPEES.QUOTA_SOUS_CONSOMMATION };
    }
    if (quotaApres !== quotaAvant) data.quotaBytes = quotaApres;
  }

  // ── Début ───────────────────────────────────────────────────────────────
  let debutApres = debutAvant;
  if (changements.startAt !== undefined) {
    debutApres = changements.startAt;
    if (debutApres.getTime() !== debutAvant.getTime()) data.startAt = debutApres;
  }

  // ── Échéance ────────────────────────────────────────────────────────────
  let echeanceApres = echeanceAvant;
  const echeanceTouchee =
    changements.expireAt !== undefined || changements.durationDays !== undefined;
  if (changements.expireAt !== undefined) {
    echeanceApres = changements.expireAt;
    // La durée reste cohérente avec les deux bornes affichées : sans cela le
    // forfait annoncerait « 30 jours » avec une échéance à trois mois.
    data.durationDays = Math.max(
      1,
      Math.round((echeanceApres.getTime() - debutApres.getTime()) / JOUR_MS),
    );
    data.expireAt = echeanceApres;
  } else if (changements.durationDays !== undefined) {
    if ((changements.durationMode ?? "set") === "add") {
      // Prolonger un forfait DÉJÀ expiré repart d'aujourd'hui : repartir de son
      // ancienne échéance laisserait la nouvelle date dans le passé.
      const base =
        echeanceAvant && echeanceAvant.getTime() > instant ? echeanceAvant : maintenant;
      echeanceApres = new Date(base.getTime() + changements.durationDays * JOUR_MS);
      data.durationDays = Number(forfait.durationDays ?? 0) + changements.durationDays;
    } else {
      echeanceApres = new Date(debutApres.getTime() + changements.durationDays * JOUR_MS);
      data.durationDays = changements.durationDays;
    }
    data.expireAt = echeanceApres;
  }

  // Contrôle de cohérence uniquement quand l'exploitant a touché aux bornes :
  // une donnée héritée incohérente ne doit pas bloquer une simple recharge.
  if (
    (echeanceTouchee || changements.startAt !== undefined) &&
    echeanceApres !== null &&
    echeanceApres.getTime() <= debutApres.getTime()
  ) {
    return { statut: "failed", raison: RAISONS_GROUPEES.ECHEANCE_AVANT_DEBUT };
  }

  if (Object.keys(data).length === 0) {
    return { statut: "skipped", raison: RAISONS_GROUPEES.AUCUN_CHANGEMENT };
  }

  const statutApres = statutApresApplication(statutAvant, quotaApres, consomme, echeanceApres, instant);
  if (statutApres !== statutAvant) data.status = statutApres;

  return {
    statut: "ok",
    data,
    quotaAvant,
    quotaApres,
    engageAvant: estEngage(statutAvant, echeanceAvant, instant),
    engageApres: estEngage(statutApres, echeanceApres, instant),
  };
}

/**
 * Variation d'enveloppe qu'entraînerait le lot, en octets.
 *
 * Le plafond revendeur doit être évalué sur le CUMUL : contrôler forfait par
 * forfait laisserait passer 100 × 5 Go pour un revendeur qui n'a que 100 Go,
 * chaque appel isolé étant valide. Les forfaits que le lot ne modifie pas
 * (`skipped`) ou qu'il refuse (`failed`) ne pèsent rien.
 */
export function deltaAllocationGroupee(
  forfaits: readonly ForfaitCible[],
  changements: ChangementsGroupes,
  maintenant: Date = new Date(),
): bigint {
  let delta = BigInt(0);
  for (const forfait of forfaits) {
    const plan = planifierApplication(forfait, changements, maintenant);
    if (plan.statut !== "ok") continue;
    const avant = plan.engageAvant ? plan.quotaAvant : BigInt(0);
    const apres = plan.engageApres ? plan.quotaApres : BigInt(0);
    delta += apres - avant;
  }
  return delta;
}

/**
 * Normalise et borne une sélection : doublons retirés, lot plafonné.
 *
 * Le dédoublonnage n'est pas cosmétique : deux fois le même identifiant dans
 * un `add_data` ajouterait deux fois le volume.
 */
export function normaliserLot(
  ids: readonly string[] | undefined,
  maximum: number = MAX_BULK_APPLY,
): { ok: true; ids: string[] } | { ok: false; raison: string } {
  const uniques = [...new Set(ids ?? [])];
  if (uniques.length === 0) return { ok: false, raison: RAISONS_GROUPEES.LOT_VIDE };
  if (uniques.length > maximum) return { ok: false, raison: RAISONS_GROUPEES.LOT_TROP_GRAND };
  return { ok: true, ids: uniques };
}

// ─────────────────────────────────────────────────────────────────────────────
// Transitions d'état — suspendre, réactiver, révoquer
// ─────────────────────────────────────────────────────────────────────────────
//
// POURQUOI ICI : la section « Essais gratuits » doit pouvoir fermer, rouvrir
// ou couper l'accès d'un essai déjà déployé, sur une sélection multiple. Ce
// sont exactement les gestes que `PUT /subscriptions/:id` et
// `POST /subscriptions/:id/revoke` font à l'unité. Plutôt que d'écrire une
// seconde mécanique dans la route d'essai, la décision est posée ici, à côté
// de `planifierApplication`, avec le même contrat : rien à écrire → `skipped`,
// geste impossible → `failed`, jamais une réussite muette.
//
// `planifierApplication` refuse volontairement de LEVER une suspension : une
// simple recharge ne doit pas rouvrir un accès fermé à dessein. Ces transitions
// sont l'inverse — un geste EXPLICITE de l'exploitant — et c'est pour cela
// qu'elles sont séparées des champs de `apply`.

/** Gestes d'état, tels que l'interface les nomme. */
export const ETATS_GROUPES = {
  SUSPENDRE: "suspend",
  REACTIVER: "resume",
  REVOQUER: "revoke",
} as const;

export type EtatGroupe = (typeof ETATS_GROUPES)[keyof typeof ETATS_GROUPES];

export const RAISONS_ETAT = {
  /** L'accès est déjà dans l'état demandé : rien à écrire. */
  ETAT_INCHANGE: "errors.subscriptions.bulk.state_unchanged",
  /** Une révocation ne se rattrape pas : elle ferme l'accès pour de bon. */
  REVOCATION_DEFINITIVE: "errors.subscriptions.bulk.revoked_is_final",
  /** Réactiver un accès échu ou épuisé ne rouvrirait rien du tout. */
  REACTIVATION_SANS_EFFET: "errors.subscriptions.bulk.cannot_resume",
  /** Geste inconnu. */
  ETAT_INCONNU: "errors.subscriptions.bulk.unknown_state",
} as const;

export type PlanEtat =
  | { statut: "ok"; data: Record<string, unknown>; reduitExposition: boolean }
  | { statut: "skipped"; raison: string }
  | { statut: "failed"; raison: string };

/**
 * Traduit un geste d'état en écritures pour UN forfait.
 *
 * La réactivation suit la MÊME règle que le tableau de bord
 * (`canResumeSubscription`) : elle ne part que d'une suspension, et seulement
 * si l'accès a encore une échéance devant lui et du volume disponible. Annoncer
 * « réactivé » sur un forfait échu serait un mensonge à l'écran.
 */
export function planifierEtat(
  forfait: ForfaitCible,
  etat: EtatGroupe,
  maintenant: Date = new Date(),
  note?: string,
): PlanEtat {
  const statut = String(forfait.status ?? "active");
  const instant = maintenant.getTime();

  if (etat === ETATS_GROUPES.REVOQUER) {
    if (statut === "revoked") return { statut: "skipped", raison: RAISONS_ETAT.ETAT_INCHANGE };
    return {
      statut: "ok",
      reduitExposition: true,
      data: {
        status: "revoked",
        revokedAt: maintenant,
        revokeReason: note?.trim() || "Essai gratuit révoqué par l’exploitation",
      },
    };
  }

  if (etat === ETATS_GROUPES.SUSPENDRE) {
    if (statut === "revoked") return { statut: "failed", raison: RAISONS_ETAT.REVOCATION_DEFINITIVE };
    if (statut === "suspended") return { statut: "skipped", raison: RAISONS_ETAT.ETAT_INCHANGE };
    return { statut: "ok", reduitExposition: true, data: { status: "suspended" } };
  }

  if (etat === ETATS_GROUPES.REACTIVER) {
    if (statut === "revoked") return { statut: "failed", raison: RAISONS_ETAT.REVOCATION_DEFINITIVE };
    if (statut !== "suspended") return { statut: "skipped", raison: RAISONS_ETAT.ETAT_INCHANGE };
    const echeance = versDate(forfait.expireAt);
    if (echeance !== null && echeance.getTime() <= instant) {
      return { statut: "failed", raison: RAISONS_ETAT.REACTIVATION_SANS_EFFET };
    }
    const quota = versBigInt(forfait.quotaBytes);
    if (quota > BigInt(0) && versBigInt(forfait.quotaUsed) >= quota) {
      return { statut: "failed", raison: RAISONS_ETAT.REACTIVATION_SANS_EFFET };
    }
    // Rouvrir réengage le volume : c'est la seule transition qui AUGMENTE
    // l'exposition, et la route doit le contrôler comme une augmentation.
    return { statut: "ok", reduitExposition: false, data: { status: "active" } };
  }

  return { statut: "failed", raison: RAISONS_ETAT.ETAT_INCONNU };
}

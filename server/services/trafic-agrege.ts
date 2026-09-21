/**
 * Agrégation du trafic : quota provisionné, consommation, taux d'utilisation.
 *
 * LE DÉFAUT MESURÉ EN PRODUCTION
 * ──────────────────────────────
 * `/api/analytics/traffic` annonçait `utilizationPercentage: 744.68`.
 *
 * Le taux comparait deux populations différentes. Le dénominateur ne retenait
 * que les fiches munies d'un quota — 31 sur 309 en production — tandis que le
 * numérateur additionnait la consommation des 309, y compris celle des accès
 * sans limite, qui n'ont par définition aucun quota à saturer.
 *
 * Ce n'était donc ni un double comptage ni une erreur d'unité : le facteur
 * variait dans le temps (13,4 puis 5,3 puis 7,4), ce qui excluait à soi seul
 * tout facteur constant.
 *
 * La règle vivait en DEUX exemplaires — branche base de données et branche de
 * repli en mémoire — et le défaut était présent dans les deux. C'est cette
 * duplication qui l'a rendu possible : d'où un point unique.
 */

export interface FicheTrafic {
  quotaTotal?: bigint | null;
  quotaUsed: bigint;
}

export interface TraficAgrege {
  /** Somme des quotas, sur les seules fiches qui en portent un. */
  provisionedBytes: bigint;
  /** Consommation de TOUT le parc visible — rien ne disparaît du total. */
  consumedBytes: bigint;
  /** Consommation des seules fiches à quota : le numérateur du taux. */
  meteredConsumedBytes: bigint;
  /** Nombre de fiches effectivement plafonnées. */
  meteredClients: number;
}

export function agregerTrafic(fiches: readonly FicheTrafic[]): TraficAgrege {
  let provisionedBytes = BigInt(0);
  let consumedBytes = BigInt(0);
  let meteredConsumedBytes = BigInt(0);
  let meteredClients = 0;

  for (const fiche of fiches) {
    const utilise = fiche.quotaUsed ?? BigInt(0);
    consumedBytes += utilise;
    // Un quota absent, nul ou négatif ne plafonne rien : la fiche n'entre ni
    // au numérateur ni au dénominateur, sinon le taux redevient incomparable.
    if (fiche.quotaTotal && fiche.quotaTotal > BigInt(0)) {
      provisionedBytes += fiche.quotaTotal;
      meteredConsumedBytes += utilise;
      meteredClients++;
    }
  }

  return { provisionedBytes, consumedBytes, meteredConsumedBytes, meteredClients };
}

const OCTETS_PAR_GO = 1024 * 1024 * 1024;

export function enGo(octets: bigint): number {
  return Number(Number(octets) / OCTETS_PAR_GO);
}

/**
 * Taux d'utilisation, numérateur et dénominateur portant sur les MÊMES fiches.
 *
 * Peut légitimement dépasser 100 % — un dépassement de quota est réel et doit
 * se voir. Ce qui ne doit plus arriver, c'est un taux gonflé par des fiches qui
 * n'ont jamais eu de plafond.
 */
export function tauxUtilisation(agrege: TraficAgrege): number {
  if (agrege.provisionedBytes <= BigInt(0)) return 0;
  const taux = (enGo(agrege.meteredConsumedBytes) / enGo(agrege.provisionedBytes)) * 100;
  return Number(taux.toFixed(2));
}

/* ──────────────────────────────────────────────────────────────────────────
 * D'OÙ VIENT LE QUOTA D'UN CLIENT
 * ───────────────────────────────
 * Le même défaut a été mesuré une seconde fois, sur `/api/dashboard/stats` :
 * consumedTraffic 1479,48 Gio pour provisionedTraffic 280 Gio. Le tableau
 * croisé des 309 fiches de production en donne la raison :
 *
 *   porte un quotaTotal ET un forfait :   4 fiches | 115 Gio |   0,6 Gio consommés
 *   porte un quotaTotal, sans forfait :  27 fiches | 165 Gio |   0   Gio consommés
 *   SANS quotaTotal, avec forfait     :  80 fiches |   0     | 760,14 Gio consommés
 *   SANS quotaTotal, sans forfait     : 198 fiches |   0     | 718,74 Gio consommés
 *
 * 100 % du numérateur venait de fiches dont `quotaTotal` vaut zéro. La cause :
 * 2 015 419 Gio de quota réellement vendu vivent sur `Subscription`, pas sur la
 * fiche — et le tableau de bord ne les lisait pas.
 *
 * La sélection de la source vit ICI, à côté de l'agrégation, et non dans la
 * route : c'est la duplication de la règle qui avait rendu le premier défaut
 * possible, et rien n'obligeait les deux écrans à rester d'accord.
 * ────────────────────────────────────────────────────────────────────────── */

const ETATS_CLIENT_INACTIFS = new Set(["suspended", "revoked", "expired", "disabled"]);
const ETATS_FORFAIT_INACTIFS = new Set(["revoked", "suspended", "expired"]);

/**
 * Un plafond négatif signifie « illimité » — même convention que
 * `estIllimite` dans services/reseller-quota.ts. Recopiée plutôt qu'importée
 * pour que ce module reste sans dépendance, donc exerçable tel quel.
 */
function estIllimite(quota: bigint): boolean {
  return quota < BigInt(0);
}

/**
 * Seuil PUREMENT INFORMATIF (1 Tio).
 *
 * En production, 39 forfaits « VIP » de 100 To à 1 Po pèsent 2 010 000 Gio sur
 * 2 015 419. Les retrancher d'office remplacerait un chiffre absurde par un
 * chiffre flatteur : ils restent donc dans le total, et sont seulement
 * dénombrés à part pour que l'exploitant puisse décider en connaissance de
 * cause d'isoler ou non cette part à l'affichage.
 */
export const SEUIL_FORFAIT_HORS_NORME = BigInt(1024) ** BigInt(4);

export interface LigneQuotaClient {
  status?: string | null;
  expireAt?: Date | string | null;
  quotaTotal?: bigint | number | null;
  quotaUsed?: bigint | number | null;
  subscriptions?: Array<{
    quotaBytes?: bigint | number | null;
    quotaUsed?: bigint | number | null;
    status?: string | null;
    expireAt?: Date | string | null;
  }> | null;
}

function echeanceDepassee(valeur: Date | string | null | undefined, maintenant: number): boolean {
  if (valeur === null || valeur === undefined) return false;
  const t = new Date(valeur).getTime();
  if (Number.isNaN(t)) return false;
  return t < maintenant;
}

/**
 * Ramène un client à UNE fiche de trafic, plafond et consommation issus de la
 * MÊME source. C'est l'invariant : sans lui, le rapport perd toute valeur.
 *
 * Règle appliquée — celle qui existe déjà pour les enveloppes revendeurs
 * (`calculerAllocation`, services/reseller-quota.ts) : LE FORFAIT PRIME SUR LE
 * QUOTA PORTÉ PAR LA FICHE. Un client qui possède au moins un forfait est
 * décrit par ses forfaits seuls ; sa fiche n'est plus lue. Sans cette
 * exclusivité, un client doté des deux serait compté deux fois.
 *
 * Le consommé retient TOUS les forfaits, y compris révoqués : le volume a bien
 * été écoulé, l'oublier minorerait la consommation réelle. Le plafond ne
 * retient que les forfaits actifs et non échus : un forfait révoqué ne
 * provisionne plus rien.
 */
export function ficheTraficEffective(
  client: LigneQuotaClient,
  maintenant: number = Date.now(),
): FicheTrafic {
  const forfaits = client.subscriptions ?? [];
  const clientActif = !ETATS_CLIENT_INACTIFS.has(String(client.status ?? ""));

  if (forfaits.length > 0) {
    let consomme = BigInt(0);
    let plafond = BigInt(0);
    for (const forfait of forfaits) {
      consomme += BigInt(forfait.quotaUsed ?? 0);
      if (!clientActif) continue;
      if (ETATS_FORFAIT_INACTIFS.has(String(forfait.status ?? ""))) continue;
      if (echeanceDepassee(forfait.expireAt, maintenant)) continue;
      const q = BigInt(forfait.quotaBytes ?? 0);
      // Additionner un plafond illimité RETRANCHERAIT du volume au total.
      if (estIllimite(q)) continue;
      plafond += q;
    }
    return { quotaTotal: plafond, quotaUsed: consomme };
  }

  const plafondFiche = BigInt(client.quotaTotal ?? 0);
  const actifEtNonEchu = clientActif && !echeanceDepassee(client.expireAt, maintenant);
  return {
    quotaTotal: actifEtNonEchu && !estIllimite(plafondFiche) ? plafondFiche : BigInt(0),
    quotaUsed: BigInt(client.quotaUsed ?? 0),
  };
}

/** Agrège un parc de clients en appliquant la règle de source puis le point unique. */
export function agregerQuotaClients(
  clients: readonly LigneQuotaClient[],
  maintenant: number = Date.now(),
): TraficAgrege {
  return agregerTrafic((clients ?? []).map((c) => ficheTraficEffective(c, maintenant)));
}

export interface ProvenanceQuota {
  /** Fiches décrites par leurs forfaits (le forfait prime). */
  fromSubscriptions: number;
  /** Fiches décrites par leur propre `quotaTotal`, faute de forfait. */
  fromClientRecord: number;
  /** Fiches dont le plafond retenu dépasse le seuil informatif. */
  outsizedPlans: number;
  outsizedBytes: bigint;
}

/**
 * Provenance des grandeurs agrégées. Publiée pour qu'une dérive redevienne
 * VISIBLE : si `fromClientRecord` enflait alors que le parc est vendu par
 * forfaits, le rapport recommencerait à perdre son sens — en silence.
 */
export function provenanceQuota(
  clients: readonly LigneQuotaClient[],
  maintenant: number = Date.now(),
): ProvenanceQuota {
  let fromSubscriptions = 0;
  let fromClientRecord = 0;
  let outsizedPlans = 0;
  let outsizedBytes = BigInt(0);

  for (const client of clients ?? []) {
    if ((client.subscriptions ?? []).length > 0) fromSubscriptions += 1;
    else fromClientRecord += 1;
    const plafond = ficheTraficEffective(client, maintenant).quotaTotal ?? BigInt(0);
    if (plafond >= SEUIL_FORFAIT_HORS_NORME) {
      outsizedPlans += 1;
      outsizedBytes += plafond;
    }
  }

  return { fromSubscriptions, fromClientRecord, outsizedPlans, outsizedBytes };
}

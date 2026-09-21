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

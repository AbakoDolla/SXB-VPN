/**
 * journalChronologie — donner une durée à chaque étape d'une connexion.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LE PROBLÈME QUE CE MODULE RÉSOUT
 * ═══════════════════════════════════════════════════════════════════════════
 * « La connexion met une minute » est un constat, pas un diagnostic. Le journal
 * affichait un horodatage brut par étape : pour savoir LAQUELLE coûte cinquante
 * secondes, il fallait soustraire des heures à la main, ligne par ligne.
 * Personne ne le fait, donc l'information restait inexploitable.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN MODULE À PART, ET PAS TROIS LIGNES DANS L'ÉCRAN
 * ═══════════════════════════════════════════════════════════════════════════
 * Le journal s'affiche du PLUS RÉCENT au plus ancien — c'est ce qu'on vient
 * chercher quand une connexion ne part pas. L'étape qui précède `liste[i]`
 * dans le TEMPS est donc `liste[i + 1]`, pas `liste[i - 1]`.
 *
 * Se tromper d'un cran ici ne casse rien de visible : la soustraction devient
 * négative, le seuil de bruit l'écarte, et plus aucune durée ne s'affiche —
 * une fonctionnalité morte en silence. C'est exactement le genre de défaut
 * qu'une relecture laisse passer et qu'un test attrape.
 *
 * Cette inversion vit donc à UN seul endroit, vérifié, que l'écran et le
 * partage utilisent tous les deux.
 *
 * Aucune donnée sensible n'entre ici : un délai n'est ni une adresse, ni une
 * configuration, ni un identifiant.
 */

export type EtapeHorodatee = { timestamp?: string };

export type EtapeChronometree<T extends EtapeHorodatee> = {
  etape: T;
  /** Temps écoulé depuis l'étape précédente, ou `null` si non mesurable. */
  duree: string | null;
  /** Heure locale lisible, ou `null` si l'étape n'est pas horodatée. */
  heure: string | null;
  /**
   * L'étape a coûté assez pour être LA cause de l'attente.
   *
   * Le journal sert à repérer la marche lente. Sans distinction visuelle, la
   * durée se noie parmi les codes de diagnostic, tous rendus pareillement —
   * l'information la plus utile de l'écran devenait la plus difficile à voir.
   */
  lent: boolean;
};

/** En dessous, l'étape est perçue comme instantanée et la durée n'apprend rien. */
const SEUIL_BRUIT_MS = 100;

/**
 * Au-delà, l'étape pèse sur le ressenti et doit sauter aux yeux.
 *
 * Trois secondes : en deçà, une connexion reste vive ; au-delà, l'utilisateur
 * attend. C'est le seuil qui sépare « normal » de « à expliquer ».
 */
const SEUIL_LENTEUR_MS = 3_000;

/**
 * Écart brut en millisecondes, ou `0` quand la mesure manque.
 *
 * Séparé de `ecart` parce que la mise en forme et la comparaison n'ont pas les
 * mêmes besoins : l'une veut un texte lisible, l'autre un nombre à comparer.
 */
function ecartMs(courant: string | undefined, precedent: string | undefined): number {
  if (!courant || !precedent) return 0;
  const fin = Date.parse(courant);
  const debut = Date.parse(precedent);
  if (!Number.isFinite(fin) || !Number.isFinite(debut)) return 0;
  return Math.max(0, fin - debut);
}

/**
 * Écart entre deux horodatages, en clair.
 *
 * Millisecondes sous la seconde, secondes au-delà : « +47.3 s » se lit, pas
 * « +47300 ms ». Rend `null` quand la mesure manque, est illisible, ou reste
 * sous le seuil de bruit.
 */
export function ecart(courant: string | undefined, precedent: string | undefined): string | null {
  if (!courant || !precedent) return null;
  const fin = Date.parse(courant);
  const debut = Date.parse(precedent);
  if (!Number.isFinite(fin) || !Number.isFinite(debut)) return null;
  const ms = fin - debut;
  if (ms < SEUIL_BRUIT_MS) return null;
  return ms < 1000 ? `+${ms} ms` : `+${(ms / 1000).toFixed(1)} s`;
}

/**
 * Heure locale sans la date : un journal couvre une seule tentative.
 *
 * Un horodatage illisible est rendu tel quel plutôt que masqué — mieux vaut
 * une ligne étrange qu'une ligne absente quand on diagnostique.
 */
export function heure(horodatage: string | undefined): string | null {
  if (!horodatage) return null;
  const date = new Date(horodatage);
  if (Number.isNaN(date.getTime())) return horodatage;
  return date.toLocaleTimeString();
}

/**
 * Chronomètre une liste d'étapes affichée du PLUS RÉCENT au plus ancien.
 *
 * L'ordre rendu est identique à celui reçu : l'appelant n'a rien à réordonner
 * pour l'affichage, et peut simplement l'inverser pour une lecture
 * chronologique (le partage).
 */
export function chronometrer<T extends EtapeHorodatee>(recenteEnTete: T[]): EtapeChronometree<T>[] {
  return recenteEnTete.map((etape, index) => {
    // L'étape précédente dans le temps est la SUIVANTE dans cette liste.
    const precedent = recenteEnTete[index + 1]?.timestamp;
    return {
      etape,
      duree: ecart(etape.timestamp, precedent),
      heure: heure(etape.timestamp),
      lent: ecartMs(etape.timestamp, precedent) >= SEUIL_LENTEUR_MS,
    };
  });
}

/**
 * attenteBornee — attendre, mais jamais indéfiniment.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT QUE CE MODULE EMPÊCHE
 * ═══════════════════════════════════════════════════════════════════════════
 * L'accueil annonçait un rafraîchissement par un tournis, et attendait une
 * chaîne réseau que RIEN ne bornait. En mesurant les délais traversés :
 * l'état d'accès tolère 35 s, la liste des connexions 15 s, et chaque
 * configuration à provisionner rejoue trois tentatives de 15 s séparées de
 * pauses — près de 46 s par configuration.
 *
 * Avec deux configurations neuves, le bouton restait désactivé et le tournis
 * tournait plus de deux minutes, sans un mot. L'utilisateur l'a décrit ainsi :
 * « j'appuie encore sur charger et ça tourne indéfiniment ».
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CE QUI EST BORNÉ, ET CE QUI NE L'EST PAS
 * ═══════════════════════════════════════════════════════════════════════════
 * On borne l'ATTENTE VISIBLE, pas le travail. Le travail se poursuit et ses
 * résultats arriveront — les annuler ferait perdre un provisionnement déjà
 * engagé, et l'utilisateur devrait tout recommencer.
 *
 * Un tournis sans fin est pire qu'une réponse tardive : il ne dit rien, et
 * n'offre aucune issue.
 */

/**
 * Marque d'un dépassement de délai.
 *
 * Un symbole, et non une `Error` : l'appelant doit pouvoir distinguer « c'est
 * long » de « c'est cassé » par une comparaison exacte, sans lire un message
 * ni risquer de confondre avec une erreur du travail lui-même.
 */
export const LENTEUR = Symbol('lenteur');

/** Vrai si la raison du rejet est un dépassement de délai, et non un échec. */
export function estLenteur(raison: unknown): boolean {
  return raison === LENTEUR;
}

/**
 * Attend `promesse`, mais pas plus de `ms` millisecondes.
 *
 * Rejette avec `LENTEUR` au dépassement. Le minuteur est toujours désarmé —
 * y compris quand la promesse gagne la course — pour ne pas retenir un
 * minuteur par appel.
 *
 * @param promesse Le travail à attendre. Il n'est PAS annulé au dépassement.
 * @param ms       Durée maximale de l'attente visible.
 */
export function avecDelai<T>(promesse: Promise<T>, ms: number): Promise<T> {
  let minuteur: ReturnType<typeof setTimeout> | undefined;
  const butoir = new Promise<never>((_, rejeter) => {
    minuteur = setTimeout(() => rejeter(LENTEUR), ms);
  });
  return Promise.race([promesse, butoir]).finally(() => clearTimeout(minuteur));
}

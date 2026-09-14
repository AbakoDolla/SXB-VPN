// Ordre d'affichage des forfaits.
//
// CAUSE RACINE : le serveur renvoie les forfaits triés par date de création
// (`orderBy: { createdAt: 'desc' }`). Les forfaits d'une même personne se
// retrouvaient donc dispersés dans toute la liste, au gré de la date à laquelle
// chacun avait été attribué, et il fallait parcourir la page entière — voire
// plusieurs pages — pour réunir ce qu'un seul client possède.
//
// Le tri ci-dessous regroupe d'abord par client, puis classe du plus récent au
// plus ancien à l'intérieur de chaque groupe.

export interface PlanOrderItem {
  clientId: string;
  createdAt: string;
}

/**
 * Compare deux forfaits pour un affichage groupé par client.
 *
 * @param nomDe rend le nom lisible d'un forfait ; une chaîne vide signifie
 *              « ce client n'a pas de nom affichable ».
 */
export function comparerForfaitsParClient<T extends PlanOrderItem>(
  a: T,
  b: T,
  nomDe: (forfait: T) => string,
): number {
  const nomA = nomDe(a);
  const nomB = nomDe(b);

  // Un client sans nom lisible passe APRÈS les autres. Sans cette règle, la
  // chaîne vide trie avant toutes les lettres et une fiche incomplète
  // s'installerait en tête de liste.
  if (!nomA !== !nomB) return nomA ? -1 : 1;

  // `numeric` classe « Appareil 2 » avant « Appareil 10 » ; un tri purement
  // lexical ferait l'inverse. `sensitivity: 'base'` évite qu'une majuscule
  // sépare deux fois le même nom.
  const parNom = nomA.localeCompare(nomB, undefined, { numeric: true, sensitivity: 'base' });
  if (parNom !== 0) return parNom;

  // Deux personnes peuvent porter le même nom affiché : les départager par
  // identifiant garde leurs forfaits dans deux groupes distincts. Les fusionner
  // laisserait croire qu'un seul compte détient les forfaits des deux.
  if (a.clientId !== b.clientId) return a.clientId.localeCompare(b.clientId);

  // À l'intérieur d'un client : le plus récemment attribué en premier, ce qui
  // préserve l'ordre que le serveur appliquait à la liste entière.
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

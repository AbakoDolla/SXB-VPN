/**
 * liste.ts — Lire une collection quelle que soit la forme que l'API lui donne.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT QUE CECI EMPÊCHE
 * ═══════════════════════════════════════════════════════════════════════════
 * Les routes de l'API ne s'accordent pas sur la forme d'une collection :
 * certaines renvoient `{ users: [...] }`, d'autres un TABLEAU NU. Le tableau
 * de bord, lui, écrivait partout `data.cle || []`.
 *
 * Sur une route qui renvoie un tableau nu, `data.cle` vaut `undefined`, le
 * `|| []` le change en liste vide, et l'écran affiche « aucun élément » alors
 * que la base en contient des centaines. Aucune exception, aucune trace dans
 * la console : le défaut est parfaitement muet, et c'est ce qui le rend
 * dangereux — il se constate seulement en comparant l'écran à la base.
 *
 * Mesuré en production : `/api/servers` renvoyait 4 nœuds et l'écran en
 * montrait 0 ; `/api/users` renvoyait 475 comptes et l'écran en montrait 0.
 *
 * Corriger le SERVEUR aurait été plus propre, mais l'application mobile
 * consomme les mêmes routes : changer leur forme aujourd'hui casserait les
 * téléphones déjà déployés, que personne ne peut mettre à jour. Le tableau de
 * bord accepte donc les deux formes — il est le seul des deux que l'on peut
 * livrer d'un coup.
 */

/**
 * Extrait une liste d'une réponse d'API, qu'elle soit enveloppée ou nue.
 *
 * @param reponse Ce que l'API a renvoyé.
 * @param cle     Nom de la propriété sous laquelle la liste est attendue.
 */
export function listeDepuis<T>(reponse: unknown, cle: string): T[] {
  if (Array.isArray(reponse)) return reponse as T[];
  if (reponse && typeof reponse === "object") {
    const valeur = (reponse as Record<string, unknown>)[cle];
    if (Array.isArray(valeur)) return valeur as T[];
  }
  return [];
}

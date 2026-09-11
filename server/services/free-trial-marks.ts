/**
 * free-trial-marks.ts — Mention « période d'essai » sur les clients et appareils.
 *
 * POURQUOI CE FICHIER EXISTE : le propriétaire veut reconnaître d'un coup d'œil
 * un accès issu d'un essai gratuit, avec sa date de fin et le pays déclaré, là
 * où le client apparaît — y compris chez un REVENDEUR, pour ses propres clients.
 *
 * CE QU'IL NE FAIT PAS : il ne décide d'aucune visibilité. Le cloisonnement
 * revendeur est déjà fait en amont par `porteeClientsRevendeur`, qui restreint
 * la liste des clients chargés ; cette fonction ne reçoit donc que des
 * identifiants que l'appelant a déjà le droit de voir. Elle n'élargit jamais
 * une portée, elle décore.
 *
 * COÛT : deux lectures indexées pour toute une page, jamais une par ligne — un
 * parc de plusieurs centaines d'appareils s'affiche sans requête en cascade.
 */
import { STATUT_DEMANDE, marqueEssaiPourClient, type MarqueEssai } from "./free-trial";

export type { MarqueEssai };

/**
 * Construit la mention d'essai pour un lot de clients.
 *
 * Renvoie une table VIDE plutôt qu'une erreur si la fonctionnalité d'essai
 * n'est pas déployée sur cette base (migration non encore appliquée) : la
 * liste des appareils est un écran d'exploitation critique, elle ne doit pas
 * tomber parce qu'une mention décorative n'a pas pu être calculée.
 */
export async function marquesEssaiParClient(
  db: any,
  clientIds: ReadonlyArray<string>,
): Promise<Map<string, MarqueEssai>> {
  const marques = new Map<string, MarqueEssai>();
  const ids = [...new Set(clientIds.filter(Boolean))];
  if (!db?.freeTrialRequest || ids.length === 0) return marques;

  try {
    // Seules les demandes DÉPLOYÉES marquent un client : une demande en attente
    // ou refusée n'a jamais ouvert d'accès, la signaler serait mensonger.
    const demandes = await db.freeTrialRequest.findMany({
      where: { clientId: { in: ids }, status: STATUT_DEMANDE.DEPLOYED },
      select: { clientId: true, country: true, deployedAt: true, subscriptionId: true },
    });
    if (!demandes.length) return marques;

    // La date de fin est lue sur le FORFAIT, pas figée à la demande : si
    // l'exploitation prolonge l'essai, la mention suit, au lieu d'afficher
    // éternellement l'échéance d'origine.
    const forfaitIds = [...new Set(demandes.map((d: any) => d.subscriptionId).filter(Boolean))] as string[];
    const echeances = new Map<string, Date | string | null>();
    if (forfaitIds.length && db.subscription) {
      const forfaits = await db.subscription.findMany({
        where: { id: { in: forfaitIds } },
        select: { id: true, expireAt: true },
      });
      for (const forfait of forfaits as any[]) echeances.set(forfait.id, forfait.expireAt ?? null);
    }

    for (const demande of demandes as any[]) {
      const marque = marqueEssaiPourClient({
        demande,
        expireAt: demande.subscriptionId ? echeances.get(demande.subscriptionId) ?? null : null,
      });
      if (!marque) continue;
      const existante = marques.get(demande.clientId);
      // Deux essais déployés sur le même compte : on garde celui qui va le plus
      // loin, c'est la période encore en cours.
      if (!existante || plusTardif(marque.trialEndsAt, existante.trialEndsAt)) {
        marques.set(demande.clientId, marque);
      }
    }
  } catch (erreur) {
    console.error("free-trial marks error:", erreur);
    return new Map<string, MarqueEssai>();
  }
  return marques;
}

function plusTardif(candidat: string | null, reference: string | null): boolean {
  if (!candidat) return false;
  if (!reference) return true;
  return new Date(candidat).getTime() > new Date(reference).getTime();
}

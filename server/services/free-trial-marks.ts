/**
 * free-trial-marks.ts — Mention « période d'essai » ET séparation des essais.
 *
 * POURQUOI CE FICHIER EXISTE : le propriétaire veut reconnaître d'un coup d'œil
 * un accès issu d'un essai gratuit, avec sa date de fin et le pays déclaré, là
 * où le client apparaît — y compris chez un REVENDEUR, pour ses propres clients.
 *
 * IL PORTE AUSSI LA SÉPARATION exigée ensuite : « Forfaits Data », « Comptes
 * VPN » et « Appareils » ne mélangent plus les essais aux clients principaux.
 * Le marqueur est le MÊME que celui de la mention — une demande d'essai
 * DÉPLOYÉE qui pointe vers son compte et son forfait. Aucun second mécanisme
 * n'a été introduit : le nom du forfait (« Essai gratuit — … ») ne décide de
 * rien, et les essais déjà déployés avant cette correction sont reconnus sans
 * migration, puisque `freeTrialRequest.subscriptionId` existe depuis l'origine.
 *
 * CE QU'IL NE FAIT PAS : il ne décide d'aucune visibilité REVENDEUR. Le
 * cloisonnement est déjà fait en amont par `porteeClientsRevendeur`, qui
 * restreint la liste des clients chargés ; les filtres d'ici ne font que
 * RETRANCHER, jamais élargir une portée.
 *
 * COÛT : trois lectures indexées pour toute une page, jamais une par ligne — un
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

/**
 * Forfaits d'UN compte nés d'un essai gratuit déployé.
 *
 * C'est ce que l'application mobile a besoin de savoir pour présenter à son
 * utilisateur un écran d'essai plutôt que l'écran ordinaire. Le marqueur est le
 * MÊME que celui du tableau de bord — une demande d'essai DÉPLOYÉE qui pointe
 * vers son forfait — et surtout PAS le nom du forfait : « Essai gratuit — … »
 * est un libellé que l'exploitation peut changer à tout moment, et un forfait
 * ordinaire peut porter ce nom sans être un essai.
 *
 * Une seule lecture indexée, bornée au compte du demandeur : l'appareil ne
 * déclenche jamais la lecture globale du parc que fait `porteeEssaiDeploye`.
 *
 * Rend un ensemble VIDE si la fonctionnalité d'essai n'est pas déployée sur
 * cette base ou si la lecture échoue : la liste des connexions est le chemin
 * par lequel un téléphone récupère son accès, elle ne doit jamais tomber parce
 * qu'une mention n'a pas pu être calculée.
 */
export async function forfaitsEssaiDuClient(db: any, clientId: string): Promise<Set<string>> {
  if (!db?.freeTrialRequest || !clientId) return new Set<string>();
  try {
    const demandes = await db.freeTrialRequest.findMany({
      where: { clientId, status: STATUT_DEMANDE.DEPLOYED },
      select: { subscriptionId: true },
    });
    return new Set(
      (demandes as any[]).map((demande) => demande.subscriptionId).filter(Boolean).map(String),
    );
  } catch (erreur) {
    console.error("free-trial mobile mark error:", erreur);
    return new Set<string>();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Séparation — ce qui relève de l'essai gratuit, et ce qui n'en relève plus
// ─────────────────────────────────────────────────────────────────────────────

/** Ce que la lecture des demandes déployées apprend sur le parc. */
export interface PorteeEssai {
  /** Forfaits NÉS d'un essai déployé. */
  subscriptionIds: string[];
  /** Comptes touchés par un essai déployé, convertis compris. */
  clientIds: string[];
  /**
   * Comptes dont TOUT l'accès vient d'un essai : aucun forfait ordinaire à
   * côté.
   *
   * C'est CE sous-ensemble que « Comptes VPN » et « Appareils » masquent, et
   * non `clientIds`. Un essayeur devenu client payant garde forcément son
   * compte et son appareil — le déploiement d'essai réutilise le compte déjà
   * lié au téléphone —, et le faire disparaître des écrans d'exploitation
   * ferait perdre de vue un vrai client.
   */
  clientsEssaiUniquement: string[];
  /**
   * false quand la fonctionnalité d'essai n'est pas déployée sur cette base ou
   * que la lecture a échoué. Dans ce cas rien n'est masqué : une liste
   * d'exploitation ne doit jamais rétrécir à cause d'un calcul décoratif.
   */
  exploitable: boolean;
}

const PORTEE_VIDE: PorteeEssai = {
  subscriptionIds: [],
  clientIds: [],
  clientsEssaiUniquement: [],
  exploitable: false,
};

/**
 * Lit une bonne fois ce qui, dans le parc, provient d'un essai gratuit déployé.
 *
 * Trois lectures indexées au plus (une seule quand aucun essai n'existe) pour
 * toute une page, quel que soit le nombre de lignes affichées.
 */
export async function porteeEssaiDeploye(db: any): Promise<PorteeEssai> {
  if (!db?.freeTrialRequest) return PORTEE_VIDE;
  try {
    // Seules les demandes DÉPLOYÉES ont ouvert un accès. Une demande en
    // attente ou refusée n'a créé ni compte ni forfait : la compter ici
    // masquerait des lignes qui n'ont rien à voir avec un essai.
    const demandes = await db.freeTrialRequest.findMany({
      where: { status: STATUT_DEMANDE.DEPLOYED },
      select: { clientId: true, subscriptionId: true },
    });
    const clientIds = [...new Set(
      (demandes as any[]).map((d) => d.clientId).filter(Boolean).map(String),
    )];
    const subscriptionIds = [...new Set(
      (demandes as any[]).map((d) => d.subscriptionId).filter(Boolean).map(String),
    )];
    if (clientIds.length === 0) {
      return { subscriptionIds, clientIds, clientsEssaiUniquement: [], exploitable: true };
    }

    // Un compte qui dispose d'un accès ORDINAIRE — un forfait qui n'est pas né
    // d'un essai, ou un volume attribué directement sur le compte — est un
    // client comme les autres : l'essai n'est qu'un épisode de son histoire.
    // Le doute profite toujours à l'affichage : mieux vaut montrer une ligne de
    // trop que perdre de vue un vrai client.
    const forfaitsEssai = new Set(subscriptionIds);
    const convertis = new Set<string>();
    if (db.subscription) {
      const forfaits = await db.subscription.findMany({
        where: { clientId: { in: clientIds } },
        select: { id: true, clientId: true },
      });
      for (const forfait of forfaits as any[]) {
        if (!forfaitsEssai.has(String(forfait.id))) convertis.add(String(forfait.clientId));
      }
    }
    if (db.vpnClient) {
      // Volume attribué au COMPTE lui-même (`quotaSource: "client"` côté
      // appareils) : c'est un accès ordinaire, sans forfait, et le manquer
      // ferait disparaître un client payant de l'exploitation.
      const comptes = await db.vpnClient.findMany({
        where: { id: { in: clientIds } },
        select: { id: true, quotaTotal: true },
      });
      for (const compte of comptes as any[]) {
        if (compte.quotaTotal !== null && compte.quotaTotal !== undefined && BigInt(compte.quotaTotal) > BigInt(0)) {
          convertis.add(String(compte.id));
        }
      }
    }

    return {
      subscriptionIds,
      clientIds,
      clientsEssaiUniquement: clientIds.filter((id) => !convertis.has(id)),
      exploitable: true,
    };
  } catch (erreur) {
    console.error("free-trial scope error:", erreur);
    return PORTEE_VIDE;
  }
}

/**
 * Le demandeur a-t-il explicitement demandé à REVOIR les essais ?
 *
 * L'absence de paramètre vaut « oui » : aucune route HTTP ne change de sens
 * pour les appelants qui existaient avant cette correction (annonces, mises à
 * jour, bons, jetons, indicateurs d'accueil…). Ce sont les trois écrans
 * d'exploitation nommés par le propriétaire qui demandent explicitement
 * `includeFreeTrial=false`, et leur interrupteur est TOUJOURS sur « masqué » à
 * l'ouverture.
 */
export function inclutEssaisGratuits(valeur: unknown): boolean {
  if (valeur === undefined || valeur === null) return true;
  const brut = Array.isArray(valeur) ? valeur[0] : valeur;
  const texte = String(brut).trim().toLowerCase();
  if (texte === "") return true;
  return !["0", "false", "no", "off", "non"].includes(texte);
}

/**
 * Contrainte « tout sauf ces identifiants », ou `null` quand il n'y a rien à
 * retrancher — un `notIn: []` inutile alourdirait chaque requête.
 */
export function exclureIdentifiants(champ: string, ids: ReadonlyArray<string>): Record<string, unknown> | null {
  return ids.length ? { [champ]: { notIn: [...ids] } } : null;
}

/**
 * Combine des filtres Prisma sans jamais en perdre un.
 *
 * `{ ...a, ...b }` écraserait silencieusement une clé commune — typiquement
 * `id` — et rendrait une liste trop large. Un `AND` explicite ne peut pas se
 * tromper, et rendre `undefined` quand il n'y a rien à filtrer laisse la
 * requête d'origine strictement inchangée.
 */
export function etFiltres(
  ...filtres: Array<Record<string, unknown> | null | undefined>
): Record<string, unknown> | undefined {
  const retenus = filtres.filter((filtre): filtre is Record<string, unknown> => !!filtre);
  if (retenus.length === 0) return undefined;
  if (retenus.length === 1) return retenus[0];
  return { AND: retenus };
}


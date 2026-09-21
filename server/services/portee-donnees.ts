/**
 * Portée des données par rôle — point unique du cloisonnement.
 *
 * Chaque rôle d'exploitation travaille dans son propre compartiment. Avant ce
 * module, la règle était réécrite route par route : le revendeur était cloisonné
 * à cinq endroits, l'administrateur nulle part, et toute route oubliée rendait
 * le parc entier. La règle vit désormais ici, et les routes la lisent.
 *
 * Les quatre compartiments :
 *
 *  • OWNER       — voit tout, sans exception, y compris ses propres clients.
 *  • SUPER_ADMIN — voit tout SAUF ce qui appartient au OWNER.
 *  • ADMIN       — ne voit que ce qu'il gère lui-même. Un administrateur
 *                  nouvellement créé part donc d'un écran vide, et n'apprend
 *                  rien de ce que font le super-administrateur ou ses pairs.
 *  • RESELLER    — ne voit que ses clients (règle préexistante, conservée).
 *
 * Le filtrage se fait à la LECTURE. Aucune donnée n'est supprimée ni déplacée :
 * un client invisible pour un rôle reste intact pour les autres.
 */
import { FURTIVITE_OWNER, OWNER_ROLE } from '../middleware/rbac/owner';
import { chargerFicheRevendeur } from './reseller-access';
import { porteeClientsRevendeur } from './reseller-state';

export const ROLE_ADMIN = 'ADMIN';
export const ROLE_SUPER_ADMIN = 'SUPER_ADMIN';
export const ROLE_RESELLER = 'RESELLER';

export interface Requerant {
  userId?: string | null;
  role?: string | null;
}

export { FURTIVITE_OWNER };

/**
 * Portée vide.
 *
 * Renvoyée quand le requérant ne peut être rattaché à aucun compartiment. Un
 * filtre vide `{}` rendrait au contraire la plateforme entière : en cas de
 * doute, on ne montre rien.
 */
export const AUCUN_CLIENT: Record<string, unknown> = { id: '__aucun__' };

/** Le requérant est-il affranchi de tout cloisonnement ? */
export function voitTout(role?: string | null): boolean {
  return role === OWNER_ROLE;
}

/** Le requérant travaille-t-il dans un compartiment qui lui est propre ? */
export function estCloisonne(role?: string | null): boolean {
  return role === ROLE_ADMIN || role === ROLE_RESELLER;
}

/**
 * Filtre Prisma restreignant les clients au compartiment du requérant.
 *
 * `null` signifie « aucune restriction » et n'est renvoyé que pour le OWNER.
 * Les appelants combinent ce filtre avec les leurs via `etFiltres`.
 */
export async function porteeClients(
  prisma: any,
  requerant: Requerant | null | undefined,
): Promise<Record<string, unknown> | null> {
  const role = requerant?.role ?? null;
  if (voitTout(role)) return null;

  if (role === ROLE_RESELLER) {
    const fiche = await chargerFicheRevendeur(prisma, requerant?.userId ?? undefined);
    return porteeClientsRevendeur(fiche) as Record<string, unknown>;
  }

  if (role === ROLE_ADMIN) {
    // Sans identité exploitable, on refuse plutôt que d'ouvrir le parc.
    if (!requerant?.userId) return AUCUN_CLIENT;
    return { AND: [FURTIVITE_OWNER, { managedById: requerant.userId }] };
  }

  return FURTIVITE_OWNER;
}

/**
 * Même portée, exprimée depuis un modèle qui pointe vers le client.
 *
 * Un forfait, une session d'activation, un jeton ou un bon n'ont pas de
 * gestionnaire : ils héritent de celui de leur client. Sans ce passage par la
 * relation, chacune de ces listes rendait tout le parc à un administrateur dont
 * la liste de clients était pourtant vide — et laissait voir le parc du
 * propriétaire à tout le monde.
 *
 * `relation` nomme le champ qui mène au client. Il vaut `client` presque
 * partout, mais certaines tables l'appellent autrement.
 */
export async function porteeSousClient(
  prisma: any,
  requerant: Requerant | null | undefined,
  relation = 'client',
): Promise<Record<string, unknown> | null> {
  const portee = await porteeClients(prisma, requerant);
  return portee ? { [relation]: portee } : null;
}

/** Alias historique : la portée d'un forfait passe par son client. */
export async function porteeClientsForfait(
  prisma: any,
  requerant: Requerant | null | undefined,
): Promise<Record<string, unknown> | null> {
  return porteeSousClient(prisma, requerant);
}

/**
 * Le requérant possède-t-il ce client ?
 *
 * Contrôle unitaire, pour les routes qui chargent une ligne avant de la
 * modifier : un filtre de liste ne protège pas un accès direct par identifiant.
 */
export function possedeClientCloisonne(
  requerant: Requerant | null | undefined,
  client: {
    managedById?: string | null;
    managedBy?: { role?: { name?: string } | null } | null;
    user?: { role?: { name?: string } | null } | null;
  } | null | undefined,
): boolean {
  if (!client) return false;
  const role = requerant?.role ?? null;
  if (voitTout(role)) return true;
  // Rattaché au OWNER, par son compte porteur ou par son gestionnaire.
  if (client.user?.role?.name === OWNER_ROLE) return false;
  if (client.managedBy?.role?.name === OWNER_ROLE) return false;
  if (role === ROLE_ADMIN) {
    return !!requerant?.userId && client.managedById === requerant.userId;
  }
  return true;
}

/**
 * Identifiant du gestionnaire à inscrire sur un client que l'on crée.
 *
 * Un ADMIN estampille ses créations : c'est ce qui lui rend son propre parc.
 * Le OWNER estampille les siennes pour la raison inverse — c'est ce qui les
 * rend invisibles aux rôles inférieurs, puisqu'un client créé depuis le
 * panneau reçoit un compte de rôle CLIENT et ne porte sinon aucune trace de
 * lui. Le super-administrateur, lui, ne s'attribue rien : ses clients doivent
 * rester lisibles par ses pairs plutôt que devenir le parc privé de l'un d'eux.
 */
export function gestionnaireAInscrire(requerant: Requerant | null | undefined): string | null {
  const role = requerant?.role ?? null;
  if (role !== ROLE_ADMIN && role !== OWNER_ROLE) return null;
  return requerant?.userId ?? null;
}

/**
 * Portée d'un objet qui porte son AUTEUR, et non un client.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LE MOTIF, ÉCRIT UNE SEULE FOIS
 * ═══════════════════════════════════════════════════════════════════════════
 * Configurations VPN, campagnes d'essai, revendeurs, serveurs, bons : aucun de
 * ces objets n'appartient à un client, donc aucun n'entrait dans le
 * cloisonnement bâti autour de `managedById`. Tous portent en revanche leur
 * auteur, et la règle est identique pour les cinq :
 *
 *   • un ADMIN ne voit que ce qu'il a lui-même créé ;
 *   • les autres rôles non cloisonnés voient tout sauf les créations du
 *     propriétaire ;
 *   • le propriétaire voit tout.
 *
 * L'écrire cinq fois garantissait qu'une des cinq copies finirait par
 * diverger — c'est d'ailleurs ainsi que ce cloisonnement s'était arrêté aux
 * clients. Elle vit donc ici, et chaque surface la nomme.
 *
 * Un objet SANS auteur reste visible des rôles non cloisonnés : les lignes
 * antérieures à ces colonnes n'appartiennent à personne en particulier, et les
 * faire disparaître priverait l'exploitation de son parc existant.
 */
async function porteeParAuteur(
  prisma: any,
  requerant: Requerant | null | undefined,
  champ = 'createdBy',
): Promise<Record<string, unknown> | null> {
  const role = requerant?.role ?? null;
  if (voitTout(role)) return null;

  if (role === ROLE_ADMIN) {
    // Sans identité exploitable, on refuse plutôt que d'ouvrir le catalogue.
    if (!requerant?.userId) return { id: { in: [] } };
    return { [champ]: requerant.userId };
  }

  const proprietaires = await prisma.user.findMany({
    where: { role: { name: OWNER_ROLE } },
    select: { id: true },
  }).catch(() => [] as Array<{ id: string }>);
  const identifiants = proprietaires.map((u: { id: string }) => u.id);
  if (identifiants.length === 0) return null;
  return { OR: [{ [champ]: null }, { [champ]: { notIn: identifiants } }] };
}

/**
 * Portée des CONFIGURATIONS VPN, exprimée sur `VpnProfile`.
 *
 * Le cloisonnement s'était arrêté aux clients et à ce qui pointe vers eux.
 * Les configurations, elles, n'ont pas de client : elles étaient donc rendues
 * ENTIÈREMENT à quiconque détient `vpnprofile.view`. Un administrateur créé
 * pour revendre l'accès voyait ainsi toutes les configurations de la maison —
 * hôtes, ports, noms commerciaux — dès sa première connexion.
 */
export async function porteeProfils(
  prisma: any,
  requerant: Requerant | null | undefined,
): Promise<Record<string, unknown> | null> {
  return porteeParAuteur(prisma, requerant);
}

/**
 * Portée des JETONS D'INVITATION d'essai, exprimée sur `FreeTrialToken`.
 *
 * Toute la surface des essais était traitée comme une exploitation INTERNE
 * indivisible : elle se fermait aux revendeurs, et s'ouvrait entièrement à
 * tous les autres. Mesuré en production, un administrateur créé à l'instant
 * voyait les dix campagnes du super-administrateur et les deux cents
 * inscriptions qu'elles avaient produites — noms et pays compris.
 */
export async function porteeJetonsEssai(
  prisma: any,
  requerant: Requerant | null | undefined,
): Promise<Record<string, unknown> | null> {
  return porteeParAuteur(prisma, requerant);
}

/** Portée des REVENDEURS, exprimée sur `Reseller`. */
export async function porteeRevendeurs(
  prisma: any,
  requerant: Requerant | null | undefined,
): Promise<Record<string, unknown> | null> {
  return porteeParAuteur(prisma, requerant);
}

/** Portée des SERVEURS, exprimée sur `VPSServer`. */
export async function porteeServeurs(
  prisma: any,
  requerant: Requerant | null | undefined,
): Promise<Record<string, unknown> | null> {
  return porteeParAuteur(prisma, requerant);
}

/** Portée des BONS, exprimée sur `Voucher`. */
export async function porteeBons(
  prisma: any,
  requerant: Requerant | null | undefined,
): Promise<Record<string, unknown> | null> {
  return porteeParAuteur(prisma, requerant);
}

/**
 * Portée des COMPTES SSH, exprimée sur `SshAccount` (champ `createdBy`).
 *
 * Les compteurs de `/api/ssh/stats` ne portaient aucune restriction. La table
 * est vide aujourd'hui, donc la fuite ne se voit pas encore — elle apparaîtra
 * au premier compte créé. On ferme avant, pas après.
 */
export async function porteeComptesSsh(
  prisma: any,
  requerant: Requerant | null | undefined,
): Promise<Record<string, unknown> | null> {
  return porteeParAuteur(prisma, requerant);
}

/**
 * Portée des CHARGES UTILES SSH, exprimée sur `SshPayload` (champ `createdBy`).
 *
 * `SshPayload` était le SEUL modèle du domaine moteur sans propriétaire :
 * `VPSServer`, `SshAccount`, `XrayAccount`, `SingboxAccount` et `VpnProfile`
 * portent tous `createdBy`. Un oubli, donc, et non un choix de conception.
 *
 * Une charge utile est l'en-tête d'injection qui fait passer le tunnel chez un
 * opérateur donné : c'est le savoir-faire commercial de l'exploitant, pas un
 * réglage de plateforme. Mesuré en production avec un administrateur neuf :
 * `GET /api/payload` répondait 200 sans aucune restriction.
 *
 * La table est VIDE aujourd'hui (0 charge, y compris pour le haut privilège).
 * C'est précisément pour cela que la colonne est posée maintenant : aucune
 * ligne à rattacher, donc aucun risque de faire disparaître un réglage en
 * service. On ferme avant que la fuite n'ait de quoi s'exprimer.
 */
export async function porteeCharges(
  prisma: any,
  requerant: Requerant | null | undefined,
): Promise<Record<string, unknown> | null> {
  return porteeParAuteur(prisma, requerant);
}

/**
 * Portée des comptes de MOTEUR (`XrayAccount`, `SingboxAccount`).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI LE SEUL `clientId` NE SUFFIT PAS
 * ═══════════════════════════════════════════════════════════════════════════
 * Première tentative : cloisonner par le client servi, seul rattachement que
 * ces tables portaient. Le banc l'a immédiatement refusée — et il avait raison.
 * Le flux normal est de créer l'offre PUIS de l'attribuer : entre les deux, le
 * compte n'a pas de client. Son auteur perdait donc l'accès à ce qu'il venait
 * de créer, et ne pouvait plus ni le modifier ni le supprimer.
 *
 * `createdBy` a été ajouté à ces deux tables (additif, nullable) pour les
 * aligner sur `SshAccount`, qui le portait déjà. Un compte appartient donc à
 * son auteur OU au compartiment du client qu'il sert.
 *
 * On ne restreint QUE les rôles cloisonnés : le propriétaire, le
 * super-administrateur et le support continuent de voir exactement ce qu'ils
 * voyaient, y compris les comptes historiques dont l'auteur est resté nul.
 */
export async function porteeComptesMoteur(
  prisma: any,
  requerant: Requerant | null | undefined,
): Promise<Record<string, unknown> | null> {
  if (!estCloisonne(requerant?.role ?? null)) return null;
  // Sans identité exploitable, on refuse plutôt que d'ouvrir le catalogue.
  if (!requerant?.userId) return { id: { in: [] } };
  const porteeDesClients = await porteeClients(prisma, requerant);
  return {
    OR: [
      { createdBy: requerant.userId },
      ...(porteeDesClients ? [{ client: porteeDesClients }] : []),
    ],
  };
}

/**
 * Portée des COMPTES DE CONNEXION, exprimée sur `User`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA FUITE LA PLUS GRAVE MESURÉE SUR CETTE PLATEFORME
 * ═══════════════════════════════════════════════════════════════════════════
 * `GET /api/users` rendait `user.findMany()` SANS AUCUNE RESTRICTION : seule
 * la furtivité OWNER s'appliquait à la lecture. Mesuré en production avec un
 * administrateur créé à l'instant, propriétaire d'un seul client : 768 comptes
 * rendus — les clients de tous les revendeurs avec leurs adresses, et jusqu'aux
 * autres comptes ADMIN. L'écran « Comptes et accès » lui proposait alors
 * « Tout sélectionner dans le filtre (754) » puis « Supprimer la sélection » :
 * ce n'était donc plus seulement une divulgation, mais un pouvoir de
 * destruction sur le parc d'autrui.
 *
 * Un compte n'a ni gestionnaire ni auteur : il ne peut donc pas passer par
 * `porteeClients` ni par `porteeParAuteur`. Son rattachement s'exprime par ses
 * RELATIONS — le client VPN qu'il incarne, ou la fiche revendeur qu'il porte.
 *
 * Renvoie `null` pour tout rôle autre qu'ADMIN, afin de ne rien changer à ce
 * que voient le propriétaire, le super-administrateur et le support.
 */
export async function porteeComptes(
  _prisma: any,
  requerant: Requerant | null | undefined,
): Promise<Record<string, unknown> | null> {
  if ((requerant?.role ?? null) !== ROLE_ADMIN) return null;
  // Sans identité exploitable, on refuse plutôt que d'ouvrir l'annuaire.
  if (!requerant?.userId) return { id: { in: [] } };
  const moi = requerant.userId;
  return {
    OR: [
      // Son propre compte : il doit toujours se voir lui-même.
      { id: moi },
      // Les comptes des clients VPN qu'il gère.
      { vpnClients: { some: { managedById: moi } } },
      // Les comptes des revendeurs qu'il a créés.
      { resellerInfo: { createdBy: moi } },
    ],
  };
}

/**
 * Identifiant de l'auteur à inscrire sur un objet que l'on crée.
 *
 * Distinct de `gestionnaireAInscrire`, qui ne vaut que pour un client : ici
 * TOUT rôle estampille sa création, y compris le super-administrateur. Sans
 * cela, ses créations seraient dépourvues d'auteur et resteraient visibles
 * d'un administrateur — exactement ce que le cloisonnement doit empêcher.
 */
export function auteurAInscrire(requerant: Requerant | null | undefined): string | null {
  return requerant?.userId ?? null;
}

/**
 * Portée des INSCRIPTIONS d'essai, exprimée sur `FreeTrialRequest`.
 *
 * Une inscription n'a pas d'auteur : personne ne la crée depuis le tableau de
 * bord, c'est l'utilisateur qui la dépose avec un code d'invitation. Elle
 * hérite donc de la campagne qui l'a rendue possible — le jeton.
 *
 * C'est la même mécanique que `porteeSousClient` pour un forfait : l'objet
 * sans propriétaire emprunte celui de l'objet dont il dépend.
 */
export async function porteeDemandesEssai(
  prisma: any,
  requerant: Requerant | null | undefined,
): Promise<Record<string, unknown> | null> {
  const portee = await porteeJetonsEssai(prisma, requerant);
  // La relation porte le nom `trialToken` dans le schéma : `token` y désigne
  // le CODE d'invitation, une chaîne, et filtrer dessus ne lèverait aucune
  // erreur — il ne rendrait simplement jamais rien.
  return portee ? { trialToken: portee } : null;
}

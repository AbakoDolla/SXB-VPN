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
 * Un forfait n'a pas de gestionnaire : il hérite de celui de son client. Sans
 * ce passage par la relation, la liste des forfaits rendait tout le parc à un
 * administrateur dont la liste de clients était pourtant vide.
 */
export async function porteeClientsForfait(
  prisma: any,
  requerant: Requerant | null | undefined,
): Promise<Record<string, unknown> | null> {
  const portee = await porteeClients(prisma, requerant);
  return portee ? { client: portee } : null;
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

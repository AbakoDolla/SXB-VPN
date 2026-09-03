/**
 * roles — source unique de vérité pour les tests de rôle côté interface.
 *
 * Chaque vue recalculait sa propre expression `isAdmin`, huit fois, toutes
 * écrites `ADMIN || SUPER_ADMIN`. Aucune n'incluait OWNER : le propriétaire
 * racine, censé pouvoir tout faire, se voyait masquer les boutons
 * d'administration alors que le serveur, lui, l'autorise (point unique de
 * contournement dans `requirePermission`). L'interface était donc plus
 * restrictive que l'API — un écart invisible et déroutant.
 *
 * Regrouper ces tests ici évite qu'une neuvième copie réintroduise l'oubli.
 */
import { UserRole } from '../types';

type Role = UserRole | string | null | undefined;

/** Propriétaire racine : au-dessus de SUPER_ADMIN, accès à tout. */
export function isOwner(role: Role): boolean {
  return role === UserRole.OWNER;
}

/** SUPER_ADMIN ou au-dessus. */
export function isSuperAdmin(role: Role): boolean {
  return role === UserRole.SUPER_ADMIN || isOwner(role);
}

/**
 * Droit d'administration : ADMIN, SUPER_ADMIN ou OWNER.
 * C'est le test à utiliser pour afficher une commande de gestion.
 */
export function isAdmin(role: Role): boolean {
  return role === UserRole.ADMIN || isSuperAdmin(role);
}

/** Revendeur — périmètre cloisonné à ses propres clients. */
export function isReseller(role: Role): boolean {
  return role === UserRole.RESELLER;
}

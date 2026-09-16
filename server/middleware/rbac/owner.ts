/**
 * OWNER — rôle racine au-dessus de SUPER_ADMIN.
 *
 * Points uniques centralisés :
 *  - `OWNER_ROLE` : nom canonique du rôle racine.
 *  - `isOwnerRequest(req)` : le requérant authentifié est-il OWNER ?
 *  - `canSeeUser(requester, target)` : stealth produit — un compte OWNER
 *    n'est visible que par un autre OWNER.
 *  - `requireOwner` : middleware Express (OWNER uniquement), utilisé par
 *    les routes d'exploitation (/api/ops/*) et le journal propriétaire.
 */
import { Request, Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../auth";

export const OWNER_ROLE = "OWNER";

/**
 * Exclut ce qui appartient au OWNER, exprimé en filtre Prisma sur `VpnClient`.
 *
 * Deux rattachements, car un client du OWNER peut l'être de deux façons :
 * porté par un compte OWNER, ou créé et géré par lui. Le second est le cas
 * courant — un client créé depuis le panneau reçoit un compte de rôle CLIENT,
 * et la seule trace du propriétaire est son gestionnaire.
 *
 * Défini ici, dans un module sans dépendance de service, pour rester l'unique
 * définition sans créer de cycle d'imports.
 */
export const FURTIVITE_OWNER: Record<string, unknown> = {
  AND: [
    { user: { role: { name: { not: OWNER_ROLE } } } },
    {
      OR: [
        { managedById: null },
        { managedBy: { role: { name: { not: OWNER_ROLE } } } },
      ],
    },
  ],
};

export function isOwnerRole(roleName?: string | null): boolean {
  return roleName === OWNER_ROLE;
}

export function isOwnerRequest(req: { user?: { role?: string } | null }): boolean {
  return isOwnerRole(req.user?.role);
}

/**
 * Stealth : le requérant peut-il voir le compte cible ?
 *   canSeeUser(requester, target) = target.role.name !== 'OWNER' || requester.role.name === 'OWNER'
 * Filtrage à la lecture uniquement — les données ne sont jamais supprimées.
 */
export function canSeeUser(
  requester: { user?: { role?: string } | null },
  target: { role?: { name?: string } | null } | null | undefined
): boolean {
  if (!target) return true;
  const targetRoleName = target.role?.name ?? null;
  if (targetRoleName !== OWNER_ROLE) return true;
  return isOwnerRequest(requester);
}

/** Middleware : route réservée au rôle OWNER (403 sinon). */
export function requireOwner(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "errors.auth.unauthorized", message: "Authorization required" });
    return;
  }
  if (!isOwnerRequest(req)) {
    res.status(403).json({ error: "errors.auth.forbidden", code: "OWNER_ONLY", message: "OWNER access required" });
    return;
  }
  next();
}

import type { AuthenticatedRequest } from "../middleware/auth";

/**
 * Forme unique de l'utilisateur de session renvoyée au tableau de bord.
 *
 * Le tableau de bord remplace l'utilisateur courant par la réponse de chaque
 * route de profil (`onUserUpdated`). Ces routes renvoyaient l'enregistrement
 * brut : `role` y était l'objet Role et `permissions` était absent. Le fournisseur
 * de permissions évalue `permissions.includes(...)` à chaque rendu, si bien
 * qu'enregistrer son profil suffisait à faire tomber toute section vérifiant un
 * droit — écran « Une erreur est survenue » — et à faire perdre son rôle à
 * l'utilisateur jusqu'au rechargement de la page.
 *
 * Le rôle et les droits viennent de `req.user`, seule source qui applique les
 * règles d'authentification (rôle effectif, révocation de compte, revendeur sans
 * fiche ramené à CLIENT) : les recopier depuis la base contournerait ce contrôle.
 */
export function sessionUser(user: any, req: AuthenticatedRequest) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: req.user?.role ?? null,
    status: user.status ?? null,
    permissions: req.user?.permissions ?? [],
    avatarUrl: user.avatarUrl ?? null,
    phone: user.phone ?? null,
  };
}

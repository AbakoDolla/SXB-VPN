import { createContext, useContext, type ReactNode } from "react";
import { UserRole } from "../types";

const PermissionsContext = createContext<(permission: string) => boolean>(() => false);

export function PermissionsProvider({ role, permissions, children }: {
  role: UserRole;
  permissions: string[];
  children: ReactNode;
}) {
  // Cette fonction est évaluée pendant le rendu de chaque section qui vérifie un
  // droit. Une liste absente y levait une exception, donc l'écran « Une erreur
  // est survenue » sur toute la section plutôt qu'un simple bouton indisponible.
  // Un droit inconnu se refuse ; il ne se lance pas.
  const granted = Array.isArray(permissions) ? permissions : [];
  return <PermissionsContext.Provider value={permission =>
    role === UserRole.OWNER || granted.includes(permission)
  }>{children}</PermissionsContext.Provider>;
}

export const usePermissions = () => useContext(PermissionsContext);

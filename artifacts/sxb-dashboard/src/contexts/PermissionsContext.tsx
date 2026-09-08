import { createContext, useContext, type ReactNode } from "react";
import { UserRole } from "../types";

const PermissionsContext = createContext<(permission: string) => boolean>(() => false);

export function PermissionsProvider({ role, permissions, children }: {
  role: UserRole;
  permissions: string[];
  children: ReactNode;
}) {
  return <PermissionsContext.Provider value={permission =>
    role === UserRole.OWNER || permissions.includes(permission)
  }>{children}</PermissionsContext.Provider>;
}

export const usePermissions = () => useContext(PermissionsContext);

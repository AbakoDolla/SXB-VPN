import { RBACRole, AppPermission } from "../types";
import { apiRequest } from "./client";

export async function fetchRoles(): Promise<RBACRole[]> {
  try {
    const data = await apiRequest<RBACRole[] | { roles: RBACRole[] }>("/rbac/roles");
    return Array.isArray(data) ? data : (data.roles || []);
  } catch (error) {
    console.error("Error fetching roles:", error);
    return [];
  }
}

export async function fetchPermissions(): Promise<AppPermission[]> {
  try {
    // L API retourne un tableau direct OU { permissions: [...] }
    const data = await apiRequest<AppPermission[] | { permissions: AppPermission[] }>("/rbac/permissions");
    return Array.isArray(data) ? data : (data.permissions || []);
  } catch (error) {
    console.error("Error fetching permissions:", error);
    return [];
  }
}

export async function updateRolePermissions(roleId: string, permissionCodes: string[]): Promise<RBACRole> {
  // Envoyer à la fois permissionIds et permissions pour compatibilité
  return await apiRequest<RBACRole>(`/rbac/roles/${roleId}`, {
    method: "PATCH",
    body: { permissions: permissionCodes, permissionIds: permissionCodes },
  });
}

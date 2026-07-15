import { RBACRole, AppPermission } from "../types";
import { apiRequest } from "./client";

export async function fetchRoles(): Promise<RBACRole[]> {
  try {
    const data = await apiRequest<{ roles: RBACRole[] }>("/rbac/roles");
    return data.roles || [];
  } catch (error) {
    console.error("Error fetching roles:", error);
    return [];
  }
}

export async function fetchPermissions(): Promise<AppPermission[]> {
  try {
    const data = await apiRequest<{ permissions: AppPermission[] }>("/rbac/permissions");
    return data.permissions || [];
  } catch (error) {
    console.error("Error fetching permissions:", error);
    return [];
  }
}

export async function updateRolePermissions(roleId: string, permissions: string[]): Promise<RBACRole> {
  return await apiRequest<RBACRole>(`/rbac/roles/${roleId}`, {
    method: "PATCH",
    body: { permissions },
  });
}

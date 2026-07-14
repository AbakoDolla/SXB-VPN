import { User, UserRole } from "../types";
import { getCurrentUser, saveCurrentUser, logActivity } from "./db";

export async function login(email: string, role: UserRole): Promise<User> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const permissionsMap: Record<UserRole, string[]> = {
        [UserRole.ADMIN]: [
          "clients:read", "clients:write",
          "resellers:read", "resellers:write",
          "servers:read", "servers:write",
          "xpanel:read", "xpanel:write",
          "tokens:read", "tokens:write",
          "vouchers:read", "vouchers:write",
          "rbac:read", "rbac:write",
          "analytics:read",
        ],
        [UserRole.SUPPORT]: [
          "clients:read",
          "resellers:read",
          "servers:read",
          "tokens:read",
          "analytics:read",
        ],
        [UserRole.RESELLER]: [
          "clients:read", "clients:write",
          "tokens:read", "tokens:write",
          "analytics:read",
        ],
      };

      const user: User = {
        id: `user-${role.toLowerCase()}`,
        name: `${role.charAt(0) + role.slice(1).toLowerCase()} SXB`,
        email: email || `${role.toLowerCase()}@sxb-vpn.com`,
        role,
        permissions: permissionsMap[role],
      };

      saveCurrentUser(user);
      logActivity(`Connexion réussie en tant que ${role}`, user.name, "success");
      resolve(user);
    }, 300);
  });
}

export async function getSessionUser(): Promise<User | null> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(getCurrentUser());
    }, 100);
  });
}

export async function updateProfile(name: string, email: string): Promise<User> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const user = getCurrentUser();
      user.name = name;
      user.email = email;
      saveCurrentUser(user);
      logActivity(`Mise à jour du profil utilisateur`, user.name, "info");
      resolve(user);
    }, 200);
  });
}

export async function logout(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const user = getCurrentUser();
      logActivity(`Déconnexion de la session`, user.name, "info");
      resolve();
    }, 150);
  });
}

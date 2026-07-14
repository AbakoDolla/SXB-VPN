import { RBACRole, AppPermission, UserRole } from "../types";
import { getCurrentUser, logActivity } from "./db";

// Memory storage for roles definitions so edits persist during the active browser session
const initialRoles: RBACRole[] = [
  {
    id: "role-admin",
    name: UserRole.ADMIN,
    permissions: [
      "clients:read", "clients:write",
      "resellers:read", "resellers:write",
      "servers:read", "servers:write",
      "xpanel:read", "xpanel:write",
      "tokens:read", "tokens:write",
      "vouchers:read", "vouchers:write",
      "rbac:read", "rbac:write",
      "analytics:read",
    ],
  },
  {
    id: "role-support",
    name: UserRole.SUPPORT,
    permissions: [
      "clients:read",
      "resellers:read",
      "servers:read",
      "tokens:read",
      "analytics:read",
    ],
  },
  {
    id: "role-reseller",
    name: UserRole.RESELLER,
    permissions: [
      "clients:read", "clients:write",
      "tokens:read", "tokens:write",
      "analytics:read",
    ],
  },
];

let rbacRoles = [...initialRoles];

const systemPermissions: AppPermission[] = [
  { id: "p1", code: "clients:read", description: "Consulter la liste et les détails des clients VPN", category: "Clients" },
  { id: "p2", code: "clients:write", description: "Créer, suspendre, renouveler et supprimer des clients", category: "Clients" },
  { id: "p3", code: "resellers:read", description: "Voir la liste des revendeurs et leurs crédits", category: "Revendeurs" },
  { id: "p4", code: "resellers:write", description: "Créer et modifier des comptes de revendeurs", category: "Revendeurs" },
  { id: "p5", code: "servers:read", description: "Surveiller les nœuds VPS et la charge serveur", category: "Serveurs" },
  { id: "p6", code: "servers:write", description: "Ajouter, éditer ou retirer des serveurs VPS", category: "Serveurs" },
  { id: "p7", code: "xpanel:read", description: "Consulter l'état de synchronisation XPanel", category: "XPanel" },
  { id: "p8", code: "xpanel:write", description: "Forcer la synchronisation avec XPanel", category: "XPanel" },
  { id: "p9", code: "tokens:read", description: "Consulter la liste des tokens d'accès SXB", category: "Tokens" },
  { id: "p10", code: "tokens:write", description: "Générer, révoquer ou assigner des tokens", category: "Tokens" },
  { id: "p11", code: "vouchers:read", description: "Consulter les vouchers prépayés", category: "Vouchers" },
  { id: "p12", code: "vouchers:write", description: "Créer ou détruire des codes vouchers", category: "Vouchers" },
  { id: "p13", code: "rbac:read", description: "Consulter la matrice d'habilitation RBAC", category: "Sécurité" },
  { id: "p14", code: "rbac:write", description: "Modifier les permissions attribuées aux rôles", category: "Sécurité" },
  { id: "p15", code: "analytics:read", description: "Accéder aux statistiques globales de consommation", category: "Statistiques" },
];

export async function fetchRoles(): Promise<RBACRole[]> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(rbacRoles);
    }, 150);
  });
}

export async function fetchPermissions(): Promise<AppPermission[]> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(systemPermissions);
    }, 100);
  });
}

export async function updateRolePermissions(roleId: string, permissions: string[]): Promise<RBACRole> {
  const currentUser = getCurrentUser();
  if (currentUser.role !== UserRole.ADMIN) {
    throw new Error("Accès refusé : Seul l'administrateur système peut altérer les règles d'habilitation RBAC.");
  }

  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const index = rbacRoles.findIndex((r) => r.id === roleId);
      if (index === -1) return reject(new Error("Rôle non trouvé"));
      
      rbacRoles[index].permissions = permissions;
      const updated = rbacRoles[index];
      
      const actor = currentUser.name;
      logActivity(`Modification de la matrice RBAC pour le rôle ${updated.name}`, actor, "warning");
      resolve(updated);
    }, 200);
  });
}

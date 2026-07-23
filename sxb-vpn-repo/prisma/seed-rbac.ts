/**
 * RBAC Seed - Initialize roles and permissions
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('=== Initializing RBAC System ===');

  // Create Roles
  const roles = {
    ADMIN: await prisma.role.upsert({
      where: { name: 'ADMIN' },
      update: {},
      create: { name: 'ADMIN', description: 'Administrateur - Acces complet' },
    }),
    SUPPORT: await prisma.role.upsert({
      where: { name: 'SUPPORT' },
      update: {},
      create: { name: 'SUPPORT', description: 'Support - Acces limite' },
    }),
    RESELLER: await prisma.role.upsert({
      where: { name: 'RESELLER' },
      update: {},
      create: { name: 'RESELLER', description: 'Revendeur - Acces clients' },
    }),
  };

  console.log('Roles created:', Object.keys(roles));

  // Define all permissions
  const allPermissions = [
    // Users
    { name: 'users.view', description: 'Voir les utilisateurs' },
    { name: 'users.create', description: 'Creer utilisateurs' },
    { name: 'users.edit', description: 'Modifier utilisateurs' },
    { name: 'users.delete', description: 'Supprimer utilisateurs' },
    
    // Clients
    { name: 'clients.view', description: 'Voir clients' },
    { name: 'clients.view_own', description: 'Voir ses propres clients' },
    { name: 'clients.create', description: 'Creer clients' },
    { name: 'clients.edit', description: 'Modifier clients' },
    { name: 'clients.delete', description: 'Supprimer clients' },
    
    // VPN
    { name: 'vpn.view', description: 'Voir VPN' },
    { name: 'vpn.manage', description: 'Gerer VPN' },
    
    // Servers
    { name: 'servers.view', description: 'Voir serveurs' },
    { name: 'servers.create', description: 'Creer serveurs' },
    { name: 'servers.edit', description: 'Modifier serveurs' },
    { name: 'servers.delete', description: 'Supprimer serveurs' },
    
    // Tokens
    { name: 'tokens.view', description: 'Voir tokens' },
    { name: 'tokens.create', description: 'Creer tokens' },
    { name: 'tokens.revoke', description: 'Revoquer tokens' },
    
    // Vouchers
    { name: 'vouchers.view', description: 'Voir vouchers' },
    { name: 'vouchers.create', description: 'Creer vouchers' },
    { name: 'vouchers.redeem', description: 'Utiliser vouchers' },
    
    // Resellers
    { name: 'resellers.view', description: 'Voir revendeurs' },
    { name: 'resellers.create', description: 'Creer revendeurs' },
    { name: 'resellers.manage', description: 'Gerer revendeurs' },
    
    // Analytics
    { name: 'analytics.view', description: 'Voir analytiques' },
    
    // RBAC
    { name: 'rbac.manage', description: 'Gerer RBAC' },
    
    // Settings
    { name: 'settings.manage', description: 'Gerer parametres' },
  ];

  // Create permissions
  const createdPermissions: Record<string, any> = {};
  for (const perm of allPermissions) {
    const p = await prisma.permission.upsert({
      where: { name: perm.name },
      update: {},
      create: perm,
    });
    createdPermissions[perm.name] = p;
  }
  console.log('Permissions created:', Object.keys(createdPermissions).length);

  // Clear existing role permissions
  await prisma.rolePermission.deleteMany({});
  console.log('Existing role permissions cleared');

  // ADMIN - Full access
  const adminPerms = [
    'users.view', 'users.create', 'users.edit', 'users.delete',
    'clients.view', 'clients.view_own', 'clients.create', 'clients.edit', 'clients.delete',
    'vpn.view', 'vpn.manage',
    'servers.view', 'servers.create', 'servers.edit', 'servers.delete',
    'tokens.view', 'tokens.create', 'tokens.revoke',
    'vouchers.view', 'vouchers.create', 'vouchers.redeem',
    'resellers.view', 'resellers.create', 'resellers.manage',
    'analytics.view', 'rbac.manage', 'settings.manage',
  ];
  for (const permName of adminPerms) {
    if (createdPermissions[permName]) {
      await prisma.rolePermission.create({
        data: { roleId: roles.ADMIN.id, permissionId: createdPermissions[permName].id },
      });
    }
  }
  console.log('ADMIN permissions assigned:', adminPerms.length);

  // SUPPORT - Limited access
  const supportPerms = [
    'clients.view', 'clients.edit',
    'vpn.view',
    'tokens.view',
    'analytics.view',
  ];
  for (const permName of supportPerms) {
    if (createdPermissions[permName]) {
      await prisma.rolePermission.create({
        data: { roleId: roles.SUPPORT.id, permissionId: createdPermissions[permName].id },
      });
    }
  }
  console.log('SUPPORT permissions assigned:', supportPerms.length);

  // RESELLER - Client management only
  const resellerPerms = [
    'clients.view_own', 'clients.create',
    'tokens.create',
    'vouchers.view', 'vouchers.redeem',
    'analytics.view',
  ];
  for (const permName of resellerPerms) {
    if (createdPermissions[permName]) {
      await prisma.rolePermission.create({
        data: { roleId: roles.RESELLER.id, permissionId: createdPermissions[permName].id },
      });
    }
  }
  console.log('RESELLER permissions assigned:', resellerPerms.length);

  console.log('=== RBAC System Initialized ===');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.(); });

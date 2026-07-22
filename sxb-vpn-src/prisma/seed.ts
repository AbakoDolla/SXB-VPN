import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('=== SXB VPN - Initialisation de la base de données ===\n');

  // ─── 1. ROLES ───────────────────────────────────────────────────
  console.log('[1/5] Création des rôles RBAC...');

  const superAdminRole = await prisma.role.upsert({
    where: { name: 'SUPER_ADMIN' },
    update: { description: 'Super Administrateur — Accès total et irrestricted' },
    create: { name: 'SUPER_ADMIN', description: 'Super Administrateur — Accès total et irrestricted' },
  });

  const adminRole = await prisma.role.upsert({
    where: { name: 'ADMIN' },
    update: {},
    create: { name: 'ADMIN', description: 'Administrateur — Gestion complète sauf secrets système' },
  });

  const supportRole = await prisma.role.upsert({
    where: { name: 'SUPPORT' },
    update: {},
    create: { name: 'SUPPORT', description: 'Support — Consultation clients et assistance' },
  });

  const resellerRole = await prisma.role.upsert({
    where: { name: 'RESELLER' },
    update: {},
    create: { name: 'RESELLER', description: 'Revendeur — Gestion de ses propres clients' },
  });

  console.log('  ✓ SUPER_ADMIN, ADMIN, SUPPORT, RESELLER créés\n');

  // ─── 2. PERMISSIONS ─────────────────────────────────────────────
  console.log('[2/5] Création des permissions...');

  const allPermissions = [
    // Users
    { name: 'users.view',     description: 'Voir les utilisateurs du dashboard' },
    { name: 'users.create',   description: 'Créer des comptes utilisateur' },
    { name: 'users.edit',     description: 'Modifier des comptes utilisateur' },
    { name: 'users.delete',   description: 'Supprimer des comptes utilisateur' },
    { name: 'users.manage',   description: 'Gestion complète des utilisateurs' },
    // Clients VPN
    { name: 'clients.view',       description: 'Voir tous les clients VPN' },
    { name: 'clients.view_own',   description: 'Voir ses propres clients' },
    { name: 'clients.create',     description: 'Créer des clients VPN' },
    { name: 'clients.edit',       description: 'Modifier des clients VPN' },
    { name: 'clients.delete',     description: 'Supprimer des clients VPN' },
    // Tokens
    { name: 'tokens.view',    description: 'Voir les tokens' },
    { name: 'tokens.create',  description: 'Créer des tokens SXB' },
    { name: 'tokens.revoke',  description: 'Révoquer des tokens' },
    { name: 'tokens.manage',  description: 'Gestion complète des tokens' },
    // Vouchers
    { name: 'vouchers.view',    description: 'Voir les vouchers' },
    { name: 'vouchers.create',  description: 'Créer des vouchers' },
    { name: 'vouchers.redeem',  description: 'Utiliser des vouchers' },
    { name: 'vouchers.manage',  description: 'Gestion complète des vouchers' },
    // Resellers
    { name: 'resellers.view',    description: 'Voir les revendeurs' },
    { name: 'resellers.create',  description: 'Créer des revendeurs' },
    { name: 'resellers.manage',  description: 'Gestion complète des revendeurs' },
    { name: 'reseller.manage',   description: 'Alias gestion revendeur (legacy)' },
    // Servers
    { name: 'servers.view',   description: 'Voir les serveurs' },
    { name: 'servers.create', description: 'Créer des serveurs' },
    { name: 'servers.edit',   description: 'Modifier des serveurs' },
    { name: 'servers.delete', description: 'Supprimer des serveurs' },
    { name: 'server.manage',  description: 'Alias gestion serveur (legacy)' },
    // Analytics
    { name: 'analytics.view', description: 'Voir les analytiques et logs' },
    // RBAC
    { name: 'ssh.view',       description: 'Voir les comptes SSH' },
    { name: 'ssh.manage',     description: 'Gérer les comptes SSH' },
    { name: 'payload.view',   description: 'Voir les payloads SSH' },
    { name: 'payload.manage', description: 'Gérer les payloads SSH' },
    { name: 'xray.view',      description: 'Voir les comptes Xray' },
    { name: 'xray.manage',    description: 'Gérer les comptes Xray' },
    { name: 'singbox.view',   description: 'Voir les comptes Sing-box' },
    { name: 'singbox.manage', description: 'Gérer les comptes Sing-box' },
    { name: 'rbac.manage',    description: 'Gérer les rôles et permissions' },
    // Settings
    { name: 'settings.manage', description: 'Modifier les paramètres système' },
    // Config
    { name: 'config.view',   description: 'Voir les configurations système' },
  ];

  for (const perm of allPermissions) {
    await prisma.permission.upsert({
      where: { name: perm.name },
      update: { description: perm.description },
      create: perm,
    });
  }

  console.log(`  ✓ ${allPermissions.length} permissions créées\n`);

  // ─── 3. ATTRIBUTION DES PERMISSIONS PAR RÔLE ────────────────────
  console.log('[3/5] Attribution des permissions aux rôles...');

  const allPerms = await prisma.permission.findMany();
  const permMap = Object.fromEntries(allPerms.map(p => [p.name, p.id]));

  // SUPER_ADMIN — toutes les permissions
  for (const perm of allPerms) {
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: superAdminRole.id, permissionId: perm.id } },
      update: {},
      create: { roleId: superAdminRole.id, permissionId: perm.id },
    });
  }

  // ADMIN — tout sauf rbac.manage et settings.manage (limité)
  const adminPermissions = allPerms.filter(p => !['rbac.manage', 'config.view'].includes(p.name));
  for (const perm of adminPermissions) {
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: adminRole.id, permissionId: perm.id } },
      update: {},
      create: { roleId: adminRole.id, permissionId: perm.id },
    });
  }

  // SUPPORT — consultation seulement
  const supportPerms = [
    'clients.view', 'clients.view_own', 'clients.edit',
    'tokens.view', 'vouchers.view',
    'resellers.view', 'servers.view',
    'analytics.view', 'users.view',
  ];
  for (const permName of supportPerms) {
    if (!permMap[permName]) continue;
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: supportRole.id, permissionId: permMap[permName] } },
      update: {},
      create: { roleId: supportRole.id, permissionId: permMap[permName] },
    });
  }

  // RESELLER — gestion de ses propres clients + tokens
  const resellerPerms = [
    'clients.view_own', 'clients.create', 'clients.edit',
    'tokens.view', 'tokens.create', 'tokens.manage',
    'vouchers.view', 'vouchers.redeem',
    'resellers.view',
  ];
  for (const permName of resellerPerms) {
    if (!permMap[permName]) continue;
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: resellerRole.id, permissionId: permMap[permName] } },
      update: {},
      create: { roleId: resellerRole.id, permissionId: permMap[permName] },
    });
  }

  console.log('  ✓ Permissions attribuées à tous les rôles\n');

  // ─── 4. COMPTES UTILISATEURS ─────────────────────────────────────
  console.log('[4/5] Création des comptes administrateurs...');

  // Super Admin
  const superAdminHash = await bcrypt.hash('SuperAdmin2026!', 12);
  await prisma.user.upsert({
    where: { email: 'superadmin@sxbvpn.com' },
    update: { passwordHash: superAdminHash, roleId: superAdminRole.id, status: 'active' },
    create: {
      name: 'Super Administrateur',
      email: 'superadmin@sxbvpn.com',
      phone: '+00000000000',
      passwordHash: superAdminHash,
      roleId: superAdminRole.id,
      status: 'active',
    },
  });
  console.log('  ✓ superadmin@sxbvpn.com / SuperAdmin2026!');

  // Admin
  const adminHash = await bcrypt.hash('Admin2026!', 12);
  await prisma.user.upsert({
    where: { email: 'admin@sxbvpn.com' },
    update: { passwordHash: adminHash, roleId: adminRole.id },
    create: {
      name: 'Administrateur',
      email: 'admin@sxbvpn.com',
      phone: '+00000000001',
      passwordHash: adminHash,
      roleId: adminRole.id,
      status: 'active',
    },
  });
  console.log('  ✓ admin@sxbvpn.com / Admin2026!');

  // Support
  const supportHash = await bcrypt.hash('Support2026!', 12);
  await prisma.user.upsert({
    where: { email: 'support@sxbvpn.com' },
    update: { passwordHash: supportHash, roleId: supportRole.id, status: 'active' },
    create: {
      name: 'Agent Support',
      email: 'support@sxbvpn.com',
      phone: '+00000000002',
      passwordHash: supportHash,
      roleId: supportRole.id,
      status: 'active',
    },
  });
  console.log('  ✓ support@sxbvpn.com / Support2026!');

  console.log('\n[5/5] Initialisation terminée ✓');

  // ─── RÉSUMÉ ──────────────────────────────────────────────────────
  console.log('\n=== RÉSUMÉ ===');
  console.log('Comptes créés :');
  console.log('  ┌────────────────────────────────┬─────────────────────┬────────────────┐');
  console.log('  │ Email                          │ Mot de passe        │ Rôle           │');
  console.log('  ├────────────────────────────────┼─────────────────────┼────────────────┤');
  console.log('  │ superadmin@sxbvpn.com          │ SuperAdmin2026!     │ SUPER_ADMIN    │');
  console.log('  │ admin@sxbvpn.com               │ Admin2026!          │ ADMIN          │');
  console.log('  │ support@sxbvpn.com             │ Support2026!        │ SUPPORT        │');
  console.log('  └────────────────────────────────┴─────────────────────┴────────────────┘');
  console.log('\n✅ Base de données prête pour la production\n');
}

main()
  .catch((e) => {
    console.error('❌ Erreur de seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

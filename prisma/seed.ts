import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  // Create roles
  const adminRole = await prisma.role.upsert({
    where: { name: 'ADMIN' },
    update: {},
    create: {
      name: 'ADMIN',
      description: 'Administrator with full access',
    },
  });

  const supportRole = await prisma.role.upsert({
    where: { name: 'SUPPORT' },
    update: {},
    create: {
      name: 'SUPPORT',
      description: 'Support staff with limited access',
    },
  });

  const resellerRole = await prisma.role.upsert({
    where: { name: 'RESELLER' },
    update: {},
    create: {
      name: 'RESELLER',
      description: 'Reseller with client management access',
    },
  });

  // Create permissions
  const permissions = [
    'users.view', 'users.create', 'users.edit', 'users.delete',
    'clients.view', 'clients.create', 'clients.edit', 'clients.delete',
    'tokens.view', 'tokens.create', 'tokens.revoke',
    'vouchers.view', 'vouchers.create', 'vouchers.redeem',
    'resellers.view', 'resellers.create', 'resellers.edit',
    'servers.view', 'servers.create', 'servers.edit',
    'xpanel.view', 'xpanel.manage',
    'analytics.view',
    'rbac.manage',
    'settings.manage',
  ];

  for (const permName of permissions) {
    await prisma.permission.upsert({
      where: { name: permName },
      update: {},
      create: { name: permName },
    });
  }

  // Assign all permissions to ADMIN role
  const allPermissions = await prisma.permission.findMany();
  for (const perm of allPermissions) {
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: adminRole.id, permissionId: perm.id } },
      update: {},
      create: { roleId: adminRole.id, permissionId: perm.id },
    });
  }

  // Create admin user
  const adminPassword = await bcrypt.hash('admin123', 12);
  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@sxbvpn.com' },
    update: {},
    create: {
      name: 'Administrator',
      email: 'admin@sxbvpn.com',
      phone: '+00000000000',
      passwordHash: adminPassword,
      roleId: adminRole.id,
      status: 'active',
    },
  });

  console.log('Database seeded successfully!');
  console.log('Admin user created:');
  console.log('  Email: admin@sxbvpn.com');
  console.log('  Password: admin123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

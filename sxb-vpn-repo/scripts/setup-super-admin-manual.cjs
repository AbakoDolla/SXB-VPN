const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  console.log("==================================================");
  console.log("  SXB VPN - SUPER ADMIN SETUP");
  console.log("==================================================\n");

  try {
    // Create SUPER_ADMIN role if not exists
    let superAdminRole = await prisma.role.upsert({
      where: { name: "SUPER_ADMIN" },
      update: {},
      create: {
        name: "SUPER_ADMIN",
        description: "Super Administrator with full system access"
      }
    });
    console.log("✅ SUPER_ADMIN role:", superAdminRole.id);

    // Get all permissions
    const allPermissions = await prisma.permission.findMany();
    console.log(`📋 Found ${allPermissions.length} permissions`);

    // Assign all permissions to SUPER_ADMIN
    for (const perm of allPermissions) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: superAdminRole.id,
            permissionId: perm.id
          }
        },
        update: {},
        create: {
          roleId: superAdminRole.id,
          permissionId: perm.id
        }
      });
    }
    console.log("✅ All permissions assigned to SUPER_ADMIN");

    // Create SUPER_ADMIN user with password SxBvpn2026
    const password = "SxBvpn2026";
    const passwordHash = bcrypt.hashSync(password, 10);

    const superAdmin = await prisma.user.upsert({
      where: { email: "superadmin@sxbvpn.com" },
      update: {
        passwordHash,
        roleId: superAdminRole.id,
        status: "active",
        name: "Super Administrator"
      },
      create: {
        name: "Super Administrator",
        email: "superadmin@sxbvpn.com",
        phone: "+00000000000",
        passwordHash,
        roleId: superAdminRole.id,
        status: "active"
      }
    });

    console.log("\n==================================================");
    console.log("  🎉 SUPER ADMIN READY!");
    console.log("==================================================");
    console.log("\n📧 Email:    superadmin@sxbvpn.com");
    console.log("🔐 Password: SxBvpn2026");
    console.log("\n⚠️  IMPORTANT: Save these credentials securely!");
    console.log("==================================================\n");

  } catch (error) {
    console.error("❌ Setup failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();

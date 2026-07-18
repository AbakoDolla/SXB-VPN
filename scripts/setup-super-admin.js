/**
 * SXB VPN - Super Admin Setup Script
 * Run this ONCE during initial deployment to create the SUPER_ADMIN account
 * 
 * Usage: node scripts/setup-super-admin.js
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function setupSuperAdmin() {
  console.log("==================================================");
  console.log("  SXB VPN - SUPER ADMIN SETUP");
  console.log("==================================================\n");

  try {
    // Check if SUPER_ADMIN role exists
    let superAdminRole = await prisma.role.findUnique({
      where: { name: "SUPER_ADMIN" }
    });

    if (!superAdminRole) {
      console.log("📦 Creating SUPER_ADMIN role...");
      superAdminRole = await prisma.role.create({
        data: {
          name: "SUPER_ADMIN",
          description: "Super Administrator with full system access"
        }
      });
      console.log(`✅ SUPER_ADMIN role created: ${superAdminRole.id}`);
    } else {
      console.log("✅ SUPER_ADMIN role already exists");
    }

    // Get all permissions
    const allPermissions = await prisma.permission.findMany();
    console.log(`📋 Found ${allPermissions.length} permissions in system`);

    // Get existing role permissions for SUPER_ADMIN
    const existingRolePerms = await prisma.rolePermission.findMany({
      where: { roleId: superAdminRole.id }
    });

    // Add all permissions to SUPER_ADMIN if not already present
    const existingPermIds = existingRolePerms.map(rp => rp.permissionId);
    const missingPerms = allPermissions.filter(p => !existingPermIds.includes(p.id));

    if (missingPerms.length > 0) {
      console.log(`🔓 Adding ${missingPerms.length} missing permissions to SUPER_ADMIN...`);
      await prisma.rolePermission.createMany({
        data: missingPerms.map(p => ({
          roleId: superAdminRole.id,
          permissionId: p.id
        }))
      });
      console.log("✅ All permissions granted to SUPER_ADMIN");
    } else {
      console.log("✅ SUPER_ADMIN already has all permissions");
    }

    // Create default SUPER_ADMIN user if none exists
    const existingSuperAdmins = await prisma.user.findMany({
      where: { roleId: superAdminRole.id }
    });

    if (existingSuperAdmins.length === 0) {
      const email = process.env.SUPER_ADMIN_EMAIL || "superadmin@sxbvpn.com";
      const password = process.env.SUPER_ADMIN_PASSWORD || "SxBvpn2026";
      const name = process.env.SUPER_ADMIN_NAME || "Super Administrator";

      console.log("\n📧 Creating default SUPER_ADMIN user...");
      const salt = bcrypt.genSaltSync(10);
      const passwordHash = bcrypt.hashSync(password, salt);

      const superAdmin = await prisma.user.create({
        data: {
          name,
          email,
          phone: process.env.SUPER_ADMIN_PHONE || "+00000000000",
          passwordHash,
          roleId: superAdminRole.id,
          status: "active"
        }
      });

      console.log("\n==================================================");
      console.log("  🎉 SUPER ADMIN CREATED SUCCESSFULLY!");
      console.log("==================================================");
      console.log("\n📧 Email:    " + email);
      console.log("🔐 Password: " + password);
      console.log("\n⚠️  IMPORTANT: Change this password after first login!");
      console.log("⚠️  Set environment variables for production:");
      console.log("    SUPER_ADMIN_EMAIL");
      console.log("    SUPER_ADMIN_PASSWORD");
      console.log("    SUPER_ADMIN_NAME");
      console.log("==================================================\n");
    } else {
      console.log(`✅ ${existingSuperAdmins.length} SUPER_ADMIN(s) already exist:`);
      existingSuperAdmins.forEach(admin => {
        console.log(`   - ${admin.email} (${admin.name})`);
      });
    }

    // Create audit log entry
    await prisma.auditLog.create({
      data: {
        action: "SUPER_ADMIN setup completed",
        type: "success",
        timestamp: new Date()
      }
    });

    console.log("\n✨ Super Admin setup completed successfully!");
  } catch (error) {
    console.error("❌ Setup failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run if called directly
setupSuperAdmin();

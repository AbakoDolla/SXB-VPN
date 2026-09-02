/**
 * SXB VPN - Super Admin Setup Script
 * Idempotent setup for the SUPER_ADMIN role and account.
 * 
 * Usage:
 *   SUPER_ADMIN_EMAIL='…' SUPER_ADMIN_PASSWORD='…' node scripts/setup-super-admin.js
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import "dotenv/config";

const prisma = new PrismaClient();

async function setupSuperAdmin() {
  console.log("==================================================");
  console.log("  SXB VPN - SUPER ADMIN SETUP");
  console.log("==================================================\n");

  try {
    const email = (process.env.SUPER_ADMIN_EMAIL || "").trim().toLowerCase();
    const password = process.env.SUPER_ADMIN_PASSWORD || "";
    const name = (process.env.SUPER_ADMIN_NAME || "Super Administrator").trim();
    const phone = (process.env.SUPER_ADMIN_PHONE || "").trim() || null;

    if (!email || !password) {
      throw new Error("SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD are required");
    }
    if (password.length < 12) {
      throw new Error("SUPER_ADMIN_PASSWORD must contain at least 12 characters");
    }

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

    const passwordHash = await bcrypt.hash(password, 12);
    const superAdmin = await prisma.user.upsert({
      where: { email },
      update: {
        name,
        phone,
        passwordHash,
        roleId: superAdminRole.id,
        status: "active"
      },
      create: {
        name,
        email,
        phone,
        passwordHash,
        roleId: superAdminRole.id,
        status: "active"
      }
    });

    console.log(`✅ SUPER_ADMIN ready: ${superAdmin.email}`);
    console.log("🔐 Password accepted from the environment and not displayed");

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
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Run if called directly
setupSuperAdmin();

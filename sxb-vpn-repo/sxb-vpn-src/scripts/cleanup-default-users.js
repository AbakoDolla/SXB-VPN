/**
 * SXB VPN - Cleanup Default Users Script
 * 
 * Removes all default users except SUPER_ADMIN
 * SUPER_ADMIN is the only default user - ADMIN creates all others
 * 
 * Usage: node scripts/cleanup-default-users.js
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function cleanup() {
  console.log("==================================================");
  console.log("  SXB VPN - CLEANUP DEFAULT USERS");
  console.log("==================================================\n");

  try {
    // Find SUPER_ADMIN role
    const superAdminRole = await prisma.role.findUnique({
      where: { name: "SUPER_ADMIN" }
    });

    if (!superAdminRole) {
      console.log("❌ SUPER_ADMIN role not found. Run setup-super-admin.js first.");
      process.exit(1);
    }

    // Find all users except SUPER_ADMIN
    const usersToDelete = await prisma.user.findMany({
      where: {
        roleId: { not: superAdminRole.id }
      },
      include: { role: true }
    });

    console.log(`Found ${usersToDelete.length} users to remove (excluding SUPER_ADMIN):\n`);
    usersToDelete.forEach(u => {
      console.log(`  - ${u.email} (${u.role.name}) - ${u.name}`);
    });

    if (usersToDelete.length === 0) {
      console.log("✅ No users to remove. System is clean.");
    } else {
      // Confirm deletion
      const confirmed = process.argv.includes("--confirm");
      
      if (!confirmed) {
        console.log("\n⚠️  Run with --confirm to actually delete these users.");
        console.log("    Example: node scripts/cleanup-default-users.js --confirm");
      } else {
        // Delete users
        await prisma.user.deleteMany({
          where: {
            roleId: { not: superAdminRole.id }
          }
        });
        
        console.log("\n✅ All non-SUPER_ADMIN users deleted successfully!");
      }
    }

    // List remaining users
    console.log("\n📋 Remaining users in system:");
    const remainingUsers = await prisma.user.findMany({
      include: { role: true }
    });
    remainingUsers.forEach(u => {
      console.log(`  - ${u.email} (${u.role.name}) - ${u.name}`);
    });

    // Create audit log
    await prisma.auditLog.create({
      data: {
        action: `Cleanup removed ${usersToDelete.length} default users`,
        type: "success",
        timestamp: new Date()
      }
    });

    console.log("\n✨ Cleanup completed!");
  } catch (error) {
    console.error("❌ Cleanup failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

cleanup();

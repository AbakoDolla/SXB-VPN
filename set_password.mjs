import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const email = "superadmin@sxbvpn.com";
  const newPassword = "Admin@123456";
  
  const hashedPassword = await bcrypt.hash(newPassword, 12);
  
  await prisma.user.update({
    where: { email },
    data: { passwordHash: hashedPassword }
  });
  
  console.log("✅ Password updated!");
  console.log("📧 Email: superadmin@sxbvpn.com");
  console.log("🔐 Password: Admin@123456");
}

main().catch(console.error).finally(() => prisma.$disconnect());

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const password = await bcrypt.hash('SxBvpn2026', 10);
  
  // Update all existing users
  const users = await prisma.user.findMany();
  for (const user of users) {
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: password }
    });
    console.log('Password updated: ' + user.email);
  }
  
  // List all users
  const allUsers = await prisma.user.findMany({ 
    include: { role: true },
    select: { email: true, role: { select: { name: true } } }
  });
  console.log('\nAll users in database:');
  allUsers.forEach(u => console.log('  - ' + u.email + ' (' + u.role.name + ')'));
  
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });

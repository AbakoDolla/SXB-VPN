/**
 * list-users.cjs — Inventaire en lecture seule des comptes applicatifs
 *
 * ⚠️  CE SCRIPT NE RÉINITIALISE PLUS LES MOTS DE PASSE EXISTANTS.
 *     Il affiche uniquement la liste des utilisateurs en base.
 *
 * Ce script ne contient aucune fonction de modification de mot de passe.
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const allUsers = await prisma.user.findMany({
    include: { role: true },
    select: { email: true, status: true, role: { select: { name: true } } }
  });

  console.log('\nUtilisateurs en base de données :');
  allUsers.forEach(u =>
    console.log(`  - ${u.email}  (rôle: ${u.role?.name})  [${u.status}]`)
  );
  console.log(`\nTotal : ${allUsers.length} utilisateur(s)`);
  console.log('\n⚠️  Aucun mot de passe modifié. Ce script est en lecture seule.');

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });

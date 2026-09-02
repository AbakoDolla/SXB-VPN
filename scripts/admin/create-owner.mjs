/**
 * create-owner.mjs — Création idempotente du compte OWNER (rôle racine).
 *
 * Utilisation (VPS, JAMAIS en CI) :
 *   cd /var/www/sxb-vpn
 *   OWNER_EMAIL='…' OWNER_PASSWORD='…' node scripts/admin/create-owner.mjs
 *   pm2 restart sxb-backend --update-env
 *
 * Règles :
 *   - Identifiants UNIQUEMENT via variables d'environnement (OWNER_EMAIL,
 *     OWNER_PASSWORD) — jamais de secret en clair dans le code ni dans un repo.
 *   - Idempotent : relançable sans risque (upsert par email).
 *   - Hash bcrypt avec un coût de 12.
 *   - Crée le rôle OWNER s'il est absent avec un upsert idempotent.
 *   - Ne journalise JAMAIS le mot de passe.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

const BCRYPT_ROUNDS = 12;
const OWNER_ROLE_NAME = 'OWNER';

const prisma = new PrismaClient();

async function main() {
  const email = (process.env.OWNER_EMAIL || '').trim().toLowerCase();
  const password = process.env.OWNER_PASSWORD || '';

  if (!email || !password) {
    console.error('❌ OWNER_EMAIL et OWNER_PASSWORD doivent être définis dans l’environnement.');
    console.error('   Exemple : OWNER_EMAIL=\'compte@exemple.com\' OWNER_PASSWORD=\'…\' node scripts/admin/create-owner.mjs');
    process.exit(1);
  }
  if (password.length < 12) {
    console.error('❌ OWNER_PASSWORD doit contenir au moins 12 caractères.');
    process.exit(1);
  }

  console.log('🔐 Création/mise à jour du compte OWNER (idempotent)…');

  // 1. Rôle OWNER (upsert — équivalent du bloc SQL idempotent des migrations manuelles)
  const ownerRole = await prisma.role.upsert({
    where: { name: OWNER_ROLE_NAME },
    update: {},
    create: {
      name: OWNER_ROLE_NAME,
      description: 'Propriétaire racine — au-dessus de SUPER_ADMIN (invisible des statistiques et listes)',
    },
  });
  console.log(`  ✓ Rôle OWNER prêt (${ownerRole.id})`);

  // 2. Compte utilisateur OWNER (upsert par email — idempotent)
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await prisma.user.upsert({
    where: { email },
    update: {
      passwordHash,
      roleId: ownerRole.id,
      status: 'active',
    },
    create: {
      name: 'Propriétaire racine',
      email,
      phone: null,
      passwordHash,
      roleId: ownerRole.id,
      status: 'active',
    },
  });

  console.log(`  ✓ Compte OWNER prêt : ${user.email} (rôle ${OWNER_ROLE_NAME}, statut ${user.status})`);
  console.log('✅ Terminé. Redémarrez le backend : pm2 restart sxb-backend --update-env');
  console.log('⚠️  Le mot de passe n’est jamais affiché ni journalisé.');
}

main()
  .catch((err) => {
    console.error('❌ Erreur create-owner:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

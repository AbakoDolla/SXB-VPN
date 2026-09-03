/**
 * seed-owner — amorçage du compte propriétaire racine (OWNER).
 *
 * POURQUOI CE SCRIPT EXISTE
 * -------------------------
 * Le rôle OWNER est le seul au-dessus de SUPER_ADMIN : il contourne toutes les
 * vérifications de permission, reste invisible des listes et des statistiques,
 * et peut mettre le dashboard en pause. Précisément parce qu'il est si
 * puissant, `POST /api/users` refuse de le créer : « seul un OWNER peut créer
 * un compte OWNER » (server/routes/users.ts).
 *
 * D'où une impasse d'amorçage : tant qu'aucun OWNER n'existe, aucun ne peut
 * être créé par l'API. Le premier doit donc être posé hors ligne, ici.
 *
 * SÉCURITÉ
 * --------
 * Le mot de passe n'est JAMAIS écrit dans le dépôt : il est lu dans
 * l'environnement et n'est jamais journalisé. Le script est idempotent — le
 * relancer met à jour le mot de passe sans créer de doublon, ce qui en fait
 * aussi la procédure de récupération si l'accès est perdu.
 *
 * USAGE
 *   OWNER_EMAIL=... OWNER_PASSWORD=... npx tsx prisma/seed-owner.ts
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const OWNER_ROLE = 'OWNER';
const MIN_PASSWORD_LENGTH = 8;
const RECOMMENDED_PASSWORD_LENGTH = 14;

async function main() {
  const email = (process.env.OWNER_EMAIL || '').trim().toLowerCase();
  const password = process.env.OWNER_PASSWORD || '';
  const name = (process.env.OWNER_NAME || 'Propriétaire').trim();

  if (!email || !password) {
    console.error('❌ OWNER_EMAIL et OWNER_PASSWORD sont requis.');
    console.error('   Exemple : OWNER_EMAIL=vous@exemple.com OWNER_PASSWORD=… npx tsx prisma/seed-owner.ts');
    process.exit(1);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error('❌ OWNER_EMAIL n’est pas une adresse valide.');
    process.exit(1);
  }
  // Ce compte peut tout faire et n'apparaît dans aucun journal consultable par
  // les autres rôles : un mot de passe trop court le rendrait indéfendable.
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`❌ OWNER_PASSWORD doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.`);
    console.error('   Ce compte contourne toutes les permissions : sa robustesse conditionne celle de la plateforme.');
    process.exit(1);
  }
  // En dessous du seuil recommandé on avertit sans bloquer : refuser ici
  // laisserait la plateforme sans propriétaire, ce qui est pire.
  if (password.length < RECOMMENDED_PASSWORD_LENGTH) {
    console.warn(`⚠️  Mot de passe court (${password.length} caractères).`);
    console.warn(`   ${RECOMMENDED_PASSWORD_LENGTH}+ caractères sont recommandés pour un compte qui contourne toutes les permissions.`);
  }

  // Le rôle peut manquer si la base a été initialisée avant son introduction.
  const role = await prisma.role.upsert({
    where: { name: OWNER_ROLE },
    update: {},
    create: {
      name: OWNER_ROLE,
      description: 'Propriétaire racine — au-dessus de SUPER_ADMIN (invisible des statistiques et listes)',
    },
  });

  // Aucune permission n'est attribuée volontairement : `requirePermission`
  // contient un point unique de contournement pour OWNER (middleware/auth.ts).
  // Lui poser des lignes RolePermission créerait une seconde source de vérité.
  const passwordHash = await bcrypt.hash(password, 12);
  const existing = await prisma.user.findUnique({
    where: { email },
    include: { role: true },
  });

  if (existing && existing.role?.name !== OWNER_ROLE) {
    console.error(`❌ ${email} existe déjà avec le rôle ${existing.role?.name}.`);
    console.error('   Promouvoir un compte existant en OWNER doit rester un geste délibéré :');
    console.error('   supprimez-le d’abord depuis le dashboard, ou choisissez une autre adresse.');
    process.exit(1);
  }

  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, roleId: role.id, status: 'active' },
    create: { name, email, passwordHash, roleId: role.id, status: 'active' },
  });

  console.log(existing ? '✅ Mot de passe du compte OWNER mis à jour.' : '✅ Compte OWNER créé.');
  console.log(`   Adresse : ${email}`);
  console.log(`   Identifiant : ${user.id}`);
  console.log('   Le mot de passe n’est volontairement pas affiché ni journalisé.');
}

main()
  .catch((e) => {
    console.error('❌ Échec de l’amorçage OWNER :', e?.message || e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

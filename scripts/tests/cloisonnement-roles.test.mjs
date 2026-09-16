/**
 * Cloisonnement par rôle — qui voit quoi, et ce que personne ne doit voir.
 *
 * CE QUI EST VÉRIFIÉ ICI
 * ──────────────────────
 * La vraie fonction de portée du serveur, pas une réécriture : c'est celle que
 * les routes appellent pour construire leur filtre Prisma. On l'exerce contre
 * un parc simulé, puis on vérifie que les routes l'utilisent bien plutôt que
 * de refabriquer leur propre règle dans leur coin.
 *
 * Les invariants tenus :
 *  • un administrateur ne voit que ce qu'il gère, et part donc d'un écran vide ;
 *  • deux administrateurs ne se voient pas l'un l'autre ;
 *  • le parc du propriétaire n'existe pour aucun autre rôle, ni ses quotas ;
 *  • aucun rôle inférieur n'apprend que le rôle OWNER existe ;
 *  • une portée inconnue ne se lit jamais comme « aucune restriction ».
 */
import './register-hooks.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

process.env.JWT_SECRET ||= 'secret-de-test-pour-le-cloisonnement-0123456789';

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(racine, 'backend', 'package.json'));
const lireSource = (relatif) => readFileSync(path.join(racine, relatif), 'utf8');

const sortie = path.join(racine, 'backend', '.sxb-portee-test.cjs');
const { build } = require('esbuild');
await build({
  entryPoints: [path.join(racine, 'server', 'services', 'portee-donnees.ts')],
  outfile: sortie,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  logLevel: 'silent',
});
const portee = require(sortie);
process.on('exit', () => { if (existsSync(sortie)) rmSync(sortie, { force: true }); });

const OWNER = { userId: 'u-owner', role: 'OWNER' };
const SUPER = { userId: 'u-super', role: 'SUPER_ADMIN' };
const ADMIN_A = { userId: 'u-admin-a', role: 'ADMIN' };
const ADMIN_B = { userId: 'u-admin-b', role: 'ADMIN' };

/** Parc simulé : un client par provenance. */
const PARC = [
  { id: 'c-historique', managedById: null, managedBy: null, user: { role: { name: 'CLIENT' } } },
  { id: 'c-du-super', managedById: null, managedBy: null, user: { role: { name: 'CLIENT' } } },
  { id: 'c-admin-a', managedById: 'u-admin-a', managedBy: { role: { name: 'ADMIN' } }, user: { role: { name: 'CLIENT' } } },
  { id: 'c-admin-b', managedById: 'u-admin-b', managedBy: { role: { name: 'ADMIN' } }, user: { role: { name: 'CLIENT' } } },
  { id: 'c-owner', managedById: 'u-owner', managedBy: { role: { name: 'OWNER' } }, user: { role: { name: 'CLIENT' } } },
  { id: 'c-porte-owner', managedById: null, managedBy: null, user: { role: { name: 'OWNER' } } },
];

const visibles = (requerant) => PARC.filter((c) => portee.possedeClientCloisonne(requerant, c)).map((c) => c.id);

test('un administrateur ne voit que le parc qu’il gère', () => {
  // L'écran d'un administrateur nouvellement créé est vide : rien du parc
  // historique, rien de ce qu'a créé le super-administrateur.
  assert.deepEqual(visibles(ADMIN_A), ['c-admin-a']);
  assert.deepEqual(visibles(ADMIN_B), ['c-admin-b']);
});

test('deux administrateurs ne se voient pas', () => {
  assert.ok(!visibles(ADMIN_A).includes('c-admin-b'));
  assert.ok(!visibles(ADMIN_B).includes('c-admin-a'));
});

test('le parc du propriétaire n’existe pour aucun autre rôle', () => {
  // Deux rattachements possibles, et les deux doivent disparaître : le client
  // PORTÉ par un compte OWNER, et celui qu'il a simplement créé — ce dernier
  // reçoit un compte de rôle CLIENT, et c'est le cas courant.
  for (const requerant of [SUPER, ADMIN_A, ADMIN_B]) {
    const vus = visibles(requerant);
    assert.ok(!vus.includes('c-owner'), `${requerant.role} ne doit pas voir le parc géré par le propriétaire`);
    assert.ok(!vus.includes('c-porte-owner'), `${requerant.role} ne doit pas voir le parc porté par le propriétaire`);
  }
});

test('le propriétaire voit tout, sans exception', async () => {
  assert.deepEqual(visibles(OWNER).sort(), PARC.map((c) => c.id).sort());
  assert.equal(await portee.porteeClients(null, OWNER), null, 'aucun filtre ne doit être posé pour le propriétaire');
});

test('le filtre posé en base exclut le propriétaire pour les autres', async () => {
  const filtreSuper = await portee.porteeClients(null, SUPER);
  assert.deepEqual(filtreSuper, portee.FURTIVITE_OWNER);
  const serialise = JSON.stringify(filtreSuper);
  // Les deux rattachements sont bien exprimés côté base, et pas seulement en
  // mémoire : un `count()` ne passe jamais par un filtre appliqué après coup.
  assert.match(serialise, /"managedById":null/);
  assert.match(serialise, /"managedBy"/);
  assert.match(serialise, /"user"/);
});

test('le filtre d’un administrateur porte son identifiant et la furtivité', async () => {
  const filtre = await portee.porteeClients(null, ADMIN_A);
  const serialise = JSON.stringify(filtre);
  assert.match(serialise, /"managedById":"u-admin-a"/);
  // La furtivité reste posée même pour l'administrateur : elle ne dépend pas
  // du hasard qui veut que son identifiant diffère de celui du propriétaire.
  assert.match(serialise, /"not":"OWNER"/);
});

test('une identité sans compte n’ouvre jamais le parc', async () => {
  const filtre = await portee.porteeClients(null, { role: 'ADMIN' });
  assert.deepEqual(filtre, portee.AUCUN_CLIENT);
  // Un filtre vide `{}` rendrait au contraire tout le parc.
  assert.notDeepEqual(filtre, {});
});

test('seuls l’administrateur et le propriétaire estampillent leurs créations', () => {
  // L'administrateur, pour se constituer un parc. Le propriétaire, pour que le
  // sien devienne invisible. Le super-administrateur, jamais : ses clients
  // doivent rester lisibles par ses pairs.
  assert.equal(portee.gestionnaireAInscrire(ADMIN_A), 'u-admin-a');
  assert.equal(portee.gestionnaireAInscrire(OWNER), 'u-owner');
  assert.equal(portee.gestionnaireAInscrire(SUPER), null);
  assert.equal(portee.gestionnaireAInscrire(null), null);
});

test('la portée d’un forfait passe par son client', async () => {
  const filtre = await portee.porteeClientsForfait(null, ADMIN_A);
  assert.ok(filtre && typeof filtre === 'object');
  assert.ok('client' in filtre, 'un forfait n’a pas de gestionnaire : il hérite de celui de son client');
  assert.equal(await portee.porteeClientsForfait(null, OWNER), null);
});

test('les routes lisent la portée centrale au lieu de la refabriquer', () => {
  // Une route qui reconstruit sa propre règle est une route qu'on oubliera de
  // mettre à jour. Les écrans porteurs de données clients doivent tous passer
  // par le même point.
  for (const fichier of [
    'server/routes/clients.ts',
    'server/routes/devices.ts',
    'server/routes/dashboard.ts',
    'server/routes/subscriptions.ts',
  ]) {
    assert.match(lireSource(fichier), /portee-donnees/, `${fichier} doit lire la portée centrale`);
  }
});

test('la colonne de gestionnaire existe dans les DEUX schémas', () => {
  // Le déploiement pousse `backend/prisma/schema.prisma` : une colonne ajoutée
  // uniquement à la racine n'atteint jamais la base, et toute lecture qui s'y
  // réfère échoue en production.
  const racineSchema = lireSource('prisma/schema.prisma');
  const backendSchema = lireSource('backend/prisma/schema.prisma');
  assert.equal(racineSchema, backendSchema, 'les deux schémas doivent rester identiques');
  assert.match(racineSchema, /managedById\s+String\?/);
  assert.match(racineSchema, /@@index\(\[managedById\]\)/);
});

test('le journal d’activité suit le même compartiment', () => {
  const source = lireSource('server/routes/audit-logs.ts');
  // Sans cela, l'accueil d'un administrateur racontait les connexions et les
  // créations du super-administrateur.
  assert.match(source, /role === "ADMIN"/);
  assert.match(source, /visibleOwnerOnly: false/);
});

test('aucun rôle inférieur n’apprend que le propriétaire existe', () => {
  // Trois portes distinctes, et les trois doivent rester fermées : la liste des
  // rôles, la liste des comptes, et le journal d'audit — qui masque
  // automatiquement les traces du propriétaire à l'écriture.
  assert.match(lireSource('server/routes/rbac.ts'), /filter\(\(r\) => r\.name !== OWNER_ROLE\)/);
  assert.match(lireSource('server/middleware/rbac/owner.ts'), /canSeeUser/);
  assert.match(lireSource('server/database.ts'), /visibleOwnerOnly = true/);
});

test('la présence applique le compartiment avant tout rapprochement', () => {
  const source = lireSource('server/services/vpn-presence.ts');
  // Le cloisonnement doit précéder le rapprochement : appliqué après, un
  // administrateur recevrait l'appareil d'un autre avant qu'on le lui retire.
  assert.match(source, /managedById/);
  assert.match(source, /managedByOwner/);
  // Une forme de filtre non reconnue ne doit jamais valoir « tout voir ».
  assert.match(source, /return false;/);
});

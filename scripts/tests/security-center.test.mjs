/**
 * Centre de sécurité — le verrou, et ce qu'il refuse.
 *
 * CE QUI EST VÉRIFIÉ ICI
 * ──────────────────────
 * La vraie logique du serveur, pas une réécriture : les fonctions importées
 * sont celles que les routes appellent. Une base est simulée en mémoire, car
 * ce qui compte est la DÉCISION, pas le moteur de stockage.
 *
 * Les invariants tenus :
 *  • un rôle non admis n'apprend même pas que la console existe ;
 *  • le mot de passe seul n'ouvre rien quand une empreinte est enrôlée ;
 *  • une preuve survit exactement à sa durée, et meurt à la rotation ;
 *  • une preuve d'un compte ne vaut pas pour un autre ;
 *  • aucun secret n'atteint le flux d'événements.
 */
import './register-hooks.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

process.env.JWT_SECRET ||= 'secret-de-test-pour-le-centre-de-securite-0123456789';
process.env.DASHBOARD_ORIGIN = 'https://vpnsxb.afrihall.com';

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(racine, 'backend', 'package.json'));
const lireSource = (relatif) => readFileSync(path.join(racine, relatif), 'utf8');

/**
 * Les services vivent avec des dépendances installées dans `backend/`
 * (bcrypt, jsonwebtoken, express-rate-limit). On les empaquette donc là-bas,
 * exactement comme le fait déjà `dashboard-profile-lock`, afin d'exercer le
 * VRAI code plutôt qu'une réécriture de sa logique.
 */
const sortie = path.join(racine, 'backend', '.sxb-security-test.cjs');
const { build } = require('esbuild');
await build({
  stdin: {
    contents: `
      export * as gate from '${path.join(racine, 'server/services/security-gate.ts').replace(/\\/g, '/')}';
      export * as events from '${path.join(racine, 'server/services/security-events.ts').replace(/\\/g, '/')}';
      export * as passkey from '${path.join(racine, 'server/services/security-passkey.ts').replace(/\\/g, '/')}';
    `,
    resolveDir: racine,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: sortie,
  logLevel: 'silent',
  external: ['bcryptjs', 'jsonwebtoken', 'express-rate-limit', 'express', 'zod', 'dotenv'],
  plugins: [{
    name: 'stub-database',
    setup(build) {
      // La base n'a pas à exister : ce qui est éprouvé ici est la DÉCISION.
      build.onResolve({ filter: /(^|\/)database$/ }, () => ({
        path: path.join(racine, 'scripts/tests/stubs/database-stub.mjs'),
      }));
    },
  }],
});
const { gate, events, passkey } = require(sortie);
test.after(() => rmSync(sortie, { force: true }));
assert.ok(existsSync(sortie));

function requete(user, entetes = {}) {
  return {
    user,
    get(nom) {
      const cle = Object.keys(entetes).find((k) => k.toLowerCase() === nom.toLowerCase());
      return cle ? entetes[cle] : undefined;
    },
  };
}

const OWNER = { userId: 'user-owner', role: 'OWNER' };
const SUPER = { userId: 'user-super', role: 'SUPER_ADMIN' };
const ADMIN = { userId: 'user-admin', role: 'ADMIN' };

test('seuls le propriétaire et le super-administrateur sont admis', () => {
  assert.equal(gate.hasSecurityCenterRole(requete(OWNER)), true);
  assert.equal(gate.hasSecurityCenterRole(requete(SUPER)), true);
  // Un ADMIN porte pourtant presque toutes les permissions du produit : le
  // Centre ne doit PAS dépendre du RBAC configurable, sinon une case mal
  // cochée ouvrirait la console qui décrit les défenses.
  for (const role of ['ADMIN', 'SUPPORT', 'RESELLER', 'CLIENT', undefined]) {
    assert.equal(gate.hasSecurityCenterRole(requete({ userId: 'x', role })), false, `rôle admis à tort : ${role}`);
  }
});

test('la route entière est fermée avant toute autre vérification', () => {
  const source = gate.SECURITY_CENTER_ROLES;
  assert.deepEqual([...source], ['OWNER', 'SUPER_ADMIN']);
  // Le refus est un 404, pas un 403 : l'existence de la console n'a pas à être
  // confirmée à un compte qui n'y a pas droit.
  const routes = lireSource('server/routes/security.ts');
  assert.match(routes, /hasSecurityCenterRole\(req\)[\s\S]{0,160}status\(404\)/);
  // Et cette barrière est posée sur TOUT le routeur.
  assert.match(routes, /router\.use\(requireAuth,/);
});

test('un mot de passe trop court ou surdimensionné est refusé', () => {
  for (const mauvais of ['', '   ', 'court', 'onzecarac', 'a'.repeat(11), 'a'.repeat(73), null, 42]) {
    assert.throws(() => gate.validateGatePassword(mauvais), /SECURITY_GATE_PASSWORD_INVALID/, `accepté à tort : ${mauvais}`);
  }
  // Douze caractères exactement : la borne est inclusive.
  assert.equal(gate.validateGatePassword('a'.repeat(12)), 'a'.repeat(12));
});

test('une preuve ouvre, expire, et ne vaut que pour son compte', () => {
  const etat = { passwordHash: 'x', version: 3, updatedAt: '', updatedById: null };
  const { unlockToken, passkeyVerified } = gate.issueSecurityUnlock(etat, OWNER.userId, true);
  assert.equal(passkeyVerified, true);

  const ouverte = gate.readSecurityUnlock(requete(OWNER, { 'X-SXB-Security-Unlock': unlockToken }), etat);
  assert.ok(ouverte);
  assert.equal(ouverte.passkeyVerified, true);
  assert.ok(ouverte.expiresAt > Date.now());

  // Un AUTRE compte ne peut pas s'en servir, même avec le même rôle.
  assert.equal(gate.readSecurityUnlock(requete(SUPER, { 'X-SXB-Security-Unlock': unlockToken }), etat), null);
  // Sans en-tête, c'est fermé.
  assert.equal(gate.readSecurityUnlock(requete(OWNER), etat), null);
  // Une preuve tronquée ou bricolée ne lève pas : elle ferme.
  assert.equal(gate.readSecurityUnlock(requete(OWNER, { 'X-SXB-Security-Unlock': `${unlockToken}x` }), etat), null);
});

test('changer le mot de passe ferme instantanément les consoles ouvertes', () => {
  const avant = { passwordHash: 'x', version: 3, updatedAt: '', updatedById: null };
  const { unlockToken } = gate.issueSecurityUnlock(avant, OWNER.userId, true);
  // `writeSecurityGate` incrémente la version ; la preuve porte l'ancienne.
  const apres = { ...avant, version: 4 };
  assert.equal(gate.readSecurityUnlock(requete(OWNER, { 'X-SXB-Security-Unlock': unlockToken }), apres), null);
});

test('une console ouverte au seul mot de passe ne se réclame pas de l’empreinte', () => {
  const etat = { passwordHash: 'x', version: 1, updatedAt: '', updatedById: null };
  const { unlockToken } = gate.issueSecurityUnlock(etat, OWNER.userId, false);
  const ouverte = gate.readSecurityUnlock(requete(OWNER, { 'X-SXB-Security-Unlock': unlockToken }), etat);
  assert.equal(ouverte.passkeyVerified, false);

  // Et la route l'exige explicitement quand une clé est enrôlée.
  const routes = lireSource('server/routes/security.ts');
  assert.match(routes, /cles\.length > 0 && !ouverture\.passkeyVerified[\s\S]{0,140}SECURITY_PASSKEY_REQUIRED/);
  // Le mot de passe seul n'émet AUCUNE preuve quand une clé existe : la route
  // rend un défi, jamais une ouverture.
  assert.match(routes, /step: 'passkey',[\s\S]{0,200}issueChallenge\(req\.user!\.userId, 'authenticate'\)/);
  const etapeMotDePasse = routes.slice(
    routes.indexOf("router.post('/gate/unlock'"),
    routes.indexOf("router.post('/gate/unlock/passkey'"),
  );
  const defi = etapeMotDePasse.indexOf("step: 'passkey'");
  const ouvert = etapeMotDePasse.indexOf("step: 'unlocked'");
  assert.ok(defi > -1 && ouvert > defi, 'le défi doit précéder toute ouverture');
});

test('le flux d’événements refuse tout ce qui n’est pas prévu', () => {
  const filtre = events.construireFiltre({ severity: 'critical', eventType: 'DEVICE_BLOCKED' });
  assert.deepEqual(filtre, { severity: 'critical', eventType: 'DEVICE_BLOCKED' });
  // Une gravité ou un type inventés sont ignorés plutôt que transmis à la base.
  assert.deepEqual(events.construireFiltre({ severity: 'urgent', eventType: 'DROP TABLE' }), {});
  // La pagination est bornée des deux côtés.
  assert.equal(events.normaliserPagination({ limit: 100000 }).limit, events.SECURITY_EVENTS_MAX_PAGE_SIZE);
  assert.equal(events.normaliserPagination({ limit: -1 }).limit, events.SECURITY_EVENTS_PAGE_SIZE);
  assert.equal(events.normaliserPagination({ offset: -5 }).offset, 0);
});

test('aucun secret ne peut entrer dans un événement', async () => {
  // `recordSecurityEvent` n'écrit rien sans base ; on éprouve donc la règle de
  // nettoyage par la surface qui la porte : seule une liste blanche passe.
  const source = lireSource('server/services/security-events.ts');
  assert.match(source, /const METADATA_KEYS = new Set\(\[/);
  for (const interdit of ['password', 'token', 'secret', 'privateKey', 'credential']) {
    assert.doesNotMatch(source, new RegExp(`'${interdit}'`), `champ sensible autorisé : ${interdit}`);
  }
  // Observer ne doit jamais casser ce qui est observé.
  assert.equal(await events.recordSecurityEvent({ eventType: 'LOGIN_FAILED' }), false);
});

test('l’adresse source n’est conservée que sous forme d’empreinte', () => {
  const empreinte = passkey.hashIp('203.0.113.7');
  assert.ok(empreinte && empreinte.length <= 22);
  assert.ok(!empreinte.includes('203'), 'l’adresse ne doit pas rester lisible');
  // Stable pour regrouper, différente d'une autre adresse.
  assert.equal(empreinte, passkey.hashIp('203.0.113.7'));
  assert.notEqual(empreinte, passkey.hashIp('203.0.113.8'));
  assert.equal(passkey.hashIp(null), null);
});

test('le domaine WebAuthn vient de la configuration, jamais de la requête', () => {
  assert.equal(passkey.dashboardOrigin(), 'https://vpnsxb.afrihall.com');
  assert.equal(passkey.relyingPartyId(), 'vpnsxb.afrihall.com');
  const source = lireSource('server/services/security-passkey.ts');
  // L'origine annoncée par le navigateur est COMPARÉE, jamais adoptée.
  assert.match(source, /donnees\?\.origin !== dashboardOrigin\(\)/);
  assert.doesNotMatch(source, /req\.get\(['"]origin/i);
  // Les contrôles qui distinguent une empreinte d'une simple présence.
  assert.match(source, /FLAG_USER_VERIFIED/);
  assert.match(source, /SECURITY_PASSKEY_VERIFICATION_REQUIRED/);
  assert.match(source, /SECURITY_PASSKEY_REPLAY_DETECTED/);
  // La clé privée n'est jamais reçue ni stockée.
  assert.doesNotMatch(source, /privateKey/);
});

test('un défi ne sert qu’une fois, pour son usage et son compte', () => {
  const defi = passkey.issueChallenge(OWNER.userId, 'authenticate');
  assert.ok(defi.challengeId && defi.challenge);
  assert.equal(defi.rpId, 'vpnsxb.afrihall.com');
  assert.deepEqual(defi.algorithms, [...passkey.SUPPORTED_ALGORITHMS]);
  // Deux défis successifs ne se ressemblent pas.
  assert.notEqual(defi.challenge, passkey.issueChallenge(OWNER.userId, 'authenticate').challenge);
});

test('le verrou ne quitte jamais l’en-tête pour une URL ou un stockage', () => {
  assert.equal(gate.SECURITY_UNLOCK_HEADER, 'X-SXB-Security-Unlock');
  const routes = lireSource('server/routes/security.ts');
  // Une preuve dans une URL finirait dans les journaux d'accès du serveur.
  assert.doesNotMatch(routes, /req\.query\.(unlock|token|proof)/);
  assert.doesNotMatch(routes, /unlockToken.*req\.params/);
});

test('le tableau de bord ne persiste jamais la preuve d’ouverture', () => {
  // C'est l'invariant le plus facile à casser par inadvertance : une preuve
  // rangée dans `localStorage` survivrait à la fermeture de l'onglet et
  // rendrait le verrou décoratif.
  for (const fichier of [
    'artifacts/sxb-dashboard/src/api/security.ts',
    'artifacts/sxb-dashboard/src/components/SecurityCenterView.tsx',
  ]) {
    const source = lireSource(fichier);
    for (const interdit of ['localStorage', 'sessionStorage', 'document.cookie', 'indexedDB']) {
      assert.ok(!source.includes(interdit), `${fichier} : la preuve ne doit pas approcher ${interdit}`);
    }
  }
  // Elle vit en mémoire React, et part par l'en-tête convenu.
  const vue = lireSource('artifacts/sxb-dashboard/src/components/SecurityCenterView.tsx');
  assert.match(vue, /const \[unlockToken, setUnlockToken\] = useState<string \| null>\(null\)/);
  const client = lireSource('artifacts/sxb-dashboard/src/api/security.ts');
  assert.match(client, /"X-SXB-Security-Unlock": unlockToken/);
});

test('l’empreinte est exigée par le navigateur, pas seulement par le serveur', () => {
  const vue = lireSource('artifacts/sxb-dashboard/src/components/SecurityCenterView.tsx');
  // `userVerification: 'required'` demande au système une empreinte, un visage
  // ou un code local. Sans lui, une clé simplement branchée suffirait, et le
  // serveur refuserait ensuite — après avoir fait croire à l'utilisateur que
  // son geste avait abouti.
  assert.equal((vue.match(/userVerification: "required"/g) || []).length, 2,
    'inscription ET connexion doivent exiger la vérification');
  // L'authentificateur visé est celui de la plateforme : c'est le capteur de
  // l'appareil, pas une clé USB tierce.
  assert.match(vue, /authenticatorAttachment: "platform"/);
  // L'absence de WebAuthn est dite, pas subie par une exception.
  assert.match(vue, /"PublicKeyCredential" in window/);
});

test('le défi d’empreinte porte les clés enrôlées', () => {
  // Sans ces identifiants, un capteur de plateforme ayant créé une clé NON
  // découvrable ne retrouve rien : la vérification échoue toujours, et le
  // propriétaire reste enfermé dehors sans aucun recours. C'est exactement ce
  // qui s'est produit en production — une empreinte enrôlée, jamais utilisable.
  const routes = lireSource('server/routes/security.ts');
  assert.match(routes, /allowCredentials: await credentialIdsFor\(req\.user!\.userId\)/);
  const service = lireSource('server/services/security-passkey.ts');
  assert.match(service, /export async function credentialIdsFor/);

  // Ces identifiants ne sortent qu'APRÈS un mot de passe valide : ils ne
  // renseignent donc personne qui ne l'ait déjà franchi.
  const avant = routes.indexOf('verifyGatePassword');
  const apres = routes.indexOf('allowCredentials: await credentialIdsFor');
  assert.ok(avant > -1 && apres > avant, 'les clés ne doivent sortir qu’après le mot de passe');

  const vue = lireSource('artifacts/sxb-dashboard/src/components/SecurityCenterView.tsx');
  // La vue doit s'en servir, et non repartir sur une liste vide.
  assert.match(vue, /challenge\.allowCredentials \?\? \[\]/);
  assert.doesNotMatch(vue, /allowCredentials: \[\],/);
  // Les futurs enrôlements exigent une clé découvrable : « preferred » laissait
  // le capteur libre d'en créer une qu'il ne saurait pas retrouver.
  assert.match(vue, /residentKey: "required"/);
  assert.doesNotMatch(vue, /residentKey: "preferred"/);
});

test('le propriétaire garde une voie de sortie quand l’empreinte ne marche plus', () => {
  // Sans elle, retirer une empreinte exigeait une console ouverte que seule
  // cette empreinte permettait d'ouvrir : un capteur remplacé ou une machine
  // perdue enfermait le propriétaire dehors DÉFINITIVEMENT.
  const routes = lireSource('server/routes/security.ts');
  assert.match(routes, /router\.post\('\/gate\/passkeys\/reset'/);

  const secours = routes.slice(
    routes.indexOf("router.post('/gate/passkeys/reset'"),
    routes.indexOf("router.delete('/passkeys/:id'"),
  );
  // Réservée au propriétaire, et jamais franchissable sans le mot de passe.
  assert.match(secours, /isOwnerRequest\(req\)/);
  assert.match(secours, /verifyGatePassword\(req\.body\?\.password\)/);
  // Elle n'ouvre AUCUNE console : elle ne rend aucune preuve de déverrouillage.
  assert.doesNotMatch(secours, /issueSecurityUnlock/);
  assert.doesNotMatch(secours, /unlockToken/);
  // Et elle laisse une trace qu'on ne peut pas manquer.
  assert.match(secours, /severity: 'critical'/);
  assert.match(secours, /OWNER_RECOVERY/);

  // Elle ne touche que les empreintes : le mot de passe de la porte reste.
  const service = lireSource('server/services/security-passkey.ts');
  assert.match(service, /export async function deleteAllPasskeys/);
  assert.doesNotMatch(service, /securityGate\.deleteMany/);
});

test('la section n’est proposée qu’aux deux rôles admis', () => {
  const layout = lireSource('artifacts/sxb-dashboard/src/components/Layout.tsx');
  const entree = layout.slice(layout.indexOf("id: 'security'"), layout.indexOf("id: 'security'") + 320);
  assert.ok(entree, 'la section doit exister dans la navigation');
  assert.match(entree, /roles: \['OWNER', 'SUPER_ADMIN'\]/);
  // Le menu ne protège rien par lui-même : le serveur refuse déjà les autres
  // rôles par un 404. Les deux doivent rester d'accord.
  const routes = lireSource('server/routes/security.ts');
  assert.match(routes, /hasSecurityCenterRole/);
});

test('chaque code du journal se lit dans la langue choisie', () => {
  // Le serveur n'écrit que des codes : `LOGIN_FAILED`, `critical`,
  // `bad_password`. Affichés tels quels, ils ne disent rien à l'opérateur et
  // restent en anglais quelle que soit la langue du panneau. Chaque code doit
  // donc porter un libellé, et chaque type une explication de ce qu'il appelle.
  const service = lireSource('server/services/security-events.ts');
  const listeDe = (nom) => {
    const debut = service.indexOf(`export const ${nom} = [`);
    assert.notEqual(debut, -1, `${nom} doit rester une liste fermée`);
    const bloc = service.slice(debut, service.indexOf('] as const', debut));
    return [...bloc.matchAll(/'([A-Za-z_]+)'/g)].map(m => m[1]);
  };
  const gravites = listeDe('SECURITY_SEVERITIES');
  const types = listeDe('SECURITY_EVENT_TYPES');
  assert.ok(types.length >= 16, 'tous les types doivent être relus depuis la source');

  for (const langue of ['fr', 'en']) {
    const secu = JSON.parse(lireSource(`artifacts/sxb-dashboard/src/locales/${langue}/operations.json`)).security;
    for (const gravite of gravites) {
      assert.ok(secu.severityLabels?.[gravite], `${langue}: libellé manquant pour la gravité ${gravite}`);
      assert.ok(secu.severityExplain?.[gravite], `${langue}: explication manquante pour la gravité ${gravite}`);
    }
    for (const type of types) {
      assert.ok(secu.eventLabels?.[type], `${langue}: libellé manquant pour ${type}`);
      assert.ok(secu.eventExplain?.[type]?.length > 30, `${langue}: explication trop courte pour ${type}`);
    }
    // Une explication qui répète le code n'explique rien.
    for (const type of types) {
      assert.ok(!secu.eventLabels[type].includes('_'), `${langue}: ${type} montre encore son code brut`);
    }
  }

  // L'action enregistrée par le serveur est un code, jamais une phrase figée
  // dans une seule langue.
  const routes = lireSource('server/routes/security.ts');
  assert.match(routes, /actionTaken: 'SESSIONS_CLOSED'/);
  assert.doesNotMatch(routes, /actionTaken: '[^']*[éèêàùç]/, "aucune phrase française ne doit être stockée telle quelle");

  // Les lignes écrites avant ce changement portent encore la phrase française :
  // elles sont relues sous leur code, sans réécrire la base.
  const service2 = lireSource('server/services/security-events.ts');
  assert.match(service2, /ACTIONS_HERITEES/);
  assert.match(service2, /'Toutes les ouvertures en cours ont été fermées', 'SESSIONS_CLOSED'/);

  // La vue ne rend plus aucun code brut.
  const vue = lireSource('artifacts/sxb-dashboard/src/components/SecurityCenterView.tsx');
  assert.doesNotMatch(vue, /\{event\.severity\}/, 'la gravité doit passer par le vocabulaire traduit');
  assert.doesNotMatch(vue, /\{event\.eventType\}/, 'le type doit passer par le vocabulaire traduit');
  assert.doesNotMatch(vue, /\{event\.actionTaken\}/, "l'action doit passer par le vocabulaire traduit");
  assert.match(vue, /vocabulary\.eventExplain\(event\.eventType\)/);
  // Un code inconnu d'une version plus récente du serveur reste affiché brut
  // plutôt que de laisser une case vide.
  assert.match(vue, /\?\? code/);
});

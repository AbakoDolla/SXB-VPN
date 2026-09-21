/**
 * cloisonnement-arbre-miroir.test.mjs — Le serveur miroir doit rester inerte
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE BANC
 *
 * Le dépôt porte DEUX arbres serveur :
 *   - server/routes/          (racine, 39 fichiers) — applique le cloisonnement
 *   - backend/server/routes/  (miroir, 34 fichiers) — ne l'applique pas
 *
 * Sur 31 fichiers présents des deux côtés, 14 sont à ZÉRO dans le miroir sur
 * tout le vocabulaire de cloisonnement (`cloisonne*`, `resellerId`) :
 *   audit-logs, clients, dashboard, devices, mobile, resellers, sessions,
 *   ssh, subscriptions, tokens, users, vouchers, vpn-profiles, xpanel
 * À titre d'exemple : clients.ts porte 14 `resellerId` à la racine, 0 dans le
 * miroir ; vouchers.ts en porte 18 contre 0.
 *
 * La production n'est PAS servie par cet arbre : ecosystem.config.cjs lance
 * /var/www/sxb-vpn/dist/server.cjs, compilé depuis le server.ts de la racine.
 *
 * Le risque est le geste manuel. backend/package.json expose `dev` (tsx
 * server.ts) et `start` (node dist/server.cjs), et backend/server.ts lit le
 * même config.PORT puis écoute sur 0.0.0.0 — exactement comme la racine. Un
 * `cd backend && npm run dev` pendant un incident relèverait donc le service
 * SANS cloisonnement, et le succès apparent masquerait la régression.
 *
 * D'où le garde d'exécution en tête de backend/server.ts, que ce banc protège.
 *
 * CE QU'IL VÉRIFIE
 *   1. le garde existe dans backend/server.ts ;
 *   2. il s'exécute AVANT tout app.listen (un garde placé après ne garde rien) ;
 *   3. il coupe réellement le processus (process.exit) : mesuré, un throw à cet
 *      endroit sort en code 0 dès qu'un module importé a installé un handler
 *      uncaughtException — le serveur ne démarre pas, mais la commande rapporte
 *      un succès, ce qui est précisément l'issue silencieuse à éviter ;
 *   4. la production ne dépend pas de ce point d'entrée — sinon le garde
 *      casserait le service au lieu de le protéger ;
 *   5. l'arbre racine, lui, porte bien le cloisonnement : sans ce témoin
 *      inverse, le banc resterait vert en surveillant deux arbres également
 *      vides, c'est-à-dire en ne surveillant rien.
 *
 * FORME DE L'ASSERTION : une implication, pas un état figé.
 * Le garde n'est exigé que TANT QUE le miroir est sans cloisonnement. Si un
 * jour ces routes sont cloisonnées, le banc n'oblige plus à rien et n'aura
 * jamais bloqué l'amélioration qu'il est censé encourager.
 *
 * Ce banc est en LECTURE SEULE. Vérifiable à l'envers via MIROIR_RACINE, qui
 * le pointe vers une arborescence de contrôle.
 *
 * Exécution CI : node --experimental-strip-types --test scripts/tests/*.test.mjs
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.MIROIR_RACINE
  ? path.resolve(process.env.MIROIR_RACINE)
  : path.resolve(__dirname, '../..');

const SERVEUR_MIROIR = 'backend/server.ts';
const SERVEUR_RACINE = 'server.ts';
const ROUTES_MIROIR = 'backend/server/routes';
const ROUTES_RACINE = 'server/routes';
const ECOSYSTEM = 'ecosystem.config.cjs';
const VARIABLE_ECHAPPEMENT = 'SXB_AUTORISER_SERVEUR_MIROIR';

const chemin = (rel) => path.join(ROOT, rel);
const lire = (rel) => fs.readFileSync(chemin(rel), 'utf8');

/** Vocabulaire réel du cloisonnement dans ce dépôt. */
const MOTIFS_CLOISONNEMENT = [/cloisonne/gi, /resellerId/g];

function compterCloisonnement(contenu) {
  return MOTIFS_CLOISONNEMENT.reduce(
    (total, motif) => total + (contenu.match(motif)?.length ?? 0),
    0,
  );
}

/** Routes présentes des deux côtés dont la version miroir est à zéro. */
function routesMiroirSansCloisonnement() {
  const dossierMiroir = chemin(ROUTES_MIROIR);
  const dossierRacine = chemin(ROUTES_RACINE);
  if (!fs.existsSync(dossierMiroir) || !fs.existsSync(dossierRacine)) return [];

  const nues = [];
  for (const fichier of fs.readdirSync(dossierRacine)) {
    if (!fichier.endsWith('.ts')) continue;
    const jumeau = path.join(dossierMiroir, fichier);
    if (!fs.existsSync(jumeau)) continue;

    const racine = compterCloisonnement(fs.readFileSync(path.join(dossierRacine, fichier), 'utf8'));
    const miroir = compterCloisonnement(fs.readFileSync(jumeau, 'utf8'));
    if (racine > 0 && miroir === 0) nues.push({ fichier, racine, miroir });
  }
  return nues;
}

test('le serveur racine porte bien le cloisonnement (témoin inverse du banc)', () => {
  const dossierRacine = chemin(ROUTES_RACINE);
  assert.ok(
    fs.existsSync(dossierRacine),
    `\n\n  ⛔ ${ROUTES_RACINE} est introuvable : ce banc ne peut plus comparer quoi que ce soit.\n`,
  );

  const cloisonnes = fs
    .readdirSync(dossierRacine)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => compterCloisonnement(fs.readFileSync(path.join(dossierRacine, f), 'utf8')) > 0);

  assert.ok(
    cloisonnes.length >= 10,
    `\n\n  ⛔ Seulement ${cloisonnes.length} fichier(s) de ${ROUTES_RACINE} portent du cloisonnement.\n\n` +
      `  Ce banc compare le miroir à la racine. Si la racine elle-même n'en porte plus,\n` +
      `  la comparaison devient vide et le banc resterait vert en ne surveillant RIEN.\n` +
      `  Vérifiez que le vocabulaire (« cloisonne », « resellerId ») n'a pas été renommé :\n` +
      `  dans ce cas, mettez à jour MOTIFS_CLOISONNEMENT dans ce fichier.\n`,
  );
});

test('la production ne dépend pas du point d’entrée miroir', () => {
  assert.ok(
    fs.existsSync(chemin(ECOSYSTEM)),
    `\n\n  ⛔ ${ECOSYSTEM} est introuvable : impossible de vérifier ce que pm2 lance.\n`,
  );
  const ecosystem = lire(ECOSYSTEM);
  const cible = ecosystem.match(/script:\s*['"]([^'"]+)['"]/)?.[1] ?? '<aucun script:>';

  assert.ok(
    !/\bbackend\//.test(cible),
    `\n\n  ⛔ pm2 lance « ${cible} », qui passe par backend/.\n\n` +
      `  Le garde d'exécution de ${SERVEUR_MIROIR} arrêterait alors la PRODUCTION\n` +
      `  au lieu de la protéger. Ce banc et ce garde supposent que la production est\n` +
      `  servie depuis l'arbre racine.\n\n` +
      `  MARCHE À SUIVRE\n` +
      `    Soit rétablissez un « script: » pointant vers le bundle compilé depuis ${SERVEUR_RACINE},\n` +
      `    soit cloisonnez ${ROUTES_MIROIR} et retirez le garde en connaissance de cause.\n`,
  );
});

test('backend/server.ts refuse de démarrer tant que ses routes ne sont pas cloisonnées', () => {
  const nues = routesMiroirSansCloisonnement();

  // Implication : pas de routes nues ⇒ aucune exigence. Le banc n'interdit
  // jamais d'améliorer le miroir, il interdit seulement de le laisser
  // démarrable ALORS qu'il est nu.
  if (nues.length === 0) return;

  const source = lire(SERVEUR_MIROIR);
  const apercu = nues
    .slice(0, 5)
    .map((n) => `      ${n.fichier.padEnd(20)} racine=${n.racine}  miroir=${n.miroir}`)
    .join('\n');
  const pourquoi =
    `  ${nues.length} route(s) de ${ROUTES_MIROIR} n'appliquent aucun cloisonnement\n` +
    `  alors que leurs jumelles de ${ROUTES_RACINE} en appliquent :\n${apercu}\n` +
    (nues.length > 5 ? `      … et ${nues.length - 5} autre(s)\n` : '');

  assert.ok(
    source.includes(VARIABLE_ECHAPPEMENT),
    `\n\n  ⛔ Le garde d'exécution a disparu de ${SERVEUR_MIROIR}.\n\n${pourquoi}\n` +
      `  Sans ce garde, « cd backend && npm run dev » relève un serveur complet SANS\n` +
      `  cloisonnement, sur le même port que la production (même config.PORT, même\n` +
      `  écoute sur 0.0.0.0). Il démarre normalement : rien ne signale la régression.\n\n` +
      `  MARCHE À SUIVRE\n` +
      `    Rétablissez le garde en tête de ${SERVEUR_MIROIR}, ou cloisonnez les routes\n` +
      `    ci-dessus — la seconde voie rend ce banc silencieux d'elle-même.\n`,
  );

  const positionGarde = source.indexOf(VARIABLE_ECHAPPEMENT);
  const positionEcoute = source.indexOf('app.listen');
  assert.ok(
    positionEcoute === -1 || positionGarde < positionEcoute,
    `\n\n  ⛔ Le garde de ${SERVEUR_MIROIR} est placé APRÈS app.listen.\n\n` +
      `  garde   : caractère ${positionGarde}\n  app.listen : caractère ${positionEcoute}\n\n` +
      `  Un garde placé après l'ouverture du port ne garde rien : le serveur a déjà\n` +
      `  accepté des connexions quand il s'exécute.\n`,
  );

  assert.match(
    source.slice(positionGarde, positionGarde + 600),
    /process\.exit\(/,
    `\n\n  ⛔ Le garde de ${SERVEUR_MIROIR} ne coupe pas le processus.\n\n` +
      `  Mesuré : un « throw » à cet endroit sort en code 0 dès qu'un module importé\n` +
      `  a installé un handler « uncaughtException » — et ce fichier en installe.\n` +
      `  Le serveur ne démarre pas, mais la commande rapporte un SUCCÈS, ce qui est\n` +
      `  exactement l'issue silencieuse que le garde existe pour éviter.\n` +
      `  Le garde doit appeler process.exit() avec un code non nul.\n`,
  );
});

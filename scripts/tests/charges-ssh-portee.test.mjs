/**
 * Les charges utiles SSH appartiennent à leur auteur.
 *
 * LE DÉFAUT MESURÉ EN PRODUCTION
 * ──────────────────────────────
 * Une charge utile SSH est l'en-tête d'injection qui fait passer le tunnel
 * chez un opérateur donné : c'est le savoir-faire commercial de l'exploitant,
 * pas un réglage de plateforme. Aucune route de `payload.ts` n'appliquait de
 * portée — ni la liste, ni les cinq routes à identifiant. Mesuré avec un
 * administrateur créé à l'instant :
 *
 *     GET /api/payload  ->  200, sans aucune restriction
 *
 * POURQUOI MAINTENANT, ALORS QUE RIEN NE FUIT ENCORE
 * ──────────────────────────────────────────────────
 * La table est VIDE en production : 0 charge, y compris pour le compte à haut
 * privilège. La fuite était donc LATENTE. C'est précisément l'argument pour
 * poser la propriété aujourd'hui — il n'y a aucune ligne à rattacher, donc
 * aucun réglage en service ne peut disparaître du tableau de bord de
 * quiconque. Attendre reviendrait à devoir arbitrer, plus tard, le sort de
 * charges déjà en production.
 *
 * `SshPayload` était le SEUL modèle du domaine moteur sans `createdBy` :
 * `VPSServer`, `SshAccount`, `XrayAccount`, `SingboxAccount` et `VpnProfile`
 * le portent tous. Un oubli, et non un choix de conception — le même que
 * celui déjà corrigé pour `XrayAccount` et `SingboxAccount`.
 *
 * Banc volontairement STRUCTUREL : il n'énumère pas les routes connues. Il
 * exige que CHAQUE route prenant un identifiant porte le garde-fou, afin
 * qu'une route ajoutée demain sans lui fasse tomber le banc.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Fins de ligne normalisées : un découpage sur « \n}\n » rendrait une chaîne
// vide face à des CRLF, et le banc passerait au vert sans rien vérifier.
const lire = (...p) => readFileSync(join(racine, ...p), 'utf8').replace(/\r\n/g, '\n');
const source = lire('server', 'routes', 'payload.ts');

/** Découpe le fichier en handlers : du `router.verbe(` jusqu'au suivant. */
function handlers() {
  const debuts = [...source.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)];
  return debuts.map((m, i) => ({
    methode: m[1].toUpperCase(),
    chemin: m[2],
    corps: source.slice(m.index, i + 1 < debuts.length ? debuts[i + 1].index : source.length),
  }));
}

const GARDE = /chargerChargeVisible\s*\(/;
const aIdentifiant = (h) => h.chemin.includes(':id');

test('le fichier expose bien des routes à analyser', () => {
  const routes = handlers();
  assert.ok(routes.length >= 6, `routes trouvées : ${routes.length}`);
  assert.ok(
    routes.filter(aIdentifiant).length >= 5,
    'aucune route à identifiant : le découpage est cassé',
  );
});

test('toute route désignant une charge par identifiant vérifie la portée', () => {
  const sans = handlers()
    .filter((h) => aIdentifiant(h) && !GARDE.test(h.corps))
    .map((h) => `${h.methode} ${h.chemin}`);
  assert.deepEqual(sans, [], `routes sans contrôle de propriété : ${sans.join(', ')}`);
});

test('le contrôle précède toujours la lecture et le refus est indifférencié', () => {
  for (const h of handlers().filter((x) => GARDE.test(x.corps))) {
    const garde = h.corps.search(GARDE);
    const refus = h.corps.indexOf('status(404).json(CHARGE_INTROUVABLE)');
    assert.ok(
      refus > garde,
      `${h.methode} ${h.chemin} doit refuser en 404 indifférencié après contrôle de portée`,
    );
    // Aucune lecture non filtrée ne doit précéder le contrôle : elle rendrait
    // la charge d'autrui avant même que la portée soit consultée.
    assert.ok(
      !/findUnique|findFirst/.test(h.corps.slice(0, garde)),
      `${h.methode} ${h.chemin} lit la charge avant d'en vérifier la propriété`,
    );
  }
});

test('la liste est cloisonnée et la création estampille son auteur', () => {
  const liste = handlers().find((h) => h.methode === 'GET' && h.chemin === '/');
  assert.ok(liste, 'route de liste introuvable');
  assert.match(liste.corps, /porteeCharges\(/, 'la liste doit être cloisonnée');
  assert.ok(
    !GARDE.test(liste.corps),
    "la liste ne désigne aucune charge : le garde n'a pas lieu d'être",
  );

  const creation = handlers().find((h) => h.methode === 'POST' && h.chemin === '/');
  assert.ok(creation, 'route de création introuvable');
  // Sans estampille, l'auteur perdrait l'accès à ce qu'il vient de créer : la
  // portée ne trouverait plus rien à lui rendre.
  assert.match(
    creation.corps,
    /createdBy:\s*auteurAInscrire\(req\.user\)/,
    'la création doit inscrire son auteur',
  );
});

test('le rattachement vérifie AUSSI la propriété du compte SSH visé', () => {
  // Cette route écrit sur un compte SSH désigné dans le CORPS de la requête,
  // pas dans l'URL. Ne garder que la charge laisserait un administrateur
  // rattacher sa propre charge au compte d'un autre exploitant.
  const attache = handlers().find((h) => h.chemin === '/:id/attach');
  assert.ok(attache, 'route de rattachement introuvable');
  assert.match(attache.corps, /porteeComptesSsh\(/, 'le compte SSH visé doit être vérifié');
  const portee = attache.corps.indexOf('porteeComptesSsh(');
  const ecriture = attache.corps.indexOf('withUnlockedEngine(');
  assert.ok(portee < ecriture, 'la propriété du compte doit être établie avant l’écriture');
});

test('le garde-fou s’appuie sur le point unique de cloisonnement', () => {
  assert.match(
    source,
    /import\s*\{[^}]*porteeCharges[^}]*\}\s*from\s*'\.\.\/services\/portee-donnees'/,
    'le garde doit importer porteeCharges depuis portee-donnees',
  );
  const debut = source.indexOf('async function chargerChargeVisible');
  assert.ok(debut > 0, 'chargerChargeVisible introuvable');
  const corps = source.slice(debut, debut + 400);
  assert.match(corps, /porteeCharges\(\s*prisma\s*,\s*req\.user\s*\)/);
  assert.match(corps, /findFirst/, 'la portée doit être appliquée DANS la requête');
  assert.ok(
    !/findUnique/.test(corps),
    'findUnique ignore le filtre de portée : la propriété ne serait pas vérifiée',
  );
});

test('le modèle porte bien la colonne de propriété, dans les DEUX schémas', () => {
  // C'est `backend/prisma/schema.prisma` qui est réellement poussé en base au
  // déploiement : une colonne absente de ce fichier n'existerait pas en
  // production, et la portée filtrerait sur un champ inconnu.
  for (const chemin of [['prisma', 'schema.prisma'], ['backend', 'prisma', 'schema.prisma']]) {
    const schema = lire(...chemin);
    const modele = schema.match(/^model SshPayload \{([\s\S]*?)^\}/m);
    assert.ok(modele, `modèle SshPayload introuvable dans ${chemin.join('/')}`);
    assert.match(
      modele[1],
      /createdBy\s+String\?/,
      `SshPayload doit porter createdBy dans ${chemin.join('/')}`,
    );
  }
});

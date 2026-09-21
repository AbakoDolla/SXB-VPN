/**
 * Le ciblage par appareil ne sort pas du cercle des opérateurs plateforme.
 *
 * LE DÉFAUT MESURÉ EN PRODUCTION
 * ──────────────────────────────
 * `GET /api/app-updates/current` interrogé par un ADMIN neuf, dont le parc
 * réel comptait ZÉRO appareil :
 *
 *     eligibleDeviceCount      -> 0        (compteur correctement cloisonné)
 *     update.targetDeviceIds[] -> 256 identifiants d'appareils d'AUTRUI
 *
 * Échantillon réellement lu par ce compte vierge : SXBA8MBL4J7V8LFGBQ,
 * SXBEP9CG72ZES1XCO2, SXBBHLR0P1FNZO67V7.
 *
 * Le compteur avait été cloisonné — avec un commentaire lucide sur la fuite —
 * pendant que la liste servie dans la MÊME réponse déversait le parc. C'est le
 * motif « liste filtrée / agrégat voisin oublié » exactement INVERSÉ.
 *
 * Ce banc exerce la vraie fonction, pas une copie de sa règle, et vérifie que
 * le défaut du champ est le SILENCE : un appelant qui oublie l'option ne doit
 * rien divulguer.
 */
import './register-hooks.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Fins de ligne normalisées : le dépôt est édité sous Windows.
const lire = (...p) => readFileSync(join(racine, ...p), 'utf8').replace(/\r\n/g, '\n');

const { toPublicAppUpdate } = await import('../../server/services/app-update.ts');

const PARC_AUTRUI = ['SXBA8MBL4J7V8LFGBQ', 'SXBEP9CG72ZES1XCO2', 'SXBBHLR0P1FNZO67V7'];

function publication() {
  return {
    id: 'pub-1',
    versionCode: 1,
    versionName: '1.0.0',
    apkUrl: 'https://exemple.test/a.apk',
    apkSha256: 'a'.repeat(64),
    notes: '',
    minSupportedCode: 0,
    forceUpdate: false,
    active: true,
    targetRoles: ['OWNER'],
    targetDeviceIds: [...PARC_AUTRUI],
    publishedAt: '2026-09-16T05:00:22Z',
    updatedAt: '2026-09-16T05:00:22Z',
  };
}

test('sans option explicite, aucun identifiant d’appareil ne sort', () => {
  const charge = toPublicAppUpdate(publication());
  assert.deepEqual(charge.targetDeviceIds, [], 'le défaut doit être le silence');
  for (const id of PARC_AUTRUI) {
    assert.ok(
      !JSON.stringify(charge).includes(id),
      `identifiant d'autrui présent dans la charge utile : ${id}`,
    );
  }
});

test('le champ reste un tableau : l’écran fait .includes() et .length dessus', () => {
  // Omettre la clé casserait `AppUpdatesView.tsx` au lieu de la protéger.
  const charge = toPublicAppUpdate(publication());
  assert.ok(Array.isArray(charge.targetDeviceIds));
  assert.equal(charge.targetDeviceIds.length, 0);
});

test('un opérateur plateforme reçoit le ciblage intact', () => {
  const charge = toPublicAppUpdate(publication(), { inclureCiblageAppareils: true });
  assert.deepEqual(charge.targetDeviceIds, PARC_AUTRUI);
});

test('le reste de la charge utile est inchangé dans les deux cas', () => {
  const sans = toPublicAppUpdate(publication());
  const avec = toPublicAppUpdate(publication(), { inclureCiblageAppareils: true });
  for (const clef of Object.keys(avec)) {
    if (clef === 'targetDeviceIds') continue;
    assert.deepEqual(sans[clef], avec[clef], `champ altéré par le cloisonnement : ${clef}`);
  }
});

test('/current n’ouvre le ciblage qu’au SUPER_ADMIN', () => {
  const source = lire('server', 'routes', 'app-updates.ts');
  const debut = source.indexOf('router.get("/current"');
  assert.ok(debut > 0, 'route /current introuvable');
  const corps = source.slice(debut, source.indexOf('router.', debut + 10));
  assert.match(
    corps,
    /toPublicAppUpdate\(\s*update\s*,\s*\{\s*inclureCiblageAppareils:\s*isSuperAdmin\(req\)\s*\}\s*\)/,
    '/current doit conditionner le ciblage à isSuperAdmin(req)',
  );
});

test('aucun appelant ne réclame le ciblage sur une route non réservée', () => {
  // `POST /publish` est le seul appelant légitime : il refuse tout
  // non-SUPER_ADMIN par un garde en tête de route (403 SUPER_ADMIN_ONLY).
  const source = lire('server', 'routes', 'app-updates.ts');
  const ouvertures = [...source.matchAll(/toPublicAppUpdate\([^)]*inclureCiblageAppareils:\s*true/g)];
  assert.equal(ouvertures.length, 1, 'un seul appel doit forcer le ciblage à vrai');
  const avant = source.slice(0, ouvertures[0].index);
  const routeCourante = avant.lastIndexOf('router.');
  const corps = source.slice(routeCourante, ouvertures[0].index);
  assert.match(corps, /isSuperAdmin\(req\)/, 'cet appel doit être gardé par isSuperAdmin');
  assert.match(corps, /SUPER_ADMIN_ONLY/, 'ce garde doit refuser explicitement les autres rôles');
});

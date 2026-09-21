// ═══════════════════════════════════════════════════════════════════════════
// Toute route d'accès direct par identifiant contrôle la propriété
// ═══════════════════════════════════════════════════════════════════════════
//
// Mesuré en production avant correction : un administrateur connaissant
// l'identifiant de la configuration d'un AUTRE administrateur la déverrouillait
// (200 + preuve + hôte du serveur en clair), lisait et réattribuait ses
// revendeurs, la renommait, puis faisait tourner le mot de passe du verrou. Le
// propriétaire légitime se retrouvait enfermé dehors : 403 sur son propre
// déverrouillage, 423 sur sa propre modification. Sa configuration lui était
// confisquée.
//
// Le filtre de LISTE ne protégeait rien ici, et `assertProfileUnlocked` non
// plus : le verrou protège la configuration technique, pas la frontière entre
// exploitants.
//
// Ce banc est volontairement STRUCTUREL. Il n'énumère pas les routes connues —
// il exige que CHAQUE route montée sur `/:id` traverse un contrôle de
// propriété. Une route ajoutée demain sans ce contrôle fait tomber le banc.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Fins de ligne normalisées : le dépôt est édité sous Windows, et un découpage
// sur « \n}\n » rendrait une chaîne vide face à des CRLF — le banc passerait
// alors au vert sans rien vérifier.
const lire = (...p) => readFileSync(join(racine, ...p), 'utf8').replace(/\r\n/g, '\n');
const source = lire('server', 'routes', 'vpn-profiles.ts');

/** Découpe le fichier en handlers : du `router.verbe(` jusqu'au suivant. */
function handlers() {
  const debuts = [...source.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)];
  return debuts.map((m, i) => ({
    methode: m[1].toUpperCase(),
    chemin: m[2],
    corps: source.slice(m.index, i + 1 < debuts.length ? debuts[i + 1].index : source.length),
  }));
}

const CONTROLE = /chargerProfilVisible\(|profilVisible\(/;

test('chaque route en /:id contrôle la propriété du profil', () => {
  const cibles = handlers().filter(h => h.chemin.startsWith('/:id'));
  assert.ok(cibles.length >= 6, `routes /:id trouvées : ${cibles.length}`);
  const sans = cibles
    .filter(h => !CONTROLE.test(h.corps))
    .map(h => `${h.methode} ${h.chemin}`);
  assert.deepEqual(sans, [], `routes sans contrôle de propriété : ${sans.join(', ')}`);
});

test('les routes de la chaîne de prise de contrôle sont couvertes nommément', () => {
  // Filet nommé : si le découpage ci-dessus dérivait, ces six-là restent tenues.
  const attendues = [
    ['POST', '/:id/unlock'],
    ['PUT', '/:id/lock'],
    ['GET', '/:id/resellers'],
    ['PUT', '/:id/resellers'],
    ['PUT', '/:id'],
    ['DELETE', '/:id'],
  ];
  const trouvees = handlers();
  for (const [methode, chemin] of attendues) {
    const h = trouvees.find(x => x.methode === methode && x.chemin === chemin);
    assert.ok(h, `route absente : ${methode} ${chemin}`);
    assert.match(h.corps, CONTROLE, `${methode} ${chemin} ne contrôle pas la propriété`);
  }
});

test('le chargeur impose createdBy même sur une projection partielle', () => {
  // `createdBy` porte la propriété. S'il n'est pas chargé quand l'appelant
  // demande un `select` restreint, le contrôle s'évalue sur `undefined` et
  // laisse tout passer.
  const bloc = source.slice(source.indexOf('async function chargerProfilVisible'));
  const corps = bloc.slice(0, bloc.indexOf('\n}\n') + 1);
  assert.match(corps, /select:\s*\{\s*\.\.\.args\.select,\s*id:\s*true,\s*createdBy:\s*true\s*\}/);
});

test("profil absent et profil d'autrui sont indiscernables", () => {
  // Répondre autre chose que 404 sur le profil d'un tiers confirmerait son
  // existence et permettrait d'énumérer le parc de la plateforme.
  const bloc = source.slice(source.indexOf('async function chargerProfilVisible'));
  const corps = bloc.slice(0, bloc.indexOf('\n}\n') + 1);
  assert.match(corps, /if \(!profil\) return null;/);
  assert.match(corps, /profilVisible\(profil, req\)\) \? profil : null/);

  for (const h of handlers().filter(x => x.chemin.startsWith('/:id'))) {
    if (!h.corps.includes('chargerProfilVisible(')) continue;
    const apres = h.corps.slice(h.corps.indexOf('chargerProfilVisible('));
    assert.match(apres, /status\(404\)/,
      `${h.methode} ${h.chemin} doit répondre 404 sur un profil invisible`);
  }
});

test('le verrou ne remplace pas le contrôle de propriété', () => {
  // assertProfileUnlocked ne lève rien quand le profil n'a pas de verrou : il
  // ne peut donc jamais tenir lieu de frontière entre exploitants.
  const verrou = lire('server', 'services', 'profile-lock.ts');
  const bloc = verrou.slice(verrou.indexOf('export function assertProfileUnlocked'));
  assert.match(bloc.slice(0, 220), /if \(profile\.lockPasswordHash &&/,
    'assertProfileUnlocked est inopérant sans verrou : la prémisse de ce banc',
  );
});

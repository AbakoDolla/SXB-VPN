/**
 * formes-api-liste.test.mjs — Une collection se lit, quelle que soit sa forme.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT QUE CE CONTRÔLE FIGE
 * ═══════════════════════════════════════════════════════════════════════════
 * Les routes de l'API ne s'accordent pas sur la forme d'une collection :
 * certaines renvoient `{ users: [...] }`, d'autres un TABLEAU NU. Le tableau
 * de bord écrivait partout `data.cle || []`, ce qui rendait vide toute route
 * de la seconde famille.
 *
 * Mesuré en production avant correction :
 *   /api/servers → 4 nœuds existent,   0 affichés
 *   /api/users   → 475 comptes existent, 0 affichés
 *
 * Rien ne signalait le problème : pas d'exception, pas de trace. L'écran
 * affirmait simplement « aucun élément », et il fallait comparer à la base
 * pour s'apercevoir du mensonge. Ce contrôle empêche le retour du motif.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API = path.join(RACINE, 'artifacts/sxb-dashboard/src/api');

const lire = (f) => readFileSync(path.join(API, f), 'utf8');

/**
 * Réimplémente `listeDepuis` à l'identique : le fichier est en TypeScript et
 * ces contrôles tournent sans compilation. La copie est minuscule et figée
 * par le contrôle de cohérence plus bas.
 */
function listeDepuis(reponse, cle) {
  if (Array.isArray(reponse)) return reponse;
  if (reponse && typeof reponse === 'object' && Array.isArray(reponse[cle])) return reponse[cle];
  return [];
}

describe('lecture des collections — les deux formes de l’API', () => {
  it('lit une réponse ENVELOPPÉE', () => {
    assert.deepEqual(listeDepuis({ users: [1, 2, 3] }, 'users'), [1, 2, 3]);
  });

  it('lit une réponse en TABLEAU NU — le cas qui était perdu', () => {
    assert.deepEqual(listeDepuis([1, 2, 3], 'users'), [1, 2, 3]);
  });

  it('reproduit les deux pannes constatées en production', () => {
    // /api/servers : quatre nœuds, renvoyés nus.
    const serveurs = [{ name: 'SXB Main Server' }, { name: 'paris' }, { name: 'WARTECH' }, { name: 'TEST' }];
    assert.equal(listeDepuis(serveurs, 'servers').length, 4, 'les 4 nœuds doivent être lus');

    // L'ancienne écriture : `data.servers || []`.
    assert.equal(serveurs.servers ?? undefined, undefined, 'un tableau n’a pas de propriété « servers »');
  });

  it('ne rend jamais autre chose qu’un tableau', () => {
    for (const entree of [null, undefined, 0, '', 'texte', { autre: [1] }, { users: 'pas un tableau' }]) {
      assert.deepEqual(listeDepuis(entree, 'users'), [], `entrée inattendue : ${JSON.stringify(entree)}`);
    }
  });
});

describe('les écrans passent bien par cet utilitaire', () => {
  for (const [fichier, cle] of [['servers.ts', 'servers'], ['users.ts', 'users']]) {
    it(`${fichier} ne lit plus une seule forme`, () => {
      const source = lire(fichier);
      assert.match(source, /listeDepuis</, `${fichier} doit utiliser listeDepuis`);
      assert.ok(
        !new RegExp(`data\\.${cle} \\|\\| \\[\\]`).test(source),
        `${fichier} garde l’ancienne lecture « data.${cle} || [] », qui perd les tableaux nus`,
      );
    });
  }

  it('l’utilitaire partagé se comporte comme ces contrôles le supposent', () => {
    const source = lire('liste.ts');
    assert.match(source, /if \(Array\.isArray\(reponse\)\) return reponse as T\[\];/);
    assert.match(source, /Array\.isArray\(valeur\)/);
  });
});

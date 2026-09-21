import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

describe('mises à jour de l’app — le compteur d’appareils est celui du requérant', () => {
  it('countActivatedDevices reçoit la requête et applique la portée', () => {
    const route = source('server/routes/app-updates.ts');

    // MESURÉ À L'ÉCRAN EN PRODUCTION : un administrateur possédant UN SEUL
    // appareil lisait « APPAREILS ACTIVÉS : 749 », le parc entier. La liste
    // sélectionnable en dessous était pourtant bien cloisonnée — seul le total
    // échappait, parce que la fonction ne recevait pas la requête.
    assert.match(route, /async function countActivatedDevices\(req: AuthenticatedRequest\)/);
    assert.match(route, /const portee = await porteeClients\(prisma, req\.user\)/);
    assert.match(route, /where: etFiltres\(\{ status: "active", deviceId: \{ not: null \} \}, portee\)/);

    // La signature sans argument est le motif qui a produit les fuites
    // précédentes : un handler qui a `req` mais ne le transmet pas.
    assert.doesNotMatch(route, /async function countActivatedDevices\(\)/);
  });

  it('aucun appel ne retombe dans la forme sans portée', () => {
    const route = source('server/routes/app-updates.ts');
    const appels = route.match(/countActivatedDevices\([^)]*\)/g) || [];
    assert.ok(appels.length >= 3, `attendu au moins 3 occurrences, vu ${appels.length}`);
    for (const appel of appels) {
      assert.notEqual(appel, 'countActivatedDevices()', 'un appel sans requête compte toute la plateforme');
    }
  });
});

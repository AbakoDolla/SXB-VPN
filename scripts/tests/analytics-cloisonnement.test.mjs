import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

// Le fichier porte plusieurs routes. `/overview` a été cloisonné auparavant par
// un autre chemin (il compte des `vpnClient` via la portée des clients) et
// conserve légitimement `prisma.user.count({ where: userStealthWhere })` dans sa
// branche de repli. On isole donc le handler `/users` avant d'asserter, sinon
// les gardes anti-régression se déclencheraient sur le voisin.
const handlerUsers = (route) => {
  const debut = route.indexOf('router.get("/users"');
  assert.ok(debut > 0, 'handler /users introuvable');
  const fin = route.indexOf('router.get("/traffic"', debut);
  assert.ok(fin > debut, 'fin du handler /users introuvable');
  return route.slice(debut, fin);
};

describe('analytics — un total est une fuite aussi sûrement qu’une liste', () => {
  it('cloisonne le nombre de comptes, de partenaires et d’agents', () => {
    const route = handlerUsers(source('server/routes/analytics.ts'));

    // MESURÉ EN PRODUCTION AVANT CORRECTION, sur un administrateur au parc VIDE :
    //   { totalUsers: 829, activeVpnClients: 0, activePartners: 18, supportAgents: 0 }
    // soit exactement les chiffres du propriétaire pour `totalUsers` et
    // `activePartners`. Il apprenait l'ampleur du parc qu'on lui cache.
    // `activeVpnClients` était, lui, déjà cloisonné : c'est cet écart qui a
    // désigné le défaut.
    assert.match(route, /const porteeComptesRequerant = await porteeAnnuaireComptes\(prisma, req\.user\)/);
    assert.match(route, /const porteeRevendeursRequerant = await porteeRevendeurs\(prisma, req\.user\)/);

    // Les trois compteurs passent par la portée, plus par la seule furtivité.
    assert.match(route, /prisma\.user\.count\(\{ where: filtreComptes as any \}\)/);
    assert.match(route, /prisma\.reseller\.count\(\{ where: filtreRevendeurs as any \}\)/);
    assert.match(route, /roleId: supportRole\.id \}, porteeComptesRequerant\)/);

    // Les anciennes formes, non cloisonnées, ne doivent pas revenir.
    assert.doesNotMatch(route, /prisma\.user\.count\(\{ where: userStealthWhere \}\)/);
    assert.doesNotMatch(route, /prisma\.reseller\.count\(\{ where: stealthResellerWhere\(requesterIsOwner\) \}\)/);
    assert.doesNotMatch(route, /prisma\.user\.count\(\{ where: \{ roleId: supportRole\.id \} \}\)/);
  });

  it('combine furtivité et portée par un AND explicite, jamais par un spread', () => {
    const route = handlerUsers(source('server/routes/analytics.ts'));
    // `{ ...a, ...b }` écrase silencieusement une clé commune et rendrait un
    // compte trop large. `etFiltres` construit un `AND` qui ne peut pas se tromper.
    assert.match(source('server/routes/analytics.ts'), /import \{ etFiltres \} from "\.\.\/services\/free-trial-marks"/);
    assert.match(route, /etFiltres\(userStealthWhere, porteeComptesRequerant\)/);
    assert.match(route, /etFiltres\(stealthResellerWhere\(requesterIsOwner\), porteeRevendeursRequerant\)/);
  });
});

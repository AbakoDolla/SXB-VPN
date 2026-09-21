/**
 * L'administration du moteur XPanel n'appartient pas à un compte cloisonné.
 *
 * LE DÉFAUT MESURÉ EN PRODUCTION
 * ──────────────────────────────
 * Un ADMIN créé neuf pour la mesure obtenait 200 sur TOUTE la surface :
 *
 *     GET    /api/xpanel/users          -> 200
 *     GET    /api/xpanel/configs        -> 200
 *     POST   /api/xpanel/sync           -> 200  {"success":true}
 *     DELETE /api/xpanel/configs/:id    -> 200  {"success":true}
 *
 * Les habilitations existaient pourtant (`xpanel.view`, `xpanel.manage`) :
 * elles ne bloquaient rien parce que le rôle ADMIN les porte.
 *
 * Or ces routes ne lisent ni n'écrivent de données de locataire. Elles relaient
 * le panneau DISTANT (`/api/subscribers`, `/api/inbounds`), dont les objets
 * n'ont aucun propriétaire : il n'existe rien sur quoi filtrer. Un admin y
 * lirait le parc complet de la plateforme et pourrait supprimer l'entrée d'un
 * autre exploitant. C'est un paramètre global, exclu du périmètre admin.
 *
 * Banc volontairement STRUCTUREL : il n'énumère pas les routes connues. Il
 * exige que CHAQUE route relayant le panneau distant porte le garde-fou. Une
 * route ajoutée demain sans lui fait tomber le banc.
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
const source = lire('server', 'routes', 'xpanel.ts');

/** Découpe le fichier en handlers : du `router.verbe(` jusqu'au suivant. */
function handlers() {
  const debuts = [...source.matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)];
  return debuts.map((m, i) => ({
    methode: m[1].toUpperCase(),
    chemin: m[2],
    corps: source.slice(m.index, i + 1 < debuts.length ? debuts[i + 1].index : source.length),
  }));
}

// Opérations qui traversent vers le panneau distant. `testConnection` en est
// exclu : il ne rend qu'un booléen d'accessibilité, aucune donnée.
const RELAIS = /XPanelService\.(getUsers|getConfigs|createConfig|deleteConfig|sync)\s*\(/;
const GARDE = /refuserCloisonne/;

test('le fichier expose bien des routes à analyser', () => {
  const routes = handlers();
  assert.ok(routes.length >= 5, `routes trouvées : ${routes.length}`);
  assert.ok(
    routes.some((h) => RELAIS.test(h.corps)),
    'aucune route ne relaie le panneau distant : le découpage est cassé',
  );
});

test('toute route relayant le panneau distant porte le garde-fou', () => {
  const sans = handlers()
    .filter((h) => RELAIS.test(h.corps) && !GARDE.test(h.corps))
    .map((h) => `${h.methode} ${h.chemin}`);
  assert.deepEqual(sans, [], `routes ouvertes aux comptes cloisonnés : ${sans.join(', ')}`);
});

test('le garde-fou s’appuie sur le point unique de cloisonnement', () => {
  // Réimplémenter la liste des rôles ici la ferait diverger en silence le jour
  // où un rôle cloisonné est ajouté.
  assert.match(
    source,
    /import\s*\{[^}]*estCloisonne[^}]*\}\s*from\s*"\.\.\/services\/portee-donnees"/,
    'le garde doit importer estCloisonne depuis portee-donnees',
  );
  const debut = source.indexOf('function refuserCloisonne');
  assert.ok(debut > 0, 'refuserCloisonne introuvable');
  const corps = source.slice(debut, debut + 600);
  assert.match(corps, /estCloisonne\(\s*req\.user\?\.role\s*\)/);
  assert.match(corps, /status\(403\)/, 'un refus franc, pas un 404 : rien à énumérer ici');
});

test('l’écran /status reste ouvert, car cloisonné par portée', () => {
  // Contre-épreuve : le garde ne doit pas être appliqué à tort. /status rend
  // les compteurs PROPRES au requérant (porteeClients / porteeServeurs) ; le
  // fermer priverait l'admin d'un écran légitime.
  const statut = handlers().find((h) => h.chemin === '/status');
  assert.ok(statut, 'route /status introuvable');
  assert.ok(!GARDE.test(statut.corps), '/status ne doit pas être fermé aux admins');
  assert.match(statut.corps, /porteeClients\(/);
  assert.match(statut.corps, /porteeServeurs\(/);
});

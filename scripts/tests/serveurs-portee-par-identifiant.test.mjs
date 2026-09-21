/**
 * Un serveur désigné par son identifiant reste dans son compartiment.
 *
 * LE DÉFAUT MESURÉ EN PRODUCTION
 * ──────────────────────────────
 * `GET /api/servers` était bien cloisonné par `porteeServeurs` : un ADMIN créé
 * à l'instant recevait une liste VIDE, là où le compte à haut privilège voyait
 * les 3 serveurs. Mais AUCUNE route prenant un identifiant ne rejouait ce
 * filtre — elles ne contrôlaient que le rôle, et ADMIN y est admis.
 *
 * Mesure, avec un admin neuf, sur un serveur ABSENT de sa propre liste :
 *
 *     GET    /api/servers/:id/config  -> 200   (lecture déchiffrée)
 *     PATCH  /api/servers/:id         -> 200   (modification effective)
 *
 * Deux gravités distinctes, à ne pas confondre :
 *   - la MODIFICATION était réelle : un admin retouchait l'infrastructure
 *     d'un autre exploitant ;
 *   - la LECTURE n'a rien rendu ce jour-là, car aucun serveur ne stocke encore
 *     de configuration (mesuré : 0 entrée sur les 3). La fuite d'identifiants
 *     SSH en clair était donc LATENTE — elle s'ouvrait au premier
 *     enregistrement de configuration.
 *
 * `DELETE /:id` partageait la même absence de filtre. Elle n'a délibérément
 * PAS été mesurée : on ne prouve pas une faille en détruisant un serveur de
 * production, ce qui couperait le service de tous ses clients.
 *
 * POURQUOI 404 ET NON 403
 * ───────────────────────
 * Un 403 confirmerait l'existence du serveur visé et permettrait d'énumérer le
 * parc identifiant par identifiant. Hors de son compartiment, un serveur
 * n'existe pas. (Distinct de XPanel, fermé en 403 franc : là-bas la route est
 * une capacité plateforme sans propriétaire — il n'y a rien à énumérer.)
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
const source = lire('server', 'routes', 'servers.ts');

/** Découpe le fichier en handlers : du `router.verbe(` jusqu'au suivant. */
function handlers() {
  const debuts = [...source.matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)];
  return debuts.map((m, i) => ({
    methode: m[1].toUpperCase(),
    chemin: m[2],
    corps: source.slice(m.index, i + 1 < debuts.length ? debuts[i + 1].index : source.length),
  }));
}

const GARDE = /chargerServeurVisible\s*\(/;
const aIdentifiant = (h) => h.chemin.includes(':id');

test('le fichier expose bien des routes à analyser', () => {
  const routes = handlers();
  assert.ok(routes.length >= 6, `routes trouvées : ${routes.length}`);
  assert.ok(
    routes.filter(aIdentifiant).length >= 4,
    'aucune route à identifiant : le découpage est cassé',
  );
});

test('toute route désignant un serveur par identifiant vérifie la portée', () => {
  const sans = handlers()
    .filter((h) => aIdentifiant(h) && !GARDE.test(h.corps))
    .map((h) => `${h.methode} ${h.chemin}`);
  assert.deepEqual(sans, [], `routes sans contrôle de propriété : ${sans.join(', ')}`);
});

test('les quatre routes historiquement ouvertes sont couvertes', () => {
  // Le banc structurel ci-dessus suffirait, mais nommer les routes mesurées
  // documente ce qui était réellement ouvert le jour du constat.
  const attendues = [
    'PATCH /:id',
    'POST /:id/config',
    'GET /:id/config',
    'DELETE /:id',
  ];
  const gardees = handlers()
    .filter((h) => GARDE.test(h.corps))
    .map((h) => `${h.methode} ${h.chemin}`);
  for (const route of attendues) {
    assert.ok(gardees.includes(route), `${route} ne porte pas le garde-fou`);
  }
});

test('le garde-fou s’appuie sur le point unique de cloisonnement', () => {
  // Réimplémenter la règle de portée ici la ferait diverger en silence le jour
  // où l'arbre de propriété change.
  assert.match(
    source,
    /import\s*\{[^}]*porteeServeurs[^}]*\}\s*from\s*"\.\.\/services\/portee-donnees"/,
    'le garde doit importer porteeServeurs depuis portee-donnees',
  );
  const debut = source.indexOf('async function chargerServeurVisible');
  assert.ok(debut > 0, 'chargerServeurVisible introuvable');
  const corps = source.slice(debut, source.indexOf('const SERVEUR_INTROUVABLE'));
  assert.match(corps, /porteeServeurs\(\s*prisma\s*,\s*req\.user\s*\)/);
  assert.match(corps, /findFirst/, 'la portée doit être appliquée DANS la requête');
  assert.ok(
    !/findUnique/.test(corps),
    'findUnique ignore le filtre de portée : la propriété ne serait pas vérifiée',
  );
});

test('le refus est un 404 indifférencié, jamais un 403', () => {
  // Un 403 confirmerait l'existence du serveur et permettrait d'énumérer le
  // parc. Le message doit être celui d'un serveur introuvable.
  //
  // On vérifie l'ORDRE plutôt qu'une distance en caractères : `DELETE` décide
  // du refus plus bas que les autres, après avoir repris le nom du serveur
  // pour le journal. Ce qui compte est que la portée soit consultée AVANT le
  // refus, et qu'aucune lecture non filtrée ne se glisse entre les deux.
  assert.match(
    source,
    /const SERVEUR_INTROUVABLE = \{[^}]*errors\.servers\.not_found/,
    'le refus doit réutiliser le message « introuvable »',
  );
  for (const h of handlers().filter((x) => GARDE.test(x.corps))) {
    const garde = h.corps.search(GARDE);
    const refus = h.corps.indexOf('status(404).json(SERVEUR_INTROUVABLE)');
    assert.ok(
      refus > garde,
      `${h.methode} ${h.chemin} doit refuser en 404 indifférencié après contrôle de portée`,
    );
    assert.ok(
      !/findUnique/.test(h.corps.slice(garde, refus)),
      `${h.methode} ${h.chemin} relit le serveur sans filtre entre la portée et le refus`,
    );
  }
});

test('la liste et la création ne sont pas fermées à tort', () => {
  // Contre-épreuve : le garde ne s'applique qu'aux routes désignant un serveur
  // existant. L'appliquer à la liste ou à la création casserait l'écran.
  for (const chemin of ['/']) {
    for (const h of handlers().filter((x) => x.chemin === chemin)) {
      assert.ok(
        !GARDE.test(h.corps),
        `${h.methode} ${chemin} ne désigne aucun serveur : le garde n'a pas lieu d'être`,
      );
    }
  }
  const liste = handlers().find((h) => h.methode === 'GET' && h.chemin === '/');
  assert.ok(liste, 'route de liste introuvable');
  assert.match(liste.corps, /porteeServeurs\(/, 'la liste doit rester cloisonnée');
});

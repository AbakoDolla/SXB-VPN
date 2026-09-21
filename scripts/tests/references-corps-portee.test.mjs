/**
 * Une référence venue du CORPS de la requête est cloisonnée comme une
 * référence venue de l'URL.
 *
 * L'ANGLE MORT QUE CE BANC FERME
 * ──────────────────────────────
 * Le cloisonnement de la plateforme s'est construit route par route, et
 * toujours sur `req.params.id`. `chargerProfilVisible` (vpn-profiles.ts) lit
 * même cet identifiant EN DUR : il ne pouvait structurellement pas couvrir un
 * identifiant lu dans `req.body`.
 *
 * Un recensement des routes citant une ressource par le corps a rendu un
 * résultat trompeur : 9 routes sur 9 portaient un marqueur de portée. La
 * lecture à la main a montré que ces marqueurs portaient sur AUTRE CHOSE que
 * la référence du corps. D'où la règle que ce banc inscrit dans le dépôt :
 *
 *     un marqueur de portée dans un fichier prouve qu'une portée existe,
 *     jamais qu'elle couvre la référence venue de `req.body`.
 *
 * LE DÉFAUT MESURÉ EN PRODUCTION — POST /api/config-test
 * ──────────────────────────────────────────────────────
 * Avec un administrateur créé à l'instant, dont la liste de profils était vide
 * (0 profil visible sur 80) :
 *
 *     profileId inexistant          ->  404 Profile not found
 *     profileId d'un AUTRE locataire ->  423 PROFILE_LOCKED
 *
 * L'écart prouve deux choses d'un coup. La ligne d'autrui était bien CHARGÉE —
 * sans quoi la route n'aurait rien eu à verrouiller. Et la route distinguait
 * « n'existe pas » de « existe, mais pas à vous » : un oracle d'énumération du
 * parc, exploitable sans rien déverrouiller.
 *
 * Le verrou n'était pas la portée : `assertProfileUnlocked` est un mot de
 * passe de profil, pas une preuve de propriété. Il n'a arrêté la chaîne que
 * parce que les 80 profils de production sont verrouillés. Un profil sans
 * verrou allait jusqu'au déchiffrement de `canonicalConfig`, à la connexion
 * sortante, puis à l'écriture de `validatedAt` dans la ligne de la victime.
 *
 * CE QUE LA SONDE N'EMPORTE PAS — vérifié, et non recopié d'un commentaire
 * ───────────────────────────────────────────────────────────────────────
 * `probeConfig` (transport-probe.ts) ne lit du canonique que `protocol`,
 * `network`, `sshTransport`, `slowDns`, `host`, `port` et `payload`. Ni `uuid`,
 * ni `password`, ni `username`. La sonde rejoue donc le TRANSPORT et n'ouvre
 * aucune session authentifiée chez le fournisseur de la victime. La population
 * concernée est bornée aux comptes portant `vpnprofile.manage`, et non « tout
 * le monde ». Les deux précisions vont dans le sens qui DIMINUE la gravité :
 * elles sont ici pour que le constat reste vérifiable, pas impressionnant.
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

/**
 * Retire les commentaires avant toute analyse d'ORDRE.
 *
 * Sans cela, une prose citant `assertProfileUnlocked` ou `findUnique` pèserait
 * autant qu'un appel réel : le banc deviendrait sensible à ce qu'on ÉCRIT sur
 * le code plutôt qu'à ce que le code FAIT. C'est la même confusion que celle
 * qui a produit l'angle mort de départ, et elle s'est produite ici même — la
 * première exécution de ce banc est tombée sur un commentaire que je venais
 * d'écrire. Seules les lignes commençant par `//` sont retirées, afin de ne
 * jamais mutiler une URL contenue dans une chaîne.
 */
const sansCommentaires = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** Source d'une route, commentaires retirés : ce que le code fait réellement. */
const code = (fichier) => sansCommentaires(lire('server', 'routes', fichier));

/** Découpe un fichier de routes en handlers : du `router.verbe(` jusqu'au suivant. */
function handlers(source) {
  const debuts = [...source.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)];
  return debuts.map((m, i) => ({
    methode: m[1].toUpperCase(),
    chemin: m[2],
    corps: source.slice(m.index, i + 1 < debuts.length ? debuts[i + 1].index : source.length),
  }));
}

const trouver = (source, methode, chemin) => {
  const h = handlers(source).find((x) => x.methode === methode && x.chemin === chemin);
  assert.ok(h, `route ${methode} ${chemin} introuvable — le découpage est cassé`);
  return h;
};

// ── POST /api/config-test ────────────────────────────────────────────────────

test('config-test : le profil du corps est chargé DANS la portée de l’appelant', () => {
  const source = code('config-test.ts');
  assert.match(
    source,
    /import\s*\{[^}]*porteeProfils[^}]*\}\s*from\s*'\.\.\/services\/portee-donnees'/,
    'le garde doit s’appuyer sur le point unique de cloisonnement',
  );

  const h = trouver(source, 'POST', '/');
  const portee = h.corps.indexOf('porteeProfils(');
  assert.ok(portee > 0, 'la portée des profils n’est pas consultée');

  // `findUnique` ignorerait le filtre : la propriété ne serait pas vérifiée.
  assert.ok(
    !/vpnProfile\.findUnique/.test(h.corps),
    'findUnique sur vpnProfile ignore la portée : utiliser findFirst',
  );
  assert.ok(
    portee < h.corps.indexOf('vpnProfile.findFirst'),
    'la portée doit être établie avant la lecture du profil',
  );
});

test('config-test : un profil d’autrui est indiscernable d’un profil absent', () => {
  const source = code('config-test.ts');
  const h = trouver(source, 'POST', '/');

  const refus = h.corps.indexOf("status(404).json({ error: 'Profile not found' })");
  assert.ok(refus > 0, 'le refus 404 indifférencié a disparu');

  // Le cœur de l'affaire : si une vérification de VERROU s'exécutait avant le
  // 404, un profil d'autrui rendrait 423 là où un identifiant inexistant rend
  // 404 — exactement l'oracle mesuré en production.
  const verrou = h.corps.indexOf('assertProfileUnlocked');
  assert.ok(verrou > 0, 'assertProfileUnlocked a disparu du handler');
  assert.ok(
    refus < verrou,
    'le 404 doit précéder toute vérification de verrou, sinon la réponse '
      + 'révèle l’existence du profil d’un autre locataire',
  );

  // Et rien ne doit déchiffrer ni sonder avant ce refus.
  const avant = h.corps.slice(0, refus);
  assert.ok(!/decryptCanonical\(/.test(avant), 'déchiffrement avant contrôle de portée');
  assert.ok(!/probeConfig\(/.test(avant), 'sonde sortante avant contrôle de portée');
  assert.ok(!/updateMany\(|\.update\(/.test(avant), 'écriture avant contrôle de portée');
});

test('config-test : l’en-tête ne prétend plus que la route est publique', () => {
  const source = lire('server', 'routes', 'config-test.ts');
  const entete = source.slice(0, source.indexOf('import '));
  // Un en-tête faux est pire qu'absent : celui-ci annonçait « Aucune
  // authentification » pour une route qui exige une session ET une permission.
  assert.ok(
    !/Aucune authentification/.test(entete),
    'l’en-tête doit distinguer la SONDE (sans credential) de la ROUTE (authentifiée)',
  );
  assert.match(source, /requireAuth/, 'la route reste authentifiée');
  assert.match(source, /requirePermission\('vpnprofile\.manage'\)/, 'la permission reste exigée');
});

// ── /api/ssh/accounts — la charge désignée par le corps ──────────────────────

test('ssh : le garde de charge s’appuie sur la portée et filtre DANS la requête', () => {
  const source = code('ssh.ts');
  assert.match(
    source,
    /import\s*\{[^}]*porteeCharges[^}]*\}\s*from\s*'\.\.\/services\/portee-donnees'/,
    'le garde doit importer porteeCharges depuis portee-donnees',
  );
  const debut = source.indexOf('async function chargeAttribuable');
  assert.ok(debut > 0, 'chargeAttribuable introuvable');
  const corps = source.slice(debut, debut + 500);
  assert.match(corps, /porteeCharges\(\s*prisma\s*,\s*req\.user\s*\)/);
  assert.match(corps, /findFirst/, 'la portée doit être appliquée DANS la requête');
  assert.ok(
    !/findUnique/.test(corps),
    'findUnique ignore le filtre de portée : la propriété ne serait pas vérifiée',
  );
});

test('ssh : toute route acceptant payloadId vérifie la charge avant d’écrire', () => {
  const source = code('ssh.ts');
  // Structurel : une route ajoutée demain avec `payloadId` dans son corps et
  // sans garde fera tomber ce banc.
  const concernees = handlers(source).filter(
    (h) => /\bpayloadId\b/.test(h.corps) && /(create|update)\(/.test(h.corps),
  );
  assert.ok(concernees.length >= 2, `routes concernées : ${concernees.length}`);

  for (const h of concernees) {
    const garde = h.corps.indexOf('chargeAttribuable(');
    assert.ok(
      garde > 0,
      `${h.methode} ${h.chemin} écrit payloadId sans vérifier la propriété de la charge`,
    );
    const ecriture = Math.min(
      ...['createLockedEngineAccount(', 'withUnlockedEngine(']
        .map((m) => h.corps.indexOf(m))
        .filter((i) => i > 0),
    );
    assert.ok(
      garde < ecriture,
      `${h.methode} ${h.chemin} doit vérifier la charge AVANT l’écriture`,
    );
    assert.match(
      h.corps.slice(garde, garde + 220),
      /status\(404\)/,
      `${h.methode} ${h.chemin} doit refuser en 404 indifférencié`,
    );
  }
});

// ── PUT /api/vpn-profiles/:id/resellers — les revendeurs du corps ────────────

test('vpn-profiles : les revendeurs du corps sont cherchés dans la portée', () => {
  const source = code('vpn-profiles.ts');
  assert.match(
    source,
    /import\s*\{[^}]*porteeRevendeurs[^}]*\}\s*from\s*'\.\.\/services\/portee-donnees'/,
    'le garde doit importer porteeRevendeurs depuis portee-donnees',
  );

  const h = trouver(source, 'PUT', '/:id/resellers');
  const portee = h.corps.indexOf('porteeRevendeurs(');
  const lecture = h.corps.indexOf('reseller.findMany(');
  assert.ok(portee > 0, 'la portée des revendeurs n’est pas consultée');
  assert.ok(lecture > 0, 'la lecture des revendeurs a changé de forme');
  assert.ok(
    portee < lecture,
    'la portée doit être établie avant de résoudre les identifiants du corps',
  );
  // Le profil visé, lui, vient de l'URL : son garde-fou doit rester en place.
  assert.match(h.corps, /chargerProfilVisible\(/, 'le profil visé doit rester cloisonné');
});

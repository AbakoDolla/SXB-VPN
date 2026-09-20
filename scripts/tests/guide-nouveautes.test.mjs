/**
 * Guide des nouveautés — la règle « une fois, puis à chaque livraison ».
 *
 * CE QUI EST VÉRIFIÉ ICI
 * ──────────────────────
 * Le guide s'ouvre une seule fois par personne, puis réapparaît quand une
 * nouvelle livraison change la version. Cette règle tient à une fonction PURE
 * et à quelques invariants sur le contenu — tous vérifiables sans navigateur,
 * donc revérifiés à chaque exécution de la CI.
 *
 * Le rendu lui-même a été regardé en vrai, dans les deux langues.
 */
import './register-hooks.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tableauDeBord = path.join(racine, 'artifacts', 'sxb-dashboard');
const lire = (relatif) => readFileSync(path.join(tableauDeBord, relatif), 'utf8');
const dictionnaire = (langue) => JSON.parse(lire(`src/locales/${langue}/nouveautes.json`));

const {
  ETAPES_NOUVEAUTES, LIEN_TELECHARGEMENT, VERSION_NOUVEAUTES, doitAfficherNouveautes,
} = await import('../../artifacts/sxb-dashboard/src/lib/nouveautes.ts');

test('le guide s’affiche UNE FOIS, puis à chaque nouvelle livraison', () => {
  // Jamais vu : on montre.
  assert.equal(doitAfficherNouveautes(null), true);
  assert.equal(doitAfficherNouveautes(undefined), true);
  assert.equal(doitAfficherNouveautes(''), true);

  // Vu à la version courante : on ne montre plus. C'est le « une seule fois ».
  assert.equal(doitAfficherNouveautes(VERSION_NOUVEAUTES), false);

  // Vu à une version ANTÉRIEURE : on remontre. C'est le « à chaque mise à jour
  // désormais » — la seule chose à faire pour la prochaine livraison est de
  // changer `VERSION_NOUVEAUTES`.
  assert.equal(doitAfficherNouveautes('2026-01-01'), true);

  // Une valeur illisible fait réapparaître le guide plutôt que de le taire :
  // revoir un guide est sans gravité, le manquer prive d'une information qu'on
  // a décidé de donner.
  assert.equal(doitAfficherNouveautes('{"corrompu":true}'), true);
});

test('chaque étape est écrite dans LES DEUX langues, sans trou', () => {
  // Une clé absente s'afficherait telle quelle à l'écran —
  // « nouveautes.etapes.conversion.titre » au lieu d'une phrase.
  for (const langue of ['fr', 'en']) {
    const textes = dictionnaire(langue);
    for (const cle of ['titre', 'exemple', 'passer', 'precedent', 'suivant', 'terminer']) {
      assert.equal(typeof textes[cle], 'string', `${langue} : ${cle} manquant`);
      assert.ok(textes[cle].trim(), `${langue} : ${cle} vide`);
    }
    for (const etape of ETAPES_NOUVEAUTES) {
      const bloc = textes.etapes?.[etape.id];
      assert.ok(bloc, `${langue} : étape « ${etape.id} » absente`);
      for (const champ of ['titre', 'texte', 'exemple']) {
        assert.equal(typeof bloc[champ], 'string', `${langue}/${etape.id} : ${champ} manquant`);
        assert.ok(bloc[champ].trim(), `${langue}/${etape.id} : ${champ} vide`);
      }
      // Une étape qui porte un lien doit porter son libellé, sinon le bouton
      // s'afficherait vide.
      if (etape.lien) {
        assert.ok(bloc.lien && bloc.lien.trim(), `${langue}/${etape.id} : libellé de lien manquant`);
      }
    }
  }
});

test('les deux langues décrivent EXACTEMENT les mêmes étapes', () => {
  // Sans cela, une étape ajoutée en français resterait muette en anglais.
  const attendues = ETAPES_NOUVEAUTES.map(e => e.id).sort();
  for (const langue of ['fr', 'en']) {
    assert.deepEqual(Object.keys(dictionnaire(langue).etapes).sort(), attendues,
      `${langue} : le dictionnaire et le registre doivent décrire les mêmes étapes`);
  }
});

test('le guide porte le lien de la page publique de téléchargement', () => {
  // Demande explicite du propriétaire : le guide doit mener à cette page.
  assert.equal(LIEN_TELECHARGEMENT, 'https://vpnsxb.afrihall.com/telecharger.html');
  assert.equal(ETAPES_NOUVEAUTES.filter(e => e.lien === LIEN_TELECHARGEMENT).length, 1,
    'une seule étape doit porter ce lien');
  // Sortir du tableau de bord exige une adresse ABSOLUE en HTTPS : un chemin
  // relatif mènerait à une page du tableau de bord qui n'existe pas.
  for (const etape of ETAPES_NOUVEAUTES) {
    if (etape.lien) assert.ok(etape.lien.startsWith('https://'), `${etape.id} : lien non HTTPS`);
  }
});

test('le guide se ferme, se mémorise, et ne bloque jamais le travail', () => {
  const source = lire('src/components/GuideNouveautes.tsx');
  // Trois sorties : la croix, « Passer », et la touche Échap. Un guide dont on
  // ne peut pas sortir se fait fermer sans être lu.
  assert.match(source, /nouveautes\.passer/);
  assert.match(source, /evenement\.key === 'Escape'/);
  // La fermeture écrit la version, sinon le guide reviendrait à chaque
  // chargement de page.
  assert.match(source, /setItem\(CLE_NOUVEAUTES_VUES, VERSION_NOUVEAUTES\)/);
  // Un navigateur qui refuse le stockage ne doit pas empêcher le tableau de
  // bord de s'afficher : on renonce au guide, pas à l'application.
  assert.match(source, /try \{[\s\S]{0,300}localStorage[\s\S]{0,300}\} catch/);
  // Aucun texte en dur : tout passe par la traduction.
  assert.doesNotMatch(source, />\s*[A-ZÉÀ][a-zéèàû]{4,}[^<{]*</,
    'le guide ne doit porter aucun texte écrit en dur');
});

test('le guide est monté une seule fois, dans le tableau de bord authentifié', () => {
  const app = lire('src/App.tsx');
  assert.match(app, /import GuideNouveautes from "\.\/components\/GuideNouveautes"/);
  assert.equal((app.match(/<GuideNouveautes \/>/g) || []).length, 1,
    'un seul point de montage, sinon le guide s’ouvrirait en double');
  // Monté DANS le Layout : il s'adresse à quelqu'un de connecté, jamais à un
  // visiteur de l'écran de connexion.
  const layout = app.slice(app.indexOf('<Layout'), app.indexOf('</Layout>'));
  assert.match(layout, /<GuideNouveautes \/>/);
});

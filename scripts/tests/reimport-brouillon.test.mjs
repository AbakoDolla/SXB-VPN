/**
 * reimport-brouillon.test.mjs — Modifier une config, pas la remplacer à l'aveugle.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT QUE CES CONTRÔLES FIGENT
 * ═══════════════════════════════════════════════════════════════════════════
 * Le réimport est la SEULE voie de modification technique d'une configuration,
 * et son champ s'ouvrait VIDE. Pour changer un seul détail — un port, un
 * chemin WebSocket — l'exploitant devait retrouver la configuration d'origine
 * ailleurs et la recoller en entier. Sans elle, la configuration devenait de
 * fait non modifiable : le mot de passe déjà saisi ne servait à rien, et le
 * verrou paraissait ne jamais s'ouvrir.
 *
 * S'y ajoutait que la seule voie de modification était un lien discret, sous
 * un bandeau qui annonçait « champs immuables » en premier.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA LIMITE QUI RESTE, ET QUI EST VOULUE
 * ═══════════════════════════════════════════════════════════════════════════
 * Le serveur ne renvoie JAMAIS les identifiants : mot de passe masqué, UUID
 * et payload chiffrés. Le brouillon ne peut donc pas être complet, et c'est
 * une protection qu'on ne contourne pas pour du confort. Il porte un marqueur
 * voyant, l'écran le signale, et l'enregistrement le refuse.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lire = (p) => readFileSync(path.join(RACINE, p), 'utf8');

const VUE = lire('artifacts/sxb-dashboard/src/components/VpnProfilesView.tsx');

/**
 * Compile et exécute le module RÉEL.
 *
 * On n'éprouve pas une copie de la logique : c'est le fichier de production
 * qui tourne. Son seul import est un `import type`, effacé à la compilation —
 * le module n'a donc aucune dépendance à l'exécution.
 */
const requireLocal = createRequire(path.join(RACINE, 'backend', 'package.json'));
const { build } = requireLocal('esbuild');
const compile = await build({
  entryPoints: [path.join(RACINE, 'artifacts/sxb-dashboard/src/lib/brouillonReimport.ts')],
  bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
});
const module = { exports: {} };
new Function('module', 'exports', 'require', compile.outputFiles[0].text)(module, module.exports, requireLocal);
const { brouillonDepuisProfil, MARQUEUR_SECRET } = module.exports;

/** Un profil VLESS déverrouillé, tel que le serveur le renvoie. */
const VLESS = {
  name: 'Orange WS',
  protocol: 'vless',
  host: 'crashlyticsreports-pa.googleapis.com',
  port: 443,
  uuid: 'ae446a7b-9988-4353-80c7-050a915e1a1e',
  network: 'ws',
  tls: true,
  sni: 'crashlyticsreports-pa.googleapis.com',
  path: '/@stuff006',
};

describe('brouillon de réimport — repartir de ce qui existe', () => {
  it('reconstruit une URI complète depuis un profil déverrouillé', () => {
    const b = brouillonDepuisProfil(VLESS);
    assert.ok(b, 'un profil complet doit produire un brouillon');
    assert.match(b.texte, /^vless:\/\//);
    assert.ok(b.texte.includes('ae446a7b-9988-4353-80c7-050a915e1a1e'));
    assert.ok(b.texte.includes('crashlyticsreports-pa.googleapis.com:443'));
    assert.deepEqual(b.aCompleter, [], 'rien à ressaisir quand tout est lisible');
  });

  it('reporte le transport, le TLS, le SNI et le chemin', () => {
    const { texte } = brouillonDepuisProfil(VLESS);
    const q = new URLSearchParams(texte.slice(texte.indexOf('?') + 1, texte.indexOf('#')));
    assert.equal(q.get('type'), 'ws');
    assert.equal(q.get('security'), 'tls');
    assert.equal(q.get('sni'), 'crashlyticsreports-pa.googleapis.com');
    assert.equal(q.get('path'), '/@stuff006');
  });

  it('signale ce que le serveur ne divulgue pas, au lieu de l’inventer', () => {
    // Sans UUID lisible, remplir le champ d'une valeur plausible produirait
    // une configuration fausse que rien ne distinguerait d'une bonne.
    const b = brouillonDepuisProfil({ ...VLESS, uuid: undefined });
    assert.ok(b.texte.includes(MARQUEUR_SECRET));
    assert.deepEqual(b.aCompleter, ['uuid']);
  });

  it('nomme « username » pour les protocoles qui en portent un', () => {
    const b = brouillonDepuisProfil({ name: 'SSH', protocol: 'ssh', host: '5.75.179.98', port: 443 });
    assert.deepEqual(b.aCompleter, ['username']);
    assert.ok(b.texte.startsWith('ssh://'));
  });

  it('ne produit RIEN plutôt qu’un brouillon faux', () => {
    // Un brouillon erroné ferait perdre plus de temps qu'une page blanche.
    for (const incomplet of [null, undefined, {}, { protocol: 'vless' }, { host: 'x' }]) {
      assert.equal(brouillonDepuisProfil(incomplet), null, JSON.stringify(incomplet));
    }
  });

  it('n’écrit pas les champs absents', () => {
    const { texte } = brouillonDepuisProfil({ protocol: 'trojan', host: 'a.b', uuid: 'x' });
    assert.ok(!texte.includes('undefined'), texte);
    assert.ok(!texte.includes('null'), texte);
    assert.ok(!texte.includes('?'), 'aucun paramètre ne doit être inventé');
  });
});

describe('l’écran rend la modification possible, et visible', () => {
  it('le bandeau propose de modifier, au lieu de seulement figer', () => {
    // La seule voie de modification était un lien discret sous un bandeau qui
    // annonçait l'immuabilité : on croyait la configuration bloquée.
    assert.match(VUE, /onClick=\{ouvrirReimport\}/);
    assert.match(VUE, /configurations\.ui\.modifyConfig/);
  });

  it('ouvrir le réimport PRÉCHARGE la configuration en place', () => {
    assert.match(VUE, /const brouillon = brouillonDepuisProfil\(editingProfile\);/);
    assert.match(VUE, /setReimportConfig\(brouillon\.texte\)/);
    // Ne jamais écraser une saisie déjà commencée.
    assert.match(VUE, /if \(reimportConfig\.trim\(\)\) return;/);
  });

  it('les champs non divulgués sont signalés à l’exploitant', () => {
    assert.match(VUE, /champsARessaisir\.length > 0/);
    assert.match(VUE, /configurations\.ui\.reimportSecretsMissing/);
  });

  it('un marqueur ne peut PAS être enregistré', () => {
    // Le laisser partir écrirait « à ressaisir » comme mot de passe : la
    // configuration serait cassée sans que rien ne le dise.
    assert.match(VUE, /if \(reimportConfig\.includes\(MARQUEUR_SECRET\)\)/);
    assert.match(VUE, /configurations\.ui\.reimportSecretsPending/);
  });

  it('les libellés existent dans les deux langues', () => {
    for (const langue of ['fr', 'en']) {
      const l = JSON.parse(lire(`artifacts/sxb-dashboard/src/locales/${langue}/configurations.json`));
      for (const cle of ['modifyConfig', 'reimportSecretsMissing', 'reimportSecretsPending']) {
        assert.ok(typeof l.ui?.[cle] === 'string' && l.ui[cle].length > 0, `« ${cle} » manquant en ${langue}`);
      }
    }
  });
});

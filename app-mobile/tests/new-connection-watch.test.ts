/**
 * new-connection-watch.test.ts — « une nouvelle connexion vous attend ».
 *
 * DÉFAUT CORRIGÉ : lorsqu'une connexion était déployée depuis le tableau de
 * bord, l'application ne l'apprenait qu'au prochain démarrage, ou si
 * l'utilisateur pensait de lui-même à rafraîchir. Rien ne le lui disait — il
 * devait le deviner.
 *
 * Les cas éprouvés ici sont ceux où une détection naïve trompe l'utilisateur :
 * le tout premier lancement, un échange à nombre constant, et un rafraîchissement
 * qui échoue.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';

const mobile = path.resolve(__dirname, '..');
const requireMobile = createRequire(path.join(mobile, 'package.json'));
const { build } = createRequire(requireMobile.resolve('tsx'))('esbuild');

type Veille = typeof import('../services/newConnectionWatch');

/**
 * Monte le module RÉEL avec un stockage en mémoire.
 *
 * On n'éprouve pas une copie de la logique : c'est le fichier de production qui
 * tourne, avec le seul AsyncStorage remplacé.
 */
async function veille(): Promise<{ module: Veille; stockage: Map<string, string> }> {
  const output = await build({
    stdin: {
      contents: `
        export { state } from 'test:state';
        export * as watch from './services/newConnectionWatch';
      `,
      resolveDir: mobile,
      loader: 'ts',
    },
    bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
    plugins: [{
      name: 'stubs',
      setup(builder: any) {
        const stubs: Record<string, string> = {
          'test:state': 'export const state = { storage: new Map() };',
          '@react-native-async-storage/async-storage': `import {state} from 'test:state'; export default {
            getItem: async key => state.storage.has(key) ? state.storage.get(key) : null,
            setItem: async (key,value) => {state.storage.set(key,value)},
            removeItem: async key => {state.storage.delete(key)},
          };`,
        };
        builder.onResolve({ filter: /.*/ }, (args: { path: string }) =>
          stubs[args.path] ? { path: args.path, namespace: 'stub' } : undefined);
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args: { path: string }) =>
          ({ contents: stubs[args.path], loader: 'ts', resolveDir: mobile }));
      },
    }],
  });
  const module = { exports: {} as any };
  runInNewContext(output.outputFiles[0].text, { module, exports: module.exports, console });
  return { module: module.exports.watch, stockage: module.exports.state.storage };
}

describe('nouvelle connexion déployée', () => {
  it('n’annonce RIEN au tout premier lancement', async () => {
    // Sans cette adoption initiale, un utilisateur qui ouvre l'application pour
    // la première fois — ou après une réinstallation — verrait TOUTES ses
    // connexions habituelles présentées comme des nouveautés.
    const { module, stockage } = await veille();
    assert.deepEqual(Array.from(await module.connexionsNouvelles(['a', 'b', 'c'])), []);
    // Et l'existant est bien adopté : la fois suivante ne ment pas non plus.
    assert.deepEqual(Array.from(await module.connexionsNouvelles(['a', 'b', 'c'])), []);
    assert.ok(stockage.size > 0, 'la mémoire doit être persistée dès le premier passage');
  });

  it('signale ce qui est réellement nouveau, une seule fois', async () => {
    const { module } = await veille();
    await module.connexionsNouvelles(['a', 'b']);

    assert.deepEqual(Array.from(await module.connexionsNouvelles(['a', 'b', 'c'])), ['c']);
    // Tant que l'utilisateur n'a pas été informé, l'annonce PERSISTE : mémoriser
    // au moment de la détection la ferait disparaître si l'écran se recompose.
    assert.deepEqual(Array.from(await module.connexionsNouvelles(['a', 'b', 'c'])), ['c']);

    await module.memoriser(['c']);
    assert.deepEqual(Array.from(await module.connexionsNouvelles(['a', 'b', 'c'])), []);
  });

  it('voit un échange à nombre constant, qu’un compteur raterait', async () => {
    // Le piège d'une détection par le NOMBRE : une connexion retirée et une
    // autre ajoutée dans le même intervalle laissent le total inchangé, alors
    // qu'il y a bien du neuf à charger.
    const { module } = await veille();
    await module.connexionsNouvelles(['a', 'b']);
    assert.deepEqual(Array.from(await module.connexionsNouvelles(['a', 'z'])), ['z']);
  });

  it('ne perd pas l’annonce quand la mémoire est illisible', async () => {
    // Un stockage corrompu ne doit pas faire tomber l'écran d'accueil.
    const { module, stockage } = await veille();
    await module.connexionsNouvelles(['a']);
    stockage.set('@sxb_seen_connections_v1', '{ ceci n’est pas du JSON');
    // On repart d'une mémoire vide : une annonce de trop, jamais un plantage.
    assert.deepEqual(Array.from(await module.connexionsNouvelles(['a'])), ['a']);
  });

  it('ignore les identifiants vides plutôt que de les annoncer', async () => {
    const { module } = await veille();
    await module.connexionsNouvelles(['a']);
    assert.deepEqual(Array.from(await module.connexionsNouvelles(['a', '', null as any, undefined as any])), []);
  });

  it('oublie tout à la désactivation de l’appareil', async () => {
    const { module, stockage } = await veille();
    await module.connexionsNouvelles(['a', 'b']);
    await module.oublierConnexionsVues();
    assert.equal(stockage.has('@sxb_seen_connections_v1'), false);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * « J'APPUIE SUR CHARGER ET ÇA S'AFFICHE UNE DEUXIÈME FOIS »
 * ═══════════════════════════════════════════════════════════════════════════
 * L'écran d'accueil enchaînait, à l'appui sur « Charger » :
 *
 *     setNouvellesConnexions([])   → l'annonce disparaît
 *     await handleRefresh()        → relit /mobile/connections
 *                                    ET RELANCE la détection
 *     await memoriser(nouvelles)   → trop tard
 *
 * La détection relisait une mémoire qui ne contenait pas encore ces
 * identifiants : elle les redonnait, et l'annonce revenait. À TOUS LES COUPS,
 * jamais par intermittence — ce qui explique que l'exploitant l'ait constaté
 * du premier essai.
 *
 * Ces contrôles rejouent les DEUX ordres sur le module réel, et montrent que
 * seul l'ordre corrigé éteint l'annonce.
 */
describe('appui sur « Charger » — l’ordre des opérations', () => {
  /**
   * Rejoue le geste de l'utilisateur.
   *
   * `memoriseAvant` choisit l'ordre : `false` reproduit le code fautif, `true`
   * celui qui est en production depuis la correction. La « détection » est
   * l'appel que `fetchConnections` fait pendant le rafraîchissement.
   */
  async function appuyerSurCharger(
    module: Veille,
    ids: string[],
    { memoriseAvant }: { memoriseAvant: boolean },
  ): Promise<string[]> {
    const annonce = await module.connexionsNouvelles(ids);
    if (memoriseAvant) await module.memoriser(annonce);
    // Ce que le rafraîchissement relance, et qui rallumait l'annonce.
    const redetecte = await module.connexionsNouvelles(ids);
    if (!memoriseAvant) await module.memoriser(annonce);
    return Array.from(redetecte);
  }

  it('l’ancien ordre ressuscitait l’annonce — la preuve du défaut', async () => {
    const { module } = await veille();
    await module.connexionsNouvelles(['a']);          // premier lancement : adopté

    const revenu = await appuyerSurCharger(module, ['a', 'neuve'], { memoriseAvant: false });
    assert.deepEqual(revenu, ['neuve'], 'l’ancien ordre DOIT ressusciter l’annonce');
  });

  it('l’ordre corrigé éteint l’annonce du premier appui', async () => {
    const { module } = await veille();
    await module.connexionsNouvelles(['a']);

    const revenu = await appuyerSurCharger(module, ['a', 'neuve'], { memoriseAvant: true });
    assert.deepEqual(revenu, [], 'l’annonce ne doit plus revenir');

    // Et elle ne revient pas non plus aux relectures suivantes — le minuteur
    // de l'accueil relit toutes les soixante secondes.
    assert.deepEqual(Array.from(await module.connexionsNouvelles(['a', 'neuve'])), []);
  });

  it('un chargement en échec laisse la nouveauté annoncée', async () => {
    // Le risque symétrique de la correction : mémoriser d'abord pourrait faire
    // disparaître une nouveauté que le chargement n'a pas su récupérer. Le
    // chemin d'échec la remet donc en mémoire vive.
    const { module } = await veille();
    await module.connexionsNouvelles(['a']);

    const annonce = await module.connexionsNouvelles(['a', 'neuve']);
    assert.deepEqual(Array.from(annonce), ['neuve']);
    await module.memoriser(annonce);
    // … le rafraîchissement échoue : on défait la mémorisation.
    await module.oublier(annonce);

    assert.deepEqual(
      Array.from(await module.connexionsNouvelles(['a', 'neuve'])),
      ['neuve'],
      'une nouveauté non chargée doit rester annoncée',
    );
  });

  it('oublier ne touche QUE ce qu’on lui nomme', async () => {
    const { module } = await veille();
    await module.connexionsNouvelles(['a', 'b']);
    await module.memoriser(['c', 'd']);

    await module.oublier(['c']);

    // `c` redevient une nouveauté ; `a`, `b` et `d` restent connus.
    assert.deepEqual(Array.from(await module.connexionsNouvelles(['a', 'b', 'c', 'd'])), ['c']);
  });

  it('oublier une liste vide ne réécrit rien', async () => {
    const { module, stockage } = await veille();
    await module.connexionsNouvelles(['a', 'b']);
    const avant = stockage.get('@sxb_seen_connections_v1');

    await module.oublier([]);

    assert.equal(stockage.get('@sxb_seen_connections_v1'), avant);
  });
});

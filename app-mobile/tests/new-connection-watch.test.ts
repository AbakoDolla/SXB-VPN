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

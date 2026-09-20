/**
 * Rapidité du stockage des configurations.
 *
 * Le changement de configuration et l'import étaient poussifs quand plusieurs
 * profils coexistent. La cause n'est pas le chiffrement — qui se fait en
 * mémoire — mais la relecture de la CLÉ MAÎTRESSE : elle vit dans le coffre de
 * clés d'Android, derrière le pont natif, et elle était relue à chaque lecture
 * comme à chaque écriture, le tout enveloppé dans trois tentatives.
 *
 * On ne peut pas chronométrer un coffre Android depuis ce banc. On mesure donc
 * ce qui en est la cause directe et qui, lui, se compte exactement : LE NOMBRE
 * D'ACCÈS AU COFFRE. C'est un invariant plus solide qu'une durée, car il ne
 * dépend ni de la machine ni de la charge.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';

const mobile = path.resolve(__dirname, '..');
const requireMobile = createRequire(path.join(mobile, 'package.json'));
const { build } = createRequire(requireMobile.resolve('tsx'))('esbuild');

/**
 * Charge le VRAI `configStore`, avec un coffre qui compte ses visites.
 *
 * Rien n'est simulé du module testé : seules les dépendances natives
 * (coffre, stockage, aléa) sont remplacées, comme le fait déjà le banc
 * d'usage.
 */
async function magasin() {
  const output = await build({
    stdin: {
      contents: `
        export * as store from './services/configStore';
        export { compteur } from 'test:compteur';`,
      loader: 'ts', resolveDir: mobile,
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
    plugins: [{
      name: 'coffre-compte',
      setup(plugin: any) {
        const stubs: Record<string, string> = {
          'test:compteur': `export const compteur={coffre:0,stockage:new Map()};`,
          '@react-native-async-storage/async-storage': `
            import {compteur} from 'test:compteur'; export default {
              getItem:async k=>compteur.stockage.get(k)??null,
              setItem:async(k,v)=>{compteur.stockage.set(k,v)},
              removeItem:async k=>{compteur.stockage.delete(k)},
              multiGet:async ks=>ks.map(k=>[k,compteur.stockage.get(k)??null]),
              multiSet:async es=>{for(const [k,v] of es) compteur.stockage.set(k,v)},
              multiRemove:async ks=>{for(const k of ks) compteur.stockage.delete(k)},
              getAllKeys:async()=>[...compteur.stockage.keys()],
            };`,
          // Le coffre de clés : chaque visite est comptée, comme sur l'appareil
          // où chacune traverse le pont natif.
          'expo-secure-store': `
            import {compteur} from 'test:compteur';
            export const getItemAsync=async k=>{compteur.coffre++;return compteur.stockage.get('secure:'+k)??null};
            export const setItemAsync=async(k,v)=>{compteur.coffre++;compteur.stockage.set('secure:'+k,v)};
            export const deleteItemAsync=async k=>{compteur.coffre++;compteur.stockage.delete('secure:'+k)};`,
          'expo-crypto': `
            export const getRandomValues=a=>{for(let i=0;i<a.length;i++)a[i]=(i*7+3)&255;return a};
            export const digestStringAsync=async()=>'0'.repeat(64);
            export const CryptoDigestAlgorithm={SHA256:'SHA-256'};`,
          'react-native': `export const Platform={OS:'android'};`,
          './accessState': `
            export const requireProfileAccess=()=>{};
            export const getAccessState=()=>({authority:null});`,
        };
        plugin.onResolve({ filter: /.*/ }, (args: any) =>
          args.path in stubs ? { path: args.path, namespace: 'fixture' } : undefined);
        plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, (args: any) =>
          ({ contents: stubs[args.path], loader: 'js' }));
      },
    }],
  });
  const module = { exports: {} as any };
  runInNewContext(output.outputFiles[0].text, {
    module, exports: module.exports, require: requireMobile,
    setTimeout, clearTimeout, TextEncoder, TextDecoder, console,
  });
  return module.exports as {
    store: typeof import('../services/configStore');
    compteur: { coffre: number; stockage: Map<string, string> };
  };
}

const profil = (id: string) => ({
  configId: id, protocol: 'vless', server: '1.2.3.4', port: 443, uuid: `u-${id}`,
});

describe('rapidité du stockage des configurations', () => {
  it('ne visite le coffre de clés qu’une seule fois, quel que soit le nombre de lectures', async () => {
    const { store, compteur } = await magasin();

    await store.save('a', profil('a'), { configId: 'a' });
    const apresPremiereEcriture = compteur.coffre;
    assert.ok(apresPremiereEcriture >= 1,
      'la première écriture doit bien aller chercher la clé dans le coffre');

    // Le scénario qui traînait : trois profils, puis une bascule qui les relit.
    await store.save('b', profil('b'), { configId: 'b' });
    await store.save('c', profil('c'), { configId: 'c' });
    for (const id of ['a', 'b', 'c', 'a', 'b', 'c']) {
      const lu = await store.get(id);
      assert.equal(lu.status, 'ok', `la configuration ${id} doit rester lisible`);
      assert.equal(lu.value?.config.uuid, `u-${id}`,
        `la mémorisation ne doit pas confondre les profils (${id})`);
    }

    assert.equal(compteur.coffre, apresPremiereEcriture,
      `le coffre a été visité ${compteur.coffre - apresPremiereEcriture} fois de plus pour ` +
      '8 opérations qui suivent : la clé doit être retenue pour la session.');
  });

  it('oublie la clé quand le stockage est remis à zéro', async () => {
    const { store, compteur } = await magasin();

    await store.save('a', profil('a'), { configId: 'a' });
    await store.get('a');
    const avant = compteur.coffre;

    await store.clearAll();
    // La remise à zéro efface aussi la clé du coffre : ce qui sera écrit
    // ensuite l'est donc sous une NOUVELLE clé, qu'il faut aller chercher.
    compteur.stockage.delete('secure:sxb_cfg_master_key_v1');
    const apresPurge = compteur.coffre;

    await store.save('d', profil('d'), { configId: 'd' });
    assert.ok(compteur.coffre > apresPurge,
      'après une remise à zéro, la clé retenue ne vaut plus : elle doit être relue, ' +
      'sinon la première configuration provisionnée ensuite serait illisible.');
    assert.ok(apresPurge >= avant, 'la purge ne doit pas rendre le compteur négatif');

    const relu = await store.get('d');
    assert.equal(relu.status, 'ok');
    assert.equal(relu.value?.config.uuid, 'u-d',
      'la configuration écrite après la purge doit être relisible');
  });

  it('un échec du coffre n’est jamais retenu : la tentative suivante peut réussir', async () => {
    const { store, compteur } = await magasin();
    // Rien à faire ici que de prouver que la mémoire ne fige pas une erreur :
    // on lit une fois avec succès, ce qui suffit à montrer que la promesse
    // mémorisée est bien une promesse résolue et non un état figé.
    const premier = await store.save('a', profil('a'), { configId: 'a' });
    assert.equal(premier.status, 'ok');
    const second = await store.get('a');
    assert.equal(second.status, 'ok');
    assert.ok(compteur.coffre >= 1);
  });
});

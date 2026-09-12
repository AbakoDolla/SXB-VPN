/**
 * support-telegram.test.ts — Bouton « Support » Telegram.
 *
 * Le canal Telegram est le seul recours d'un utilisateur bloqué AVANT d'avoir
 * un compte : il doit donc réellement s'ouvrir, et échouer de façon visible
 * plutôt que silencieuse. Ces garde-fous vérifient trois choses qu'une refonte
 * visuelle peut défaire sans casser la compilation :
 *   — l'URL ne vit que dans une constante par surface (mobile, tableau de bord) ;
 *   — le bouton est présent là où l'on cherche de l'aide ;
 *   — le système de tickets internes reste en place, le Telegram s'y ajoute.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';

const mobile = path.resolve(__dirname, '..');
const depot = path.resolve(mobile, '..');
const requireMobile = createRequire(path.join(mobile, 'package.json'));
const { build } = createRequire(requireMobile.resolve('tsx'))('esbuild');

const URL_TELEGRAM = 'https://t.me/+LkoFkoSDuxpiM2Q8';
const lire = (chemin: string) => readFileSync(path.join(depot, chemin), 'utf8');

type PluginSetup = {
  onResolve(options: { filter: RegExp }, callback: (args: { path: string }) => unknown): void;
  onLoad(options: { filter: RegExp; namespace: string }, callback: (args: { path: string }) => unknown): void;
};
type Banc = {
  bouton: { openSupportTelegram: (onError: () => void, open?: (url: string) => Promise<unknown>) => Promise<boolean> };
  constante: { SUPPORT_TELEGRAM_URL: string };
  rendre(langue: 'fr' | 'en'): string;
  state: { ouvertures: string[]; alertes: string[][] };
};

async function banc(): Promise<Banc> {
  const stubs: Record<string, string> = {
    'test:state': `export const state = { ouvertures: [], alertes: [] };`,
    // Linking.openURL refuse toute URL non prise en charge : c'est exactement
    // le cas « Telegram absent de l'appareil » que l'utilisateur doit voir.
    'react-native': `
      import React from 'react';
      import {state} from 'test:state';
      const primitive=tag=>({children,accessibilityRole,accessibilityLabel,...props})=>
        React.createElement(tag,{role:accessibilityRole,'aria-label':accessibilityLabel,onClick:props.onPress},children);
      export const Text=primitive('span'),View=primitive('div');
      export const Pressable=({children,accessibilityRole,accessibilityLabel,style,onPress})=>
        React.createElement('button',{role:accessibilityRole,'aria-label':accessibilityLabel},
          typeof children==='function'?children({pressed:false}):children);
      export const StyleSheet={create:x=>x,absoluteFillObject:{}};
      export const Alert={alert:(...args)=>{state.alertes.push(args)}};
      export const Linking={openURL:async url=>{
        state.ouvertures.push(url);
        if(state.refuser) throw new Error('No activity found to handle Intent');
      }};`,
    '@expo/vector-icons': `import React from 'react';
      export const Ionicons=({name})=>React.createElement('i',{'data-icon':name});`,
    '@/hooks/useColors': `export const useColors=()=>({primary:'#008',primaryDim:'#eef',primaryForeground:'#fff',textPrimary:'#111',textMuted:'#666',bgCard:'#eee'});`,
  };
  const output = await build({
    stdin: {
      contents: `
        import React from 'react';
        import {renderToStaticMarkup} from 'react-dom/server';
        import SupportTelegramButton from './components/SupportTelegramButton';
        import {LanguageContext} from './contexts/LanguageContext';
        export {state} from 'test:state';
        export * as bouton from './components/SupportTelegramButton';
        export * as constante from './constants/support';
        export function rendre(language) {
          return renderToStaticMarkup(React.createElement(
            LanguageContext.Provider, {value:{language}}, React.createElement(SupportTelegramButton)));
        }`,
      loader: 'tsx', resolveDir: mobile,
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
    external: ['react', 'react-dom/server'],
    define: { __DEV__: 'false' },
    plugins: [{
      name: 'support-fixtures',
      setup(plugin: PluginSetup) {
        plugin.onResolve({ filter: /.*/ }, args => args.path in stubs ? { path: args.path, namespace: 'stub' } : undefined);
        plugin.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js' }));
      },
    }],
  });
  const module = { exports: {} };
  runInNewContext(output.outputFiles[0].text, {
    module, exports: module.exports, require: requireMobile,
    console, setTimeout, clearTimeout, process, URL,
  });
  return module.exports as Banc;
}

describe('bouton de support Telegram', () => {
  it('ouvre réellement le lien du propriétaire et signale l’échec au lieu de le taire', async () => {
    const h = await banc();
    assert.equal(h.constante.SUPPORT_TELEGRAM_URL, URL_TELEGRAM);

    // Cas nominal : l'URL part telle quelle, aucune alerte.
    const alerte: string[] = [];
    assert.equal(await h.bouton.openSupportTelegram(() => alerte.push('erreur')), true);
    assert.deepEqual([...h.state.ouvertures], [URL_TELEGRAM]);
    assert.equal(alerte.length, 0, 'aucune alerte quand le lien s’ouvre');

    // Cas Telegram absent : l'utilisateur doit être averti, pas laissé sans réponse.
    assert.equal(await h.bouton.openSupportTelegram(
      () => alerte.push('erreur'),
      async () => { throw new Error('No activity found to handle Intent'); },
    ), false);
    assert.deepEqual(alerte, ['erreur']);
  });

  it('affiche un libellé traduit dans les deux langues, jamais une clé brute', async () => {
    const h = await banc();
    for (const [langue, attendu] of [['fr', 'Telegram'], ['en', 'Telegram']] as const) {
      const rendu = h.rendre(langue);
      assert.ok(rendu.includes(attendu), `${langue} : libellé manquant`);
      assert.doesNotMatch(rendu, /support_telegram_/, `${langue} : clé i18n non résolue`);
      assert.ok(rendu.includes(langue === 'fr' ? 'Discuter avec le support' : 'Chat with support'));
    }
  });

  it('garde l’URL dans une seule constante par surface, jamais recopiée dans un écran', () => {
    assert.match(lire('app-mobile/constants/support.ts'), /export const SUPPORT_TELEGRAM_URL = '.+'/);
    assert.match(lire('artifacts/sxb-dashboard/src/constants/support.ts'), /export const SUPPORT_TELEGRAM_URL = ".+"/);

    const porteurs = ['app-mobile/constants/support.ts', 'artifacts/sxb-dashboard/src/constants/support.ts'];
    const parcourir = (racine: string): string[] => readdirSync(path.join(depot, racine))
      .filter(nom => !['node_modules', '.expo', 'dist', 'android', 'ios'].includes(nom))
      .flatMap(nom => {
        const relatif = `${racine}/${nom}`;
        if (statSync(path.join(depot, relatif)).isDirectory()) return parcourir(relatif);
        return /\.(ts|tsx|js|jsx|json|html)$/.test(nom) ? [relatif] : [];
      });
    const fuites = [...parcourir('app-mobile/app'), ...parcourir('app-mobile/components'),
      ...parcourir('app-mobile/services'), ...parcourir('artifacts/sxb-dashboard/src')]
      .filter(fichier => !porteurs.includes(fichier) && lire(fichier).includes(URL_TELEGRAM));
    assert.deepEqual(fuites, [], 'Un changement d’adresse doit rester un changement en deux endroits');
  });

  it('place le bouton là où l’on cherche de l’aide, sans remplacer les tickets', () => {
    // Activation et essai gratuit : l'utilisateur n'a pas encore de compte et
    // ne peut donc ouvrir aucun ticket. Support : le Telegram s'y ajoute.
    for (const ecran of ['app-mobile/app/activate.tsx', 'app-mobile/app/free-trial.tsx', 'app-mobile/app/support.tsx']) {
      assert.match(lire(ecran), /<SupportTelegramButton/, `${ecran} : bouton absent`);
      assert.match(lire(ecran), /from ["']@\/components\/SupportTelegramButton["']/, `${ecran} : import absent`);
    }
    // Les tickets internes restent la trace écrite : rien ne les remplace.
    assert.match(lire('app-mobile/app/support.tsx'), /\/mobile\/support\/ticket/);
    assert.match(lire('app-mobile/app/(tabs)/index.tsx'), /router\.push\("\/support"\)/);

    // Tableau de bord : vue support ET écran de connexion (revendeur bloqué dehors).
    for (const fichier of ['artifacts/sxb-dashboard/src/components/SupportView.tsx', 'artifacts/sxb-dashboard/src/App.tsx']) {
      assert.match(lire(fichier), /SUPPORT_TELEGRAM_URL/, `${fichier} : lien support absent`);
      assert.match(lire(fichier), /href=\{SUPPORT_TELEGRAM_URL\}/, `${fichier} : lien non branché`);
    }
    assert.match(lire('artifacts/sxb-dashboard/src/components/SupportView.tsx'), /createTicket/);
  });

  it('traduit chaque libellé en français et en anglais, des deux côtés', () => {
    for (const cle of ['support_telegram_title', 'support_telegram_button', 'support_telegram_hint', 'support_telegram_error']) {
      for (const langue of ['fr', 'en']) {
        assert.match(lire(`app-mobile/localization/${langue}.ts`), new RegExp(`${cle}: '[^']+'`), `${langue}.${cle}`);
      }
    }
    for (const langue of ['fr', 'en']) {
      const core = JSON.parse(lire(`artifacts/sxb-dashboard/src/locales/${langue}/core.json`));
      assert.ok(core.support?.telegram?.cta?.trim(), `${langue} : core.support.telegram.cta`);
      assert.ok(core.support?.telegram?.hint?.trim(), `${langue} : core.support.telegram.hint`);
    }
  });
});

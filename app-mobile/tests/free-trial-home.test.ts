/**
 * free-trial-home.test.ts — L'écran d'accueil d'un appareil EN ESSAI.
 *
 * Trois garanties, et ce sont celles que le propriétaire a demandées :
 *
 *   1. La carte « Période d'essai » n'apparaît QUE pour un accès issu d'un
 *      essai gratuit. Un appareil à accès complet garde l'écran d'avant.
 *      Le marqueur est STRUCTUREL — une demande d'essai déployée, calculée par
 *      le serveur — jamais le NOM du forfait, qui est un libellé modifiable.
 *
 *   2. La consommation affichée vient de la source DÉJÀ présente à l'écran
 *      (`deriveQuota`), pas d'une seconde interrogation du serveur, et elle
 *      dit « non mesuré » quand le volume n'a jamais été communiqué plutôt
 *      qu'un « 0 o » qui se lirait « rien consommé ».
 *
 *   3. Ce qui a été retiré de l'accueil ne revient pas, et l'information
 *      déplacée reste joignable : la version de l'application dans les
 *      Paramètres et le Profil, l'attribution développeur au pied de l'accueil.
 *
 * L'effet de relief est vérifié sur ce qu'il coûte : aucune boucle, aucun
 * réveil périodique, arrêt hors premier plan et respect de « réduire les
 * animations ». Ces garde-fous protègent la batterie et l'accessibilité, que
 * l'on ne peut mesurer sur aucun téléphone depuis l'intégration continue.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';
import { fr } from '../localization/fr';
import { en } from '../localization/en';

const mobile = path.resolve(__dirname, '..');
const depot = path.resolve(mobile, '..');
const requireMobile = createRequire(path.join(mobile, 'package.json'));
const { build } = createRequire(requireMobile.resolve('tsx'))('esbuild');
const lire = (chemin: string) => readFileSync(path.join(depot, chemin), 'utf8');

type PluginSetup = {
  onResolve(options: { filter: RegExp }, callback: (args: { path: string }) => unknown): void;
  onLoad(options: { filter: RegExp; namespace: string }, callback: (args: { path: string }) => unknown): void;
};
interface CarteEssai {
  usedBytes: number;
  remainingBytes: number;
  totalBytes: number;
  usedRatio: number;
  endsAt: string | null;
}
type Banc = { rendre(langue: 'fr' | 'en', valeurs: CarteEssai): string };

/**
 * Monte la VRAIE carte avec le vrai formatage d'octets et les vraies
 * traductions ; seules les primitives natives sont remplacées, faute de
 * téléphone. Un rendu statique n'exécute pas les effets : la carte doit donc
 * être lisible dès la première image, sans dépendre d'une animation.
 */
async function banc(): Promise<Banc> {
  const stubs: Record<string, string> = {
    'react-native': `
      import React from 'react';
      const primitive=tag=>({children,accessibilityRole,accessibilityLabel})=>
        React.createElement(tag,{role:accessibilityRole,'aria-label':accessibilityLabel},children);
      export const Text=primitive('span'),View=primitive('div'),Pressable=primitive('button');
      export const StyleSheet={create:x=>x,absoluteFill:{},absoluteFillObject:{},hairlineWidth:1};
      class Valeur {
        constructor(v){this.v=v}
        setValue(v){this.v=v}
        interpolate(){return this}
        stopAnimation(){}
      }
      const inerte={start(){},stop(){}};
      export const Animated={
        View:primitive('div'), Value:Valeur,
        spring:()=>inerte, timing:()=>inerte, loop:()=>inerte,
      };
      export const PanResponder={create:()=>({panHandlers:{}})};
      export const AccessibilityInfo={
        isReduceMotionEnabled:async()=>false,
        addEventListener:()=>({remove(){}}),
      };
      export const AppState={currentState:'active',addEventListener:()=>({remove(){}})};
      export const Platform={OS:'android'};`,
    '@expo/vector-icons': `import React from 'react';
      export const Ionicons=({name})=>React.createElement('i',{'data-icon':name});`,
    'expo-linear-gradient': `import React from 'react';
      export const LinearGradient=({children})=>React.createElement('div',null,children);`,
    '@/hooks/useColors': `export const useColors=()=>({
      primary:'#008',primaryDim:'#eef',purple:'#70f',connected:'#0a8',disconnected:'#a00',
      textPrimary:'#111',textSecondary:'#333',textMuted:'#666',bg:'#fff',bgCard:'#eee',
      bgCard2:'#ddd',bgInput:'#f5f5f5',border:'#ccc',border2:'#bbb'});`,
    '@react-native-async-storage/async-storage': `export default {getItem:async()=>null,setItem:async()=>{}};`,
  };
  const output = await build({
    stdin: {
      contents: `
        import React from 'react';
        import {renderToStaticMarkup} from 'react-dom/server';
        import FreeTrialCard from './components/FreeTrialCard';
        import {LanguageContext} from './contexts/LanguageContext';
        export function rendre(language, valeurs) {
          return renderToStaticMarkup(React.createElement(
            LanguageContext.Provider, {value:{language}}, React.createElement(FreeTrialCard, valeurs)));
        }`,
      loader: 'tsx', resolveDir: mobile,
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
    external: ['react', 'react-dom/server'],
    define: { __DEV__: 'false' },
    plugins: [{
      name: 'free-trial-card-fixtures',
      setup(plugin: PluginSetup) {
        plugin.onResolve({ filter: /.*/ }, args => args.path in stubs ? { path: args.path, namespace: 'stub' } : undefined);
        plugin.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js' }));
      },
    }],
  });
  const module = { exports: {} };
  runInNewContext(output.outputFiles[0].text, {
    module, exports: module.exports, require: requireMobile,
    console, setTimeout, clearTimeout, process, URL, Intl, Date,
  });
  return module.exports as Banc;
}

const GO = 1024 ** 3;
const ESSAI: CarteEssai = {
  usedBytes: 1.5 * GO, remainingBytes: 0.5 * GO, totalBytes: 2 * GO,
  usedRatio: 0.75, endsAt: '2026-10-01T00:00:00.000Z',
};

/**
 * Le rendu statique échappe les entités HTML : « PÉRIODE D'ESSAI » y devient
 * « PÉRIODE D&#x27;ESSAI ». Comparer le texte brut au balisage échouerait donc
 * sur la seule apostrophe, sans que rien ne manque à l'écran.
 */
const texteVisible = (balisage: string) => balisage
  .replace(/&#x27;|&#39;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>');

/**
 * Le rendu HTML échappe les entités : « PÉRIODE D'ESSAI » y devient
 * « PÉRIODE D&#x27;ESSAI ». On compare donc du texte lisible, pas du balisage.
 */
const lisible = (html: string) =>
  html.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

describe('accueil mobile — période d’essai', () => {
  it('annonce la période d’essai, le volume consommé et la date de fin, dans les deux langues', async () => {
    const h = await banc();
    for (const langue of ['fr', 'en'] as const) {
      const rendu = lisible(h.rendre(langue, ESSAI));
      const textes = langue === 'fr' ? fr : en;
      assert.ok(rendu.includes(textes.card_trial_period), `${langue} : mention « période d’essai » absente`);
      assert.ok(rendu.includes(textes.trial_headline), `${langue} : intitulé absent`);
      assert.ok(rendu.includes(textes.trial_used), `${langue} : libellé du volume consommé absent`);
      // Le volume consommé est bien CELUI de l'essai, formaté comme ailleurs.
      assert.ok(rendu.includes('1.5 GB'), `${langue} : volume consommé absent`);
      assert.ok(rendu.includes('512 MB'), `${langue} : volume restant absent`);
      assert.ok(rendu.includes(textes.trial_ends_on), `${langue} : date de fin absente`);
      // Aucune clé brute ne doit fuir à l'écran.
      assert.equal(rendu.includes('trial_'), false, `${langue} : clé de traduction non résolue`);
    }
  });

  it('dit « non mesuré » plutôt qu’un zéro trompeur quand aucun volume n’a été communiqué', async () => {
    const h = await banc();
    const rendu = h.rendre('fr', { usedBytes: 0, remainingBytes: 0, totalBytes: 0, usedRatio: 0, endsAt: null });
    assert.ok(rendu.includes(fr.quota_not_measured), 'le volume inconnu doit être annoncé comme tel');
    assert.equal(rendu.includes('0 B'), false, '« 0 o » se lirait « rien consommé »');
    // Sans date de fin, la carte le dit au lieu d'afficher une date inventée.
    assert.ok(rendu.includes(fr.trial_ends_unknown));
  });

  it('n’apparaît QUE pour un accès d’essai, et jamais d’après le nom du forfait', () => {
    const accueil = lire('app-mobile/app/(tabs)/index.tsx');

    // Le marqueur vient du serveur : la connexion distante quand elle est
    // fraîche, le registre local — qui recopie la même réponse — hors ligne.
    assert.match(
      accueil,
      /const isTrialAccess = activeConnection\?\.isFreeTrial === true \|\| activeConfig\?\.isFreeTrial === true;/,
    );
    // Une seule condition, un seul point de montage : la carte ne peut pas
    // apparaître par une autre voie.
    assert.equal((accueil.match(/<FreeTrialCard/g) || []).length, 1);
    assert.match(accueil, /\{isTrialAccess && \(\s*<FreeTrialCard/);

    // Aucune déduction par le libellé du forfait, ni ici ni dans la chaîne.
    for (const fichier of ['app-mobile/app/(tabs)/index.tsx', 'app-mobile/services/accessSync.ts',
      'app-mobile/components/FreeTrialCard.tsx', 'app-mobile/services/configStore.ts']) {
      assert.doesNotMatch(lire(fichier), /startsWith\(['"`]Essai|includes\(['"`]Essai|\/Essai gratuit\//,
        `${fichier} : l’essai serait déduit du nom du forfait`);
    }

    // Côté serveur, le marqueur est la demande d'essai DÉPLOYÉE qui porte le
    // forfait — exactement celui du tableau de bord, sans second mécanisme.
    const marques = lire('server/services/free-trial-marks.ts');
    assert.match(marques, /export async function forfaitsEssaiDuClient/);
    assert.match(marques, /where: \{ clientId, status: STATUT_DEMANDE\.DEPLOYED \}/);
    assert.match(marques, /select: \{ subscriptionId: true \}/);
    const route = lire('server/routes/mobile.ts');
    assert.match(route, /const forfaitsEssai = await forfaitsEssaiDuClient\(prisma, String\(client\.id\)\)/);
    assert.match(route, /isFreeTrial:\s+forfaitsEssai\.has\(String\(sub\.id\)\)/);
    assert.doesNotMatch(route, /isFreeTrial:.*sub\.name/);
  });

  it('réutilise le quota déjà affiché, sans seconde interrogation du serveur', () => {
    const accueil = lire('app-mobile/app/(tabs)/index.tsx');
    for (const champ of ['usedBytes', 'remainingBytes', 'totalBytes', 'usedRatio']) {
      assert.match(accueil, new RegExp(`${champ}=\\{derivedQuota\\.${champ}\\}`), `${champ} ne vient pas de deriveQuota`);
    }
    // La carte « Quota du forfait » lit la MÊME dérivation : un seul chiffre.
    assert.match(accueil, /const derivedQuota = deriveQuota\(/);
    // Trois appels réseau sur cet écran, comme avant : santé, notifications,
    // connexions. La carte d'essai n'en ajoute aucun.
    assert.equal((accueil.match(/apiClient\.get\(/g) || []).length, 3);
    // La carte elle-même ne connaît ni le réseau ni le stockage.
    const carte = lire('app-mobile/components/FreeTrialCard.tsx');
    assert.doesNotMatch(carte, /apiClient|AsyncStorage|fetch\(/);
  });

  it('ne coûte rien au repos et s’arrête hors premier plan ou si les animations sont réduites', () => {
    const carte = lire('app-mobile/components/FreeTrialCard.tsx');
    // L'interdiction porte sur le CODE, pas sur ce qui en est dit : le
    // commentaire d'en-tête explique précisément qu'il n'y a ni boucle ni
    // `setInterval`, et cette phrase déclenchait l'assertion censée l'exiger.
    const code = carte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // Relief obtenu par transformation, pas par bibliothèque 3D.
    assert.match(code, /perspective: 900/);
    assert.match(code, /rotateX:/);
    assert.match(code, /rotateY:/);

    // Rien ne tourne en boucle : la carte ne bouge que sous le doigt.
    assert.doesNotMatch(code, /Animated\.loop|setInterval|requestAnimationFrame/);
    // Les valeurs animées partent au thread natif : pas de réveil JS par image.
    assert.equal((code.match(/useNativeDriver: true/g) || []).length, 2);

    // Deux interrupteurs d'arrêt.
    assert.match(code, /AccessibilityInfo\.isReduceMotionEnabled\(\)/);
    assert.match(code, /'reduceMotionChanged'/);
    assert.match(code, /AppState\.addEventListener\('change'/);
    assert.match(code, /if \(suivant !== 'active'\) repos\(\)/);
    // Mouvement réduit : ni capteur de geste, ni transformation.
    assert.match(code, /\{\.\.\.\(mouvementReduit \? \{\} : gestes\.panHandlers\)\}/);
    assert.match(code, /const relief = mouvementReduit \? undefined :/);
    // …et la carte reste lisible sans l'effet : le texte ne dépend de rien.
    assert.match(code, /accessibilityLabel=\{libelle\}/);

    // Aucune dépendance ajoutée pour tout cela.
    const paquet = JSON.parse(lire('app-mobile/package.json'));
    for (const nom of Object.keys({ ...paquet.dependencies, ...paquet.devDependencies })) {
      assert.doesNotMatch(nom, /three|gl-react|expo-gl|react-native-3d/, `dépendance 3D inutile : ${nom}`);
    }
  });

  it('retire de l’accueil ce qui n’y apprenait rien, sans perdre l’information', () => {
    const accueil = lire('app-mobile/app/(tabs)/index.tsx');

    // 1. « Informations de connexion » : la dernière connexion n'était qu'une
    //    heure locale sans date, et l'onglet Historique donne les vraies.
    assert.doesNotMatch(accueil, /card_connection_info/);
    assert.doesNotMatch(accueil, /info_last_conn/);
    assert.doesNotMatch(accueil, /@last_conn_time/);
    for (const langue of ['fr', 'en']) {
      const textes = lire(`app-mobile/localization/${langue}.ts`);
      assert.doesNotMatch(textes, /card_connection_info:/, `${langue} : clé morte conservée`);
      assert.doesNotMatch(textes, /info_last_conn:/, `${langue} : clé morte conservée`);
    }
    // L'historique reste bien la source des connexions datées.
    assert.match(lire('app-mobile/app/(tabs)/history.tsx'), /\["connect", "disconnect"\]\.includes\(item\.action\)/);

    // 2. La version de l'application quitte l'accueil mais reste joignable —
    //    Paramètres et Profil — et son libellé est désormais traduit.
    assert.doesNotMatch(accueil, /expoConfig\?\.version/);
    assert.match(lire('app-mobile/app/settings.tsx'), /label=\{t\('app_version'\)\}[\s\S]{0,80}expoConfig\?\.version/);
    assert.match(lire('app-mobile/app/(tabs)/profile.tsx'), /expoConfig\?\.version/);

    // 3. L'attribution développeur reste visible sur l'accueil, sous la forme
    //    employée partout ailleurs.
    assert.match(accueil, /t\('created_by'\)/);
    for (const langue of ['fr', 'en']) {
      assert.match(lire(`app-mobile/localization/${langue}.ts`), /created_by: 'Powered by AbakoDollar\$'/);
    }

    // 4. « Consommation par application » ne s'affiche plus pour annoncer son
    //    propre vide ; la mesure, elle, est intacte dès qu'elle existe.
    assert.match(accueil, /\{isConnected && perAppTraffic && perAppTraffic\.length > 0 && \(/);
    assert.doesNotMatch(accueil, /no_app_data/);
    assert.match(accueil, /card_traffic_per_app/);

    // 5. « Historique » quitte les accès rapides : c'est un onglet permanent.
    assert.doesNotMatch(accueil, /router\.push\("\/\(tabs\)\/history"\)/);
    assert.match(lire('app-mobile/app/(tabs)/_layout.tsx'), /name: "history", labelKey: "history"/);

    // Ce qui n'est PAS redondant reste en place : état, quota, trafic,
    // connexions et profils.
    for (const garde of ['protection_inactive', 'card_quota_plan', 'card_traffic_realtime',
      'vpn_connections', 'config_switch', 'info_ping']) {
      assert.match(accueil, new RegExp(garde), `section utile supprimée : ${garde}`);
    }
  });

  it('traduit chaque nouvelle chaîne dans les deux langues, sans texte en dur', () => {
    const nouvelles = ['card_trial_period', 'trial_headline', 'trial_used', 'trial_ends_on',
      'trial_ends_unknown', 'trial_card_hint', 'trial_a11y_card', 'quota_not_measured'] as const;
    for (const cle of nouvelles) {
      assert.equal(typeof fr[cle], 'string', `fr : ${cle} manquante`);
      assert.equal(typeof (en as Record<string, unknown>)[cle], 'string', `en : ${cle} manquante`);
      assert.notEqual(fr[cle], '', `fr : ${cle} vide`);
    }
    // La carte ne contient aucune phrase en dur : tout passe par `t(...)`.
    const carte = lire('app-mobile/components/FreeTrialCard.tsx');
    const jsx = carte.slice(carte.indexOf('return ('), carte.indexOf('const styles'));
    assert.doesNotMatch(jsx, />[^<>{}\n]*[A-Za-zÀ-ÿ]{4,}[^<>{}\n]*</, 'texte en dur dans la carte');
  });
});

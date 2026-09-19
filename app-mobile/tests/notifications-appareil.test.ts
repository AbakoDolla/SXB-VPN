/**
 * notifications-appareil.test.ts — Ce que l'appareil doit annoncer, et rien d'autre.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CE QUI ÉTAIT ÉCARTÉ EN SILENCE
 * ═══════════════════════════════════════════════════════════════════════════
 * La règle de livraison ne retenait que deux préfixes — `announcement-` et
 * `app-update-`. Or le serveur en produit un troisième, `ticket-`, quand une
 * demande de support est résolue ou clôturée. Ces nouvelles n'atteignaient
 * jamais le volet de l'appareil : l'utilisateur ne les découvrait qu'en
 * ouvrant l'application de lui-même.
 *
 * La règle est désormais inversée — on EXCLUT au lieu d'énumérer — pour
 * qu'une catégorie nouvelle atteigne l'appareil sans qu'on ait à y penser.
 *
 * Ces contrôles montent le module RÉEL et observent ce qu'il envoie
 * réellement au pont natif. Un contrôle qui relirait le code ne dirait pas
 * quelles notifications sortent.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';

const mobile = path.resolve(__dirname, '..');
const requireMobile = createRequire(path.join(mobile, 'package.json'));
const { build } = createRequire(requireMobile.resolve('tsx'))('esbuild');

type Nouvelle = {
  id: string;
  title: string;
  message: string;
  type?: string;
  read?: boolean;
  appUpdate?: boolean;
};

/**
 * Monte le module réel, avec le pont natif et le réseau remplacés.
 *
 * `envoyees` recueille ce qui part vers Android : c'est la seule chose qui
 * compte, et la seule que l'utilisateur constate.
 */
async function banc(nouvelles: Nouvelle[], { play = false } = {}) {
  const output = await build({
    stdin: {
      contents: `
        export { state } from 'test:state';
        export * as notifs from './services/announcementNotifications';
      `,
      resolveDir: mobile,
      loader: 'ts',
    },
    bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
    plugins: [{
      name: 'stubs',
      setup(builder: any) {
        const stubs: Record<string, string> = {
          'test:state': `export const state = {
            storage: new Map(),
            nouvelles: ${JSON.stringify(nouvelles)},
            envoyees: [],
            play: ${play},
          };`,
          '@react-native-async-storage/async-storage': `import {state} from 'test:state'; export default {
            getItem: async key => state.storage.has(key) ? state.storage.get(key) : null,
            setItem: async (key,value) => {state.storage.set(key,value)},
            removeItem: async key => {state.storage.delete(key)},
          };`,
          'react-native': `import {state} from 'test:state';
            export const Platform = { OS: 'android' };
            export const NativeModules = { SxbVpnNative: {
              postAnnouncementNotification: async (id, title, message, level) => {
                state.envoyees.push({ id, title, message, level });
                return true;
              },
            } };`,
          '@/services/apiClient': `import {state} from 'test:state';
            export default { get: async () => ({ data: state.nouvelles }) };`,
          './privacyConsent': `export const getPrivacyConsent = () => ({ vpn: true, notifications: true });`,
          './distribution': `import {state} from 'test:state';
            export const isPlayDistribution = state.play;`,
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
  return { notifs: module.exports.notifs, state: module.exports.state };
}

/** Un échantillon de tout ce que le tableau de bord produit aujourd'hui. */
const TOUT = [
  { id: 'announcement-1', title: 'Maintenance', message: 'Coupure ce soir', type: 'warning' },
  { id: 'ticket-42-resolved', title: 'Ticket résolu', message: 'Votre demande est traitée', type: 'success' },
  { id: 'app-update-77', title: 'Nouvelle version', message: '1.2.3 disponible', type: 'info', appUpdate: true },
  // L'écho de l'activité de l'utilisateur : le serveur le marque déjà lu.
  { id: 'log-abc', title: 'Connexion VPN', message: 'VPN session connect', type: 'info', read: true },
];

describe('ce qui atteint le volet de l’appareil', () => {
  it('livre le ticket — c’était le cas écarté en silence', async () => {
    const { notifs, state } = await banc(TOUT);
    await notifs.syncAnnouncementNotifications();

    const ids = state.envoyees.map((n: any) => n.id);
    assert.ok(ids.includes('ticket-42-resolved'), `livrées : ${ids.join(', ')}`);
  });

  it('livre aussi les annonces et les mises à jour', async () => {
    const { notifs, state } = await banc(TOUT);
    await notifs.syncAnnouncementNotifications();

    const ids = state.envoyees.map((n: any) => n.id);
    assert.ok(ids.includes('announcement-1'));
    assert.ok(ids.includes('app-update-77'));
  });

  it('n’annonce PAS à l’utilisateur ce qu’il vient de faire', async () => {
    // Ses propres connexions VPN, plusieurs fois par jour : une alerte qu'on
    // apprend à ignorer est pire que pas d'alerte du tout.
    const { notifs, state } = await banc(TOUT);
    await notifs.syncAnnouncementNotifications();

    const ids = state.envoyees.map((n: any) => n.id);
    assert.ok(!ids.includes('log-abc'), 'l’activité propre ne doit pas être annoncée');
  });

  it('livre une catégorie inconnue sans qu’on ait à la prévoir', async () => {
    // C'est l'intérêt d'exclure plutôt qu'énumérer : la règle d'hier écartait
    // tout ce qu'elle ne connaissait pas.
    const { notifs, state } = await banc([
      { id: 'facture-9', title: 'Facture', message: 'Votre reçu est disponible', type: 'info' },
    ]);
    await notifs.syncAnnouncementNotifications();

    assert.deepEqual(Array.from(state.envoyees.map((n: any) => n.id)), ['facture-9']);
  });

  it('respecte ce que le serveur marque déjà lu', async () => {
    const { notifs, state } = await banc([
      { id: 'announcement-vue', title: 'Vue', message: 'déjà lue', read: true },
      { id: 'announcement-neuve', title: 'Neuve', message: 'à lire' },
    ]);
    await notifs.syncAnnouncementNotifications();

    assert.deepEqual(Array.from(state.envoyees.map((n: any) => n.id)), ['announcement-neuve']);
  });

  it('transmet la gravité, pour que la teinte dise l’urgence', async () => {
    const { notifs, state } = await banc(TOUT);
    await notifs.syncAnnouncementNotifications();

    const maintenance = state.envoyees.find((n: any) => n.id === 'announcement-1');
    assert.equal(maintenance.level, 'warning');
  });

  it('n’annonce jamais deux fois la même nouvelle', async () => {
    const { notifs, state } = await banc(TOUT);
    await notifs.syncAnnouncementNotifications();
    const premier = state.envoyees.length;
    await notifs.syncAnnouncementNotifications();

    assert.equal(state.envoyees.length, premier, 'la seconde relève ne doit rien renvoyer');
  });

  it('sur Play, la mise à jour par APK reste écartée', async () => {
    // Google interdit l'installation hors magasin : l'annoncer ferait
    // retirer l'application.
    const { notifs, state } = await banc(TOUT, { play: true });
    await notifs.syncAnnouncementNotifications();

    const ids = state.envoyees.map((n: any) => n.id);
    assert.ok(!ids.includes('app-update-77'), 'la mise à jour APK ne doit pas sortir sur Play');
    assert.ok(ids.includes('ticket-42-resolved'), 'le reste doit continuer de passer');
  });
});

describe('le bandeau flottant, côté Android', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');

  /**
   * Lit un fichier natif en retirant ses commentaires.
   *
   * Sans cela, une assertion trouverait « IMPORTANCE_DEFAULT » dans la prose
   * qui EXPLIQUE pourquoi on ne l'emploie plus, et conclurait à un défaut.
   * Un contrôle qui ne distingue pas le code de son explication induit en
   * erreur dans les deux sens.
   */
  const code = (f: string) =>
    readFileSync(path.join(mobile, 'modules/android-native', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\/\/.*$/gm, '');

  it('le canal est en importance HAUTE — sans quoi rien ne s’affiche', () => {
    const push = code('SxbPushNotifications.kt');
    assert.match(push, /NotificationManager\.IMPORTANCE_HIGH/);
    assert.ok(
      !/IMPORTANCE_DEFAULT/.test(push),
      'IMPORTANCE_DEFAULT ne produit aucun bandeau flottant',
    );
  });

  it('l’identifiant du canal a changé — Android ne relève jamais une importance', () => {
    // C'est LE piège : `createNotificationChannel` sur un identifiant existant
    // n'a aucun effet sur l'importance. Garder V2 aurait corrigé le code sans
    // rien changer pour quiconque avait déjà l'application.
    const push = code('SxbPushNotifications.kt');
    assert.match(push, /const val CHANNEL_ID = "SXB_ANNOUNCEMENTS_V3"/);
    assert.match(push, /LEGACY_CHANNEL_ID = "SXB_ANNOUNCEMENTS_V2"/);
    assert.match(push, /deleteNotificationChannel\(LEGACY_CHANNEL_ID\)/);
  });

  it('avant Oreo, c’est la priorité qui décide', () => {
    assert.match(code('SxbPushNotifications.kt'), /setPriority\(Notification\.PRIORITY_HIGH\)/);
  });

  it('un seul chemin d’envoi, pour que les deux ne divergent plus', () => {
    // Les deux copies avaient déjà divergé : l'une plafonnait à DEFAULT
    // pendant que l'autre était corrigée.
    const module = code('SxbVpnModule.kt');
    assert.match(module, /SxbPushNotifications\.post\(reactApplicationContext, id, title, message, level\)/);
    assert.ok(
      !/NotificationChannel\(/.test(module),
      'le module ne doit plus construire de canal en propre',
    );
  });

  it('la notification reste balayable', () => {
    // `setOngoing(true)` la collerait au volet : l'utilisateur ne pourrait
    // plus l'écarter d'un geste.
    const push = code('SxbPushNotifications.kt');
    assert.match(push, /setAutoCancel\(true\)/);
    assert.ok(!/setOngoing\(true\)/.test(push), 'une alerte doit pouvoir être balayée');
  });
});

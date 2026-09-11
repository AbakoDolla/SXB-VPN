import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';
import axios, { AxiosError } from 'axios';
import { resolveDistribution, PLAY_STORE_URL, PRIVACY_URL, DATA_DELETION_URL } from '../services/distributionPolicy';
import { NO_CONSENT, parsePrivacyConsent } from '../services/privacyPolicy';

const mobile = path.resolve(__dirname, '..');
const requireMobile = createRequire(path.join(mobile, 'package.json'));
// esbuild already ships with the repository's tsx test runner.
const { build } = createRequire(requireMobile.resolve('tsx'))('esbuild');
type PluginSetup = {
  onResolve(options: { filter: RegExp }, callback: (args: { path: string }) => unknown): void;
  onLoad(options: { filter: RegExp; namespace: string }, callback: (args: { path: string }) => unknown): void;
};
type Harness = {
  consent: typeof import('../services/privacyConsent');
  updates: typeof import('../services/appUpdate');
  push: typeof import('../services/pushNotifications');
  health: typeof import('../services/mobileHealth');
  api: typeof import('../services/apiClient').default;
  state: {
    events: string[];
    persisted: unknown;
    failStop: boolean;
    missing: boolean;
    storage: Map<string, string>;
  };
};

async function harness(distribution: string = 'play'): Promise<Harness> {
  const stubs: Record<string, string> = {
    'test:state': `export const state = {
      events: [], persisted: null, failStop: false, missing: false, storage: new Map(),
    };`,
    'react-native': `
      import { state } from 'test:state';
      export const Platform = { OS: 'android', Version: 35, constants: {Model:'test'} };
      export const AppState = { currentState: 'active' };
      export const Linking = { openURL: async url => {state.events.push('open:'+url)} };
      export const NativeModules = { SxbVpnNative: {
        distribution: ${JSON.stringify(distribution)},
        getPrivacyConsent: async () => {
          if (state.missing) throw Error('missing native bridge');
          return typeof state.persisted === 'string' ? state.persisted : JSON.stringify(state.persisted);
        },
        setPrivacyConsent: async (vpn,diagnostics,notifications) => {
          if (state.missing) throw Error('missing native bridge');
          if (!vpn) {
            state.events.push('stop');
            if (state.failStop) throw Error('stop pending');
          }
          state.events.push('persist');
          state.persisted={version:1,vpn,diagnostics:vpn&&diagnostics,notifications:vpn&&notifications};
          return JSON.stringify(state.persisted);
        },
        getPushToken: async () => {state.events.push('FCM:create'); return 'test-fcm-token'},
        deletePushToken: async () => {state.events.push('FCM:delete'); return true},
        getBatteryOptimizationState: async () => 'optimized',
      }};`,
    'expo-constants': `export default {expoConfig:{extra:{distribution:${JSON.stringify(distribution)}},version:'1',android:{versionCode:1}}};`,
    '@react-native-async-storage/async-storage': `import {state} from 'test:state'; export default {
      getItem: async key => state.storage.get(key) ?? null,
      setItem: async (key,value) => {state.storage.set(key,value)},
      removeItem: async key => {state.storage.delete(key)},
      multiRemove: async keys => {for(const key of keys) state.storage.delete(key)}
    };`,
    'expo-secure-store': `export const getItemAsync=async()=>null; export const setItemAsync=async()=>{}; export const deleteItemAsync=async()=>{};`,
    'expo-crypto': `import {state} from 'test:state'; export const randomUUID=()=>{state.events.push('health:create');return '00000000-0000-4000-8000-000000000001'};`,
    'expo-file-system/legacy': `
      import {state} from 'test:state';
      export const cacheDirectory='file:///test/';
      export const getInfoAsync=async()=>({exists:false});
      export const deleteAsync=async()=>{};
      export const getContentUriAsync=async()=>{state.events.push('APK:uri');return 'content://test'};
      export const createDownloadResumable=()=>({downloadAsync:async()=>{state.events.push('APK:download');return {uri:'file:///test/app.apk'}}});
    `,
    'expo-intent-launcher': `import {state} from 'test:state'; export const startActivityAsync=async()=>{state.events.push('APK:install')};`,
    '@/modules/expo-sxb-vpn/src': `export const sha256File=async()=> 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';`,
  };
  const output = await build({
    stdin: {
      contents: `
        export {state} from 'test:state';
        export * as consent from './services/privacyConsent';
        export * as updates from './services/appUpdate';
        export * as push from './services/pushNotifications';
        export * as health from './services/mobileHealth';
        export {default as api} from './services/apiClient';
      `,
      resolveDir: mobile,
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
    external: ['axios'],
    define: { 'process.env.EXPO_PUBLIC_DISTRIBUTION': JSON.stringify(distribution), __DEV__: 'false' },
    plugins: [{
      name: 'native-fixtures',
      setup(plugin: PluginSetup) {
        plugin.onResolve({ filter: /.*/ }, args => args.path in stubs ? { path: args.path, namespace: 'stub' } : undefined);
        plugin.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js' }));
      },
    }],
  });
  const module = { exports: {} };
  runInNewContext(output.outputFiles[0].text, {
    module, exports: module.exports, require: requireMobile, console,
    AbortController, setTimeout, clearTimeout, process,
  });
  return module.exports as Harness;
}

const accepted = { version: 1, vpn: true, diagnostics: false, notifications: false };

describe('Play distribution and privacy runtime', () => {
  it('defaults to direct but fails closed for conflict and unknown build markers', () => {
    assert.equal(resolveDistribution(), 'direct');
    assert.equal(resolveDistribution(undefined, 'direct'), 'direct');
    for (const marker of ['play', 'unknown', true, {}, 7]) {
      assert.equal(resolveDistribution('direct', marker), 'play');
    }
    assert.equal(resolveDistribution('play', 'direct'), 'play');
  });

  it('requires the current version and explicit booleans, not legacy or prechecked values', () => {
    for (const value of [null, {}, { ...accepted, version: 0 }, { ...accepted, vpn: 'true' }]) {
      assert.deepEqual(parsePrivacyConsent(value), NO_CONSENT);
    }
    assert.deepEqual(parsePrivacyConsent({ ...accepted, diagnostics: 'true', notifications: 1 }), accepted);
  });

  it('blocks APIs, FCM creation and diagnostics before loading or granting consent', async () => {
    const h = await harness();
    const requests: string[] = [];
    h.api.defaults.adapter = async config => {
      requests.push(config.url || '');
      return { data: [], status: 200, statusText: 'OK', headers: {}, config };
    };
    await assert.rejects(h.api.post('/mobile/auth/activate', { token: 'test' }), /privacy_consent_required/);
    await assert.rejects(h.api.get('/mobile/me'), /privacy_consent_required/);
    await h.push.syncPushTokenRegistration('device');
    await h.health.noteMobileHealthAppState('background');
    h.health.noteMobileHealthReconnect();
    await h.health.reportMobileHealth({ tunnelState: 'connected' });
    assert.equal(requests.length, 0);
    assert.equal(h.state.events.length, 0);
    assert.equal(h.state.storage.size, 0);
  });

  it('fails closed on corrupt storage or a missing native bridge', async () => {
    const h = await harness();
    h.state.persisted = '{invalid';
    await assert.rejects(h.consent.loadPrivacyConsent());
    assert.equal(h.consent.getPrivacyConsent().vpn, false);
    h.state.missing = true;
    await assert.rejects(h.consent.savePrivacyConsent(accepted));
    assert.equal(h.consent.getPrivacyConsent().vpn, false);
  });

  it('does not reuse stale consent when a later native read fails', async () => {
    const h = await harness();
    await h.consent.savePrivacyConsent(accepted);
    h.state.missing = true;
    await assert.rejects(h.consent.loadPrivacyConsent());
    assert.equal(h.consent.getPrivacyConsent().vpn, false);
  });

  it('allows required access without either optional data stream', async () => {
    const h = await harness();
    const requests: string[] = [];
    h.api.defaults.adapter = async config => {
      requests.push(config.url || '');
      return { data: [], status: 200, statusText: 'OK', headers: {}, config };
    };
    await h.consent.savePrivacyConsent(accepted);
    await h.api.get('/mobile/me');
    await h.push.syncPushTokenRegistration('device');
    await h.health.reportMobileHealth({ tunnelState: 'connected' });
    await assert.rejects(h.api.post('/mobile-health/report', {}), /privacy_diagnostics_disabled/);
    await assert.rejects(h.api.post('/mobile/push-tokens', {}), /privacy_notifications_disabled/);
    assert.deepEqual(requests, ['/mobile/me']);
    assert.equal(h.state.events.includes('FCM:create'), false);
    assert.equal(h.state.events.includes('health:create'), false);
  });

  it('collects optional data only after its own opt-in and removes it after withdrawal', async () => {
    const h = await harness();
    const requests: string[] = [];
    h.api.defaults.adapter = async config => {
      requests.push(`${config.method}:${config.url}`);
      return { data: [], status: 200, statusText: 'OK', headers: {}, config };
    };
    await h.consent.savePrivacyConsent({ ...accepted, diagnostics: true, notifications: true });
    await h.push.syncPushTokenRegistration('device');
    await h.health.reportMobileHealth({ tunnelState: 'connected', protocol: 'ssh' });
    assert.ok(requests.includes('post:/mobile/push-tokens'));
    assert.ok(requests.includes('post:/mobile-health/report'));
    const signal = h.consent.getPrivacySignal();
    await h.consent.savePrivacyConsent(NO_CONSENT);
    assert.equal(signal.aborted, true);
    assert.ok(h.state.events.indexOf('stop') < h.state.events.lastIndexOf('persist'));
    await h.health.clearMobileHealth();
    await h.push.unregisterPushToken('device');
    assert.ok(requests.includes('delete:/mobile/push-tokens'));
    assert.equal(h.state.storage.has('@sxb_mobile_health_pending_v1'), false);
    assert.equal(h.state.storage.has('@sxb_fcm_registered_token_v1'), false);
    const count = requests.length;
    await h.health.reportMobileHealth({ tunnelState: 'connected' });
    await h.push.syncPushTokenRegistration('device');
    assert.equal(requests.length, count);
  });

  it('does not claim withdrawal when the native tunnel cannot stop', async () => {
    const h = await harness();
    await h.consent.savePrivacyConsent(accepted);
    h.state.failStop = true;
    await assert.rejects(h.consent.savePrivacyConsent(NO_CONSENT), /stop pending/);
    assert.equal(h.consent.getPrivacyConsent().vpn, true);
  });

  // ── BATTEMENT DE PRÉSENCE ──────────────────────────────────────────────────
  // Sans battement, un appareil qui perd brutalement le réseau n'émet jamais de
  // « disconnected » et reste « connecté » indéfiniment côté serveur. Le
  // battement doit donc partir — mais jamais avant le consentement, jamais sans
  // tunnel, et jamais en différé.
  it('sends the presence heartbeat only for a live tunnel, and only after diagnostics opt-in', async () => {
    const h = await harness();
    const requests: { url: string; body: any }[] = [];
    h.api.defaults.adapter = async config => {
      requests.push({ url: config.url || '', body: JSON.parse(String(config.data || '{}')) });
      return { data: {}, status: 202, statusText: 'Accepted', headers: {}, config };
    };

    // Sans aucun consentement : rien ne part, rien n'est créé.
    assert.equal(await h.health.sendMobileHealthHeartbeat({ tunnelState: 'connected' }), false);
    assert.equal(requests.length, 0);

    // Consentement VPN seul, diagnostics refusés : toujours rien.
    await h.consent.savePrivacyConsent(accepted);
    assert.equal(await h.health.sendMobileHealthHeartbeat({ tunnelState: 'connected' }), false);
    assert.equal(requests.length, 0);

    // Diagnostics acceptés : le battement emprunte la route de rapport.
    await h.consent.savePrivacyConsent({ ...accepted, diagnostics: true });
    assert.equal(await h.health.sendMobileHealthHeartbeat({ tunnelState: 'connected', protocol: 'ssh' }), true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/mobile-health/report');
    assert.equal(requests[0].body.heartbeat, true);
    assert.equal(requests[0].body.tunnelState, 'connected');
    assert.equal(requests[0].body.protocol, 'ssh');
    // Un battement ne porte aucun compteur : il ne fausse aucune durée mesurée.
    assert.equal(requests[0].body.outcome, 'none');
    for (const compteur of ['sessionDurationSeconds', 'reconnectCount', 'activeDurationSeconds', 'backgroundDurationSeconds', 'wakeCount']) {
      assert.equal(requests[0].body[compteur], 0, compteur);
    }
    // Et il ne transporte aucune donnée nominative ni de navigation.
    for (const interdit of ['host', 'ip', 'payload', 'credentials', 'rawLog', 'userId', 'deviceId']) {
      assert.equal(interdit in requests[0].body, false, `${interdit} ne doit jamais être envoyé`);
    }

    // Tunnel arrêté : le battement n'a plus lieu d'être et ne part pas.
    for (const etat of ['disconnected', 'connecting', 'error'] as const) {
      assert.equal(await h.health.sendMobileHealthHeartbeat({ tunnelState: etat }), false, etat);
    }
    assert.equal(requests.length, 1);
  });

  it('never queues a failed heartbeat, so a stale one can never assert presence later', async () => {
    const h = await harness();
    await h.consent.savePrivacyConsent({ ...accepted, diagnostics: true });
    h.api.defaults.adapter = async () => { throw new Error('offline'); };

    // Un échec réseau ne rejette pas : il ne peut donc ni interrompre ni
    // ralentir le tunnel, qui n'attend rien de cet envoi.
    assert.equal(await h.health.sendMobileHealthHeartbeat({ tunnelState: 'connected' }), false);
    // Et il ne laisse aucune trace rejouable : rejoué plus tard, un battement
    // affirmerait une présence déjà expirée.
    assert.equal(h.state.storage.has('@sxb_mobile_health_pending_v1'), false);
  });

  it('retains a failed remote deletion for retry without recreating a Firebase token', async () => {
    const h = await harness();
    h.state.storage.set('@sxb_fcm_registered_token_v1', 'cached');
    h.state.storage.set('@sxb_device_id', 'device');
    h.api.defaults.adapter = async () => { throw new Error('offline'); };
    await assert.rejects(h.push.unregisterPushToken(''), /offline/);
    assert.equal(h.state.storage.get('@sxb_fcm_registered_token_v1'), 'cached');
    assert.equal(h.state.events.includes('FCM:create'), false);
  });

  it('rejects all queued calls on transient refresh failure while retaining credentials', async () => {
    const h = await harness();
    await h.consent.savePrivacyConsent(accepted);
    h.state.storage.set('@sxb_access_token', 'old-access');
    h.state.storage.set('@sxb_refresh_token', 'old-refresh');
    h.state.storage.set('@sxb_device_id', 'device');
    const previousAdapter = axios.defaults.adapter;
    let releaseRefresh: (() => void) | undefined;
    let refreshCount = 0;
    let apiCount = 0;
    const refreshReady = new Promise<void>(resolve => { releaseRefresh = resolve; });
    h.api.defaults.adapter = async config => {
      apiCount++;
      throw new AxiosError('Expired access', 'ERR_BAD_REQUEST', config, undefined, {
        data: {}, status: 401, statusText: 'Unauthorized', headers: {}, config,
      });
    };
    axios.defaults.adapter = async config => {
      refreshCount++;
      assert.equal(config.headers['X-SXB-Device-ID'], 'device');
      await refreshReady;
      throw new AxiosError('Temporarily limited', 'ERR_BAD_REQUEST', config, undefined, {
        data: {}, status: 429, statusText: 'Too Many Requests', headers: {}, config,
      });
    };
    const calls = [h.api.get('/mobile/me'), h.api.get('/mobile/vpn/config')];
    const outcomes = Promise.allSettled(calls);
    try {
      for (let i = 0; i < 100 && (apiCount < 2 || refreshCount < 1); i++) {
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      assert.equal(apiCount, 2);
      assert.equal(refreshCount, 1);
      releaseRefresh!();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const results = await Promise.race([
        outcomes,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Refresh queue remained pending')), 1000); }),
      ]).finally(() => clearTimeout(timer));
      assert.ok(results.every(result => result.status === 'rejected'));
      assert.equal(h.state.storage.get('@sxb_refresh_token'), 'old-refresh');
      assert.equal(h.state.storage.get('@sxb_access_token'), 'old-access');
    } finally {
      releaseRefresh!();
      axios.defaults.adapter = previousAdapter;
    }
  });

  it('never downloads or installs an APK on Play, including indirect/malicious API actions', async () => {
    for (const distribution of ['play', 'misconfigured']) {
      const h = await harness(distribution);
      assert.equal(await h.updates.fetchLatestAppUpdate(), null);
      for (const apkUrl of ['https://attacker.test/app.apk', 'file:///local.apk', 'javascript:bad']) {
        await h.updates.downloadAndInstallAppUpdate({ apkUrl, versionCode: 999, versionName: '999', forceUpdate: true });
      }
      assert.equal(h.state.events.filter(event => event === `open:${PLAY_STORE_URL}`).length, 3);
      assert.equal(h.state.events.some(event => event.startsWith('APK:')), false);
    }
  });

  it('preserves the direct APK installation path', async () => {
    const h = await harness('direct');
    await h.updates.downloadAndInstallAppUpdate({
      apkUrl: 'https://updates.test/app.apk', versionCode: 1, versionName: '1',
      apkSha256: 'a'.repeat(64),
    });
    assert.equal(h.state.events.join(','), 'APK:download,APK:uri,APK:install');
    assert.equal(h.consent.getPrivacyConsent().vpn, true);
  });

  it('keeps public privacy/deletion entry points and guards the final native engine', () => {
    assert.equal(PRIVACY_URL, 'https://vpnsxb.afrihall.com/api/public/privacy');
    assert.equal(DATA_DELETION_URL, 'https://vpnsxb.afrihall.com/api/public/data-deletion');
    const read = (file: string) => readFileSync(path.join(mobile, file), 'utf8');
    assert.match(read('app/_layout.tsx'), /publicSegments = new Set\(\[[^\]]*'privacy'/);
    assert.match(read('app/activate.tsx'), /router\.push\('\/privacy'\)/);
    assert.doesNotMatch(read('app/settings.tsx'), /sxbvpn\.com\/legal|ne transmet rien à des tiers/);
    const service = read('modules/android-native/SxbVpnService.kt');
    const finalEngine = service.slice(service.indexOf('private fun startLibboxService'));
    assert.ok(finalEngine.indexOf('SxbPlayEncryption.validate') < finalEngine.indexOf('Libbox.newService'));
    assert.match(service, /onStartCommand[\s\S]*?SxbPrivacyPolicy\.vpnAllowed/);
    assert.match(service, /private fun dispatchProtocol[\s\S]*?SxbPrivacyPolicy\.vpnAllowed/);
    assert.match(read('modules/android-native/SxbPushNotifications.kt'), /if \(!SxbPrivacyPolicy\.notificationsAllowed\(context\)\) return null/);
    assert.match(read('modules/android-native/SxbPrivacyPolicy.kt'), /if \(!play\) PackageManager\.COMPONENT_ENABLED_STATE_DEFAULT/);
    assert.match(read('modules/android-native/SxbVpnModule.kt'), /if \(!SxbPrivacyPolicy\.isPlay\(reactContext\)\) SxbPrivacyPolicy\.syncPushComponents\(reactContext\)/);
  });
});

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import type { AccessAuthority, AccessSnapshot, DeviceStatus, ProfileStatus, ProfileIdentity } from '../services/accessPolicy';
import type { NativeAccessRuntime } from '../services/nativeAccess';
import type { IdentitySession } from '../services/identitySession';

const mobile = path.resolve(__dirname, '..');
const requireMobile = createRequire(path.join(mobile, 'package.json'));
const { build } = createRequire(requireMobile.resolve('tsx'))('esbuild');
type PluginSetup = {
  onResolve(options: { filter: RegExp }, callback: (args: { path: string }) => unknown): void;
  onLoad(options: { filter: RegExp; namespace: string }, callback: (args: { path: string }) => unknown): void;
};
type Harness = {
  policy: typeof import('../services/accessPolicy');
  access: typeof import('../services/accessState');
  sync: typeof import('../services/accessSync');
  auth: typeof import('../services/identitySession');
  api: typeof import('../services/apiClient');
  store: typeof import('../services/configStore');
  profiles: typeof import('../services/activeProfile');
  offline: typeof import('../services/offlineStorage');
  consent: typeof import('../services/privacyConsent');
  provision: typeof import('../services/provisionClient');
  events: typeof import('../services/accessEvents');
  aes: typeof import('../services/aesGcm');
  renderBlocked(language: 'fr' | 'en', status: DeviceStatus): string;
  state: {
    storage: Map<string, string>;
    secure: Map<string, string>;
    events: string[];
    logs: unknown[][];
    failRemove: string | null;
    failStop: boolean;
    stopCount: number;
    foreground(next: string): void;
    native: Record<string, unknown>;
  };
};

async function harness(distribution = 'direct'): Promise<Harness> {
  const stubs: Record<string, string> = {
    'test:state': `export const state = {
      storage:new Map(), secure:new Map(), events:[], logs:[], failRemove:null, failStop:false,
      stopCount:0, native:{}, foreground:()=>{},
    };`,
    'react-native': `
      import React from 'react';
      import {state} from 'test:state';
      export const Platform={OS:'android',Version:35,constants:{Model:'test'}};
      const listeners=new Set();
      export const AppState={currentState:'active',addEventListener:(_,f)=>{listeners.add(f);return{remove:()=>listeners.delete(f)}}};
      state.foreground=next=>{AppState.currentState=next;for(const f of listeners)f(next)};
      const primitive=tag=>({children,accessibilityRole,...props})=>React.createElement(tag, {role:accessibilityRole}, children);
      export const Text=primitive('span'),View=primitive('div'),Pressable=primitive('button'),ScrollView=primitive('main'),ActivityIndicator=primitive('progress');
      export const StyleSheet={create:x=>x,absoluteFillObject:{}};
      export const Linking={openURL:async()=>{}};
      export const NativeModules={SxbVpnNative:state.native};
      Object.assign(state.native,{
        distribution:${JSON.stringify(distribution)},
        getPrivacyConsent:async()=>JSON.stringify(state.consent??{version:1,vpn:false,diagnostics:false,notifications:false}),
        setPrivacyConsent:async(vpn,diagnostics,notifications)=>{
          if(!vpn) {state.events.push('native:stop');if(state.failStop)throw Error('stop pending')}
          state.consent={version:1,vpn,diagnostics,notifications};return JSON.stringify(state.consent);
        },
        getBatteryOptimizationState:async()=>'optimized',
        deletePushToken:async()=>true,
      });
      export class NativeEventEmitter {
        addListener(name,cb){state.nativeListeners??=new Map();state.nativeListeners.set(name,cb);return{remove:()=>state.nativeListeners.delete(name)}}
      }`,
    '@react-native-async-storage/async-storage': `import {state} from 'test:state';export default{
      getItem:async k=>state.storage.get(k)??null,
      setItem:async(k,v)=>{state.events.push('write:'+k);state.storage.set(k,v)},
      removeItem:async k=>{if(state.failRemove===k)throw Error('IO unavailable');state.events.push('remove:'+k);state.storage.delete(k)},
      multiRemove:async keys=>{for(const k of keys){if(state.failRemove===k)throw Error('IO unavailable');state.events.push('remove:'+k);state.storage.delete(k)}},
      getAllKeys:async()=>[...state.storage.keys()],
    };`,
    'expo-secure-store': `import {state} from 'test:state';
      export const getItemAsync=async k=>state.secure.get(k)??null;
      export const setItemAsync=async(k,v)=>{state.events.push('secure:'+k);state.secure.set(k,v)};
      export const deleteItemAsync=async k=>{state.events.push('secure-delete:'+k);state.secure.delete(k)};`,
    'expo-crypto': `import {randomFillSync,randomUUID as uuid} from 'node:crypto';
      export const getRandomValues=x=>randomFillSync(x);
      export const randomUUID=()=>uuid();`,
    'expo-constants': `export default {expoConfig:{extra:{distribution:${JSON.stringify(distribution)}},version:'1',android:{versionCode:1}}};`,
    'expo-router': `export const router={push:()=>{},replace:()=>{}};`,
    'react-native-safe-area-context': `export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});`,
    '@/hooks/useColors': `export const useColors=()=>({primary:'#008',primaryForeground:'#fff',textPrimary:'#111',textMuted:'#666',textSecondary:'#333',bg:'#fff',bgCard:'#eee',border:'#ccc',warning:'#900'});`,
    '@/modules/expo-sxb-vpn/src': `export const getPushToken=async()=>null;export const deletePushToken=async()=>true;`,
  };
  const output = await build({
    stdin: {
      contents: `
        import React from 'react';
        import {renderToStaticMarkup} from 'react-dom/server';
        import DeviceAccessScreen from './app/access-blocked';
        import {AuthContext} from './contexts/AuthContext';
        import {LanguageContext} from './contexts/LanguageContext';
        export {state} from 'test:state';
        export * as policy from './services/accessPolicy';
        export * as access from './services/accessState';
        export * as sync from './services/accessSync';
        export * as auth from './services/identitySession';
        export * as api from './services/apiClient';
        export * as store from './services/configStore';
        export * as profiles from './services/activeProfile';
        export * as offline from './services/offlineStorage';
        export * as consent from './services/privacyConsent';
        export * as provision from './services/provisionClient';
        export * as events from './services/accessEvents';
        export * as aes from './services/aesGcm';
        export function renderBlocked(language,status) {
          const value={deviceAccess:{id:'client',status,code:'DEVICE_'+status.toUpperCase(),expireAt:null,activationRequired:false},accessNotices:[]};
          return renderToStaticMarkup(React.createElement(LanguageContext.Provider,{value:{language}},React.createElement(AuthContext.Provider,{value},React.createElement(DeviceAccessScreen))));
        }`,
      loader: 'tsx', resolveDir: mobile,
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
    external: ['axios', 'react', 'react-dom/server', 'node:crypto'],
    define: { 'process.env.EXPO_PUBLIC_DISTRIBUTION': JSON.stringify(distribution), __DEV__: 'false' },
    plugins: [{
      name: 'native-io-fixtures',
      setup(plugin: PluginSetup) {
        plugin.onResolve({ filter: /.*/ }, args => args.path in stubs ? { path: args.path, namespace: 'stub' } : undefined);
        plugin.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js' }));
      },
    }],
  });
  const module = { exports: {} };
  const logs: unknown[][] = [];
  runInNewContext(output.outputFiles[0].text, {
    module, exports: module.exports, require: requireMobile,
    console: { warn: (...args: unknown[]) => logs.push(args), log: (...args: unknown[]) => logs.push(args), error: (...args: unknown[]) => logs.push(args) },
    AbortController, setTimeout, clearTimeout, setInterval, clearInterval, process, URL,
  });
  const h = module.exports as Harness;
  h.state.logs = logs;
  return h;
}

const user = { id: 'identity-user', name: 'Subscriber', email: '' };
const accountState = { state: 'ready', quotaTotalGb: 1, quotaUsedGb: 0, quotaRemainingGb: 1, expireAt: null, deviceLimit: 1 };
function snapshot(revision: string, device: DeviceStatus = 'active', a: ProfileStatus = 'active', b: ProfileStatus = 'active'): AccessSnapshot {
  return {
    revision, serverTime: '2026-09-09T00:00:00.000Z',
    device: { id: 'client-not-user', status: device, code: `DEVICE_${device.toUpperCase()}`, expireAt: '2027-01-01T00:00:00.000Z', activationRequired: false },
    subscriptions: [
      { id: 'a', name: 'Profile A', status: a, quotaTotalBytes: 100, quotaUsedBytes: 5, expireAt: '2026-12-01T00:00:00.000Z', configVersion: 1, configHash: 'hash-a' },
      { id: 'b', name: 'Profile B', status: b, quotaTotalBytes: 200, quotaUsedBytes: 6, expireAt: null, configVersion: 1, configHash: 'hash-b' },
    ],
  };
}
const config = { protocol: 'vless', host: 'vpn.example.test', port: 443, uuid: 'test-vpn-credential', tls: true };

async function setup(h: Harness, active: string | null = 'a') {
  h.state.storage.set('@sxb_device_id', 'hardware');
  await h.auth.acceptActivatedIdentity({ accessToken: 'test-access', refreshToken: 'test-refresh', user, accountState }, 'hardware');
  for (const id of ['a', 'b', 'manual']) {
    const source = id === 'manual' ? 'manual' : 'backend';
    assert.equal((await h.store.save(id, { ...config, configId: id }, {
      name: `Profile ${id}`, source, subscriptionId: source === 'backend' ? id : undefined,
      configHash: `hash-${id}`, configVersion: 1, isActive: id === 'a',
    })).status, 'ok');
    await h.offline.saveQuotaData({ configId: id, totalQuota: 100, usedQuota: 5, expiryDate: null });
  }
  let activeProfile: ProfileIdentity | null = active ? { configId: active, subscriptionId: active === 'manual' ? undefined : active, source: active === 'manual' ? 'manual' : 'backend' } : null;
  const cleanup = h.sync.registerAccessRuntime({
    activeProfile: () => activeProfile,
    stop: async () => {
      h.state.events.push('vpn:stop');
      if (h.state.failStop) throw new Error('native stop pending');
      h.state.stopCount++;
      activeProfile = null;
    },
    changed: async () => { h.state.events.push('ui:changed'); },
  });
  await apply(h, snapshot('r0'));
  h.state.events.length = 0;
  return { cleanup, setActive: (id: string) => { activeProfile = { configId: id, subscriptionId: id, source: 'backend' }; } };
}
async function apply(h: Harness, value: AccessSnapshot) {
  const stamp = h.access.captureAccessAuthority();
  assert.ok(stamp);
  const profiles = h.sync.storeValue(await h.store.list()) ?? [];
  await h.access.applyAccessSnapshot(value, stamp, profiles);
  await h.sync.reconcileAccess();
}
function httpError(config: InternalAxiosRequestConfig, status: number, data: unknown) {
  return new AxiosError('Fixture error', 'ERR_BAD_REQUEST', config, undefined, {
    data, status, statusText: 'Fixture', headers: {}, config,
  });
}
function remoteConnections(value: AccessSnapshot) {
  return { connections: value.subscriptions.map(entry => ({
    id: entry.id, name: entry.name, status: entry.status, quota: { totalBytes: entry.quotaTotalBytes, usedBytes: entry.quotaUsedBytes },
    expiresAt: entry.expireAt, dataToken: '', configHash: entry.configHash, configVersion: entry.configVersion,
  })) };
}
const equal = (actual: unknown, expected: unknown) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);

describe('mobile access runtime with real encrypted store, auth and HTTP interceptors', () => {
  /**
   * Passage d'un ESSAI GRATUIT à un compte normal activé par jeton.
   *
   * Ce que fait RÉELLEMENT le serveur : le déploiement d'un essai réutilise le
   * compte déjà lié au téléphone, et `/api/devices/generate-token` rend le
   * jeton EXISTANT pour un appareil déjà enrôlé. Le compte — donc l'identité —
   * ne change pas, si bien que `acceptActivatedIdentity` ne purge rien : c'est
   * voulu, purger détruirait un accès encore valide.
   *
   * Le défaut était ailleurs : la configuration d'essai restait ACTIVE après
   * son échéance, et le forfait ordinaire arrivé ensuite était enregistré
   * inactif. L'application proposait donc l'essai terminé alors qu'un accès
   * valide existait.
   */
  it('remplace une configuration d’essai terminée par celle du compte actif, sans jamais la supprimer', async () => {
    const h = await harness();
    h.state.storage.set('@sxb_device_id', 'hardware');
    await h.auth.acceptActivatedIdentity({ accessToken: 'trial-access', refreshToken: 'trial-refresh', user, accountState }, 'hardware');

    const passe = new Date(Date.now() - 86_400_000).toISOString();
    const futur = new Date(Date.now() + 30 * 86_400_000).toISOString();
    assert.equal((await h.store.save('trial-sub', { ...config, configId: 'trial-sub' }, {
      source: 'backend', subscriptionId: 'trial-sub', name: 'Essai gratuit — Orange', expiryDate: futur,
    })).status, 'ok');
    assert.equal((await h.store.getActive()).value?.meta.configId, 'trial-sub');

    // Tant que l'essai fonctionne, un forfait ordinaire ne lui vole pas la place.
    assert.equal((await h.store.save('paid-sub', { ...config, configId: 'paid-sub' }, {
      source: 'backend', subscriptionId: 'paid-sub', name: 'Forfait 50 Go', expiryDate: futur,
    })).status, 'ok');
    assert.equal((await h.store.getActive()).value?.meta.configId, 'trial-sub');

    // L'essai arrive à échéance : le serveur le rapporte « expired ».
    await h.store.updateMetadata('trial-sub', { accessStatus: 'expired', expiryDate: passe });

    // Le compte normal se réactive avec le MÊME identifiant utilisateur : rien
    // n'est purgé, et c'est précisément le cas que le propriétaire redoutait.
    await h.auth.acceptActivatedIdentity({ accessToken: 'renewed-access', refreshToken: 'renewed-refresh', user, accountState }, 'hardware');
    assert.equal((await h.store.get('trial-sub')).status, 'ok', 'une configuration stockée ne doit pas être supprimée');

    // Le forfait ordinaire est reprovisionné : il devient l'actif.
    assert.equal((await h.store.save('paid-sub', { ...config, configId: 'paid-sub' }, {
      source: 'backend', subscriptionId: 'paid-sub', name: 'Forfait 50 Go', expiryDate: futur, configVersion: 2,
    })).status, 'ok');
    assert.equal((await h.store.getActive()).value?.meta.configId, 'paid-sub');
    assert.equal(h.state.storage.get('@sxb_active_config_id'), 'paid-sub');

    // Un seul actif à la fois, et l'essai reste stocké — déclassé, pas détruit.
    const entrees = (await h.store.list()).value ?? [];
    assert.deepEqual([...entrees.filter(entree => entree.isActive).map(entree => entree.configId)], ['paid-sub']);
    assert.equal(entrees.some(entree => entree.configId === 'trial-sub'), true);
  });

  it('choisit la configuration du compte actif et n’en invente pas quand tout est terminé', async () => {
    const h = await harness();
    const passe = new Date(Date.now() - 3_600_000).toISOString();
    const futur = new Date(Date.now() + 3_600_000).toISOString();
    const essai = { configId: 'trial', subscriptionId: 'trial', source: 'backend' as const, expiryDate: passe, isActive: true };
    const paye = { configId: 'paid', subscriptionId: 'paid', source: 'backend' as const, expiryDate: futur, isActive: false };

    // L'essai terminé était le dernier choix mémorisé : il cède la place.
    assert.equal(h.profiles.choisirProfilActif([essai, paye], { demande: 'trial' })?.configId, 'paid');
    // Un profil encore valide explicitement choisi n'est jamais déclassé.
    assert.equal(h.profiles.choisirProfilActif([{ ...essai, expiryDate: futur }, paye], { demande: 'trial' })?.configId, 'trial');
    // Plus rien d'utilisable : on garde le profil demandé pour pouvoir
    // EXPLIQUER le blocage, au lieu de n'afficher rien du tout.
    assert.equal(h.profiles.choisirProfilActif([essai, { ...paye, expiryDate: passe }], { demande: 'trial' })?.configId, 'trial');
    // Une restriction connue (suspendu, révoqué) reste prioritaire sur le choix.
    assert.equal(h.profiles.choisirProfilActif([{ ...essai, expiryDate: futur }, paye], {
      demande: 'trial', restreint: entree => entree.configId === 'trial',
    })?.configId, 'paid');
    assert.equal(h.profiles.profilEpuiseOuExpire({ accessStatus: 'exhausted' }), true);
    assert.equal(h.profiles.profilUtilisable({ expiryDate: null }), true);
  });

  it('accepts the real token-only activation and account response without an e-mail', async () => {
    const h = await harness();
    h.state.storage.set('@sxb_device_id', 'hardware');
    const mobileUser = { id: user.id, name: user.name };
    await h.auth.acceptActivatedIdentity({
      accessToken: 'activated-access', refreshToken: 'activated-refresh', user: mobileUser, accountState,
    }, 'hardware');
    equal(h.auth.getIdentitySession()?.user, { ...mobileUser, email: '' });
    assert.equal(h.state.secure.get('sxb_access_token_v2'), 'activated-access');
    h.api.default.defaults.adapter = async request => ({
      status: 200, statusText: 'OK', config: request, headers: {}, data: { user: mobileUser, accountState },
    });
    await h.auth.validateIdentitySession('hardware');
    equal(h.auth.getIdentitySession()?.user, { ...mobileUser, email: '' });
    const restored = await harness();
    restored.state.storage.set('@sxb_device_id', 'hardware');
    restored.state.storage.set('@sxb_user', JSON.stringify({ user: mobileUser, accountState }));
    restored.state.secure.set('sxb_access_token_v2', 'activated-access');
    await restored.auth.restoreIdentitySession('hardware');
    equal(restored.auth.getIdentitySession()?.user, { ...mobileUser, email: '' });
  });

  it('allows absent contact data but rejects a malformed identity before changing credentials', async () => {
    const h = await harness();
    await h.auth.acceptActivatedIdentity({
      accessToken: 'kept-access', refreshToken: 'kept-refresh', user: { ...user, email: null }, accountState,
    }, 'hardware');
    assert.equal(h.auth.getIdentitySession()?.user.email, '');
    for (const malformed of [{ ...user, email: 42 }, { ...user, id: '' }, { ...user, name: null }]) {
      await assert.rejects(h.auth.acceptActivatedIdentity({
        accessToken: 'wrong-access', refreshToken: 'wrong-refresh', user: malformed, accountState,
      }, 'hardware'), /AUTH_RESPONSE_INVALID/);
      assert.equal(h.state.secure.get('sxb_access_token_v2'), 'kept-access');
      assert.equal(h.auth.getIdentitySession()?.user.id, user.id);
    }
  });
  it('revokes active A only, stops before purge, preserves B/manual/auth and selects B without connecting', async () => {
    const h = await harness();
    await setup(h);
    const b = h.state.storage.get('sxb_cfg_payload_b');
    const token = h.state.secure.get('sxb_access_token_v2');
    await apply(h, snapshot('revoked', 'active', 'revoked'));
    assert.equal(h.state.stopCount, 1);
    assert.ok(h.state.events.indexOf('vpn:stop') < h.state.events.indexOf('remove:sxb_cfg_payload_a'));
    assert.equal((await h.store.get('a')).status, 'missing');
    assert.equal(h.state.storage.has('sxb_quota_a'), false);
    assert.equal(h.state.storage.get('sxb_cfg_payload_b'), b);
    assert.equal((await h.store.get('manual')).status, 'ok');
    assert.equal((await h.store.getActive()).value?.meta.configId, 'b');
    assert.equal(h.state.secure.get('sxb_access_token_v2'), token);
    assert.equal(h.auth.getIdentitySession()?.user.id, user.id);
    assert.ok(h.access.getAccessState().notices.some(item => item.kind === 'config_revoked' && item.name === 'Profile A'));
    assert.equal(h.state.events.includes('vpn:connect'), false);
  });

  it('inactive B revocation never stops A, even when the two managed profiles share a payload hash', async () => {
    const h = await harness();
    await setup(h);
    const s = snapshot('revoke-b', 'active', 'active', 'revoked');
    s.subscriptions[0].configHash = 'shared';
    s.subscriptions[1].configHash = 'shared';
    await h.store.save('a', config, { source: 'backend', subscriptionId: 'a', configHash: 'shared' });
    await h.store.save('b', config, { source: 'backend', subscriptionId: 'b', configHash: 'shared' });
    await apply(h, s);
    assert.equal(h.state.stopCount, 0);
    assert.equal((await h.store.get('a')).status, 'ok');
    assert.equal((await h.store.get('b')).status, 'missing');
  });

  it('suspends only a profile, retains ciphertext/quota, and lifts the block without reconnecting', async () => {
    const h = await harness();
    await setup(h);
    const a = h.state.storage.get('sxb_cfg_payload_a');
    await apply(h, snapshot('suspended', 'active', 'suspended'));
    assert.equal(h.state.storage.get('sxb_cfg_payload_a'), a);
    assert.throws(() => h.access.requireProfileAccess({ configId: 'a' }), /CONFIG_SUSPENDED/);
    assert.doesNotThrow(() => h.access.requireProfileAccess({ configId: 'b' }));
    await apply(h, snapshot('restored'));
    assert.doesNotThrow(() => h.access.requireProfileAccess({ configId: 'a' }));
    assert.equal(h.state.stopCount, 1);
    assert.ok(h.access.getAccessState().notices.some(item => item.kind === 'config_restored'));
  });

  for (const device of ['suspended', 'disabled', 'expired', 'revoked', 'deleted'] as const) {
    it(`${device} device blocks business operations without losing identity, and restores without reconnect`, async () => {
      const h = await harness();
      await setup(h);
      const cached = h.state.storage.get('sxb_cfg_payload_b');
      await apply(h, snapshot(device, device));
      assert.equal(h.auth.getIdentitySession()?.user.id, user.id);
      assert.equal(h.state.storage.get('sxb_cfg_payload_b'), cached);
      assert.equal(h.state.stopCount, 1);
      let count = 0;
      h.api.default.defaults.adapter = async request => { count++; return { status: 200, statusText: 'OK', config: request, headers: {}, data: {} }; };
      await assert.rejects(h.api.default.post('/mobile/vpn/session'), /DEVICE_/);
      assert.equal(count, 0);
      await apply(h, snapshot('resumed'));
      assert.doesNotThrow(() => h.access.requireDeviceAccess());
      assert.equal(h.state.stopCount, 1);
      assert.equal(h.state.secure.get('sxb_refresh_token_v2'), 'test-refresh');
    });
  }

  it('preserves known blocks across a cold offline restore and rejects a revoked reimport', async () => {
    const first = await harness();
    await setup(first);
    await apply(first, snapshot('revoked', 'active', 'revoked'));
    const second = await harness();
    first.state.storage.forEach((value, key) => second.state.storage.set(key, value));
    first.state.secure.forEach((value, key) => second.state.secure.set(key, value));
    await second.auth.restoreIdentitySession('hardware');
    assert.equal(second.auth.getIdentitySession()?.user.id, user.id);
    assert.equal((await second.store.save('renamed', config, { source: 'manual', configHash: 'hash-a' })).status, 'error');
    assert.equal((await second.store.save('a', config, { source: 'backend', subscriptionId: 'a' })).status, 'error');
    assert.equal((await second.store.restore('a')).status, 'error');
    assert.equal((await second.store.get('b')).status, 'ok');
  });

  it('updates quota/expiry without token rotation, ciphertext replacement, stop, or per-usage notices', async () => {
    const h = await harness();
    await setup(h);
    const ciphertext = h.state.storage.get('sxb_cfg_payload_a');
    await h.access.dismissAccessNotices();
    const quota = snapshot('quota');
    quota.subscriptions[0].quotaTotalBytes = 500;
    quota.subscriptions[0].expireAt = '2028-01-01T00:00:00.000Z';
    await apply(h, quota);
    const notices = h.access.getAccessState().notices;
    equal(notices.map(item => item.kind), ['config_extended', 'config_quota_updated']);
    assert.equal((await h.offline.loadQuotaData('a'))?.totalQuota, 500);
    assert.equal((await h.store.get('a')).value?.meta.expiryDate, '2028-01-01T00:00:00.000Z');
    assert.equal(h.state.storage.get('sxb_cfg_payload_a'), ciphertext);
    assert.equal(h.state.stopCount, 0);
    assert.equal(h.state.secure.get('sxb_access_token_v2'), 'test-access');
    quota.revision = 'usage';
    quota.subscriptions[0].quotaUsedBytes = 6;
    await apply(h, quota);
    assert.equal(h.access.getAccessState().notices.length, notices.length);
    quota.revision = 'usage-reconciled';
    quota.subscriptions[0].quotaUsedBytes = 4;
    await apply(h, quota);
    assert.equal(h.access.getAccessState().notices.length, notices.length);
  });

  it('keeps expired/exhausted profiles and readmits them after extension/top-up', async () => {
    const h = await harness();
    await setup(h);
    await apply(h, snapshot('spent', 'active', 'expired', 'exhausted'));
    assert.equal((await h.store.get('a')).status, 'ok');
    assert.equal((await h.store.get('b')).status, 'ok');
    assert.doesNotThrow(() => h.access.requireProfileAccess({ configId: 'a' }));
    assert.equal(h.state.stopCount, 0);
    await apply(h, snapshot('topped-up'));
    assert.ok(h.access.getAccessState().notices.some(item => item.kind === 'config_restored'));
    assert.equal((await h.store.get('a')).value?.meta.accessStatus, 'active');
  });

  it('only a validated complete snapshot can remove an orphan; manual imports are not orphans', async () => {
    const h = await harness();
    await setup(h, null);
    const s = snapshot('deleted');
    s.subscriptions = [];
    await apply(h, s);
    equal((await h.store.list()).value?.map(entry => entry.configId), ['manual']);
    assert.equal(h.auth.getIdentitySession()?.user.id, user.id);
  });

  it('rejects malformed, duplicate, wrong-client and stale snapshots before side effects', async () => {
    const h = await harness();
    await setup(h);
    const stamp = h.access.captureAccessAuthority()!;
    await assert.rejects(h.access.applyAccessSnapshot({ ...snapshot('bad'), subscriptions: undefined }, stamp), /ACCESS_SNAPSHOT_INVALID/);
    const duplicate = snapshot('dup');
    duplicate.subscriptions[1].id = 'a';
    await assert.rejects(h.access.applyAccessSnapshot(duplicate, stamp), /ACCESS_PROFILE_INVALID/);
    const foreign = snapshot('foreign');
    foreign.device.id = 'other-client';
    await assert.rejects(h.access.applyAccessSnapshot(foreign, stamp), /ACCESS_CLIENT_MISMATCH/);
    await apply(h, snapshot('block', 'active', 'suspended'));
    assert.equal(await h.access.applyAccessSnapshot(snapshot('late-active'), stamp), false);
    assert.throws(() => h.access.requireProfileAccess({ configId: 'a' }), /CONFIG_SUSPENDED/);
  });

  for (const status of ['deleted', 'revoked'] as const) {
    it(`keeps unrelated caches for a minimal ${status} device snapshot`, async () => {
      const h = await harness();
      await setup(h);
      const b = h.state.storage.get('sxb_cfg_payload_b');
      await apply(h, snapshot('known-revocation', 'active', 'revoked'));
      const minimal = snapshot('minimal', status);
      minimal.device.activationRequired = true;
      minimal.subscriptions = [];
      await apply(h, minimal);
      assert.equal(h.auth.getIdentitySession()?.user.id, user.id);
      assert.equal(h.state.storage.get('sxb_cfg_payload_b'), b);
      assert.equal((await h.store.get('manual')).status, 'ok');
      assert.equal((await h.store.get('a')).status, 'missing');
      assert.equal(h.access.getAccessState().authority?.restrictions.some(item => item.id === 'b'), false);
      assert.throws(() => h.access.requireDeviceAccess(), /DEVICE_/);
    });
  }

  it('hands observation to native and rejects late JS snapshots after a native restriction', async () => {
    const h = await harness();
    const native: NativeAccessRuntime = {
      authority: null, observing: false, ticketStatus: 'ready',
      ticketExpiresAt: '2027-01-01T00:00:00.000Z', activeProfile: null,
    };
    const authority = (): AccessAuthority => {
      assert.ok(native.authority);
      return native.authority;
    };
    Object.assign(h.state.native, {
      bindAccessSession: async (userId: string, deviceId: string) => {
        native.authority ??= { userId, deviceId, session: 'native-session', sequence: 0,
          snapshot: null, deviceIssue: null, restrictions: [] };
        return JSON.stringify(native);
      },
      getAccessControlState: async () => JSON.stringify(native),
      applyAccessSnapshot: async (raw: string, local: string, session: string, sequence: number) => {
        if (authority().session === session && authority().sequence === sequence) {
          native.authority = h.policy.reduceSnapshot(authority(), h.policy.parseAccessSnapshot(JSON.parse(raw)), JSON.parse(local));
        }
        return JSON.stringify(native);
      },
    });
    await setup(h);
    const stale = h.access.captureAccessAuthority()!;
    native.observing = true;
    native.activeProfile = { configId: 'a', subscriptionId: 'a', source: 'backend' };
    let requests = 0;
    h.api.default.defaults.adapter = async request => {
      requests++;
      throw httpError(request, 429, { code: 'ACCESS_STATE_BUSY' });
    };
    await h.sync.refreshAccessState(true);
    assert.equal(requests, 0);
    native.authority = h.policy.reduceSnapshot(authority(), snapshot('native-b-revoked', 'active', 'active', 'revoked'), []);
    await h.access.syncNativeAccessState();
    await h.sync.reconcileAccess();
    assert.equal(h.state.stopCount, 0);
    assert.equal((await h.store.get('a')).status, 'ok');
    assert.equal((await h.store.get('b')).status, 'missing');
    assert.equal(await h.access.applyAccessSnapshot(snapshot('late-js-active'), stale), false);
    assert.throws(() => h.access.requireProfileAccess({ configId: 'b' }), /CONFIG_REVOKED/);
    assert.equal(h.auth.getIdentitySession()?.user.id, user.id);
  });

  it('refreshes genuine JWT expiry with the existing hardware binding, not a control ticket', async () => {
    const h = await harness();
    await setup(h);
    const previous = axios.defaults.adapter;
    let requests = 0;
    axios.defaults.adapter = async request => {
      assert.equal(request.headers['X-SXB-Device-ID'], 'hardware');
      assert.equal(JSON.parse(request.data).refreshToken, 'test-refresh');
      return { status: 200, statusText: 'OK', config: request, headers: {}, data: { accessToken: 'fresh-access', refreshToken: 'fresh-refresh' } };
    };
    h.api.default.defaults.adapter = async request => {
      if (++requests === 1) throw httpError(request, 401, { error: 'errors.auth.invalid_token' });
      return { status: 200, statusText: 'OK', config: request, headers: {}, data: { user, accountState } };
    };
    try {
      await h.auth.validateIdentitySession('hardware');
      assert.equal(requests, 2);
      assert.equal(h.state.secure.get('sxb_access_token_v2'), 'fresh-access');
      assert.equal(h.auth.getIdentitySession()?.user.id, user.id);
      assert.equal((await h.store.get('b')).status, 'ok');
    } finally { axios.defaults.adapter = previous; }
  });

  it('does not purge before a failed native stop, and retries the same targeted cleanup', async () => {
    const h = await harness();
    await setup(h);
    h.state.failStop = true;
    await assert.rejects(apply(h, snapshot('revoked', 'active', 'revoked')), /stop pending/);
    assert.equal((await h.store.get('a')).status, 'ok');
    assert.throws(() => h.access.requireProfileAccess({ configId: 'a' }), /CONFIG_REVOKED/);
    h.state.failStop = false;
    await h.sync.reconcileAccess();
    assert.equal((await h.store.get('a')).status, 'missing');
    assert.equal((await h.store.get('b')).status, 'ok');
  });

  it('retains identity on 403, random 404, 429, network failure and legacy refresh DB-style 401', async () => {
    const h = await harness();
    await setup(h);
    const previous = axios.defaults.adapter;
    axios.defaults.adapter = async request => { throw httpError(request, 401, { error: 'errors.auth.invalid_token' }); };
    try {
      for (const status of [403, 404, 429, 401, 0]) {
        h.api.default.defaults.adapter = async request => {
          if (!status) throw new Error('offline');
          throw httpError(request, status, { error: status === 401 ? 'errors.auth.invalid_token' : 'permission_denied' });
        };
        await assert.rejects(h.auth.validateIdentitySession('hardware', 'a'));
        assert.equal(h.auth.getIdentitySession()?.user.id, user.id);
        assert.equal(h.state.secure.get('sxb_refresh_token_v2'), 'test-refresh');
        assert.equal((await h.store.get('b')).status, 'ok');
      }
    } finally { axios.defaults.adapter = previous; }
  });

  it('preserves typed config/device failures through real API and only clears a definite invalid session', async () => {
    const h = await harness();
    await setup(h);
    const failures: string[] = [];
    const unsub = h.events.subscribeAccessFailures(({ issue }) => failures.push(issue.code));
    const previous = axios.defaults.adapter;
    let refreshCalls = 0;
    axios.defaults.adapter = async request => { refreshCalls++; throw httpError(request, 401, { code: 'SESSION_INVALID', scope: 'session', temporary: false }); };
    try {
      h.api.default.defaults.adapter = async request => { throw httpError(request, 403, { code: 'CONFIG_REVOKED', scope: 'subscription', temporary: false, subscriptionId: 'a' }); };
      await assert.rejects(h.auth.validateIdentitySession('hardware', 'a'));
      assert.equal(failures[0], 'CONFIG_REVOKED');
      assert.equal(refreshCalls, 0);
      assert.equal(h.auth.getIdentitySession()?.user.id, user.id);
      h.api.default.defaults.adapter = async request => { throw httpError(request, 401, { code: 'SESSION_INVALID', scope: 'session', temporary: false }); };
      await assert.rejects(h.auth.validateIdentitySession('hardware'));
      assert.equal(h.auth.getIdentitySession(), null);
      assert.equal(h.state.secure.has('sxb_access_token_v2'), false);
      equal((await h.store.list()).value, []);
    } finally { unsub(); axios.defaults.adapter = previous; }
  });

  it('uses legacy connections when the endpoint is not deployed without deleting manual/absent entries', async () => {
    const h = await harness();
    await setup(h);
    const requests: string[] = [];
    h.api.default.defaults.adapter = async request => {
      requests.push(request.url ?? '');
      if (request.url === '/mobile/access-state') throw httpError(request, 404, { error: 'not_found' });
      if (request.url === '/mobile/connections') return { status: 200, statusText: 'OK', config: request, headers: {}, data: { connections: [] } };
      throw new Error('Unexpected request');
    };
    await h.sync.refreshMobileConfigs();
    equal((await h.store.list()).value?.map(entry => entry.configId), ['a', 'b', 'manual']);
    assert.equal(h.auth.getIdentitySession()?.user.id, user.id);
    assert.equal(requests.some(url => url.startsWith('/mobile/vpn/config')), false);
  });

  it('reconciles before provisioning even when the selected config endpoint would return 403', async () => {
    const h = await harness();
    await setup(h);
    const s = snapshot('revoke-a', 'active', 'revoked');
    const requests: string[] = [];
    h.api.default.defaults.adapter = async request => {
      requests.push(request.url ?? '');
      if (request.url?.startsWith('/mobile/vpn/config')) throw httpError(request, 403, { code: 'CONFIG_REVOKED', scope: 'subscription', temporary: false, subscriptionId: 'a' });
      return { status: 200, statusText: 'OK', config: request, headers: {}, data: request.url === '/mobile/access-state' ? s : remoteConnections(s) };
    };
    await h.sync.refreshMobileConfigs();
    assert.equal((await h.store.get('a')).status, 'missing');
    assert.equal((await h.store.get('b')).status, 'ok');
    assert.equal(requests.includes('/mobile/vpn/config'), false);
  });

  it('provisions independent backend B after A is revoked even when both share a payload hash', async () => {
    const h = await harness();
    await setup(h, null);
    const existingA = (await h.store.get('a')).value;
    assert.ok(existingA);
    assert.equal((await h.store.save('a', existingA.config, { ...existingA.meta, configHash: 'shared-hash' })).status, 'ok');
    assert.equal((await h.store.remove('b')).status, 'ok');
    const s = snapshot('revoke-shared-a', 'active', 'revoked');
    for (const entry of s.subscriptions) entry.configHash = 'shared-hash';
    const remote = remoteConnections(s);
    remote.connections[1].dataToken = 'SXB-DATA-BBBB-CCCC-DDDD';
    const plaintext = { ...config, uuid: '00000000-0000-4000-8000-000000000001',
      configId: 'b', subscriptionId: 'b', deviceId: 'hardware' };
    const key = new Uint8Array(32).fill(7), iv = new Uint8Array(12).fill(3);
    const sealed = h.aes.encryptAes256Gcm(key, iv, Buffer.from(JSON.stringify(plaintext)));
    const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
    const provisioned: string[] = [];
    h.api.default.defaults.adapter = async request => {
      let data: unknown;
      if (request.url === '/mobile/access-state') data = s;
      else if (request.url === '/mobile/connections') data = remote;
      else if (request.url === '/provision/activate') {
        const body = JSON.parse(request.data);
        provisioned.push(body.dataToken);
        assert.equal(body.deviceId, 'hardware');
        data = { deviceId: 'hardware', subscriptionId: 'b', profileName: 'Profile B', protocol: 'vless',
          configHash: 'shared-hash', configVersion: 1, configKey: hex(key),
          encryptedBlob: `gcm:${hex(iv)}:${hex(sealed.ciphertext)}:${hex(sealed.authTag)}` };
      } else throw new Error('Unexpected request');
      return { status: 200, statusText: 'OK', config: request, headers: {}, data };
    };
    await h.sync.refreshMobileConfigs();
    equal(provisioned, ['SXB-DATA-BBBB-CCCC-DDDD']);
    assert.equal((await h.store.get('a')).status, 'missing');
    assert.equal((await h.store.get('b')).status, 'ok');
    assert.equal((await h.store.get('b')).value?.meta.subscriptionId, 'b');
    assert.equal(h.state.stopCount, 0);
    assert.equal(h.auth.getIdentitySession()?.user.id, user.id);
  });

  it('drains a legacy native service before first binding and keeps reconnect denial inside dispatch', () => {
    const nativeModule = readFileSync(path.join(mobile, 'modules/android-native/SxbVpnModule.kt'), 'utf8');
    const bind = nativeModule.slice(nativeModule.indexOf('fun bindAccessSession('), nativeModule.indexOf('fun getAccessControlState('));
    assert.match(bind, /SxbAccessPolicy\.bindingRequired\(previous, userId, deviceId\)/);
    assert.ok(bind.indexOf('service.stopForAccess()') < bind.indexOf('SxbAccessControl.bind('));
    const service = readFileSync(path.join(mobile, 'modules/android-native/SxbVpnService.kt'), 'utf8');
    const reconnect = service.slice(service.indexOf('onReconnect = {'), service.indexOf('onGiveUp = {'));
    assert.match(reconnect, /dispatchProtocol\(currentConfig,/);
    assert.doesNotMatch(reconnect, /SxbAccessControl\.checkStart/);
    const dispatch = service.slice(service.indexOf('private fun dispatchProtocol('), service.indexOf('activeDispatches++'));
    assert.match(dispatch, /try \{[\s\S]*SxbAccessControl\.checkStart[\s\S]*catch \(error: Exception\)[\s\S]*cleanup\(\)/);
  });

  it('coalesces concurrent refreshes and refuses an old /me response after logout', async () => {
    const h = await harness();
    await setup(h);
    let release: (() => void) | undefined;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    let count = 0;
    h.api.default.defaults.adapter = async request => {
      count++;
      if (request.url === '/mobile/me') { await waiting; return { status: 200, statusText: 'OK', config: request, headers: {}, data: { user, accountState } }; }
      return { status: 200, statusText: 'OK', config: request, headers: {}, data: request.url === '/mobile/access-state' ? snapshot('same') : remoteConnections(snapshot('same')) };
    };
    await Promise.all([h.sync.refreshMobileConfigs(), h.sync.refreshMobileConfigs()]);
    assert.equal(count, 2);
    const pending = h.auth.validateIdentitySession('hardware');
    while (count < 3) await new Promise(resolve => setTimeout(resolve, 1));
    await h.auth.clearIdentitySession();
    release!();
    await pending;
    assert.equal(h.auth.getIdentitySession(), null);
    assert.equal(h.state.storage.has('@sxb_user'), false);
  });

  it('performs no control/ticket/provisioning HTTP before Play VPN consent', async () => {
    const h = await harness('play');
    let requests = 0;
    h.api.default.defaults.adapter = async request => { requests++; throw new Error('Must not run'); };
    await assert.rejects(h.access.bindAccessState(user.id, 'hardware'), /privacy_consent_required/);
    await assert.rejects(h.sync.refreshAccessState(), /privacy_consent_required/);
    await assert.rejects(h.provision.provisionAndStore('test-data-token', 'hardware'), /privacy_consent_required/);
    await assert.rejects(h.api.default.post('/mobile/access-ticket'), /privacy_consent_required/);
    assert.equal(requests, 0);
    assert.equal(h.state.storage.size, 0);
  });

  it('honors Retry-After and validates the root blocked route and rendered French/English attribution', async () => {
    const h = await harness();
    assert.equal(h.policy.retryDelay(0, '120'), 120_000);
    assert.equal(h.policy.retryDelay(9, '999999'), 300_000);
    const disabled = snapshot('disabled', 'disabled').device;
    assert.equal(h.policy.accessRedirect(true, true, disabled, '(tabs)'), '/access-blocked');
    assert.equal(h.policy.accessRedirect(true, true, disabled, 'settings'), null);
    assert.equal(h.policy.accessRedirect(true, true, snapshot('active').device, 'access-blocked'), '/(tabs)/');
    for (const [language, text, author] of [
      ['fr', 'temporairement désactivé', 'Powered by AbakoDollar$'],
      ['en', 'temporarily disabled', 'Powered by AbakoDollar$'],
    ] as const) {
      const rendered = h.renderBlocked(language, 'disabled');
      assert.ok(rendered.includes(text));
      assert.ok(rendered.includes(author));
      assert.equal(rendered.includes('SXB-USER-'), false);
    }
    const read = (file: string) => readFileSync(path.join(mobile, file), 'utf8');
    assert.match(read('app/_layout.tsx'), /accessRedirect\(isAuthenticated, accessReady, deviceAccess/);
    for (const file of ['app/settings.tsx', 'app/activate.tsx']) assert.match(read(file), /t\(["']created_by["']\)/);
  });

  it('laisse atteindre l’essai gratuit, seule porte de ceux qui n’ont pas encore de compte', async () => {
    const h = await harness();
    const read = (file: string) => readFileSync(path.join(mobile, file), 'utf8');

    // Sans compte : l'écran d'activation propose « J'ai un jeton d'essai
    // gratuit ». Si `free-trial` n'est pas déclaré public, la navigation part
    // bien puis la garde renvoie aussitôt sur `/activate` — l'utilisateur
    // revient au même écran et la fonctionnalité est inatteignable pour la
    // totalité de son public.
    const publicSegments = read('app/_layout.tsx').match(/publicSegments = new Set\(\[([^\]]*)\]/);
    assert.ok(publicSegments, 'La liste des écrans publics doit rester lisible');
    for (const segment of ['activate', 'free-trial', 'privacy', 'onboarding']) {
      assert.ok(publicSegments[1].includes(`'${segment}'`), `${segment} doit rester atteignable sans compte`);
    }
    assert.match(read('app/activate.tsx'), /router\.push\('\/free-trial'/);

    // Avec un appareil bloqué : la demande d'essai ne donne aucun accès par
    // elle-même, donc l'écarter enfermerait un appareil révoqué sans recours.
    const blocked = snapshot('revoked', 'revoked').device;
    assert.equal(h.policy.accessRedirect(true, true, blocked, 'free-trial'), null);
    assert.equal(h.policy.accessRedirect(true, true, blocked, '(tabs)'), '/access-blocked');
  });
});

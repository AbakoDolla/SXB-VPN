import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
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
  ledger: typeof import('../services/usageLedger');
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
    beforeWrite?: (store: 'async' | 'secure', key: string, value: string | null) => Promise<void>;
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
      setItem:async(k,v)=>{await state.beforeWrite?.('async',k,v);state.events.push('write:'+k);state.storage.set(k,v)},
      multiSet:async entries=>{for(const [k,v] of entries){await state.beforeWrite?.('async',k,v);state.storage.set(k,v)}},
      removeItem:async k=>{await state.beforeWrite?.('async',k,null);if(state.failRemove===k)throw Error('IO unavailable');state.events.push('remove:'+k);state.storage.delete(k)},
      multiRemove:async keys=>{for(const k of keys){await state.beforeWrite?.('async',k,null);if(state.failRemove===k)throw Error('IO unavailable');state.events.push('remove:'+k);state.storage.delete(k)}},
      getAllKeys:async()=>[...state.storage.keys()],
    };`,
    'expo-secure-store': `import {state} from 'test:state';
      export const getItemAsync=async k=>state.secure.get(k)??null;
      export const setItemAsync=async(k,v)=>{await state.beforeWrite?.('secure',k,v);state.events.push('secure:'+k);state.secure.set(k,v)};
      export const deleteItemAsync=async k=>{await state.beforeWrite?.('secure',k,null);state.events.push('secure-delete:'+k);state.secure.delete(k)};`,
    'expo-crypto': `import {randomFillSync,randomUUID as uuid,createHash} from 'node:crypto';
      export const getRandomValues=x=>randomFillSync(x);
      export const randomUUID=()=>uuid();
      export const CryptoDigestAlgorithm={SHA256:'sha256'};
      export const digestStringAsync=async(algorithm,value)=>createHash(algorithm).update(value).digest('hex');`,
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
        export * as ledger from './services/usageLedger';
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
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

// Software cipher fixture: exercises the bridge/storage contract, not Android Keystore.
function installConfigVault(h: Harness) {
  const key = randomBytes(32);
  const encrypt = async (value: string) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `v1:${Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64')}`;
  };
  h.state.native.encryptVpnConfig = encrypt;
  h.state.native.decryptVpnConfig = async (value: string) => {
    const blob = Buffer.from(value.slice(3), 'base64');
    const cipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
    cipher.setAuthTag(blob.subarray(-16));
    return Buffer.concat([cipher.update(blob.subarray(12, -16)), cipher.final()]).toString('utf8');
  };
  return encrypt;
}

describe('native configuration vault and lossless migration', () => {
  it('opens a current relay cache without waiting for catalogue synchronization', async () => {
    const h = await harness();
    const { cleanup } = await setup(h, null);
    try {
      h.state.storage.set('@sxb_session_security_v1', JSON.stringify({
        version: 1, sessionId: 'current-session', generation: 2, keyId: 'key', clientId: 'client',
      }));
      const relay = { protocol: 'ssh', host: 'sxb-gateway', port: 443, username: 'sxb',
        sshRelay: { version: 1, ticket: 'aaa.bbb.ccc', expiresAt: new Date(Date.now() + 3600000).toISOString() } };
      await h.store.save('a', relay, { source: 'backend', subscriptionId: 'a', configHash: 'hash-a',
        sshRelayRequired: true, relaySession: await h.provision.currentRelaySession() });
      let requests = 0;
      h.api.default.defaults.adapter = async request => {
        requests++;
        throw new AxiosError('timeout of 15000ms exceeded', 'ECONNABORTED', request);
      };
      equal(await h.sync.prepareSshConnection('a', (await h.store.get('a')).value!), relay);
      assert.equal(requests, 0, 'an already valid relay must not depend on the catalogue HTTP endpoint');
      await apply(h, snapshot('spent', 'active', 'exhausted'));
      await assert.rejects(h.sync.prepareSshConnection('a', (await h.store.get('a')).value!),
        (error: unknown) => h.policy.accessIssueFromError(error)?.code === 'CONFIG_EXHAUSTED');
      assert.equal(requests, 0, 'a known access refusal must not start another catalogue request');
    } finally { cleanup(); }
  });

  it('does not let an Android request that ignores abort block a fresh access snapshot', async () => {
    const h = await harness();
    const { cleanup } = await setup(h, null);
    const started = deferred(), release = deferred();
    let first: Promise<boolean> | undefined, second: Promise<boolean> | undefined;
    let requests = 0;
    try {
      h.api.default.defaults.adapter = async request => {
        const number = ++requests;
        if (number === 1) { started.resolve(); await release.promise; }
        return { status: 200, statusText: 'OK', headers: {}, config: request,
          data: snapshot(number === 1 ? 'old' : 'fresh') };
      };
      first = h.sync.refreshAccessState(true);
      void first.catch(() => {});
      await started.promise;
      second = h.sync.refreshAccessState(false);
      void second.catch(() => {});
      await nextTurn();
      assert.equal(requests, 2, 'replacement request starts even if the cancelled adapter has not settled');
      await second;
      assert.equal(h.access.getAccessState().authority?.snapshot?.revision, 'fresh');
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
      cleanup();
    }
    assert.equal(h.access.getAccessState().authority?.snapshot?.revision, 'fresh');
  });

  for (const previous of ['direct', 'older-session', 'changed-profile'] as const) {
    it(`upgrades ${previous} SSH cache to the current session without exposing provider credentials`, async () => {
      const h = await harness();
      const { cleanup } = await setup(h, null);
      try {
        h.state.native.sshRelayVersion = 1;
        h.state.storage.set('@sxb_session_security_v1', JSON.stringify({
          version: 1, sessionId: 'new-session', generation: 2, keyId: 'key', clientId: 'client',
        }));
        const relay = { protocol: 'ssh', host: 'sxb-gateway', port: 443, username: 'sxb',
          sshRelay: { version: 1, ticket: 'aaa.bbb.ccc', expiresAt: new Date(Date.now() + 3600000).toISOString() } };
        const oldConfig = previous === 'direct'
          ? { protocol: 'ssh', host: 'provider.invalid', port: 80, username: 'synthetic', password: 'fixture-only' } : relay;
        await h.store.save('a', oldConfig, { source: 'backend', subscriptionId: 'a',
          configHash: previous === 'changed-profile' ? 'older-hash' : 'hash-a',
          relaySession: previous === 'changed-profile' ? await h.provision.currentRelaySession() : 'old-session' });
        const key = new Uint8Array(32).fill(7), iv = new Uint8Array(12).fill(3);
        const sealed = h.aes.encryptAes256Gcm(key, iv, Buffer.from(JSON.stringify(relay)));
        const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
        let requests = 0;
        h.api.default.defaults.adapter = async request => {
          let data: unknown;
          if (request.url === '/mobile/access-state') data = snapshot('ssh-rollout');
          else if (request.url === '/mobile/connections') {
            const remote = remoteConnections(snapshot('ssh-rollout'));
            data = { connections: remote.connections.map(entry => entry.id === 'a'
              ? { ...entry, dataToken: 'synthetic-token', sshRelayAvailable: true, technicalProtocol: 'ssh' } : entry) };
          } else if (request.url === '/provision/activate') {
            requests++;
            assert.equal(request.headers['X-SXB-SSH-Relay'], '1');
            assert.equal(JSON.parse(request.data).deviceId, 'hardware');
            data = { deviceId: 'hardware', subscriptionId: 'a', profileName: 'Profile A', protocol: 'ssh',
              configHash: 'hash-a', configVersion: 1, configKey: hex(key),
              encryptedBlob: `gcm:${hex(iv)}:${hex(sealed.ciphertext)}:${hex(sealed.authTag)}` };
          } else throw new Error('Unexpected request');
          return { status: 200, statusText: 'OK', config: request, headers: {}, data };
        };
        const result = await h.sync.prepareSshConnection('a', (await h.store.get('a')).value!);
        equal(result, relay);
        assert.equal(result.password, undefined);
        assert.equal(requests, 1);
        assert.equal((await h.store.get('a')).value?.meta.relaySession, await h.provision.currentRelaySession());
        await h.sync.prepareSshConnection('a', (await h.store.get('a')).value!);
        assert.equal(requests, 1, 'a current relay credential does not reprovision on every connect');
      } finally { cleanup(); }
    });
  }

  it('shows an existing SSH cache migration refusal and never dials its old direct credentials', async () => {
    const h = await harness();
    const { cleanup } = await setup(h, null);
    try {
      const direct = { protocol: 'ssh', host: 'provider.invalid', port: 80, username: 'synthetic', password: 'fixture-only' };
      await h.store.save('a', direct, { source: 'backend', subscriptionId: 'a', configHash: 'hash-a' });
      h.api.default.defaults.adapter = async request => {
        let data: unknown;
        if (request.url === '/mobile/access-state') data = snapshot('ssh-rollout');
        else if (request.url === '/mobile/connections') {
          const remote = remoteConnections(snapshot('ssh-rollout'));
          data = { connections: remote.connections.map(entry => entry.id === 'a'
            ? { ...entry, dataToken: 'synthetic-token', sshRelayAvailable: true } : entry) };
        } else throw httpError(request, 409, { code: 'RELAY_BOUND_SESSION_REQUIRED' });
        return { status: 200, statusText: 'OK', config: request, headers: {}, data };
      };
      await assert.rejects(h.sync.prepareSshConnection('a', (await h.store.get('a')).value!),
        (error: unknown) => error instanceof h.provision.ProvisioningError && error.diagnostic.code === 'RELAY_BOUND_SESSION_REQUIRED');
      assert.equal(h.sync.getImportNotes().get('a')?.code, 'RELAY_BOUND_SESSION_REQUIRED');
      equal((await h.store.get('a')).value?.config, direct);
      assert.equal((await h.store.get('a')).value?.meta.sshRelayRequired, true);
      h.api.default.defaults.adapter = async () => { throw new Error('offline'); };
      await assert.rejects(h.sync.prepareSshConnection('a', (await h.store.get('a')).value!), /offline/);
    } finally { cleanup(); }
  });

  it('keeps the offline path of an unprotected managed SSH profile without ignoring HTTP denial', async () => {
    const h = await harness();
    const { cleanup } = await setup(h, null);
    try {
      const direct = { protocol: 'ssh', host: 'provider.invalid', port: 80, username: 'synthetic', password: 'fixture-only' };
      await h.store.save('a', direct, { source: 'backend', subscriptionId: 'a', configHash: 'hash-a' });
      h.api.default.defaults.adapter = async () => { throw new Error('offline'); };
      equal(await h.sync.prepareSshConnection('a', (await h.store.get('a')).value!), direct);
      h.api.default.defaults.adapter = async request => { throw httpError(request, 403, { code: 'CONFIG_EXHAUSTED' }); };
      await assert.rejects(h.sync.prepareSshConnection('a', (await h.store.get('a')).value!));
    } finally { cleanup(); }
  });

  it('renews only the relay ticket and cannot resurrect or overwrite a replaced profile', async () => {
    const h = await harness();
    installConfigVault(h);
    const { cleanup } = await setup(h);
    const relay = { protocol: 'ssh', host: 'sxb-gateway', port: 443, username: 'sxb',
      sshRelay: { version: 1, ticket: 'aaa.bbb.ccc', expiresAt: new Date(Date.now() + 60000).toISOString() } };
    try {
      assert.equal((await h.store.save('a', relay, { subscriptionId: 'a', configHash: 'hash-a' })).status, 'ok');
      const requests: string[] = [];
      const credential = { ticket: 'ddd.eee.fff', expiresAt: new Date(Date.now() + 3600000).toISOString() };
      h.api.default.defaults.adapter = async request => {
        requests.push(request.url!);
        assert.equal(JSON.parse(request.data).ticket, relay.sshRelay.ticket);
        return { data: credential, status: 200, statusText: 'OK', headers: {}, config: request };
      };
      const updated = await h.provision.refreshRelayCredential('a', relay);
      equal(updated.sshRelay, { version: 1, ...credential });
      equal(requests, ['/provision/ssh-relay/refresh']);
      await h.provision.refreshRelayCredential('a', updated);
      assert.equal(requests.length, 1);
      await assert.rejects(h.store.replaceRelayCredential('a', relay.sshRelay.ticket, credential), /CHANGED/);
      await h.store.remove('a');
      await assert.rejects(h.store.replaceRelayCredential('a', credential.ticket, credential), /CHANGED/);
      assert.equal((await h.store.get('a')).status, 'missing');
    } finally { cleanup(); }
  });

  for (const failure of ['network', 'expired', 'denied', 'deleted'] as const) {
    it(`handles ${failure} during relay renewal without extending or restoring credentials`, async () => {
      const h = await harness();
      const { cleanup } = await setup(h, null);
      try {
        const relay = { protocol: 'ssh', host: 'sxb-gateway', port: 443, username: 'sxb',
          sshRelay: { version: 1, ticket: 'aaa.bbb.ccc',
            expiresAt: new Date(Date.now() + (failure === 'expired' ? -1000 : 120000)).toISOString() } };
        await h.store.save('a', relay, { source: 'backend', subscriptionId: 'a', configHash: 'hash-a' });
        h.api.default.defaults.adapter = async request => {
          assert.equal(request.url, '/provision/ssh-relay/refresh');
          if (failure === 'deleted') await h.store.remove('a');
          if (failure === 'denied') throw httpError(request, 403, { code: 'RELAY_TICKET_INVALID' });
          throw new AxiosError('timeout of 15000ms exceeded', 'ECONNABORTED', request);
        };
        if (failure === 'network') {
          equal(await h.provision.refreshRelayCredential('a', relay), relay);
          assert.ok(JSON.stringify(h.state.logs).includes('PVN_TIMEOUT'));
          assert.equal(JSON.stringify(h.state.logs).includes(relay.sshRelay.ticket), false);
        } else if (failure === 'deleted') {
          await assert.rejects(h.provision.refreshRelayCredential('a', relay), /RELAY_CREDENTIAL_CHANGED/);
        } else {
          await assert.rejects(h.provision.refreshRelayCredential('a', relay), (error: unknown) => {
            return error instanceof h.provision.ProvisioningError &&
              error.diagnostic.code === (failure === 'expired' ? 'PVN_TIMEOUT' : 'PVN_HTTP_403');
          });
        }
        const stored = await h.store.get('a');
        if (failure === 'deleted') assert.equal(stored.status, 'missing');
        else equal(stored.value?.config, relay);
      } finally { cleanup(); }
    });
  }

  it('preserves safe network diagnostics before the SSH engine starts', async () => {
    const h = await harness();
    assert.equal(h.provision.toProvisioningError(new AxiosError('private endpoint', 'ECONNABORTED'), 1).diagnostic.code, 'PVN_TIMEOUT');
    assert.equal(h.provision.toProvisioningError(new AxiosError('private endpoint', 'ERR_NETWORK'), 1).diagnostic.code, 'PVN_NETWORK');
    const source = readFileSync(path.join(mobile, 'contexts', 'VpnContext.tsx'), 'utf8');
    assert.match(source, /isAxiosError\(err\) \? toProvisioningError\(err, 1\)\.diagnostic\.code/);
    assert.match(source, /code === 'PVN_TIMEOUT' \? 'log_timeout'/);
    assert.match(source, /code === 'PVN_NETWORK' \? 'network_error'/);
  });

  it('keeps the Android handoff encrypted, atomic, attempt-specific and free of raw Intent credentials', () => {
    const native = (name: string) => readFileSync(path.join(mobile, 'modules', 'android-native', name), 'utf8');
    const module = native('SxbVpnModule.kt');
    const service = native('SxbVpnService.kt');
    const keystore = native('KeystoreManager.kt');
    assert.ok(module.includes('KeystoreManager.writeEncrypted(configFile, guardedOptions)'));
    assert.ok(module.includes('sxb_pending_${java.util.UUID.randomUUID()}.enc'));
    assert.doesNotMatch(module, /putExtra\("configJson"/);
    assert.ok(service.includes('file.parentFile == filesDir.canonicalFile'));
    assert.ok(service.includes('KeystoreManager.decrypt(KeystoreManager.readEncoded(credsFile))'));
    assert.doesNotMatch(service, /fallback plaintext/);
    assert.match(keystore, /@Synchronized\s+fun writeEncrypted/);
    assert.ok(keystore.includes('atomic.startWrite()') && keystore.includes('atomic.failWrite(stream)'));
    assert.ok(keystore.includes('check(readEncoded(file) == encrypted.toString(Charsets.UTF_8))'));
    const decrypt = keystore.slice(keystore.indexOf('fun decrypt('), keystore.indexOf('fun writeEncrypted('));
    assert.ok(decrypt.includes('getKey(createIfMissing = false)'));
    assert.ok(native('SxbAccessControl.kt').includes('KeystoreManager.deleteIfUnchanged(vault, encoded)'));
  });

  it('uses native operations without creating an exportable JS key', async () => {
    const h = await harness();
    installConfigVault(h);
    const { cleanup } = await setup(h);
    try {
      const sealed = h.state.storage.get('sxb_cfg_payload_a')!;
      assert.match(sealed, /^v1:/);
      assert.equal(sealed.includes(config.host), false);
      assert.equal(h.state.secure.has('sxb_cfg_master_key_v1'), false);
      equal((await h.store.get('a')).value?.config, { ...config, configId: 'a' });
    } finally { cleanup(); }
  });

  it('migrates legacy GCM only after successful encryption and leaves metadata unchanged', async () => {
    const h = await harness();
    const { cleanup } = await setup(h);
    try {
      const previous = h.state.storage.get('sxb_cfg_payload_a');
      const registry = h.state.storage.get('sxb_cfg_registry_v1');
      assert.match(previous!, /^gcm:/);
      const encrypt = installConfigVault(h);
      h.state.native.encryptVpnConfig = async () => { throw new Error('SYNTHETIC_KEYSTORE_UNAVAILABLE'); };
      assert.equal((await h.store.get('a')).status, 'error');
      assert.equal(h.state.storage.get('sxb_cfg_payload_a'), previous);
      h.state.native.encryptVpnConfig = encrypt;
      equal((await h.store.get('a')).value?.config, { ...config, configId: 'a' });
      assert.match(h.state.storage.get('sxb_cfg_payload_a')!, /^v1:/);
      assert.equal(h.state.storage.get('sxb_cfg_registry_v1'), registry);
    } finally { cleanup(); }
  });

  it('reports corrupted or unavailable native storage without falling back to legacy decryption', async () => {
    const h = await harness();
    installConfigVault(h);
    const { cleanup } = await setup(h);
    try {
      const before = h.state.storage.get('sxb_cfg_payload_a')!;
      const damaged = Buffer.from(before.slice(3), 'base64');
      damaged[damaged.length - 1] ^= 1;
      h.state.storage.set('sxb_cfg_payload_a', `v1:${damaged.toString('base64')}`);
      assert.equal((await h.store.get('a')).status, 'error');
      h.state.storage.set('sxb_cfg_payload_a', before);
      delete h.state.native.decryptVpnConfig;
      assert.equal((await h.store.get('a')).status, 'error');
      assert.equal(h.state.secure.has('sxb_cfg_master_key_v1'), false);
      assert.equal(h.state.storage.get('sxb_cfg_payload_a'), before);
    } finally { cleanup(); }
  });

  it('retains the only legacy copy when saving its migration fails', async () => {
    const h = await harness();
    const { cleanup } = await setup(h);
    try {
      h.state.storage.delete('sxb_cfg_registry_v1');
      const legacy = JSON.stringify({ config, configId: 'a' });
      h.state.storage.set('sxb_offline_vpn_config_v2', legacy);
      const encrypt = installConfigVault(h);
      h.state.native.encryptVpnConfig = async () => { throw new Error('SYNTHETIC_KEYSTORE_UNAVAILABLE'); };
      assert.equal((await h.store.migrateLegacy()).status, 'error');
      assert.equal(h.state.storage.get('sxb_offline_vpn_config_v2'), legacy);
      assert.equal(h.state.storage.has('sxb_cfg_registry_v1'), false);
      h.state.native.encryptVpnConfig = encrypt;
      assert.equal((await h.store.migrateLegacy()).status, 'ok');
      assert.equal(h.state.storage.has('sxb_offline_vpn_config_v2'), false);
      equal((await h.store.get('a')).value?.config, config);
    } finally { cleanup(); }
  });

  for (const action of ['remove', 'update'] as const) {
    it(`does not resurrect or overwrite a profile during concurrent ${action}`, async () => {
      const h = await harness();
      const { cleanup } = await setup(h);
      const entered = deferred(), release = deferred();
      try {
        const encrypt = installConfigVault(h);
        h.state.native.encryptVpnConfig = async (value: string) => {
          entered.resolve();
          await release.promise;
          return encrypt(value);
        };
        const reading = h.store.get('a');
        await entered.promise;
        const change = action === 'remove' ? h.store.remove('a') : h.store.save('a', { ...config, port: 8443 });
        release.resolve();
        await Promise.all([reading, change]);
        if (action === 'remove') {
          assert.equal(h.state.storage.has('sxb_cfg_payload_a'), false);
          assert.equal((await h.store.get('a')).status, 'missing');
        } else {
          assert.equal((await h.store.get('a')).value?.config.port, 8443);
        }
      } finally { release.resolve(); cleanup(); }
    });
  }
});

const securityFor = (owner: string, generation = 1) => ({
  version: 1, sessionId: `synthetic-authority-${owner}`, generation,
  clientId: `synthetic-client-${owner}`, keyId: 'a'.repeat(64),
});
const activated = (owner: string) => ({
  accessToken: `synthetic-${owner}-access`, refreshToken: `synthetic-${owner}-refresh`,
  user: { id: owner, name: `Synthetic ${owner}`, email: '' }, accountState, security: securityFor(owner),
});
function assertStoredIdentity(h: Harness, owner: string | null) {
  assert.equal(h.state.secure.get('sxb_access_token_v2'), owner ? activated(owner).accessToken : undefined);
  assert.equal(h.state.secure.get('sxb_refresh_token_v2'), owner ? activated(owner).refreshToken : undefined);
  assert.equal(h.state.storage.get('@sxb_user'), owner ? JSON.stringify({ user: activated(owner).user, accountState }) : undefined);
  assert.equal(h.state.storage.get('@sxb_session_security_v1'), owner ? JSON.stringify(securityFor(owner)) : undefined);
  assert.equal(h.auth.getIdentitySession()?.user.id ?? null, owner);
  assert.equal(h.access.getAccessState().authority?.userId ?? null, owner);
  assert.equal(h.state.storage.get('@sxb_device_proof_enrolled'), '1');
}

describe('identity persistence with controlled storage promises (synthetic native IO only)', () => {
  for (const stage of ['metadata', 'access-token', 'parallel-failure', 'invalid-cleanup'] as const) {
    for (const successor of ['B', null]) {
      it(`drains A ${stage} before ${successor ?? 'clear'} and never retries queued A as another owner`, { timeout: 10_000 }, async () => {
        const h = await harness();
        h.state.storage.set('@sxb_device_id', 'hardware');
        h.state.native.signBackendRequest = async () => '{}';
        await h.auth.acceptActivatedIdentity(activated('A'), 'hardware');
        const blocked = deferred(), release = deferred(), refreshStarted = deferred(), answerRefresh = deferred();
        let held = false;
        h.state.beforeWrite = async (store, key, value) => {
          if (stage === 'parallel-failure' && store === 'secure' && key === 'sxb_refresh_token_v2' && value === 'A-refreshed-refresh') {
            throw new Error('SYNTHETIC_STORAGE_FAILURE');
          }
          const target = stage === 'metadata'
            ? key === '@sxb_session_security_v1' && value === JSON.stringify(securityFor('A', 2))
            : store === 'secure' && key === 'sxb_access_token_v2' &&
              value === (stage === 'invalid-cleanup' ? null : 'A-refreshed-access');
          if (!held && target) {
            held = true;
            blocked.resolve();
            await release.promise;
          }
        };
        const previous = axios.defaults.adapter;
        const requests: string[] = [];
        let refreshes = 0;
        h.api.default.defaults.adapter = async request => {
          requests.push(`${request.url}:${request.headers.get('Authorization')}`);
          throw httpError(request, 401, { error: 'errors.auth.invalid_token' });
        };
        axios.defaults.adapter = async request => {
          refreshes++;
          refreshStarted.resolve();
          await answerRefresh.promise;
          if (stage === 'invalid-cleanup') {
            throw httpError(request, 401, { code: 'SESSION_INVALID', scope: 'session', temporary: false });
          }
          return { status: 200, statusText: 'OK', config: request, headers: {}, data: {
            accessToken: 'A-refreshed-access', refreshToken: 'A-refreshed-refresh', security: securityFor('A', 2),
          } };
        };
        try {
          const pending = Promise.allSettled([
            h.api.default.get('/mobile/me?request=A-first'), h.api.default.get('/mobile/me?request=A-queued'),
          ]);
          await refreshStarted.promise;
          await nextTurn();
          assert.equal(requests.length, 2);
          answerRefresh.resolve();
          await blocked.promise;
          const oldStamp = h.events.accessRequestStamp();
          let successorStored = false;
          const changing = (successor ? h.auth.acceptActivatedIdentity(activated(successor), 'hardware') : h.auth.clearIdentitySession())
            .then(() => { successorStored = true; });
          assert.equal(h.events.currentIdentityRequest(oldStamp), false);
          await nextTurn();
          assert.equal(successorStored, false, 'the new owner waits for every old write, including failed parallel groups');
          release.resolve();
          const outcomes = await pending;
          await changing;
          assert.ok(outcomes.every(result => result.status === 'rejected'));
          assert.equal(requests.length, 2, 'neither the original nor queued request was sent again');
          assert.ok(requests.every(request => request.endsWith(`Bearer ${activated('A').accessToken}`)));
          assert.equal(refreshes, 1);
          assertStoredIdentity(h, successor);
        } finally {
          release.resolve();
          answerRefresh.resolve();
          axios.defaults.adapter = previous;
        }
      });
    }
  }

  it('keeps the original stamp even when identity changes inside the replay interceptor', { timeout: 10_000 }, async () => {
    const h = await harness();
    h.state.storage.set('@sxb_device_id', 'hardware');
    h.state.native.signBackendRequest = async () => '{}';
    await h.auth.acceptActivatedIdentity(activated('A'), 'hardware');
    const previous = axios.defaults.adapter;
    const started = deferred(), release = deferred();
    let changing: Promise<void> | undefined;
    const sent: string[] = [];
    h.api.default.interceptors.request.use(async config => {
      if ((config as InternalAxiosRequestConfig & { _retry?: boolean })._retry) {
        changing ??= h.auth.acceptActivatedIdentity(activated('B'), 'hardware');
        await changing;
      }
      return config;
    });
    h.api.default.defaults.adapter = async config => {
      sent.push(String(config.headers.get('Authorization')));
      if (config.headers.get('Authorization') === `Bearer ${activated('A').accessToken}`) {
        throw httpError(config, 401, { error: 'errors.auth.invalid_token' });
      }
      return { status: 200, statusText: 'OK', config, headers: {}, data: {} };
    };
    axios.defaults.adapter = async config => {
      started.resolve();
      await release.promise;
      return { status: 200, statusText: 'OK', config, headers: {}, data: {
        ...activated('A'), accessToken: 'A-refreshed-access', security: securityFor('A', 2),
      } };
    };
    try {
      const pending = Promise.allSettled([h.api.default.get('/mobile/me'), h.api.default.get('/mobile/me')]);
      await started.promise;
      await nextTurn();
      release.resolve();
      const outcomes = await pending;
      await changing;
      assert.ok(outcomes.every(result => result.status === 'rejected'));
      assert.equal(sent.length, 2);
      assertStoredIdentity(h, 'B');
    } finally { release.resolve(); axios.defaults.adapter = previous; }
  });

  it('preserves the exact signed body bytes through Axios transformations', async () => {
    const h = await harness();
    await h.auth.acceptActivatedIdentity(activated('A'), 'hardware');
    let signed = '';
    h.state.native.signBackendRequest = async (_method: string, _url: string, body: string) => {
      signed = body;
      return '{}';
    };
    const body = ' \n{"synthetic":"body"} \n';
    h.api.default.defaults.adapter = async config => {
      assert.equal(config.data, signed);
      assert.equal(config.data, body);
      return { status: 200, statusText: 'OK', config, headers: {}, data: {} };
    };
    await h.api.default.post('/mobile/me', body);
  });

  it('does not accept an old activation response or account-state response after a newer login', async () => {
    const h = await harness();
    await h.auth.acceptActivatedIdentity(activated('A'), 'hardware');
    const stamp = h.events.accessRequestStamp();
    await h.auth.acceptActivatedIdentity(activated('B'), 'hardware');
    await assert.rejects(h.auth.acceptActivatedIdentity(activated('A'), 'hardware', { stamp }), /AUTH_SESSION_CHANGED/);
    await assert.rejects(h.auth.updateIdentityAccountState({ ...h.auth.getIdentitySession()!.accountState!, state: 'expired' }, stamp), /AUTH_SESSION_CHANGED/);
    assertStoredIdentity(h, 'B');
  });

  for (const writer of ['activation', 'validation', 'account-state', 'legacy-restore'] as const) {
    it(`fences delayed ${writer} persistence against activation B`, { timeout: 10_000 }, async () => {
      const h = await harness();
      h.state.native.signBackendRequest = async () => '{}';
      await h.auth.acceptActivatedIdentity(activated('A'), 'hardware');
      const blocked = deferred(), release = deferred();
      let held = false;
      h.state.beforeWrite = async (store, key, value) => {
        if (!held && (writer === 'legacy-restore'
          ? store === 'secure' && key === 'sxb_access_token_v2' && value === 'A-legacy-access'
          : key === '@sxb_user')) {
          held = true;
          blocked.resolve();
          await release.promise;
        }
      };
      h.api.default.defaults.adapter = async config => ({
        status: 200, statusText: 'OK', config, headers: {}, data: activated('A'),
      });
      if (writer === 'legacy-restore') {
        h.state.secure.delete('sxb_access_token_v2');
        h.state.storage.set('@sxb_access_token', 'A-legacy-access');
        h.state.storage.set('@sxb_refresh_token', 'A-legacy-refresh');
      }
      const writing = writer === 'activation' ? h.auth.acceptActivatedIdentity(activated('A'), 'hardware')
        : writer === 'validation' ? h.auth.validateIdentitySession('hardware')
          : writer === 'legacy-restore' ? h.auth.restoreIdentitySession('hardware')
            : h.auth.updateIdentityAccountState(h.auth.getIdentitySession()!.accountState!, h.events.accessRequestStamp());
      const completed = Promise.allSettled([writing]);
      try {
        await blocked.promise;
        const changing = h.auth.acceptActivatedIdentity(activated('B'), 'hardware');
        release.resolve();
        await completed;
        await changing;
        assertStoredIdentity(h, 'B');
        assert.equal(h.state.storage.has('@sxb_access_token'), false);
        assert.equal(h.state.storage.has('@sxb_refresh_token'), false);
      } finally { release.resolve(); }
    });
  }

  it('clears only the acknowledged activation retry ID', async () => {
    const h = await harness();
    const key = '@sxb_security_activation_request';
    const pending = JSON.stringify({ accountHash: 'synthetic-account-hash', requestId: 'synthetic-request-B' });
    h.state.storage.set(key, pending);
    await h.auth.acceptActivatedIdentity(activated('A'), 'hardware', {
      stamp: h.events.accessRequestStamp(), activationRequestId: 'synthetic-request-A',
    });
    assert.equal(h.state.storage.get(key), pending);
    await h.auth.acceptActivatedIdentity(activated('B'), 'hardware', {
      stamp: h.events.accessRequestStamp(), activationRequestId: 'synthetic-request-B',
    });
    assert.equal(h.state.storage.has(key), false);
  });

  for (const stage of ['quota', 'payload', 'legacy'] as const) {
    it(`drains nested ${stage} cleanup after a sibling failure before B can reuse a manual ID`, { timeout: 10_000 }, async () => {
      const h = await harness();
      await h.auth.acceptActivatedIdentity(activated('A'), 'hardware');
      for (const id of ['shared', 'failed']) {
        assert.equal((await h.store.save(id, config, { source: 'manual' })).status, 'ok');
      }
      await h.offline.saveQuotaData({ configId: 'shared', totalQuota: 100, usedQuota: 10, expiryDate: null });
      const blocked = deferred(), release = deferred();
      let held = false, failed = false;
      h.state.beforeWrite = async (store, key, value) => {
        if (value !== null) return;
        const delayedKey = stage === 'quota' ? 'sxb_quota_shared'
          : stage === 'payload' ? 'sxb_cfg_payload_shared' : 'sxb_prov_config_v2';
        const failureKey = stage === 'quota' ? 'sxb_offline_quota_v2'
          : stage === 'payload' ? 'sxb_cfg_payload_failed' : 'sxb_prov_meta_v2';
        if (!failed && store === 'async' && key === failureKey) {
          failed = true;
          throw new Error('SYNTHETIC_CLEAR_FAILURE');
        }
        if (!held && key === delayedKey && store === (stage === 'legacy' ? 'secure' : 'async')) {
          held = true;
          blocked.resolve();
          await release.promise;
        }
      };
      let clearSettled = false, replacementStored = false;
      const cleared = assert.rejects(h.auth.clearIdentitySession(), /SYNTHETIC_CLEAR_FAILURE/)
        .then(() => { clearSettled = true; });
      try {
        await blocked.promise;
        const replacement = (async () => {
          await h.auth.acceptActivatedIdentity(activated('B'), 'hardware');
          assert.equal((await h.store.save('shared', { ...config, host: 'vpn-b.example.test' }, { source: 'manual' })).status, 'ok');
          await h.offline.saveQuotaData({ configId: 'shared', totalQuota: 100, usedQuota: 20, expiryDate: null });
          replacementStored = true;
        })();
        await nextTurn();
        assert.equal(failed, true);
        assert.equal(clearSettled, false, 'nested cleanup must drain before rejecting');
        assert.equal(replacementStored, false);
        release.resolve();
        await cleared;
        await replacement;
        assertStoredIdentity(h, 'B');
        assert.equal((await h.offline.loadQuotaData('shared'))?.usedQuota, 20);
        assert.equal((await h.store.get('shared')).value?.config.host, 'vpn-b.example.test');
      } finally { release.resolve(); }
    });
  }
});

describe('mobile access runtime with real encrypted store, auth and HTTP interceptors', () => {
  it('accepts keyed and historical config fingerprints as opaque cache identities', async () => {
    const h = await harness();
    const state = snapshot('fingerprint-formats');
    state.subscriptions[0].configHash = `hmac-sha256-v1:${'a'.repeat(64)}`;
    state.subscriptions[1].configHash = 'b'.repeat(64);
    const parsed = h.policy.parseAccessSnapshot(state);
    assert.equal(parsed.subscriptions[0].configHash, state.subscriptions[0].configHash);
    assert.equal(parsed.subscriptions[1].configHash, state.subscriptions[1].configHash);
  });

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
    assert.throws(() => h.access.requireProfileAccess({ configId: 'a' }), /CONFIG_EXPIRED/);
    assert.throws(() => h.access.requireProfileAccess({ configId: 'b' }), /CONFIG_EXHAUSTED/);
    assert.equal(h.state.stopCount, 1);
    await apply(h, snapshot('topped-up'));
    assert.doesNotThrow(() => h.access.requireProfileAccess({ configId: 'a' }));
    assert.doesNotThrow(() => h.access.requireProfileAccess({ configId: 'b' }));
    assert.ok(h.access.getAccessState().notices.some(item => item.kind === 'config_restored'));
    assert.equal((await h.store.get('a')).value?.meta.accessStatus, 'active');
  });

  it('an exhausted inactive plan does not stop another plan using the same SSH provider', async () => {
    const h = await harness();
    const { cleanup } = await setup(h);
    try {
      await h.store.save('a', config, { source: 'backend', subscriptionId: 'a', configHash: 'shared' });
      await h.store.save('b', config, { source: 'backend', subscriptionId: 'b', configHash: 'shared' });
      const next = snapshot('quota-b', 'active', 'active', 'exhausted');
      next.subscriptions.forEach(entry => { entry.configHash = 'shared'; });
      await apply(h, next);
      assert.equal(h.state.stopCount, 0);
      assert.doesNotThrow(() => h.access.requireProfileAccess({ configId: 'a', subscriptionId: 'a', configHash: 'shared' }));
      assert.throws(() => h.access.requireProfileAccess({ configId: 'b', subscriptionId: 'b' }), /CONFIG_EXHAUSTED/);
      const restored = h.access.parseAuthority(JSON.parse(JSON.stringify(h.access.getAccessState().authority)));
      assert.equal(h.policy.profileRestriction(restored, { configId: 'b' })?.status, 'exhausted');
    } finally { cleanup(); }
  });

  it('an extension replaces the stale "expired" notice with a single "available again" one', async () => {
    // Constaté dans un navigateur : après une prolongation, « la durée est
    // écoulée » restait affiché à côté de « de nouveau disponible » ET de
    // « a été prolongée » — trois bandeaux contradictoires pour un geste.
    const h = await harness();
    await setup(h);
    await h.access.dismissAccessNotices();
    await apply(h, snapshot('elapsed', 'active', 'expired', 'exhausted'));
    equal(h.access.getAccessState().notices.map(item => item.kind), ['config_expired', 'config_exhausted']);
    const extended = snapshot('extended', 'active', 'active', 'exhausted');
    extended.subscriptions[0].expireAt = '2027-06-01T00:00:00.000Z';
    await apply(h, extended);
    const notices = h.access.getAccessState().notices;
    equal(notices.map(item => [item.name, item.kind]), [['Profile B', 'config_exhausted'], ['Profile A', 'config_restored']]);
    // Une prolongation d'un profil resté actif reste annoncée comme telle.
    const again = snapshot('extended-again', 'active', 'active', 'exhausted');
    again.subscriptions[0].expireAt = '2028-06-01T00:00:00.000Z';
    await apply(h, again);
    equal(h.access.getAccessState().notices.map(item => [item.name, item.kind]),
      [['Profile B', 'config_exhausted'], ['Profile A', 'config_extended']]);
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

  it('prepares a cached native ticket without waiting for a cancelled access poll', async () => {
    const h = await harness();
    await setup(h);
    const native: NativeAccessRuntime = {
      authority: h.access.getAccessState().authority, observing: false, activeProfile: null,
      ticketStatus: 'ready', ticketExpiresAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
    };
    let applied = 0;
    Object.assign(h.state.native, {
      bindAccessSession: async () => JSON.stringify(native),
      getAccessControlState: async () => JSON.stringify(native),
      applyAccessSnapshot: async () => { applied++; return JSON.stringify(native); },
    });
    let entered!: (request: InternalAxiosRequestConfig) => void;
    const received = new Promise<InternalAxiosRequestConfig>(resolve => { entered = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let requests = 0;
    h.api.default.defaults.adapter = async request => {
      requests++;
      entered(request);
      await blocked;
      return { config: request, status: 200, statusText: 'OK', headers: {},
        data: snapshot('cancelled-response', 'suspended') };
    };
    const pending = h.sync.refreshAccessState(true).catch(() => false);
    const request = await received;
    const revision = h.access.getAccessState().authority?.snapshot?.revision;
    const preparing = h.sync.prepareNativeAccess();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = await Promise.race([
        preparing.then(() => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 250); }),
      ]);
      assert.equal(ready, true, 'a cancelled 25-second poll must not delay native startup');
      assert.equal(request.signal?.aborted, true);
      assert.equal(requests, 1, 'a valid cached ticket requires no new network request');
      release();
      await pending;
      assert.equal(applied, 0, 'the cancelled poll must never apply its late response');
      assert.equal(h.access.getAccessState().authority?.snapshot?.revision, revision);
      h.access.requireDeviceAccess();
    } finally {
      if (timer) clearTimeout(timer);
      release();
      await Promise.allSettled([pending, preparing]);
    }
  });

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

  it('preserves config/device failures and clears invalid auth without deleting profiles', async () => {
    const h = await harness();
    await setup(h);
    const pending = { counterUp: 15, counterDown: 40, nextSeq: 2, initialized: true,
      context: { subscriptionId: 'a', configId: 'a', sessionId: 'sess-original' },
      entries: [{ subscriptionId: 'a', configId: 'a', sessionId: 'sess-original', seq: 1, up: 15, down: 40, frozen: true }] };
    await h.ledger.saveLedger(pending);
    const ledgerBefore = h.state.storage.get('@sxb_usage_ledger');
    const profileBefore = (await h.store.get('a')).value;
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
      assert.equal(h.state.secure.has('sxb_refresh_token_v2'), false);
      assert.equal(h.state.storage.get('@sxb_usage_ledger'), ledgerBefore);
      equal((await h.store.get('a')).value, JSON.parse(JSON.stringify(profileBefore)));
      assert.equal((await h.store.get('a')).status, 'ok');
      assert.equal((await h.store.get('b')).status, 'ok');
      assert.equal((await h.store.get('manual')).status, 'ok');
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

  it('garde au plus quatre configurations importées tout en conservant l’actif et les suppressions locales', async () => {
    const h = await harness();
    await setup(h);
    for (const id of ['c', 'd', 'e']) {
      assert.equal((await h.store.save(id, { ...config, configId: id }, {
        name: `Profile ${id}`, source: 'backend', subscriptionId: id,
        configHash: `hash-${id}`, configVersion: 1, isActive: false,
      })).status, 'ok');
    }

    const entries = (await h.store.list()).value ?? [];
    const backendIds = entries.filter(entry => entry.source === 'backend').map(entry => entry.configId);
    assert.equal(backendIds.length, 4);
    assert.equal(entries.some(entry => entry.configId === 'a' && entry.isActive), true);
    assert.equal(entries.some(entry => entry.configId === 'manual'), true);
    assert.equal(entries.some(entry => entry.configId === 'e'), true);
    assert.equal(h.state.storage.has('sxb_cfg_payload_b'), false);
    assert.equal(h.state.storage.has('sxb_quota_b'), false);
  });

  // ── Import automatique : aucun forfait attribué ne doit rester en attente ──
  //
  // Ce que le propriétaire exige : une configuration assignée depuis le tableau
  // de bord arrive d'elle-même sur le téléphone, jusqu'à quatre, et rien ne
  // déconnecte l'application. Chaque scénario ci-dessous reproduit un chemin
  // par lequel l'une de ces promesses était rompue.
  function provisionResponse(h: Harness, id: string) {
    const plaintext = { ...config, uuid: '00000000-0000-4000-8000-000000000001', configId: id, subscriptionId: id, deviceId: 'hardware' };
    const key = new Uint8Array(32).fill(7), iv = new Uint8Array(12).fill(3);
    const sealed = h.aes.encryptAes256Gcm(key, iv, Buffer.from(JSON.stringify(plaintext)));
    const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
    return { deviceId: 'hardware', subscriptionId: id, profileName: `Profile ${id}`, protocol: 'vless',
      configHash: `hash-${id}`, configVersion: 1, configKey: hex(key),
      encryptedBlob: `gcm:${hex(iv)}:${hex(sealed.ciphertext)}:${hex(sealed.authTag)}` };
  }
  function withSubscriptions(revision: string, entries: Array<[string, ProfileStatus]>): AccessSnapshot {
    return { ...snapshot(revision), subscriptions: entries.map(([id, status]) => ({
      id, name: `Profile ${id}`, status, quotaTotalBytes: 100, quotaUsedBytes: 5, expireAt: null, configVersion: 1, configHash: `hash-${id}`,
    })) };
  }
  function serve(h: Harness, s: AccessSnapshot, remote: ReturnType<typeof remoteConnections>, provision: (id: string) => unknown) {
    h.api.default.defaults.adapter = async request => {
      let data: unknown;
      if (request.url === '/mobile/access-state') data = s;
      else if (request.url === '/mobile/connections') data = remote;
      else if (request.url === '/provision/activate') {
        const token: string = JSON.parse(request.data).dataToken;
        data = provision(token.slice('SXB-DATA-'.length, 'SXB-DATA-'.length + 1).toLowerCase());
      } else throw new Error('Unexpected request');
      return { status: 200, statusText: 'OK', config: request, headers: {}, data };
    };
  }

  it('un refus de forfait (403 SESSION_INVALID d’un ancien serveur) ne déconnecte jamais l’application', async () => {
    const h = await harness();
    const { cleanup } = await setup(h);
    // Même câblage que `AuthContext` : un échec de portée « session » efface
    // l'identité, coupe le tunnel et purge TOUTES les configurations.
    const publiees: string[] = [];
    h.events.subscribeAccessFailures(({ issue }) => {
      publiees.push(`${issue.scope}:${issue.code}`);
      if (issue.scope === 'session') void h.auth.clearIdentitySession();
    });
    const s = withSubscriptions('bound-c', [['a', 'active'], ['b', 'active'], ['c', 'active']]);
    const remote = remoteConnections(s);
    remote.connections[2].dataToken = 'SXB-DATA-CCCC-CCCC-CCCC';
    let tentatives = 0;
    h.api.default.defaults.adapter = async request => {
      if (request.url === '/provision/activate') {
        tentatives++;
        throw httpError(request, 403, { code: 'SESSION_INVALID', scope: 'session', temporary: false, error: 'Cet abonnement est déjà lié à un autre appareil' });
      }
      return { status: 200, statusText: 'OK', config: request, headers: {}, data: request.url === '/mobile/access-state' ? s : remote };
    };
    await h.sync.refreshMobileConfigs();
    await new Promise(resolve => setTimeout(resolve, 20));
    cleanup();
    assert.equal(tentatives, 1, 'un refus 403 ne se rejoue pas en rafale');
    assert.equal(publiees.some(entry => entry.startsWith('session:')), false);
    assert.equal(h.auth.getIdentitySession()?.user.id, user.id);
    assert.equal((await h.store.get('a')).status, 'ok');
    assert.equal((await h.store.get('b')).status, 'ok');
    assert.equal(h.state.stopCount, 0);
    assert.equal(h.sync.getImportNotes().get('c')?.kind, 'failed');
    // La règle elle-même : seul un 401 porte une invalidation de session.
    const refus = httpError({ url: '/provision/activate', headers: {} } as InternalAxiosRequestConfig, 403,
      { code: 'SESSION_INVALID', scope: 'session', temporary: false });
    assert.equal(h.policy.accessIssueFromError(refus), null);
    assert.equal(h.policy.isInvalidSession(refus), false);
    const expiree = httpError({ url: '/mobile/me', headers: {} } as InternalAxiosRequestConfig, 401,
      { code: 'SESSION_INVALID', scope: 'session', temporary: false });
    assert.equal(h.policy.accessIssueFromError(expiree)?.scope, 'session');
    assert.equal(h.policy.isInvalidSession(expiree), true);
  });

  it('au plafond, une configuration expirée cède sa place à un forfait actif attribué', async () => {
    const h = await harness();
    const { cleanup } = await setup(h);
    for (const id of ['c', 'd']) {
      assert.equal((await h.store.save(id, { ...config, configId: id }, {
        name: `Profile ${id}`, source: 'backend', subscriptionId: id, configHash: `hash-${id}`, configVersion: 1, isActive: false,
      })).status, 'ok');
    }
    // a (active), b, c, d : quatre configurations importées, plafond atteint.
    const s = withSubscriptions('cap', [['a', 'active'], ['b', 'expired'], ['c', 'active'], ['d', 'active'], ['e', 'active']]);
    const remote = remoteConnections(s);
    remote.connections[4].dataToken = 'SXB-DATA-EEEE-EEEE-EEEE';
    const importes: string[] = [];
    serve(h, s, remote, id => { importes.push(id); return provisionResponse(h, id); });
    await h.sync.refreshMobileConfigs();
    cleanup();
    equal(importes, ['e']);
    assert.equal((await h.store.get('e')).status, 'ok');
    assert.equal((await h.store.get('b')).status, 'missing');
    for (const id of ['a', 'c', 'd', 'manual']) assert.equal((await h.store.get(id)).status, 'ok', id);
    assert.equal((await h.store.getActive()).value?.meta.configId, 'a');
    assert.equal(h.sync.getImportNotes().size, 0);
    assert.equal(h.state.stopCount, 0);
  });

  it('au plafond de quatre configurations UTILISABLES, le cinquième forfait attend sans rien évincer', async () => {
    const h = await harness();
    const { cleanup } = await setup(h);
    for (const id of ['c', 'd']) {
      assert.equal((await h.store.save(id, { ...config, configId: id }, {
        name: `Profile ${id}`, source: 'backend', subscriptionId: id, configHash: `hash-${id}`, configVersion: 1, isActive: false,
      })).status, 'ok');
    }
    const s = withSubscriptions('full', [['a', 'active'], ['b', 'active'], ['c', 'active'], ['d', 'active'], ['e', 'active']]);
    const remote = remoteConnections(s);
    remote.connections[4].dataToken = 'SXB-DATA-EEEE-EEEE-EEEE';
    const importes: string[] = [];
    serve(h, s, remote, id => { importes.push(id); return provisionResponse(h, id); });
    await h.sync.refreshMobileConfigs();
    cleanup();
    equal(importes, []);
    for (const id of ['a', 'b', 'c', 'd']) assert.equal((await h.store.get(id)).status, 'ok', id);
    assert.equal(h.sync.getImportNotes().get('e')?.kind, 'cap');
  });

  it('réimporte une configuration au payload illisible au lieu de bloquer tout le rafraîchissement', async () => {
    const h = await harness();
    const { cleanup } = await setup(h);
    // Le système a tué l'application entre deux écritures : le registre cite
    // encore « b », son payload a disparu.
    h.state.storage.delete('sxb_cfg_payload_b');
    assert.equal((await h.store.get('b')).status, 'error');
    const s = withSubscriptions('repair', [['a', 'active'], ['b', 'active']]);
    const remote = remoteConnections(s);
    remote.connections[1].dataToken = 'SXB-DATA-BBBB-BBBB-BBBB';
    serve(h, s, remote, id => provisionResponse(h, id));
    await h.sync.refreshMobileConfigs();
    cleanup();
    assert.equal((await h.store.get('b')).status, 'ok');
    assert.equal((await h.store.get('a')).status, 'ok');
  });

  it('importe de lui-même un forfait que l’instantané d’accès annonce, sans aucun geste', async () => {
    const h = await harness();
    const { cleanup } = await setup(h);
    const s = withSubscriptions('assigned-e', [['a', 'active'], ['b', 'active'], ['e', 'active']]);
    const remote = remoteConnections(s);
    remote.connections[2].dataToken = 'SXB-DATA-EEEE-EEEE-EEEE';
    serve(h, s, remote, id => provisionResponse(h, id));
    // L'instantané arrive (long-poll HTTP ou service natif) : personne ne
    // touche l'écran, personne n'appuie sur « Actualiser ».
    await apply(h, s);
    const limite = Date.now() + 3000;
    while ((await h.store.get('e')).status !== 'ok' && Date.now() < limite) await new Promise(resolve => setTimeout(resolve, 10));
    cleanup();
    assert.equal((await h.store.get('e')).status, 'ok');
    assert.ok(h.state.events.includes('ui:changed'));
  });

  it('remplace de lui-même une configuration dont le tableau de bord a changé le profil, sans couper le tunnel', async () => {
    const h = await harness();
    const { cleanup } = await setup(h);
    // Le propriétaire réattribue un autre profil au forfait « b », déjà sur
    // l'appareil : seule l'empreinte annoncée change.
    const s = withSubscriptions('reassigned-b', [['a', 'active'], ['b', 'active']]);
    s.subscriptions[1].configHash = 'hash-b2';
    const remote = remoteConnections(s);
    remote.connections[1].dataToken = 'SXB-DATA-BBBB-BBBB-BBBB';
    const importes: string[] = [];
    let empreinteRendue = 'hash-b2';
    serve(h, s, remote, id => { importes.push(id); return { ...provisionResponse(h, id), configHash: empreinteRendue }; });
    await apply(h, s);
    const attendre = async (fait: () => Promise<boolean>) => {
      const limite = Date.now() + 3000;
      while (!(await fait()) && Date.now() < limite) await new Promise(resolve => setTimeout(resolve, 10));
    };
    await attendre(async () => (await h.store.get('b')).value?.meta.configHash === 'hash-b2');
    assert.equal((await h.store.get('b')).value?.meta.configHash, 'hash-b2');
    equal(importes, ['b']);
    // Aucune coupure : le tunnel de « a » continue, « a » reste sélectionné.
    assert.equal(h.state.stopCount, 0);
    assert.equal((await h.store.getActive()).value?.meta.configId, 'a');
    assert.ok(h.state.events.includes('ui:changed'));

    // Un nouvel instantané identique ne relance rien : la version est à jour.
    await apply(h, { ...s, revision: 'reassigned-b-again' });
    await new Promise(resolve => setTimeout(resolve, 50));
    equal(importes, ['b']);

    // Serveur incohérent : l'empreinte rendue au provisionnement diffère de
    // celle annoncée. Une seule mise à jour par empreinte annoncée — jamais
    // une boucle d'allers-retours.
    s.subscriptions[1].configHash = 'hash-b3';
    remote.connections[1].configHash = 'hash-b3';
    empreinteRendue = 'hash-b4';
    await apply(h, { ...s, revision: 'reassigned-b3' });
    await attendre(async () => (await h.store.get('b')).value?.meta.configHash === 'hash-b4');
    for (const revision of ['reassigned-b3-1', 'reassigned-b3-2', 'reassigned-b3-3']) await apply(h, { ...s, revision });
    await new Promise(resolve => setTimeout(resolve, 50));
    cleanup();
    equal(importes, ['b', 'b']);
    assert.equal(h.state.stopCount, 0);
  });

  it('drains a legacy native service before first binding and keeps reconnect denial inside dispatch', () => {
    const nativeModule = readFileSync(path.join(mobile, 'modules/android-native/SxbVpnModule.kt'), 'utf8');
    const bind = nativeModule.slice(nativeModule.indexOf('fun bindAccessSession('), nativeModule.indexOf('fun getAccessControlState('));
    assert.match(bind, /SxbAccessPolicy\.bindingRequired\(previous, userId, deviceId\)/);
    assert.ok(bind.indexOf('service.stopForAccess()') < bind.indexOf('SxbAccessControl.bind('));
    const service = readFileSync(path.join(mobile, 'modules/android-native/SxbVpnService.kt'), 'utf8');
    const reconnect = service.slice(service.indexOf('onReconnect ='), service.indexOf('onGiveUp = {'));
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

  it('n’a plus de barrière de consentement avant le réseau', async () => {
    // Ce test exigeait l'inverse : sous Google Play, aucune requête ne devait
    // partir avant un consentement explicite. SXB ne publie plus sur Play, et
    // la barrière a été retirée — l'utilisateur qui installe l'APK et saisit
    // son jeton consent par le geste même.
    //
    // On vérifie donc que le consentement est ACQUIS et ne peut plus refuser,
    // car c'est lui qui bloquait autrefois ces quatre chemins.
    const h = await harness();
    const consent = h.consent.getPrivacyConsent();
    assert.equal(consent.vpn, true);
    assert.equal(consent.diagnostics, true);
    assert.equal(consent.notifications, true);
    // La garde subsiste au point d'entrée du tunnel, mais ne peut plus lever.
    assert.doesNotThrow(() => h.consent.requireVpnConsent());
  });

  it('honors Retry-After and validates the root blocked route and rendered French/English attribution', async () => {
    const h = await harness();
    assert.equal(h.policy.retryDelay(0, '120'), 120_000);
    assert.equal(h.policy.retryDelay(9, '999999'), 300_000);
    const disabled = snapshot('disabled', 'disabled').device;
    assert.equal(h.policy.accessRedirect(true, true, disabled, '(tabs)'), '/access-blocked');
    assert.equal(h.policy.accessRedirect(true, true, disabled, 'settings'), null);
    assert.equal(h.policy.accessRedirect(true, true, snapshot('active').device, 'access-blocked'), '/(tabs)');
    for (const [language, text, author] of [
      ['fr', 'temporairement désactivé', 'StuffxBilal'],
      ['en', 'temporarily disabled', 'StuffxBilal'],
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

describe('livre de comptes de la consommation', () => {
  const MO = 1024 * 1024;

  it('conserve les octets quand le compteur de session repart de zéro', async () => {
    const h = await harness();
    const contexte = { subscriptionId: 'a', sessionId: 'sess-1' };
    let livre = h.ledger.emptyLedger();

    // 78 Mo consommés, dont seulement 20 remontés.
    livre = h.ledger.accumulate(livre, { up: 20 * MO, down: 0 }, contexte);
    const premier = h.ledger.nextReport(livre)!;
    livre = h.ledger.settle(premier.ledger, premier.report);
    assert.equal(premier.report.bytesUp, 20 * MO);

    livre = h.ledger.accumulate(livre, { up: 78 * MO, down: 0 }, contexte);
    assert.equal(h.ledger.pendingBytes(livre), 58 * MO);

    // La session suivante compte 5 Mo, mais l'odomètre natif durable continue
    // à 83 Mo. Le ledger ne reçoit plus le compteur de session remis à zéro.
    livre = h.ledger.accumulate(livre, { up: 83 * MO, down: 0 }, contexte);
    assert.equal(h.ledger.pendingBytes(livre), 63 * MO,
      'Le reliquat précédent et les nouveaux octets doivent rester comptés');

    // Et la mesure suivante reprend un delta normal, sans recompter.
    livre = h.ledger.accumulate(livre, { up: 87 * MO, down: 0 }, contexte);
    assert.equal(h.ledger.pendingBytes(livre), 67 * MO);
  });

  it('rejoue le delta non remonté après la mort de l’application', async () => {
    const h = await harness();
    let livre = h.ledger.accumulate(h.ledger.emptyLedger(),
      { up: 3 * MO, down: 7 * MO }, { subscriptionId: 'a', sessionId: 'sess-1' });

    // Le livre part sur disque AVANT tout appel réseau.
    const prepare = h.ledger.nextReport(livre)!;
    await h.ledger.saveLedger(prepare.ledger);
    assert.ok(h.state.storage.has('@sxb_usage_ledger'));

    // … puis le système tue l'application : la mémoire disparaît, pas le livre.
    const relu = await h.ledger.loadLedger();
    assert.equal(h.ledger.pendingBytes(relu), 10 * MO);
    const rejeu = h.ledger.nextReport(relu)!;
    // Mêmes identifiants, mêmes octets : le serveur reconnaîtra le doublon.
    assert.equal(rejeu.report.sessionId, prepare.report.sessionId);
    assert.equal(rejeu.report.seq, prepare.report.seq);
    assert.equal(rejeu.report.bytesUp, 3 * MO);
    assert.equal(rejeu.report.bytesDown, 7 * MO);
    assert.equal(rejeu.report.subscriptionId, 'a');
  });

  it('fige les identifiants d’un rapport tenté, pour qu’un rejeu ne compte jamais deux fois', async () => {
    const h = await harness();
    const contexte = { subscriptionId: 'a', sessionId: 'sess-1' };
    let livre = h.ledger.accumulate(h.ledger.emptyLedger(), { up: MO, down: 0 }, contexte);
    const premier = h.ledger.nextReport(livre)!;
    livre = premier.ledger;

    // L'envoi échoue (réseau coupé) et la consommation continue : les octets
    // neufs vont dans une entrée SUIVANTE, jamais dans celle déjà partie.
    livre = h.ledger.accumulate(livre, { up: 3 * MO, down: 0 }, contexte);
    const rejeu = h.ledger.nextReport(livre)!;
    assert.equal(rejeu.report.seq, premier.report.seq);
    assert.equal(rejeu.report.bytesUp, premier.report.bytesUp);

    // Acquitté : l'entrée disparaît, la suivante porte un autre `seq`.
    livre = h.ledger.settle(rejeu.ledger, rejeu.report);
    const suivant = h.ledger.nextReport(livre)!;
    assert.notEqual(suivant.report.seq, premier.report.seq);
    assert.equal(suivant.report.bytesUp, 2 * MO);

    // Acquitter deux fois le même rapport ne retire jamais une autre entrée.
    const inchange = h.ledger.settle(livre, premier.report);
    assert.equal(h.ledger.pendingBytes(inchange), h.ledger.pendingBytes(livre));
  });

  it('n’impute jamais à un forfait les octets d’un autre', async () => {
    const h = await harness();
    let livre = h.ledger.accumulate(h.ledger.emptyLedger(), { up: MO, down: 0 },
      { subscriptionId: 'a', sessionId: 'sess-1' });
    livre = h.ledger.accumulate(livre, { up: 4 * MO, down: 0 },
      { subscriptionId: 'b', sessionId: 'sess-2' });
    const premier = h.ledger.nextReport(livre)!;
    assert.equal(premier.report.subscriptionId, 'a');
    assert.equal(premier.report.bytesUp, MO);
    const second = h.ledger.nextReport(h.ledger.settle(premier.ledger, premier.report))!;
    assert.equal(second.report.subscriptionId, 'b');
    assert.equal(second.report.bytesUp, 3 * MO);
  });

  it('découpe un retard énorme sous la limite que le serveur accepte', async () => {
    const h = await harness();
    const enorme = 6 * 1024 * 1024 * 1024; // 6 Go : le serveur refuse au-delà de 5.
    const livre = h.ledger.accumulate(h.ledger.emptyLedger(), { up: 0, down: enorme },
      { subscriptionId: 'a', sessionId: 'sess-1' });
    const premier = h.ledger.nextReport(livre)!;
    assert.ok(premier.report.bytesUp + premier.report.bytesDown <= h.ledger.MAX_REPORT_BYTES);
    // Le reliquat reste au livre : rien n'est jeté.
    assert.equal(h.ledger.pendingBytes(premier.ledger), enorme);
    const reste = h.ledger.settle(premier.ledger, premier.report);
    assert.equal(h.ledger.pendingBytes(reste), enorme - h.ledger.MAX_REPORT_BYTES);
  });

  it('s’ancre sur un compteur déjà avancé sans facturer le passé', async () => {
    const h = await harness();
    assert.equal(h.ledger.isFreshLedger(h.ledger.emptyLedger()), true);
    const ancre = h.ledger.anchorLedger(h.ledger.emptyLedger(), { up: 500 * MO, down: 900 * MO });
    assert.equal(h.ledger.pendingBytes(ancre), 0);
    assert.equal(h.ledger.isFreshLedger(ancre), false);
    const apres = h.ledger.accumulate(ancre, { up: 501 * MO, down: 900 * MO },
      { subscriptionId: 'a', sessionId: 'sess-1' });
    assert.equal(h.ledger.pendingBytes(apres), MO);
  });

  it('ne recule pas sur une lecture nulle, qui ne prouve rien', async () => {
    const h = await harness();
    const contexte = { subscriptionId: 'a', sessionId: 'sess-1' };
    let livre = h.ledger.accumulate(h.ledger.emptyLedger(), { up: 40 * MO, down: 60 * MO }, contexte);
    assert.equal(h.ledger.pendingBytes(livre), 100 * MO);

    // Le service n'est pas encore en vie : ses compteurs rendent zéro. Avancer
    // le livre à zéro sur cette lecture referait facturer les 100 Mo dès que le
    // service aurait rechargé son cumul.
    livre = h.ledger.accumulate(livre, { up: 0, down: 0 }, contexte);
    assert.equal(h.ledger.pendingBytes(livre), 100 * MO);
    assert.equal(livre.counterUp, 40 * MO);
    assert.equal(livre.counterDown, 60 * MO);

    livre = h.ledger.accumulate(livre, { up: 40 * MO, down: 61 * MO }, contexte);
    assert.equal(h.ledger.pendingBytes(livre), 101 * MO, 'Seul le mégaoctet neuf doit être facturé');
  });

  it('préserve un livre corrompu au lieu de le remplacer par une nouvelle facture', async () => {
    const h = await harness();
    h.state.storage.set('@sxb_usage_ledger', '{ pas du json');
    await assert.rejects(h.ledger.loadLedger(), /VPN_USAGE_LEDGER_UNAVAILABLE/);
    assert.equal(h.state.storage.get('@sxb_usage_ledger'), '{ pas du json');
    h.state.storage.set('@sxb_usage_ledger', JSON.stringify({
      counterUp: -5, counterDown: 'x', nextSeq: 2,
      entries: [
        { subscriptionId: 'a', sessionId: 'sess-1', seq: 0, up: 10, down: 5 },
        { subscriptionId: 'a', sessionId: '', seq: 1, up: 10, down: 5 },
        { subscriptionId: 'a', sessionId: 'sess-1', seq: -1, up: 10, down: 5 },
      ],
    }));
    const original = h.state.storage.get('@sxb_usage_ledger');
    await assert.rejects(h.ledger.loadLedger(), /VPN_USAGE_LEDGER_UNAVAILABLE/);
    assert.equal(h.state.storage.get('@sxb_usage_ledger'), original);
    h.state.storage.set('@sxb_usage_ledger', JSON.stringify({
      counterUp: 10, counterDown: 5, nextSeq: 2,
      entries: [{ subscriptionId: 'a', sessionId: 'sess-1', seq: 0, up: 10, down: 5 }],
    }));
    const relu = await h.ledger.loadLedger();
    assert.equal(relu.counterUp, 10);
    assert.equal(relu.counterDown, 5);
    assert.equal(h.ledger.pendingBytes(relu), 15);
    // Une entrée relue est gelée d'office : elle a pu atteindre le serveur.
    assert.equal(relu.entries[0].frozen, true);
  });
});

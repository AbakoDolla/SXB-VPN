import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';

const mobile = path.resolve(__dirname, '..');
const requireMobile = createRequire(path.join(mobile, 'package.json'));
const { build, transform } = createRequire(requireMobile.resolve('tsx'))('esbuild');

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function services() {
  const output = await build({
    stdin: {
      contents: `
        export * as ledger from './services/usageLedger';
        export * as quota from './services/quotaState';
        export * as offline from './services/offlineStorage';
        export { state } from 'test:state';`,
      loader: 'ts', resolveDir: mobile,
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
    plugins: [{
      name: 'usage-storage-fixture',
      setup(plugin: any) {
        const stubs: Record<string, string> = {
          'test:state': `export const state={storage:new Map(),failWrites:false,failReads:false,metadata:new Map()};`,
          '@react-native-async-storage/async-storage': `
            import {state} from 'test:state'; export default {
              getItem:async k=>{if(state.failReads)throw Error('STORAGE_UNAVAILABLE');return state.storage.get(k)??null},
              setItem:async(k,v)=>{if(state.failWrites)throw Error('STORAGE_UNAVAILABLE');state.storage.set(k,v)},
              removeItem:async k=>state.storage.delete(k),
              getAllKeys:async()=>[...state.storage.keys()],
            };`,
          './configStore': `
            import {state} from 'test:state';
            export const updateMetadata=async(id,meta)=>{state.metadata.set(id,meta);return{status:'ok'}};
            export const getActive=async()=>({status:'ok',value:null});
            export const updateQuota=async()=>({status:'ok'});
            export const save=async()=>({status:'ok'});
            export const remove=async()=>({status:'ok'});
            export const clearAll=async()=>({status:'ok'});`,
        };
        plugin.onResolve({ filter: /.*/ }, (args: any) =>
          args.path in stubs ? { path: args.path, namespace: 'fixture' } : undefined);
        plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, (args: any) =>
          ({ contents: stubs[args.path], loader: 'js' }));
      },
    }],
  });
  const module = { exports: {} as any };
  runInNewContext(output.outputFiles[0].text, { module, exports: module.exports, require: requireMobile });
  return module.exports as {
    ledger: typeof import('../services/usageLedger');
    quota: typeof import('../services/quotaState');
    offline: typeof import('../services/offlineStorage');
    state: { storage: Map<string, string>; failWrites: boolean; failReads: boolean; metadata: Map<string, unknown> };
  };
}

// Execute the provider's real accounting callbacks without mounting unrelated
// screens or starting native/network observers.
async function reporter() {
  const h = await services();
  const source = readFileSync(path.join(mobile, 'contexts', 'VpnContext.tsx'), 'utf8');
  const callbacks = source.slice(source.indexOf('  const applyServerQuota ='), source.indexOf('  const flushUsageRef ='));
  assert.ok(callbacks.includes("'/mobile/vpn/traffic'"));
  const ref = (current: any) => ({ current });
  const state: any = {
    stats: { lifetimeUploadBytes: 1, lifetimeDownloadBytes: 1, uploadBytes: 0, downloadBytes: 0 },
    posts: [], quota: null, stops: 0, epoch: 0, retries: new Map(), timerId: 0,
  };
  const env: any = {
    ...h.ledger,
    accumulateUsage: h.ledger.accumulate,
    settleUsage: h.ledger.settle,
    ...h.offline,
    isAuthenticated: true, deviceId: 'fixture-device', IS_ANDROID: true,
    useCallback: (callback: any) => callback,
    ledgerRef: ref(h.ledger.anchorLedger(h.ledger.emptyLedger(), { up: 1, down: 1 })),
    ledgerBusyRef: ref(false), ledgerFlushRef: ref(null),
    usageRetryTimerRef: ref(null), USAGE_REPORT_INTERVAL_MS: 20_000,
    usageMountedRef: ref(true),
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++state.timerId;
      state.retries.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id: number) => state.retries.delete(id),
    runningProfileRef: ref({ configId: 'normal', subscriptionId: 'normal' }),
    sessionIdRef: ref('native-session-1'),
    sessionBaselineRef: ref({ up: 0, down: 0 }),
    shownUsageRef: ref(null),
    activeConfigIdRef: ref('normal'),
    activeConnection: { id: 'normal' },
    quotaWriteRef: ref(0),
    quotaDataRef: ref(null),
    flushUsageRef: ref(null),
    accessRequestStamp: () => ({ epoch: state.epoch, revision: state.epoch }),
    currentAccessRequest: (stamp: any) => stamp.epoch === state.epoch,
    currentIdentityRequest: (stamp: any) => stamp.epoch === state.epoch,
    setQuotaData: (value: any) => { state.quota = typeof value === 'function' ? value(state.quota) : value; },
    setUsageLedger: (value: any) => { state.ledger = value; },
    SxbVpnNative: { getTrafficStats: async () => ({ ...state.stats }) },
    getAccessState: () => ({ authority: { userId: 'fixture-user', deviceId: 'fixture-device' } }),
    configStore: {
      list: async () => ({ status: 'ok', value: ['normal', 'trial'].map(configId => ({ configId, subscriptionId: configId })) }),
    },
    storeValue: (result: any) => result.value,
    apiClient: { post: async (_url: string, body: any) => {
      state.posts.push(body);
      return state.respond(body);
    } },
    legacyDebugLog: () => {}, addLog: () => {}, wakeAccessObservation: () => {},
    setRevokedStatus: (value: string) => { state.revoked = value; },
    stopForAccessRef: ref(async () => { state.stops++; }),
  };
  state.respond = async (body: any) => ({ data: {
    ok: true, subscriptionId: body.subscriptionId ?? 'normal',
    quotaTotalBytes: 1000, quotaUsedBytes: body.bytesUp + body.bytesDown,
  } });
  const compiled = await transform(`
    export function create(env) {
      const { ${Object.keys(env).join(',')} } = env;
      ${callbacks}
      return {applyServerQuota,flushUsage};
    }`, { loader: 'ts', format: 'cjs' });
  const module = { exports: {} as any };
  runInNewContext(compiled.code, { module, exports: module.exports, console });
  const api = module.exports.create(env);
  env.flushUsageRef.current = api.flushUsage;
  return { ...h, ...api, env, state, storageState: h.state };
}

describe('durable byte accounting', () => {
  it('anchors once even when both lifetime counters start at zero', async () => {
    const h = await services();
    let ledger = h.ledger.anchorLedger(h.ledger.emptyLedger(), { up: 0, down: 0 });
    await h.ledger.saveLedger(ledger);
    ledger = await h.ledger.loadLedger();
    const next = { up: 17, down: 29 };
    ledger = h.ledger.isFreshLedger(ledger)
      ? h.ledger.anchorLedger(ledger, next)
      : h.ledger.accumulate(ledger, next, { subscriptionId: 'trial', sessionId: 'first' });
    assert.equal(h.ledger.pendingBytes(ledger), 46, 'the first measured bytes must not become a second anchor');
  });

  it('retains distinct native sessions before the first network attempt', async () => {
    const h = await services();
    let ledger = h.ledger.accumulate(h.ledger.emptyLedger(), { up: 20, down: 30 }, { subscriptionId: 'normal', sessionId: 'one' });
    ledger = h.ledger.accumulate(ledger, { up: 25, down: 37 }, { subscriptionId: 'normal', sessionId: 'two' });
    assert.equal(ledger.entries.length, 2);
    assert.equal(ledger.entries[1].sessionId, 'two');
    assert.equal(h.ledger.pendingBytes(ledger), 62);
  });

  it('does not acknowledge persistence when storage refused the write', async () => {
    const h = await services();
    h.state.failWrites = true;
    await assert.rejects(h.ledger.saveLedger(h.ledger.emptyLedger()), /STORAGE_UNAVAILABLE/);
  });

  it('does not replace unreadable or corrupt persisted traffic with an empty ledger', async () => {
    const h = await services();
    const key = '@sxb_usage_ledger';
    const saved = h.ledger.accumulate(h.ledger.emptyLedger(), { up: 17, down: 29 }, {
      subscriptionId: 'normal', sessionId: 'durable',
    });
    await h.ledger.saveLedger(saved);
    const original = h.state.storage.get(key);
    h.state.failReads = true;
    await assert.rejects(h.ledger.loadLedger(), /VPN_USAGE_LEDGER_UNAVAILABLE/);
    assert.equal(h.state.storage.get(key), original);
    h.state.failReads = false;
    for (const corrupt of [
      '', '{', 'null', '{}', JSON.stringify({ ...saved, entries: [{}] }),
      JSON.stringify({ ...saved, entries: [{ ...saved.entries[0], subscriptionId: 17 }] }),
      JSON.stringify({ ...saved, context: { sessionId: 'saved', subscriptionId: {} } }),
      JSON.stringify({ ...saved, quotas: { normal: { usedBytes: 'bad', totalBytes: 100 } } }),
    ]) {
      h.state.storage.set(key, corrupt);
      await assert.rejects(h.ledger.loadLedger(), /VPN_USAGE_LEDGER_UNAVAILABLE/);
      assert.equal(h.state.storage.get(key), corrupt);
    }
    h.state.storage.delete(key);
    assert.equal(h.ledger.isFreshLedger(await h.ledger.loadLedger()), true);
  });

  it('does not recharge 99 MiB when an older native checkpoint follows an acknowledged 100 MiB', async () => {
    const h = await services();
    const MiB = 1024 ** 2;
    const context = { subscriptionId: 'normal', sessionId: 'upgrade' };
    let ledger = h.ledger.anchorLedger(h.ledger.emptyLedger(), { up: 100 * MiB, down: 200 * MiB });
    ledger = h.ledger.accumulate(ledger, { up: 99 * MiB, down: 199 * MiB }, context);
    assert.equal(h.ledger.pendingBytes(ledger), 0);
    await h.ledger.saveLedger(ledger);
    ledger = h.ledger.accumulate(await h.ledger.loadLedger(), { up: 99 * MiB + 7, down: 199 * MiB + 11 }, context);
    assert.equal(h.ledger.pendingBytes(ledger), 18);
  });

  it('does not hide measured over-quota bytes that the dashboard still counts', async () => {
    const h = await services();
    const quota = h.quota.deriveQuota({ totalQuota: 100, usedQuota: 113 });
    assert.equal(quota.usedBytes, 113);
    assert.equal(quota.remainingBytes, 0);
    assert.equal(quota.usedRatio, 1);
  });

  it('does not expose the previous trial snapshot during a normal-profile switch', async () => {
    const h = await services();
    const source = readFileSync(path.join(mobile, 'contexts', 'VpnContext.tsx'), 'utf8');
    const selector = source.slice(source.indexOf('  const quotaProfile ='), source.indexOf('  // ── StepLogs helpers'));
    const env = {
      deriveQuota: h.quota.deriveQuota, quotaProjection: h.ledger.quotaProjection,
      runningProfileRef: { current: null }, activeConfigId: 'normal',
      activeConnection: { id: 'normal', quota: { totalBytes: 1000, usedBytes: 7 }, expiresAt: null },
      sessionBaselineRef: { current: { up: 0, down: 0 } },
      trafficStats: { uploadBytes: 0, downloadBytes: 0 }, usageLedger: null,
      quotaData: { configId: 'trial', totalQuota: 100, usedQuota: 99 },
      accountState: { subscription: { id: 'trial' }, quotaTotalBytes: 100, quotaUsedBytes: 99 },
      isConnected: false,
    };
    const output = await transform(`export function select(env) {
      const {${Object.keys(env).join(',')}}=env;
      ${selector}
      return currentDerivedQuota;
    }`, { loader: 'ts', format: 'cjs' });
    const module = { exports: {} as any };
    runInNewContext(output.code, { module, exports: module.exports });
    assert.equal(module.exports.select(env).usedBytes, 7);
  });

  it('keeps both directions across old checkpoints, zero readings and persisted replay', async () => {
    const h = await services();
    const owner = { subscriptionId: 'normal', configId: 'normal', sessionId: 'one' };
    let ledger = h.ledger.anchorLedger(h.ledger.emptyLedger(), { up: 0, down: 0 });
    ledger = h.ledger.recordQuota(ledger, owner, { usedBytes: 7, totalBytes: 1000 });
    ledger = h.ledger.accumulate(ledger, { up: 100, down: 200 }, owner);
    const frozen = h.ledger.nextReport(ledger)!;
    await h.ledger.saveLedger(frozen.ledger);
    ledger = await h.ledger.loadLedger();
    ledger = h.ledger.accumulate(ledger, { up: 0, down: 0 }, owner);
    ledger = h.ledger.accumulate(ledger, { up: 5, down: 220 }, { ...owner, sessionId: 'two' });
    const projection = h.ledger.quotaProjection(ledger, owner);
    assert.equal(projection.pendingBytes, 320);
    const quota = h.quota.deriveQuota({ totalQuota: 1000, usedQuota: 7 }, {
      sessionUp: 0, sessionDown: 0, sessionBaselineUp: 100, sessionBaselineDown: 200, ...projection,
    }, false);
    assert.equal(quota.usedBytes, 327, 'disconnect or a reset session display must not hide queued bytes');
    const replay = h.ledger.nextReport(ledger)!;
    assert.equal(replay.report.bytesUp, 100);
    assert.equal(replay.report.bytesDown, 200);
    assert.equal(replay.report.seq, frozen.report.seq);
    ledger = h.ledger.settle(replay.ledger, replay.report);
    const next = h.ledger.nextReport(ledger)!;
    assert.equal(next.report.bytesUp, 0);
    assert.equal(next.report.bytesDown, 20);
    assert.notEqual(next.report.seq, replay.report.seq);
  });

  it('does not mistake an older UI reading for a lifetime counter reset', async () => {
    const h = await services();
    const owner = { subscriptionId: 'normal', sessionId: 'one' };
    let ledger = h.ledger.accumulate(h.ledger.emptyLedger(), { up: 100, down: 200 }, owner);
    ledger = h.ledger.recordQuota(ledger, owner, { usedBytes: 7, totalBytes: 1000 });
    const lagging = h.ledger.quotaProjection(ledger, owner, { up: 90, down: 180 });
    assert.equal(lagging.pendingBytes, 300);
    assert.equal(h.ledger.quotaProjection(ledger, owner, { up: 105, down: 220 }).pendingBytes, 325);
  });

  it('does not add the same pending report to a refreshed server snapshot twice', async () => {
    const h = await services();
    const quota = h.quota.deriveQuota({ totalQuota: 1000, usedQuota: 37 }, {
      sessionUp: 10000, sessionDown: 20000, sessionBaselineUp: 0, sessionBaselineDown: 0,
      pendingBytes: 35, accountedUsedBytes: 7,
    }, true);
    assert.equal(quota.usedBytes, 42, '30 bytes included by the server plus 5 still pending, not 37+35');
  });

  it('retains a long offline backlog instead of dropping bytes beyond 64 GiB', async () => {
    const h = await services();
    const GiB = 1024 ** 3;
    const owner = { subscriptionId: 'normal', sessionId: 'offline' };
    let ledger = h.ledger.accumulate(h.ledger.emptyLedger(), { up: 4 * GiB, down: 60 * GiB }, owner);
    ledger = h.ledger.accumulate(ledger, { up: 5 * GiB, down: 63 * GiB }, owner);
    assert.equal(h.ledger.pendingBytes(ledger), 68 * GiB);
    let up = 0;
    let down = 0;
    const keys = new Set<string>();
    while (ledger.entries.length) {
      const next = h.ledger.nextReport(ledger)!;
      assert.ok(next.report.bytesUp + next.report.bytesDown <= h.ledger.MAX_REPORT_BYTES);
      const key = `${next.report.sessionId}:${next.report.seq}`;
      assert.equal(keys.has(key), false);
      keys.add(key);
      up += next.report.bytesUp;
      down += next.report.bytesDown;
      ledger = h.ledger.settle(next.ledger, next.report);
    }
    assert.equal(up, 5 * GiB);
    assert.equal(down, 63 * GiB);
  });
});

describe('provider traffic report lifecycle', () => {
  it('saves a replayed trial receipt to the trial, not the newly selected normal plan', async () => {
    const h = await reporter();
    await h.offline.saveQuotaData({ configId: 'normal', totalQuota: 1000, usedQuota: 7, expiryDate: null });
    await h.offline.saveQuotaData({ configId: 'trial', totalQuota: 100, usedQuota: 0, expiryDate: null });
    h.env.ledgerRef.current = h.ledger.accumulate(h.env.ledgerRef.current, { up: 11, down: 21 }, { subscriptionId: 'trial', sessionId: 'trial-session' });
    h.state.stats = { lifetimeUploadBytes: 11, lifetimeDownloadBytes: 21, uploadBytes: 0, downloadBytes: 0 };
    await h.flushUsage();
    assert.equal((await h.offline.loadQuotaData('normal'))?.usedQuota, 7);
    assert.equal((await h.offline.loadQuotaData('trial'))?.usedQuota, 30);
    assert.notEqual(h.state.quota?.configId, 'trial', 'the selected UI must not receive another plan');
  });

  it('waits for an in-flight report before recording the final old-profile tail', async () => {
    const h = await reporter();
    const received = deferred();
    const response = deferred<any>();
    h.state.stats = { lifetimeUploadBytes: 11, lifetimeDownloadBytes: 21, uploadBytes: 10, downloadBytes: 20 };
    h.state.respond = async () => {
      if (h.state.posts.length === 1) { received.resolve(); return response.promise; }
      return { data: { ok: true, subscriptionId: 'normal', quotaTotalBytes: 1000, quotaUsedBytes: 35 } };
    };
    const first = h.flushUsage();
    await received.promise;
    h.state.stats = { lifetimeUploadBytes: 13, lifetimeDownloadBytes: 24, uploadBytes: 12, downloadBytes: 23 };
    const final = h.flushUsage({ final: true });
    response.resolve({ data: { ok: true, subscriptionId: 'normal', quotaTotalBytes: 1000, quotaUsedBytes: 30 } });
    await Promise.all([first, final]);
    assert.equal(h.state.posts.length, 2);
    assert.equal(h.state.posts[1].bytesUp, 2);
    assert.equal(h.state.posts[1].bytesDown, 3);
    assert.equal(h.state.posts[1].subscriptionId, 'normal');
    assert.equal(h.ledger.pendingBytes(await h.ledger.loadLedger()), 0);
  });

  it('keeps reports when a response does not explicitly acknowledge them', async () => {
    const h = await reporter();
    h.state.stats = { lifetimeUploadBytes: 5, lifetimeDownloadBytes: 7 };
    h.state.respond = async () => ({ data: { ok: false, reason: 'temporarily_unavailable' } });
    await h.flushUsage();
    assert.equal(h.ledger.pendingBytes(await h.ledger.loadLedger()), 10);
  });

  it('does not discard traffic on a temporary device-level 403', async () => {
    const h = await reporter();
    h.state.stats = { lifetimeUploadBytes: 5, lifetimeDownloadBytes: 7 };
    h.state.respond = async () => { throw { response: { status: 403, data: { code: 'DEVICE_SUSPENDED' } } }; };
    await h.flushUsage();
    assert.equal(h.ledger.pendingBytes(await h.ledger.loadLedger()), 10);
  });

  it('does not exhaust a selected normal plan when an old trial receipt arrives while disconnected', async () => {
    const h = await reporter();
    h.env.runningProfileRef.current = null;
    h.env.ledgerRef.current = h.ledger.accumulate(h.env.ledgerRef.current, { up: 5, down: 7 }, {
      subscriptionId: 'trial', configId: 'trial', sessionId: 'trial-old',
    });
    h.state.stats = { lifetimeUploadBytes: 5, lifetimeDownloadBytes: 7 };
    h.state.respond = async () => ({ data: {
      ok: true, subscriptionId: 'trial', quotaUsedBytes: 10, quotaTotalBytes: 10, quotaExhausted: true,
    } });
    await h.flushUsage();
    assert.equal(h.state.stops, 0);
    assert.notEqual(h.state.revoked, 'exhausted');
  });

  it('still stops the running profile when its own confirmed quota is exhausted', async () => {
    const h = await reporter();
    h.state.stats = { lifetimeUploadBytes: 5, lifetimeDownloadBytes: 7 };
    h.state.respond = async () => ({ data: {
      ok: true, subscriptionId: 'normal', quotaUsedBytes: 10, quotaTotalBytes: 10, quotaExhausted: true,
    } });
    await h.flushUsage();
    assert.equal(h.state.stops, 1);
    assert.equal(h.state.revoked, 'exhausted');
  });

  it('rejects a late receipt after the authenticated identity changes', async () => {
    const h = await reporter();
    const received = deferred();
    const response = deferred<any>();
    h.state.stats = { lifetimeUploadBytes: 5, lifetimeDownloadBytes: 7 };
    h.state.respond = async () => { received.resolve(); return response.promise; };
    const first = h.flushUsage();
    await received.promise;
    h.state.epoch++;
    response.resolve({ data: { ok: true, subscriptionId: 'normal', quotaTotalBytes: 1000, quotaUsedBytes: 10 } });
    await first;
    assert.equal(h.state.quota, null);
  });

  it('anchors before tunnel start and reports the first bytes, never the duration', async () => {
    const h = await reporter();
    h.env.ledgerRef.current = h.ledger.emptyLedger();
    h.state.stats = { lifetimeUploadBytes: 0, lifetimeDownloadBytes: 0, connectedSeconds: 90000 };
    await h.offline.saveQuotaData({ configId: 'normal', totalQuota: 1000, usedQuota: 0, expiryDate: null });
    await h.flushUsage({ beforeConnect: true });
    assert.equal(h.state.posts.length, 0);
    h.state.stats = { lifetimeUploadBytes: 17, lifetimeDownloadBytes: 29, connectedSeconds: 90001 };
    await h.flushUsage();
    assert.equal(h.state.posts[0].bytesUp, 17);
    assert.equal(h.state.posts[0].bytesDown, 29);
    assert.equal(h.state.quota.usedQuota, 46);
  });

  it('keeps the offline tail on the old profile when preparing a different tunnel', async () => {
    const h = await reporter();
    const old = { configId: 'trial', subscriptionId: 'trial', sessionId: 'old' };
    h.env.ledgerRef.current = { ...h.env.ledgerRef.current, context: old };
    h.state.stats = { lifetimeUploadBytes: 3, lifetimeDownloadBytes: 4 };
    await h.flushUsage({ beforeConnect: true });
    assert.equal(h.state.posts.length, 0);
    assert.equal(h.env.ledgerRef.current.context.subscriptionId, 'normal');
    h.state.stats = { lifetimeUploadBytes: 7, lifetimeDownloadBytes: 9 };
    await h.flushUsage();
    assert.equal(h.state.posts.length, 2);
    assert.equal(h.state.posts[0].subscriptionId, 'trial');
    assert.equal(h.state.posts[0].bytesUp + h.state.posts[0].bytesDown, 5);
    assert.equal(h.state.posts[1].subscriptionId, 'normal');
    assert.equal(h.state.posts[1].bytesUp + h.state.posts[1].bytesDown, 9);
  });

  it('retains the accepted byte floor when a stale cached snapshot arrives later', async () => {
    const h = await reporter();
    h.env.ledgerRef.current = h.ledger.recordQuota(h.env.ledgerRef.current, {
      configId: 'normal', subscriptionId: 'normal',
    }, { usedBytes: 30, totalBytes: 1000 });
    await h.offline.saveQuotaData({ configId: 'normal', totalQuota: 1000, usedQuota: 0, expiryDate: null });
    h.state.stats = { lifetimeUploadBytes: 3, lifetimeDownloadBytes: 4 };
    h.state.respond = async () => { throw new Error('OFFLINE'); };
    await h.flushUsage();
    const projection = h.ledger.quotaProjection(await h.ledger.loadLedger(), { subscriptionId: 'normal' });
    const quota = h.quota.deriveQuota({ totalQuota: 1000, usedQuota: 0 }, {
      sessionUp: 0, sessionDown: 0, sessionBaselineUp: 0, sessionBaselineDown: 0, ...projection,
    }, false);
    assert.equal(quota.usedBytes, 35);
  });

  it('does not send any report without its durable replay key', async () => {
    const h = await reporter();
    h.state.stats = { lifetimeUploadBytes: 5, lifetimeDownloadBytes: 7 };
    h.storageState.failWrites = true;
    await h.flushUsage();
    assert.equal(h.state.posts.length, 0);
    h.storageState.failWrites = false;
    h.state.respond = async (body: any) => {
      const persisted = await h.ledger.loadLedger();
      const replay = h.ledger.nextReport(persisted)!;
      assert.equal(replay.report.sessionId, body.sessionId);
      assert.equal(replay.report.seq, body.seq);
      assert.equal(replay.report.bytesUp, body.bytesUp);
      assert.equal(replay.report.bytesDown, body.bytesDown);
      return { data: { ok: true, subscriptionId: 'normal', quotaUsedBytes: 10, quotaTotalBytes: 1000 } };
    };
    await h.flushUsage();
    assert.equal(h.state.posts.length, 1);
  });

  it('does not start a new accounting period without a durable anchor', async () => {
    const h = await reporter();
    h.storageState.failWrites = true;
    await assert.rejects(h.flushUsage({ beforeConnect: true }), /STORAGE_UNAVAILABLE/);
    assert.equal(h.state.posts.length, 0);
  });

  it('retries a failed ledger read without overwriting the queue or sending a debit', async () => {
    const h = await reporter();
    const pending = h.ledger.accumulate(h.env.ledgerRef.current, { up: 5, down: 7 }, {
      subscriptionId: 'normal', configId: 'normal', sessionId: 'saved',
    });
    await h.ledger.saveLedger(pending);
    const original = h.storageState.storage.get('@sxb_usage_ledger');
    h.env.ledgerRef.current = null;
    h.state.stats = { lifetimeUploadBytes: 5, lifetimeDownloadBytes: 7 };
    h.storageState.failReads = true;
    await h.flushUsage();
    assert.equal(h.state.posts.length, 0);
    assert.equal(h.storageState.storage.get('@sxb_usage_ledger'), original);
    assert.notEqual(h.env.usageRetryTimerRef.current, null);
    await assert.rejects(h.flushUsage({ beforeConnect: true }), /VPN_USAGE_LEDGER_UNAVAILABLE/);
    h.storageState.failReads = false;
    await h.flushUsage();
    assert.equal(h.state.posts.length, 1);
    assert.equal(h.state.posts[0].bytesUp + h.state.posts[0].bytesDown, 10);
  });

  it('retains corrupt ledger evidence and refuses a replacement anchor', async () => {
    const h = await reporter();
    h.env.ledgerRef.current = null;
    h.storageState.storage.set('@sxb_usage_ledger', '{');
    await assert.rejects(h.flushUsage({ beforeConnect: true }), /VPN_USAGE_LEDGER_UNAVAILABLE/);
    assert.equal(h.state.posts.length, 0);
    assert.equal(h.storageState.storage.get('@sxb_usage_ledger'), '{');
  });

  it('does not leave a second reporter running after its provider unmounts', async () => {
    const h = await reporter();
    const received = deferred();
    const response = deferred<any>();
    h.state.stats = { lifetimeUploadBytes: 5, lifetimeDownloadBytes: 7 };
    h.state.respond = async () => { received.resolve(); return response.promise; };
    const running = h.flushUsage();
    await received.promise;
    h.env.usageMountedRef.current = false;
    response.reject(new Error('OFFLINE'));
    await running;
    assert.equal(h.state.retries.size, 0);
    assert.equal(h.ledger.pendingBytes(await h.ledger.loadLedger()), 10);
  });

  it('continues a bounded final replay until the disconnected backlog is empty', async () => {
    const h = await reporter();
    const GiB = 1024 ** 3;
    h.state.stats = { lifetimeUploadBytes: 5 * GiB + 1, lifetimeDownloadBytes: 63 * GiB + 1 };
    let accounted = 0;
    h.state.respond = async (body: any) => {
      accounted += body.bytesUp + body.bytesDown;
      return { data: { ok: true, subscriptionId: 'normal', quotaTotalBytes: 100 * GiB, quotaUsedBytes: accounted } };
    };
    await h.flushUsage({ final: true });
    assert.equal(h.state.posts.length, 6);
    for (let cycle = 0; h.ledger.pendingBytes(h.env.ledgerRef.current) > 0 && cycle < 5; cycle++) {
      const id = h.env.usageRetryTimerRef.current;
      const retry = h.state.retries.get(id);
      assert.equal(retry.delay, 20_000);
      h.state.retries.delete(id);
      retry.callback();
      await h.env.ledgerFlushRef.current;
    }
    assert.equal(accounted, 68 * GiB);
    assert.equal(h.ledger.pendingBytes(await h.ledger.loadLedger()), 0);
    assert.equal(h.env.usageRetryTimerRef.current, null);
  });
});

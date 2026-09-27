import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';
import { sanitizeEngineConfig } from '../services/configValidator';
import type { ProfileIdentity } from '../services/accessPolicy';

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
        export * as reporting from './services/usageReporting';
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
          'react-native': `export const AppRegistry={registerHeadlessTask(){}};`,
          'expo-crypto': `export {randomUUID} from 'node:crypto';`,
          '@react-native-async-storage/async-storage': `
            import {state} from 'test:state'; export default {
              getItem:async k=>{if(state.failReads)throw Error('STORAGE_UNAVAILABLE');return state.storage.get(k)??null},
              setItem:async(k,v)=>{
                if(state.failWrites)throw Error('STORAGE_UNAVAILABLE');
                if(state.beforeWrite)await state.beforeWrite(k,v);
                state.storage.set(k,v);
              },
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
  runInNewContext(output.outputFiles[0].text, { module, exports: module.exports, require: requireMobile, setTimeout, clearTimeout });
  return module.exports as {
    ledger: typeof import('../services/usageLedger');
    reporting: typeof import('../services/usageReporting');
    quota: typeof import('../services/quotaState');
    offline: typeof import('../services/offlineStorage');
    state: {
      storage: Map<string, string>; failWrites: boolean; failReads: boolean; metadata: Map<string, unknown>;
      beforeWrite?: (key: string, value: string) => Promise<void>;
    };
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
    posts: [], signals: [], quota: null, stops: 0, epoch: 0, retries: new Map(), timerId: 0,
    profiles: ['normal', 'trial'].map(configId => ({ configId, subscriptionId: configId })),
  };
  const env: any = {
    ...h.ledger,
    ...h.reporting,
    AbortController,
    accumulateUsage: h.ledger.accumulate,
    settleUsage: h.ledger.settle,
    ...h.offline,
    isAuthenticated: true, deviceId: 'fixture-device', IS_ANDROID: true,
    useCallback: (callback: any) => callback,
    ledgerRef: ref(h.ledger.anchorLedger(h.ledger.emptyLedger(), { up: 1, down: 1 })),
    ledgerBusyRef: ref(false), ledgerFlushRef: ref(null),
    usagePreparationPendingRef: ref(0), usageRequestAbortRef: ref(null),
    usageRetryTimerRef: ref(null), USAGE_REPORT_INTERVAL_MS: 20_000,
    usageMountedRef: ref(true),
    usageRetryAtRef: ref(0), usageFailuresRef: ref(0),
    usageRetryDelay: () => 20_000,
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
      list: async () => ({ status: 'ok', value: state.profiles }),
    },
    storeValue: (result: any) => result.value,
    apiClient: { post: async (_url: string, body: any, options?: { signal?: AbortSignal }) => {
      state.posts.push(body);
      state.signals.push(options?.signal);
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

  it('preserves explicit unlinking through frozen chunking and disk replay without rewriting legacy entries', async () => {
    const h = await services();
    const legacy = { subscriptionId: null, configId: 'old-manual', sessionId: 'one-app-session' };
    let ledger = h.ledger.accumulate(h.ledger.emptyLedger(), { up: 2, down: 3 }, legacy);
    const manual = { subscriptionId: null, configId: 'manual', attribution: 'unlinked' as const, sessionId: legacy.sessionId };
    ledger = h.ledger.accumulate(ledger, { up: 2, down: h.ledger.MAX_REPORT_BYTES + 12 }, manual);
    assert.equal(ledger.entries.length, 2, 'different manual configurations must not coalesce');
    await h.ledger.saveLedger(ledger);
    const first = h.ledger.nextReport(await h.ledger.loadLedger())!;
    assert.equal(first.report.attribution, undefined, 'legacy identity is not rewritten');
    ledger = h.ledger.settle(first.ledger, first.report);
    const chunk = h.ledger.nextReport(ledger)!;
    assert.equal(chunk.report.attribution, 'unlinked');
    assert.equal(chunk.report.bytesDown, h.ledger.MAX_REPORT_BYTES);
    await h.ledger.saveLedger(chunk.ledger);
    const replay = h.ledger.nextReport(await h.ledger.loadLedger())!;
    assert.deepEqual(replay.report, chunk.report);
    const tail = h.ledger.nextReport(h.ledger.settle(replay.ledger, replay.report))!;
    assert.equal(tail.report.attribution, 'unlinked');
    assert.equal(tail.report.bytesDown, 9);
    assert.notEqual(tail.report.seq, chunk.report.seq);
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
      JSON.stringify({ ...saved, entries: [{ ...saved.entries[0], attribution: 'unlinked' }] }),
      JSON.stringify({ ...saved, context: { sessionId: 'saved', subscriptionId: null, attribution: 'invalid' } }),
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

  it('recovers only a legacy null context session while preserving counters and frozen report identities', async () => {
    const h = await services();
    const queued = h.ledger.accumulate(h.ledger.emptyLedger(), { up: 17, down: 29 }, {
      subscriptionId: 'normal', configId: 'normal', sessionId: 'already-sent',
    });
    const original = JSON.stringify({ ...queued,
      context: { subscriptionId: 'trial', configId: 'trial', sessionId: null },
    });
    h.state.storage.set('@sxb_usage_ledger', original);
    const recovered = await h.ledger.loadLedger();
    assert.equal(recovered.counterUp, 17);
    assert.equal(recovered.counterDown, 29);
    assert.equal(recovered.nextSeq, queued.nextSeq);
    assert.equal(recovered.context?.subscriptionId, 'trial');
    assert.equal(recovered.context?.configId, 'trial');
    assert.match(recovered.context!.sessionId, /^sess_/);
    assert.equal(recovered.entries[0].frozen, true);
    assert.deepEqual(h.ledger.nextReport(recovered)?.report, h.ledger.nextReport(queued)?.report);
    assert.deepEqual(JSON.parse(h.state.storage.get('@sxb_usage_ledger_recovery')!), [original]);
    const reloaded = await h.ledger.loadLedger();
    assert.equal(reloaded.context?.sessionId, recovered.context?.sessionId);
    assert.equal(h.ledger.pendingBytes(reloaded), 46);
  });

  for (const failedKey of ['@sxb_usage_ledger_recovery', '@sxb_usage_ledger']) {
    it(`does not replace the legacy ledger when recovery cannot persist ${failedKey}`, async () => {
      const h = await services();
      const original = JSON.stringify({ ...h.ledger.emptyLedger(),
        context: { subscriptionId: null, configId: 'manual', attribution: 'unlinked', sessionId: null },
      });
      h.state.storage.set('@sxb_usage_ledger', original);
      h.state.beforeWrite = async key => {
        if (key === failedKey) throw new Error('RECOVERY_WRITE_FAILED');
      };
      await assert.rejects(h.ledger.loadLedger(), /RECOVERY_WRITE_FAILED/);
      assert.equal(h.state.storage.get('@sxb_usage_ledger'), original);
      h.state.beforeWrite = undefined;
      const recovered = await h.ledger.loadLedger();
      assert.equal(recovered.context?.attribution, 'unlinked');
      assert.equal(recovered.context?.subscriptionId, null);
      assert.deepEqual(JSON.parse(h.state.storage.get('@sxb_usage_ledger_recovery')!), [original]);
    });
  }

  it('does not repair a null context session if any pending receipt is invalid', async () => {
    const h = await services();
    const original = JSON.stringify({ ...h.ledger.emptyLedger(),
      context: { subscriptionId: 'normal', sessionId: null },
      entries: [{ subscriptionId: 'normal', sessionId: '', seq: 0, up: 17, down: 29 }],
    });
    h.state.storage.set('@sxb_usage_ledger', original);
    await assert.rejects(h.ledger.loadLedger(), error =>
      error instanceof h.ledger.UsageLedgerReadError && error.detail === 'entry_session');
    assert.equal(h.state.storage.get('@sxb_usage_ledger'), original);
    assert.equal(h.state.storage.has('@sxb_usage_ledger_recovery'), false);
  });

  it('repairs explicit null report IDs but never rewrites valid frozen receipts', async () => {
    const h = await services();
    const original = JSON.stringify({
      initialized: true, counterUp: 10, counterDown: 18, nextSeq: 2,
      context: { subscriptionId: 'trial', configId: 'trial', sessionId: null },
      entries: [
        { subscriptionId: 'normal', configId: 'normal', sessionId: 'accepted', seq: 0, up: 3, down: 7, frozen: true },
        { subscriptionId: 'trial', configId: 'trial', sessionId: null, seq: 1, up: 7, down: 11, frozen: true },
      ],
    });
    h.state.storage.set('@sxb_usage_ledger', original);
    const recovered = await h.ledger.loadLedger();
    assert.equal(recovered.entries[0].sessionId, 'accepted');
    assert.match(recovered.entries[1].sessionId, /^sess_[0-9a-f-]{36}$/);
    assert.equal(recovered.entries[1].subscriptionId, 'trial');
    assert.equal(recovered.entries[1].seq, 1);
    assert.equal(h.ledger.pendingBytes(recovered), 28);
    assert.equal(recovered.counterUp, 10);
    assert.equal(recovered.counterDown, 18);
    assert.equal((await h.ledger.loadLedger()).entries[1].sessionId, recovered.entries[1].sessionId);
    assert.deepEqual(JSON.parse(h.state.storage.get('@sxb_usage_ledger_recovery')!), [original]);
  });

  it('rejects an invalid writer snapshot before replacing a valid persisted ledger', async () => {
    const h = await services();
    const ledger = h.ledger.accumulate(h.ledger.emptyLedger(), { up: 17, down: 29 }, {
      subscriptionId: 'normal', sessionId: 'valid-session',
    });
    await h.ledger.saveLedger(ledger);
    const original = h.state.storage.get('@sxb_usage_ledger');
    Reflect.set(ledger.context!, 'sessionId', null);
    await assert.rejects(h.ledger.saveLedger(ledger), error =>
      error instanceof h.ledger.UsageLedgerReadError && error.detail === 'context');
    assert.equal(h.state.storage.get('@sxb_usage_ledger'), original);
  });

  it('does not turn duplicate null replay keys into two independently billable reports', async () => {
    const h = await services();
    const entry = { subscriptionId: 'normal', sessionId: null, seq: 0, up: 3, down: 7, frozen: true };
    const original = JSON.stringify({ counterUp: 6, counterDown: 14, nextSeq: 1, entries: [entry, entry] });
    h.state.storage.set('@sxb_usage_ledger', original);
    await assert.rejects(h.ledger.loadLedger(), error =>
      error instanceof h.ledger.UsageLedgerReadError && error.detail === 'entry_sequence');
    assert.equal(h.state.storage.get('@sxb_usage_ledger'), original);
    assert.equal(h.state.storage.has('@sxb_usage_ledger_recovery'), false);
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
  const profiles: { label: string; meta: ProfileIdentity; subscriptionId: string | null }[] = [
    { label: 'legacy backend without subscriptionId', meta: { configId: 'plan-id', source: 'backend' }, subscriptionId: 'plan-id' },
    { label: 'manual alias explicitly linked', meta: { configId: 'local-alias', source: 'manual', subscriptionId: 'plan-id' }, subscriptionId: 'plan-id' },
    { label: 'unlinked manual ID equal to a plan ID', meta: { configId: 'plan-id', source: 'manual' }, subscriptionId: null },
  ];
  for (const { label, meta, subscriptionId } of profiles) {
    it(`uses the same read-only connection/native/ledger attribution for ${label}`, async () => {
      const h = await reporter();
      const original = JSON.stringify(meta);
      Object.freeze(meta);
      const source = readFileSync(path.join(mobile, 'contexts', 'VpnContext.tsx'), 'utf8');
      const start = source.indexOf('        const security = await sessionSecurity();');
      assert.ok(start > 0);
      const connection = source.slice(start, source.indexOf('        requireVpnConsent();', start));
      assert.ok(connection.includes("apiClient.post('/mobile/vpn/session'"));
      assert.ok(connection.includes('sanitizeEngineConfig'));
      const posts: { subscriptionId: string | null; sessionId: string; configId: string }[] = [];
      const env = {
        usageSubscriptionId: h.ledger.usageSubscriptionId,
        currentProfile: { meta }, selectedId: meta.configId,
        sessionSecurity: async () => ({ sessionId: 'synthetic-authority', generation: 1, clientId: 'synthetic-client' }),
        newUsageSessionId: () => 'sess_synthetic-connection',
        apiClient: { post: async (_url: string, body: typeof posts[number]) => { posts.push(body); } },
        sessionIdRef: { current: '' }, configMoteurRef: { current: null },
        configToUse: { protocol: 'vless', host: 'vpn.example.test', port: 443, uuid: 'synthetic-uuid', tls: true },
        appliquerPresentationTls: (config: unknown) => config,
        presentationEssaiRef: { current: 0 }, echelleApplicable: () => false,
        sanitizeEngineConfig, getAccessState: () => ({ authority: { session: 'synthetic-access' } }),
        engineProtocol: 'vless', killSwitch: true, autoReconnect: true,
      };
      const compiled = await transform(`export async function run(env) {
        const {${Object.keys(env).join(',')}} = env;
        ${connection}
        return JSON.parse(optionsJson);
      }`, { loader: 'ts', format: 'cjs' });
      const module = { exports: {} as { run: (input: typeof env) => Promise<Record<string, unknown>> } };
      runInNewContext(compiled.code, { module, exports: module.exports });
      const options = await module.exports.run(env);
      assert.equal(posts.length, 1);
      assert.equal(posts[0].subscriptionId, subscriptionId);
      assert.equal(posts[0].configId, meta.configId);
      assert.equal(options.subscriptionId ?? null, subscriptionId);
      assert.equal(options.managedConfig, subscriptionId !== null);
      h.env.runningProfileRef.current = meta;
      h.env.sessionIdRef.current = posts[0].sessionId;
      h.state.profiles = [meta];
      h.state.stats.lifetimeUploadBytes += 10;
      h.state.stats.lifetimeDownloadBytes += 20;
      h.state.respond = async () => { throw new Error('synthetic offline'); };
      await h.flushUsage();
      assert.equal(h.state.posts.length, 1);
      assert.equal(h.state.posts[0].subscriptionId ?? null, subscriptionId);
      assert.equal(h.state.posts[0].reportMode, subscriptionId ? 'delta' : 'unlinked');
      assert.equal(h.state.posts[0].sessionId, posts[0].sessionId);
      const persisted = await h.ledger.loadLedger();
      assert.equal(persisted.entries[0].subscriptionId, subscriptionId);
      assert.equal(persisted.entries[0].configId, meta.configId);
      assert.equal(h.ledger.pendingBytes(persisted), 30);
      assert.equal(JSON.stringify(meta), original, 'no metadata or ID rewrite');
    });
  }

  it('does not persist a null session when a stop completes during the pre-connect counter read', async () => {
    const h = await reporter();
    h.env.SxbVpnNative.getTrafficStats = async () => {
      h.env.sessionIdRef.current = null;
      return h.state.stats;
    };
    await h.flushUsage({ beforeConnect: true });
    const saved = await h.ledger.loadLedger();
    assert.equal(saved.context?.sessionId, 'native-session-1');
    assert.equal(saved.context?.subscriptionId, 'normal');
    assert.equal(h.state.posts.length, 0);
  });

  it('does not overwrite a new identity session after a delayed native counter read', async () => {
    const h = await reporter();
    await h.flushUsage({ beforeConnect: true });
    const saved = h.storageState.storage.get('@sxb_usage_ledger');
    const reading = deferred(), counters = deferred<any>();
    h.env.SxbVpnNative.getTrafficStats = () => { reading.resolve(); return counters.promise; };
    const previous = h.flushUsage();
    await reading.promise;
    h.state.epoch++;
    h.env.sessionIdRef.current = 'new-identity-session';
    h.env.runningProfileRef.current = { configId: 'trial', subscriptionId: 'trial' };
    counters.resolve({ lifetimeUploadBytes: 11, lifetimeDownloadBytes: 21, usageSessionId: 'native-session-1' });
    await previous;
    assert.equal(h.env.sessionIdRef.current, 'new-identity-session');
    assert.equal(h.storageState.storage.get('@sxb_usage_ledger'), saved);
    assert.equal(h.state.posts.length, 0);
    h.env.SxbVpnNative.getTrafficStats = async () => ({ lifetimeUploadBytes: 11, lifetimeDownloadBytes: 21 });
    await h.flushUsage({ beforeConnect: true });
    const ledger = await h.ledger.loadLedger();
    assert.equal(ledger.entries[0].sessionId, 'native-session-1');
    assert.equal(ledger.entries[0].subscriptionId, 'normal');
    assert.equal(ledger.entries[0].up + ledger.entries[0].down, 30);
    assert.equal(ledger.context?.sessionId, 'new-identity-session');
  });

  it('anchors a connection without waiting for a blocked HTTP report or losing its frozen receipt', async () => {
    const h = await reporter();
    const received = deferred();
    const response = deferred<any>();
    h.state.stats = { lifetimeUploadBytes: 11, lifetimeDownloadBytes: 21 };
    h.state.respond = async () => { received.resolve(); return response.promise; };
    const first = h.flushUsage();
    await received.promise;
    const sent = { ...h.state.posts[0] };
    h.env.runningProfileRef.current = { configId: 'trial', subscriptionId: 'trial' };
    h.env.sessionIdRef.current = 'new-session';
    const preparation = h.flushUsage({ beforeConnect: true });
    try {
      await h.reporting.usageDeadline(preparation, 1_000);
      await first;
      const saved = await h.ledger.loadLedger();
      assert.equal(saved.context?.subscriptionId, 'trial');
      assert.equal(saved.context?.sessionId, 'new-session');
      assert.equal(h.ledger.pendingBytes(saved), 30);
      assert.equal(saved.entries[0].frozen, true);
      assert.equal(h.state.signals[0].aborted, true);
      assert.equal(h.state.posts.length, 1, 'preparation must not send a second HTTP report');
      response.resolve({ data: { ok: true, subscriptionId: 'trial', quotaExhausted: true } });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(h.state.stops, 0, 'a cancelled request must not stop the new connection on late completion');
      assert.equal(h.ledger.pendingBytes(await h.ledger.loadLedger()), 30);
      h.state.respond = async () => ({ data: { duplicate: true, subscriptionId: 'normal' } });
      await h.flushUsage();
      assert.deepEqual({ ...h.state.posts[1] }, sent, 'retry the identical frozen report after an uncertain receipt');
      assert.equal(h.ledger.pendingBytes(await h.ledger.loadLedger()), 0);
    } finally {
      response.resolve({ data: { ok: true, subscriptionId: 'normal' } });
      await Promise.allSettled([first, preparation]);
    }
  });

  it('does not start an HTTP report when connection preparation arrives during a local counter read', async () => {
    const h = await reporter();
    const reading = deferred();
    const counters = deferred<any>();
    let reads = 0;
    h.state.stats = { lifetimeUploadBytes: 11, lifetimeDownloadBytes: 21 };
    h.env.SxbVpnNative.getTrafficStats = async () => {
      if (++reads === 1) { reading.resolve(); return counters.promise; }
      return h.state.stats;
    };
    const first = h.flushUsage();
    await reading.promise;
    const preparation = h.flushUsage({ beforeConnect: true });
    counters.resolve(h.state.stats);
    await Promise.all([first, preparation]);
    assert.equal(h.state.posts.length, 0);
    assert.equal(h.ledger.pendingBytes(await h.ledger.loadLedger()), 30);
    assert.equal(h.env.usagePreparationPendingRef.current, 0);
  });

  it('yields after persisting a frozen report if preparation arrived during that write', async () => {
    const h = await reporter();
    const writing = deferred();
    const release = deferred();
    let writes = 0;
    h.state.stats = { lifetimeUploadBytes: 11, lifetimeDownloadBytes: 21 };
    h.storageState.beforeWrite = async (key: string) => {
      if (key === '@sxb_usage_ledger' && ++writes === 2) {
        writing.resolve();
        await release.promise;
      }
    };
    const first = h.flushUsage();
    await writing.promise;
    const preparation = h.flushUsage({ beforeConnect: true });
    release.resolve();
    await Promise.all([first, preparation]);
    assert.equal(h.state.posts.length, 0);
    assert.equal((await h.ledger.loadLedger()).entries[0].frozen, true);
  });

  async function stoppingProvider() {
    const source = readFileSync(path.join(mobile, 'contexts', 'VpnContext.tsx'), 'utf8');
    const disconnect = source.slice(source.indexOf('  const disconnect = useCallback'), source.indexOf('  const deleteConfig ='));
    const accessStop = source.slice(source.indexOf('  const stopForAccess = useCallback'), source.indexOf('  const stopForAccessRef ='));
    const runtimeStart = source.indexOf('  const syncNativeRuntime = useCallback');
    const runtimeSync = source.slice(runtimeStart, source.indexOf('  useEffect(() => {', runtimeStart));
    const ref = <T,>(current: T) => ({ current });
    const state = {
      vpnState: 'connected', connected: true, connecting: false,
      stop: async () => {}, report: async () => {}, persist: async () => {},
      control: async () => ({ activeProfile: { configId: 'old-profile' } }),
    };
    const env = {
      useCallback: <T,>(callback: T) => callback,
      isConnected: true, isConnecting: false, IS_ANDROID: true,
      connectionAttemptRef: ref(0), pendingAutoConnectRef: ref<string | null>(null),
      disconnectInFlightRef: ref(false), lastStopAttemptRef: ref(0), acceptNativeConnectedRef: ref(true),
      basculeEnCoursRef: ref(false), reportTimerRef: ref(null),
      runningProfileRef: ref<{ configId: string } | null>({ configId: 'old-profile' }),
      sessionBaselineRef: ref({ up: 10, down: 20 }), sessionIdRef: ref<string | null>('old-session'),
      stopWatchdog: () => {}, stopEchelon: () => {}, stopTrafficPolling: () => {},
      startTrafficPolling: () => {}, setTrafficStats: () => {}, DEFAULT_STATS: {},
      getAccessState: () => ({ authority: null }), selectDeviceAccess: () => null,
      blocksDevice: () => false, profileRestriction: () => null,
      syncNativeAccessState: () => state.control(),
      addLog: () => {}, addStepLog: () => {}, t: (key: string) => key,
      CLE_MOTIF_ARRET: {}, clearInterval,
      setIsConnected: (value: boolean) => { state.connected = value; },
      setIsConnecting: (value: boolean) => { state.connecting = value; },
      setVpnState: (value: string) => { state.vpnState = value; },
      SxbVpnNative: { stopVpn: () => state.stop(), getVpnState: async () => 'disconnected' },
      flushUsageRef: ref(() => state.report()),
      AsyncStorage: { setItem: () => state.persist() },
    };
    const compiled = await transform(`
      export function create(env) {
        const { ${Object.keys(env).join(',')} } = env;
        ${disconnect}
        ${accessStop}
        ${runtimeSync}
        return {disconnect,stopForAccess,syncNativeRuntime};
      }`, { loader: 'ts', format: 'cjs' });
    const module = { exports: {} as any };
    runInNewContext(compiled.code, { module, exports: module.exports });
    const api = module.exports.create(env) as {
      disconnect: () => Promise<void>; stopForAccess: () => Promise<void>; syncNativeRuntime: () => Promise<void>;
    };
    const startNext = () => {
      env.connectionAttemptRef.current++;
      env.runningProfileRef.current = { configId: 'new-profile' };
      env.sessionBaselineRef.current = { up: 30, down: 40 };
      env.sessionIdRef.current = 'new-session';
      state.vpnState = 'connecting';
      state.connecting = true;
    };
    return { ...api, env, state, startNext };
  }

  describe('connection generation during an asynchronous stop', () => {
    it('preserves normal stop cleanup and releases its guard even when persistence fails', async () => {
      const normal = await stoppingProvider();
      await normal.disconnect();
      assert.equal(normal.state.vpnState, 'disconnected');
      assert.equal(normal.env.runningProfileRef.current, null);
      assert.equal(normal.env.sessionIdRef.current, null);
      assert.equal(normal.env.disconnectInFlightRef.current, false);
      const failed = await stoppingProvider();
      failed.state.persist = async () => { throw new Error('STORAGE_UNAVAILABLE'); };
      await assert.rejects(failed.disconnect(), /STORAGE_UNAVAILABLE/);
      assert.equal(failed.env.disconnectInFlightRef.current, false);
    });

    it('ignores a stale native profile snapshot after a newer attempt has started', async () => {
      const h = await stoppingProvider();
      const entered = deferred();
      const release = deferred();
      h.state.control = async () => {
        entered.resolve();
        await release.promise;
        return { activeProfile: { configId: 'old-profile' } };
      };
      const sync = h.syncNativeRuntime();
      await entered.promise;
      h.startNext();
      release.resolve();
      await sync;
      assert.equal(h.env.runningProfileRef.current?.configId, 'new-profile');
      assert.equal(h.state.vpnState, 'connecting');
    });

    for (const phase of ['report', 'persist', 'stop'] as const) {
      it(`does not reset a new connection when the old ${phase} finishes`, async () => {
        const h = await stoppingProvider();
        const entered = deferred();
        const release = deferred();
        h.state[phase] = async () => { entered.resolve(); await release.promise; };
        const stopping = phase === 'stop' ? h.stopForAccess() : h.disconnect();
        await entered.promise;
        h.startNext();
        release.resolve();
        await stopping;
        assert.equal(h.state.vpnState, 'connecting');
        assert.equal(h.state.connecting, true);
        assert.equal(h.env.runningProfileRef.current?.configId, 'new-profile');
        assert.equal(h.env.sessionIdRef.current, 'new-session');
        assert.equal(h.env.sessionBaselineRef.current.up, 30);
        assert.equal(h.env.disconnectInFlightRef.current, false);
      });
    }

    it('preserves thirty successive connection generations across delayed stop completions', async () => {
      const h = await stoppingProvider();
      const phases = ['report', 'persist', 'stop'] as const;
      for (let cycle = 0; cycle < 30; cycle++) {
        const phase = phases[cycle % phases.length];
        const entered = deferred();
        const release = deferred();
        h.state[phase] = async () => { entered.resolve(); await release.promise; };
        const stopping = phase === 'stop' ? h.stopForAccess() : h.disconnect();
        await entered.promise;
        h.startNext();
        const sessionId = `session-${cycle}`;
        const configId = `vless-${cycle}`;
        h.env.sessionIdRef.current = sessionId;
        h.env.runningProfileRef.current = { configId };
        release.resolve();
        await stopping;
        assert.equal(h.state.vpnState, 'connecting', `cycle ${cycle}: ${phase}`);
        assert.equal(h.state.connecting, true);
        assert.equal(h.env.sessionIdRef.current, sessionId);
        assert.equal(h.env.runningProfileRef.current?.configId, configId);
        assert.equal(h.env.disconnectInFlightRef.current, false);
        h.state[phase] = async () => {};
      }
      await h.disconnect();
      assert.equal(h.state.vpnState, 'disconnected');
      assert.equal(h.env.sessionIdRef.current, null);
      assert.equal(h.env.runningProfileRef.current, null);
      assert.equal(h.env.disconnectInFlightRef.current, false);
    });

    it('keeps a newer stop guarded when an older stop completes', async () => {
      const h = await stoppingProvider();
      const firstEntered = deferred();
      const firstRelease = deferred();
      h.state.stop = async () => { firstEntered.resolve(); await firstRelease.promise; };
      const first = h.stopForAccess();
      await firstEntered.promise;
      h.startNext();
      h.state.stop = async () => {};
      const secondEntered = deferred();
      const secondRelease = deferred();
      h.state.report = async () => { secondEntered.resolve(); await secondRelease.promise; };
      const second = h.disconnect();
      await secondEntered.promise;
      firstRelease.resolve();
      await first;
      assert.equal(h.env.disconnectInFlightRef.current, true);
      secondRelease.resolve();
      await second;
      assert.equal(h.env.disconnectInFlightRef.current, false);
    });
  });

  it('keeps a late HTTP rejection handled after releasing the cancelled reporter', async () => {
    const h = await services();
    const response = deferred();
    const controller = new AbortController();
    const request = h.reporting.interruptibleUsageRequest(response.promise, controller.signal);
    controller.abort();
    await assert.rejects(request, /VPN_USAGE_PREPARING/);
    response.reject(new Error('LATE_NETWORK_FAILURE'));
    await new Promise(resolve => setImmediate(resolve));
  });

  it('seeds the first offline display from provisioned metadata without a legacy quota key', async () => {
    const h = await reporter();
    h.state.profiles[0] = { configId: 'normal', subscriptionId: 'normal', quotaTotal: 1000, quotaUsed: 7 };
    await h.flushUsage({ beforeConnect: true });
    h.state.stats = { lifetimeUploadBytes: 11, lifetimeDownloadBytes: 21 };
    h.state.respond = async () => { throw new Error('OFFLINE'); };
    await h.flushUsage();
    const projection = h.ledger.quotaProjection(h.env.ledgerRef.current, { subscriptionId: 'normal' });
    assert.equal(projection.accountedUsedBytes, 7);
    assert.equal(projection.pendingBytes, 30, 'real first bytes must be visible before the first acknowledgement');
  });

  it('uses the managed subscription identity rather than the local storage alias', async () => {
    const h = await reporter();
    h.env.runningProfileRef.current = { configId: 'local-alias', source: 'backend' };
    h.state.profiles = [{ configId: 'local-alias', subscriptionId: 'normal', source: 'backend' }];
    h.state.stats = { lifetimeUploadBytes: 11, lifetimeDownloadBytes: 21 };
    await h.flushUsage();
    assert.equal(h.state.posts[0].subscriptionId, 'normal');
    assert.equal(h.env.runningProfileRef.current.subscriptionId, 'normal');
  });

  it('does not turn failure to persist the pre-connect anchor into permission to start', () => {
    const source = readFileSync(path.join(mobile, 'contexts', 'VpnContext.tsx'), 'utf8');
    assert.doesNotMatch(source, /avecDelai\(flushUsageRef\.current\(\{ beforeConnect: true \}\)/);
  });

  it('does not erase rejected ownership evidence as a success-shaped receipt', async () => {
    const h = await reporter();
    h.state.stats = { lifetimeUploadBytes: 11, lifetimeDownloadBytes: 21 };
    h.state.respond = async () => { throw { response: { status: 403, data: { code: 'OWNERSHIP_FORBIDDEN' } } }; };
    await h.flushUsage();
    assert.equal(h.ledger.pendingBytes(await h.ledger.loadLedger()), 30);
  });

  it('keeps refused reports durable without blocking another owned subscription', async () => {
    const h = await reporter();
    h.env.ledgerRef.current = h.ledger.accumulate(h.env.ledgerRef.current, { up: 11, down: 21 }, {
      configId: 'trial', subscriptionId: 'trial', sessionId: 'removed-trial',
    });
    h.state.stats = { lifetimeUploadBytes: 13, lifetimeDownloadBytes: 24 };
    h.state.respond = async (body: any) => {
      if (body.subscriptionId === 'trial') throw { response: { status: 403, data: { code: 'OWNERSHIP_FORBIDDEN' } } };
      return { data: { ok: true, subscriptionId: 'normal', quotaUsedBytes: 5, quotaTotalBytes: 1000 } };
    };
    await h.flushUsage();
    const saved = await h.ledger.loadLedger();
    assert.equal(h.state.posts.length, 2);
    assert.equal(h.ledger.pendingBytes(saved), 30);
    assert.equal(saved.entries[0].subscriptionId, 'trial');
    assert.equal(saved.entries[0].frozen, true);
    assert.equal(h.ledger.nextReport(saved), null);
    assert.equal((await h.offline.loadQuotaData('normal'))?.usedQuota, 5);
    assert.ok(h.ledger.nextAttemptDelay(saved) > 250_000);
  });

  it('does not bypass reporting backoff on a native or foreground wake', async () => {
    const h = await reporter();
    h.state.stats = { lifetimeUploadBytes: 11, lifetimeDownloadBytes: 21 };
    h.state.respond = async () => { throw { response: { status: 429 } }; };
    await h.flushUsage();
    h.state.stats = { lifetimeUploadBytes: 13, lifetimeDownloadBytes: 24 };
    await h.flushUsage({ final: true });
    assert.equal(h.state.posts.length, 1);
    assert.equal(h.ledger.pendingBytes(await h.ledger.loadLedger()), 35);
  });

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
    const persisted = await h.ledger.loadLedger();
    assert.equal(persisted.entries[0].sessionId, 'native-session-1');
    assert.equal(persisted.entries[0].frozen, true);
    assert.equal(persisted.entries[0].up + persisted.entries[0].down, 10);
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

  it('does not inherit a backend subscription when switching to an unlinked manual profile', async () => {
    const h = await reporter();
    h.env.ledgerRef.current = { ...h.env.ledgerRef.current, context: {
      configId: 'normal', subscriptionId: 'normal', sessionId: 'old-backend',
    } };
    h.state.profiles.push({ configId: 'manual', source: 'manual' });
    h.env.runningProfileRef.current = { configId: 'manual' };
    h.env.activeConfigIdRef.current = 'manual';
    h.state.stats = { lifetimeUploadBytes: 3, lifetimeDownloadBytes: 4 };
    await h.flushUsage({ beforeConnect: true });
    const anchored = await h.ledger.loadLedger();
    assert.equal(anchored.context?.configId, 'manual');
    assert.equal(anchored.context?.subscriptionId, null);
    assert.equal(anchored.context?.attribution, 'unlinked');
    h.state.respond = async (body: any) => {
      if (!body.subscriptionId) {
        throw new Error('OFFLINE');
      }
      return { data: { ok: true, subscriptionId: 'normal', quotaUsedBytes: 5, quotaTotalBytes: 1000 } };
    };
    h.state.stats = { lifetimeUploadBytes: 7, lifetimeDownloadBytes: 9 };
    await h.flushUsage();
    assert.equal(h.state.posts.length, 2);
    assert.equal(h.state.posts[0].subscriptionId, 'normal');
    assert.equal(h.state.posts[0].bytesUp + h.state.posts[0].bytesDown, 5);
    assert.equal(h.state.posts[1].subscriptionId, undefined);
    assert.equal(h.state.posts[1].reportMode, 'unlinked');
    assert.equal(h.state.posts[1].bytesUp + h.state.posts[1].bytesDown, 9);
    const persisted = await h.ledger.loadLedger();
    assert.equal(persisted.entries.length, 1);
    assert.equal(persisted.entries[0].configId, 'manual');
    assert.equal(persisted.entries[0].subscriptionId, null);
    assert.equal(persisted.entries[0].attribution, 'unlinked');
    assert.equal(h.ledger.pendingBytes(persisted), 9);
    h.env.ledgerRef.current = null;
    h.env.usageRetryAtRef.current = 0;
    h.state.respond = async () => ({ data: { ok: true, subscriptionId: null } });
    await h.flushUsage();
    assert.deepEqual(h.state.posts[2], h.state.posts[1]);
    assert.equal(h.ledger.pendingBytes(await h.ledger.loadLedger()), 0);
    assert.equal(h.state.stops, 0);
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

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const source = readFileSync(new URL('../contexts/VpnContext.tsx', import.meta.url), 'utf8');

function listenerFixture() {
  const start = source.indexOf("    const stateSub = vpnEmitter.addListener('onVpnStateChange'");
  const end = source.indexOf("    const logSub =", start);
  assert.ok(start >= 0 && end > start);
  const ref = <T,>(current: T) => ({ current });
  const state = { connected: true, connecting: false, vpnState: 'connected', permission: true, writes: [] as unknown[],
    control: async () => ({ activeProfile: null }) };
  let listener: (event: unknown) => void = () => {};
  const env = {
    vpnEmitter: { addListener: (_name: string, callback: typeof listener) => { listener = callback; return { remove() {} }; } },
    vpnState: 'connected', vpnStateRef: ref('connected'),
    useCallback: <T,>(callback: T) => callback,
    connectionAttemptRef: ref(4), nativeStateSequenceRef: ref(5), disconnectInFlightRef: ref(false),
    pendingAutoConnectRef: ref<string | null>('old-profile'), echelonRelanceRef: ref(true),
    basculeEnCoursRef: ref(true), acceptNativeConnectedRef: ref(true), autoReconnectRef: ref(true),
    vpnPermissionRevokedRef: ref(false),
    runningProfileRef: ref({ configId: 'new-profile' }), presentationEssaiRef: ref(0),
    sessionStartRef: ref(0), sessionIdRef: ref<string | null>('old-session'), sessionBaselineRef: ref({ up: 0, down: 0 }),
    getAccessState: () => ({ authority: { session: 'new-access' } }), selectDeviceAccess: () => null,
    blocksDevice: () => false, profileRestriction: () => null, motifPourRestriction: () => 'profil_retire',
    stopForAccess: async () => {}, reportAccessSyncError: () => {}, noterProgresMoteur: () => {},
    stopWatchdog: () => {}, stopEchelon: () => {}, startTrafficPolling: () => {}, stopTrafficPolling: () => {},
    addLog: () => {}, addStepLog: () => {}, legacyDebugLog: () => {}, rearmerWatchdogRef: ref<unknown>(null),
    setVpnState: (value: string) => { state.vpnState = value; env.vpnStateRef.current = value; },
    setIsConnected: (value: boolean) => { state.connected = value; },
    setIsConnecting: (value: boolean) => { state.connecting = value; },
    setHasVpnPermission: (value: boolean) => { state.permission = value; },
    setTrafficStats: () => {}, DEFAULT_STATS: {}, clearInterval,
    AsyncStorage: { setItem: async (key: string, value: string) => { state.writes.push([key, value]); } },
    SxbVpnNative: { stopVpn: async () => {}, getTrafficStats: async () => ({}), getVpnState: async () => 'connected',
      getVpnRuntimeState: async () => ({ state: 'connected', stateSequence: 5, errorCode: undefined as string | undefined }) },
    IS_ANDROID: true, CLE_PRESENTATION: 'fixture', newUsageSessionId: () => 'fixture-session',
    refreshAccountState: async () => {}, avancerEchelon: () => false, analyserErreurVpn: () => ({ cle: 'error', code: 'error' }),
    syncNativeAccessState: () => state.control(),
    privacyEncryptionMessage: 'fixture', flushUsageRef: ref(async () => {}),
  };
  const compiled = transformSync(`
    module.exports = function(env) {
      const { ${Object.keys(env).join(',')} } = env;
      ${source.slice(source.indexOf('  const onVpnPermissionLost = useCallback'), source.indexOf('  // ── Listener événements natifs VPN'))}
      ${source.slice(start, end)}
      ${source.slice(source.indexOf('  const syncNativeRuntime = useCallback'), source.indexOf('  useEffect(() => {', source.indexOf('  const syncNativeRuntime = useCallback')))}
      return { syncNativeRuntime };
    };`, { loader: 'ts', format: 'cjs' });
  const module = { exports: (_env: typeof env) => ({ syncNativeRuntime: async () => {} }) };
  runInNewContext(compiled.code, { module, exports: module.exports, Date });
  const api = module.exports(env);
  return { state, env, ...api, emit: (event: unknown) => listener(event) };
}

test('permission loss is global and cannot be hidden by a profile switch, TLS ladder or stale access scope', () => {
  const h = listenerFixture();
  h.emit({ state: 'disconnected', errorCode: 'VPN_PERMISSION_REQUIRED',
    configId: 'old-profile', accessSession: 'old-access', stateSequence: 6 });
  assert.equal(h.state.connected, false, 'another VPN must remove the green state synchronously');
  assert.equal(h.state.connecting, false);
  assert.equal(h.state.vpnState, 'disconnected');
  assert.equal(h.state.permission, false);
  assert.equal(h.env.pendingAutoConnectRef.current, null);
  assert.equal(h.env.basculeEnCoursRef.current, false);
  assert.equal(h.env.echelonRelanceRef.current, false);
  assert.equal(h.env.acceptNativeConnectedRef.current, false);
  assert.ok(h.state.writes.some(value => JSON.stringify(value) === '["@sxb_vpn_connected","false"]'));
});

test('foreground ownership snapshot removes green before a slow access-state read can start', async () => {
  const h = listenerFixture();
  h.env.SxbVpnNative.getVpnRuntimeState = async () => ({
    state: 'disconnected', stateSequence: 6, errorCode: 'VPN_PERMISSION_REQUIRED',
  });
  let accessRead = false;
  h.state.control = async () => { accessRead = true; throw new Error('SHOULD_NOT_WAIT_FOR_ACCESS_IO'); };
  await h.syncNativeRuntime();
  assert.equal(accessRead, false);
  assert.equal(h.state.connected, false);
  assert.equal(h.state.permission, false);
});

test('an old connected snapshot completing its access read after takeover cannot restore green', async () => {
  const h = listenerFixture();
  h.env.basculeEnCoursRef.current = false;
  let release: () => void = () => {};
  const delayed = new Promise<void>(resolve => { release = resolve; });
  h.state.control = async () => { await delayed; return { activeProfile: null }; };
  const read = h.syncNativeRuntime();
  await new Promise(resolve => setImmediate(resolve));
  h.emit({ state: 'disconnected', errorCode: 'VPN_PERMISSION_REQUIRED', stateSequence: 6 });
  release();
  await read;
  assert.equal(h.state.connected, false);
  assert.equal(h.state.vpnState, 'disconnected');
});

test('a connected event from before takeover cannot restore green, even if delivered after it', () => {
  const h = listenerFixture();
  h.emit({ state: 'disconnected', errorCode: 'VPN_PERMISSION_REQUIRED', stateSequence: 6 });
  h.emit({ state: 'connected', stateSequence: 5, configId: 'new-profile', accessSession: 'new-access' });
  assert.equal(h.state.connected, false);
  assert.equal(h.state.vpnState, 'disconnected');
});

test('duplicate takeover never consumes a new logical connection generation twice', () => {
  const h = listenerFixture();
  h.emit({ state: 'disconnected', errorCode: 'VPN_PERMISSION_REQUIRED', stateSequence: 6 });
  const attempt = h.env.connectionAttemptRef.current;
  h.emit({ state: 'disconnected', errorCode: 'VPN_PERMISSION_REQUIRED', stateSequence: 6 });
  assert.equal(h.env.connectionAttemptRef.current, attempt);
  assert.equal(h.state.connected, false);
});

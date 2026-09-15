import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const native = (name: string) => readFileSync(
  path.resolve(import.meta.dirname, '..', 'modules', 'android-native', name), 'utf8',
);
const policy = native('SxbReconnectPolicy.kt');
const manager = native('AutoReconnectManager.kt');
const service = native('SxbVpnService.kt');
const keepAlive = native('SxbSshKeepAlive.kt');

function constant(source: string, name: string): number | undefined {
  const match = source.match(new RegExp(`const val ${name} = ([\\d_]+)L?`));
  return match ? Number(match[1].replaceAll('_', '')) : undefined;
}

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing native section: ${start}`);
  return source.slice(from, to);
}

describe('native recovery source contracts (JVM behavior has its own gate)', () => {
  it('removes the measured 5000 ms policy wait after a healthy session', () => {
    const base = constant(policy, 'BASE_RETRY_DELAY_MS');
    const healthy = constant(policy, 'FAST_RETRY_DELAY_MS') ?? base;
    assert.equal(base, 5_000, 'Initial/unproven failures keep their existing backoff');
    assert.equal(healthy, 250, `Healthy-session retry still waits ${healthy} ms`);
    assert.match(manager, /retryDelayMs\(attempt, state\.lastSessionUpMs\)/);
    assert.match(policy, /lastSessionUpMs >= SESSION_HEALTHY_MS/);
    assert.equal(constant(policy, 'SESSION_HEALTHY_MS'), 30_000);
    assert.equal(constant(policy, 'MAX_RETRIES'), 5);
    assert.equal(constant(policy, 'MAX_RETRY_DELAY_MS'), 60_000);
  });

  it('does not turn briefly connected flapping into unlimited fresh budgets', () => {
    const connected = section(manager, 'fun onConnected()', 'fun onNetworkAvailable()');
    assert.doesNotMatch(connected, /failedAttempts\.set\(0\)/);
    assert.doesNotMatch(connected, /resumeStreak\.set\(0\)/);
    assert.match(connected, /connectedAtMs\.set\(elapsedMs\(\)\)/);
    const healthy = section(manager, 'if (state.lastSessionUpMs >=', 'val attempt =');
    assert.match(healthy, /failedAttempts\.set\(0\)/);
    assert.match(healthy, /resumeStreak\.set\(0\)/);
  });

  it('retains the only network-return event even inside the debounce window', () => {
    const available = section(policy, 'private fun onNetworkAvailable', 'private fun onTunnelLost');
    const offline = available.indexOf('!state.networkAvailable -> Decision.WAIT_FOR_NETWORK');
    const awaited = available.indexOf('state.awaitingNetwork -> Decision.RESUME');
    const interval = available.indexOf('state.sinceLastEventMs < MIN_EVENT_INTERVAL_MS');
    assert.ok(offline >= 0 && offline < awaited && awaited < interval);
    assert.match(manager, /private fun networkPresent\(\) = runCatching \{ hasNetwork\(\) \}\.getOrDefault\(false\)/);
  });

  it('serializes reconnect callbacks and rejects stale or cancelled timer generations', () => {
    assert.match(manager, /reconnectMutex\.withLock/);
    assert.match(manager, /CoroutineStart\.LAZY/);
    assert.match(manager, /generation != scheduleGeneration/);
    const begin = section(manager, 'private fun beginAttempt(', 'fun cancel()');
    const network = begin.indexOf('if (!networkPresent())');
    const consume = begin.indexOf('failedAttempts.incrementAndGet()');
    assert.ok(network >= 0 && consume > network);
    assert.match(begin, /!isEnabled\(\)/);
    assert.match(begin, /isTunnelUp\(\)/);
  });

  it('rechecks stop and connectivity after draining, without bypassing access checks', () => {
    const reconnect = section(service, 'onReconnect =', 'onGiveUp =');
    const drain = reconnect.indexOf('if (drainTunnelBeforeReconnect())');
    assert.ok(drain >= 0);
    const drained = reconnect.slice(drain);
    const stop = drained.indexOf('!autoReconnect.isEnabled()');
    const network = drained.indexOf('!hasUsableNetwork()');
    const dispatchAt = drained.indexOf('dispatchProtocol(');
    assert.ok(stop >= 0 && network >= 0 && dispatchAt > stop && dispatchAt > network);
    assert.match(drained, /autoReconnect\.onNetworkLost\(false\)/);
    const dispatch = section(service, 'private fun dispatchProtocol(', 'private fun startDnsttProtectServer(');
    assert.match(dispatch, /SxbAccessControl\.checkStart\(this, JSONObject\(json\)\)/);
    assert.match(service, /autoReconnect\.markStopped\("user_stop"\)/);
    const fail = section(service, 'private fun failVpn(', 'private fun startConnectionWatchdog(');
    assert.match(fail, /if \(code == "AUTH_FAILED" && ::autoReconnect\.isInitialized\) autoReconnect\.markStopped\(code\)/);
    assert.match(service, /fun interruptForAccess\(\) \{\s*disableAutoReconnect\(\)/);
  });

  it('keeps SSH liveness tolerance and reports detection separately from retry delay', () => {
    const interval = constant(keepAlive, 'INTERVAL_MS');
    const count = constant(keepAlive, 'COUNT_MAX');
    const poll = constant(keepAlive, 'POLL_INTERVAL_MS');
    assert.equal(interval, 10_000);
    assert.equal(count, 3);
    assert.equal(poll, 500);
    assert.equal(poll! + constant(policy, 'FAST_RETRY_DELAY_MS')!, 750);
    assert.equal(interval! * (count! + 1) + poll!, 40_500);
    assert.match(service, /s\.setServerAliveInterval\(SxbSshKeepAlive\.INTERVAL_MS\)/);
    assert.match(service, /s\.setServerAliveCountMax\(SxbSshKeepAlive\.COUNT_MAX\)/);
    assert.match(service, /Thread\.sleep\(SxbSshKeepAlive\.POLL_INTERVAL_MS\)/);
  });

  it('restarts traffic accounting after draining, before the recovered tunnel starts', () => {
    const callback = section(service, 'onReconnect = reconnect@', 'onGiveUp =');
    const drain = callback.indexOf('if (drainTunnelBeforeReconnect())');
    const accounting = callback.indexOf('if (!startTrafficAccounting()) return@reconnect');
    const dispatch = callback.indexOf('dispatchProtocol(');
    assert.ok(drain >= 0 && accounting > drain && dispatch > accounting);
    assert.match(service, /if \(!startTrafficAccounting\(\)\) return START_NOT_STICKY/);
    assert.match(service, /cleanup\(stopService = !killSwitchEnabled, keepRunning = killSwitchEnabled\)/);
  });
});

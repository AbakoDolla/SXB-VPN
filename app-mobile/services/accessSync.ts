import { AppState, NativeEventEmitter, NativeModules } from 'react-native';
import apiClient, { API_BASE_URL } from './apiClient';
import * as configStore from './configStore';
import { saveQuotaData } from './offlineStorage';
import { provisionAndStore, ProvisioningError } from './provisionClient';
import {
  accessIssueFromError, blocksDevice, blocksProfile, deviceAccess, isRecord, managedProfile,
  profileRestriction, responseInfo, retryDelay, type AccessAuthority, type ProfileIdentity,
} from './accessPolicy';
import {
  applyAccessIssue, applyAccessSnapshot, captureAccessAuthority, getAccessState,
  subscribeAccessState, syncNativeAccessState, requireDeviceAccess,
} from './accessState';
import { accessRequestStamp, currentAccessRequest, currentIdentityRequest, subscribeAccessFailures } from './accessEvents';
import { getPrivacyConsent, requireVpnConsent, subscribePrivacyConsent } from './privacyConsent';
import { nativeAccess, storeNativeAccessTicket } from './nativeAccess';
import type { VpnConnection } from '../types/api';

type Runtime = {
  activeProfile(): ProfileIdentity | null;
  stop(): Promise<void>;
  changed(): Promise<void>;
};
let runtime: Runtime | null = null;
let reconciliation: Promise<void> = Promise.resolve();
let refresh: Promise<VpnConnection[]> | null = null;
let controlRequest: { promise: Promise<boolean>; controller: AbortController } | null = null;
let controlSupported: boolean | null = null;
let ticketRetryAt = 0;
let ticketRequest: Promise<void> | null = null;
let nativeHandoffUntil = 0;
let lifecycle = 0;
let wakeObservation: (() => void) | null = null;
let connections: VpnConnection[] = [];
export const getRemoteConnections = () => connections;

export function storeValue<T>(result: configStore.StoreResult<T>): T | undefined {
  if (result.status === 'error') throw result.error ?? new Error('CONFIG_STORAGE_UNAVAILABLE');
  return result.value;
}

export function registerAccessRuntime(next: Runtime): () => void {
  runtime = next;
  void reconcileAccess().catch(reportAccessSyncError);
  return () => { if (runtime === next) runtime = null; };
}

export function reportAccessSyncError(error: unknown): void {
  const issue = accessIssueFromError(error);
  const status = responseInfo(error).status;
  // Never log Axios bodies, provisioning objects or tokens.
  console.warn('[Access] Synchronization deferred:', issue?.code ?? status ?? (error instanceof Error && /^ACCESS_/.test(error.message) ? error.message : 'UNAVAILABLE'));
}

/** Stop first, then remove only revoked/deleted payloads. Suspensions keep their ciphertext. */
export function reconcileAccess(): Promise<void> {
  const epoch = lifecycle;
  const operation = reconciliation.then(async () => {
    const authority = getAccessState().authority;
    if (!authority || epoch !== lifecycle) return;
    const currentRuntime = runtime;
    const active = currentRuntime?.activeProfile();
    if (currentRuntime && active && (blocksDevice(deviceAccess(authority)) || profileRestriction(authority, active))) {
      await currentRuntime.stop();
    }
    if (epoch !== lifecycle || getAccessState().authority !== authority) return;
    const entries = storeValue(await configStore.list()) ?? [];
    for (const entry of entries) {
      if (epoch !== lifecycle || getAccessState().authority !== authority) return;
      const restriction = profileRestriction(authority, entry);
      if (restriction?.status === 'revoked' || restriction?.status === 'deleted') {
        storeValue(await configStore.remove(entry.configId));
        continue;
      }
      const remote = authority.snapshot?.subscriptions.find(item => item.id === (entry.subscriptionId || entry.configId));
      if (remote && managedProfile(entry)) {
        storeValue(await configStore.updateMetadata(entry.configId, { name: remote.name, accessStatus: remote.status }));
        await saveQuotaData({ configId: entry.configId, totalQuota: remote.quotaTotalBytes,
          usedQuota: remote.quotaUsedBytes, expiryDate: remote.expireAt });
      } else if (restriction) {
        storeValue(await configStore.updateMetadata(entry.configId, { accessStatus: restriction.status }));
      }
    }
    await currentRuntime?.changed();
  });
  reconciliation = operation.catch(reportAccessSyncError);
  return operation;
}

function parseConnections(data: unknown): VpnConnection[] {
  if (!isRecord(data) || !Array.isArray(data.connections)) throw new Error('ACCESS_CONNECTIONS_INVALID');
  const ids = new Set<string>();
  return data.connections.map((entry): VpnConnection => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) ||
        typeof entry.name !== 'string' || typeof entry.status !== 'string' ||
        !['active', 'suspended', 'revoked', 'deleted', 'expired', 'exhausted'].includes(entry.status) ||
        !isRecord(entry.quota) || typeof entry.quota.totalBytes !== 'number' ||
        typeof entry.quota.usedBytes !== 'number') throw new Error('ACCESS_CONNECTIONS_INVALID');
    ids.add(entry.id);
    const totalBytes = entry.quota.totalBytes;
    const usedBytes = entry.quota.usedBytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || !Number.isSafeInteger(usedBytes) || usedBytes < 0) throw new Error('ACCESS_CONNECTIONS_INVALID');
    return {
      id: entry.id, name: entry.name, status: entry.status,
      displayProtocol: typeof entry.displayProtocol === 'string' ? entry.displayProtocol : '',
      technicalProtocol: typeof entry.technicalProtocol === 'string' ? entry.technicalProtocol : '',
      dataToken: typeof entry.dataToken === 'string' ? entry.dataToken : '',
      quota: { totalBytes, usedBytes, totalGB: totalBytes / 1024 ** 3, usedGB: usedBytes / 1024 ** 3,
        remainingGB: Math.max(0, totalBytes - usedBytes) / 1024 ** 3 },
      duration: typeof entry.duration === 'number' ? entry.duration : 0,
      expiresAt: typeof entry.expiresAt === 'string' ? entry.expiresAt : null,
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
      configVersion: typeof entry.configVersion === 'number' ? entry.configVersion : 1,
      configHash: typeof entry.configHash === 'string' ? entry.configHash : null,
    };
  });
}

async function reconcileLegacyConnections(remote: VpnConnection[], authority: AccessAuthority): Promise<void> {
  // The legacy memory fallback returns [], so absence here is never a deletion.
  for (const entry of remote) {
    if (getAccessState().authority?.session !== authority.session) return;
    if (blocksProfile(entry.status)) {
      const stamp = captureAccessAuthority();
      if (stamp) await applyAccessIssue({
        code: entry.status === 'suspended' ? 'CONFIG_SUSPENDED' : entry.status === 'revoked' ? 'CONFIG_REVOKED' : 'CONFIG_DELETED',
        scope: 'subscription', temporary: entry.status === 'suspended', subscriptionId: entry.id,
      }, stamp, storeValue(await configStore.list()) ?? []);
    }
    // Only the new authoritative snapshot can lift a previously known block.
  }
}

export async function refreshAccessState(wait = false, signal?: AbortSignal, timeout = 35_000): Promise<boolean> {
  requireVpnConsent();
  if (!getAccessState().authority) return false;
  if (Date.now() < nativeHandoffUntil) return true;
  if (controlRequest) {
    if (wait) return controlRequest.promise;
    controlRequest.controller.abort();
    try { await controlRequest.promise; }
    catch (error) { if (responseInfo(error).status) reportAccessSyncError(error); }
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  const promise = (async () => {
    const native = await syncNativeAccessState();
    if (native?.observing) return true; // One HTTP reader while the foreground service owns observation.
    const stamp = captureAccessAuthority();
    if (!stamp) return false;
    const snapshot = getAccessState().authority?.snapshot;
    const params = wait && snapshot ? { revision: snapshot.revision, wait: 25 } : undefined;
    try {
      const response = await apiClient.get('/mobile/access-state', { params, signal: controller.signal, timeout });
      if (controller.signal.aborted) return false;
      const profiles = storeValue(await configStore.list()) ?? [];
      const applied = await applyAccessSnapshot(response.data, stamp, profiles);
      controlSupported = true;
      await reconcileAccess();
      return applied;
    } catch (error) {
      const status = responseInfo(error).status;
      if ((status === 404 || status === 405 || status === 501) && !accessIssueFromError(error)) {
        controlSupported = false;
        return false; // Endpoint not deployed; never turn a route-level 404 into logout.
      }
      throw error;
    }
  })();
  const request = { promise, controller };
  controlRequest = request;
  try { return await promise; }
  finally {
    signal?.removeEventListener('abort', cancel);
    if (controlRequest === request) controlRequest = null;
  }
}

export function refreshMobileConfigs(): Promise<VpnConnection[]> {
  if (refresh) return refresh;
  const epoch = lifecycle;
  const identity = accessRequestStamp();
  const operation = (async () => {
    requireVpnConsent();
    try { await refreshAccessState(); }
    catch (error) { reportAccessSyncError(error); }
    requireDeviceAccess();
    const requestStamp = accessRequestStamp();
    const response = await apiClient.get('/mobile/connections');
    if (epoch !== lifecycle || !currentIdentityRequest(identity)) return [];
    const remote = parseConnections(response.data);
    // A native snapshot may have arrived while the legacy list was in flight.
    if (!currentAccessRequest(requestStamp)) return connections;
    const authority = getAccessState().authority;
    if (controlSupported === false && authority) await reconcileLegacyConnections(remote, authority);
    const dismissed = new Set(storeValue(await configStore.listDismissed()) ?? []);
    connections = remote.filter(entry => !dismissed.has(entry.id));
    await reconcileAccess();
    for (const entry of connections) {
      if (epoch !== lifecycle || !currentIdentityRequest(identity)) return [];
      const current = getAccessState().authority;
      if (!current || blocksDevice(deviceAccess(current))) break;
      const restriction = profileRestriction(current, {
        configId: entry.id, subscriptionId: entry.id, source: 'backend', configHash: entry.configHash,
      });
      if (restriction || entry.status !== 'active' || !entry.dataToken) continue;
      const stored = storeValue(await configStore.get(entry.id));
      const changed = stored && (entry.configHash ? stored.meta.configHash !== entry.configHash : stored.meta.configVersion !== entry.configVersion);
      if (!stored || changed) {
        try { await provisionAndStore(entry.dataToken, current.deviceId); }
        catch (error) {
          if (error instanceof ProvisioningError) console.warn('[Access] Provisioning deferred:', error.diagnostic.code);
          else reportAccessSyncError(error);
        }
      }
      if (controlSupported === false) {
        storeValue(await configStore.updateMetadata(entry.id, { name: entry.name, accessStatus: entry.status as 'active' }));
        await saveQuotaData({ configId: entry.id, totalQuota: entry.quota.totalBytes,
          usedQuota: entry.quota.usedBytes, expiryDate: entry.expiresAt });
      }
    }
    await reconcileAccess();
    return connections;
  })();
  refresh = operation;
  void operation.finally(() => { if (refresh === operation) refresh = null; }).catch(() => { /* Caller handles the error. */ });
  return operation;
}

async function refreshNativeTicket(): Promise<void> {
  if (!nativeAccess() || controlSupported === false || ticketRequest || Date.now() < ticketRetryAt) return;
  const authority = getAccessState().authority;
  if (!authority || blocksDevice(deviceAccess(authority))) return;
  const native = getAccessState().native;
  if (native?.ticketStatus === 'ready' && native.ticketExpiresAt && Date.parse(native.ticketExpiresAt) - Date.now() > 3600_000) return;
  const stamp = accessRequestStamp();
  // Missing/invalid tickets cannot trigger an unbounded 401 acquisition loop.
  ticketRetryAt = Date.now() + 5 * 60_000;
  const operation = (async () => {
    const response = await apiClient.post('/mobile/access-ticket', {});
    requireVpnConsent();
    if (!currentIdentityRequest(stamp) || authority.session !== getAccessState().authority?.session) return;
    if (!isRecord(response.data) || typeof response.data.ticket !== 'string' || typeof response.data.expiresAt !== 'string') throw new Error('ACCESS_TICKET_INVALID');
    await storeNativeAccessTicket(API_BASE_URL, response.data.ticket, response.data.expiresAt, authority.session);
    await syncNativeAccessState();
  })();
  ticketRequest = operation;
  try { await operation; }
  catch (error) {
    ticketRetryAt = Date.now() + Math.max(5 * 60_000, retryDelay(0, responseInfo(error).retryAfter));
    reportAccessSyncError(error);
  } finally { if (ticketRequest === operation) ticketRequest = null; }
}

export async function prepareNativeAccess(): Promise<void> {
  if (nativeAccess()) {
    nativeHandoffUntil = Date.now() + 15_000;
    const pending = controlRequest;
    if (pending) {
      pending.controller.abort();
      try { await pending.promise; }
      catch (error) { if (responseInfo(error).status) reportAccessSyncError(error); }
    }
  }
  await refreshNativeTicket();
  requireDeviceAccess();
}

/** Owns foreground observation; Android continues independently only while its VPN service runs. */
export function startAccessObservation(): () => void {
  const epoch = ++lifecycle;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let running = false;
  let rerun = false;
  const controller = new AbortController();
  const schedule = (delay: number) => {
    if (timer) clearTimeout(timer);
    if (!stopped && AppState.currentState === 'active' && getPrivacyConsent().vpn) timer = setTimeout(tick, delay);
  };
  const tick = async () => {
    if (running) { rerun = true; return; }
    if (stopped || AppState.currentState !== 'active' || !getPrivacyConsent().vpn) return;
    running = true;
    let delay = 1000;
    try {
      await refreshAccessState(controlSupported !== false, controller.signal);
      if (controlSupported === false) {
        await refreshMobileConfigs();
        delay = 30_000;
      } else {
        await refreshNativeTicket();
        if (getAccessState().native?.observing) delay = 30_000;
      }
      failures = 0;
    } catch (error) {
      if (!controller.signal.aborted) reportAccessSyncError(error);
      delay = ++failures >= 6 ? 300_000 : retryDelay(failures, responseInfo(error).retryAfter);
    } finally {
      running = false;
      if (rerun) { rerun = false; delay = 1000; }
      schedule(delay);
    }
  };
  const wake = () => {
    if (AppState.currentState === 'active') schedule(0);
    else { if (timer) clearTimeout(timer); timer = null; controlRequest?.controller.abort(); }
  };
  wakeObservation = wake;
  const foreground = AppState.addEventListener('change', wake);
  const privacy = subscribePrivacyConsent(wake);
  const unsubscribe = subscribeAccessState(() => { void reconcileAccess().catch(reportAccessSyncError); });
  const failuresSub = subscribeAccessFailures(({ issue, stamp }) => {
    if (issue.scope === 'session' || !currentAccessRequest(stamp)) return;
    const captured = captureAccessAuthority();
    if (!captured) return;
    void (async () => {
      await applyAccessIssue(issue, captured, storeValue(await configStore.list()) ?? []);
      await reconcileAccess();
    })().catch(reportAccessSyncError);
  });
  const native = nativeAccess() ? new NativeEventEmitter(NativeModules.SxbVpnNative) : null;
  const nativeSub = native?.addListener('onAccessStateChange', () => {
    controlRequest?.controller.abort();
    void syncNativeAccessState().then(() => reconcileAccess()).catch(reportAccessSyncError);
    wake();
  });
  schedule(0);
  return () => {
    stopped = true;
    if (epoch === lifecycle) { lifecycle++; connections = []; controlSupported = null; nativeHandoffUntil = 0; wakeObservation = null; }
    controller.abort();
    controlRequest?.controller.abort();
    if (timer) clearTimeout(timer);
    foreground.remove(); privacy(); unsubscribe(); failuresSub(); nativeSub?.remove();
  };
}

export function wakeAccessObservation(): void { wakeObservation?.(); }

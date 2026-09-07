import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { AppState, AppStateStatus, NativeModules, Platform } from 'react-native';
import apiClient from './apiClient';

export type MobileHealthErrorCode =
  | 'NETWORK_UNAVAILABLE'
  | 'AUTH_REJECTED'
  | 'CONFIG_INVALID'
  | 'VPN_PERMISSION_DENIED'
  | 'TUNNEL_TIMEOUT'
  | 'TUNNEL_INTERRUPTED'
  | 'UNKNOWN';

type TunnelState = 'disconnected' | 'connecting' | 'connected' | 'error';
type SessionOutcome = 'none' | 'success' | 'failure';

interface PendingBatterySignals {
  activeSeconds: number;
  backgroundSeconds: number;
  wakeCount: number;
  reconnectCount: number;
  outbox: MobileHealthPayload[];
}

export interface MobileHealthSnapshot {
  tunnelState: TunnelState;
  protocol?: string | null;
  outcome?: SessionOutcome;
  errorCode?: MobileHealthErrorCode | null;
  sessionDurationSeconds?: number;
}

interface MobileHealthPayload {
  reportId: string;
  appVersion: string;
  versionCode: number;
  androidApi: number | null;
  deviceModel: string | null;
  tunnelState: TunnelState;
  protocol: string | null;
  outcome: SessionOutcome;
  errorCode: MobileHealthErrorCode | null;
  sessionDurationSeconds: number;
  reconnectCount: number;
  activeDurationSeconds: number;
  backgroundDurationSeconds: number;
  wakeCount: number;
  batteryOptimization: 'optimized' | 'unrestricted' | 'unknown';
}

const STORAGE_KEY = '@sxb_mobile_health_pending_v1';
const ALLOWED_PROTOCOLS = new Set([
  'vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria2',
  'ssh', 'ssh+payload', 'wireguard', 'tuic', 'singbox',
]);
const SxbVpnNative = Platform.OS === 'android' ? NativeModules.SxbVpnNative as {
  getBatteryOptimizationState?: () => Promise<string>;
} : null;

let appState: AppStateStatus = AppState.currentState;
let lastTransitionAt = Date.now();
let pending: PendingBatterySignals = {
  activeSeconds: 0,
  backgroundSeconds: 0,
  wakeCount: 0,
  reconnectCount: 0,
  outbox: [],
};
let hydrated: Promise<void> | null = null;
let sendInFlight: Promise<boolean> | null = null;

function clampInteger(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(max, Math.round(value)));
}

function hydrate(): Promise<void> {
  if (!hydrated) {
    hydrated = AsyncStorage.getItem(STORAGE_KEY).then((stored) => {
      if (!stored) return;
      try {
        const value = JSON.parse(stored) as Partial<PendingBatterySignals>;
        pending.activeSeconds += clampInteger(Number(value.activeSeconds), 7 * 86_400);
        pending.backgroundSeconds += clampInteger(Number(value.backgroundSeconds), 7 * 86_400);
        pending.wakeCount += clampInteger(Number(value.wakeCount), 100);
        pending.reconnectCount += clampInteger(Number(value.reconnectCount), 100);
        pending.outbox = Array.isArray(value.outbox)
          ? value.outbox.filter((item): item is MobileHealthPayload => {
              return !!item && typeof item === 'object' && typeof item.reportId === 'string';
            }).slice(0, 20)
          : [];
      } catch {
        // Corrupt non-sensitive counters are discarded; no identity or config is stored here.
      }
    }).catch(() => {});
  }
  return hydrated;
}

function accrue(now = Date.now()): void {
  const elapsedSeconds = Math.max(0, (now - lastTransitionAt) / 1000);
  if (appState === 'active') pending.activeSeconds += elapsedSeconds;
  else pending.backgroundSeconds += elapsedSeconds;
  lastTransitionAt = now;
}

async function persist(): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(pending)).catch(() => {});
}

export function normalizeMobileHealthProtocol(protocol?: string | null): string | null {
  const normalized = String(protocol || '').trim().toLowerCase();
  return ALLOWED_PROTOCOLS.has(normalized) ? normalized : null;
}

export async function noteMobileHealthAppState(next: AppStateStatus): Promise<boolean> {
  await hydrate();
  accrue();
  const becameActive = next === 'active' && appState !== 'active';
  if (becameActive) pending.wakeCount = Math.min(100, pending.wakeCount + 1);
  appState = next;
  await persist();
  return becameActive;
}

export function noteMobileHealthReconnect(): void {
  pending.reconnectCount = Math.min(100, pending.reconnectCount + 1);
  void persist();
}

function appMetadata() {
  const configuredVersionCode = Constants.expoConfig?.android?.versionCode;
  const nativeVersionCode = Number(Constants.nativeBuildVersion);
  const platformConstants = Platform.constants as unknown as { Model?: string };
  const rawModel = Platform.OS === 'android' ? String(platformConstants?.Model || '').trim() : '';
  const deviceModel = rawModel
    ? rawModel.replace(/[^\p{L}\p{N} ._()+-]/gu, ' ').replace(/\s+/g, ' ').slice(0, 80)
    : null;

  return {
    appVersion: Constants.nativeAppVersion || Constants.expoConfig?.version || '0',
    versionCode: Number.isInteger(nativeVersionCode) && nativeVersionCode > 0
      ? nativeVersionCode
      : Number(configuredVersionCode) || 1,
    androidApi: Platform.OS === 'android' && typeof Platform.Version === 'number'
      ? Platform.Version
      : null,
    deviceModel,
  };
}

async function batteryOptimizationState(): Promise<'optimized' | 'unrestricted' | 'unknown'> {
  if (!SxbVpnNative?.getBatteryOptimizationState) return 'unknown';
  try {
    const state = await SxbVpnNative.getBatteryOptimizationState();
    return state === 'optimized' || state === 'unrestricted' ? state : 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function reportMobileHealth(snapshot: MobileHealthSnapshot): Promise<boolean> {
  if (sendInFlight) {
    await sendInFlight;
    return reportMobileHealth(snapshot);
  }
  sendInFlight = (async () => {
    await hydrate();
    accrue();
    const reserved = pending.outbox.reduce((sum, item) => ({
      activeSeconds: sum.activeSeconds + item.activeDurationSeconds,
      backgroundSeconds: sum.backgroundSeconds + item.backgroundDurationSeconds,
      wakeCount: sum.wakeCount + item.wakeCount,
      reconnectCount: sum.reconnectCount + item.reconnectCount,
    }), {
      activeSeconds: 0,
      backgroundSeconds: 0,
      wakeCount: 0,
      reconnectCount: 0,
    });
    const reportCounters = {
      activeSeconds: Math.max(0, pending.activeSeconds - reserved.activeSeconds),
      backgroundSeconds: Math.max(0, pending.backgroundSeconds - reserved.backgroundSeconds),
      wakeCount: Math.max(0, pending.wakeCount - reserved.wakeCount),
      reconnectCount: Math.max(0, pending.reconnectCount - reserved.reconnectCount),
    };
    const payload: MobileHealthPayload = {
      reportId: Crypto.randomUUID(),
      ...appMetadata(),
      tunnelState: snapshot.tunnelState,
      protocol: normalizeMobileHealthProtocol(snapshot.protocol),
      outcome: snapshot.outcome || 'none',
      errorCode: snapshot.outcome === 'failure' ? snapshot.errorCode || 'UNKNOWN' : null,
      sessionDurationSeconds: clampInteger(snapshot.sessionDurationSeconds || 0, 7 * 86_400),
      reconnectCount: clampInteger(reportCounters.reconnectCount, 100),
      activeDurationSeconds: clampInteger(reportCounters.activeSeconds, 7 * 86_400),
      backgroundDurationSeconds: clampInteger(reportCounters.backgroundSeconds, 7 * 86_400),
      wakeCount: clampInteger(reportCounters.wakeCount, 100),
      batteryOptimization: await batteryOptimizationState(),
    };
    pending.outbox.push(payload);
    await persist();

    while (pending.outbox.length > 0) {
      const queued = pending.outbox[0];
      try {
        await apiClient.post('/mobile-health/report', queued, { timeout: 8_000 });
        pending.activeSeconds = Math.max(0, pending.activeSeconds - queued.activeDurationSeconds);
        pending.backgroundSeconds = Math.max(0, pending.backgroundSeconds - queued.backgroundDurationSeconds);
        pending.wakeCount = Math.max(0, pending.wakeCount - queued.wakeCount);
        pending.reconnectCount = Math.max(0, pending.reconnectCount - queued.reconnectCount);
        pending.outbox.shift();
        await persist();
      } catch {
        await persist();
        return false;
      }
    }
    return true;
  })().finally(() => {
    sendInFlight = null;
  });
  return sendInFlight;
}

import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
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
}

export interface MobileHealthSnapshot {
  tunnelState: TunnelState;
  protocol?: string | null;
  outcome?: SessionOutcome;
  errorCode?: MobileHealthErrorCode | null;
  sessionDurationSeconds?: number;
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
    const sent = {
      activeSeconds: pending.activeSeconds,
      backgroundSeconds: pending.backgroundSeconds,
      wakeCount: pending.wakeCount,
      reconnectCount: pending.reconnectCount,
    };
    const payload = {
      ...appMetadata(),
      tunnelState: snapshot.tunnelState,
      protocol: normalizeMobileHealthProtocol(snapshot.protocol),
      outcome: snapshot.outcome || 'none',
      errorCode: snapshot.outcome === 'failure' ? snapshot.errorCode || 'UNKNOWN' : null,
      sessionDurationSeconds: clampInteger(snapshot.sessionDurationSeconds || 0, 7 * 86_400),
      reconnectCount: clampInteger(sent.reconnectCount, 100),
      activeDurationSeconds: clampInteger(sent.activeSeconds, 7 * 86_400),
      backgroundDurationSeconds: clampInteger(sent.backgroundSeconds, 7 * 86_400),
      wakeCount: clampInteger(sent.wakeCount, 100),
      batteryOptimization: await batteryOptimizationState(),
    };

    try {
      await apiClient.post('/mobile-health/report', payload, { timeout: 8_000 });
      pending.activeSeconds = Math.max(0, pending.activeSeconds - sent.activeSeconds);
      pending.backgroundSeconds = Math.max(0, pending.backgroundSeconds - sent.backgroundSeconds);
      pending.wakeCount = Math.max(0, pending.wakeCount - sent.wakeCount);
      pending.reconnectCount = Math.max(0, pending.reconnectCount - sent.reconnectCount);
      await persist();
      return true;
    } catch {
      await persist();
      return false;
    }
  })().finally(() => {
    sendInFlight = null;
  });
  return sendInFlight;
}

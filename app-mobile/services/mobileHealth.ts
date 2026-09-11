import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { AppState, AppStateStatus, NativeModules, Platform } from 'react-native';
import apiClient from './apiClient';
import { getPrivacyConsent, getPrivacySignal, subscribePrivacyConsent } from './privacyConsent';

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
  heartbeat?: boolean;
}

/**
 * Cadence du battement de présence, en millisecondes.
 *
 * Tant que le tunnel est monté, l'application redit périodiquement « je suis
 * toujours connecté ». Sans cela, un appareil qui perd brutalement le réseau
 * resterait indéfiniment « connecté » côté serveur, puisque le dernier état
 * reçu ne serait jamais contredit.
 *
 * 5 minutes est le compromis retenu : assez court pour que le serveur puisse
 * fermer sa fenêtre de présence à 15 minutes (3 battements) et rester honnête,
 * assez long pour rester négligeable en batterie et en données — un battement
 * pèse moins d'un kilo-octet, soit ~12 requêtes par heure de tunnel.
 *
 * Surchargeable au build via EXPO_PUBLIC_MOBILE_HEALTH_HEARTBEAT_MS ; toute
 * valeur absente, illisible ou inférieure à une minute retombe sur la valeur
 * par défaut, afin qu'une configuration fautive ne puisse pas transformer le
 * battement en matraquage réseau.
 */
export const MOBILE_HEALTH_HEARTBEAT_INTERVAL_MS = (() => {
  const configured = Number(process.env.EXPO_PUBLIC_MOBILE_HEALTH_HEARTBEAT_MS);
  return Number.isFinite(configured) && configured >= 60_000 ? configured : 5 * 60_000;
})();

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
subscribePrivacyConsent(() => { lastTransitionAt = Date.now(); });
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
  if (!getPrivacyConsent().diagnostics || !getPrivacyConsent().vpn) {
    appState = next;
    lastTransitionAt = Date.now();
    return false;
  }
  const signal = getPrivacySignal();
  await hydrate();
  if (signal.aborted) return false;
  accrue();
  const becameActive = next === 'active' && appState !== 'active';
  if (becameActive) pending.wakeCount = Math.min(100, pending.wakeCount + 1);
  appState = next;
  await persist();
  return becameActive;
}

export function noteMobileHealthReconnect(): void {
  if (!getPrivacyConsent().diagnostics || !getPrivacyConsent().vpn) return;
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
  if (!getPrivacyConsent().diagnostics || !getPrivacyConsent().vpn) return false;
  if (sendInFlight) {
    await sendInFlight;
    return reportMobileHealth(snapshot);
  }
  sendInFlight = (async () => {
    const signal = getPrivacySignal();
    await hydrate();
    if (signal.aborted) return false;
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
    if (signal.aborted) return false;
    pending.outbox.push(payload);
    await persist();

    while (pending.outbox.length > 0) {
      if (signal.aborted) return false;
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

/**
 * Battement de présence — « le tunnel est toujours monté ».
 *
 * Volontairement distinct de reportMobileHealth, pour trois raisons :
 *
 *  1. AUCUNE REPRISE. Un battement en échec n'est jamais mis en file : rejoué
 *     plus tard, il affirmerait une présence déjà expirée. Un battement perdu
 *     est un battement oublié, et c'est exactement le comportement voulu.
 *  2. AUCUN COMPTEUR. Il ne consomme ni ne réserve les durées accumulées, qui
 *     restent intactes pour le prochain rapport de cycle de vie.
 *  3. AUCUNE ÉCRITURE LOCALE. Ni AsyncStorage, ni état persistant : la réussite
 *     comme l'échec ne coûtent qu'une requête.
 *
 * Il emprunte en revanche exactement le même chemin réseau que les rapports —
 * même route, même schéma, même garde de consentement côté apiClient.
 *
 * Ne rejette jamais : un réseau coupé ne doit ni interrompre ni ralentir le
 * tunnel, qui est piloté par le service natif et n'attend rien d'ici.
 */
export async function sendMobileHealthHeartbeat(snapshot: MobileHealthSnapshot): Promise<boolean> {
  if (!getPrivacyConsent().diagnostics || !getPrivacyConsent().vpn) return false;
  // Un battement n'a de sens que pour un tunnel effectivement monté ; sur tout
  // autre état c'est la transition de cycle de vie qui fait foi.
  if (snapshot.tunnelState !== 'connected') return false;
  const signal = getPrivacySignal();
  if (signal.aborted) return false;
  try {
    const payload: MobileHealthPayload = {
      reportId: Crypto.randomUUID(),
      ...appMetadata(),
      tunnelState: 'connected',
      protocol: normalizeMobileHealthProtocol(snapshot.protocol),
      outcome: 'none',
      errorCode: null,
      sessionDurationSeconds: 0,
      reconnectCount: 0,
      activeDurationSeconds: 0,
      backgroundDurationSeconds: 0,
      wakeCount: 0,
      batteryOptimization: await batteryOptimizationState(),
      heartbeat: true,
    };
    if (signal.aborted) return false;
    await apiClient.post('/mobile-health/report', payload, { timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

export async function clearMobileHealth(): Promise<void> {
  // savePrivacyConsent aborts in-flight requests before draining old writes.
  if (hydrated) await hydrated;
  if (sendInFlight) await sendInFlight;
  pending = { activeSeconds: 0, backgroundSeconds: 0, wakeCount: 0, reconnectCount: 0, outbox: [] };
  lastTransitionAt = Date.now();
  await AsyncStorage.removeItem(STORAGE_KEY);
}

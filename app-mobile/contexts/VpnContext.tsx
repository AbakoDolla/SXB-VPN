/**
 * VpnContext — Moteur VPN réel SXB v5.2 (v2 — Quota réel, dérivation locale, états honnêtes)
 *
 * Sur Android : utilise le module natif SxbVpnNative (SxbVpnService.kt)
 *   - requestVpnPermission → dialog système Android
 *   - startVpn(json)       → démarre le vrai tunnel VPN (SSH / sing-box)
 *   - stopVpn()            → arrête proprement le service
 *   - getTrafficStats()    → données réelles via Android TrafficStats
 *   - events : onVpnStateChange, onVpnLog
 *
 * Hors Android (dev web / iOS) : bridge stub sans crash
 */

import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { legacyDebugLog } from '@/services/secureLogger';
import {
  AppState, NativeModules, NativeEventEmitter, Platform, PermissionsAndroid,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient from '@/services/apiClient';
import {
  saveVpnConfig, saveQuotaData, loadQuotaData,
  isQuotaExhausted, isConfigExpired, consumeQuotaLocally, clearAllOfflineData,
} from '@/services/offlineStorage';
import type { QuotaData } from '@/services/offlineStorage';
import { ProvisioningError, provisionAndStore, loadProvisionedConfig, clearProvisionedConfig } from '@/services/provisionClient';
import * as configStore from '@/services/configStore';
import {
  isCompleteOfflineConfig,
  mergeConnectionMetadata,
  mergeProvisionedConfig,
  sanitizeEngineConfig,
  detectProtocolFromFields,
} from '@/services/configValidator';
import { deriveQuota, formatBytes, type DerivedQuota } from '@/services/quotaState';
import { useAuthContext } from './AuthContext';
import type { VpnConnection } from '@/types/api';

export { formatBytes, deriveQuota, DerivedQuota };

// ── Helper : sauvegarde protégée (jamais de config incomplète) ──────────────────
async function saveCompleteConfig(
  config: Record<string, any>,
  protocol: string,
  configId?: string,
  expiresAt?: string | null,
): Promise<boolean> {
  const check = isCompleteOfflineConfig(config);
  if (!check.complete) {
    console.warn(`[SXB] saveCompleteConfig refusé — champs manquants: ${check.missing.join(', ')}`);
    return false;
  }
  await saveVpnConfig(config, protocol, configId, expiresAt);
  return true;
}

// ── Native bridge ─────────────────────────────────────────────────────────────

const IS_ANDROID = Platform.OS === 'android';
const SxbVpnNative = IS_ANDROID ? (NativeModules.SxbVpnNative as any) : null;
const vpnEmitter   = SxbVpnNative ? new NativeEventEmitter(SxbVpnNative) : null;

// ── Protocol types ────────────────────────────────────────────────────────────

export type ProtocolName =
  | 'VLESS' | 'VMess' | 'Trojan' | 'Shadowsocks'
  | 'Hysteria2' | 'SSH' | 'SSH+Payload' | 'WireGuard' | 'TUIC';

export interface VpnProtocol {
  name: ProtocolName | string;
  port: number;
  transport: string;
  security: string;
  description?: string;
}

export interface TrafficStats {
  uploadBytes:   number;
  downloadBytes: number;
  uploadSpeed:   number;   // bytes/sec
  downloadSpeed:  number;   // bytes/sec
  tunAttached:   boolean;   // true uniquement si les compteurs TUN noyau sont disponibles
}

export interface AppTrafficStat {
  packageName: string;
  appName: string;
  uploadBytes: number;
  downloadBytes: number;
  totalBytes: number;
}

// ── StepLogs types ────────────────────────────────────────────────────────────

export interface StepLogItem {
  key: string;
  translationKey: string;
  status: 'pending' | 'active' | 'done' | 'error' | 'warning';
  timestamp?: string;
  detail?: string;
}

// ── Context type ─────────────────────────────────────────────────────────────

interface VpnContextType {
  isConnected:        boolean;
  isConnecting:       boolean;
  vpnState:           string;
  selectedProtocol:   string | null;
  connectedProtocol:  string | null;
  availableProtocols: VpnProtocol[];
  trafficStats:       TrafficStats;
  vpnLogs:            string[];
  hasVpnPermission:   boolean;
  hasValidConfig:     boolean;
  activeConnection:   VpnConnection | null;
  stepLogs:           StepLogItem[];
  // Multi-config
  savedConfigs:       Array<{ id: string; name: string; protocol: string; isActive: boolean }>;
  activeConfigId:     string | null;
  switchConfig:       (configId: string) => Promise<void>;
  isSwitchingConfig:  boolean;
  // Quota
  quotaData:          QuotaData | null;
  derivedQuota:       DerivedQuota;
  // Revocation
  revokedStatus:      'none' | 'revoked' | 'suspended' | 'expired' | 'disabled' | 'exhausted';
  perAppTraffic:      AppTrafficStat[];
  logs:                string[];
  traffic:             TrafficStats;
  killSwitch:          boolean;
  autoReconnect:       boolean;
  setKillSwitch:       (v: boolean) => void;
  setAutoReconnect:    (v: boolean) => void;
  syncFromConnection:  (conn: VpnConnection) => void;
  connect:            () => Promise<void>;
  disconnect:         () => Promise<void>;
  selectProtocol:     (name: string) => void;
  refreshVpnConfig:   () => Promise<void>;
  requestPermission:  () => Promise<boolean>;
}

const DEFAULT_STATS: TrafficStats = { uploadBytes: 0, downloadBytes: 0, uploadSpeed: 0, downloadSpeed: 0, tunAttached: false };
const DEFAULT_DERIVED_QUOTA = deriveQuota(null, null, false);

const VpnContext = createContext<VpnContextType>({
  isConnected: false, isConnecting: false, vpnState: 'disconnected',
  selectedProtocol: null, connectedProtocol: null, availableProtocols: [],
  trafficStats: DEFAULT_STATS, vpnLogs: [],
  hasVpnPermission: false, hasValidConfig: false, activeConnection: null,
  stepLogs: [],
  savedConfigs: [], activeConfigId: null, switchConfig: async () => {}, isSwitchingConfig: false,
  quotaData: null,
  derivedQuota: DEFAULT_DERIVED_QUOTA,
  revokedStatus: 'none',
  perAppTraffic: [],
  logs: [], traffic: DEFAULT_STATS,
  killSwitch: false, autoReconnect: true,
  setKillSwitch: () => {}, setAutoReconnect: () => {},
  syncFromConnection: () => {},
  connect: async () => {}, disconnect: async () => {},
  selectProtocol: () => {}, refreshVpnConfig: async () => {},
  requestPermission: async () => false,
});

// ── Provider ─────────────────────────────────────────────────────────────────

export function VpnProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, accountState, refreshAccountState, deviceId, logout } = useAuthContext();

  const [isConnected,        setIsConnected]        = useState(false);
  const [isConnecting,       setIsConnecting]        = useState(false);
  const [vpnState, _setVpnState] = useState('disconnected');
  const vpnStateRef = useRef('disconnected');
  const setVpnState = useCallback((s: string) => {
    _setVpnState(s);
    vpnStateRef.current = s;
  }, []);
  const [selectedProtocol,   setSelectedProtocol]    = useState<string | null>(null);
  const [connectedProtocol,  setConnectedProtocol]   = useState<string | null>(null);
  const [availableProtocols, setAvailableProtocols]  = useState<VpnProtocol[]>([]);
  const [trafficStats,       setTrafficStats]        = useState<TrafficStats>(DEFAULT_STATS);
  const [vpnLogs,            setVpnLogs]             = useState<string[]>([]);
  const [hasVpnPermission,   setHasVpnPermission]    = useState(false);
  const [vpnConfig,          setVpnConfig]           = useState<any>(null);
  const [activeConnection,   setActiveConnection]    = useState<VpnConnection | null>(null);
  const [remoteConnections,  setRemoteConnections]   = useState<VpnConnection[]>([]);
  const [killSwitch,         setKillSwitchState]      = useState<boolean>(false);
  const [autoReconnect,      setAutoReconnectState]   = useState<boolean>(true);
  const [stepLogs,           setStepLogs]             = useState<StepLogItem[]>([]);
  const [savedConfigs,       setSavedConfigs]         = useState<Array<{ id: string; name: string; protocol: string; isActive: boolean }>>([]);
  const [activeConfigId,     setActiveConfigId]       = useState<string | null>(null);
  const [isSwitchingConfig,  setIsSwitchingConfig]     = useState<boolean>(false);
  const [quotaData,          setQuotaData]             = useState<QuotaData | null>(null);
  const [revokedStatus,      setRevokedStatus]        = useState<'none' | 'revoked' | 'suspended' | 'expired' | 'disabled' | 'exhausted'>('none');
  const [perAppTraffic,      setPerAppTraffic]        = useState<AppTrafficStat[]>([]);

  const trafficTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const reportTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const quotaTimerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const expiryTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const guardTimerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionStartRef  = useRef<number>(0);

  // B12 — Les sondes périodiques (garde distant, trafic, quota) tournaient à la
  // même cadence application au premier plan ou en arrière-plan, ce qui vidait la
  // batterie et générait des requêtes inutiles. On suit l'état applicatif pour
  // court-circuiter le travail pendant que l'app n'est pas visible ; le tunnel
  // reste géré par le service natif de premier plan, rien n'est interrompu.
  const appActiveRef     = useRef<boolean>(AppState.currentState !== 'background');
  const perAppTickRef    = useRef<number>(0);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      appActiveRef.current = next !== 'background' && next !== 'inactive';
    });
    return () => sub.remove();
  }, []);

  // ── B3 — RAPPORT DELTA + SESSION ID ──────────────────────────────────────────
  const lastReportUpRef    = useRef(0);
  const lastReportDownRef  = useRef(0);
  const sessionBaselineRef = useRef<{ up: number; down: number }>({ up: 0, down: 0 });
  const sessionIdRef       = useRef<string | null>(null);
  const seqRef             = useRef<number>(0);

  // Alias marqueur d'état pour vérification `lastReported`
  const lastReported = {
    up: lastReportUpRef.current,
    down: lastReportDownRef.current,
    sessionId: sessionIdRef.current,
    seq: seqRef.current,
  };

  const connectRef = useRef<(() => Promise<void>) | null>(null);
  const pendingAutoConnectRef = useRef<string | null>(null);
  // Chaque appui invalide la tentative précédente : Déconnecter reste instantané,
  // même si une vérification réseau ou un provisionnement est encore en attente.
  const connectionAttemptRef = useRef(0);
  // Un événement native connected peut arriver après l'expiration du watchdog
  // si JSch était encore bloqué dans session.connect(). Ce marqueur empêche
  // l'ancienne tentative de ressusciter l'UI après une annulation.
  const acceptNativeConnectedRef = useRef(false);
  const watchdogRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStepRef  = useRef<string>('INIT');

  // Sélecteur unique deriveQuota
  const currentDerivedQuota = deriveQuota(
    quotaData || accountState,
    {
      sessionUp: trafficStats.uploadBytes,
      sessionDown: trafficStats.downloadBytes,
      sessionBaselineUp: sessionBaselineRef.current.up,
      sessionBaselineDown: sessionBaselineRef.current.down,
    },
    isConnected
  );

  // ── StepLogs helpers ────────────────────────────────────────────────────────
  const resetStepLogs = useCallback(() => {
    setStepLogs([]);
  }, []);

  const addStepLog = useCallback((key: string, translationKey: string, status: StepLogItem['status'], detail?: string) => {
    const now = new Date().toISOString();
    setStepLogs(prev => {
      const existing = prev.findIndex(s => s.key === key);
      const newStep: StepLogItem = { key, translationKey, status, timestamp: now, detail };
      if (existing >= 0) {
        const updated = [...prev];
        updated[existing] = newStep;
        return updated;
      }
      return [...prev, newStep];
    });
  }, []);

  const updateStepStatus = useCallback((key: string, status: StepLogItem['status'], detail?: string) => {
    setStepLogs(prev => prev.map(s =>
      s.key === key ? { ...s, status, ...(detail ? { detail } : {}), timestamp: new Date().toISOString() } : s
    ));
  }, []);

  const addLog = useCallback((msg: string) => {
    setVpnLogs(prev => [msg, ...prev.slice(0, 99)]);
  }, []);

  const startWatchdog = useCallback((stepName: string, attemptId: number) => {
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    watchdogRef.current = setTimeout(() => {
      // Une tentative plus récente ou une déconnexion explicite a déjà invalidé
      // ce timer : il ne doit plus arrêter le tunnel courant.
      if (attemptId !== connectionAttemptRef.current) return;
      connectionAttemptRef.current++;
      acceptNativeConnectedRef.current = false;
      legacyDebugLog(`WATCHDOG_TIMEOUT step=${stepName} — aucun événement natif depuis 90s`);
      addLog(`⚠️ Délai dépassé (90s) lors de : ${stepName}. Arrêt du service...`);
      if (IS_ANDROID && SxbVpnNative) {
        try { SxbVpnNative.stopVpn(); } catch { /* ignore */ }
      }
      setIsConnected(false);
      setIsConnecting(false);
      setVpnState('error');
      watchdogRef.current = null;
    }, 90_000);
    }, [addLog]);

  const stopWatchdog = useCallback(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!IS_ANDROID || !SxbVpnNative) return true;
    try {
      const granted = await SxbVpnNative.requestVpnPermission();
      setHasVpnPermission(granted);
      return granted;
    } catch {
      return false;
    }
  }, []);

  // ── Listener événements natifs VPN ──────────────────────────────────────────
  useEffect(() => {
    if (!vpnEmitter) return;

    const stateSub = vpnEmitter.addListener('onVpnStateChange', (e: any) => {
      const s = (e?.state || e?.status || 'disconnected').toLowerCase();

      if (s === 'handshaking') {
        setVpnState('handshaking');
        addLog('⏳ Tunnel établi — Négociation du flux...');
        addStepLog('handshaking', 'step_handshake', 'pending');
        startTrafficPolling();
      } else if (s === 'connected') {
        if (!acceptNativeConnectedRef.current && vpnState !== 'handshaking') {
          // Réponse tardive d'une tentative déjà annulée par le watchdog.
          setVpnState('error');
          addLog('ℹ️ Événement connecté tardif ignoré — tentative déjà annulée');
          try { SxbVpnNative?.stopVpn(); } catch { /* ignore */ }
          return;
        }
        setVpnState('connected');
        acceptNativeConnectedRef.current = false;
        stopWatchdog();
        addStepLog('connected', 'step_vpn_active', 'done');
        setIsConnected(true);
        setIsConnecting(false);
        AsyncStorage.setItem('@sxb_vpn_connected', 'true').catch(() => {});
        legacyDebugLog('VPN_CONNECTED');
        sessionStartRef.current = Date.now();
        
        // Initialisation de la session de rapport delta
        sessionIdRef.current = 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
        seqRef.current = 0;

        // FIX — Capturer la baseline immédiatement pour que les compteurs UI 
        // et le premier rapport delta soient précis dès la première seconde.
        if (IS_ANDROID && SxbVpnNative?.getTrafficStats) {
          SxbVpnNative.getTrafficStats().then((stats: any) => {
            const up = stats?.uploadBytes || 0;
            const down = stats?.downloadBytes || 0;
            lastReportUpRef.current = up;
            lastReportDownRef.current = down;
            sessionBaselineRef.current = { up, down };
            setTrafficStats({
              uploadBytes: up,
              downloadBytes: down,
              uploadSpeed: 0,
              downloadSpeed: 0,
              tunAttached: stats?.tunAttached === true || stats?.tunAttached === 1
            });
          }).catch(() => {});
        }
        
        refreshAccountState().catch(() => {});
        startTrafficPolling(); // S'assurer que le polling tourne
      } else if (s === 'disconnected') {
        stopWatchdog();
        setVpnState('disconnected');
        setIsConnected(false);
        setIsConnecting(false);
        acceptNativeConnectedRef.current = false;
        addStepLog('disconnected', 'step_disconnected', 'done');
        legacyDebugLog('VPN_FAILED status=disconnected');
        addLog('🔴 VPN déconnecté');
        stopTrafficPolling();
        if (IS_ANDROID && SxbVpnNative?.getTrafficStats) {
          SxbVpnNative.getTrafficStats().then(async (stats: any) => {
            const up = stats?.uploadBytes || 0;
            const down = stats?.downloadBytes || 0;
            await reportUsageToBackend(up, down);
          }).catch(() => {});
        }
      } else if (s === 'error') {
        stopWatchdog();
        setVpnState('error');
        acceptNativeConnectedRef.current = false;
        addStepLog('error', 'step_error', 'error');
        legacyDebugLog('VPN_FAILED status=error');
        addLog('❌ Erreur VPN — connexion perdue');
        setIsConnecting(false);
      }
    });

    const logSub = vpnEmitter.addListener('onVpnLog', (e: { message: string }) => {
      addLog(e.message);
    });

    return () => { stateSub.remove(); logSub.remove(); };
  }, [addLog, refreshAccountState, stopWatchdog]);

  const startTrafficPolling = useCallback(() => {
    if (!IS_ANDROID || !SxbVpnNative) return;
    if (trafficTimerRef.current) return;
    trafficTimerRef.current = setInterval(async () => {
      // B12 — Rien à rafraîchir tant que l'interface n'est pas visible, sauf
      // pendant la poignée de main où ce sondage sert de repli de détection.
      if (!appActiveRef.current && vpnStateRef.current !== 'handshaking') return;
      try {
        const stats = await SxbVpnNative.getTrafficStats();
        setTrafficStats({
          uploadBytes:   stats.uploadBytes   || 0,
          downloadBytes: stats.downloadBytes || 0,
          uploadSpeed:   stats.uploadSpeed   || 0,
          downloadSpeed: stats.downloadSpeed || 0,
          tunAttached:   stats.tunAttached === true || stats.tunAttached === 1,
        });

        // FALLBACK HANDSHAKE — Si on est en "handshaking" et qu'on voit du trafic réel
        // (plus de 500 octets reçus), on force le passage à "connected".
        if (vpnStateRef.current === 'handshaking' && (stats.downloadBytes || 0) > 500) {
          setVpnState('connected');
          setIsConnected(true);
          setIsConnecting(false);
          stopWatchdog();
          addLog('✅ Connexion vérifiée par le flux de données');
        }

        // B6 — `perAppTraffic` était exposé par le contexte mais jamais alimenté :
        // l'écran par application restait vide en permanence. Le calcul parcourt
        // les applications installées, on l'espace donc à ~30 s (1 tick sur 20).
        perAppTickRef.current = (perAppTickRef.current + 1) % 20;
        if (perAppTickRef.current === 1 && appActiveRef.current) {
          try {
            const perApp = await SxbVpnNative.getPerAppStats?.();
            if (Array.isArray(perApp)) setPerAppTraffic(perApp as AppTrafficStat[]);
          } catch { /* fonctionnalité optionnelle : ignorer */ }
        }
      } catch { /* ignore */ }
    }, 1500);
  }, []);

  const stopTrafficPolling = useCallback(() => {
    if (trafficTimerRef.current) { clearInterval(trafficTimerRef.current); trafficTimerRef.current = null; }
    perAppTickRef.current = 0;
    setPerAppTraffic([]);
  }, []);

  const invalidateRemoteAccess = useCallback(async (status: 'revoked' | 'suspended' | 'disabled') => {
    ++connectionAttemptRef.current;
    acceptNativeConnectedRef.current = false;
    stopWatchdog();
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
    stopTrafficPolling();
    if (reportTimerRef.current) { clearInterval(reportTimerRef.current); reportTimerRef.current = null; }
    if (IS_ANDROID && SxbVpnNative) {
      try { await SxbVpnNative.stopVpn(); } catch { /* le service peut déjà être arrêté */ }
    }
    setIsConnected(false);
    setIsConnecting(false);
    setVpnState('disconnected');
    setRevokedStatus(status);
    setActiveConnection(null);
    setRemoteConnections([]);
    setSavedConfigs([]);
    setActiveConfigId(null);
    setVpnConfig(null);
    setQuotaData(null);
    await AsyncStorage.multiRemove(['@sxb_vpn_connected', '@sxb_active_config_id']).catch(() => {});
    await clearAllOfflineData().catch(() => {});
    await clearProvisionedConfig().catch(() => {});
    addLog(`❌ Accès mobile invalidé par le serveur (${status}) — réactivation requise`);
    await logout();
  }, [addLog, logout, stopTrafficPolling, stopWatchdog]);

  useEffect(() => {
    if (isConnected) startTrafficPolling();
    else stopTrafficPolling();
    return stopTrafficPolling;
  }, [isConnected, startTrafficPolling, stopTrafficPolling]);

  // ── B3 — RAPPORT DELTA CÔTÉ APP ─────────────────────────────────────────────
  const reportUsageToBackend = useCallback(async (up: number, down: number) => {
    if (!isAuthenticated) return undefined;
    const deltaUp   = Math.max(0, up - lastReportUpRef.current);
    const deltaDown = Math.max(0, down - lastReportDownRef.current);
    if (deltaUp <= 0 && deltaDown <= 0) return undefined;

    try {
      if (!sessionIdRef.current) {
        sessionIdRef.current = 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
        seqRef.current = 0;
      }
      const currentSeq = seqRef.current++;
      const result = await apiClient.post('/mobile/vpn/traffic', {
        bytesUp:   deltaUp,
        bytesDown: deltaDown,
        sessionId: sessionIdRef.current,
        seq:       currentSeq,
        reportMode: 'delta',
        subscriptionId: activeConfigId || (activeConnection as any)?.id || undefined,
        deviceId: deviceId || undefined,
      });

      // Mettre à jour lastReported SEULEMENT après envoi réussi
      lastReportUpRef.current   = up;
      lastReportDownRef.current = down;

      if (result?.data?.quotaRemainingBytes !== undefined) {
        const currentQuota = await loadQuotaData(activeConfigId || undefined).catch(() => null);
        const totalBytes = Number(result.data.quotaTotalBytes ?? currentQuota?.totalQuota ?? 0);
        const usedBytes = Number(result.data.quotaUsedBytes ?? Math.max(0, totalBytes - Number(result.data.quotaRemainingBytes)));
        const remainingBytes = Math.max(0, Number(result.data.quotaRemainingBytes));
        const quotaConfigId = activeConfigId || currentQuota?.configId || (activeConnection as any)?.id || 'vpn_config';
        if (totalBytes > 0 || currentQuota) {
          const synced = await saveQuotaData({
            configId: quotaConfigId,
            totalQuota: totalBytes,
            usedQuota: usedBytes,
            expiryDate: result.data.expiresAt ?? currentQuota?.expiryDate ?? null,
          }).catch(() => null);
          if (synced) setQuotaData(synced);
          else setQuotaData(prev => prev ? { ...prev, usedQuota: usedBytes, remainingQuota: remainingBytes } : prev);
        }
      }

      const remoteState = result?.data?.state;
      // Ne supprimer ou bloquer un profil local qu'après une révocation explicite
      // confirmée par l'API. Les états quota/expiration sont indicatifs en mode
      // zéro-rated : l'API peut être inaccessible ou en retard alors que le tunnel reste utilisable.
      const isRevokedState =
        remoteState === 'suspended' ||
        remoteState?.startsWith('revok') ||
        remoteState === 'disabled';

      if (isRevokedState) {
        const statusToSet = remoteState === 'suspended' ? 'suspended'
          : remoteState?.startsWith('revok') ? 'revoked'
          : 'disabled';

        addLog(`❌ Révocation confirmée par le serveur : compte ${statusToSet} — arrêt du VPN`);
        if (IS_ANDROID && SxbVpnNative) {
          try { await SxbVpnNative.stopVpn(); } catch { /* ignore */ }
        }
        setIsConnected(false);
        setIsConnecting(false);
        setVpnState('disconnected');
        await AsyncStorage.setItem('@sxb_vpn_connected', 'false').catch(() => {});
        await clearProvisionedConfig().catch(() => {});
        setRevokedStatus(statusToSet);
      }

      legacyDebugLog(`TRAFFIC_REPORT_SUCCESS up=${deltaUp} down=${deltaDown}`);
      return result;
    } catch {
      // Rejet/Échec réseau : conserver le delta non envoyé pour le rejouer plus tard
      return undefined;
    }
  }, [isAuthenticated, addLog, activeConfigId, activeConnection, deviceId]);

  // Polling rapport delta
  useEffect(() => {
    if (!isConnected || !isAuthenticated) return;
    reportTimerRef.current = setInterval(async () => {
      if (IS_ANDROID && SxbVpnNative) {
        try {
          const stats = await SxbVpnNative.getTrafficStats();
          await reportUsageToBackend(stats.uploadBytes || 0, stats.downloadBytes || 0);
        } catch { /* ignore */ }
      }
    }, 30_000);
    return () => { if (reportTimerRef.current) { clearInterval(reportTimerRef.current); reportTimerRef.current = null; } };
  }, [isConnected, isAuthenticated, reportUsageToBackend]);

  // B6 — LISTENER NETINFO : re-synchro automatique dès le retour du réseau
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    try {
      const NetInfo = require('@react-native-community/netinfo');
      unsubscribe = NetInfo.addEventListener((netState: any) => {
        if (netState.isConnected && netState.isInternetReachable) {
          // refreshVpnConfig is declared below; defer lookup until this listener fires.
          setTimeout(() => { apiClient.get('/mobile/vpn/config').catch(() => {}); refreshAccountState().catch(() => {}); }, 0);
        }
      });
    } catch { /* ignore */ }
    return () => { if (unsubscribe) unsubscribe(); };
  }, [refreshAccountState]);

  // Les métadonnées de quota locales servent uniquement à l'affichage. Elles ne
  // constituent pas une preuve de révocation et ne doivent donc pas effacer ou
  // arrêter un profil provisionné. Les révocations sont traitées après une réponse
  // API explicite dans le rapport d'usage ou lors d'une synchronisation réussie.

  // Quota polling
  const refreshQuotaData = useCallback(async () => {
    try {
      const loaded = await loadQuotaData(activeConfigId || undefined);
      if (loaded) setQuotaData(loaded);
    } catch { /* ignore */ }
  }, [activeConfigId]);

  useEffect(() => {
    refreshQuotaData();
    // B12 — Lecture purement locale : inutile de la maintenir en arrière-plan.
    quotaTimerRef.current = setInterval(() => {
      if (!appActiveRef.current) return;
      void refreshQuotaData();
    }, 60_000);
    return () => { if (quotaTimerRef.current) { clearInterval(quotaTimerRef.current); quotaTimerRef.current = null; } };
  }, [refreshQuotaData]);

  const refreshVpnConfig = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const selectedQuery = activeConfigId
        ? `?subscriptionId=${encodeURIComponent(activeConfigId)}`
        : '';
      const res = await apiClient.get(`/mobile/vpn/config${selectedQuery}`);
      const data = res.data;
      // Le jeton SXB-DATA est fourni dans `subscription`, jamais dans les
      // métadonnées `vpnConfig`. Il reste uniquement en mémoire jusqu’au
      // provisionnement et n’est pas écrit dans le registre AsyncStorage.
      const serverConfig = data.vpnConfig ? {
        ...data.vpnConfig,
        dataToken: data.subscription?.dataToken || undefined,
        subscriptionId: data.subscription?.id || undefined,
      } : null;

      if (data.quota && (data.subscription?.id || serverConfig?.configId || data.profile?.id)) {
        const quotaConfigId = data.subscription?.id || serverConfig?.subscriptionId || serverConfig?.configId || data.profile?.id || 'vpn_config';
        await saveQuotaData({
          configId:    quotaConfigId,
          totalQuota:  Number(data.quota.totalQuota ?? data.subscription?.quotaTotalBytes ?? 0),
          usedQuota:   Number(data.quota.usedQuota ?? data.subscription?.quotaUsedBytes ?? 0),
          expiryDate:  data.subscription?.expireAt ?? data.quota.expiryDate ?? null,
        });
        const freshQuota = await loadQuotaData(quotaConfigId);
        if (freshQuota) setQuotaData(freshQuota);
      }

      if (serverConfig?.configHash) {
        await AsyncStorage.removeItem(`@sxb_blocked_hash_${serverConfig.configHash}`).catch(() => {});
      }

      // Multi-config : chaque abonnement est identifiable et provisionnable séparément.
      let isRemoteSuccess = true;
      const connectionsRes = await apiClient.get('/mobile/connections').catch(() => {
        isRemoteSuccess = false;
        return { data: { connections: [] } };
      });
      const remote = (connectionsRes.data?.connections || []) as VpnConnection[];
      setRemoteConnections(remote);
      // Provisionner chaque abonnement encore actif, même si les métadonnées de
      // quota ou d'échéance sont à zéro : le profil doit rester disponible pour une
      // connexion ultérieure sur un réseau zéro-rated.
      const connections = remote.filter((c: any) => c.status === 'active');

      // Seule une révocation/suppression explicitement retournée par le dashboard
      // purge le coffre local. Les états quota/expiration restent consultatifs.
      const invalidIds = remote.filter((c: any) => c.status === 'revoked' || c.status === 'deleted').map((c: any) => c.id);
      await Promise.all(invalidIds.map(id => configStore.remove(id).catch(() => ({ status: 'error' }))));

      // Nettoyage des configurations orphelines supprimées du dashboard (UNIQUEMENT si l'appel distant a réussi pour éviter de purger en mode hors-ligne)
      if (isRemoteSuccess) {
        const remoteIds = new Set(remote.map((c: any) => c.id));
        const localListBefore = await configStore.list();
        const registeredBefore = localListBefore.status === 'ok' ? localListBefore.value || [] : [];
        const orphanIds = registeredBefore
          .map((r: any) => r.configId)
          .filter((id: string) => !remoteIds.has(id));
        await Promise.all(orphanIds.map(id => configStore.remove(id).catch(() => ({ status: 'error' }))));
      }

      // Provisionnement proactif : pour chaque connexion active ayant un token, on récupère la config complète.
      // Cela permet la connexion ultérieure sans data (mode hors-ligne / zero-rated).
      if (isRemoteSuccess && deviceId) {
        const { provisionAndStore } = require('@/services/provisionClient');
        for (const conn of connections) {
          if (conn.dataToken && conn.status === 'active') {
            try {
              await provisionAndStore(conn.dataToken, deviceId);
            } catch (pErr) {
              console.warn(`[Refresh] Échec provisionnement proactif pour ${conn.id}:`, pErr);
            }
          }
        }
      }

      const local = await configStore.list();
      const registered = local.status === 'ok' ? local.value || [] : [];

      const allConfigsMap = new Map();
      registered.forEach((r: any) => allConfigsMap.set(r.configId, { id: r.configId, name: r.name || 'Connexion VPN', protocol: r.displayProtocol || r.protocol || 'VPN', isActive: r.isActive }));
      connections.forEach((c: any) => {
        allConfigsMap.set(c.id, { id: c.id, name: c.name, protocol: c.displayProtocol || c.technicalProtocol, isActive: c.id === activeConfigId });
      });

      const mergedSaved = Array.from(allConfigsMap.values());
      setSavedConfigs(mergedSaved);

      const requestedActive = activeConfigId && connections.some(c => c.id === activeConfigId) ? activeConfigId : null;
      const activeId = requestedActive || mergedSaved.find(s => s.isActive)?.id || connections[0]?.id;
      const activeRemote = connections.find((c: any) => c.id === activeId) || connections[0] || null;
      setActiveConnection(activeRemote);
      if (activeRemote) {
        setRevokedStatus('none');
        if (activeRemote.quota) {
          const exactQuota = await saveQuotaData({
            configId: activeRemote.id,
            totalQuota: Number(activeRemote.quota.totalBytes ?? (activeRemote.quota.totalGB || 0) * 1024 ** 3),
            usedQuota: Number(activeRemote.quota.usedBytes ?? (activeRemote.quota.usedGB || 0) * 1024 ** 3),
            expiryDate: activeRemote.expiresAt ?? null,
          }).catch(() => null);
          if (exactQuota) setQuotaData(exactQuota);
        }
      }
      if (activeId) {
        setActiveConfigId(activeId);
        await refreshAccountState(activeId);
        await configStore.setActive(activeId);
        const activeStore = await configStore.get(activeId);
        if (activeStore.status === 'ok' && activeStore.value) {
          setVpnConfig(activeStore.value.config);
        } else if (activeRemote) {
          // Métadonnées du profil précis : le jeton associé est utilisé au premier provisionnement.
          setVpnConfig({ configId: activeRemote.id, displayProtocol: activeRemote.displayProtocol, dataToken: activeRemote.dataToken, configVersion: activeRemote.configVersion, configHash: activeRemote.configHash });
        } else {
          setVpnConfig(serverConfig);
        }
      } else {
        setVpnConfig(null);
      }
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401 || status === 403 || status === 404) {
        await invalidateRemoteAccess(status === 403 ? 'suspended' : 'revoked');
        return;
      }
      // mode hors-ligne : chargement complet depuis le registre local (multi-config préservées)
      try {
        const local = await configStore.list();
        if (local.status === 'ok' && local.value && local.value.length > 0) {
          setSavedConfigs(local.value.map(c => ({
            id: c.configId,
            name: c.name || 'Connexion VPN',
            protocol: c.displayProtocol || c.protocol || 'VPN',
            isActive: !!c.isActive,
          })));
          const activeMeta = local.value.find(c => c.isActive) || local.value[0];
          if (activeMeta) {
            setActiveConfigId(activeMeta.configId);
            const activeStore = await configStore.get(activeMeta.configId);
            if (activeStore.status === 'ok' && activeStore.value) {
              setVpnConfig(activeStore.value.config);
            }
          }
        }
      } catch (_offlineErr) {
        // Ignorer
      }
    }
  }, [isAuthenticated, activeConfigId, refreshAccountState, invalidateRemoteAccess]);

  // Garde distant : une action dashboard doit couper l’accès même si le VPN
  // était déjà connecté et que l’utilisateur reste sur l’écran courant.
  useEffect(() => {
    if (!isAuthenticated) return;
    const verifyRemoteAccess = async () => {
      try {
        const res = await apiClient.get('/mobile/me', { timeout: 4000 });
        const state = res.data?.accountState?.state;
        if (state === 'suspended' || state === 'revoked') {
          await invalidateRemoteAccess(state);
        }
      } catch (err: any) {
        const status = err?.response?.status;
        if (status === 401 || status === 403 || status === 404) {
          await invalidateRemoteAccess(status === 403 ? 'suspended' : 'revoked');
        }
      }
    };
    void verifyRemoteAccess();
    // B12 — Cette sonde interrogeait /mobile/me toutes les 10 s sans jamais
    // s'interrompre, y compris application fermée : ~8 640 requêtes par jour et
    // par appareil. La cadence de premier plan est conservée (la révocation
    // depuis le dashboard doit rester immédiate), mais le tick est ignoré tant
    // que l'application n'est pas visible et un contrôle est déclenché dès le
    // retour au premier plan : même réactivité, plus aucun trafic en veille.
    guardTimerRef.current = setInterval(() => {
      if (!appActiveRef.current) return;
      void verifyRemoteAccess();
    }, 10_000);
    const foregroundSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void verifyRemoteAccess();
    });
    return () => {
      if (guardTimerRef.current) { clearInterval(guardTimerRef.current); guardTimerRef.current = null; }
      foregroundSub.remove();
    };
  }, [isAuthenticated, invalidateRemoteAccess]);

  useEffect(() => {
    const state = accountState?.state;
    if (state === 'suspended' || state === 'revoked') {
      void invalidateRemoteAccess(state);
    } else if (state === 'ready') {
      setRevokedStatus('none');
    }
  }, [accountState?.state, invalidateRemoteAccess]);

  // Restore the selected profile before any network request; a transient keystore error is not "no config".
  useEffect(() => {
    (async () => {
      const persistedId = await AsyncStorage.getItem('@sxb_active_config_id');
      const local = await configStore.list();
      if (local.status === 'ok' && local.value) {
        const id = persistedId && local.value?.some(c => c.configId === persistedId)
          ? persistedId : local.value?.find(c => c.isActive)?.configId || local.value[0]?.configId;
        if (id) {
          await configStore.setActive(id);
          setActiveConfigId(id);
          const activeStore = await configStore.get(id);
          if (activeStore.status === 'ok' && activeStore.value) {
            setVpnConfig(activeStore.value.config);
          }
        }
        setSavedConfigs(local.value.map(c => ({ id: c.configId, name: c.name || 'Connexion VPN', protocol: c.displayProtocol || c.protocol || 'VPN', isActive: !!c.isActive })));
      }
    })().catch(() => {});
    refreshVpnConfig();
  }, [refreshVpnConfig]);

  const syncFromConnection = useCallback((conn: VpnConnection) => {
    setActiveConnection(conn);
  }, []);

  // ── CONNECT ──────────────────────────────────────────────────────────────────
  const connect = useCallback(async () => {
    if (isConnecting || isConnected) return;
    const attemptId = ++connectionAttemptRef.current;
    // Retour UI immédiat : le bouton et l’animation changent avant toute E/S réseau.
    setIsConnecting(true);
    setVpnState('connecting');

    if (revokedStatus !== 'none') {
      addLog(`❌ Connexion impossible — compte ${revokedStatus === 'revoked' ? 'révoqué' : revokedStatus === 'suspended' ? 'suspendu' : revokedStatus === 'expired' ? 'expiré' : 'épuisé'}`);
      setIsConnecting(false);
      setVpnState('disconnected');
      return;
    }

    // Les anciennes versions pouvaient déposer un marqueur local de blocage à
    // partir d'un quota estimé. Il ne correspond pas à une révocation serveur ;
    // on le retire pour que le profil sécurisé puisse de nouveau être essayé.
    const provConfig = await loadProvisionedConfig();
    const blockedByConfigHashKey = provConfig?.meta?.configHash ? `@sxb_blocked_hash_${provConfig.meta.configHash}` : null;
    if (blockedByConfigHashKey && await AsyncStorage.getItem(blockedByConfigHashKey)) {
      await AsyncStorage.removeItem(blockedByConfigHashKey).catch(() => {});
      addLog('ℹ️ Ancien blocage local ignoré — profil sécurisé conservé');
    }

    // B6 — Échec vérification serveur = mode hors ligne honnête, pas de faux "expiré"
    try {
      const selectedId = activeConfigId || activeConnection?.id;
      const freshRes = await apiClient.get(
        selectedId ? `/mobile/vpn/config?subscriptionId=${encodeURIComponent(selectedId)}` : '/mobile/vpn/config',
        { timeout: 4000 },
      );
      const freshState = freshRes?.data?.state;
      const freshSubscriptionStatus = freshRes?.data?.subscription?.status;
      const remoteBlocked = freshState === 'suspended' || freshState?.startsWith('revok') || freshState === 'disabled'
        || freshSubscriptionStatus === 'suspended' || freshSubscriptionStatus === 'revoked';
      if (remoteBlocked) {
        const statusToSet = freshState === 'suspended' || freshSubscriptionStatus === 'suspended' ? 'suspended'
          : freshState?.startsWith('revok') || freshSubscriptionStatus === 'revoked' ? 'revoked'
          : 'disabled';
        setRevokedStatus(statusToSet);
        addLog(`❌ Connexion refusée : révocation confirmée par le serveur (${statusToSet})`);
        return;
      }
      if (freshState === 'expired' || freshState === 'exhausted') {
        addLog('ℹ️ État quota/échéance remonté par l’API — tentative conservée avec le profil local');
      }
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401 || status === 403 || status === 404) {
        await invalidateRemoteAccess(status === 403 ? 'suspended' : 'revoked');
        return;
      }
      addLog('ℹ️ Vérification réseau impossible — connexion hors-ligne sur dernier état connu');
    }

    if (attemptId !== connectionAttemptRef.current) return;
    resetStepLogs();
    addStepLog('preparing', 'step_preparing', 'active');
    addLog('🔄 Initialisation du tunnel VPN...');

    try {
      if (IS_ANDROID && SxbVpnNative) {
        updateStepStatus('preparing', 'done');
        addStepLog('security', 'step_checking_security', 'active');

        const hasPerm = SxbVpnNative.isVpnPermissionGranted();
        if (!hasPerm) {
          addStepLog('permission', 'step_permission_check', 'active');
          addLog('🔐 Demande de permission VPN...');
          const granted = await SxbVpnNative.requestVpnPermission();
          if (!granted) {
            addStepLog('permission', 'step_permission_denied', 'error');
            addLog('❌ Permission VPN refusée');
            setIsConnecting(false);
            return;
          }
          addStepLog('permission', 'step_permission_granted', 'done');
          addLog('✅ Permission VPN accordée');
        } else {
          addStepLog('permission', 'step_permission_granted', 'done');
        }

        addStepLog('security', 'step_security_ok', 'done');
        addStepLog('config', 'step_loading_config', 'active');
        addLog('🔐 Chargement configuration sécurisée...');
        let configToUse: any = null;

        const localResult = await configStore.getActive();
        if (localResult.status === 'error') {
          addLog('⚠️ Stockage temporairement illisible — nouvelle tentative…');
          setIsConnecting(false);
          return;
        }
        const offlineEntry = localResult.status === 'ok' && localResult.value
          ? { config: localResult.value.config, configId: localResult.value.meta.configId, protocol: localResult.value.meta.protocol || '' }
          : null;

        const hasCompleteOfflineConfig = Boolean(
          offlineEntry?.config && isCompleteOfflineConfig(offlineEntry.config).complete,
        );
        if (hasCompleteOfflineConfig && offlineEntry?.config) {
          if (isCompleteOfflineConfig(offlineEntry.config).complete) {
            configToUse = { ...offlineEntry.config };
            if (vpnConfig?.displayProtocol) configToUse.displayProtocol = vpnConfig.displayProtocol;
            if (vpnConfig?.configId)        configToUse.configId        = vpnConfig.configId;
            addLog('✅ Configuration sécurisée chargée — mode hors-ligne, aucun provisionnement requis');
          }
        }

        // Une configuration complète en cache est autonome : ne jamais appeler
        // provisionAndStore() dans connect(). Le provisionnement initial s'effectue
        // uniquement lors de l'activation/import ou lorsqu'aucun profil complet n'existe.
        if (!configToUse) {
          const dataToken =
            ((vpnConfig as any)?.dataToken as string | undefined) ??
            ((offlineEntry?.config as any)?.dataToken as string | undefined) ??
            ((activeConnection as any)?.dataToken as string | undefined);

          if (dataToken && deviceId) {
            addStepLog('provisioning', 'step_provisioning', 'active');
            addLog('🔒 Provisionnement sécurisé en cours...');
            try {
              const freshResult = await provisionAndStore(dataToken, deviceId);
              const freshConfig = freshResult.config;

              configToUse = mergeConnectionMetadata(
                mergeProvisionedConfig(null, freshConfig),
                {
                  displayProtocol: vpnConfig?.displayProtocol ?? activeConnection?.displayProtocol ?? freshResult.meta.displayProtocol,
                  configId:        vpnConfig?.configId ?? activeConnection?.id ?? freshResult.meta.subscriptionId,
                  subscriptionId:  freshResult.meta.subscriptionId,
                  dataToken:       dataToken,
                  configVersion:   freshResult.meta.configVersion,
                  configHash:      freshResult.meta.configHash,
                },
              );

              await saveCompleteConfig(configToUse, (configToUse.protocol || 'vless').toLowerCase(), vpnConfig?.configId ?? activeConnection?.id, freshResult.meta.configExpiresAt);

              if (freshResult.meta.quotaGB > 0) {
                const totalB = Math.round(freshResult.meta.quotaGB * 1024 ** 3);
                const usedB = Math.round(freshResult.meta.quotaUsedGB * 1024 ** 3);
                await saveQuotaData({
                  configId:    freshResult.meta.subscriptionId || 'provision',
                  totalQuota:  totalB,
                  usedQuota:   usedB,
                  expiryDate:  freshResult.meta.expireAt,
                }).catch(() => {});
              }

              addStepLog('provisioning', 'step_provisioned', 'done');
              addLog('✅ Configuration provisionnée avec succès');
            } catch (provErr: unknown) {
              const diagnostic = provErr instanceof ProvisioningError ? provErr.diagnostic : undefined;
              if (diagnostic?.code === 'PVN_NETWORK' || diagnostic?.code === 'PVN_TIMEOUT' || !diagnostic?.httpStatus) {
                const fallbackLocal = await configStore.getActive();
                if (fallbackLocal.status === 'ok' && fallbackLocal.value?.config) {
                  configToUse = fallbackLocal.value.config;
                  addLog('ℹ️ Réseau restreint / hors-ligne détecté — utilisation du profil local sécurisé');
                } else if (activeConnection) {
                  configToUse = { ...activeConnection };
                  addLog('ℹ️ Réseau restreint / hors-ligne détecté — utilisation de la connexion active en cache');
                }
              }

              if (!configToUse) {
                const details = diagnostic
                  ? ` [${diagnostic.code}; étape=${diagnostic.stage}; essais=${diagnostic.attempts}${diagnostic.httpStatus ? `; HTTP=${diagnostic.httpStatus}` : ''}${diagnostic.requestId ? `; req=${diagnostic.requestId}` : ''}]`
                  : '';
                const message = provErr instanceof Error ? provErr.message : 'erreur inconnue';
                addStepLog('provisioning', 'step_error', 'error', diagnostic?.code || 'PVN_UNKNOWN');
                addLog(`⚠️ Provisionnement échoué : ${message}${details}`);
                setVpnState('error');
                setIsConnecting(false);
                return;
              }
              addStepLog('provisioning', 'step_provisioned', 'done');
              addLog('✅ Configuration locale chargée en mode hors-ligne');
            }
          } else {
            addLog('❌ Aucune configuration disponible — activez un forfait');
            setVpnState('error');
            setIsConnecting(false);
            return;
          }
        }

        if (!configToUse.host && configToUse.protocol !== 'wireguard' && configToUse.protocol !== 'singbox') {
          addLog('❌ Configuration invalide — champ "host" manquant');
          setVpnState('error');
          setIsConnecting(false);
          return;
        }

        const completeness = isCompleteOfflineConfig(configToUse);
        if (!completeness.complete) {
          addLog(`❌ Configuration incomplète — champs manquants : ${completeness.missing.join(', ')}`);
          setVpnState('error');
          setIsConnecting(false);
          return;
        }

        updateStepStatus('config', 'done');
        addStepLog('quota', 'step_quota_check', 'active');

        // En mode hors-ligne / zero-rated, si une configuration locale complète existe,
        // on autorise la tentative de connexion même si le quota enregistré localement semble épuisé,
        // car l'opérateur mobile zero-rated permet d'atteindre le serveur VPN sans data classique.
        const exhausted = await isQuotaExhausted();
        if (exhausted) {
          addLog('ℹ️ Quota local estimé épuisé — tentative de connexion quand même (zéro-rated / hors-ligne)');
        }
        const expired = await isConfigExpired();
        if (expired) {
          addLog('ℹ️ Date d’expiration locale atteinte — tentative de connexion quand même en mode de secours');
        }
        addStepLog('quota', 'step_quota_ok', 'done');

        // Une déconnexion demandée pendant le provisionnement annule le départ
        // avant tout appel natif long ou ouverture de tunnel.
        if (attemptId !== connectionAttemptRef.current) return;
        const engineProtocol = (configToUse.protocol || selectedProtocol || 'vless').toLowerCase();

        // Capturer le baseline initial natif
        try {
          const stats = await SxbVpnNative.getTrafficStats();
          const initUp = stats?.uploadBytes || 0;
          const initDown = stats?.downloadBytes || 0;
          sessionBaselineRef.current = { up: initUp, down: initDown };
          lastReportUpRef.current = initUp;
          lastReportDownRef.current = initDown;
        } catch {
          sessionBaselineRef.current = { up: 0, down: 0 };
          lastReportUpRef.current = 0;
          lastReportDownRef.current = 0;
        }

        const optionsJson = JSON.stringify(sanitizeEngineConfig({
          ...configToUse,
          protocol:      engineProtocol,
          killSwitch,
          autoReconnect,
          includeOwnApp: true,
        }));

        addStepLog('connecting', 'step_connecting', 'active');
        addLog(`🚀 Démarrage tunnel ${engineProtocol.toUpperCase()}...`);

        acceptNativeConnectedRef.current = true;
        startWatchdog(`STEP_3_NATIVE_CALLED proto=${engineProtocol}`, attemptId);
        await SxbVpnNative.startVpn(optionsJson);
        if (attemptId !== connectionAttemptRef.current) return;
        addStepLog('handshake', 'step_handshake', 'active');
        addLog('⏳ Connexion en cours...');
      } else {
        await apiClient.post('/mobile/vpn/session', { action: 'connect', protocol: selectedProtocol || 'VLESS' });
        await new Promise(r => setTimeout(r, 1200));
        setIsConnected(true);
        setVpnState('connected');
        await AsyncStorage.setItem('@sxb_vpn_connected', 'true');
        addLog('✅ Connecté (mode web dev)');
        setIsConnecting(false);
      }
    } catch (err: any) {
      if (attemptId !== connectionAttemptRef.current) return;
      addLog(`❌ Erreur : ${err?.message || 'Connexion échouée'}`);
      setVpnState('error');
      setIsConnecting(false);
    }
  }, [isConnecting, isConnected, revokedStatus, vpnConfig, activeConnection, killSwitch, autoReconnect, deviceId, addLog, startWatchdog, resetStepLogs, addStepLog, updateStepStatus, invalidateRemoteAccess]);

  useEffect(() => { connectRef.current = connect; });

  // La reconnexion est différée au rendu suivant : connect() lit ainsi le profil B
  // et non la fermeture React capturée avant setActiveConfigId.
  useEffect(() => {
    if (!pendingAutoConnectRef.current || pendingAutoConnectRef.current !== activeConfigId) return;
    if (isConnecting || isConnected) return;
    pendingAutoConnectRef.current = null;
    void connectRef.current?.();
  }, [activeConfigId, isConnecting, isConnected]);

  // ── B2 — PERSISTANCE À LA DÉCONNEXION ────────────────────────────────────────
  const disconnect = useCallback(async () => {
    if (!isConnecting && !isConnected) return;
    // L’interface revient immédiatement à « Se connecter » ; l’arrêt natif et
    // l’envoi du quota se poursuivent ensuite sans bloquer l’utilisateur.
    ++connectionAttemptRef.current;
    acceptNativeConnectedRef.current = false;
    stopWatchdog();
    setIsConnecting(false);
    setIsConnected(false);
    setVpnState('disconnected');
    addStepLog('disconnecting', 'step_disconnecting', 'active');
    addLog('🔴 Déconnexion...');

    try {
      let finalUp = 0;
      let finalDown = 0;

      if (IS_ANDROID && SxbVpnNative) {
        try {
          const stats = await SxbVpnNative.getTrafficStats();
          finalUp = stats?.uploadBytes || 0;
          finalDown = stats?.downloadBytes || 0;
        } catch { /* ignore */ }

        await SxbVpnNative.stopVpn();
      } else {
        await apiClient.post('/mobile/vpn/session', { action: 'disconnect' });
        await new Promise(r => setTimeout(r, 600));
      }

      // B2 : Calcule le delta de la session et persiste via consumeQuotaLocally AVANT la remise à zéro
      const deltaUp = Math.max(0, finalUp - lastReportUpRef.current);
      const deltaDown = Math.max(0, finalDown - lastReportDownRef.current);
      const totalDelta = deltaUp + deltaDown;

      if (totalDelta > 0) {
        await consumeQuotaLocally(totalDelta, activeConfigId || undefined);
        const loaded = await loadQuotaData(activeConfigId || undefined);
        if (loaded) setQuotaData(loaded);
      }

      // PUIS envoie le rapport delta final au backend
      if (finalUp > 0 || finalDown > 0) {
        await reportUsageToBackend(finalUp, finalDown);
      }
    } catch (err: any) {
      addLog(`⚠️ Erreur déconnexion : ${err?.message || ''}`);
    } finally {
      setIsConnected(false);
      setVpnState('disconnected');
      await AsyncStorage.setItem('@sxb_vpn_connected', 'false');
      setIsConnecting(false);

      // Remise à zéro des références de session
      lastReportUpRef.current = 0;
      lastReportDownRef.current = 0;
      sessionBaselineRef.current = { up: 0, down: 0 };
      sessionIdRef.current = null;
      seqRef.current = 0;
    }
  }, [isConnecting, isConnected, activeConfigId, addLog, reportUsageToBackend, addStepLog]);

  // B8 — Bascule atomique. Un abonnement distant actif peut être choisi avant
  // son premier provisionnement local : il est alors provisionné avec SON jeton.
  const switchConfig = useCallback(async (configId: string) => {
    if (isSwitchingConfig || configId === activeConfigId) return;
    const remoteTarget = remoteConnections.find(c => c.id === configId) || null;
    if (remoteTarget && remoteTarget.status !== 'active') {
      addLog(`❌ Cette configuration est ${remoteTarget.status} et ne peut pas être sélectionnée.`);
      return;
    }

    setIsSwitchingConfig(true);
    const previousId = activeConfigId;
    const wasConnected = isConnected;
    try {
      let target = await configStore.get(configId);
      if ((target.status !== 'ok' || !target.value) && remoteTarget) {
        if (!deviceId) throw new Error('Identifiant appareil indisponible — reconnectez-vous puis réessayez');
        addLog(`🔒 Provisionnement de « ${remoteTarget.name} »...`);
        const fresh = await provisionAndStore(remoteTarget.dataToken, deviceId);
        const provisioned = mergeConnectionMetadata(mergeProvisionedConfig(null, fresh.config), {
          configId,
          subscriptionId: fresh.meta.subscriptionId,
          displayProtocol: remoteTarget.displayProtocol || fresh.meta.displayProtocol,
          dataToken: remoteTarget.dataToken,
          configVersion: fresh.meta.configVersion,
          configHash: fresh.meta.configHash,
        });
        const stored = await saveCompleteConfig(provisioned, (provisioned.protocol || remoteTarget.technicalProtocol || 'vless').toLowerCase(), configId, fresh.meta.configExpiresAt);
        if (!stored) throw new Error('La configuration reçue est incomplète');
        target = await configStore.get(configId);
      }
      if (target.status !== 'ok' || !target.value) {
        throw new Error(target.status === 'error' ? 'Stockage temporairement illisible — nouvelle tentative…' : 'Configuration absente');
      }

      if (wasConnected) { addLog(`🔄 Basculement de configuration → ${configId}...`); await disconnect(); }
      await configStore.setActive(configId);
      setActiveConfigId(configId);
      setActiveConnection(remoteTarget || activeConnection);
      setRevokedStatus('none');
      setQuotaData(await loadQuotaData(configId));
      setVpnConfig({ ...target.value.config, configId, displayProtocol: target.value.meta.displayProtocol || remoteTarget?.displayProtocol, dataToken: (target.value.config as any).dataToken || remoteTarget?.dataToken });
      if (wasConnected) pendingAutoConnectRef.current = configId;
    } catch (err: any) {
      pendingAutoConnectRef.current = null;
      if (previousId) {
        await configStore.setActive(previousId);
        setActiveConfigId(previousId);
        const previous = await configStore.get(previousId);
        const previousRemote = remoteConnections.find(c => c.id === previousId) || null;
        if (previous.status === 'ok' && previous.value) {
          setVpnConfig({ ...previous.value.config, configId: previousId, dataToken: (previous.value.config as any).dataToken || previousRemote?.dataToken });
        }
        setActiveConnection(previousRemote);
        setQuotaData(await loadQuotaData(previousId));
        if (wasConnected) pendingAutoConnectRef.current = previousId;
      }
      addLog(`⚠️ Basculement annulé : ${err?.message || 'erreur réseau'}`);
    } finally { setIsSwitchingConfig(false); }
  }, [isSwitchingConfig, isConnected, activeConfigId, activeConnection, remoteConnections, deviceId, disconnect, addLog]);

  const selectProtocol = useCallback(async (name: string) => {
    setSelectedProtocol(name);
    await AsyncStorage.setItem('@sxb_vpn_protocol', name);
    if (isConnected) {
      addLog(`🔄 Changement protocole → ${name}...`);
      await disconnect();
      setTimeout(() => connect(), 800);
    }
  }, [isConnected, connect, disconnect, addLog]);

  // B5 — `vpnConfig !== null` suffisait à activer le bouton alors qu'un profil
  // partiel (champs manquants) fait échouer le démarrage du tunnel côté natif.
  // On exige désormais un profil réellement complet, tout en conservant le repli
  // sur une connexion serveur active pour ne bloquer personne.
  const hasValidConfig = useMemo(
    () => (vpnConfig !== null && isCompleteOfflineConfig(vpnConfig).complete) || activeConnection !== null,
    [vpnConfig, activeConnection],
  );

  return (
    <VpnContext.Provider value={{
      isConnected, isConnecting, vpnState,
      selectedProtocol, connectedProtocol, availableProtocols,
      trafficStats, vpnLogs,
      hasVpnPermission,
      hasValidConfig,
      activeConnection,
      stepLogs,
      savedConfigs, activeConfigId, switchConfig, isSwitchingConfig,
      quotaData,
      derivedQuota: currentDerivedQuota,
      revokedStatus,
      perAppTraffic,
      logs:          vpnLogs,
      traffic:       trafficStats,
      killSwitch,
      autoReconnect,
      setKillSwitch: setKillSwitchState,
      setAutoReconnect: setAutoReconnectState,
      syncFromConnection,
      connect, disconnect, selectProtocol,
      refreshVpnConfig, requestPermission,
    }}>
      {children}
    </VpnContext.Provider>
  );
}

const FALLBACK_PROTOCOLS: VpnProtocol[] = [
  { name: 'VLESS',       port: 443,  transport: 'TCP',  security: 'Reality',     description: 'Recommandé' },
  { name: 'VMess',       port: 80,   transport: 'WS',   security: 'None',        description: 'Compatible' },
  { name: 'Trojan',      port: 443,  transport: 'TCP',  security: 'TLS',         description: 'Stable' },
  { name: 'Shadowsocks', port: 8388, transport: 'TCP',  security: 'ChaCha20',    description: 'Léger' },
  { name: 'Hysteria2',   port: 443,  transport: 'QUIC', security: 'TLS',         description: 'Rapide' },
  { name: 'SSH',         port: 22,   transport: 'TCP',  security: 'SSH',         description: 'Sécurisé' },
  { name: 'SSH+Payload', port: 80,   transport: 'TCP',  security: 'SSH+Payload', description: 'Bypass DPI' },
  { name: 'WireGuard',   port: 51820, transport: 'UDP', security: 'WireGuard',   description: 'Rapide & sécurisé' },
  { name: 'TUIC',        port: 443,  transport: 'QUIC', security: 'TLS',         description: 'QUIC optimisé' },
];

export function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 B/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
  return `${parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function useVpnContext() {
  return useContext(VpnContext);
}

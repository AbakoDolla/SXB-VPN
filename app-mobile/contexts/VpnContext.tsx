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
  createContext, useCallback, useContext, useEffect, useRef, useState,
} from 'react';
import { legacyDebugLog } from '@/services/secureLogger';
import {
  NativeModules, NativeEventEmitter, Platform, PermissionsAndroid,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient from '@/services/apiClient';
import {
  saveVpnConfig, saveQuotaData, loadQuotaData,
  isQuotaExhausted, isConfigExpired, consumeQuotaLocally,
} from '@/services/offlineStorage';
import type { QuotaData } from '@/services/offlineStorage';
import { provisionAndStore, loadProvisionedConfig, clearProvisionedConfig } from '@/services/provisionClient';
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
  downloadSpeed: number;   // bytes/sec
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

const DEFAULT_STATS: TrafficStats = { uploadBytes: 0, downloadBytes: 0, uploadSpeed: 0, downloadSpeed: 0 };
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
  const { isAuthenticated, accountState, refreshAccountState, deviceId } = useAuthContext();

  const [isConnected,        setIsConnected]        = useState(false);
  const [isConnecting,       setIsConnecting]        = useState(false);
  const [vpnState,           setVpnState]            = useState('disconnected');
  const [selectedProtocol,   setSelectedProtocol]    = useState<string | null>(null);
  const [connectedProtocol,  setConnectedProtocol]   = useState<string | null>(null);
  const [availableProtocols, setAvailableProtocols]  = useState<VpnProtocol[]>([]);
  const [trafficStats,       setTrafficStats]        = useState<TrafficStats>(DEFAULT_STATS);
  const [vpnLogs,            setVpnLogs]             = useState<string[]>([]);
  const [hasVpnPermission,   setHasVpnPermission]    = useState(false);
  const [vpnConfig,          setVpnConfig]           = useState<any>(null);
  const [activeConnection,   setActiveConnection]    = useState<VpnConnection | null>(null);
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

  const startWatchdog = useCallback((stepName: string) => {
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    watchdogRef.current = setTimeout(() => {
      legacyDebugLog(`WATCHDOG_TIMEOUT step=${stepName} — aucun événement natif depuis 45s`);
      addLog(`⚠️ Délai dépassé (45s) lors de : ${stepName}. Arrêt du service...`);
      if (IS_ANDROID && SxbVpnNative) {
        try { SxbVpnNative.stopVpn(); } catch { /* ignore */ }
      }
      setIsConnecting(false);
      setVpnState('error');
    }, 45_000);
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

    const stateSub = vpnEmitter.addListener('onVpnStateChange', (e: { state: string }) => {
      const s = (e?.state || 'disconnected').toLowerCase();
      setVpnState(s);

      if (s === 'connected') {
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
        
        refreshAccountState().catch(() => {});
      } else if (s === 'disconnected') {
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
      try {
        const stats = await SxbVpnNative.getTrafficStats();
        setTrafficStats({
          uploadBytes:   stats.uploadBytes   || 0,
          downloadBytes: stats.downloadBytes || 0,
          uploadSpeed:   stats.uploadSpeed   || 0,
          downloadSpeed: stats.downloadSpeed || 0,
        });
      } catch { /* ignore */ }
    }, 1500);
  }, []);

  const stopTrafficPolling = useCallback(() => {
    if (trafficTimerRef.current) { clearInterval(trafficTimerRef.current); trafficTimerRef.current = null; }
  }, []);

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
      });

      // Mettre à jour lastReported SEULEMENT après envoi réussi
      lastReportUpRef.current   = up;
      lastReportDownRef.current = down;

      if (result?.data?.quotaRemainingBytes !== undefined) {
        const remainingBytes = Number(result.data.quotaRemainingBytes);
        const currentQuota = await loadQuotaData().catch(() => null);
        if (currentQuota) {
          const usedBytes = Math.max(0, currentQuota.totalQuota - remainingBytes);
          setQuotaData(prev => prev ? { ...prev, usedQuota: usedBytes, remainingQuota: remainingBytes } : prev);
          await saveQuotaData({
            configId: currentQuota.configId,
            totalQuota: currentQuota.totalQuota,
            usedQuota: usedBytes,
            expiryDate: currentQuota.expiryDate,
          }).catch(() => {});
        }
      }

      const remoteState = result?.data?.state;
      const isRevokedState =
        remoteState === 'suspended' ||
        remoteState?.startsWith('revok') ||
        remoteState === 'expired' ||
        remoteState === 'disabled' ||
        remoteState === 'exhausted';

      if (isRevokedState || result?.data?.quotaExhausted) {
        const statusToSet = remoteState === 'suspended' ? 'suspended'
          : remoteState?.startsWith('revok') ? 'revoked'
          : remoteState === 'expired' ? 'expired'
          : remoteState === 'exhausted' ? 'exhausted'
          : 'disabled';

        addLog(`❌ Compte ${statusToSet} ou quota épuisé — arrêt du VPN`);
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

      return result;
    } catch {
      // Rejet/Échec réseau : conserver le delta non envoyé pour le rejouer plus tard
      return undefined;
    }
  }, [isAuthenticated, addLog, activeConfigId, activeConnection]);

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
    }, 60_000);
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

  // ── B5 — GARDE DURE LOCALE (5 s) ─────────────────────────────────────────────
  useEffect(() => {
    if (!isConnected) return;
    guardTimerRef.current = setInterval(async () => {
      try {
        const derived = deriveQuota(
          quotaData || accountState,
          {
            sessionUp: trafficStats.uploadBytes,
            sessionDown: trafficStats.downloadBytes,
            sessionBaselineUp: sessionBaselineRef.current.up,
            sessionBaselineDown: sessionBaselineRef.current.down,
          },
          isConnected
        );

        const activeConfig = await loadProvisionedConfig();
        const configHash = activeConfig?.meta?.configHash;

        if (derived.isExhausted || derived.isExpired) {
          const reason = derived.isExhausted ? 'exhausted' : 'expired';
          const logMsg = derived.isExhausted
            ? 'Forfait épuisé — configuration retirée. Rechargez pour une nouvelle configuration.'
            : 'Forfait expiré — configuration retirée. Renouvelez votre forfait.';

          addLog(`❌ ${logMsg}`);
          if (IS_ANDROID && SxbVpnNative) {
            try { await SxbVpnNative.stopVpn(); } catch { /* ignore */ }
          }
          setIsConnected(false);
          setIsConnecting(false);
          setVpnState('disconnected');
          await AsyncStorage.setItem('@sxb_vpn_connected', 'false').catch(() => {});
          await clearProvisionedConfig().catch(() => {});
          setRevokedStatus(reason);

          if (configHash) {
            const blockedByConfigHashKey = `@sxb_blocked_hash_${configHash}`;
            await AsyncStorage.setItem(blockedByConfigHashKey, 'true').catch(() => {});
          }

          if (activeConnection?.id) {
            apiClient.post(`/mobile/connections/${activeConnection.id}/status`, { disabledReason: reason }).catch(() => {});
          }
        }
      } catch { /* ignore */ }
    }, 5000);

    return () => { if (guardTimerRef.current) clearInterval(guardTimerRef.current); };
  }, [isConnected, quotaData, accountState, trafficStats, activeConnection, addLog]);

  // Quota polling
  const refreshQuotaData = useCallback(async () => {
    try {
      const loaded = await loadQuotaData();
      if (loaded) setQuotaData(loaded);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    refreshQuotaData();
    quotaTimerRef.current = setInterval(refreshQuotaData, 60_000);
    return () => { if (quotaTimerRef.current) { clearInterval(quotaTimerRef.current); quotaTimerRef.current = null; } };
  }, [refreshQuotaData]);

  const refreshVpnConfig = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const res = await apiClient.get('/mobile/vpn/config');
      const data = res.data;

      if (data.quota && Number(data.quota.totalQuota) > 0) {
        await saveQuotaData({
          configId:    data.vpnConfig?.configId ?? data.profile?.id ?? 'vpn_config',
          totalQuota:  Number(data.quota.totalQuota) || 0,
          usedQuota:   Number(data.quota.usedQuota)   || 0,
          expiryDate:  data.quota.expiryDate ?? null,
        });
        const freshQuota = await loadQuotaData();
        if (freshQuota) setQuotaData(freshQuota);
      }

      if (data.vpnConfig?.configHash) {
        await AsyncStorage.removeItem(`@sxb_blocked_hash_${data.vpnConfig.configHash}`).catch(() => {});
      }

      // Multi-config & offline resilience: merge local registry and server connections
      const connectionsRes = await apiClient.get('/mobile/connections').catch(() => ({ data: { connections: [] } }));
      const connections = (connectionsRes.data?.connections || []).filter((c: any) =>
        c.status === 'active' && (!c.expiresAt || new Date(c.expiresAt) > new Date()) && Number(c.quota?.remainingBytes ?? 1) > 0,
      );
      const local = await configStore.list();
      const registered = local.status === 'ok' ? local.value || [] : [];

      const allConfigsMap = new Map();
      registered.forEach((r: any) => allConfigsMap.set(r.configId, { id: r.configId, name: r.name || 'Connexion VPN', protocol: r.displayProtocol || r.protocol || 'VPN', isActive: r.isActive }));
      connections.forEach((c: any) => {
        allConfigsMap.set(c.id, { id: c.id, name: c.name, protocol: c.displayProtocol || c.technicalProtocol, isActive: c.id === activeConfigId });
      });

      const mergedSaved = Array.from(allConfigsMap.values());
      setSavedConfigs(mergedSaved);

      const activeId = activeConfigId || mergedSaved.find(s => s.isActive)?.id || mergedSaved[0]?.id;
      if (activeId) {
        setActiveConfigId(activeId);
        await configStore.setActive(activeId);
        const activeStore = await configStore.get(activeId);
        if (activeStore.status === 'ok' && activeStore.value) {
          setVpnConfig(activeStore.value.config);
        } else {
          setVpnConfig(data.vpnConfig || null);
        }
      } else {
        setVpnConfig(data.vpnConfig || null);
      }
    } catch {
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
  }, [isAuthenticated, activeConfigId]);

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

    if (revokedStatus !== 'none') {
      addLog(`❌ Connexion impossible — compte ${revokedStatus === 'revoked' ? 'révoqué' : revokedStatus === 'suspended' ? 'suspendu' : revokedStatus === 'expired' ? 'expiré' : 'épuisé'}`);
      return;
    }

    // B5 — Vérifier si bloqué par blockedByConfigHash
    const provConfig = await loadProvisionedConfig();
    const blockedByConfigHashKey = provConfig?.meta?.configHash ? `@sxb_blocked_hash_${provConfig.meta.configHash}` : null;
    if (blockedByConfigHashKey) {
      const blockedByConfigHash = await AsyncStorage.getItem(blockedByConfigHashKey);
      if (blockedByConfigHash === 'true') {
        const isExhausted = await isQuotaExhausted();
        const msg = isExhausted
          ? 'Forfait épuisé — configuration retirée. Rechargez pour une nouvelle configuration.'
          : 'Forfait expiré — configuration retirée. Renouvelez votre forfait.';
        addLog(`❌ ${msg}`);
        setIsConnecting(false);
        return;
      }
    }

    // B6 — Échec vérification serveur = mode hors ligne honnête, pas de faux "expiré"
    try {
      const freshRes = await apiClient.get('/mobile/vpn/config', { timeout: 4000 });
      const freshState = freshRes?.data?.state;
      if (
        freshState === 'suspended' ||
        freshState?.startsWith('revok') ||
        freshState === 'expired' ||
        freshState === 'disabled' ||
        freshState === 'exhausted'
      ) {
        const statusToSet = freshState === 'suspended' ? 'suspended'
          : freshState?.startsWith('revok') ? 'revoked'
          : freshState === 'expired' ? 'expired'
          : freshState === 'exhausted' ? 'exhausted'
          : 'disabled';
        setRevokedStatus(statusToSet);
        addLog(`❌ Connexion refusée par le serveur : compte ${statusToSet}`);
        return;
      }
    } catch {
      addLog('ℹ️ Vérification réseau impossible — connexion hors-ligne sur dernier état connu');
    }

    setIsConnecting(true);
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

        if (offlineEntry?.config) {
          const storedCheck = isCompleteOfflineConfig(offlineEntry.config);
          if (storedCheck.complete) {
            configToUse = { ...offlineEntry.config };
            if (vpnConfig?.displayProtocol) configToUse.displayProtocol = vpnConfig.displayProtocol;
            if (vpnConfig?.configId)        configToUse.configId        = vpnConfig.configId;
            addLog('✅ Configuration sécurisée chargée');
          }
        }

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

              const newlyBlocked = freshResult.meta.configHash && await AsyncStorage.getItem(`@sxb_blocked_hash_${freshResult.meta.configHash}`);
              if (newlyBlocked === 'true' && freshResult.meta.quotaUsedGB >= freshResult.meta.quotaGB) {
                await configStore.remove(freshResult.meta.subscriptionId);
                throw new Error('Forfait épuisé — rechargez avant de vous reconnecter');
              }
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
            } catch (provErr: any) {
              const httpMsg = provErr?.response?.data?.error ?? provErr?.response?.data?.message ?? '';
              addLog(`⚠️ Provisionnement échoué : ${httpMsg || provErr?.message || 'erreur réseau'}`);
              setVpnState('error');
              setIsConnecting(false);
              return;
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

        const exhausted = await isQuotaExhausted();
        if (exhausted) {
          addStepLog('quota', 'step_quota_exhausted', 'error');
          addLog('❌ Quota data épuisé — rechargez votre abonnement');
          setIsConnecting(false);
          return;
        }
        const expired = await isConfigExpired();
        if (expired) {
          addStepLog('quota', 'step_expired', 'error');
          addLog('❌ Abonnement expiré — renouvelez votre abonnement');
          setIsConnecting(false);
          return;
        }
        addStepLog('quota', 'step_quota_ok', 'done');

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

        startWatchdog(`STEP_3_NATIVE_CALLED proto=${engineProtocol}`);
        await SxbVpnNative.startVpn(optionsJson);
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
      addLog(`❌ Erreur : ${err?.message || 'Connexion échouée'}`);
      setVpnState('error');
      setIsConnecting(false);
    }
  }, [isConnecting, isConnected, revokedStatus, vpnConfig, activeConnection, killSwitch, autoReconnect, deviceId, addLog, startWatchdog, resetStepLogs, addStepLog, updateStepStatus]);

  useEffect(() => { connectRef.current = connect; });

  // ── B2 — PERSISTANCE À LA DÉCONNEXION ────────────────────────────────────────
  const disconnect = useCallback(async () => {
    if (isConnecting && !isConnected) return;
    setIsConnecting(true);
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
        await consumeQuotaLocally(totalDelta);
        const loaded = await loadQuotaData();
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
  }, [isConnecting, isConnected, addLog, reportUsageToBackend, addStepLog]);

  // B8 — transaction: credentials are loaded first; failure always restores A and never removes either payload.
  const switchConfig = useCallback(async (configId: string) => {
    if (isSwitchingConfig || configId === activeConfigId) return;
    setIsSwitchingConfig(true);
    const previousId = activeConfigId;
    const target = await configStore.get(configId);
    try {
      if (target.status !== 'ok' || !target.value) throw new Error(target.status === 'error' ? 'Stockage temporairement illisible — nouvelle tentative…' : 'Configuration absente');
      if (isConnected) { addLog(`🔄 Basculement de configuration → ${configId}...`); await disconnect(); }
      // The active pointer is switched only while starting B, and is rolled back atomically on failure.
      await configStore.setActive(configId);
      setActiveConfigId(configId);
      const targetQuota = await loadQuotaData(configId);
      setQuotaData(targetQuota);
      setVpnConfig({ ...target.value.config, configId, displayProtocol: target.value.meta.displayProtocol, dataToken: target.value.meta.dataToken });
      await connect();
      await configStore.setActive(configId);
    } catch (err: any) {
      if (previousId) {
        await configStore.setActive(previousId);
        setActiveConfigId(previousId);
        const previous = await configStore.get(previousId);
        if (previous.status === 'ok' && previous.value) setVpnConfig({ ...previous.value.config, configId: previousId, dataToken: previous.value.meta.dataToken });
        setQuotaData(await loadQuotaData(previousId));
        if (isConnected) await disconnect();
        await connect();
      }
      addLog(`⚠️ Basculement annulé : ${err?.message || 'erreur réseau'}`);
    } finally { setIsSwitchingConfig(false); }
  }, [isSwitchingConfig, isConnected, activeConfigId, connect, disconnect, addLog]);

  const selectProtocol = useCallback(async (name: string) => {
    setSelectedProtocol(name);
    await AsyncStorage.setItem('@sxb_vpn_protocol', name);
    if (isConnected) {
      addLog(`🔄 Changement protocole → ${name}...`);
      await disconnect();
      setTimeout(() => connect(), 800);
    }
  }, [isConnected, connect, disconnect, addLog]);

  const hasValidConfig = vpnConfig !== null || activeConnection !== null;

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

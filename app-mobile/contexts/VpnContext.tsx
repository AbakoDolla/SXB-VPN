/**
 * VpnContext — Moteur VPN réel SXB v5.1
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
  NativeModules, NativeEventEmitter, Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient from '@/services/apiClient';
import { saveVpnConfig, loadVpnConfig, saveQuotaData, isQuotaExhausted, isConfigExpired } from '@/services/offlineStorage';
import { provisionAndStore, loadProvisionedConfig, clearProvisionedConfig } from '@/services/provisionClient';
import {
  isCompleteOfflineConfig,
  mergeConnectionMetadata,
  mergeProvisionedConfig,
  sanitizeEngineConfig,
} from '@/services/configValidator';
import { useAuthContext } from './AuthContext';
import type { VpnConnection } from '@/types/api';

// ── Helper : sauvegarde protégée (jamais de config incomplète) ──────────────────
// Retourne true si la config a été sauvegardée, false si elle était incomplète.
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

const VpnContext = createContext<VpnContextType>({
  isConnected: false, isConnecting: false, vpnState: 'disconnected',
  selectedProtocol: null, connectedProtocol: null, availableProtocols: [],
  trafficStats: DEFAULT_STATS, vpnLogs: [],
  hasVpnPermission: false, hasValidConfig: false, activeConnection: null,
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
  const { isAuthenticated, refreshAccountState, deviceId } = useAuthContext();

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

  const trafficTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const reportTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionStartRef  = useRef<number>(0);

  const watchdogRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStepRef  = useRef<string>('INIT');

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
  }, []);

  const startWatchdog = useCallback((lastStep: string) => {
    clearWatchdog();
    lastStepRef.current = lastStep;
    watchdogRef.current = setTimeout(async () => {
      const step = lastStepRef.current;
      legacyDebugLog(`WATCHDOG_FIRED lastStep=${step}`);

      let errorCode = 'TIMEOUT_SERVER';
      let errorDetail = 'Aucune réponse du serveur après 45s';
      if (step.includes('ssh+payload')) {
        errorCode = 'TIMEOUT_SSH_PAYLOAD';
        errorDetail = 'Timeout SSH+Payload — vérifiez le payload et le serveur';
      } else if (step.includes('ssh')) {
        errorCode = 'SSH_TIMEOUT';
        errorDetail = 'Timeout SSH — serveur non joignable ou port fermé';
      } else if (step.includes('CONFIG')) {
        errorCode = 'INVALID_CONFIG';
        errorDetail = 'Configuration VPN invalide ou incomplète';
      }

      setVpnLogs(prev => [
        `[WATCHDOG] ❌ ${errorCode}`,
        `[WATCHDOG] Bloqué à : ${step}`,
        `[WATCHDOG] Cause probable : ${errorDetail}`,
        `[WATCHDOG] Arrêt du service après 45s sans réponse`,
        ...prev,
      ].slice(0, 200));

      if (IS_ANDROID && SxbVpnNative) {
        try { await SxbVpnNative.stopVpn(); } catch { /* ignore */ }
      }
      setIsConnecting(false);
      setVpnState('error');
    }, 45_000);
  }, [clearWatchdog]);

  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setVpnLogs(prev => [`[${ts}] ${msg}`, ...prev].slice(0, 200));
  }, []);

  const setKillSwitch = useCallback((v: boolean) => {
    setKillSwitchState(v);
    if (IS_ANDROID && SxbVpnNative) {
      try { SxbVpnNative.setKillSwitch(v); } catch { /* ignore */ }
    }
    AsyncStorage.setItem('@sxb_kill_switch', v ? 'true' : 'false').catch(() => {});
  }, []);

  const setAutoReconnect = useCallback((v: boolean) => {
    setAutoReconnectState(v);
    if (IS_ANDROID && SxbVpnNative) {
      try { SxbVpnNative.setAutoReconnect(v); } catch { /* ignore */ }
    }
    AsyncStorage.setItem('@sxb_auto_reconnect', v ? 'true' : 'false').catch(() => {});
  }, []);

  // ── Synchronisation depuis une connexion active (/mobile/connections) ──────
  // Modèle « intermédiaire » (mission §6) :
  //   • /mobile/connections = MÉTADONNÉES UNIQUEMENT (allowlist §6.4) —
  //     ne fournit JAMAIS de champ technique au moteur ;
  //   • la SEULE source technique est la config provisionnée déchiffrée
  //     (/provision/activate, stockée dans SecureStore) ;
  //   • invalidation de cache : changement d'abonnement OU configHash
  //     différent → purge atomique + re-provisionnement ;
  //   • aucune config incomplète n'est jamais persistée.
  const syncFromConnection = useCallback((conn: VpnConnection) => {
    legacyDebugLog(`ACTIVE_CONNECTION_FOUND id=${conn.id} proto=${conn.technicalProtocol} display=${conn.displayProtocol}`);
    legacyDebugLog(`ACTIVE_CONNECTION_FOUND id=${conn.id}`);

    // Étiquette technique informative (UI uniquement — jamais injectée dans
    // la config moteur ; la vérité technique vient du blob provisionné).
    const protocolLabel   = conn.technicalProtocol.toLowerCase();
    const displayProtocol = conn.displayProtocol;

    // Métadonnées de connexion autorisées à la fusion (allowlist §6.4)
    const connMeta: Record<string, any> = {
      displayProtocol,
      configId:        conn.id,
      subscriptionId:  conn.id,
      dataToken:       conn.dataToken,
      configVersion:   (conn as any).configVersion,
      configHash:      (conn as any).configHash,
    };

    // Métadonnées de connexion (non-sensibles, toujours disponibles)
    setActiveConnection(conn);
    setConnectedProtocol(displayProtocol);
    AsyncStorage.setItem('@sxb_connected_protocol', displayProtocol).catch(() => {});
    setSelectedProtocol(prev => {
      if (!prev) {
        AsyncStorage.setItem('@sxb_vpn_protocol', protocolLabel).catch(() => {});
        return protocolLabel;
      }
      return prev;
    });

    // ── Flux sécurisé : provisionner avant de sauvegarder ───────────────────
    // On ne sauvegarde JAMAIS une config incomplète. Le provisionnement
    // récupère les vraies données VPN (host, port, credentials, payload),
    // y ajoute les métadonnées de connexion (allowlist), valide la complétude,
    // puis enregistre uniquement le résultat complet dans SecureStore.
    const provisionFlow = async () => {
      // 1. Vérifier si une config provisionnée valide existe déjà —
      //    avec INVALIDATION §6.4 : autre abonnement OU hash différent.
      const existing = await loadProvisionedConfig().catch(() => null);
      if (existing) {
        const staleByProfile =
          !!existing.meta?.subscriptionId && existing.meta.subscriptionId !== conn.id;
        const staleByHash =
          !!existing.meta?.configHash && !!connMeta.configHash &&
          existing.meta.configHash !== connMeta.configHash;
        if (staleByProfile || staleByHash) {
          legacyDebugLog(`CONFIG_STALE ${staleByProfile ? 'subscription-changed' : 'config-hash-mismatch'} — PURGE atomique du cache provisionné`);
          await clearProvisionedConfig().catch(() => {});
        } else {
          // Cache valide et à jour — métadonnées seules ajoutées (technique intacte)
          const merged = mergeConnectionMetadata(existing.config, connMeta);
          const engineProtocol = (merged.protocol || protocolLabel).toLowerCase();
          const saved = await saveCompleteConfig(merged, engineProtocol, conn.id, existing.meta.configExpiresAt);
          if (saved) {
            setVpnConfig(merged);
            legacyDebugLog(`CONFIG_SYNC_SUCCESS proto=${engineProtocol} display="${displayProtocol}" (depuis cache provisionné)`);
            legacyDebugLog(`HOME_STATE_UPDATED hasValidConfig=true proto="${engineProtocol}" display="${displayProtocol}"`);
            return;
          }
        }
      }

      // 2. Pas de config provisionnée valide (ou périmée) — provisionnement
      if (conn.dataToken && deviceId) {
        legacyDebugLog('PROVISION_START — provisionnement sécurisé');
        try {
          const freshResult = await provisionAndStore(conn.dataToken!, deviceId);
          // Synchroniser le quota local (gardes offline : expiration + épuisement)
          if (freshResult.meta.quotaGB > 0) {
            await saveQuotaData({
              configId:    freshResult.meta.subscriptionId || conn.id,
              totalQuota:  Math.round(freshResult.meta.quotaGB * 1024 ** 3),
              usedQuota:   Math.round(freshResult.meta.quotaUsedGB * 1024 ** 3),
              expiryDate:  freshResult.meta.expireAt,
            }).catch(() => {});
          }
          // Provisionné = SEULE source technique (§6.1) ; connexion = allowlist (§6.4)
          const merged = mergeConnectionMetadata(
            mergeProvisionedConfig(null, freshResult.config),
            connMeta,
          );
          // La vérité technique du protocole vient du blob, pas de l'étiquette UI
          const engineProtocol = (merged.protocol || protocolLabel).toLowerCase();
          const saved = await saveCompleteConfig(merged, engineProtocol, conn.id, freshResult.meta.configExpiresAt);
          if (saved) {
            setVpnConfig(merged);
            legacyDebugLog(`CONFIG_SYNC_SUCCESS proto=${engineProtocol} display="${displayProtocol}"`);
            legacyDebugLog('PROVISION_OK — config complète stockée dans SecureStore');
            legacyDebugLog(`HOME_STATE_UPDATED hasValidConfig=true proto="${engineProtocol}" display="${displayProtocol}"`);
            legacyDebugLog(`HOME_STATE_UPDATED hasValidConfig=true proto=${engineProtocol} display=${displayProtocol}`);
            return;
          } else {
            legacyDebugLog('PROVISION_WARN — config provisionnée incomplète, sauvegarde refusée');
          }
        } catch (e: any) {
          legacyDebugLog(`PROVISION_WARN — ${e?.message || 'erreur réseau'}`);
        }
      }

      // 3. Provisionnement échoué — conserver l'ancienne config si valide ET à jour
      const offlineEntry = await loadVpnConfig().catch(() => null);
      if (offlineEntry?.config) {
        const check = isCompleteOfflineConfig(offlineEntry.config);
        if (check.complete) {
          // §6.4 : si le serveur annonce un autre hash, la config offline est
          // périmée — on ne l'utilise plus (re-provisionnement requis).
          if (connMeta.configHash && (offlineEntry.config as any).configHash &&
              (offlineEntry.config as any).configHash !== connMeta.configHash) {
            legacyDebugLog('CONFIG_OFFLINE_STALE config-hash-mismatch — re-provisionnement requis (internet)');
          } else {
            // Métadonnées de connexion ajoutées (allowlist — technique intacte)
            const merged = mergeConnectionMetadata(offlineEntry.config, connMeta);
            setVpnConfig(merged);
            legacyDebugLog('CONFIG_RESTORED — config offline valide conservée');
            legacyDebugLog(`HOME_STATE_UPDATED hasValidConfig=true proto="${(merged.protocol || protocolLabel).toLowerCase()}" display="${displayProtocol}"`);
            return;
          }
        }
      }

      // 4. Aucune config valide — état dégradé, internet requis
      legacyDebugLog('CONFIG_INCOMPLETE — provisionnement requis, internet nécessaire pour la première activation');
      setVpnConfig({
        protocol:        protocolLabel,
        displayProtocol: displayProtocol,
        configId:        conn.id,
        dataToken:       conn.dataToken,
      });
    };

    provisionFlow().catch(e => legacyDebugLog(`SYNC_ERROR — ${e?.message || 'erreur'}`));
  }, [addLog, deviceId]);

  const checkPermission = useCallback(async () => {
    if (!IS_ANDROID || !SxbVpnNative) { setHasVpnPermission(true); return true; }
    try {
      const granted: boolean = SxbVpnNative.isVpnPermissionGranted();
      setHasVpnPermission(granted);
      return granted;
    } catch { return false; }
  }, []);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!IS_ANDROID || !SxbVpnNative) { setHasVpnPermission(true); return true; }
    try {
      const granted: boolean = await SxbVpnNative.requestVpnPermission();
      setHasVpnPermission(granted);
      return granted;
    } catch (e) {
      addLog('⚠️ Erreur permission VPN');
      return false;
    }
  }, [addLog]);

  useEffect(() => {
    checkPermission();

    const restore = async () => {
      const [connected, protocol, ks, ar] = await Promise.all([
        AsyncStorage.getItem('@sxb_vpn_connected'),
        AsyncStorage.getItem('@sxb_vpn_protocol'),
        AsyncStorage.getItem('@sxb_kill_switch'),
        AsyncStorage.getItem('@sxb_auto_reconnect'),
      ]);
      if (protocol) setSelectedProtocol(protocol);
      if (ks !== null)  setKillSwitchState(ks === 'true');
      if (ar !== null)  setAutoReconnectState(ar !== 'false');

      if (IS_ANDROID && SxbVpnNative) {
        try {
          const state: string = await SxbVpnNative.getVpnState();
          const reallyConnected = state === 'connected';
          setVpnState(state);
          setIsConnected(reallyConnected);
          await AsyncStorage.setItem('@sxb_vpn_connected', reallyConnected ? 'true' : 'false');
        } catch { /* ignore */ }
      }

      try {
        const offlineEntry = await loadVpnConfig();
        if (offlineEntry?.config) {
          setVpnConfig(offlineEntry.config);
          if (offlineEntry.config.displayProtocol) {
            setConnectedProtocol(offlineEntry.config.displayProtocol);
          }
        }
      } catch { /* ignore */ }

      if (!IS_ANDROID || !SxbVpnNative) {
        const wasConnected = connected === 'true' && !!isAuthenticated;
        setIsConnected(wasConnected);
        setVpnState(wasConnected ? 'connected' : 'disconnected');
      }
    };
    restore();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  useEffect(() => {
    if (!vpnEmitter) return;

    const stateSub = vpnEmitter.addListener('onVpnStateChange', (e: { status: string }) => {
      const s = e.status;
      legacyDebugLog(`BROADCAST_STATUS_RECEIVED status=${s}`);
      setVpnState(s);
      const connected = s === 'connected';
      setIsConnected(connected);
      if (s === 'connecting') {
        setIsConnecting(true);
        lastStepRef.current = 'CONNECTING';
      } else {
        setIsConnecting(false);
        clearWatchdog();
      }
      AsyncStorage.setItem('@sxb_vpn_connected', connected ? 'true' : 'false').catch(() => {});
      if (connected) {
        clearWatchdog();
        addLog('✅ VPN_CONNECTED — tunnel actif');
        legacyDebugLog('VPN_CONNECTED');
        legacyDebugLog('VPN_CONNECTED');
        sessionStartRef.current = Date.now();
        refreshAccountState().catch(() => {});
      } else if (s === 'disconnected') {
        legacyDebugLog('VPN_FAILED status=disconnected');
        addLog('🔴 VPN déconnecté');
        stopTrafficPolling();
        reportUsageToBackend(0, 0);
      } else if (s === 'error') {
        legacyDebugLog('VPN_FAILED status=error');
        addLog('❌ Erreur VPN — connexion perdue');
        setIsConnecting(false);
      }
    });

    const logSub = vpnEmitter.addListener('onVpnLog', (e: { message: string }) => {
      addLog(e.message);
    });

    return () => { stateSub.remove(); logSub.remove(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addLog, refreshAccountState]);

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

  const reportUsageToBackend = useCallback(async (up: number, down: number) => {
    if (!isAuthenticated) return;
    try {
      await apiClient.post('/mobile/vpn/traffic', {
        bytesUp:   up,
        bytesDown: down,
      });
    } catch { /* ignore — report is best-effort */ }
  }, [isAuthenticated]);

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

  const refreshVpnConfig = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      legacyDebugLog('CONFIG_SYNC_START — appel /mobile/vpn/config');
      const res = await apiClient.get('/mobile/vpn/config');
      const data = res.data;

      // ── Quota : persister localement pour le mode hors-ligne ──────────────
      // Le backend renvoie quota { totalQuota, usedQuota, expiryDate } (bytes).
      // C'est ce qui permet aux gardes isQuotaExhausted()/isConfigExpired()
      // de fonctionner sans réseau après redémarrage de l'app.
      if (data.quota && Number(data.quota.totalQuota) > 0) {
        await saveQuotaData({
          configId:    data.vpnConfig?.configId ?? data.profile?.id ?? 'vpn_config',
          totalQuota:  Number(data.quota.totalQuota) || 0,
          usedQuota:   Number(data.quota.usedQuota)   || 0,
          expiryDate:  data.quota.expiryDate ?? null,
        }).catch(() => {});
      }

      // ── Synchronisation intelligente — modèle « intermédiaire » (§6.4) ─────
      // /mobile/vpn/config ne fournit QUE des métadonnées : aucun champ
      // technique (protocol, host, port, tls, sni, payload…) n'est jamais lu
      // ici pour le moteur. La technique provient exclusivement de la config
      // provisionnée (SecureStore). configHash différent → config périmée.
      if (data.vpnConfig) {
        const dp = data.vpnConfig.displayProtocol || data.profile?.displayProtocol || null;
        // Étiquette technique informative (UI uniquement — jamais injectée
        // dans la config moteur persistée).
        const metaProtocolLabel = (data.vpnConfig.protocol || '').toLowerCase() || null;

        // Charger l'ancienne config (seule source technique locale autorisée)
        const offlineEntry = await loadVpnConfig().catch(() => null);
        const oldConfig = offlineEntry?.config || null;

        // Fusion ALLOWLIST : métadonnées uniquement — technique intacte
        const merged = mergeConnectionMetadata(oldConfig, {
          displayProtocol: dp ?? data.vpnConfig.displayProtocol,
          configId:        data.vpnConfig.configId ?? data.profile?.id,
          subscriptionId:  data.subscription?.id,
          dataToken:       data.subscription?.dataToken,
          configVersion:   data.vpnConfig.configVersion,
          configHash:      data.vpnConfig.configHash,
        });

        if (oldConfig) {
          // La vérité technique du protocole vient de la config persistée,
          // JAMAIS de data.vpnConfig.protocol (métadonnée informative).
          const engineProto = ((merged.protocol as string) || 'vless').toLowerCase();

          // §6.4 — invalidation de cache : hash serveur ≠ hash local
          if (data.vpnConfig.configHash && (oldConfig as any).configHash &&
              data.vpnConfig.configHash !== (oldConfig as any).configHash) {
            legacyDebugLog('CONFIG_STALE_HASH — configuration serveur modifiée, re-provisionnement au prochain démarrage');
            await clearProvisionedConfig().catch(() => {});
          }

          // Valider la complétude avant de sauvegarder (métadonnées enrichies)
          const saved = await saveCompleteConfig(merged, engineProto, data.vpnConfig.configId);
          if (saved) {
            setVpnConfig(merged);
            legacyDebugLog(`CONFIG_SYNC_SUCCESS proto="${engineProto}" display="${dp ?? '—'}" (métadonnées seules)`);
            legacyDebugLog(`CONFIG_SYNC_SUCCESS proto=${engineProto}`);
          } else if (isCompleteOfflineConfig(oldConfig).complete) {
            legacyDebugLog('CONFIG_SYNC_PARTIAL — ancienne config complète conservée');
          } else {
            legacyDebugLog('CONFIG_SYNC_INCOMPLETE — métadonnées seules non persistées (provisionnement requis)');
          }
        } else {
          legacyDebugLog('CONFIG_SYNC_META — aucune config provisionnée : métadonnées reçues, moteur intact');
        }

        if (dp) {
          setConnectedProtocol(dp);
          await AsyncStorage.setItem('@sxb_connected_protocol', dp).catch(() => {});
        }

        setSelectedProtocol(prev => {
          if (!prev && metaProtocolLabel) {
            AsyncStorage.setItem('@sxb_vpn_protocol', metaProtocolLabel).catch(() => {});
            return metaProtocolLabel;
          }
          return prev;
        });
      }

      if (Array.isArray(data.protocols) && data.protocols.length > 0) {
        setAvailableProtocols(data.protocols);
        const saved = await AsyncStorage.getItem('@sxb_vpn_protocol');
        if (!saved && data.protocols[0]) {
          setSelectedProtocol(data.protocols[0].name);
          await AsyncStorage.setItem('@sxb_vpn_protocol', data.protocols[0].name);
        }
      } else {
        setAvailableProtocols(FALLBACK_PROTOCOLS);
      }
    } catch {
      legacyDebugLog('CONFIG_SYNC_FAILED — backend inaccessible, mode hors-ligne');
      setAvailableProtocols(FALLBACK_PROTOCOLS);
    }
  }, [isAuthenticated, addLog]);

  useEffect(() => { refreshVpnConfig(); }, [refreshVpnConfig]);

  const connect = useCallback(async () => {
    if (isConnecting || isConnected) return;
    setIsConnecting(true);
    legacyDebugLog('CONNECT_START');
    legacyDebugLog('CONNECT_START — bouton "Se connecter" appuyé');
    addLog('🔄 Initialisation du tunnel VPN...');

    try {
      if (IS_ANDROID && SxbVpnNative) {
        const hasPerm = SxbVpnNative.isVpnPermissionGranted();
        if (!hasPerm) {
          addLog('🔐 Demande de permission VPN...');
          const granted = await SxbVpnNative.requestVpnPermission();
          if (!granted) {
            addLog('❌ Permission VPN refusée');
            setIsConnecting(false);
            return;
          }
          addLog('✅ Permission VPN accordée');
        }

        addLog('🔐 Chargement configuration sécurisée...');
        let configToUse: any = null;

        // ── Source de vérité unique : offlineStorage (SecureStore) ────────────
        // La config Offline est la seule source de vérité locale. Elle contient
        // tout ce qui est nécessaire au moteur VPN (host, port, credentials,
        // payload, paramètres de protocole). Le moteur ne dépend plus d'un
        // nouvel appel API pour démarrer.
        legacyDebugLog('CONFIG_LOAD_START — lecture SecureStore');
        const offlineEntry = await loadVpnConfig().catch(() => null);

        if (offlineEntry?.config) {
          // FIX — Ne JAMAIS utiliser une config stockée incomplète :
          // une écriture partielle héritée d'une ancienne version (avant le
          // gardien saveCompleteConfig) bloquait définitivement la connexion
          // (CONFIG_INCOMPLETE_BLOCK) sans jamais re-tenter le provisionnement.
          // Règle : complète → utilisable hors-ligne ; incomplète → re-provision.
          const storedCheck = isCompleteOfflineConfig(offlineEntry.config);
          if (storedCheck.complete) {
            configToUse = { ...offlineEntry.config };
            // Enrichir avec les métadonnées de connexion courante
            if (vpnConfig?.displayProtocol) configToUse.displayProtocol = vpnConfig.displayProtocol;
            if (vpnConfig?.configId)        configToUse.configId        = vpnConfig.configId;
            legacyDebugLog(`CONFIG_LOADED proto=${offlineEntry.protocol} savedAt=${offlineEntry.savedAt}`);
            addLog('✅ Configuration sécurisée chargée');
          } else {
            legacyDebugLog(`CONFIG_STORED_INCOMPLETE missing=[${storedCheck.missing.join(',')}] — re-provisionnement requis`);
          }
        }

        // ── Si pas de config Offline complète, tenter le provisionnement ─────
        if (!configToUse) {
          // Chercher le dataToken dans toutes les sources disponibles
          const dataToken =
            ((vpnConfig as any)?.dataToken as string | undefined) ??
            ((offlineEntry?.config as any)?.dataToken as string | undefined) ??
            ((activeConnection as any)?.dataToken as string | undefined);
          legacyDebugLog(`PROVISION_CHECK dataToken=${dataToken ? 'OK' : 'MISSING'} deviceId=${deviceId ? 'OK' : 'MISSING'}`);
          if (dataToken && deviceId) {
            legacyDebugLog('PROVISION_REQUIRED — appel /provision/activate');
            addLog('🔒 Provisionnement sécurisé en cours...');
            try {
              const freshResult = await provisionAndStore(dataToken, deviceId);
              const freshConfig = freshResult.config;
              // §6.1 : provisionné = SEULE source technique ; §6.4 : la
              // connexion n'apporte que des métadonnées (allowlist).
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
              // Sauvegarder uniquement si complet
              await saveCompleteConfig(configToUse, (configToUse.protocol || 'vless').toLowerCase(), vpnConfig?.configId ?? activeConnection?.id, freshResult.meta.configExpiresAt);
              // Synchroniser le quota local (validation offline expiration/quota)
              if (freshResult.meta.quotaGB > 0) {
                await saveQuotaData({
                  configId:    freshResult.meta.subscriptionId || 'provision',
                  totalQuota:  Math.round(freshResult.meta.quotaGB * 1024 ** 3),
                  usedQuota:   Math.round(freshResult.meta.quotaUsedGB * 1024 ** 3),
                  expiryDate:  freshResult.meta.expireAt,
                }).catch(() => {});
              }
              legacyDebugLog('PROVISION_OK — config complète stockée dans SecureStore');
              addLog('✅ Configuration provisionnée avec succès');
            } catch (provErr: any) {
              const httpStatus = provErr?.response?.status ?? 'no-response';
              const httpMsg    = provErr?.response?.data?.error ?? provErr?.response?.data?.message ?? '';
              legacyDebugLog(`PROVISION_FAILED http=${httpStatus} msg="${httpMsg || provErr?.message || 'inconnu'}"`);
              addLog(`⚠️ Provisionnement échoué : ${httpMsg || provErr?.message || 'erreur réseau'}`);
              if (offlineEntry?.config) {
                // Gardien ultime : signaler précisément ce qui manque au lieu
                // d'un échec opaque. La config incomplète n'est PAS utilisée.
                const missing = isCompleteOfflineConfig(offlineEntry.config).missing;
                legacyDebugLog(`CONFIG_INCOMPLETE_BLOCK missing=${missing.join(',')}`);
                addLog(`❌ Configuration incomplète (manque : ${missing.join(', ')}) — internet requis pour la réparer`);
              } else {
                addLog('❌ Internet requis pour le premier provisionnement');
              }
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

        // ── Validation de complétude avec le gardien unifié ───────────────────
        const completeness = isCompleteOfflineConfig(configToUse);
        legacyDebugLog(`CONFIG_READY hasHost=${completeness.hasHost} hasCreds=${completeness.hasCreds} missing=[${completeness.missing.join(',')}]`);

        if (!completeness.complete) {
          addLog(`❌ Configuration incomplète — champs manquants : ${completeness.missing.join(', ')}`);
          legacyDebugLog(`CONFIG_INCOMPLETE_BLOCK missing=${completeness.missing.join(',')}`);
          addLog('ℹ️  Re-provisionnement requis — vérifiez votre connexion internet');
          setVpnState('error');
          setIsConnecting(false);
          return;
        }

        const exhausted = await isQuotaExhausted();
        if (exhausted) {
          addLog('❌ Quota data épuisé — rechargez votre abonnement');
          setIsConnecting(false);
          return;
        }
        const expired = await isConfigExpired();
        if (expired) {
          addLog('❌ Abonnement expiré — renouvelez votre abonnement');
          setIsConnecting(false);
          return;
        }

        const engineProtocol = (configToUse.protocol || selectedProtocol || 'vless').toLowerCase();

        const displayProto = configToUse.displayProtocol
          || (activeConnection?.displayProtocol ?? null)
          || null;
        if (displayProto) {
          setConnectedProtocol(displayProto);
          await AsyncStorage.setItem('@sxb_connected_protocol', displayProto).catch(() => {});
        }

        // §6.4 — Frontière native : AUCUN champ null/undefined ne doit
        // atteindre Android (AOSP JSONObject.optString lit NULL comme la
        // chaîne "null" — cause du payload_len=4 de l'incident APK #165).
        const optionsJson = JSON.stringify(sanitizeEngineConfig({
          ...configToUse,
          protocol:      engineProtocol,
          killSwitch,
          autoReconnect,
        }));

        legacyDebugLog(`CONFIG_SENT_NATIVE proto=${engineProtocol}`);
        legacyDebugLog(`CONFIG_SENT_NATIVE proto=${engineProtocol}`);
        addLog(`🚀 Démarrage tunnel ${engineProtocol.toUpperCase()}...`);

        legacyDebugLog('SERVICE_STARTED — appel startVpn()');
        legacyDebugLog('SERVICE_STARTED — startVpn() envoyé au module natif');

        lastStepRef.current = `STEP_3_NATIVE_CALLED proto=${engineProtocol}`;
        startWatchdog(`STEP_3_NATIVE_CALLED proto=${engineProtocol}`);

        const startResult = await SxbVpnNative.startVpn(optionsJson);
        legacyDebugLog(`SERVICE_STARTED result=${JSON.stringify(startResult)}`);
        legacyDebugLog(`SERVICE_STARTED serviceStarted=${startResult?.serviceStarted}`);
        addLog('⏳ Connexion en cours... (watchdog 45s actif)');

      } else if (IS_ANDROID) {
        addLog('❌ Module natif VPN non chargé');
        addLog('ℹ️  Réinstallez l\'APK ou signalez ce bug');
        setVpnState('error');
        setIsConnecting(false);
        return;
      } else {
        addLog('⚠️ Mode développement — VPN simulé (non-Android)');
        await apiClient.post('/mobile/vpn/session', {
          action: 'connect',
          protocol: selectedProtocol || 'VLESS',
        });
        await new Promise(r => setTimeout(r, 1200));
        setIsConnected(true);
        setVpnState('connected');
        await AsyncStorage.setItem('@sxb_vpn_connected', 'true');
        legacyDebugLog('VPN_CONNECTED mode=dev-simulation');
        addLog('✅ Connecté (mode web dev)');
        setIsConnecting(false);
      }

      try {
        await apiClient.post('/mobile/vpn/session', {
          action:   'connect',
          protocol: selectedProtocol || 'VLESS',
        });
      } catch { /* non-bloquant */ }

    } catch (err: any) {
      legacyDebugLog(`VPN_FAILED error=${err?.message || 'connexion_échouée'}`);
      addLog(`❌ Erreur : ${err?.message || 'Connexion échouée'}`);
      setVpnState('error');
      setIsConnecting(false);
    }
  }, [isConnecting, isConnected, selectedProtocol, vpnConfig, activeConnection, killSwitch, autoReconnect, deviceId, addLog, startWatchdog]);

  const disconnect = useCallback(async () => {
    if (isConnecting && !isConnected) return;
    setIsConnecting(true);
    addLog('🔴 Déconnexion...');

    try {
      if (IS_ANDROID && SxbVpnNative) {
        await SxbVpnNative.stopVpn();
      } else {
        await apiClient.post('/mobile/vpn/session', { action: 'disconnect' });
        await new Promise(r => setTimeout(r, 600));
        setIsConnected(false);
        setVpnState('disconnected');
        await AsyncStorage.setItem('@sxb_vpn_connected', 'false');
        setIsConnecting(false);
      }

      if (IS_ANDROID && SxbVpnNative) {
        try {
          const stats = await SxbVpnNative.getTrafficStats();
          await reportUsageToBackend(stats.uploadBytes || 0, stats.downloadBytes || 0);
        } catch { /* ignore */ }
      }
    } catch (err: any) {
      addLog(`⚠️ Erreur déconnexion : ${err?.message || ''}`);
      setIsConnected(false);
      setVpnState('disconnected');
      await AsyncStorage.setItem('@sxb_vpn_connected', 'false');
    } finally {
      if (!IS_ANDROID || !SxbVpnNative) setIsConnecting(false);
    }
  }, [isConnecting, isConnected, addLog, reportUsageToBackend]);

  useEffect(() => {
    AsyncStorage.getItem('@sxb_connected_protocol').then(p => {
      if (p) setConnectedProtocol(p);
    });
  }, []);

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
      logs:          vpnLogs,
      traffic:       trafficStats,
      killSwitch,
      autoReconnect,
      setKillSwitch,
      setAutoReconnect,
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

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

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

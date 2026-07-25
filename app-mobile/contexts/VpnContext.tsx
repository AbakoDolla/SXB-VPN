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
import {
  NativeModules, NativeEventEmitter, Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient from '@/services/apiClient';
import { saveVpnConfig, loadVpnConfig, isQuotaExhausted, isConfigExpired, syncQuotaFromBackend } from '@/services/offlineStorage';
import { useAuthContext } from './AuthContext';
import type { VpnConnection } from '@/types/api';

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
  const { isAuthenticated, refreshAccountState } = useAuthContext();

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
      console.warn(`[SXB_DEBUG] WATCHDOG_FIRED lastStep=${step}`);

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
  const syncFromConnection = useCallback((conn: VpnConnection) => {
    console.log(`[SXB_DEBUG] ACTIVE_CONNECTION_FOUND id=${conn.id} proto=${conn.technicalProtocol} display=${conn.displayProtocol}`);
    addLog(`[SXB_DEBUG] ACTIVE_CONNECTION_FOUND id=${conn.id}`);
    addLog(`[SXB_DEBUG] CONFIG_SYNC_SUCCESS proto=${conn.technicalProtocol} display="${conn.displayProtocol}"`);

    const engineProtocol = conn.technicalProtocol.toLowerCase();
    const displayProtocol = conn.displayProtocol;

    // Les champs techniques (host, port, credentials) seront complétés par
    // /mobile/vpn/config au moment du connect() — on ne stocke pas server/port ici
    const synthesizedConfig: Record<string, any> = {
      protocol:        engineProtocol,
      displayProtocol: displayProtocol,
      configId:        conn.id,
      dataToken:       conn.dataToken,
    };

    setVpnConfig(synthesizedConfig);
    setActiveConnection(conn);

    setSelectedProtocol(prev => {
      if (!prev) {
        AsyncStorage.setItem('@sxb_vpn_protocol', engineProtocol).catch(() => {});
        return engineProtocol;
      }
      return prev;
    });

    setConnectedProtocol(displayProtocol);
    AsyncStorage.setItem('@sxb_connected_protocol', displayProtocol).catch(() => {});

    saveVpnConfig(synthesizedConfig, engineProtocol, conn.id).catch(() => {});

    addLog(`[SXB_DEBUG] HOME_STATE_UPDATED hasValidConfig=true proto="${engineProtocol}" display="${displayProtocol}"`);
    console.log(`[SXB_DEBUG] HOME_STATE_UPDATED hasValidConfig=true proto=${engineProtocol} display=${displayProtocol}`);
  }, [addLog]);

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
      console.log(`[SXB_DEBUG] BROADCAST_STATUS_RECEIVED status=${s}`);
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
        addLog('[SXB_DEBUG] VPN_CONNECTED');
        console.log('[SXB_DEBUG] VPN_CONNECTED');
        sessionStartRef.current = Date.now();
        refreshAccountState().catch(() => {});
      } else if (s === 'disconnected') {
        addLog('[SXB_DEBUG] VPN_FAILED status=disconnected');
        addLog('🔴 VPN déconnecté');
        stopTrafficPolling();
        reportUsageToBackend(0, 0);
      } else if (s === 'error') {
        addLog('[SXB_DEBUG] VPN_FAILED status=error');
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
      addLog('[SXB_DEBUG] CONFIG_SYNC_START — appel /mobile/vpn/config');
      const res = await apiClient.get('/mobile/vpn/config');
      const data = res.data;
      if (data.vpnConfig) {
        setVpnConfig(data.vpnConfig);

        const dp = data.vpnConfig.displayProtocol || data.profile?.displayProtocol || null;
        if (dp) {
          setConnectedProtocol(dp);
          await AsyncStorage.setItem('@sxb_connected_protocol', dp).catch(() => {});
        }

        const engineProto = (data.vpnConfig.protocol || 'vless').toLowerCase();
        setSelectedProtocol(prev => {
          if (!prev) {
            AsyncStorage.setItem('@sxb_vpn_protocol', engineProto).catch(() => {});
            return engineProto;
          }
          return prev;
        });

        try {
          await saveVpnConfig(data.vpnConfig, engineProto, data.vpnConfig.configId);
        } catch { /* ignore */ }

        addLog(`[SXB_DEBUG] CONFIG_SYNC_SUCCESS proto="${engineProto}" display="${dp ?? '—'}"`);
        console.log(`[SXB_DEBUG] CONFIG_SYNC_SUCCESS proto=${engineProto}`);
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
      addLog('[SXB_DEBUG] CONFIG_SYNC_FAILED — backend inaccessible, mode hors-ligne');
      setAvailableProtocols(FALLBACK_PROTOCOLS);
    }
  }, [isAuthenticated, addLog]);

  useEffect(() => { refreshVpnConfig(); }, [refreshVpnConfig]);

  const connect = useCallback(async () => {
    if (isConnecting || isConnected) return;
    setIsConnecting(true);
    console.log('[SXB_DEBUG] CONNECT_START');
    addLog('[SXB_DEBUG] CONNECT_START — bouton "Se connecter" appuyé');
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

        addLog('🌐 Récupération de la configuration...');
        let configToUse = vpnConfig;

        // ── Stratégie multi-niveaux pour obtenir les credentials complets ──────
        //   1. GET /mobile/vpn/config/<dataToken> — endpoint config par token
        //   2. GET /mobile/connections/<configId>/config — endpoint par connexion
        //   3. GET /mobile/vpn/config — endpoint générique (fallback)
        const needsCredentials = !configToUse?.password && !configToUse?.username;
        if (!configToUse || needsCredentials) {
          const token   = configToUse?.dataToken  as string | undefined;
          const connId  = configToUse?.configId   as string | undefined;
          let fetched   = false;

          // Stratégie 1 — GET /mobile/vpn/config/<dataToken> ──────────────────
          if (token && !fetched) {
            try {
              addLog(`[SXB_DEBUG] CRED_FETCH strategy=token_endpoint token=...${token.slice(-6)}`);
              const res = await apiClient.get(`/mobile/vpn/config/${token}`);
              const data = res.data?.vpnConfig ?? res.data?.config ?? res.data;
              if (data && typeof data === 'object' && (data.host || data.username || data.password)) {
                configToUse = { ...configToUse, ...data };
                fetched     = true;
                addLog('[SXB_DEBUG] CRED_FETCH_OK strategy=token_endpoint');
              }
            } catch { /* endpoint inexistant */ }
          }

          // Stratégie 2 — GET /mobile/connections/<id>/config ─────────────────
          if (connId && !fetched) {
            try {
              addLog(`[SXB_DEBUG] CRED_FETCH strategy=connection_config id=${connId}`);
              const res = await apiClient.get(`/mobile/connections/${connId}/config`);
              const data = res.data?.vpnConfig ?? res.data?.config ?? res.data;
              if (data && typeof data === 'object' && (data.host || data.username || data.password)) {
                configToUse = { ...configToUse, ...data };
                fetched     = true;
                addLog('[SXB_DEBUG] CRED_FETCH_OK strategy=connection_config');
              }
            } catch { /* endpoint inexistant */ }
          }

          // Stratégie 3 — /mobile/vpn/config générique (fallback) ─────────────
          if (!fetched) {
            try {
              addLog('[SXB_DEBUG] CRED_FETCH strategy=generic_config');
              const res = await apiClient.get('/mobile/vpn/config');
              if (res.data?.vpnConfig) {
                configToUse = { ...configToUse, ...res.data.vpnConfig };
                setVpnConfig(configToUse);
                fetched = true;
                try {
                  const proto = (configToUse.protocol || 'vless').toLowerCase();
                  await saveVpnConfig(configToUse, proto, configToUse.configId);
                  await syncQuotaFromBackend(async () => ({
                    configId:   configToUse.configId   ?? 'default',
                    totalQuota: res.data.quota?.totalQuota ?? 0,
                    usedQuota:  res.data.quota?.usedQuota  ?? 0,
                    expiryDate: res.data.quota?.expiryDate ?? null,
                  }));
                } catch { /* quota non critique */ }
                addLog('[SXB_DEBUG] CRED_FETCH_OK strategy=generic_config');
              }
            } catch {
              addLog('⚠️ Backend inaccessible — chargement config hors-ligne...');
            }
          }

          // Log final — masqué pour ne pas exposer les champs techniques
          const hasUser = !!(configToUse as any)?.username;
          const hasPass = !!(configToUse as any)?.password;
          const hasPayload = !!(configToUse as any)?.payload;
          addLog(`[SXB_DEBUG] CRED_STATUS hasUser=${hasUser} hasPass=${hasPass} hasPayload=${hasPayload}`);
        }

        // Fallback : charger depuis offlineStorage (mode avion)
        if (!configToUse) {
          try {
            const offlineEntry = await loadVpnConfig();
            if (offlineEntry?.config) {
              configToUse = offlineEntry.config;
              addLog('✅ Config restaurée depuis stockage local');
            }
          } catch { /* ignore */ }
        }

        if (!configToUse) {
          addLog('❌ Aucune configuration VPN disponible — activez un forfait');
          setIsConnecting(false);
          return;
        }

        const cfgProto = ((configToUse as any)?.protocol || selectedProtocol || '').toLowerCase();
        const isSshBased = cfgProto === 'ssh' || cfgProto === 'ssh+payload';
        const hasCriticalFields = !!(configToUse as any)?.host;
        const hasCredentials = !!(configToUse as any)?.username || !!(configToUse as any)?.password
          || !!(configToUse as any)?.uuid || !!(configToUse as any)?.dataToken;

        if (!hasCriticalFields) {
          addLog('❌ Config incomplète : champ "host" manquant — synchronisez votre abonnement');
          addLog('[SXB_DEBUG] CONFIG_INCOMPLETE_BLOCK host=missing proto=' + cfgProto);
          setVpnState('error');
          setIsConnecting(false);
          return;
        }

        if (isSshBased && !hasCredentials) {
          addLog('❌ Config SSH incomplète : credentials manquants (username/password)');
          addLog('[SXB_DEBUG] CONFIG_INCOMPLETE_BLOCK proto=' + cfgProto + ' credentials=missing');
          addLog('ℹ️  Essayez de vous déconnecter puis reconnecter — rechargement de la config...');
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

        const optionsJson = JSON.stringify({
          ...configToUse,
          protocol:      engineProtocol,
          killSwitch,
          autoReconnect,
        });

        console.log(`[SXB_DEBUG] CONFIG_SENT_NATIVE proto=${engineProtocol}`);
        addLog(`[SXB_DEBUG] CONFIG_SENT_NATIVE proto=${engineProtocol}`);
        addLog(`🚀 Démarrage tunnel ${engineProtocol.toUpperCase()}...`);

        console.log('[SXB_DEBUG] SERVICE_STARTED — appel startVpn()');
        addLog('[SXB_DEBUG] SERVICE_STARTED — startVpn() envoyé au module natif');

        lastStepRef.current = `STEP_3_NATIVE_CALLED proto=${engineProtocol}`;
        startWatchdog(`STEP_3_NATIVE_CALLED proto=${engineProtocol}`);

        const startResult = await SxbVpnNative.startVpn(optionsJson);
        console.log(`[SXB_DEBUG] SERVICE_STARTED result=${JSON.stringify(startResult)}`);
        addLog(`[SXB_DEBUG] SERVICE_STARTED serviceStarted=${startResult?.serviceStarted}`);
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
        addLog('[SXB_DEBUG] VPN_CONNECTED mode=dev-simulation');
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
      addLog(`[SXB_DEBUG] VPN_FAILED error=${err?.message || 'connexion_échouée'}`);
      addLog(`❌ Erreur : ${err?.message || 'Connexion échouée'}`);
      setVpnState('error');
      setIsConnecting(false);
    }
  }, [isConnecting, isConnected, selectedProtocol, vpnConfig, activeConnection, killSwitch, autoReconnect, addLog, startWatchdog]);

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

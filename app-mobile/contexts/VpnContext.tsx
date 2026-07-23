/**
 * VpnContext — Moteur VPN réel SXB v5
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
import { saveVpnConfig, loadVpnConfig, isQuotaExhausted, isConfigExpired, consumeLocalQuota, syncQuotaFromBackend } from '@/services/offlineStorage';
import { useAuthContext } from './AuthContext';

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
  vpnState:           string;        // 'disconnected' | 'connecting' | 'connected' | 'error'
  selectedProtocol:   string | null;
  availableProtocols: VpnProtocol[];
  subscriptionUrl:    string | null;
  serverInfo:         { host: string; location: string } | null;
  trafficStats:       TrafficStats;
  vpnLogs:            string[];
  hasVpnPermission:   boolean;
  hasValidConfig:     boolean;       // true si une config (backend OU locale hors-ligne) est disponible
  // Alias pratiques (mêmes valeurs que trafficStats/vpnLogs, noms attendus par settings.tsx)
  logs:                string[];
  traffic:             TrafficStats;
  killSwitch:          boolean;
  autoReconnect:       boolean;
  setKillSwitch:       (v: boolean) => void;
  setAutoReconnect:    (v: boolean) => void;
  manuallySetConfig:   (config: any) => Promise<void>;
  connect:            () => Promise<void>;
  disconnect:         () => Promise<void>;
  selectProtocol:     (name: string) => void;
  refreshVpnConfig:   () => Promise<void>;
  requestPermission:  () => Promise<boolean>;
}

const DEFAULT_STATS: TrafficStats = { uploadBytes: 0, downloadBytes: 0, uploadSpeed: 0, downloadSpeed: 0 };

const VpnContext = createContext<VpnContextType>({
  isConnected: false, isConnecting: false, vpnState: 'disconnected',
  selectedProtocol: null, availableProtocols: [], subscriptionUrl: null,
  serverInfo: null, trafficStats: DEFAULT_STATS, vpnLogs: [],
  hasVpnPermission: false, hasValidConfig: false,
  logs: [], traffic: DEFAULT_STATS,
  killSwitch: false, autoReconnect: true,
  setKillSwitch: () => {}, setAutoReconnect: () => {},
  manuallySetConfig: async () => {},
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
  const [availableProtocols, setAvailableProtocols]  = useState<VpnProtocol[]>([]);
  const [subscriptionUrl,    setSubscriptionUrl]     = useState<string | null>(null);
  const [serverInfo,         setServerInfo]          = useState<{ host: string; location: string } | null>(null);
  const [trafficStats,       setTrafficStats]        = useState<TrafficStats>(DEFAULT_STATS);
  const [vpnLogs,            setVpnLogs]             = useState<string[]>([]);
  const [hasVpnPermission,   setHasVpnPermission]    = useState(false);
  const [vpnConfig,          setVpnConfig]           = useState<any>(null);
  const [killSwitch,         setKillSwitchState]      = useState<boolean>(false);
  const [autoReconnect,      setAutoReconnectState]   = useState<boolean>(true);

  const trafficTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const reportTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionStartRef  = useRef<number>(0);

  // ── Ajout d'un log ─────────────────────────────────────────────────────────

  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setVpnLogs(prev => [`[${ts}] ${msg}`, ...prev].slice(0, 200));
  }, []);

  // ── Kill Switch & Auto Reconnect ──────────────────────────────────────────

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

  // ── Import manuel d'une configuration ─────────────────────────────────────

  const manuallySetConfig = useCallback(async (config: any) => {
    if (!config || typeof config !== 'object') {
      throw new Error('Configuration invalide');
    }
    const proto = (config.protocol || 'vless').toLowerCase();
    setVpnConfig(config);
    await saveVpnConfig(config, proto, config.configId || `manual_${Date.now()}`);
    addLog(`✅ Configuration ${proto.toUpperCase()} importée et sauvegardée localement`);
  }, [addLog]);

  // ── Vérification / demande permission VPN ─────────────────────────────────

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

  // ── Initialisation : vérif permission + restauration état ─────────────────

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
      // Restaurer kill switch & auto reconnect
      if (ks !== null)  setKillSwitchState(ks === 'true');
      if (ar !== null)  setAutoReconnectState(ar !== 'false'); // default true

      // Sur Android, vérifier l'état réel du service VPN
      // IMPORTANT : ne pas retourner ici — continuer pour charger la config hors-ligne
      if (IS_ANDROID && SxbVpnNative) {
        try {
          const state: string = await SxbVpnNative.getVpnState();
          const reallyConnected = state === 'connected';
          setVpnState(state);
          setIsConnected(reallyConnected);
          await AsyncStorage.setItem('@sxb_vpn_connected', reallyConnected ? 'true' : 'false');
          // Pas de return ici — on continue pour restaurer la config locale
        } catch { /* ignore */ }
      }

      // Restaurer vpnConfig depuis stockage local (mode hors-ligne)
      // S'exécute sur TOUTES les plateformes, y compris Android
      try {
        const offlineEntry = await loadVpnConfig();
        if (offlineEntry?.config) {
          setVpnConfig(offlineEntry.config);
        }
      } catch { /* ignore */ }

      // Fallback : utiliser la valeur persistée si Android non disponible
      if (!IS_ANDROID || !SxbVpnNative) {
        const wasConnected = connected === 'true' && !!isAuthenticated;
        setIsConnected(wasConnected);
        setVpnState(wasConnected ? 'connected' : 'disconnected');
      }
    };
    restore();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  // ── Listeners événements natifs (Android) ─────────────────────────────────

  useEffect(() => {
    if (!vpnEmitter) return;

    const stateSub = vpnEmitter.addListener('onVpnStateChange', (e: { status: string }) => {
      const s = e.status;
      setVpnState(s);
      const connected = s === 'connected';
      setIsConnected(connected);
      if (s === 'connecting') setIsConnecting(true);
      else setIsConnecting(false);
      AsyncStorage.setItem('@sxb_vpn_connected', connected ? 'true' : 'false').catch(() => {});
      if (connected) {
        addLog('✅ VPN connecté — tunnel actif');
        sessionStartRef.current = Date.now();
        refreshAccountState().catch(() => {});
      } else if (s === 'disconnected') {
        addLog('🔴 VPN déconnecté');
        stopTrafficPolling();
        reportUsageToBackend(0, 0);
      } else if (s === 'error') {
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

  // ── Polling TrafficStats Android ──────────────────────────────────────────

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

  // Démarrer le polling dès la connexion établie
  useEffect(() => {
    if (isConnected) startTrafficPolling();
    else stopTrafficPolling();
    return stopTrafficPolling;
  }, [isConnected, startTrafficPolling, stopTrafficPolling]);

  // ── Rapport usage backend toutes les 60s ──────────────────────────────────

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

  // ── Fetch config VPN depuis le backend ────────────────────────────────────

  const refreshVpnConfig = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const res = await apiClient.get('/mobile/vpn/config');
      const data = res.data;
      if (data.subscriptionUrl) setSubscriptionUrl(data.subscriptionUrl);
      if (data.serverInfo)      setServerInfo(data.serverInfo);
      if (data.vpnConfig) {
        setVpnConfig(data.vpnConfig);
        // Persister localement pour mode hors-ligne
        try {
          const proto = (data.vpnConfig.protocol || 'vless').toLowerCase();
          await saveVpnConfig(data.vpnConfig, proto, data.vpnConfig.configId);
        } catch { /* ignore */ }
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
      setAvailableProtocols(FALLBACK_PROTOCOLS);
    }
  }, [isAuthenticated]);

  useEffect(() => { refreshVpnConfig(); }, [refreshVpnConfig]);

  // ── Connect ───────────────────────────────────────────────────────────────

  const connect = useCallback(async () => {
    if (isConnecting || isConnected) return;
    setIsConnecting(true);
    addLog('🔄 Initialisation du tunnel VPN...');

    try {
      // 1. Vérifier / demander la permission VPN
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

        // 2. Récupérer la configuration depuis le backend
        addLog('🌐 Récupération de la configuration...');
        let configToUse = vpnConfig;

        if (!configToUse) {
          try {
            const res = await apiClient.get('/mobile/vpn/config');
            configToUse = res.data?.vpnConfig;
            if (res.data?.vpnConfig) {
              setVpnConfig(res.data.vpnConfig);
              // Persister + synchroniser quota depuis backend
              try {
                const proto = (res.data.vpnConfig.protocol || 'vless').toLowerCase();
                await saveVpnConfig(res.data.vpnConfig, proto, res.data.vpnConfig.configId);
                await syncQuotaFromBackend(async () => ({
                  configId:   res.data.vpnConfig.configId ?? 'default',
                  totalQuota: res.data.quota?.totalQuota  ?? 0,
                  usedQuota:  res.data.quota?.usedQuota   ?? 0,
                  expiryDate: res.data.quota?.expiryDate  ?? null,
                }));
              } catch { /* quota non critique */ }
            }
          } catch {
            addLog('⚠️ Backend inaccessible — chargement config hors-ligne...');
          }
        }

        // Fallback 2 : charger depuis offlineStorage (mode avion)
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
          addLog('❌ Aucune configuration VPN disponible — importez un profil');
          setIsConnecting(false);
          return;
        }

        // Vérifier quota local avant connexion
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

        // 3. Construire les options pour le module natif
        const protocol = (configToUse.protocol || selectedProtocol || 'VLESS').toLowerCase();
        const optionsJson = JSON.stringify({
          ...configToUse,
          protocol,
          killSwitch,
          autoReconnect,
        });

        addLog(`🚀 Démarrage tunnel ${protocol.toUpperCase()}...`);

        // 4. Démarrer le service VPN Android
        await SxbVpnNative.startVpn(optionsJson);
        // L'état réel sera mis à jour via onVpnStateChange event
        addLog('⏳ Connexion en cours...');

      } else if (IS_ANDROID) {
        // Android MAIS module natif absent (SxbVpnNative === undefined)
        // Cela indique un problème de build — le package n'a pas été enregistré.
        addLog('❌ Module natif VPN non chargé');
        addLog('ℹ️  Réinstallez l\'APK ou signalez ce bug');
        setVpnState('error');
        setIsConnecting(false);
        return;
      } else {
        // Hors Android (web/iOS dev uniquement) — simuler pour le dev
        addLog('⚠️ Mode développement — VPN simulé (non-Android)');
        await apiClient.post('/mobile/vpn/session', {
          action: 'connect',
          protocol: selectedProtocol || 'VLESS',
        });
        await new Promise(r => setTimeout(r, 1200));
        setIsConnected(true);
        setVpnState('connected');
        await AsyncStorage.setItem('@sxb_vpn_connected', 'true');
        addLog('✅ Connecté (mode web dev)');
        setIsConnecting(false);
      }

      // Notifier le backend de la session
      try {
        await apiClient.post('/mobile/vpn/session', {
          action: 'connect',
          protocol: selectedProtocol || 'VLESS',
        });
      } catch { /* non-bloquant */ }

    } catch (err: any) {
      addLog(`❌ Erreur : ${err?.message || 'Connexion échouée'}`);
      setVpnState('error');
      setIsConnecting(false);
    }
  }, [isConnecting, isConnected, selectedProtocol, vpnConfig, killSwitch, autoReconnect, addLog]);

  // ── Disconnect ────────────────────────────────────────────────────────────

  const disconnect = useCallback(async () => {
    if (isConnecting && !isConnected) return;
    setIsConnecting(true);
    addLog('🔴 Déconnexion...');

    try {
      if (IS_ANDROID && SxbVpnNative) {
        await SxbVpnNative.stopVpn();
        // État mis à jour via onVpnStateChange
      } else {
        await apiClient.post('/mobile/vpn/session', { action: 'disconnect' });
        await new Promise(r => setTimeout(r, 600));
        setIsConnected(false);
        setVpnState('disconnected');
        await AsyncStorage.setItem('@sxb_vpn_connected', 'false');
        setIsConnecting(false);
      }

      // Rapport final d'usage
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

  // ── Sélection protocole ───────────────────────────────────────────────────

  const selectProtocol = useCallback(async (name: string) => {
    setSelectedProtocol(name);
    await AsyncStorage.setItem('@sxb_vpn_protocol', name);
    if (isConnected) {
      addLog(`🔄 Changement protocole → ${name}...`);
      await disconnect();
      setTimeout(() => connect(), 800);
    }
  }, [isConnected, connect, disconnect, addLog]);

  // hasValidConfig : true si config disponible en mémoire OU en stockage local
  const hasValidConfig = vpnConfig !== null;

  return (
    <VpnContext.Provider value={{
      isConnected, isConnecting, vpnState,
      selectedProtocol, availableProtocols,
      subscriptionUrl, serverInfo,
      trafficStats, vpnLogs,
      hasVpnPermission,
      hasValidConfig,
      // Alias pour compatibilité avec settings.tsx et autres composants
      logs:          vpnLogs,
      traffic:       trafficStats,
      killSwitch,
      autoReconnect,
      setKillSwitch,
      setAutoReconnect,
      manuallySetConfig,
      connect, disconnect, selectProtocol,
      refreshVpnConfig, requestPermission,
    }}>
      {children}
    </VpnContext.Provider>
  );
}

// ── Protocoles de repli ───────────────────────────────────────────────────────

const FALLBACK_PROTOCOLS: VpnProtocol[] = [
  { name: 'VLESS',       port: 443,  transport: 'TCP',  security: 'Reality',     description: 'Recommandé' },
  { name: 'VMess',       port: 80,   transport: 'WS',   security: 'None',        description: 'Compatible' },
  { name: 'Trojan',      port: 443,  transport: 'TCP',  security: 'TLS',         description: 'Stable' },
  { name: 'Shadowsocks', port: 8388, transport: 'TCP',  security: 'ChaCha20',    description: 'Léger' },
  { name: 'Hysteria2',   port: 443,  transport: 'QUIC', security: 'TLS',         description: 'Rapide' },
  { name: 'SSH',         port: 22,   transport: 'TCP',  security: 'SSH',         description: 'Sécurisé' },
  { name: 'SSH+Payload', port: 80,   transport: 'TCP',  security: 'SSH+Payload', description: 'Bypass DPI' },
];

// ── Utilitaires formatage ─────────────────────────────────────────────────────

/**
 * Formate un nombre d'octets en chaîne lisible (B / KB / MB / GB).
 * Exporté pour usage dans les composants (ex : HomeScreen stats de trafic).
 */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Formate un débit en octets/sec en chaîne lisible (B/s / KB/s / MB/s).
 * Exporté pour usage dans les composants (ex : HomeScreen stats de trafic).
 */
export function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 B/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
  return `${parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

// ── Export hook ───────────────────────────────────────────────────────────────

export function useVpnContext() {
  return useContext(VpnContext);
}

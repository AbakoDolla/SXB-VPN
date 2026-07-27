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
import * as SecureStore from 'expo-secure-store';
import apiClient from '@/services/apiClient';
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
  hasVpnPermission: false,
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
  const [availableProtocols, setAvailableProtocols]  = useState<VpnProtocol[]>([]);
  const [subscriptionUrl,    setSubscriptionUrl]     = useState<string | null>(null);
  const [serverInfo,         setServerInfo]          = useState<{ host: string; location: string } | null>(null);
  const [trafficStats,       setTrafficStats]        = useState<TrafficStats>(DEFAULT_STATS);
  const [vpnLogs,            setVpnLogs]             = useState<string[]>([]);
  const [hasVpnPermission,   setHasVpnPermission]    = useState(false);
  // vpnConfig supprimé — config VPN stockée chiffrée dans SecureStore (PROVISION_KEY)

  const trafficTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const reportTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionStartRef  = useRef<number>(0);

  // ── Ajout d'un log ─────────────────────────────────────────────────────────

  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setVpnLogs(prev => [`[${ts}] ${msg}`, ...prev].slice(0, 200));
  }, []);

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
      const [connected, protocol] = await Promise.all([
        AsyncStorage.getItem('@sxb_vpn_connected'),
        AsyncStorage.getItem('@sxb_vpn_protocol'),
      ]);
      if (protocol) setSelectedProtocol(protocol);

      // Sur Android, vérifier l'état réel du service
      if (IS_ANDROID && SxbVpnNative) {
        try {
          const state: string = await SxbVpnNative.getVpnState();
          const reallyConnected = state === 'connected';
          setVpnState(state);
          setIsConnected(reallyConnected);
          await AsyncStorage.setItem('@sxb_vpn_connected', reallyConnected ? 'true' : 'false');
          return;
        } catch { /* ignore */ }
      }

      // Fallback : utiliser la valeur persistée
      const wasConnected = connected === 'true' && !!isAuthenticated;
      setIsConnected(wasConnected);
      setVpnState(wasConnected ? 'connected' : 'disconnected');
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

  // ── Clé SecureStore pour la config provisionnée ─────────────────────────────
  const PROVISION_KEY = '@sxb_provision_v2';

  // ── Stocker la config provisionnée dans SecureStore ──────────────────────────
  const provisionAndStore = useCallback(async (dataToken: string, did: string): Promise<boolean> => {
    try {
      addLog('🌐 Provisionnement configuration sécurisée...');
      const res = await apiClient.post('/provision/activate', { dataToken, deviceId: did });
      const cfg = res.data;
      if (!cfg.encryptedBlob || !cfg.configKey) {
        addLog('⚠️ Réponse provision invalide');
        return false;
      }
      const stored = JSON.stringify({
        encryptedBlob:   cfg.encryptedBlob,
        configKey:       cfg.configKey,
        encVersion:      cfg.encVersion || 'gcm-v2',
        protocol:        cfg.protocol   || 'ssh',
        signature:       cfg.signature  || '',
        configExpiresAt: cfg.expiresAt  || null,
        deviceId:        did,
        storedAt:        new Date().toISOString(),
      });
      await SecureStore.setItemAsync(PROVISION_KEY, stored);
      addLog('🔐 Configuration stockée dans le Keystore');
      return true;
    } catch (err: any) {
      addLog();
      return false;
    }
  }, [addLog]);

  // ── Charger la config provisionnée depuis SecureStore ────────────────────────
  const loadProvisionedConfig = useCallback(async (): Promise<any | null> => {
    try {
      const raw = await SecureStore.getItemAsync(PROVISION_KEY);
      if (!raw) return null;
      const cfg = JSON.parse(raw);
      if (cfg.configExpiresAt && new Date(cfg.configExpiresAt) < new Date()) {
        await SecureStore.deleteItemAsync(PROVISION_KEY);
        addLog('⚠️ Config expirée — re-provisionnement nécessaire');
        return null;
      }
      return cfg;
    } catch {
      return null;
    }
  }, [addLog]);

  // ── Fetch config VPN depuis le backend ────────────────────────────────────

  const refreshVpnConfig = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const res = await apiClient.get('/mobile/vpn/config');
      const data = res.data;
      if (data.serverInfo) setServerInfo(data.serverInfo);

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

      // Auto-provision si subscription disponible et pas encore en cache
      if (data.subscription?.dataToken && deviceId) {
        const existing = await loadProvisionedConfig();
        if (!existing) {
          await provisionAndStore(data.subscription.dataToken, deviceId);
        }
      }
    } catch {
      setAvailableProtocols(FALLBACK_PROTOCOLS);
    }
  }, [isAuthenticated, deviceId, loadProvisionedConfig, provisionAndStore]);

  useEffect(() => { refreshVpnConfig(); }, [refreshVpnConfig]);

  // ── Connect ───────────────────────────────────────────────────────────────

  const connect = useCallback(async () => {
    if (isConnecting || isConnected) return;
    setIsConnecting(true);
    addLog('🔄 Initialisation du tunnel VPN...');

    try {
      if (IS_ANDROID && SxbVpnNative) {
        // 1. Permission VPN Android
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

        // 2. Charger config chiffrée depuis SecureStore (Android Keystore)
        addLog('🔐 Chargement configuration sécurisée...');
        let provConfig = await loadProvisionedConfig();

        if (!provConfig) {
          // 3. Re-provisionnement automatique
          addLog('🌐 Récupération configuration serveur...');
          try {
            const res = await apiClient.get('/mobile/vpn/config');
            const data = res.data;
            const dataToken = data.subscription?.dataToken;
            if (!dataToken) {
              addLog('❌ Aucun forfait actif — importez un abonnement');
              setIsConnecting(false);
              return;
            }
            if (!deviceId) {
              addLog('❌ deviceId manquant — relancez l\'application');
              setIsConnecting(false);
              return;
            }
            const ok = await provisionAndStore(dataToken, deviceId);
            if (!ok) {
              addLog('❌ Provisionnement échoué — vérifiez votre connexion');
              setIsConnecting(false);
              return;
            }
            provConfig = await loadProvisionedConfig();
          } catch {
            addLog('❌ Impossible de contacter le serveur de provisionnement');
            setIsConnecting(false);
            return;
          }
        }

        // 4. Bloc strict — pas de fallback AsyncStorage
        if (!provConfig?.encryptedBlob || !provConfig?.configKey) {
          addLog('❌ Configuration sécurisée invalide — réactivez votre compte');
          setIsConnecting(false);
          return;
        }

        // 5. Passer config chiffrée au VPN engine (déchiffrement natif Kotlin)
        const protocol = provConfig.protocol || selectedProtocol || 'ssh';
        const optionsJson = JSON.stringify({
          encryptedBlob: provConfig.encryptedBlob,
          configKey:     provConfig.configKey,
          encVersion:    provConfig.encVersion || 'gcm-v2',
          protocol,
          killSwitch:    false,
          autoReconnect: true,
        });

        addLog(`🚀 Démarrage tunnel ${protocol.toUpperCase()}...`);
        await SxbVpnNative.startVpn(optionsJson);
        addLog('⏳ Connexion en cours...');

      } else {
        // Hors Android (dev web/iOS)
        addLog('⚠️ VPN Android non disponible sur cette plateforme');
        await apiClient.post('/mobile/vpn/session', {
          action: 'connect', protocol: selectedProtocol || 'ssh',
        });
        await new Promise(r => setTimeout(r, 1200));
        setIsConnected(true);
        setVpnState('connected');
        await AsyncStorage.setItem('@sxb_vpn_connected', 'true');
        addLog('✅ Connecté (mode web)');
        setIsConnecting(false);
      }

      // Audit trail backend (non bloquant)
      try {
        await apiClient.post('/mobile/vpn/session', {
          action: 'connect', protocol: selectedProtocol || 'ssh',
        });
      } catch { /* non-bloquant */ }

    } catch (err: any) {
      addLog(`❌ Erreur : ${err?.message || 'Connexion échouée'}`);
      setVpnState('error');
      setIsConnecting(false);
    }
  }, [isConnecting, isConnected, selectedProtocol, deviceId, loadProvisionedConfig, provisionAndStore, addLog]);

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

  return (
    <VpnContext.Provider value={{
      isConnected, isConnecting, vpnState,
      selectedProtocol, availableProtocols,
      subscriptionUrl, serverInfo,
      trafficStats, vpnLogs,
      hasVpnPermission,
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

// ── Export hook ───────────────────────────────────────────────────────────────

export function useVpnContext() {
  return useContext(VpnContext);
}

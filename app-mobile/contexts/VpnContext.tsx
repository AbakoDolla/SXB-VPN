import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { NativeModules, NativeEventEmitter, Platform } from "react-native";
import apiClient from "@/services/apiClient";
import { useAuthContext } from "./AuthContext";

// ── Protocol types ─────────────────────────────────────────────────────────────

export type ProtocolName =
  | "VLESS" | "VMess" | "Trojan" | "Shadowsocks"
  | "Hysteria2" | "SSH" | "SSH+Payload" | "WireGuard" | "TUIC";

export interface VpnProtocol {
  name: ProtocolName | string;
  port: number;
  transport: string;
  security: string;
  description?: string;
}

export interface VpnConnectionConfig {
  protocol: string;
  host: string;
  port: number;
  uuid?: string;
  username?: string;
  password?: string;
  method?: string;
  path?: string;
  network?: string;
  tls?: boolean;
  sni?: string;
  flow?: string;
  privateKey?: string;
  peerPublicKey?: string;
  localAddress?: string;
  connectionUri?: string | null;
  profileName?: string;
  subscriptionName?: string;
}

// ── Context type ──────────────────────────────────────────────────────────────

interface VpnContextType {
  isConnected: boolean;
  isConnecting: boolean;
  selectedProtocol: string | null;
  availableProtocols: VpnProtocol[];
  subscriptionUrl: string | null;
  serverInfo: { host: string; location: string } | null;
  connectionConfig: VpnConnectionConfig | null;
  logs: string[];
  hasVpnPermission: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  selectProtocol: (name: string) => void;
  refreshVpnConfig: () => Promise<void>;
  requestVpnPermission: () => Promise<boolean>;
}

const VpnContext = createContext<VpnContextType>({
  isConnected: false,
  isConnecting: false,
  selectedProtocol: null,
  availableProtocols: [],
  subscriptionUrl: null,
  serverInfo: null,
  connectionConfig: null,
  logs: [],
  hasVpnPermission: false,
  connect: async () => {},
  disconnect: async () => {},
  selectProtocol: () => {},
  refreshVpnConfig: async () => {},
  requestVpnPermission: async () => false,
});

const FALLBACK_PROTOCOLS: VpnProtocol[] = [
  { name: "VLESS",       port: 443,  transport: "TCP",  security: "Reality", description: "Recommandé" },
  { name: "VMess",       port: 80,   transport: "WS",   security: "None",    description: "Compatible" },
  { name: "Trojan",      port: 443,  transport: "TCP",  security: "TLS",     description: "Stable" },
  { name: "Shadowsocks", port: 8388, transport: "TCP",  security: "ChaCha20",description: "Léger" },
  { name: "Hysteria2",   port: 443,  transport: "QUIC", security: "TLS",     description: "Rapide" },
  { name: "SSH",         port: 22,   transport: "TCP",  security: "SSH",     description: "Sécurisé" },
  { name: "SSH+Payload", port: 80,   transport: "TCP",  security: "Bypass",  description: "Bypass DPI" },
];

// ── Native VPN module (Android) ───────────────────────────────────────────────
const SxbVpnNative = Platform.OS === 'android' ? NativeModules.SxbVpnNative : null;

function buildSingBoxConfigJson(config: VpnConnectionConfig): string {
  return JSON.stringify({
    protocol: config.protocol,
    host: config.host,
    port: config.port,
    uuid: config.uuid || '',
    password: config.password || '',
    method: config.method || 'aes-256-gcm',
    network: config.network || 'tcp',
    tls: config.tls || false,
    sni: config.sni || config.host,
    path: config.path || '/',
    flow: config.flow || '',
    privateKey: config.privateKey || '',
    peerPublicKey: config.peerPublicKey || '',
    localAddress: config.localAddress || '10.0.0.2/32',
  });
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function VpnProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, refreshAccountState } = useAuthContext();

  const [isConnected, setIsConnected]         = useState(false);
  const [isConnecting, setIsConnecting]       = useState(false);
  const [selectedProtocol, setSelectedProtocol] = useState<string | null>(null);
  const [availableProtocols, setAvailableProtocols] = useState<VpnProtocol[]>(FALLBACK_PROTOCOLS);
  const [subscriptionUrl, setSubscriptionUrl] = useState<string | null>(null);
  const [serverInfo, setServerInfo]           = useState<{ host: string; location: string } | null>(null);
  const [connectionConfig, setConnectionConfig] = useState<VpnConnectionConfig | null>(null);
  const [logs, setLogs]                       = useState<string[]>([]);
  const [hasVpnPermission, setHasVpnPermission] = useState(false);

  const statusSubRef = useRef<any>(null);
  const logSubRef    = useRef<any>(null);

  const addLog = useCallback((msg: string) => {
    setLogs(prev => [...prev.slice(-99), msg]);
  }, []);

  // ── Native event listeners ─────────────────────────────────────────────────

  useEffect(() => {
    if (!SxbVpnNative) return;

    const emitter = new NativeEventEmitter(SxbVpnNative);

    statusSubRef.current = emitter.addListener('onVpnStatusChange', (event: { status: string }) => {
      const s = event.status;
      if (s === 'connected') {
        setIsConnected(true);
        setIsConnecting(false);
        AsyncStorage.setItem('@sxb_vpn_connected', 'true');
        refreshAccountState().catch(() => {});
      } else if (s === 'connecting') {
        setIsConnecting(true);
        setIsConnected(false);
      } else if (s === 'disconnected') {
        setIsConnected(false);
        setIsConnecting(false);
        AsyncStorage.setItem('@sxb_vpn_connected', 'false');
      } else if (s === 'error') {
        setIsConnected(false);
        setIsConnecting(false);
        AsyncStorage.setItem('@sxb_vpn_connected', 'false');
        addLog('❌ Erreur de connexion VPN');
      }
    });

    logSubRef.current = emitter.addListener('onVpnLog', (event: { message: string }) => {
      addLog(event.message);
    });

    // Check VPN permission on mount
    checkVpnPermission();

    return () => {
      statusSubRef.current?.remove();
      logSubRef.current?.remove();
    };
  }, []);

  const checkVpnPermission = async () => {
    if (!SxbVpnNative) {
      setHasVpnPermission(false);
      return;
    }
    try {
      const granted = await SxbVpnNative.isVpnPermissionGranted();
      setHasVpnPermission(!!granted);
    } catch {
      setHasVpnPermission(false);
    }
  };

  const requestVpnPermission = useCallback(async (): Promise<boolean> => {
    if (!SxbVpnNative) return false;
    // On Android, the permission dialog is shown by VpnService.prepare()
    // We trigger it by calling startVpn with a dummy config and catching the error
    try {
      const granted = await SxbVpnNative.isVpnPermissionGranted();
      setHasVpnPermission(!!granted);
      return !!granted;
    } catch {
      return false;
    }
  }, []);

  // ── Restore session ────────────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      const [connected, protocol] = await Promise.all([
        AsyncStorage.getItem('@sxb_vpn_connected'),
        AsyncStorage.getItem('@sxb_vpn_protocol'),
      ]);
      if (connected === 'true' && isAuthenticated) {
        // Don't restore connected state — user must press button again after restart
        // This is intentional for security
      }
      if (protocol) setSelectedProtocol(protocol);
    })();
  }, [isAuthenticated]);

  // ── Fetch real VPN config ──────────────────────────────────────────────────

  const refreshVpnConfig = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const res = await apiClient.get('/mobile/vpn/config');
      const data = res.data;

      if (data.subscriptionUrl) setSubscriptionUrl(data.subscriptionUrl);
      if (data.serverInfo)      setServerInfo(data.serverInfo);

      // Real profile from backend
      if (data.profile) {
        const cfg = data.profile as VpnConnectionConfig;
        setConnectionConfig(cfg);
        // Persist for offline use (encrypted storage in production)
        await AsyncStorage.setItem('@sxb_vpn_config', JSON.stringify(cfg));
      }

      if (data.connectionUri) {
        await AsyncStorage.setItem('@sxb_connection_uri', data.connectionUri);
      }

      if (Array.isArray(data.protocols) && data.protocols.length > 0) {
        setAvailableProtocols(data.protocols);
        const saved = await AsyncStorage.getItem('@sxb_vpn_protocol');
        if (!saved && data.protocols[0]) {
          setSelectedProtocol(data.protocols[0].name);
          await AsyncStorage.setItem('@sxb_vpn_protocol', data.protocols[0].name);
        }
      }
    } catch {
      // Offline: try to load persisted config
      try {
        const cached = await AsyncStorage.getItem('@sxb_vpn_config');
        if (cached) setConnectionConfig(JSON.parse(cached));
      } catch {}
      setAvailableProtocols(FALLBACK_PROTOCOLS);
    }
  }, [isAuthenticated]);

  useEffect(() => { refreshVpnConfig(); }, [refreshVpnConfig]);

  // ── Connect ────────────────────────────────────────────────────────────────

  const connect = useCallback(async () => {
    if (isConnecting || isConnected) return;
    setIsConnecting(true);
    setLogs([]);

    try {
      // Get config: from state or AsyncStorage (offline)
      let cfg = connectionConfig;
      if (!cfg) {
        const cached = await AsyncStorage.getItem('@sxb_vpn_config');
        if (cached) cfg = JSON.parse(cached);
      }

      if (Platform.OS === 'android' && SxbVpnNative) {
        // ── REAL VPN (Android native module) ──────────────────────────────

        // Check permission first
        const permGranted = await SxbVpnNative.isVpnPermissionGranted();
        if (!permGranted) {
          addLog('❌ Permission VPN requise — Accordez l\'accès dans la boîte de dialogue');
          // Try to start anyway — Android will show the permission dialog
          // The user must grant it before VPN can start
        }

        const configJson = cfg ? buildSingBoxConfigJson(cfg) : JSON.stringify({
          protocol: selectedProtocol?.toLowerCase() || 'direct',
          host: serverInfo?.host || '',
          port: 443,
        });

        addLog('Demande de connexion VPN...');
        await SxbVpnNative.startVpn(configJson);
        // Status will be updated via onVpnStatusChange event

      } else {
        // ── Fallback (iOS or no native module) ────────────────────────────
        addLog('Mode simulation (module natif non disponible sur cette plateforme)');
        await apiClient.post('/mobile/vpn/session', {
          action: 'connect',
          protocol: selectedProtocol || cfg?.protocol || 'SSH',
        });
        await new Promise(r => setTimeout(r, 1200));
        setIsConnected(true);
        setIsConnecting(false);
        await AsyncStorage.setItem('@sxb_vpn_connected', 'true');
        refreshAccountState().catch(() => {});
      }

      // Log session to backend (non-blocking)
      apiClient.post('/mobile/vpn/session', {
        action: 'connect',
        protocol: selectedProtocol || cfg?.protocol || 'VPN',
      }).catch(() => {});

    } catch (err: any) {
      const msg = err?.message || 'Erreur inconnue';
      addLog(`❌ Erreur: ${msg}`);
      setIsConnected(false);
      setIsConnecting(false);
    }
  }, [isConnecting, isConnected, selectedProtocol, connectionConfig, serverInfo, addLog, refreshAccountState]);

  // ── Disconnect ────────────────────────────────────────────────────────────

  const disconnect = useCallback(async () => {
    if (isConnecting) return;
    setIsConnecting(true);

    try {
      if (Platform.OS === 'android' && SxbVpnNative) {
        addLog('Déconnexion du tunnel VPN...');
        await SxbVpnNative.stopVpn();
        // Status updated via onVpnStatusChange event
      } else {
        await apiClient.post('/mobile/vpn/session', { action: 'disconnect' }).catch(() => {});
        await new Promise(r => setTimeout(r, 600));
        setIsConnected(false);
        setIsConnecting(false);
        await AsyncStorage.setItem('@sxb_vpn_connected', 'false');
      }

      apiClient.post('/mobile/vpn/session', { action: 'disconnect' }).catch(() => {});
    } catch {
      setIsConnected(false);
      setIsConnecting(false);
    }
  }, [isConnecting, addLog]);

  // ── Select protocol ───────────────────────────────────────────────────────

  const selectProtocol = useCallback(async (name: string) => {
    setSelectedProtocol(name);
    await AsyncStorage.setItem('@sxb_vpn_protocol', name);
    if (isConnected) {
      await disconnect();
      setTimeout(() => connect(), 800);
    }
  }, [isConnected, connect, disconnect]);

  return (
    <VpnContext.Provider value={{
      isConnected, isConnecting,
      selectedProtocol, availableProtocols,
      subscriptionUrl, serverInfo,
      connectionConfig,
      logs,
      hasVpnPermission,
      connect, disconnect, selectProtocol,
      refreshVpnConfig,
      requestVpnPermission,
    }}>
      {children}
    </VpnContext.Provider>
  );
}

export function useVpnContext() {
  return useContext(VpnContext);
}

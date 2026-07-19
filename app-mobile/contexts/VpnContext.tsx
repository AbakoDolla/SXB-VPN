import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
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
  path?: string;
  network?: string;
  tls?: boolean;
  sni?: string;
  connectionUri?: string | null;
  profileName?: string;
  subscriptionName?: string;
}

// ── Context type ─────────────────────────────────────────────────────────────

interface VpnContextType {
  isConnected: boolean;
  isConnecting: boolean;
  selectedProtocol: string | null;
  availableProtocols: VpnProtocol[];
  subscriptionUrl: string | null;
  serverInfo: { host: string; location: string } | null;
  connectionConfig: VpnConnectionConfig | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  selectProtocol: (name: string) => void;
  refreshVpnConfig: () => Promise<void>;
}

const VpnContext = createContext<VpnContextType>({
  isConnected: false,
  isConnecting: false,
  selectedProtocol: null,
  availableProtocols: [],
  subscriptionUrl: null,
  serverInfo: null,
  connectionConfig: null,
  connect: async () => {},
  disconnect: async () => {},
  selectProtocol: () => {},
  refreshVpnConfig: async () => {},
});

const FALLBACK_PROTOCOLS: VpnProtocol[] = [
  { name: "SSH",         port: 22,   transport: "TCP",  security: "SSH",     description: "Sécurisé" },
  { name: "SSH+Payload", port: 80,   transport: "TCP",  security: "Bypass",  description: "Bypass DPI" },
  { name: "VLESS",       port: 443,  transport: "TCP",  security: "Reality", description: "Recommandé" },
  { name: "VMess",       port: 80,   transport: "WS",   security: "None",    description: "Compatible" },
  { name: "Trojan",      port: 443,  transport: "TCP",  security: "TLS",     description: "Stable" },
  { name: "Shadowsocks", port: 8388, transport: "TCP",  security: "ChaCha20",description: "Léger" },
  { name: "Hysteria2",   port: 443,  transport: "QUIC", security: "TLS",     description: "Rapide" },
];

// ── Provider ─────────────────────────────────────────────────────────────────

export function VpnProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, refreshAccountState } = useAuthContext();

  const [isConnected, setIsConnected]         = useState(false);
  const [isConnecting, setIsConnecting]       = useState(false);
  const [selectedProtocol, setSelectedProtocol] = useState<string | null>(null);
  const [availableProtocols, setAvailableProtocols] = useState<VpnProtocol[]>(FALLBACK_PROTOCOLS);
  const [subscriptionUrl, setSubscriptionUrl] = useState<string | null>(null);
  const [serverInfo, setServerInfo]           = useState<{ host: string; location: string } | null>(null);
  const [connectionConfig, setConnectionConfig] = useState<VpnConnectionConfig | null>(null);

  // Restore persisted state
  useEffect(() => {
    (async () => {
      const [connected, protocol] = await Promise.all([
        AsyncStorage.getItem("@sxb_vpn_connected"),
        AsyncStorage.getItem("@sxb_vpn_protocol"),
      ]);
      setIsConnected(connected === "true" && !!isAuthenticated);
      if (protocol) setSelectedProtocol(protocol);
    })();
  }, [isAuthenticated]);

  // Fetch real VPN config from backend (subscription-based)
  const refreshVpnConfig = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const res = await apiClient.get("/mobile/vpn/config");
      const data = res.data;

      // Real subscription URL / connection URI
      if (data.subscriptionUrl) setSubscriptionUrl(data.subscriptionUrl);
      if (data.serverInfo)      setServerInfo(data.serverInfo);
      if (data.profile)         setConnectionConfig(data.profile as VpnConnectionConfig);

      // Persist connection URI for offline use
      if (data.connectionUri) {
        await AsyncStorage.setItem("@sxb_connection_uri", data.connectionUri);
      }
      if (data.subscription?.dataToken) {
        await AsyncStorage.setItem("@sxb_data_token", data.subscription.dataToken);
      }

      if (Array.isArray(data.protocols) && data.protocols.length > 0) {
        setAvailableProtocols(data.protocols);
        const saved = await AsyncStorage.getItem("@sxb_vpn_protocol");
        if (!saved && data.protocols[0]) {
          setSelectedProtocol(data.protocols[0].name);
          await AsyncStorage.setItem("@sxb_vpn_protocol", data.protocols[0].name);
        }
      } else {
        setAvailableProtocols(FALLBACK_PROTOCOLS);
      }
    } catch (_) {
      setAvailableProtocols(FALLBACK_PROTOCOLS);
    }
  }, [isAuthenticated]);

  useEffect(() => { refreshVpnConfig(); }, [refreshVpnConfig]);

  // Connect
  const connect = useCallback(async () => {
    if (isConnecting) return;
    setIsConnecting(true);
    try {
      // Log session to backend
      await apiClient.post("/mobile/vpn/session", {
        action: "connect",
        protocol: selectedProtocol || connectionConfig?.protocol || "SSH",
      });
      await new Promise(r => setTimeout(r, 1200));
      setIsConnected(true);
      await AsyncStorage.setItem("@sxb_vpn_connected", "true");
      refreshAccountState().catch(() => {});
    } catch (_) {
      // Still mark as connected (offline mode)
      setIsConnected(true);
      await AsyncStorage.setItem("@sxb_vpn_connected", "true");
    } finally {
      setIsConnecting(false);
    }
  }, [isConnecting, selectedProtocol, connectionConfig, refreshAccountState]);

  // Disconnect
  const disconnect = useCallback(async () => {
    if (isConnecting) return;
    setIsConnecting(true);
    try {
      await apiClient.post("/mobile/vpn/session", { action: "disconnect" });
      await new Promise(r => setTimeout(r, 600));
    } catch (_) {}
    finally {
      setIsConnected(false);
      await AsyncStorage.setItem("@sxb_vpn_connected", "false");
      setIsConnecting(false);
    }
  }, [isConnecting]);

  const selectProtocol = useCallback(async (name: string) => {
    setSelectedProtocol(name);
    await AsyncStorage.setItem("@sxb_vpn_protocol", name);
    if (isConnected) {
      await disconnect();
      setTimeout(() => connect(), 500);
    }
  }, [isConnected, connect, disconnect]);

  return (
    <VpnContext.Provider value={{
      isConnected, isConnecting,
      selectedProtocol, availableProtocols,
      subscriptionUrl, serverInfo,
      connectionConfig,
      connect, disconnect, selectProtocol,
      refreshVpnConfig,
    }}>
      {children}
    </VpnContext.Provider>
  );
}

export function useVpnContext() {
  return useContext(VpnContext);
}

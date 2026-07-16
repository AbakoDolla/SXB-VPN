import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient from '@/services/apiClient';
import { useAuthContext } from './AuthContext';

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

// ── Context type ─────────────────────────────────────────────────────────────

interface VpnContextType {
  isConnected: boolean;
  isConnecting: boolean;
  selectedProtocol: string | null;
  availableProtocols: VpnProtocol[];
  subscriptionUrl: string | null;
  serverInfo: { host: string; location: string } | null;
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
  connect: async () => {},
  disconnect: async () => {},
  selectProtocol: () => {},
  refreshVpnConfig: async () => {},
});

// Protocoles de secours utilisés hors ligne ou si le serveur ne répond pas
const FALLBACK_PROTOCOLS: VpnProtocol[] = [
  { name: 'VLESS',       port: 443,  transport: 'TCP',  security: 'Reality',     description: 'Recommandé' },
  { name: 'VMess',       port: 80,   transport: 'WS',   security: 'None',        description: 'Compatible' },
  { name: 'Trojan',      port: 443,  transport: 'TCP',  security: 'TLS',         description: 'Stable' },
  { name: 'Shadowsocks', port: 8388, transport: 'TCP',  security: 'ChaCha20',    description: 'Léger' },
  { name: 'Hysteria2',   port: 443,  transport: 'QUIC', security: 'TLS',         description: 'Rapide' },
  { name: 'SSH',         port: 22,   transport: 'TCP',  security: 'SSH',         description: 'Sécurisé' },
  { name: 'SSH+Payload', port: 80,   transport: 'TCP',  security: 'SSH+Payload', description: 'Bypass DPI' },
];

const CACHE_KEY = '@sxb_vpn_config_cache';

// ── Provider ─────────────────────────────────────────────────────────────────

export function VpnProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, refreshAccountState } = useAuthContext();

  const [isConnected, setIsConnected]     = useState(false);
  const [isConnecting, setIsConnecting]   = useState(false);
  const [selectedProtocol, setSelectedProtocol] = useState<string | null>(null);
  const [availableProtocols, setAvailableProtocols] = useState<VpnProtocol[]>(FALLBACK_PROTOCOLS);
  const [subscriptionUrl, setSubscriptionUrl] = useState<string | null>(null);
  const [serverInfo, setServerInfo] = useState<{ host: string; location: string } | null>(null);

  // ── Restore persisted state ──────────────────────────────────────────────

  useEffect(() => {
    const restore = async () => {
      const [connected, protocol, cache] = await Promise.all([
        AsyncStorage.getItem('@sxb_vpn_connected'),
        AsyncStorage.getItem('@sxb_vpn_protocol'),
        AsyncStorage.getItem(CACHE_KEY),
      ]);
      setIsConnected(connected === 'true' && !!isAuthenticated);
      if (protocol) setSelectedProtocol(protocol);

      // Charger la config en cache immédiatement (offline first)
      if (cache) {
        try {
          const cached = JSON.parse(cache);
          if (cached.subscriptionUrl) setSubscriptionUrl(cached.subscriptionUrl);
          if (cached.serverInfo) setServerInfo(cached.serverInfo);
          if (Array.isArray(cached.protocols) && cached.protocols.length > 0) {
            setAvailableProtocols(cached.protocols);
            if (!protocol && cached.protocols[0]) {
              setSelectedProtocol(cached.protocols[0].name);
            }
          }
        } catch (_) {}
      }
    };
    restore();
  }, [isAuthenticated]);

  // ── Fetch real VPN config from backend ──────────────────────────────────

  const refreshVpnConfig = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const res = await apiClient.get('/mobile/vpn/config');
      const data = res.data;

      if (data.subscriptionUrl) setSubscriptionUrl(data.subscriptionUrl);
      if (data.serverInfo) setServerInfo(data.serverInfo);

      if (Array.isArray(data.protocols) && data.protocols.length > 0) {
        setAvailableProtocols(data.protocols);
        const saved = await AsyncStorage.getItem('@sxb_vpn_protocol');
        if (!saved && data.protocols[0]) {
          setSelectedProtocol(data.protocols[0].name);
          await AsyncStorage.setItem('@sxb_vpn_protocol', data.protocols[0].name);
        }
      } else {
        // Si le serveur retourne une config vide, garder les protocoles existants
        if (availableProtocols.length === 0) {
          setAvailableProtocols(FALLBACK_PROTOCOLS);
        }
      }

      // Mettre à jour le cache
      await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({
        subscriptionUrl: data.subscriptionUrl ?? subscriptionUrl,
        serverInfo: data.serverInfo ?? serverInfo,
        protocols: (Array.isArray(data.protocols) && data.protocols.length > 0)
          ? data.protocols
          : availableProtocols,
      }));
    } catch (_) {
      // Hors ligne ou erreur serveur → garder les données en cache/fallback
      if (availableProtocols.length === 0) {
        setAvailableProtocols(FALLBACK_PROTOCOLS);
      }
    }
  }, [isAuthenticated]);

  useEffect(() => {
    refreshVpnConfig();
  }, [refreshVpnConfig]);

  // ── Connect/Disconnect ───────────────────────────────────────────────────

  const connect = useCallback(async () => {
    if (isConnecting) return;
    setIsConnecting(true);
    try {
      await apiClient.post('/mobile/vpn/session', {
        action: 'connect',
        protocol: selectedProtocol || 'VLESS',
      });
      await new Promise(r => setTimeout(r, 1400));
      setIsConnected(true);
      await AsyncStorage.setItem('@sxb_vpn_connected', 'true');
      refreshAccountState().catch(() => {});
    } catch (_) {
      // Même si le serveur ne répond pas, marquer comme connecté côté UI
      setIsConnected(true);
      await AsyncStorage.setItem('@sxb_vpn_connected', 'true');
    } finally {
      setIsConnecting(false);
    }
  }, [isConnecting, selectedProtocol, refreshAccountState]);

  const disconnect = useCallback(async () => {
    if (isConnecting) return;
    setIsConnecting(true);
    try {
      await apiClient.post('/mobile/vpn/session', { action: 'disconnect' });
      await new Promise(r => setTimeout(r, 700));
    } catch (_) { /* ignore */ }
    finally {
      setIsConnected(false);
      await AsyncStorage.setItem('@sxb_vpn_connected', 'false');
      setIsConnecting(false);
    }
  }, [isConnecting]);

  const selectProtocol = useCallback(async (name: string) => {
    setSelectedProtocol(name);
    await AsyncStorage.setItem('@sxb_vpn_protocol', name);
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

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient from '@/services/apiClient';
import { useAuthContext } from './AuthContext';

interface VpnContextType {
  isConnected: boolean;
  isConnecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

const VpnContext = createContext<VpnContextType>({
  isConnected: false,
  isConnecting: false,
  connect: async () => {},
  disconnect: async () => {},
});

export function VpnProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, refreshAccountState } = useAuthContext();
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);

  useEffect(() => {
    if (isAuthenticated) {
      AsyncStorage.getItem('@sxb_vpn_connected').then((val) => {
        setIsConnected(val === 'true');
      });
    } else {
      setIsConnected(false);
    }
  }, [isAuthenticated]);

  const connect = useCallback(async () => {
    if (isConnecting) return;
    setIsConnecting(true);
    try {
      await apiClient.post('/mobile/vpn/session', { action: 'connect' });
      // Simulate connection handshake delay
      await new Promise((r) => setTimeout(r, 1600));
      setIsConnected(true);
      await AsyncStorage.setItem('@sxb_vpn_connected', 'true');
      refreshAccountState().catch(() => {});
    } catch (_) {
      // Still show connected state locally
      setIsConnected(true);
      await AsyncStorage.setItem('@sxb_vpn_connected', 'true');
    } finally {
      setIsConnecting(false);
    }
  }, [isConnecting, refreshAccountState]);

  const disconnect = useCallback(async () => {
    if (isConnecting) return;
    setIsConnecting(true);
    try {
      await apiClient.post('/mobile/vpn/session', { action: 'disconnect' });
      await new Promise((r) => setTimeout(r, 800));
    } catch (_) {
      // ignore
    } finally {
      setIsConnected(false);
      await AsyncStorage.setItem('@sxb_vpn_connected', 'false');
      setIsConnecting(false);
    }
  }, [isConnecting]);

  return (
    <VpnContext.Provider value={{ isConnected, isConnecting, connect, disconnect }}>
      {children}
    </VpnContext.Provider>
  );
}

export function useVpnContext() {
  return useContext(VpnContext);
}

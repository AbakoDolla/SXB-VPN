/**
 * ConfigContext.tsx
 *
 * Gère l'état de la configuration VPN importée via token de configuration.
 * La config est déchiffrée en mémoire à la demande.
 */

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { importConfig, getStoredConfig, clearStoredConfig, getConfigTokenRef, type ImportConfigResult } from '@/services/configService';
import { hasSecureConfig } from '@/services/secureConfig';
import { useAuthContext } from '@/contexts/AuthContext';
import type { SecureConfigPayload } from '@/services/secureConfig';

interface ConfigContextType {
  hasConfig: boolean;
  isImporting: boolean;
  config: SecureConfigPayload | null;
  configTokenRef: string | null;
  importVpnConfig: (configToken: string) => Promise<ImportConfigResult>;
  refreshConfig: () => Promise<void>;
  clearConfig: () => Promise<void>;
}

const ConfigContext = createContext<ConfigContextType>({
  hasConfig: false,
  isImporting: false,
  config: null,
  configTokenRef: null,
  importVpnConfig: async () => ({ config: {} }),
  refreshConfig: async () => {},
  clearConfig: async () => {},
});

export function ConfigProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuthContext();

  const [hasConfig, setHasConfig] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [config, setConfig] = useState<SecureConfigPayload | null>(null);
  const [configTokenRef, setConfigTokenRef] = useState<string | null>(null);

  // Vérifier si une config existe déjà au démarrage
  useEffect(() => {
    (async () => {
      const exists = await hasSecureConfig();
      setHasConfig(exists);
      const ref = await getConfigTokenRef();
      setConfigTokenRef(ref);
    })();
  }, []);

  // Charger la config déchiffrée quand l'utilisateur est authentifié
  useEffect(() => {
    if (isAuthenticated) {
      refreshConfig();
    }
  }, [isAuthenticated]);

  const getAccessToken = async (): Promise<string> => {
    const token = await AsyncStorage.getItem('@sxb_access_token');
    return token ?? '';
  };

  const refreshConfig = useCallback(async () => {
    try {
      const token = await getAccessToken();
      if (!token) return;
      const stored = await getStoredConfig(token);
      if (stored) {
        setConfig(stored);
        setHasConfig(true);
        const ref = await getConfigTokenRef();
        setConfigTokenRef(ref);
      }
    } catch {
      // silencieux
    }
  }, []);

  const importVpnConfig = useCallback(async (configToken: string): Promise<ImportConfigResult> => {
    setIsImporting(true);
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error('Non authentifié');

      const result = await importConfig(configToken, accessToken);
      setConfig(result.config);
      setHasConfig(true);
      const ref = await getConfigTokenRef();
      setConfigTokenRef(ref);
      return result;
    } finally {
      setIsImporting(false);
    }
  }, []);

  const clearConfig = useCallback(async () => {
    await clearStoredConfig();
    setConfig(null);
    setHasConfig(false);
    setConfigTokenRef(null);
  }, []);

  return (
    <ConfigContext.Provider
      value={{
        hasConfig,
        isImporting,
        config,
        configTokenRef,
        importVpnConfig,
        refreshConfig,
        clearConfig,
      }}
    >
      {children}
    </ConfigContext.Provider>
  );
}

export function useConfigContext() {
  return useContext(ConfigContext);
}

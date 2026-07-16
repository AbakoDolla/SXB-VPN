import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient from '@/services/apiClient';
import type { AccountState, User } from '@/types/api';

const KEYS = {
  ACCESS: '@sxb_access_token',
  REFRESH: '@sxb_refresh_token',
  USER: '@sxb_user',
  ONBOARDING: '@sxb_onboarding_done',
  DEVICE_ID: '@sxb_device_id',
};

// Generate a unique device ID stored permanently (survives app restarts)
async function getOrCreateDeviceId(): Promise<string> {
  try {
    const stored = await AsyncStorage.getItem(KEYS.DEVICE_ID);
    if (stored) return stored;
    // Generate format: SXB + 15 random alphanumeric chars
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const rand = Array.from({ length: 15 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const id = 'SXB' + rand;
    await AsyncStorage.setItem(KEYS.DEVICE_ID, id);
    return id;
  } catch {
    return 'SXB' + Math.random().toString(36).toUpperCase().slice(2, 17);
  }
}

interface AuthContextType {
  isLoading: boolean;
  isAuthenticated: boolean;
  user: User | null;
  accountState: AccountState | null;
  hasSeenOnboarding: boolean;
  deviceId: string;
  activateAccount: (token: string) => Promise<void>;
  activatePlan: (code: string) => Promise<void>;
  refreshAccountState: () => Promise<void>;
  logout: () => Promise<void>;
  markOnboardingDone: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextType>({
  isLoading: true,
  isAuthenticated: false,
  user: null,
  accountState: null,
  hasSeenOnboarding: false,
  deviceId: '',
  activateAccount: async () => {},
  activatePlan: async () => {},
  refreshAccountState: async () => {},
  logout: async () => {},
  markOnboardingDone: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [accountState, setAccountState] = useState<AccountState | null>(null);
  const [hasSeenOnboarding, setHasSeenOnboarding] = useState(false);
  const [deviceId, setDeviceId] = useState<string>('');

  useEffect(() => {
    initSession();
  }, []);

  useEffect(() => {
    getOrCreateDeviceId().then(setDeviceId);
  }, []);

  const initSession = async () => {
    try {
      const results = await AsyncStorage.multiGet([
        KEYS.ACCESS,
        KEYS.USER,
        KEYS.ONBOARDING,
      ]);
      const accessToken = results[0][1];
      const storedUser = results[1][1];
      const onboardingDone = results[2][1];

      setHasSeenOnboarding(!!onboardingDone);

      if (accessToken) {
        if (storedUser) {
          try {
            const parsed = JSON.parse(storedUser);
            setUser(parsed.user ?? null);
            setAccountState(parsed.accountState ?? null);
          } catch (_) {}
        }
        await validateSession();
      }
    } catch (_) {
      // ignore
    } finally {
      setIsLoading(false);
    }
  };

  const validateSession = async () => {
    try {
      const res = await apiClient.get('/mobile/me');
      const { user: u, accountState: as } = res.data;
      setUser(u);
      setAccountState(as);
      setIsAuthenticated(true);
      await AsyncStorage.setItem(KEYS.USER, JSON.stringify({ user: u, accountState: as }));
    } catch (err: any) {
      if (err?.response?.status === 401) {
        const stillHasToken = await AsyncStorage.getItem(KEYS.ACCESS);
        if (!stillHasToken) {
          setIsAuthenticated(false);
          setUser(null);
          setAccountState(null);
        }
      }
    }
  };

  const activateAccount = useCallback(async (token: string) => {
    const did = await getOrCreateDeviceId();
    setDeviceId(did);
    const res = await apiClient.post('/mobile/auth/activate', { token, deviceId: did });
    const { accessToken, refreshToken, user: u, accountState: as } = res.data;
    await AsyncStorage.multiSet([
      [KEYS.ACCESS, accessToken],
      [KEYS.REFRESH, refreshToken],
      [KEYS.USER, JSON.stringify({ user: u, accountState: as })],
    ]);
    setUser(u);
    setAccountState(as);
    setIsAuthenticated(true);
  }, []);

  const activatePlan = useCallback(async (code: string) => {
    const res = await apiClient.post('/mobile/plans/activate', { code });
    const newState: AccountState = res.data.accountState ?? res.data;
    setAccountState(newState);
    if (user) {
      await AsyncStorage.setItem(KEYS.USER, JSON.stringify({ user, accountState: newState }));
    }
  }, [user]);

  const refreshAccountState = useCallback(async () => {
    try {
      const res = await apiClient.get('/mobile/me');
      const { user: u, accountState: as } = res.data;
      setUser(u);
      setAccountState(as);
      await AsyncStorage.setItem(KEYS.USER, JSON.stringify({ user: u, accountState: as }));
    } catch (_) {}
  }, []);

  const logout = useCallback(async () => {
    await AsyncStorage.multiRemove([KEYS.ACCESS, KEYS.REFRESH, KEYS.USER]);
    setUser(null);
    setAccountState(null);
    setIsAuthenticated(false);
  }, []);

  const markOnboardingDone = useCallback(async () => {
    await AsyncStorage.setItem(KEYS.ONBOARDING, 'true');
    setHasSeenOnboarding(true);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        isLoading,
        isAuthenticated,
        user,
        accountState,
        hasSeenOnboarding,
        deviceId,
        activateAccount,
        activatePlan,
        refreshAccountState,
        logout,
        markOnboardingDone,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuthContext() {
  return useContext(AuthContext);
}

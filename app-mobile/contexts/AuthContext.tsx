import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient, { getSecureToken, setSecureToken, removeSecureToken, SEC_KEYS } from '@/services/apiClient';
import type { AccountState, User } from '@/types/api';

// Clés non-sensibles restent dans AsyncStorage (infos user, onboarding...)
// Clés sensibles (JWT) migrent vers SecureStore (Android Keystore / iOS Keychain)
const KEYS = {
  USER:       '@sxb_user',
  ONBOARDING: '@sxb_onboarding_done',
  DEVICE_ID:  '@sxb_device_id',
};

// Generate a unique device ID stored permanently (survives app restarts)
async function getOrCreateDeviceId(): Promise<string> {
  try {
    const stored = await AsyncStorage.getItem(KEYS.DEVICE_ID);
    if (stored) return stored;
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const rand = Array.from({ length: 15 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');
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
  const [isLoading,        setIsLoading]        = useState(true);
  const [isAuthenticated,  setIsAuthenticated]  = useState(false);
  const [user,             setUser]             = useState<User | null>(null);
  const [accountState,     setAccountState]     = useState<AccountState | null>(null);
  const [hasSeenOnboarding,setHasSeenOnboarding]= useState(false);
  const [deviceId,         setDeviceId]         = useState<string>('');

  useEffect(() => {
    initSession();
    getOrCreateDeviceId().then(setDeviceId);
  }, []);

  /**
   * CORRECTIF OFFLINE — Restauration de session locale
   *
   * AVANT : on appelait validateSession() (GET /mobile/me) et
   *         isAuthenticated restait false si l'appel échouait (hors ligne).
   *
   * APRÈS : si un token + un utilisateur sont en cache local, on marque
   *         immédiatement isAuthenticated = true et on lance la validation
   *         réseau en arrière-plan. Seule une réponse 401 du serveur révoque
   *         la session (pas une erreur réseau / timeout).
   */
  const initSession = async () => {
    try {
      // JWT depuis SecureStore (Keystore Android), fallback AsyncStorage legacy
      let accessToken = await getSecureToken(SEC_KEYS.ACCESS);
      if (!accessToken) {
        // Migration v1→v2 : lire l'ancien AsyncStorage et migrer vers SecureStore
        accessToken = await AsyncStorage.getItem('@sxb_access_token');
        const legacyRefresh = await AsyncStorage.getItem('@sxb_refresh_token');
        if (accessToken) await setSecureToken(SEC_KEYS.ACCESS, accessToken);
        if (legacyRefresh) await setSecureToken(SEC_KEYS.REFRESH, legacyRefresh);
        // Nettoyer les anciens tokens en clair
        await AsyncStorage.multiRemove(['@sxb_access_token', '@sxb_refresh_token']).catch(() => {});
      }

      const [storedUser, onboardingDone] = await Promise.all([
        AsyncStorage.getItem(KEYS.USER),
        AsyncStorage.getItem(KEYS.ONBOARDING),
      ]);

      setHasSeenOnboarding(!!onboardingDone);

      if (accessToken) {
        if (storedUser) {
          try {
            const parsed = JSON.parse(storedUser);
            // ✅ Restaurer immédiatement depuis le cache local (Offline First)
            setUser(parsed.user ?? null);
            setAccountState(parsed.accountState ?? null);
            setIsAuthenticated(true);
          } catch (_) {}
        }
        // Valider en arrière-plan (non-bloquant — erreur réseau ne déconnecte PAS)
        validateSession().catch(() => {});
      }
    } catch (_) {
      // Ignorer — isAuthenticated reste false
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Valide la session en ligne.
   * - Succès → met à jour user/accountState depuis le serveur
   * - 401    → session révoquée côté serveur → déconnecter
   * - Erreur réseau → session locale conservée (offline mode)
   */
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
        await Promise.all([
          removeSecureToken(SEC_KEYS.ACCESS),
          removeSecureToken(SEC_KEYS.REFRESH),
          AsyncStorage.removeItem(KEYS.USER),
        ]);
        setIsAuthenticated(false);
        setUser(null);
        setAccountState(null);
      }
      // Erreur réseau → session locale conservée
    }
  };

  const activateAccount = useCallback(async (token: string) => {
    const did = await getOrCreateDeviceId();
    setDeviceId(did);
    const res = await apiClient.post('/mobile/auth/activate', { token, deviceId: did });
    const { accessToken, refreshToken, user: u, accountState: as } = res.data;
    // Stocker JWT dans SecureStore (Keystore Android / Keychain iOS)
    await Promise.all([
      setSecureToken(SEC_KEYS.ACCESS, accessToken),
      setSecureToken(SEC_KEYS.REFRESH, refreshToken),
      AsyncStorage.setItem(KEYS.USER, JSON.stringify({ user: u, accountState: as })),
    ]);
    setUser(u);
    setAccountState(as);
    setIsAuthenticated(true);
  }, []);

  const activatePlan = useCallback(async (code: string) => {
    const res = await apiClient.post('/mobile/packages/activate', { code });
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
    } catch (_) {
      // Hors ligne → ne rien faire (état local conservé)
    }
  }, []);

  const logout = useCallback(async () => {
    await Promise.all([
      removeSecureToken(SEC_KEYS.ACCESS),
      removeSecureToken(SEC_KEYS.REFRESH),
      AsyncStorage.multiRemove([KEYS.USER, '@sxb_access_token', '@sxb_refresh_token']),
    ]);
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

import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

export const API_BASE_URL = 'https://vpnsxb.afrihall.com/api';
const TIMEOUT = 15000;

// ── Secure token storage ───────────────────────────────────────────────────────
// Android : Android Keystore via expo-secure-store (chiffrement AES hardware)
// iOS     : Keychain Services
// Web/dev : AsyncStorage fallback (pas de Keystore disponible)
const SEC_KEYS = {
  ACCESS:  'sxb_access_token_v2',
  REFRESH: 'sxb_refresh_token_v2',
} as const;

async function getSecureToken(key: string): Promise<string | null> {
  try {
    if (Platform.OS !== 'web') return await SecureStore.getItemAsync(key);
    return await AsyncStorage.getItem('@' + key);
  } catch { return null; }
}

async function setSecureToken(key: string, value: string): Promise<void> {
  try {
    if (Platform.OS !== 'web') {
      await SecureStore.setItemAsync(key, value);
    } else {
      await AsyncStorage.setItem('@' + key, value);
    }
  } catch { /* ignore */ }
}

async function removeSecureToken(key: string): Promise<void> {
  try {
    if (Platform.OS !== 'web') await SecureStore.deleteItemAsync(key);
    else await AsyncStorage.removeItem('@' + key);
  } catch { /* ignore */ }
}

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: TIMEOUT,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
});

// --- Request interceptor: attach JWT ---
apiClient.interceptors.request.use(
  async (config: InternalAxiosRequestConfig) => {
    // Lecture depuis SecureStore (Keystore Android) avec fallback AsyncStorage legacy
    let token = await getSecureToken(SEC_KEYS.ACCESS);
    if (!token) token = await AsyncStorage.getItem('@sxb_access_token'); // legacy migration
    if (token && config.headers) {
      config.headers['Authorization'] = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error),
);

// --- Response interceptor: refresh on 401 ---
let isRefreshing = false;
let refreshQueue: Array<(token: string) => void> = [];

function processQueue(token: string) {
  refreshQueue.forEach((resolve) => resolve(token));
  refreshQueue = [];
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const original = error.config as InternalAxiosRequestConfig & {
      _retry?: boolean;
    };

    if (error.response?.status === 401 && !original._retry) {
      if (isRefreshing) {
        return new Promise<string>((resolve) => {
          refreshQueue.push(resolve);
        }).then((newToken) => {
          if (original.headers) {
            original.headers['Authorization'] = `Bearer ${newToken}`;
          }
          return apiClient(original);
        });
      }

      original._retry = true;
      isRefreshing = true;

      try {
        // Lire depuis SecureStore avec fallback legacy AsyncStorage
        let refreshToken = await getSecureToken(SEC_KEYS.REFRESH);
        if (!refreshToken) refreshToken = await AsyncStorage.getItem('@sxb_refresh_token');
        if (!refreshToken) throw new Error('No refresh token');

        const res = await axios.post(`${API_BASE_URL}/mobile/auth/refresh`, {
          refreshToken,
        });
        const { accessToken, refreshToken: newRefresh } = res.data;

        // Stocker dans SecureStore ET migrer depuis AsyncStorage legacy
        await Promise.all([
          setSecureToken(SEC_KEYS.ACCESS, accessToken),
          setSecureToken(SEC_KEYS.REFRESH, newRefresh),
          AsyncStorage.removeItem('@sxb_access_token').catch(() => {}),
          AsyncStorage.removeItem('@sxb_refresh_token').catch(() => {}),
        ]);

        processQueue(accessToken);
        if (original.headers) {
          original.headers['Authorization'] = `Bearer ${accessToken}`;
        }
        return apiClient(original);
      } catch (_err: any) {
        // Ne supprimer les tokens QUE si le serveur répond explicitement (erreur HTTP).
        // Une erreur réseau (pas d'internet, timeout) NE DOIT PAS effacer la session —
        // sinon chaque coupure de réseau déconnecte l'utilisateur et invalide le token.
        const isHttpError = !!_err?.response;
        if (isHttpError) {
          await Promise.all([
            removeSecureToken(SEC_KEYS.ACCESS),
            removeSecureToken(SEC_KEYS.REFRESH),
            AsyncStorage.multiRemove(['@sxb_access_token', '@sxb_refresh_token', '@sxb_user']),
          ]);
        }
        refreshQueue = [];
        return Promise.reject(error);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  },
);

// Exporter les helpers SecureStore pour que AuthContext les utilise
export { getSecureToken, setSecureToken, removeSecureToken, SEC_KEYS };
export default apiClient;


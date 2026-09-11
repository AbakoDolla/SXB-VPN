import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { getPrivacyConsent, getPrivacySignal, requireVpnConsent } from './privacyConsent';
import { accessIssueFromError, isInvalidSession } from './accessPolicy';
import { accessRequestStamp, currentIdentityRequest, publishAccessFailure } from './accessEvents';
import { requireDeviceAccess } from './accessState';

/**
 * B7 — URL de l'API.
 *
 * `EXPO_PUBLIC_API_URL` est déjà défini dans `eas.json` et dans le workflow CI,
 * mais n'était jamais lu : l'URL de production était figée dans le binaire, ce
 * qui rendait impossible tout build de recette. La valeur historique reste le
 * repli par défaut afin qu'un build sans variable produise exactement l'APK
 * actuellement distribué.
 *
 * Seules les URL HTTPS sont acceptées : une variable mal renseignée ne doit pas
 * pouvoir rétrograder silencieusement le trafic en clair.
 */
const DEFAULT_API_BASE_URL = 'https://vpnsxb.afrihall.com/api';

function resolveApiBaseUrl(): string {
  const configured = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (!configured) return DEFAULT_API_BASE_URL;
  const normalized = configured.replace(/\/+$/, '');
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?(\/|$)/i.test(normalized);
  if (!/^https:\/\//i.test(normalized) && !(__DEV__ && isLocal)) {
    return DEFAULT_API_BASE_URL;
  }
  return normalized;
}

export const API_BASE_URL = resolveApiBaseUrl();
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

type AccessRequestConfig = InternalAxiosRequestConfig & {
  _retry?: boolean;
  _sxbStamp?: ReturnType<typeof accessRequestStamp>;
  _sxbCleanupSignal?: () => void;
};

// --- Request interceptor: attach JWT ---
apiClient.interceptors.request.use(
  async (config: AccessRequestConfig) => {
    config._sxbStamp = accessRequestStamp();
    config._sxbCleanupSignal?.();
    const removingPushToken = config.method === 'delete' && config.url === '/mobile/push-tokens';
    if (!removingPushToken) {
      requireVpnConsent();
      const path = config.url?.split('?')[0];
      const identityOrControl = path === '/mobile/me' || path === '/mobile/access-state' ||
        path === '/mobile/auth/activate' || path === '/mobile/auth/refresh' ||
        // Essai gratuit : ces deux routes précèdent toute identité VPN. Elles ne
        // renvoient jamais de configuration, seulement un statut de demande.
        path === '/free-trial/enroll' || path === '/free-trial/status';
      if (!identityOrControl) requireDeviceAccess();
      if (config.url === '/mobile-health/report' && !getPrivacyConsent().diagnostics) {
        throw new Error('privacy_diagnostics_disabled');
      }
      if (config.url === '/mobile/push-tokens' && !getPrivacyConsent().notifications) {
        throw new Error('privacy_notifications_disabled');
      }
      const signal = getPrivacySignal();
      if (!config.signal) config.signal = signal;
      else {
        const controller = new AbortController();
        const requestSignal = config.signal;
        const abort = () => controller.abort();
        if (signal.aborted || requestSignal.aborted) abort();
        signal.addEventListener('abort', abort, { once: true });
        requestSignal.addEventListener?.('abort', abort, { once: true });
        config._sxbCleanupSignal = () => {
          signal.removeEventListener('abort', abort);
          requestSignal.removeEventListener?.('abort', abort);
        };
        config.signal = controller.signal;
      }
    }
    // Lecture depuis SecureStore (Keystore Android) avec fallback AsyncStorage legacy
    let token = await getSecureToken(SEC_KEYS.ACCESS);
    if (!token) token = await AsyncStorage.getItem('@sxb_access_token'); // legacy migration
    if (token && config.headers) {
      config.headers['Authorization'] = `Bearer ${token}`;
    }
    try {
      const deviceId = await AsyncStorage.getItem('@sxb_device_id');
      if (deviceId && config.headers) {
        config.headers['X-SXB-Device-ID'] = deviceId;
      }
    } catch {}
    if (!removingPushToken) requireVpnConsent();
    return config;
  },
  (error) => Promise.reject(error),
);

// --- Response interceptor: refresh on 401 ---
let isRefreshing = false;
let refreshQueue: Array<{ resolve: (token: string) => void; reject: (error: unknown) => void }> = [];

function processQueue(token: string) {
  refreshQueue.forEach(({ resolve }) => resolve(token));
  refreshQueue = [];
}

function rejectQueue(error: unknown) {
  refreshQueue.forEach(({ reject }) => reject(error));
  refreshQueue = [];
}

apiClient.interceptors.response.use(
  (response) => {
    (response.config as AccessRequestConfig)._sxbCleanupSignal?.();
    return response;
  },
  async (error: AxiosError) => {
    const original = error.config as AccessRequestConfig | undefined;
    original?._sxbCleanupSignal?.();
    const issue = accessIssueFromError(error);
    const stamp = original?._sxbStamp ?? accessRequestStamp();
    const publishFailure = (failure: unknown) => {
      const domain = accessIssueFromError(failure);
      if (domain) publishAccessFailure(domain, stamp);
      else if (isInvalidSession(failure)) {
        publishAccessFailure({ code: 'SESSION_INVALID', scope: 'session', temporary: false }, stamp);
      }
    };

    if (original && error.response?.status === 401 && !original._retry &&
        (!issue || issue.scope === 'session') && !original.url?.startsWith('/mobile/auth/')) {
      original._retry = true;
      if (isRefreshing) {
        return new Promise<string>((resolve, reject) => {
          refreshQueue.push({ resolve, reject });
        }).then((newToken) => {
          if (original.headers) {
            original.headers['Authorization'] = `Bearer ${newToken}`;
          }
          return apiClient(original);
        });
      }

      isRefreshing = true;

      try {
        // Lire depuis SecureStore avec fallback legacy AsyncStorage
        let refreshToken = await getSecureToken(SEC_KEYS.REFRESH);
        if (!refreshToken) refreshToken = await AsyncStorage.getItem('@sxb_refresh_token');
        if (!refreshToken) throw error;

        requireVpnConsent();
        const deviceId = await AsyncStorage.getItem('@sxb_device_id');
        if (!deviceId) throw new Error('AUTH_DEVICE_BINDING_REQUIRED');
        const res = await axios.post(`${API_BASE_URL}/mobile/auth/refresh`, {
          refreshToken,
        }, { signal: getPrivacySignal(), timeout: TIMEOUT, headers: { 'X-SXB-Device-ID': deviceId } });
        const { accessToken, refreshToken: newRefresh } = res.data;
        requireVpnConsent();
        if (!currentIdentityRequest(stamp)) throw new Error('AUTH_SESSION_CHANGED');
        if (typeof accessToken !== 'string' || !accessToken || typeof newRefresh !== 'string' || !newRefresh) {
          throw new Error('AUTH_REFRESH_RESPONSE_INVALID');
        }

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
        // Retrait du consentement, limitation ou panne réseau ne rendent pas
        // les identifiants invalides. Toutes les requêtes en attente reçoivent
        // cependant un rejet pour que le retrait puisse finir hors ligne.
        rejectQueue(_err);
        const invalidSession = isInvalidSession(_err) && currentIdentityRequest(stamp);
        if (invalidSession) {
          await Promise.all([
            removeSecureToken(SEC_KEYS.ACCESS),
            removeSecureToken(SEC_KEYS.REFRESH),
            AsyncStorage.multiRemove(['@sxb_access_token', '@sxb_refresh_token', '@sxb_user']),
          ]);
        }
        publishFailure(_err);
        return Promise.reject(_err);
      } finally {
        isRefreshing = false;
      }
    }

    // Session refresh failure is handled above; domain refusals never rotate tokens.
    if (!original?.url?.startsWith('/mobile/auth/')) publishFailure(error);
    return Promise.reject(error);
  },
);

// Exporter les helpers SecureStore pour que AuthContext les utilise
export { getSecureToken, setSecureToken, removeSecureToken, SEC_KEYS };
export default apiClient;

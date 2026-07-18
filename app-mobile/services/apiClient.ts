import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const API_BASE_URL = 'https://vpnsxb.afrihall.com/api';
const TIMEOUT = 15000;

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
    const token = await AsyncStorage.getItem('@sxb_access_token');
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
        const refreshToken = await AsyncStorage.getItem('@sxb_refresh_token');
        if (!refreshToken) throw new Error('No refresh token');

        const res = await axios.post(`${API_BASE_URL}/mobile/auth/refresh`, {
          refreshToken,
        });
        const { accessToken, refreshToken: newRefresh } = res.data;

        await AsyncStorage.multiSet([
          ['@sxb_access_token', accessToken],
          ['@sxb_refresh_token', newRefresh],
        ]);

        processQueue(accessToken);
        if (original.headers) {
          original.headers['Authorization'] = `Bearer ${accessToken}`;
        }
        return apiClient(original);
      } catch (_err) {
        // Refresh failed — clear session
        await AsyncStorage.multiRemove([
          '@sxb_access_token',
          '@sxb_refresh_token',
          '@sxb_user',
        ]);
        refreshQueue = [];
        return Promise.reject(error);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  },
);

export default apiClient;

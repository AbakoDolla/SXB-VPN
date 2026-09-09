import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules, Platform } from 'react-native';
import apiClient from '@/services/apiClient';
import { getPrivacyConsent, getPrivacySignal } from './privacyConsent';
import { isPlayDistribution } from './distribution';

interface SxbPushNativeModule {
  getPushToken?: () => Promise<string | null>;
  deletePushToken?: () => Promise<boolean>;
}

const REGISTERED_TOKEN_KEY = '@sxb_fcm_registered_token_v1';

export type PushRegistrationResult =
  | { status: 'registered' }
  | { status: 'unavailable' };

function nativePushModule(): SxbPushNativeModule | null {
  if (Platform.OS !== 'android') return null;
  return (NativeModules.SxbVpnNative as SxbPushNativeModule | undefined) ?? null;
}

async function readPushToken(): Promise<string | null> {
  if (!getPrivacyConsent().notifications || !getPrivacyConsent().vpn) return null;
  const nativeModule = nativePushModule();
  if (!nativeModule?.getPushToken) return null;
  const token = await nativeModule.getPushToken();
  return typeof token === 'string' && token.trim() ? token.trim() : null;
}

export async function syncPushTokenRegistration(deviceId: string): Promise<PushRegistrationResult> {
  const signal = getPrivacySignal();
  const normalizedDeviceId = deviceId.trim();
  if (!normalizedDeviceId) return { status: 'unavailable' };
  const token = await readPushToken();
  if (signal.aborted || !getPrivacyConsent().notifications || !getPrivacyConsent().vpn) return { status: 'unavailable' };
  if (!token) return { status: 'unavailable' };

  // Remember before sending so withdrawal can remove even a pending registration.
  await AsyncStorage.setItem(REGISTERED_TOKEN_KEY, token);
  if (signal.aborted) return { status: 'unavailable' };
  await apiClient.post('/mobile/push-tokens', {
    token,
    deviceId: normalizedDeviceId,
    platform: 'android',
    appVersion: Constants.expoConfig?.version ?? null,
  });
  return { status: 'registered' };
}

export async function unregisterPushToken(deviceId: string): Promise<boolean> {
  const nativeModule = nativePushModule();
  // Never create a Firebase installation just to remove its registration.
  const token = await AsyncStorage.getItem(REGISTERED_TOKEN_KEY);
  const registeredDeviceId = deviceId.trim() || (await AsyncStorage.getItem('@sxb_device_id'))?.trim() || '';
  let serverError: unknown = null;
  if (token && registeredDeviceId) {
    try {
      await apiClient.delete('/mobile/push-tokens', {
        data: { token, deviceId: registeredDeviceId },
      });
    } catch (error) {
      serverError = error;
    }
  }

  if (nativeModule?.deletePushToken && (token || isPlayDistribution)) {
    await nativeModule.deletePushToken();
  }
  if (serverError) throw serverError;
  await AsyncStorage.removeItem(REGISTERED_TOKEN_KEY);
  return token !== null;
}

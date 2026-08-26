import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface AppUpdateInfo {
  id?: string;
  versionCode: number;
  versionName: string;
  apkUrl: string;
  notes?: string;
  minSupportedCode?: number;
  forceUpdate?: boolean;
  publishedAt?: string;
}

export const APP_VERSION_URL = 'https://vpnsxb.afrihall.com/xapi/mobile/app-version';

export async function fetchLatestAppUpdate(): Promise<AppUpdateInfo | null> {
  if (Platform.OS !== 'android') return null;
  try {
    const deviceId = await AsyncStorage.getItem('@sxb_device_id');
    const response = await fetch(APP_VERSION_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(deviceId ? { 'X-SXB-Device-ID': deviceId } : {}),
      },
    });
    if (!response.ok) return null;
    const json = await response.json();
    if (typeof json?.versionCode !== 'number' || !json?.versionName || !json?.apkUrl) return null;
    if (!String(json.apkUrl).startsWith('https://')) return null;
    return {
      id: json.id ? String(json.id) : undefined,
      versionCode: json.versionCode,
      versionName: String(json.versionName),
      apkUrl: String(json.apkUrl),
      notes: json.notes ? String(json.notes) : undefined,
      minSupportedCode: Number.isInteger(json.minSupportedCode) ? json.minSupportedCode : undefined,
      forceUpdate: json.forceUpdate === true,
      publishedAt: json.publishedAt ? String(json.publishedAt) : undefined,
    };
  } catch {
    return null;
  }
}

export async function downloadAndInstallAppUpdate(
  update: AppUpdateInfo,
  onProgress?: (progress: number) => void,
  onInstallStart?: () => void,
): Promise<void> {
  if (Platform.OS !== 'android') throw new Error('android_only');
  if (!update.apkUrl.startsWith('https://')) throw new Error('invalid_update_url');

  const cacheDir = FileSystem.cacheDirectory || FileSystem.documentDirectory || '';
  const target = `${cacheDir}sxbvpn-${update.versionCode}.apk`;
  try {
    const info = await FileSystem.getInfoAsync(target);
    if (info.exists) await FileSystem.deleteAsync(target, { idempotent: true });
  } catch { /* téléchargement neuf malgré un ancien cache illisible */ }

  const task = FileSystem.createDownloadResumable(
    update.apkUrl,
    target,
    {},
    (event) => {
      const total = event.totalBytesExpectedToWrite || 1;
      onProgress?.(Math.min(1, (event.totalBytesWritten || 0) / total));
    },
  );
  const result = await task.downloadAsync();
  if (!result?.uri) throw new Error('download_no_uri');

  const contentUri = await FileSystem.getContentUriAsync(result.uri);
  onInstallStart?.();
  await IntentLauncher.startActivityAsync('android.intent.action.INSTALL_PACKAGE', {
    data: contentUri,
    type: 'application/vnd.android.package-archive',
    flags: 1,
  });
}

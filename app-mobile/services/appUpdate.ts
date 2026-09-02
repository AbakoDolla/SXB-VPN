import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import apiClient from '@/services/apiClient';
import { sha256File } from '@/modules/expo-sxb-vpn/src';

export interface AppUpdateInfo {
  id?: string;
  versionCode: number;
  versionName: string;
  apkUrl: string;
  /** Condensat SHA-256 attendu de l'APK, quand le serveur le publie. */
  apkSha256?: string;
  notes?: string;
  minSupportedCode?: number;
  forceUpdate?: boolean;
  publishedAt?: string;
}

/** Un condensat SHA-256 est exactement 64 caractères hexadécimaux. */
function normalizeSha256(value: unknown): string | undefined {
  const raw = String(value ?? '').trim().replace(/^sha256:/i, '').replace(/[:\s]/g, '');
  return /^[0-9a-f]{64}$/i.test(raw) ? raw.toLowerCase() : undefined;
}

export async function fetchLatestAppUpdate(): Promise<AppUpdateInfo | null> {
  if (Platform.OS !== 'android') return null;
  try {
    // Le mobile activé dispose déjà d’une session authentifiée et de son Device ID.
    // Le serveur filtre la publication avant de la renvoyer dans les notifications.
    const response = await apiClient.get('/mobile/notifications');
    const item = (Array.isArray(response.data) ? response.data : []).find(
      (notification: any) => notification?.appUpdate === true && notification?.actionType === 'download_app_update',
    );
    if (!item || typeof item.versionCode !== 'number' || !item.versionName || !item.downloadUrl) return null;
    if (!String(item.downloadUrl).startsWith('https://')) return null;
    return {
      id: item.id ? String(item.id) : undefined,
      versionCode: item.versionCode,
      versionName: String(item.versionName),
      apkUrl: String(item.downloadUrl),
      apkSha256: normalizeSha256(item.downloadSha256 ?? item.apkSha256),
      notes: item.notes ? String(item.notes) : undefined,
      minSupportedCode: Number.isInteger(item.minSupportedCode) ? item.minSupportedCode : undefined,
      forceUpdate: item.forceUpdate === true,
      publishedAt: item.createdAt ? String(item.createdAt) : undefined,
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

  // C6 — Contrôle d'intégrité avant de confier l'archive à l'installeur système.
  //
  // Android refuse déjà d'installer un APK dont le certificat de signature ne
  // correspond pas à celui de l'application installée, mais ce contrôle
  // n'intervient qu'après avoir écrit puis ouvert le fichier. Comparer le
  // condensat publié par le serveur détecte une archive altérée en transit
  // avant tout appel à l'installeur, et donne un message d'erreur exploitable.
  const expected = normalizeSha256(update.apkSha256);
  if (expected) {
    const actual = await sha256File(result.uri);
    if (!actual) {
      await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => undefined);
      throw new Error('integrity_unavailable');
    }
    if (actual !== expected) {
      await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => undefined);
      throw new Error('integrity_mismatch');
    }
  }

  const contentUri = await FileSystem.getContentUriAsync(result.uri);
  onInstallStart?.();
  await IntentLauncher.startActivityAsync('android.intent.action.INSTALL_PACKAGE', {
    data: contentUri,
    type: 'application/vnd.android.package-archive',
    flags: 1,
  });
}

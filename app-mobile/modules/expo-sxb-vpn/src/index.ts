import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import type { VpnState, StartVpnOptions, VpnTrafficStats } from './SxbVpn.types';
export * from './SxbVpn.types';

/**
 * B2/B3 — Pont natif unique.
 *
 * Ce module déclarait auparavant `NativeModulesProxy.SxbVpnNative`, c'est-à-dire
 * l'API Expo Modules. Or l'implémentation Android (`SxbVpnModule`) est un
 * `ReactContextBaseJavaModule` classique enregistré par `SxbVpnPackage` : le
 * proxy Expo renvoyait toujours `undefined`, si bien que chaque fonction
 * exportée ici était un no-op silencieux (le bouton de diagnostic des réglages
 * ne pilotait rien). On résout donc le module via `NativeModules`, le pont
 * effectivement utilisé par `VpnContext`, afin que les deux chemins d'accès
 * partagent la même instance.
 */
const IS_ANDROID = Platform.OS === 'android';
const SxbVpnNative = IS_ANDROID ? ((NativeModules as any).SxbVpnNative ?? null) : null;
const emitter = SxbVpnNative ? new NativeEventEmitter(SxbVpnNative) : null;

const EVENT_STATE_CHANGE = 'onVpnStateChange';
const EVENT_TRAFFIC      = 'onTrafficUpdate';
const EVENT_LOG          = 'onVpnLog';

/** Abonnement inerte, retourné lorsque le module natif est indisponible. */
const NOOP_SUBSCRIPTION = { remove: () => {} };

export function isNativeModuleAvailable(): boolean {
  return SxbVpnNative !== null;
}

export async function startVpn(options: StartVpnOptions): Promise<void> {
  if (!SxbVpnNative) throw new Error('SxbVpnModule not available on this platform');
  return SxbVpnNative.startVpn(JSON.stringify(options));
}

export async function stopVpn(): Promise<void> {
  if (!SxbVpnNative) return;
  return SxbVpnNative.stopVpn();
}

export async function getVpnState(): Promise<VpnState> {
  if (!SxbVpnNative) return 'disconnected';
  return SxbVpnNative.getVpnState();
}

export async function getTrafficStats(): Promise<VpnTrafficStats> {
  if (!SxbVpnNative) {
    return { uploadBytes: 0, downloadBytes: 0, uploadSpeed: 0, downloadSpeed: 0 };
  }
  return SxbVpnNative.getTrafficStats();
}

export async function getPerAppStats(): Promise<import('./SxbVpn.types').AppTrafficStat[]> {
  if (!SxbVpnNative) return [];
  try {
    return await SxbVpnNative.getPerAppStats();
  } catch {
    return [];
  }
}

export async function updateNotification(text: string): Promise<boolean> {
  if (!SxbVpnNative?.updateNotification) return false;
  try {
    return await SxbVpnNative.updateNotification(text);
  } catch {
    return false;
  }
}

/**
 * C6 — Condensat SHA-256 d'un fichier local, calculé en flux côté natif.
 *
 * `expo-crypto` ne sait hacher que des chaînes : hacher un APK côté JS
 * imposerait de charger plusieurs dizaines de mégaoctets en base64 en mémoire.
 * @returns le condensat hexadécimal minuscule, ou `null` si indisponible.
 */
export async function sha256File(path: string): Promise<string | null> {
  if (!SxbVpnNative?.sha256File) return null;
  try {
    const digest = await SxbVpnNative.sha256File(path);
    return typeof digest === 'string' && digest.length === 64 ? digest.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Demande la permission VPN Android.
 * Sur Android : affiche la popup système VPN si non encore accordée.
 * Sur iOS / Web : retourne toujours true (pas de permission VPN requise).
 */
export async function requestVpnPermission(): Promise<boolean> {
  if (!SxbVpnNative) return !IS_ANDROID;
  return SxbVpnNative.requestVpnPermission();
}

/**
 * Vérifie si la permission VPN est déjà accordée (synchrone).
 */
export function isVpnPermissionGranted(): boolean {
  if (!SxbVpnNative) return !IS_ANDROID;
  return SxbVpnNative.isVpnPermissionGranted() ?? false;
}

export async function setDiagnosticLogging(enabled: boolean): Promise<boolean> {
  if (!SxbVpnNative?.setDiagnosticLogging) return false;
  return Boolean(await SxbVpnNative.setDiagnosticLogging(enabled));
}

export async function getDiagnosticLogging(): Promise<boolean> {
  if (!SxbVpnNative?.getDiagnosticLogging) return false;
  return Boolean(await SxbVpnNative.getDiagnosticLogging());
}

export function addVpnStateListener(listener: (state: VpnState) => void) {
  if (!emitter) return NOOP_SUBSCRIPTION;
  return emitter.addListener(EVENT_STATE_CHANGE, listener);
}

export function addTrafficListener(listener: (stats: VpnTrafficStats) => void) {
  if (!emitter) return NOOP_SUBSCRIPTION;
  return emitter.addListener(EVENT_TRAFFIC, listener);
}

export function addLogListener(listener: (log: string) => void) {
  if (!emitter) return NOOP_SUBSCRIPTION;
  return emitter.addListener(EVENT_LOG, listener);
}

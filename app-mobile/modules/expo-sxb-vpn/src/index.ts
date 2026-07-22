import { EventEmitter, NativeModulesProxy, Platform } from 'expo-modules-core';
import type { VpnState, StartVpnOptions, VpnTrafficStats } from './SxbVpn.types';
export * from './SxbVpn.types';

const SxbVpnNative = NativeModulesProxy.SxbVpnNative;
const emitter = new EventEmitter((SxbVpnNative ?? {}) as any);

const EVENT_STATE_CHANGE = 'onVpnStateChange';
const EVENT_TRAFFIC      = 'onTrafficUpdate';
const EVENT_LOG          = 'onVpnLog';

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

/**
 * Demande la permission VPN Android.
 * Sur Android : affiche la popup système VPN si non encore accordée.
 * Sur iOS / Web : retourne toujours true (pas de permission VPN requise).
 */
export async function requestVpnPermission(): Promise<boolean> {
  if (!SxbVpnNative || Platform.OS !== 'android') return true;
  return SxbVpnNative.requestVpnPermission();
}

/**
 * Vérifie si la permission VPN est déjà accordée (synchrone).
 */
export function isVpnPermissionGranted(): boolean {
  if (!SxbVpnNative || Platform.OS !== 'android') return true;
  return SxbVpnNative.isVpnPermissionGranted() ?? false;
}

export function addVpnStateListener(listener: (state: VpnState) => void) {
  return (emitter as any).addListener(EVENT_STATE_CHANGE, listener);
}

export function addTrafficListener(listener: (stats: VpnTrafficStats) => void) {
  return (emitter as any).addListener(EVENT_TRAFFIC, listener);
}

export function addLogListener(listener: (log: string) => void) {
  return (emitter as any).addListener(EVENT_LOG, listener);
}

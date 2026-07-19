import { NativeModulesProxy, EventEmitter, Subscription } from 'expo-modules-core';

// TypeScript interface for the native module
interface SxbVpnNativeModule {
  startVpn(configJson: string): Promise<boolean>;
  stopVpn(): Promise<boolean>;
  getStatus(): string;
  isVpnPermissionGranted(): boolean;
}

const SxbVpnNative: SxbVpnNativeModule = NativeModulesProxy.SxbVpnNative;

export type VpnStatus = 'connecting' | 'connected' | 'disconnected' | 'error' | 'no_permission';

export interface VpnStatusEvent {
  status: VpnStatus;
}

export interface VpnLogEvent {
  message: string;
}

const emitter = new EventEmitter(SxbVpnNative as any);

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the VPN with a given profile configuration.
 * configJson: JSON string from the backend VPN profile
 */
export async function startVpn(configJson: string): Promise<boolean> {
  return await SxbVpnNative.startVpn(configJson);
}

/**
 * Stop the VPN and disconnect.
 */
export async function stopVpn(): Promise<boolean> {
  return await SxbVpnNative.stopVpn();
}

/**
 * Get current VPN status synchronously.
 */
export function getVpnStatus(): string {
  return SxbVpnNative.getStatus();
}

/**
 * Check if VPN permission has been granted.
 */
export function isVpnPermissionGranted(): boolean {
  return SxbVpnNative.isVpnPermissionGranted();
}

/**
 * Listen to VPN status changes.
 */
export function addVpnStatusListener(
  listener: (event: VpnStatusEvent) => void
): Subscription {
  return emitter.addListener<VpnStatusEvent>('onVpnStatusChange', listener);
}

/**
 * Listen to VPN engine logs.
 */
export function addVpnLogListener(
  listener: (event: VpnLogEvent) => void
): Subscription {
  return emitter.addListener<VpnLogEvent>('onVpnLog', listener);
}

export default {
  startVpn,
  stopVpn,
  getVpnStatus,
  isVpnPermissionGranted,
  addVpnStatusListener,
  addVpnLogListener,
};

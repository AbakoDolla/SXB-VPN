import { EventEmitter, NativeModulesProxy, Platform } from expo-modules-core;
import type { VpnState, StartVpnOptions, VpnTrafficStats } from ./SxbVpn.types;
export * from ./SxbVpn.types;

const SxbVpnNative = NativeModulesProxy.SxbVpnModule;
const emitter = new EventEmitter(SxbVpnNative ?? {});

export async function startVpn(options: StartVpnOptions): Promise<void> {
  if (!SxbVpnNative) throw new Error(SxbVpnModule not available on this platform);
  return SxbVpnNative.startVpn(JSON.stringify(options));
}

export async function stopVpn(): Promise<void> {
  if (!SxbVpnNative) return;
  return SxbVpnNative.stopVpn();
}

export async function getVpnState(): Promise<VpnState> {
  if (!SxbVpnNative) return disconnected;
  return SxbVpnNative.getVpnState();
}

export async function getTrafficStats(): Promise<VpnTrafficStats> {
  if (!SxbVpnNative) return { uploadBytes: 0, downloadBytes: 0, uploadSpeed: 0, downloadSpeed: 0 };
  return SxbVpnNative.getTrafficStats();
}

export async function requestVpnPermission(): Promise<boolean> {
  if (!SxbVpnNative || Platform.OS !== android) return true;
  return SxbVpnNative.requestVpnPermission();
}

export function addVpnStateListener(listener: (state: VpnState) => void) {
  return emitter.addListener(onVpnStateChange, listener);
}

export function addTrafficListener(listener: (stats: VpnTrafficStats) => void) {
  return emitter.addListener(onTrafficUpdate, listener);
}

export function addLogListener(listener: (log: string) => void) {
  return emitter.addListener(onVpnLog, listener);
}

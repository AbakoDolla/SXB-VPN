import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules, Platform } from 'react-native';
import { randomUUID, digestStringAsync, CryptoDigestAlgorithm } from 'expo-crypto';
import { loadLedger, isFreshLedger } from './usageLedger';

interface SecurityBridge {
  deviceSecurityIdentity?: () => Promise<string>;
  signBackendRequest?: (method: string, url: string, body: string, credential: string) => Promise<string>;
  getVpnState?: () => Promise<string>;
  getTrafficStats?: () => Promise<{ lifetimeUploadBytes: number; lifetimeDownloadBytes: number }>;
}
export interface SessionSecurity { version: 1; sessionId: string; generation: number; keyId: string; clientId: string; }
const KEY = '@sxb_session_security_v1';
const ENROLLED = '@sxb_device_proof_enrolled';
const ACTIVATION = '@sxb_security_activation_request';
const bridge = () => NativeModules.SxbVpnNative as SecurityBridge | undefined;

export async function activationSecurity(accountToken: string) {
  const module = bridge();
  if (Platform.OS !== 'android' || !module?.deviceSecurityIdentity) {
    if (await AsyncStorage.getItem(ENROLLED)) throw new Error('DEVICE_PROOF_UNAVAILABLE');
    return {};
  }
  if (!await AsyncStorage.getItem(ENROLLED)) {
    const ledger = await loadLedger();
    const state = await module.getVpnState?.();
    const counters = await module.getTrafficStats?.();
    if ((state && !['disconnected', 'error'].includes(state)) || ledger.entries.length ||
        (!isFreshLedger(ledger) && (!counters ||
          counters.lifetimeUploadBytes > ledger.counterUp || counters.lifetimeDownloadBytes > ledger.counterDown))) {
      throw new Error('DEVICE_ENROLLMENT_FLUSH_REQUIRED');
    }
  }
  const identity = JSON.parse(await module.deviceSecurityIdentity()) as { publicKey: string; keyId: string };
  const accountHash = await digestStringAsync(CryptoDigestAlgorithm.SHA256, accountToken);
  const stored = await AsyncStorage.getItem(ACTIVATION);
  const previous = stored ? JSON.parse(stored) as { accountHash: string; requestId: string } : null;
  const requestId = previous?.accountHash === accountHash ? previous.requestId : randomUUID();
  await AsyncStorage.setItem(ACTIVATION, JSON.stringify({ accountHash, requestId }));
  return { publicKey: identity.publicKey, activationRequestId: requestId };
}

export const completeActivationSecurity = () => AsyncStorage.removeItem(ACTIVATION);
export const clearSessionSecurity = () => AsyncStorage.removeItem(KEY);
export async function deviceKeyFingerprint(): Promise<string> {
  const module = bridge();
  if (!module?.deviceSecurityIdentity) throw new Error('DEVICE_PROOF_UNAVAILABLE');
  const identity = JSON.parse(await module.deviceSecurityIdentity()) as { keyId: string };
  if (!/^[a-f0-9]{64}$/.test(identity.keyId)) throw new Error('DEVICE_KEY_INVALID');
  return identity.keyId;
}

export async function saveSessionSecurity(value: unknown): Promise<void> {
  if (!value || typeof value !== 'object') {
    if (await AsyncStorage.getItem(ENROLLED)) throw new Error('DEVICE_PROOF_DOWNGRADE_REFUSED');
    return;
  }
  const security = value as SessionSecurity;
  if (security.version !== 1 || typeof security.sessionId !== 'string' ||
      !Number.isSafeInteger(security.generation) || security.generation < 1 ||
      typeof security.clientId !== 'string' || typeof security.keyId !== 'string') throw new Error('SECURITY_RESPONSE_INVALID');
  await AsyncStorage.multiSet([[KEY, JSON.stringify(security)], [ENROLLED, '1']]);
}
export async function sessionSecurity(): Promise<SessionSecurity | null> {
  const raw = await AsyncStorage.getItem(KEY);
  return raw ? JSON.parse(raw) as SessionSecurity : null;
}
export async function backendProof(method: string, url: string, body: string, credential: string) {
  const module = bridge();
  if (!credential) return {};
  if (Platform.OS !== 'android' || !module?.signBackendRequest) {
    if (await AsyncStorage.getItem(ENROLLED)) throw new Error('DEVICE_PROOF_UNAVAILABLE');
    return {};
  }
  return JSON.parse(await module.signBackendRequest(method, url, body, credential)) as Record<string, string>;
}

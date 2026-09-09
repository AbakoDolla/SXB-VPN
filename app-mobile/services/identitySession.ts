import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient, { getSecureToken, setSecureToken, removeSecureToken, SEC_KEYS } from './apiClient';
import { clearAllOfflineData } from './offlineStorage';
import { bindAccessState, clearAccessState } from './accessState';
import { accessRequestStamp, advanceAccessSession, currentIdentityRequest } from './accessEvents';
import { isInvalidSession, isRecord } from './accessPolicy';
import { requireVpnConsent } from './privacyConsent';
import type { User, AccountState } from '../types/api';

const USER_KEY = '@sxb_user';
export interface IdentitySession { user: User; accountState: AccountState | null; }
let identity: IdentitySession | null = null;
let requests = 0;
let clearing: Promise<void> | null = null;
const listeners = new Set<() => void>();
export const getIdentitySession = () => identity;
export const subscribeIdentitySession = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
function publish(next: IdentitySession | null) { identity = next; listeners.forEach(listener => listener()); }

function parseIdentity(value: unknown): IdentitySession {
  if (!isRecord(value) || !isRecord(value.user) || typeof value.user.id !== 'string' || !value.user.id ||
      typeof value.user.name !== 'string' || typeof value.user.email !== 'string') throw new Error('AUTH_RESPONSE_INVALID');
  const state = value.accountState;
  if (state !== null && state !== undefined && (!isRecord(state) || typeof state.state !== 'string' ||
      !['no_package', 'ready', 'exhausted', 'expired', 'suspended', 'revoked'].includes(state.state))) throw new Error('AUTH_RESPONSE_INVALID');
  return {
    user: { id: value.user.id, name: value.user.name, email: value.user.email },
    accountState: state ? state as unknown as AccountState : null,
  };
}

export async function restoreIdentitySession(deviceId: string): Promise<void> {
  requireVpnConsent();
  const request = ++requests;
  let accessToken = await getSecureToken(SEC_KEYS.ACCESS);
  if (!accessToken) {
    accessToken = await AsyncStorage.getItem('@sxb_access_token');
    const refresh = await AsyncStorage.getItem('@sxb_refresh_token');
    if (accessToken) await setSecureToken(SEC_KEYS.ACCESS, accessToken);
    if (refresh) await setSecureToken(SEC_KEYS.REFRESH, refresh);
    await AsyncStorage.multiRemove(['@sxb_access_token', '@sxb_refresh_token']);
  }
  const raw = await AsyncStorage.getItem(USER_KEY);
  requireVpnConsent();
  if (request !== requests || !accessToken || !raw) return;
  const cached = parseIdentity(JSON.parse(raw));
  await bindAccessState(cached.user.id, deviceId);
  if (request === requests) publish(cached);
}

export async function validateIdentitySession(deviceId: string, subscriptionId?: string | null): Promise<void> {
  requireVpnConsent();
  const request = ++requests;
  const stamp = accessRequestStamp();
  try {
    const query = subscriptionId ? `?subscriptionId=${encodeURIComponent(subscriptionId)}` : '';
    const response = await apiClient.get(`/mobile/me${query}`);
    requireVpnConsent();
    if (request !== requests || !currentIdentityRequest(stamp)) return;
    const next = parseIdentity(response.data);
    await bindAccessState(next.user.id, deviceId);
    if (request !== requests) return;
    await AsyncStorage.setItem(USER_KEY, JSON.stringify(next));
    if (request === requests) publish(next);
  } catch (error) {
    if (request === requests && currentIdentityRequest(stamp) && isInvalidSession(error)) await clearIdentitySession();
    throw error;
  }
}

export async function acceptActivatedIdentity(response: unknown, deviceId: string): Promise<void> {
  requireVpnConsent();
  if (!isRecord(response) || typeof response.accessToken !== 'string' || !response.accessToken ||
      typeof response.refreshToken !== 'string' || !response.refreshToken) throw new Error('AUTH_RESPONSE_INVALID');
  const next = parseIdentity(response);
  ++requests;
  advanceAccessSession();
  // A renewed SXB-USER code for the same identity never erases its profiles.
  if (identity && identity.user.id !== next.user.id) await clearIdentitySession();
  await bindAccessState(next.user.id, deviceId);
  await Promise.all([
    setSecureToken(SEC_KEYS.ACCESS, response.accessToken),
    setSecureToken(SEC_KEYS.REFRESH, response.refreshToken),
    AsyncStorage.setItem(USER_KEY, JSON.stringify(next)),
  ]);
  requireVpnConsent();
  publish(next);
}

export async function updateIdentityAccountState(accountState: AccountState): Promise<void> {
  if (!identity) throw new Error('AUTH_SESSION_REQUIRED');
  const next = { ...identity, accountState };
  await AsyncStorage.setItem(USER_KEY, JSON.stringify(next));
  publish(next);
}

export function clearIdentitySession(): Promise<void> {
  if (clearing) return clearing;
  ++requests;
  advanceAccessSession();
  const operation = (async () => {
    await clearAccessState(); // Native stop/barrier precedes removal of any profile.
    await Promise.all([
      removeSecureToken(SEC_KEYS.ACCESS), removeSecureToken(SEC_KEYS.REFRESH),
      AsyncStorage.multiRemove([USER_KEY, '@sxb_access_token', '@sxb_refresh_token', '@sxb_vpn_connected']),
      clearAllOfflineData(),
    ]);
    publish(null);
  })();
  clearing = operation;
  void operation.finally(() => { if (clearing === operation) clearing = null; }).catch(() => { /* Caller reports the failure. */ });
  return operation;
}

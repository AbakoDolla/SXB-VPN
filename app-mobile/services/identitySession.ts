import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient, { getSecureToken, setSecureToken, removeSecureToken, SEC_KEYS } from './apiClient';
import { clearAllOfflineData } from './offlineStorage';
import { bindAccessState, clearAccessState } from './accessState';
import { accessRequestStamp, advanceAccessSession, currentIdentityRequest } from './accessEvents';
import { isInvalidSession, isRecord } from './accessPolicy';
import { requireVpnConsent } from './privacyConsent';
import type { User, AccountState } from '../types/api';
import { saveSessionSecurity, clearSessionSecurity, completeActivationSecurity } from './deviceSecurity';
import { assertIdentityRequest, serializeIdentityPersistence, settleIdentityWrites } from './identityPersistence';

const USER_KEY = '@sxb_user';
export interface IdentitySession { user: User; accountState: AccountState | null; }
let identity: IdentitySession | null = null;
let requests = 0;
let identityVersion = 0;
let clearing: { version: number; operation: Promise<void> } | null = null;
const listeners = new Set<() => void>();
export const getIdentitySession = () => identity;
export const subscribeIdentitySession = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
function publish(next: IdentitySession | null) { identity = next; listeners.forEach(listener => listener()); }

function parseIdentity(value: unknown): IdentitySession {
  if (!isRecord(value) || !isRecord(value.user) || typeof value.user.id !== 'string' || !value.user.id ||
      typeof value.user.name !== 'string' ||
      (value.user.email != null && typeof value.user.email !== 'string')) throw new Error('AUTH_RESPONSE_INVALID');
  const state = value.accountState;
  if (state !== null && state !== undefined && (!isRecord(state) || typeof state.state !== 'string' ||
      !['no_package', 'ready', 'exhausted', 'expired', 'suspended', 'revoked'].includes(state.state))) throw new Error('AUTH_RESPONSE_INVALID');
  return {
    // Token-only mobile endpoints intentionally omit the account's e-mail.
    user: { id: value.user.id, name: value.user.name, email: value.user.email ?? '' },
    accountState: state ? state as unknown as AccountState : null,
  };
}

export async function restoreIdentitySession(deviceId: string): Promise<void> {
  requireVpnConsent();
  const request = ++requests;
  const version = identityVersion;
  return serializeIdentityPersistence(async () => {
    if (request !== requests || version !== identityVersion) return;
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
    if (request !== requests || version !== identityVersion || !accessToken || !raw) return;
    const cached = parseIdentity(JSON.parse(raw));
    await bindAccessState(cached.user.id, deviceId);
    if (request === requests && version === identityVersion) publish(cached);
  });
}

export async function validateIdentitySession(deviceId: string, subscriptionId?: string | null): Promise<void> {
  requireVpnConsent();
  const request = ++requests;
  const version = identityVersion;
  const stamp = accessRequestStamp();
  try {
    const query = subscriptionId ? `?subscriptionId=${encodeURIComponent(subscriptionId)}` : '';
    const response = await apiClient.get(`/mobile/me${query}`);
    requireVpnConsent();
    if (request !== requests || !currentIdentityRequest(stamp)) return;
    const next = parseIdentity(response.data);
    await serializeIdentityPersistence(async () => {
      if (request !== requests || version !== identityVersion || !currentIdentityRequest(stamp)) return;
      await bindAccessState(next.user.id, deviceId);
      if (request !== requests || version !== identityVersion) return;
      await AsyncStorage.setItem(USER_KEY, JSON.stringify(next));
      if (request === requests && version === identityVersion) publish(next);
    });
  } catch (error) {
    if (request !== requests || !currentIdentityRequest(stamp)) return;
    if (isInvalidSession(error)) await clearIdentitySession(true);
    throw error;
  }
}

export async function acceptActivatedIdentity(
  response: unknown, deviceId: string,
  authority?: { stamp: ReturnType<typeof accessRequestStamp>; activationRequestId?: string },
): Promise<void> {
  requireVpnConsent();
  if (!isRecord(response) || typeof response.accessToken !== 'string' || !response.accessToken ||
      typeof response.refreshToken !== 'string' || !response.refreshToken) throw new Error('AUTH_RESPONSE_INVALID');
  const next = parseIdentity(response);
  const { accessToken, refreshToken } = response;
  if (authority) assertIdentityRequest(authority.stamp);
  const version = ++identityVersion;
  ++requests;
  advanceAccessSession();
  const current = () => {
    requireVpnConsent();
    if (version !== identityVersion) throw new Error('AUTH_SESSION_CHANGED');
  };
  return serializeIdentityPersistence(async () => {
    current();
    // A renewed SXB-USER code for the same identity never erases its profiles.
    if (identity && identity.user.id !== next.user.id) {
      await clearAccessState();
      await clearStoredIdentity(false);
    }
    current();
    await bindAccessState(next.user.id, deviceId);
    current();
    await saveSessionSecurity(response.security);
    current();
    await settleIdentityWrites([
      setSecureToken(SEC_KEYS.ACCESS, accessToken),
      setSecureToken(SEC_KEYS.REFRESH, refreshToken),
      AsyncStorage.setItem(USER_KEY, JSON.stringify(next)),
    ]);
    current();
    await completeActivationSecurity(authority?.activationRequestId);
    current();
    publish(next);
  });
}

export async function updateIdentityAccountState(
  accountState: AccountState, stamp: ReturnType<typeof accessRequestStamp>,
): Promise<void> {
  if (!identity) throw new Error('AUTH_SESSION_REQUIRED');
  return serializeIdentityPersistence(async () => {
    assertIdentityRequest(stamp);
    if (!identity) throw new Error('AUTH_SESSION_REQUIRED');
    const next = { ...identity, accountState };
    await AsyncStorage.setItem(USER_KEY, JSON.stringify(next));
    assertIdentityRequest(stamp);
    publish(next);
  });
}

async function clearStoredIdentity(preserveData: boolean): Promise<void> {
  await settleIdentityWrites([
    removeSecureToken(SEC_KEYS.ACCESS), removeSecureToken(SEC_KEYS.REFRESH),
    clearSessionSecurity(),
    AsyncStorage.multiRemove([USER_KEY, '@sxb_access_token', '@sxb_refresh_token', '@sxb_vpn_connected']),
    ...(preserveData ? [] : [clearAllOfflineData()]),
  ]);
}

export function clearIdentitySession(preserveData = false): Promise<void> {
  if (clearing?.version === identityVersion) return clearing.operation;
  const version = ++identityVersion;
  ++requests;
  advanceAccessSession();
  // Stop immediately, even while an older storage operation is draining.
  const stopping = clearAccessState();
  void stopping.catch(() => { /* Awaited inside the persistence barrier below. */ });
  const operation = serializeIdentityPersistence(async () => {
    await stopping;
    await clearStoredIdentity(preserveData);
    if (version === identityVersion) publish(null);
  });
  clearing = { version, operation };
  void operation.finally(() => { if (clearing?.operation === operation) clearing = null; }).catch(() => { /* Caller reports the failure. */ });
  return operation;
}

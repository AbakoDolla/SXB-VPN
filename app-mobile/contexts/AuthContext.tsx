import React, { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import apiClient from '@/services/apiClient';
import { provisionAndStore } from '@/services/provisionClient';
import * as configStore from '@/services/configStore';
import { unregisterPushToken } from '@/services/pushNotifications';
import { normalizeActivationToken } from '@/services/activationError';
import type { AccountState, User } from '@/types/api';
import { usePrivacy } from './PrivacyContext';
import { requireVpnConsent } from '@/services/privacyConsent';
import { deviceAccess as selectDeviceAccess, type AccessNotice, type DeviceAccess } from '@/services/accessPolicy';
import { getAccessState, requireDeviceAccess, subscribeAccessState } from '@/services/accessState';
import { subscribeAccessFailures } from '@/services/accessEvents';
import { refreshAccessState, reportAccessSyncError, startAccessObservation, storeValue, wakeAccessObservation } from '@/services/accessSync';
import {
  acceptActivatedIdentity, clearIdentitySession, getIdentitySession, restoreIdentitySession,
  subscribeIdentitySession, updateIdentityAccountState, validateIdentitySession,
} from '@/services/identitySession';

const DEVICE_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const DEVICE_ID_LENGTH = 15;

/** The existing hardware binding survives renewal, logout and app updates. */
async function getOrCreateDeviceId(): Promise<string> {
  requireVpnConsent();
  const stored = await AsyncStorage.getItem('@sxb_device_id');
  if (stored) return stored;
  const bytes = new Uint8Array(DEVICE_ID_LENGTH);
  Crypto.getRandomValues(bytes);
  const id = 'SXB' + Array.from(bytes, value => DEVICE_ID_ALPHABET[value % DEVICE_ID_ALPHABET.length]).join('');
  requireVpnConsent();
  await AsyncStorage.setItem('@sxb_device_id', id);
  return id;
}

interface AuthContextType {
  isLoading: boolean;
  isAuthenticated: boolean;
  user: User | null;
  accountState: AccountState | null;
  deviceAccess: DeviceAccess | null;
  accessReady: boolean;
  accessNotices: AccessNotice[];
  hasSeenOnboarding: boolean;
  deviceId: string;
  activateAccount: (token: string) => Promise<void>;
  activatePlan: (code: string) => Promise<void>;
  refreshAccountState: (subscriptionId?: string | null) => Promise<void>;
  logout: () => Promise<void>;
  markOnboardingDone: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextType>({
  isLoading: true, isAuthenticated: false, user: null, accountState: null,
  deviceAccess: null, accessReady: false, accessNotices: [],
  hasSeenOnboarding: false, deviceId: '',
  activateAccount: async () => {}, activatePlan: async () => {}, refreshAccountState: async () => {},
  logout: async () => {}, markOnboardingDone: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { consent, loading: privacyLoading } = usePrivacy();
  const identity = useSyncExternalStore(subscribeIdentitySession, getIdentitySession);
  const access = useSyncExternalStore(subscribeAccessState, getAccessState);
  const [isLoading, setIsLoading] = useState(true);
  const [deviceId, setDeviceId] = useState('');
  const [hasSeenOnboarding, setHasSeenOnboarding] = useState(false);
  const isAuthenticated = consent.vpn && identity !== null;

  useEffect(() => {
    if (privacyLoading) return;
    if (!consent.vpn) { setIsLoading(false); return; }
    let active = true;
    setIsLoading(true);
    void (async () => {
      const id = await getOrCreateDeviceId();
      if (!active) return;
      setDeviceId(id);
      setHasSeenOnboarding(!!await AsyncStorage.getItem('@sxb_onboarding_done'));
      await restoreIdentitySession(id);
      if (active) void validateIdentitySession(id).catch(reportAccessSyncError);
    })().catch(reportAccessSyncError).finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, [consent.vpn, privacyLoading]);

  useEffect(() => {
    if (!isAuthenticated || !deviceId || !access.ready) return;
    return startAccessObservation();
  }, [isAuthenticated, deviceId, access.ready]);

  useEffect(() => subscribeAccessFailures(({ issue }) => {
    if (issue.scope === 'session') void clearIdentitySession().catch(reportAccessSyncError);
  }), []);

  const refreshAccountState = useCallback(async (subscriptionId?: string | null) => {
    if (!deviceId) return;
    await validateIdentitySession(deviceId, subscriptionId);
  }, [deviceId]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active' && isAuthenticated) {
        void refreshAccountState().catch(reportAccessSyncError);
        wakeAccessObservation();
      }
    });
    return () => subscription.remove();
  }, [isAuthenticated, refreshAccountState]);

  const activateAccount = useCallback(async (token: string) => {
    requireVpnConsent();
    const id = await getOrCreateDeviceId();
    setDeviceId(id);
    const response = await apiClient.post('/mobile/auth/activate', { token: normalizeActivationToken(token), deviceId: id });
    await acceptActivatedIdentity(response.data, id);
    // Only a server snapshot lifts a known device block, never a UI route change.
    try { await refreshAccessState(); } catch (error) { reportAccessSyncError(error); }
    wakeAccessObservation();
  }, []);

  const activatePlan = useCallback(async (code: string) => {
    requireVpnConsent();
    requireDeviceAccess();
    const normalized = normalizeActivationToken(code);
    if (normalized.startsWith('SXB-DATA-')) {
      const id = await getOrCreateDeviceId();
      const provisioned = await provisionAndStore(normalized, id);
      storeValue(await configStore.restore(provisioned.meta.subscriptionId));
      await validateIdentitySession(id, provisioned.meta.subscriptionId);
    } else {
      const response = await apiClient.post('/mobile/packages/activate', { code: normalized });
      await updateIdentityAccountState(response.data.accountState ?? response.data);
    }
    try { await refreshAccessState(); } catch (error) { reportAccessSyncError(error); }
    wakeAccessObservation();
  }, []);

  const logout = useCallback(async () => {
    // Stop immediately; optional push-token deletion cannot delay VPN shutdown.
    const stopping = clearIdentitySession();
    try { await unregisterPushToken(deviceId); } catch (error) { reportAccessSyncError(error); }
    await stopping;
  }, [deviceId]);

  const markOnboardingDone = useCallback(async () => {
    await AsyncStorage.setItem('@sxb_onboarding_done', 'true');
    setHasSeenOnboarding(true);
  }, []);

  return (
    <AuthContext.Provider value={{
      isLoading, isAuthenticated, user: identity?.user ?? null, accountState: identity?.accountState ?? null,
      deviceAccess: selectDeviceAccess(access.authority), accessReady: access.ready, accessNotices: access.notices,
      deviceId, hasSeenOnboarding, activateAccount, activatePlan, refreshAccountState, logout, markOnboardingDone,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuthContext() { return useContext(AuthContext); }

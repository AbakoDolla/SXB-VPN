import { NativeModules, Platform } from 'react-native';
import { isPlayDistribution } from './distribution';
import { NO_CONSENT, parsePrivacyConsent, type PrivacyConsent } from './privacyPolicy';

interface PrivacyNativeModule {
  distribution: string;
  getPrivacyConsent(): Promise<string>;
  setPrivacyConsent(vpn: boolean, diagnostics: boolean, notifications: boolean): Promise<string>;
}

let consent: PrivacyConsent = isPlayDistribution
  ? { ...NO_CONSENT }
  : { ...NO_CONSENT, vpn: true, diagnostics: true, notifications: true };
let generation = new AbortController();
const listeners = new Set<() => void>();

function nativePrivacy(): PrivacyNativeModule {
  const module = NativeModules.SxbVpnNative as PrivacyNativeModule | undefined;
  if (Platform.OS !== 'android' || module?.distribution !== 'play' || !module?.getPrivacyConsent || !module?.setPrivacyConsent) {
    throw new Error('privacy_native_unavailable');
  }
  return module;
}

function publish(next: PrivacyConsent) {
  generation.abort();
  generation = new AbortController();
  consent = next;
  listeners.forEach(listener => listener());
}

export const getPrivacyConsent = () => consent;
export const getPrivacySignal = () => generation.signal;
export const subscribePrivacyConsent = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export function requireVpnConsent(): void {
  if (!consent.vpn) throw new Error('privacy_consent_required');
}

export async function loadPrivacyConsent(): Promise<void> {
  if (!isPlayDistribution) return;
  publish({ ...NO_CONSENT });
  publish(parsePrivacyConsent(JSON.parse(await nativePrivacy().getPrivacyConsent())));
}

export async function savePrivacyConsent(next: PrivacyConsent): Promise<void> {
  if (!isPlayDistribution) throw new Error('privacy_play_only');
  // The native transaction first stops and joins the tunnel on withdrawal.
  // No JS state claims a successful withdrawal before that has completed.
  const result = await nativePrivacy().setPrivacyConsent(next.vpn, next.diagnostics, next.notifications);
  publish(parsePrivacyConsent(JSON.parse(result)));
}

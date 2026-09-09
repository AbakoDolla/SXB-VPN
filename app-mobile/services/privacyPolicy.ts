export const PRIVACY_CONSENT_VERSION = 1;
export interface PrivacyConsent {
  version: number;
  vpn: boolean;
  diagnostics: boolean;
  notifications: boolean;
}
export const NO_CONSENT: PrivacyConsent = {
  version: PRIVACY_CONSENT_VERSION, vpn: false, diagnostics: false, notifications: false,
};

export function parsePrivacyConsent(value: unknown): PrivacyConsent {
  if (!value || typeof value !== 'object') return { ...NO_CONSENT };
  const record = value as Record<string, unknown>;
  if (record.version !== PRIVACY_CONSENT_VERSION || record.vpn !== true) return { ...NO_CONSENT };
  return {
    version: PRIVACY_CONSENT_VERSION, vpn: true,
    diagnostics: record.diagnostics === true, notifications: record.notifications === true,
  };
}

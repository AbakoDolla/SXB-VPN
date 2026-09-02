import { apiRequest } from "./client";

export interface VpnProfile {
  id: string;
  name: string;
  description?: string;
  protocol: string;         // Protocole technique : ssh | vless | vmess | trojan | shadowsocks | singbox
  displayProtocol?: string; // Nom commercial affiché sur mobile : "MTN Protocol", "Orange Protocol"
  host: string;
  port: number;
  username?: string;
  password?: string; // always masked
  uuid?: string;
  path?: string;
  network: string;
  tls: boolean;
  sni?: string;
  dns?: string;
  payloadId?: string;
  offlineValidDays: number;
  method?: string;
  jsonConfig?: string;
  status: string;
  createdAt: string;
  updatedAt?: string | null;
  _count?: { subscriptions: number };

  // ── Modèle « intermédiaire » (import-only, canonique chiffré) ─────────────
  /** true si la config technique vient d'un import fournisseur (immuable hors réimport) */
  hasCanonicalConfig?: boolean;
  canonicalConfigHash?: string | null;
  configVersion?: number;
  sourceFormat?: string | null;
  importedAt?: string | null;
  validatedAt?: string | null;
  validationStatus?: string | null;  // transport_ok | unreachable_from_probe | invalid | unsupported | unknown
  validationMessage?: string | null;
}

// ── Préflight /api/config-test (mission §7) ───────────────────────────────────

export interface ProbeStep {
  step: string;
  ok: boolean;
  detail: string;
  latencyMs?: number;
}

export interface ConfigTestResult {
  success: boolean;
  validationStatus: 'transport_ok' | 'unreachable_from_probe' | 'invalid' | 'unsupported' | 'unknown' | string;
  parse?: { errors: string[]; warnings: string[] };
  probe?: {
    verdict: string;
    steps: ProbeStep[];
    latencyMs?: number | null;
    durationMs?: number;
    startedAt?: string;
    hint?: string | null;
  };
  error?: string;
  details?: { errors?: string[]; warnings?: string[] };
}

/** Teste une configuration en cours d'import (URI/JSON — non encore stockée). */
export const testImportedConfig = (importConfig: string): Promise<ConfigTestResult> =>
  apiRequest<ConfigTestResult>('/config-test', { method: 'POST', body: { importConfig } });

/** Teste la configuration importée d'un profil existant (stockée chiffrée). */
export const testProfileConfig = (profileId: string): Promise<ConfigTestResult> =>
  apiRequest<ConfigTestResult>('/config-test', { method: 'POST', body: { profileId } });

export interface Subscription {
  id: string;
  name: string;
  clientId: string;
  profileId: string;
  dataToken: string;
  quotaBytes: string;
  quotaUsed: string;
  durationDays: number;
  deviceLimit: number;
  startAt: string;
  expireAt: string;
  status: string;
  createdAt: string;
  client?: any;
  profile?: VpnProfile;
}

export const fetchVpnProfiles = (): Promise<VpnProfile[]> =>
  apiRequest<any>('/vpn-profiles').then(r => r.profiles);

export const fetchVpnProfile = (id: string): Promise<VpnProfile> =>
  apiRequest<any>(`/vpn-profiles/${id}`).then(r => r.profile);

/**
 * Crée un profil VPN.
 *
 * Retourne aussi les avertissements du serveur (doublon de configuration,
 * particularités de parsing). Ils étaient jusqu'ici écartés par `.then(r =>
 * r.profile)` : un import strictement identique à un profil existant passait
 * donc totalement inaperçu.
 */
export const createVpnProfile = (data: Partial<VpnProfile>): Promise<VpnProfile & { _warnings?: string[] }> =>
  apiRequest<any>('/vpn-profiles', { method: 'POST', body: data })
    .then(r => ({ ...r.profile, _warnings: r.warnings || [] }));

export const updateVpnProfile = (id: string, data: Partial<VpnProfile>): Promise<VpnProfile> =>
  apiRequest<any>(`/vpn-profiles/${id}`, { method: 'PUT', body: data }).then(r => r.profile);

export const deleteVpnProfile = (id: string): Promise<void> =>
  apiRequest<any>(`/vpn-profiles/${id}`, { method: 'DELETE' });

export const fetchVpnProfileStats = (): Promise<{ total: number; active: number; byProtocol: any[] }> =>
  apiRequest<any>('/vpn-profiles/stats/all').then(r => r);

export const fetchSubscriptions = (): Promise<Subscription[]> =>
  apiRequest<any>('/subscriptions').then(r => r.subscriptions);

export const createSubscription = (data: {
  clientId: string; profileId: string; name?: string;
  quotaGB: number; durationDays: number; deviceLimit?: number; deviceId?: string;
}): Promise<Subscription> =>
  apiRequest<any>('/subscriptions', { method: 'POST', body: data }).then(r => r.subscription);

export const updateSubscription = (id: string, data: any): Promise<Subscription> =>
  apiRequest<any>(`/subscriptions/${id}`, { method: 'PUT', body: data }).then(r => r.subscription);

export const deleteSubscription = (id: string): Promise<void> =>
  apiRequest<any>(`/subscriptions/${id}`, { method: 'DELETE' });

export const revokeSubscription = (id: string, reason?: string): Promise<void> =>
  apiRequest<any>(`/subscriptions/${id}/revoke`, { method: 'POST', body: { reason } });

export interface UnifiedConfig {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number;
  sourceType: string;
  status: string;
}

export const fetchUnifiedConfigs = (): Promise<UnifiedConfig[]> =>
  apiRequest<any>("/vpn-profiles/unified").then(r => r.configs || []);

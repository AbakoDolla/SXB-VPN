import { apiRequest } from "./client";

export type SecuritySeverity = "critical" | "warning" | "info" | string;

export interface SecurityPasskey {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface SecurityGateState {
  configured: boolean;
  canConfigure: boolean;
  unlocked: boolean;
  unlockExpiresAt: string | null;
  passkeyVerified: boolean;
  passkeyRequired: boolean;
  passkeys: SecurityPasskey[];
  rpId: string;
  unlockSeconds: number;
  updatedAt: string | null;
}

export interface SecurityChallenge {
  challengeId: string;
  challenge: string;
  rpId: string;
  timeoutMs: number;
  algorithms: number[];
  /**
   * Empreintes enrôlées que le navigateur est autorisé à présenter.
   *
   * Servi uniquement à la vérification, après un mot de passe valide : une clé
   * de plateforme non découvrable ne se retrouve que par son identifiant.
   */
  allowCredentials?: string[];
}

export interface SecurityUnlockPasskeyStep extends SecurityChallenge {
  step: "passkey";
}

export interface SecurityUnlockedStep {
  step: "unlocked";
  unlockToken: string;
  expiresAt: string;
  passkeyVerified: boolean;
}

export type SecurityUnlockResponse = SecurityUnlockPasskeyStep | SecurityUnlockedStep;

export interface SecurityOverview {
  total: number;
  critical: number;
  warning: number;
  info: number;
  unacknowledged: number;
  last24h: number;
  latestAt: string | null;
}

export interface SecurityOverviewResponse {
  overview: SecurityOverview;
  severities: string[];
  eventTypes: string[];
}

export interface SecurityEvent {
  id: string;
  eventType: string;
  severity: SecuritySeverity;
  userId: string | null;
  deviceId: string | null;
  ipHash: string | null;
  appVersion: string | null;
  actionTaken: string | null;
  metadata: string | null;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  createdAt: string;
  sessionId: string | null;
  sessionGeneration: number | null;
  connectionId: string | null;
  policyVersion: number | null;
  riskLevel: string | null;
}

export interface SecurityEventsQuery {
  userId?: string;
  deviceId?: string;
  sessionId?: string;
  from?: string;
  to?: string;
  severity?: string;
  eventType?: string;
  acknowledged?: "true" | "false" | "";
  limit?: number;
  offset?: number;
  riskLevel?: string;
  search?: string;
}

export interface SecurityEventsResponse {
  events: SecurityEvent[];
  total: number;
  limit: number;
  offset: number;
}

export interface SecurityAuditEntry {
  id: string;
  action: string;
  type: string;
  timestamp: string;
  user: { name: string | null; email: string | null } | null;
  ipAddress?: string | null;
  visibleOwnerOnly?: boolean;
}

export interface SecurityAuditResponse {
  entries: SecurityAuditEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface SecuritySession {
  id: string;
  clientId: string;
  deviceId: string;
  activationDate: string;
  lastSync: string;
  authGeneration: number;
  authExpiresAt: string | null;
  authRevokedAt: string | null;
  ipAddress: string | null;
  state: "active" | "revoked" | "expired" | "legacy";
  client: {
    deviceKeyId: string | null;
    enrollmentGrantExpiresAt: string | null;
    user: { id: string; name: string };
  };
}

export interface SecuritySessionsResponse {
  sessions: SecuritySession[];
  total: number;
  limit: number;
  offset: number;
}

export interface SecurityAuditQuery {
  limit?: number;
  offset?: number;
  search?: string;
  type?: string;
  ownerOnly?: "true" | "false" | "";
}

function queryString(query: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  });
  return params.toString();
}

const unlockHeaders = (unlockToken?: string): Record<string, string> =>
  unlockToken ? { "X-SXB-Security-Unlock": unlockToken } : {};

export const fetchSecurityGate = (): Promise<SecurityGateState> =>
  apiRequest<SecurityGateState>("/security/gate");

export const setSecurityGatePassword = (data: { currentPassword?: string; newPassword: string }): Promise<{ configured: boolean; updatedAt: string }> =>
  apiRequest<{ configured: boolean; updatedAt: string }>("/security/gate/password", { method: "POST", body: data });

export const unlockSecurityGate = (password: string): Promise<SecurityUnlockResponse> =>
  apiRequest<SecurityUnlockResponse>("/security/gate/unlock", { method: "POST", body: { password } });

/**
 * Voie de secours du propriétaire : retire ses empreintes au seul mot de passe.
 *
 * Elle existe parce que retirer une empreinte exigeait une console ouverte, que
 * seule l'empreinte permettait d'ouvrir : une empreinte devenue inutilisable
 * enfermait le propriétaire dehors définitivement.
 */
export const resetSecurityPasskeys = (password: string): Promise<{ success: boolean; removed: number }> =>
  apiRequest<{ success: boolean; removed: number }>("/security/gate/passkeys/reset", { method: "POST", body: { password } });

export const unlockSecurityGateWithPasskey = (data: {
  challengeId: string;
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}): Promise<SecurityUnlockedStep> =>
  apiRequest<SecurityUnlockedStep>("/security/gate/unlock/passkey", { method: "POST", body: data });

export const createSecurityPasskeyChallenge = (unlockToken: string): Promise<SecurityChallenge> =>
  apiRequest<SecurityChallenge>("/security/passkeys/challenge", { method: "POST", headers: unlockHeaders(unlockToken) });

export const createSecurityPasskey = (
  unlockToken: string,
  data: {
    challengeId: string;
    credentialId: string;
    publicKey: string;
    algorithm: number;
    clientDataJSON: string;
    signCount?: number;
    label?: string;
  },
): Promise<{ passkey: SecurityPasskey }> =>
  apiRequest<{ passkey: SecurityPasskey }>("/security/passkeys", { method: "POST", body: data, headers: unlockHeaders(unlockToken) });

export const deleteSecurityPasskey = (unlockToken: string, id: string): Promise<{ success: true }> =>
  apiRequest<{ success: true }>(`/security/passkeys/${encodeURIComponent(id)}`, { method: "DELETE", headers: unlockHeaders(unlockToken) });

export const fetchSecurityOverview = (unlockToken: string): Promise<SecurityOverviewResponse> =>
  apiRequest<SecurityOverviewResponse>("/security/overview", { headers: unlockHeaders(unlockToken) });

export const fetchSecurityEvents = (unlockToken: string, query: SecurityEventsQuery = {}): Promise<SecurityEventsResponse> => {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  });
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<SecurityEventsResponse>(`/security/events${suffix}`, { headers: unlockHeaders(unlockToken) });
};

export const acknowledgeSecurityEvents = (unlockToken: string, ids: string[], acknowledged = true): Promise<{ acknowledged: number }> =>
  apiRequest<{ acknowledged: number }>("/security/events/acknowledge", { method: "POST", body: { ids, acknowledged }, headers: unlockHeaders(unlockToken) });

export const fetchSecurityAudit = (unlockToken: string, query: SecurityAuditQuery | number = {}): Promise<SecurityAuditResponse> =>
  apiRequest<SecurityAuditResponse>(`/security/audit?${queryString(typeof query === "number" ? { limit: query } : { ...query })}`, { headers: unlockHeaders(unlockToken) });

export const fetchSecuritySessions = (token: string, query: { search?: string; state?: string; offset?: number; limit?: number }) =>
  apiRequest<SecuritySessionsResponse>(`/security/sessions?${queryString(query)}`, { headers: unlockHeaders(token) });

export interface SecurityPolicy {
  version: number;
  medium: number;
  high: number;
  weights: Record<string, number>;
  certificates: string[];
  packageName: 'com.sxbvpn.mobile';
}
export const fetchSecurityPolicy = (token: string) =>
  apiRequest<SecurityPolicy>('/security/policy', { headers: unlockHeaders(token) });
export const updateSecurityPolicy = (token: string, policy: SecurityPolicy) =>
  apiRequest<SecurityPolicy>('/security/policy', { method: 'PUT', body: policy, headers: unlockHeaders(token) });
export const authorizeDeviceKey = (token: string, clientId: string, keyId: string, replaceExisting: boolean) =>
  apiRequest<{ authorized: boolean; expiresInSeconds: number }>(`/security/devices/${encodeURIComponent(clientId)}/authorize-key`, {
    method: 'POST', body: { keyId, replaceExisting }, headers: unlockHeaders(token),
  });
export const revokeSecuritySession = (token: string, id: string, generation: number) =>
  apiRequest<{ revoked: boolean }>(`/security/sessions/${encodeURIComponent(id)}/revoke`, {
    method: 'POST', body: { generation }, headers: unlockHeaders(token),
  });

export interface RootDevice {
  keyId: string;
  status: 'pending' | 'approved' | 'denied';
  revision: number;
  deviceModel: string | null;
  appVersion: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  decidedAt: string | null;
  client: { id: string; deviceId: string | null; user: { name: string } } | null;
}
export interface RootDevicesPage {
  devices: RootDevice[];
  total: number;
  limit: number;
  offset: number;
  offlineHours: number;
  canApproveUnassigned: boolean;
}
export const fetchRootDevices = (token: string, query: { status?: string; search?: string; limit?: number; offset?: number }) =>
  apiRequest<RootDevicesPage>(`/security/root-devices?${queryString(query)}`, { headers: unlockHeaders(token) });
export const decideRootDevice = (token: string, device: RootDevice, status: 'approved' | 'denied') =>
  apiRequest<{ keyId: string; status: string; revision: number }>(`/security/root-devices/${device.keyId}/decision`, {
    method: 'POST', body: { status, revision: device.revision }, headers: unlockHeaders(token),
  });

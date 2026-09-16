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
}

export interface SecurityEventsQuery {
  severity?: string;
  eventType?: string;
  acknowledged?: "true" | "false" | "";
  limit?: number;
  offset?: number;
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
}

export interface SecurityAuditResponse {
  entries: SecurityAuditEntry[];
  total: number;
  limit: number;
}

const unlockHeaders = (unlockToken?: string): Record<string, string> =>
  unlockToken ? { "X-SXB-Security-Unlock": unlockToken } : {};

export const fetchSecurityGate = (): Promise<SecurityGateState> =>
  apiRequest<SecurityGateState>("/security/gate");

export const setSecurityGatePassword = (data: { currentPassword?: string; newPassword: string }): Promise<{ configured: boolean; updatedAt: string }> =>
  apiRequest<{ configured: boolean; updatedAt: string }>("/security/gate/password", { method: "POST", body: data });

export const unlockSecurityGate = (password: string): Promise<SecurityUnlockResponse> =>
  apiRequest<SecurityUnlockResponse>("/security/gate/unlock", { method: "POST", body: { password } });

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

export const acknowledgeSecurityEvents = (unlockToken: string, ids: string[]): Promise<{ acknowledged: number }> =>
  apiRequest<{ acknowledged: number }>("/security/events/acknowledge", { method: "POST", body: { ids }, headers: unlockHeaders(unlockToken) });

export const fetchSecurityAudit = (unlockToken: string, limit = 50): Promise<SecurityAuditResponse> =>
  apiRequest<SecurityAuditResponse>(`/security/audit?limit=${encodeURIComponent(String(limit))}`, { headers: unlockHeaders(unlockToken) });

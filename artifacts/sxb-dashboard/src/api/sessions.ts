import { apiRequest } from "./client";

export interface ActivationSession {
  id: string;
  clientId: string;
  clientName: string;
  clientToken: string;
  deviceId: string;
  activationDate: string;
  expirationDate: string | null;
  lastSync: string;
  status: "active" | "revoked" | "expired";
  authGeneration?: number;
  authRevokedAt?: string | null;
  canRevokeSecurity?: boolean;
  ipAddress: string | null;
  userAgent: string | null;
}

export async function fetchSessions(): Promise<ActivationSession[]> {
    const data = await apiRequest<{ sessions: ActivationSession[] }>("/sessions");
    if (!Array.isArray(data.sessions)) throw new Error("INVALID_SESSIONS_RESPONSE");
    return data.sessions;
}

export interface SessionSecurityEvent {
  id: string; eventType: string; severity: string; createdAt: string; sessionGeneration: number | null;
  connectionId: string | null; riskLevel: string | null; actionTaken: string | null; acknowledged: boolean;
}
export const fetchSessionSecurityEvents = (id: string, offset = 0) =>
  apiRequest<{ events: SessionSecurityEvent[]; total: number }>(`/sessions/${encodeURIComponent(id)}/security-events?offset=${offset}`);
export const revokeSessionGeneration = (id: string, generation: number) =>
  apiRequest<{ revoked: boolean }>(`/sessions/${encodeURIComponent(id)}/security-revoke`, { method: "POST", body: { generation } });

export async function revokeSession(id: string): Promise<void> {
  await apiRequest(`/sessions/${id}/revoke`, { method: "POST" });
}

export async function resetSession(id: string): Promise<void> {
  await apiRequest(`/sessions/${id}/reset`, { method: "POST" });
}

export async function deleteSession(id: string): Promise<void> {
  await apiRequest(`/sessions/${id}`, { method: "DELETE" });
}

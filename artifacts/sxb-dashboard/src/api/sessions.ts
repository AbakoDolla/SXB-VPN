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
  ipAddress: string | null;
  userAgent: string | null;
}

export async function fetchSessions(): Promise<ActivationSession[]> {
  try {
    const data = await apiRequest<{ sessions: ActivationSession[] }>("/sessions");
    return data.sessions || [];
  } catch (err) {
    console.error("Error fetching sessions:", err);
    return [];
  }
}

export async function revokeSession(id: string): Promise<void> {
  await apiRequest(`/sessions/${id}/revoke`, { method: "POST" });
}

export async function resetSession(id: string): Promise<void> {
  await apiRequest(`/sessions/${id}/reset`, { method: "POST" });
}

export async function deleteSession(id: string): Promise<void> {
  await apiRequest(`/sessions/${id}`, { method: "DELETE" });
}

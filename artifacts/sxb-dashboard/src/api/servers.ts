import { VPSServer } from "../types";
import { apiRequest } from "./client";
import { listeDepuis } from "./liste";

export async function fetchServers(): Promise<VPSServer[]> {
  try {
    // `/api/servers` renvoie un tableau NU, pas `{ servers: [...] }` : lire la
    // seule forme enveloppée rendait les quatre nœuds existants invisibles.
    return listeDepuis<VPSServer>(await apiRequest<unknown>("/servers"), "servers");
  } catch (error) {
    console.error("Error fetching servers:", error);
    return [];
  }
}

export async function fetchServerById(id: string): Promise<VPSServer | null> {
  try {
    return await apiRequest<VPSServer>(`/servers/${id}`);
  } catch (error) {
    console.error("Error fetching server:", error);
    return null;
  }
}

export async function createServer(serverData: {
  name: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  sshKey?: string;
  location?: string;
  ip?: string;
  status?: "online" | "offline";
}): Promise<VPSServer> {
  return await apiRequest<VPSServer>("/servers", {
    method: "POST",
    body: serverData,
  });
}

export async function updateServer(id: string, updates: Partial<VPSServer>): Promise<VPSServer> {
  return await apiRequest<VPSServer>(`/servers/${id}`, {
    method: "PATCH",
    body: updates,
  });
}

export async function deleteServer(id: string): Promise<void> {
  await apiRequest(`/servers/${id}`, { method: "DELETE" });
}

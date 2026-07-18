import { VPSServer } from "../types";
import { apiRequest } from "./client";

export async function fetchServers(): Promise<VPSServer[]> {
  try {
    const data = await apiRequest<{ servers: VPSServer[] }>("/servers");
    return data.servers || [];
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
  host: string;
  port: number;
  username: string;
  password?: string;
  sshKey?: string;
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

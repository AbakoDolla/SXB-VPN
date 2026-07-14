import { VPSServer } from "../types";
import { getServers, saveServers, getCurrentUser, logActivity } from "./db";

export async function fetchServers(): Promise<VPSServer[]> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(getServers());
    }, 200);
  });
}

export async function fetchServerById(id: string): Promise<VPSServer | null> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const servers = getServers();
      const server = servers.find((s) => s.id === id) || null;
      resolve(server);
    }, 150);
  });
}

export async function createServer(serverData: Omit<VPSServer, "id" | "cpuLoad" | "ramLoad" | "activeUsers">): Promise<VPSServer> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const servers = getServers();
      const newServer: VPSServer = {
        ...serverData,
        id: `server-${Date.now()}`,
        cpuLoad: 0,
        ramLoad: 0,
        activeUsers: 0,
      };
      
      saveServers([...servers, newServer]);
      const actor = getCurrentUser().name;
      logActivity(`Ajout du serveur VPS: ${newServer.name}`, actor, "success");
      resolve(newServer);
    }, 300);
  });
}

export async function updateServer(id: string, updates: Partial<VPSServer>): Promise<VPSServer> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const servers = getServers();
      const index = servers.findIndex((s) => s.id === id);
      if (index === -1) return reject(new Error("Serveur non trouvé"));
      
      const updated = { ...servers[index], ...updates };
      servers[index] = updated;
      saveServers(servers);
      
      const actor = getCurrentUser().name;
      logActivity(`Modification du serveur VPS: ${updated.name}`, actor, "info");
      resolve(updated);
    }, 200);
  });
}

export async function deleteServer(id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const servers = getServers();
      const serverToDelete = servers.find((s) => s.id === id);
      if (!serverToDelete) return reject(new Error("Serveur non trouvé"));
      
      saveServers(servers.filter((s) => s.id !== id));
      const actor = getCurrentUser().name;
      logActivity(`Suppression du serveur VPS: ${serverToDelete.name}`, actor, "danger");
      resolve();
    }, 200);
  });
}

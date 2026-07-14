import { Client } from "../types";
import { getClients, saveClients, getCurrentUser, logActivity } from "./db";

export async function fetchClients(): Promise<Client[]> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(getClients());
    }, 250);
  });
}

export async function fetchClientById(id: string): Promise<Client | null> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const clients = getClients();
      const client = clients.find((c) => c.id === id) || null;
      resolve(client);
    }, 200);
  });
}

export async function createClient(clientData: Omit<Client, "id" | "consumption">): Promise<Client> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const clients = getClients();
      const newClient: Client = {
        ...clientData,
        id: `client-${Date.now()}`,
        consumption: 0, // Starts at 0 GB as requested
      };
      
      saveClients([...clients, newClient]);
      const actor = getCurrentUser().name;
      logActivity(`Création du client VPN: ${newClient.name}`, actor, "success");
      resolve(newClient);
    }, 300);
  });
}

export async function updateClient(id: string, updates: Partial<Client>): Promise<Client> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const clients = getClients();
      const index = clients.findIndex((c) => c.id === id);
      if (index === -1) {
        return reject(new Error("Client non trouvé"));
      }
      
      const updated = { ...clients[index], ...updates };
      clients[index] = updated;
      saveClients(clients);
      
      const actor = getCurrentUser().name;
      logActivity(`Modification du client VPN: ${updated.name}`, actor, "info");
      resolve(updated);
    }, 250);
  });
}

export async function deleteClient(id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const clients = getClients();
      const clientToDelete = clients.find((c) => c.id === id);
      if (!clientToDelete) {
        return reject(new Error("Client non trouvé"));
      }
      
      saveClients(clients.filter((c) => c.id !== id));
      const actor = getCurrentUser().name;
      logActivity(`Suppression du client VPN: ${clientToDelete.name}`, actor, "danger");
      resolve();
    }, 200);
  });
}

export async function suspendClient(id: string): Promise<Client> {
  return updateClient(id, { status: "suspended" });
}

export async function activateClient(id: string): Promise<Client> {
  return updateClient(id, { status: "active" });
}

export async function renewClient(id: string): Promise<Client> {
  const clients = getClients();
  const client = clients.find((c) => c.id === id);
  if (!client) throw new Error("Client non trouvé");
  
  // Extend expiration by 30 days
  const currentExpiry = new Date(client.expiration);
  const newExpiry = new Date(currentExpiry.getTime() + 30 * 24 * 60 * 60 * 1000);
  
  return updateClient(id, { 
    expiration: newExpiry.toISOString(), 
    status: "active" 
  });
}

export async function resetClientAccess(id: string): Promise<Client> {
  // Generates a brand new random secure UUID token for Sing-box / XPanel
  const newToken = `sxb-usr-${Math.random().toString(36).substring(2, 10)}-${Math.random().toString(36).substring(2, 10)}`;
  return updateClient(id, { token: newToken });
}

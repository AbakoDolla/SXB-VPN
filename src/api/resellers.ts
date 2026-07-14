import { Reseller, Client } from "../types";
import { getResellers, saveResellers, getClients, saveClients, getCurrentUser, logActivity } from "./db";

export async function fetchResellers(): Promise<Reseller[]> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(getResellers());
    }, 250);
  });
}

export async function fetchResellerById(id: string): Promise<Reseller | null> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const resellers = getResellers();
      const reseller = resellers.find((r) => r.id === id) || null;
      resolve(reseller);
    }, 200);
  });
}

export async function createReseller(data: Omit<Reseller, "id" | "clientsCount" | "createdAt">): Promise<Reseller> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const resellers = getResellers();
      const newReseller: Reseller = {
        ...data,
        id: `reseller-${Date.now()}`,
        clientsCount: 0,
        createdAt: new Date().toISOString(),
      };
      saveResellers([...resellers, newReseller]);
      
      const actor = getCurrentUser().name;
      logActivity(`Création du revendeur: ${newReseller.name}`, actor, "success");
      resolve(newReseller);
    }, 300);
  });
}

export async function updateReseller(id: string, updates: Partial<Reseller>): Promise<Reseller> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const resellers = getResellers();
      const index = resellers.findIndex((r) => r.id === id);
      if (index === -1) return reject(new Error("Revendeur non trouvé"));
      
      const updated = { ...resellers[index], ...updates };
      resellers[index] = updated;
      saveResellers(resellers);
      
      const actor = getCurrentUser().name;
      logActivity(`Mise à jour du revendeur: ${updated.name}`, actor, "info");
      resolve(updated);
    }, 250);
  });
}

export async function fetchResellerClients(resellerId: string): Promise<Client[]> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const clients = getClients();
      resolve(clients.filter((c) => c.resellerId === resellerId));
    }, 200);
  });
}

export async function addClientToReseller(resellerId: string, clientData: Omit<Client, "id" | "consumption" | "resellerId">): Promise<Client> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const resellers = getResellers();
      const resellerIndex = resellers.findIndex((r) => r.id === resellerId);
      if (resellerIndex === -1) return reject(new Error("Revendeur non trouvé"));
      
      const reseller = resellers[resellerIndex];
      if (reseller.balance < clientData.quotaTotal) {
        return reject(new Error("Solde de crédits insuffisant pour allouer ce quota"));
      }

      // Deduct quota from reseller balance
      reseller.balance -= clientData.quotaTotal;
      reseller.clientsCount += 1;
      resellers[resellerIndex] = reseller;
      saveResellers(resellers);

      // Create new client
      const clients = getClients();
      const newClient: Client = {
        ...clientData,
        id: `client-${Date.now()}`,
        consumption: 0,
        resellerId,
      };
      saveClients([...clients, newClient]);

      const actor = getCurrentUser().name;
      logActivity(`Revendeur [${reseller.name}] a créé un client: ${newClient.name}`, actor, "success");
      resolve(newClient);
    }, 350);
  });
}

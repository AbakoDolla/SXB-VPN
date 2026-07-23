import { Client } from "../types";
import { apiRequest } from "./client";

export async function fetchClients(): Promise<Client[]> {
  try {
    // Backend returns a direct array (not { clients: [] })
    const data = await apiRequest<Client[] | { clients: Client[] }>("/clients");
    if (Array.isArray(data)) return data;
    return (data as any).clients || [];
  } catch (error) {
    console.error("Error fetching clients:", error);
    return [];
  }
}

export async function fetchClientById(id: string): Promise<Client | null> {
  try {
    return await apiRequest<Client>(`/clients/${id}`);
  } catch (error) {
    console.error("Error fetching client:", error);
    return null;
  }
}

export async function createClient(clientData: { name: string; email?: string; phone?: string; userId?: string }): Promise<Client> {
  return await apiRequest<Client>("/clients", {
    method: "POST",
    body: clientData,
  });
}

export async function updateClient(id: string, updates: Partial<Client>): Promise<Client> {
  return await apiRequest<Client>(`/clients/${id}`, {
    method: "PATCH",
    body: updates,
  });
}

export async function deleteClient(id: string): Promise<void> {
  await apiRequest(`/clients/${id}`, { method: "DELETE" });
}

export async function suspendClient(id: string): Promise<Client> {
  return await apiRequest<Client>(`/clients/${id}/suspend`, { method: "POST" });
}

export async function activateClient(id: string): Promise<Client> {
  return updateClient(id, { status: "active" });
}

export async function renewClient(id: string): Promise<Client> {
  return updateClient(id, { status: "active" });
}

export async function resetClientAccess(id: string): Promise<Client> {
  return await apiRequest<Client>(`/clients/${id}/reset-token`, { method: "POST" });
}

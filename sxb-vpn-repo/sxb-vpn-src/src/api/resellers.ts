import { Reseller, Client } from "../types";
import { apiRequest } from "./client";

export async function fetchResellers(): Promise<Reseller[]> {
  try {
    const data = await apiRequest<{ resellers: Reseller[] }>("/resellers");
    return data.resellers || [];
  } catch (error) {
    console.error("Error fetching resellers:", error);
    return [];
  }
}

export async function fetchResellerById(id: string): Promise<Reseller | null> {
  try {
    return await apiRequest<Reseller>(`/resellers/${id}`);
  } catch (error) {
    console.error("Error fetching reseller:", error);
    return null;
  }
}

export async function createReseller(data: {
  name: string;
  email: string;
  phone?: string;
}): Promise<Reseller> {
  return await apiRequest<Reseller>("/resellers", {
    method: "POST",
    body: data,
  });
}

export async function updateReseller(id: string, updates: Partial<Reseller>): Promise<Reseller> {
  return await apiRequest<Reseller>(`/resellers/${id}`, {
    method: "PATCH",
    body: updates,
  });
}

export async function deleteReseller(id: string): Promise<void> {
  await apiRequest(`/resellers/${id}`, { method: "DELETE" });
}

export async function fetchResellerClients(resellerId: string): Promise<Client[]> {
  try {
    const data = await apiRequest<{ clients: Client[] }>(`/resellers/${resellerId}/clients`);
    return data.clients || [];
  } catch (error) {
    console.error("Error fetching reseller clients:", error);
    return [];
  }
}

import {
  Reseller,
  Client,
  ResellerQuotaMovement,
  ResellerReconciliation,
  ResellerAccessSummary,
} from "../types";
import { apiRequest } from "./client";

export async function fetchResellers(): Promise<Reseller[]> {
    const data = await apiRequest<{ resellers: Reseller[] }>("/resellers");
    return data.resellers || [];
}

export async function fetchMyResellerAccess(): Promise<ResellerAccessSummary | null> {
  const data = await apiRequest<{ resellerAccess: ResellerAccessSummary | null }>("/resellers/me/access");
  return data.resellerAccess ?? null;
}

export async function fetchResellerById(id: string): Promise<Reseller | null> {
  try {
    return await apiRequest<Reseller>(`/resellers/${id}`);
  } catch (error) {
    console.error("Error fetching reseller:", error);
    return null;
  }
}

/**
 * Création d'un revendeur — FLUX CANONIQUE UNIQUE.
 *
 * Le compte de connexion, le rôle RESELLER et la fiche commerciale naissent
 * dans la même transaction serveur. Passer par la création de compte générique
 * produisait des comptes portant le rôle sans fiche en face : la production en
 * compte 70 pour 6 revendeurs réels.
 *
 * `accessExpiresAt` est OBLIGATOIRE et doit être une date ISO future : un
 * agrément sans échéance est un agrément perpétuel accordé par inadvertance.
 * `quotaGB` négatif = plafond levé explicitement ; 0 = aucun volume attribué,
 * ce qui n'est PAS la même chose.
 */
export async function createReseller(data: {
  name: string;
  email: string;
  phone?: string;
  quotaGB: number;
  status?: "active" | "suspended";
  commission?: number;
  accessExpiresAt: string;
}): Promise<Reseller> {
  return await apiRequest<Reseller>("/resellers", {
    method: "POST",
    body: data,
  });
}

export async function updateReseller(
  id: string,
  updates: Partial<Reseller> & {
    quotaGB?: number;
    accessExpiresAt?: string;
    reason?: string;
    correction?: boolean;
  }
): Promise<Reseller> {
  return await apiRequest<Reseller>(`/resellers/${id}`, {
    method: "PATCH",
    body: updates,
  });
}

/**
 * Renouvellement / report de l'échéance d'accès.
 * Réservé aux rôles qui administrent les revendeurs ; la date doit être future.
 */
export async function renewResellerAccess(id: string, accessExpiresAt: string): Promise<Reseller> {
  return await apiRequest<Reseller>(`/resellers/${id}`, {
    method: "PATCH",
    body: { accessExpiresAt },
  });
}

export async function setResellerStatus(id: string, status: "active" | "suspended"): Promise<Reseller> {
  return await apiRequest<Reseller>(`/resellers/${id}`, {
    method: "PATCH",
    body: { status },
  });
}

export async function fetchResellerQuotaHistory(resellerId?: string): Promise<ResellerQuotaMovement[]> {
  const suffix = resellerId ? `?resellerId=${encodeURIComponent(resellerId)}` : "";
  const data = await apiRequest<{ movements: ResellerQuotaMovement[] }>(`/resellers/quota-history${suffix}`);
  return data.movements || [];
}

/**
 * Rapport de réconciliation, LECTURE SEULE et réservé aux rôles supérieurs.
 * Il nomme l'écart entre comptes portant le rôle RESELLER et fiches réelles ;
 * il ne corrige rien, car aucune correction automatique ne serait réversible.
 */
export async function fetchResellerReconciliation(): Promise<ResellerReconciliation | null> {
  try {
    return await apiRequest<ResellerReconciliation>("/resellers/reconciliation");
  } catch (error) {
    console.error("Error fetching reseller reconciliation:", error);
    return null;
  }
}

export async function deleteReseller(id: string): Promise<void> {
  await apiRequest(`/resellers/${id}`, { method: "DELETE" });
}

export async function fetchResellerClients(resellerId: string): Promise<Client[]> {
  try {
    const data = await apiRequest<Client[] | { clients: Client[] }>(`/resellers/${resellerId}/clients`);
    return Array.isArray(data) ? data : data.clients || [];
  } catch (error) {
    console.error("Error fetching reseller clients:", error);
    return [];
  }
}

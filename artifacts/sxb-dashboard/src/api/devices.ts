import { apiRequest } from "./client";

export interface Device {
  id: string;
  deviceId: string;
  token: string;
  status: "active" | "suspended" | "expired";
  expireAt: string | null;
  activatedAt: string | null;
  createdAt: string;
  label: string | null;
  /** Propriété commerciale de l'appareil, pour les rôles supérieurs. */
  resellerId: string | null;
  resellerName: string | null;
  subscriptionId: string | null;
  subscriptionName: string | null;
  /**
   * Un appareil SANS forfait est un état normal : l'activation crée le compte
   * appareil, jamais un plan. L'attribution reste une décision distincte.
   */
  hasSubscription: boolean;
  quotaSource: "subscription" | "client";
  quotaTotal: string;
  quotaUsed: string;
  quotaRemaining: string;
  trafficDownload: string;
  trafficUpload: string;
  trafficTotal: string;
  lastTrafficAt: string | null;
}

export async function fetchDevices(): Promise<Device[]> {
  try {
    const data = await apiRequest<{ devices: Device[] }>("/devices");
    return data.devices || [];
  } catch (error) {
    console.error("Error fetching devices:", error);
    return [];
  }
}

/**
 * Crée UNIQUEMENT un compte appareil et son jeton d'activation.
 *
 * Aucun forfait, aucun profil VPN, aucun quota n'est attribué au passage :
 * `resellerId` ne sert qu'aux rôles supérieurs, pour rattacher l'appareil au
 * bon revendeur.
 */
export async function generateDeviceToken(params: {
  deviceId: string;
  label?: string;
  durationDays?: number;
  resellerId?: string;
}): Promise<Device> {
  return apiRequest<Device>("/devices/generate-token", {
    method: "POST",
    body: params,
  });
}

export async function revokeDevice(id: string): Promise<Device> {
  return apiRequest<Device>(`/devices/${id}/revoke`, { method: "POST" });
}

export async function renewDevice(id: string, durationDays = 365): Promise<Device> {
  return apiRequest<Device>(`/devices/${id}/renew`, { method: "POST", body: { durationDays } });
}

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
  quotaTotal: string;
  quotaUsed: string;
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

export async function generateDeviceToken(params: {
  deviceId: string;
  label?: string;
  durationDays?: number;
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

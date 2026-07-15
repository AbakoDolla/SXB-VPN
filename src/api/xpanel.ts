import { XPanelStatus } from "../types";
import { apiRequest } from "./client";

export async function getXPanelStatus(): Promise<XPanelStatus> {
  try {
    return await apiRequest<XPanelStatus>("/xpanel/status");
  } catch (error) {
    console.error("Error fetching XPanel status:", error);
    return {
      status: "offline",
      connectedServers: 0,
      synchronizedUsers: 0,
      availableConfigs: 0,
      isSyncing: false,
    };
  }
}

export interface XPanelUser {
  id: string;
  username: string;
  protocol: string;
  connectedIp: string;
  duration: string;
  trafficUsed: number;
  status: string;
}

export async function fetchXPanelUsers(): Promise<XPanelUser[]> {
  try {
    const data = await apiRequest<{ users: XPanelUser[] }>("/xpanel/users");
    return data.users || [];
  } catch (error) {
    console.error("Error fetching XPanel users:", error);
    return [];
  }
}

export interface XPanelConfig {
  id: string;
  name: string;
  protocol: string;
  uuid: string;
  privateKey?: string;
  port: number;
  fullConfigUrl: string;
  createdAt: string;
}

export async function fetchXPanelConfigurations(): Promise<XPanelConfig[]> {
  try {
    const data = await apiRequest<{ configs: XPanelConfig[] }>("/xpanel/configs");
    return data.configs || [];
  } catch (error) {
    console.error("Error fetching XPanel configurations:", error);
    return [];
  }
}

export async function createXPanelConfig(configData: {
  name: string;
  protocol: string;
  port: number;
  settings?: any;
}): Promise<XPanelConfig> {
  return await apiRequest<XPanelConfig>("/xpanel/configs", {
    method: "POST",
    body: configData,
  });
}

export async function deleteXPanelConfig(id: string): Promise<void> {
  await apiRequest(`/xpanel/configs/${id}`, { method: "DELETE" });
}

export async function triggerXPanelSync(): Promise<{ success: boolean; message: string }> {
  try {
    return await apiRequest<{ success: boolean; message: string }>("/xpanel/sync", {
      method: "POST",
    });
  } catch (error) {
    console.error("Error triggering XPanel sync:", error);
    return { success: false, message: "Sync failed" };
  }
}

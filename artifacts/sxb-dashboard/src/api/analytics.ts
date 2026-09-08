import { TrafficDataPoint, UserDataPoint, ActivityLog, ResellerAccessSummary } from "../types";
import { apiRequest } from "./client";

export interface DashboardResellerQuota {
  /** Quota du revendeur connecté ou agrégat des revendeurs administrés. */
  scope: "self" | "platform";
  assignedBytes: string;
  committedBytes: string;
  consumedBytes: string;
  remainingBytes: string | null;
  /** Vrai uniquement pour le revendeur connecté explicitement illimité. */
  unlimited: boolean;
  resellerCount: number;
  limitedResellers: number;
  unlimitedResellers: number;
}

export interface DashboardStats {
  activeUsers: number;
  expiredAccounts: number;
  consumedTraffic: number;
  provisionedTraffic: number;
  remainingTraffic: number;
  consumedTrafficBytes?: string;
  provisionedTrafficBytes?: string;
  /** « own » : les chiffres ne portent que sur les clients du revendeur. */
  quotaScope?: "own" | "platform";
  /** Faux pour un administrateur : son compte ne porte aucun quota. */
  hasPersonalQuota?: boolean;
  personalQuota?: { attribue: string; alloue: string; illimite: boolean } | null;
  /** Validité + plafond du revendeur connecté, même contrat que les refus. */
  resellerAccess?: ResellerAccessSummary | null;
  /** Enveloppes attribuées aux revendeurs, jamais un agrégat des clients. */
  resellerQuota?: DashboardResellerQuota | null;
  activeServers: number;
  activeResellers: number;
  totalRevenue: number;
}

export async function fetchDashboardStats(): Promise<DashboardStats | null> {
  try {
    return await apiRequest<DashboardStats>("/dashboard/stats");
  } catch (error) {
    console.error("Error fetching dashboard stats:", error);
    return null;
  }
}

export async function fetchTrafficAnalytics(): Promise<TrafficDataPoint[]> {
  try {
    return await apiRequest<TrafficDataPoint[]>("/dashboard/traffic");
  } catch (error) {
    console.error("Error fetching traffic analytics:", error);
    return [];
  }
}

export async function fetchUserAnalytics(): Promise<UserDataPoint[]> {
  try {
    return await apiRequest<UserDataPoint[]>("/dashboard/users");
  } catch (error) {
    console.error("Error fetching user analytics:", error);
    return [];
  }
}

export async function fetchActivityLogs(): Promise<ActivityLog[]> {
  try {
    const data = await apiRequest<{ logs: ActivityLog[] }>("/audit-logs?limit=50");
    return data.logs || [];
  } catch (error) {
    console.error("Error fetching activity logs:", error);
    return [];
  }
}

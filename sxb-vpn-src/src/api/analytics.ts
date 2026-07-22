import { TrafficDataPoint, UserDataPoint, ActivityLog } from "../types";
import { apiRequest } from "./client";

export interface DashboardStats {
  activeUsers: number;
  expiredAccounts: number;
  consumedTraffic: number;
  activeServers: number;
  activeResellers: number;
  totalRevenue: number;
}

export async function fetchDashboardStats(): Promise<DashboardStats> {
  try {
    return await apiRequest<DashboardStats>("/dashboard/stats");
  } catch (error) {
    console.error("Error fetching dashboard stats:", error);
    return {
      activeUsers: 0,
      expiredAccounts: 0,
      consumedTraffic: 0,
      activeServers: 0,
      activeResellers: 0,
      totalRevenue: 0,
    };
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

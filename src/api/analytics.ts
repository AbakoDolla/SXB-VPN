import { TrafficDataPoint, UserDataPoint, ActivityLog } from "../types";
import { getClients, getServers, getResellers, getLogs } from "./db";

export interface DashboardStats {
  activeUsers: number;
  expiredAccounts: number;
  consumedTraffic: number; // in GB
  activeServers: number;
  activeResellers: number;
  totalRevenue: number; // calculated loosely
}

export async function fetchDashboardStats(): Promise<DashboardStats> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const clients = getClients();
      const servers = getServers();
      const resellers = getResellers();

      const activeUsers = clients.filter((c) => c.status === "active").length;
      const expiredAccounts = clients.filter((c) => c.status === "expired").length;
      const consumedTraffic = parseFloat(
        clients.reduce((acc, c) => acc + (c.consumption || 0), 0).toFixed(2)
      );
      const activeServers = servers.filter((s) => s.status === "online").length;
      const activeResellers = resellers.filter((r) => r.status === "active").length;
      
      // Calculate a virtual SaaS revenue based on total quotas of active accounts (e.g., $0.15 per GB)
      const totalRevenue = parseFloat(
        clients
          .filter((c) => c.status === "active")
          .reduce((acc, c) => acc + c.quotaTotal * 0.15, 0)
          .toFixed(2)
      );

      resolve({
        activeUsers,
        expiredAccounts,
        consumedTraffic,
        activeServers,
        activeResellers,
        totalRevenue,
      });
    }, 200);
  });
}

export async function fetchTrafficAnalytics(): Promise<TrafficDataPoint[]> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const clients = getClients();
      if (clients.length === 0) {
        // Return empty list to trigger the clean "No data" analytics state
        return resolve([]);
      }

      // Generate a dynamic 7-day traffic chart reflecting actual user quotas
      const totalConsumption = clients.reduce((acc, c) => acc + c.consumption, 0);
      const days = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
      
      const data: TrafficDataPoint[] = days.map((day, idx) => {
        const factor = (idx + 1) / 7;
        return {
          time: day,
          download: parseFloat((totalConsumption * 0.75 * factor).toFixed(1)),
          upload: parseFloat((totalConsumption * 0.25 * factor).toFixed(1)),
        };
      });
      resolve(data);
    }, 200);
  });
}

export async function fetchUserAnalytics(): Promise<UserDataPoint[]> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const clients = getClients();
      if (clients.length === 0) {
        return resolve([]);
      }

      const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      let countAccumulator = 0;
      
      const data: UserDataPoint[] = days.map((day, idx) => {
        // Distribute actual users over the week
        const step = Math.ceil(clients.length / 7);
        countAccumulator = Math.min(clients.length, countAccumulator + step);
        return {
          time: day,
          count: countAccumulator,
        };
      });
      resolve(data);
    }, 150);
  });
}

export async function fetchActivityLogs(): Promise<ActivityLog[]> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(getLogs());
    }, 100);
  });
}

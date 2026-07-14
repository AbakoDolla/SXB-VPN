/**
 * XPanel Service Integration
 */

import { config } from "../../config";

export interface XPanelUser {
  id: string;
  username: string;
  password: string;
  quota: number;
  expireDate: string;
  status: "active" | "disabled" | "expired";
}

export interface XPanelServer {
  id: string;
  name: string;
  ip: string;
  port: number;
  location: string;
  status: "online" | "offline";
}

export interface XPanelTraffic {
  userId: string;
  upload: number;
  download: number;
  total: number;
  lastConnected: string;
}

class XPanelService {
  private baseUrl: string;
  private apiToken: string;

  constructor() {
    this.baseUrl = config.XPANEL_URL || "http://localhost:2080";
    this.apiToken = config.XPANEL_TOKEN || "";
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = this.baseUrl + endpoint;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + this.apiToken,
    };

    try {
      const response = await fetch(url, { ...options, headers });
      if (!response.ok) {
        throw new Error("XPanel API error: " + response.status);
      }
      return await response.json();
    } catch (error) {
      console.error("XPanel service error:", error);
      throw error;
    }
  }

  async createUser(username: string, password: string, quota: number, expireDays: number): Promise<XPanelUser> {
    return this.request<XPanelUser>("/api/users", {
      method: "POST",
      body: JSON.stringify({ username, password, quota, expire_days: expireDays }),
    });
  }

  async deleteUser(userId: string): Promise<void> {
    return this.request<void>("/api/users/" + userId, { method: "DELETE" });
  }

  async getUser(userId: string): Promise<XPanelUser> {
    return this.request<XPanelUser>("/api/users/" + userId);
  }

  async updateUser(userId: string, data: Partial<XPanelUser>): Promise<XPanelUser> {
    return this.request<XPanelUser>("/api/users/" + userId, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async getUsers(): Promise<XPanelUser[]> {
    return this.request<XPanelUser[]>("/api/users");
  }

  async getServers(): Promise<XPanelServer[]> {
    return this.request<XPanelServer[]>("/api/servers");
  }

  async getUserTraffic(userId: string): Promise<XPanelTraffic> {
    return this.request<XPanelTraffic>("/api/traffic/" + userId);
  }

  async getAllTraffic(): Promise<XPanelTraffic[]> {
    return this.request<XPanelTraffic[]>("/api/traffic");
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.request<{ status: string }>("/api/health");
      return true;
    } catch {
      return false;
    }
  }

  async syncUsers(sxbUsers: Array<{ id: string; token: string; quotaTotal: bigint; expireAt: Date }>): Promise<void> {
    const xpanelUsers = await this.getUsers();
    for (const sxbUser of sxbUsers) {
      const existingUser = xpanelUsers.find(u => u.username === sxbUser.token);
      if (!existingUser) {
        await this.createUser(
          sxbUser.token,
          this.generatePassword(),
          Number(sxbUser.quotaTotal),
          Math.ceil((sxbUser.expireAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        );
      } else {
        await this.updateUser(existingUser.id, {
          quota: Number(sxbUser.quotaTotal),
          expireDate: sxbUser.expireAt.toISOString(),
        });
      }
    }
  }

  private generatePassword(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let password = "";
    for (let i = 0; i < 16; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }
}

export const xpanelService = new XPanelService();

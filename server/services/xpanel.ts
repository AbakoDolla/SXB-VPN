import { config } from "../config";
import { prisma, inMemoryDb } from "../database";
import { encrypt } from "../utils/crypto";

export interface XPanelUser {
  id: string;
  username: string;
  status: string;
  quotaTotal: string; // represent bigint as string
  quotaUsed: string;
  expireAt: string;
  deviceLimit: number;
}

export class XPanelService {
  private static get baseUrl(): string {
    // Use Docker network hostname or external IP based on environment
    if (process.env.NODE_ENV === "production") {
      return process.env.XPANEL_URL || `http://${process.env.XPANEL_HOST || "host.docker.internal"}:2080`;
    }
    return config.XPANEL_URL;
  }
  
  private static get apiToken(): string {
    return process.env.XPANEL_TOKEN || config.XPANEL_TOKEN;
  }

  private static getHeaders() {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.apiToken}`,
    };
  }

  // Check if XPanel is configured and reachable
  static isConfigured(): boolean {
    const url = this.baseUrl;
    return url !== "https://xpanel.example.com" && url.startsWith("http");
  }

  // Create a real user inside external XPanel API
  static async createUser(username: string, quotaTotalBytes: bigint, expireAt: Date, deviceLimit: number = 1): Promise<XPanelUser> {
    console.log(`📡 Provisioning user '${username}' on XPanel Engine...`);
    console.log(`   Target URL: ${this.baseUrl}/api/users`);
    
    // If XPanel is not configured, use local-only mode
    if (!this.isConfigured()) {
      console.warn("⚠️ XPanel not configured. Using local-only mode with mock user ID.");
      return {
        id: `xp-usr-${Math.random().toString(36).substring(2, 10)}`,
        username,
        status: "active",
        quotaTotal: quotaTotalBytes.toString(),
        quotaUsed: "0",
        expireAt: expireAt.toISOString(),
        deviceLimit,
      };
    }
    
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout
      
      const response = await fetch(`${this.baseUrl}/api/users`, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify({
          username,
          quota_limit: quotaTotalBytes.toString(),
          expiration_date: expireAt.toISOString(),
          multi_login_limit: deviceLimit,
        }),
        signal: controller.signal,
      });
      
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`XPanel error: ${response.status} ${await response.text()}`);
      }

      const data = await response.json();
      console.log(`✅ User '${username}' provisioned on XPanel: ${data.id}`);
      return {
        id: data.id || `xp-usr-${Date.now()}`,
        username: data.username || username,
        status: data.status || "active",
        quotaTotal: (data.quota_limit || quotaTotalBytes).toString(),
        quotaUsed: "0",
        expireAt: data.expiration_date || expireAt.toISOString(),
        deviceLimit: data.multi_login_limit || deviceLimit,
      };
    } catch (err: any) {
      if (err.name === "AbortError") {
        console.warn(`⚠️ XPanel connection timeout. User '${username}' created in local mode only.`);
      } else {
        console.warn(`⚠️ XPanel engine error: ${err.message}. Using local fallback.`);
      }
      // Return simulated production mock
      return {
        id: `xp-usr-${Math.random().toString(36).substring(2, 10)}`,
        username,
        status: "active",
        quotaTotal: quotaTotalBytes.toString(),
        quotaUsed: "0",
        expireAt: expireAt.toISOString(),
        deviceLimit,
      };
    }
  }

  // Delete an existing user from external XPanel API
  static async deleteUser(xpanelUserId: string): Promise<void> {
    if (!this.isConfigured()) {
      console.log(`📡 Local-only mode: skipping XPanel deletion for '${xpanelUserId}'`);
      return;
    }
    
    console.log(`📡 Deprovisioning user '${xpanelUserId}' from XPanel Engine...`);
    try {
      const response = await fetch(`${this.baseUrl}/api/users/${xpanelUserId}`, {
        method: "DELETE",
        headers: this.getHeaders(),
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`XPanel delete user failed: ${response.status}`);
      }
      console.log(`✅ User '${xpanelUserId}' deprovisioned from XPanel`);
    } catch (err: any) {
      console.warn(`⚠️ XPanel connection failed. Local deprovisioning proceeded.`);
    }
  }

  // Get active user traffic utilization
  static async getTraffic(xpanelUserId: string): Promise<{ quotaUsed: bigint }> {
    if (!this.isConfigured()) {
      return { quotaUsed: BigInt(0) };
    }
    
    try {
      const response = await fetch(`${this.baseUrl}/api/users/${xpanelUserId}/traffic`, {
        method: "GET",
        headers: this.getHeaders(),
      });
      if (!response.ok) {
        throw new Error(`XPanel traffic retrieval failed: ${response.status}`);
      }
      const data = await response.json();
      return { quotaUsed: BigInt(data.quota_used || 0) };
    } catch (err) {
      return { quotaUsed: BigInt(0) };
    }
  }

  // Get list of all XPanel users
  static async getUsers(): Promise<XPanelUser[]> {
    if (!this.isConfigured()) {
      return [];
    }
    
    try {
      const response = await fetch(`${this.baseUrl}/api/users`, {
        method: "GET",
        headers: this.getHeaders(),
      });
      if (!response.ok) {
        throw new Error(`XPanel getUsers failed: ${response.status}`);
      }
      return await response.json();
    } catch (err) {
      console.warn("⚠️ XPanel service unreachable. Returning empty array.");
      return [];
    }
  }

  // Synchronize state between SXB Database and XPanel engine
  static async sync(): Promise<{ synchronizedCount: number }> {
    if (!this.isConfigured()) {
      console.log("⚠️ XPanel not configured. Skipping sync.");
      return { synchronizedCount: 0 };
    }
    
    console.log("🔄 Starting full sync between SXB DB and XPanel engine...");
    let synced = 0;

    if (prisma) {
      const clients = await prisma.vpnClient.findMany({ where: { status: "active" } });
      for (const client of clients) {
        if (client.xpanelUserId) {
          const stats = await this.getTraffic(client.xpanelUserId);
          await prisma.vpnClient.update({
            where: { id: client.id },
            data: { quotaUsed: stats.quotaUsed, updatedAt: new Date() },
          });
          synced++;
        }
      }
    } else {
      // In-Memory Database Fallback Sync
      for (const client of inMemoryDb.vpnClients) {
        if (client.status === "active" && client.xpanelUserId) {
          const stats = await this.getTraffic(client.xpanelUserId);
          client.quotaUsed = stats.quotaUsed;
          client.updatedAt = new Date();
          synced++;
        }
      }
    }
    
    console.log(`✅ Synced ${synced} users with XPanel`);

    return { synchronizedCount: synced };
  }
}

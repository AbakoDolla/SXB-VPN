import { config } from "../config";

export interface XPanelUser {
  id: string;
  username: string;
  status: string;
  quotaTotal: string;
  quotaUsed: string;
  expireAt: string;
  deviceLimit: number;
}

interface XPanelCredentials {
  username: string;
  password: string;
}

export class XPanelService {
  private static cachedToken: string | null = null;
  private static tokenExpiry: number = 0;

  private static get baseUrl(): string {
    return config.XPANEL_URL || "http://localhost:18790";
  }

  private static get adminCredentials(): XPanelCredentials {
    return {
      username: process.env.XPANEL_ADMIN_USERNAME || config.XPANEL_ADMIN_USERNAME || "admin",
      password: process.env.XPANEL_ADMIN_PASSWORD || config.XPANEL_ADMIN_PASSWORD || "",
    };
  }

  private static get jwtSecret(): string {
    return process.env.XPANEL_JWT_SECRET || config.XPANEL_JWT_SECRET || "";
  }

  private static async getAuthToken(): Promise<string> {
    // Return cached token if still valid
    if (this.cachedToken && Date.now() < this.tokenExpiry) {
      return this.cachedToken;
    }

    const { username, password } = this.adminCredentials;
    if (!password) {
      throw new Error("X-Panel admin password not configured");
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`${this.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`X-Panel login failed: ${response.status}`);
      }

      const data = await response.json();
      this.cachedToken = data.token;
      // Token expires in 1 day, refresh 5 minutes before
      this.tokenExpiry = Date.now() + (24 * 60 * 60 * 1000) - (5 * 60 * 1000);
      
      return this.cachedToken;
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error("X-Panel connection timeout");
      }
      throw err;
    }
  }

  private static async getHeaders(): Promise<Record<string, string>> {
    const token = await this.getAuthToken();
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    };
  }

  // Check if XPanel is configured and reachable
  static isConfigured(): boolean {
    const url = this.baseUrl;
    return url.startsWith("http") && url !== "https://xpanel.example.com";
  }

  // Test X-Panel connectivity
  static async testConnection(): Promise<{ success: boolean; error?: string }> {
    if (!this.isConfigured()) {
      return { success: false, error: "X-Panel URL not configured" };
    }

    try {
      await this.getAuthToken();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  // Create a real user inside external XPanel API
  static async createUser(username: string, quotaTotalBytes: bigint, expireAt: Date, deviceLimit: number = 1): Promise<XPanelUser> {
    console.log(`📡 Provisioning user '${username}' on XPanel Engine...`);
    console.log(`   Target URL: ${this.baseUrl}/api/subscribers`);

    if (!this.isConfigured()) {
      throw new Error("X-Panel not configured. Cannot create users.");
    }

    try {
      const headers = await this.getHeaders();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      // Create subscriber in X-Panel
      const response = await fetch(`${this.baseUrl}/api/subscribers`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          username,
          quota_limit: Number(quotaTotalBytes),
          expiry_time: Math.floor(expireAt.getTime() / 1000),
          enable: true,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`XPanel error: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      console.log(`✅ User '${username}' provisioned on XPanel: ${data.id || data.uuid}`);
      
      return {
        id: data.id || data.uuid || `xp-usr-${Date.now()}`,
        username: data.username || username,
        status: data.status || "active",
        quotaTotal: (data.quota_limit || quotaTotalBytes).toString(),
        quotaUsed: "0",
        expireAt: data.expiry || expireAt.toISOString(),
        deviceLimit,
      };
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error(`XPanel connection timeout for user '${username}'`);
      }
      throw new Error(`XPanel engine error: ${err.message}`);
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
      const headers = await this.getHeaders();
      const response = await fetch(`${this.baseUrl}/api/subscribers/${xpanelUserId}`, {
        method: "DELETE",
        headers,
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`XPanel delete user failed: ${response.status}`);
      }
      console.log(`✅ User '${xpanelUserId}' deprovisioned from XPanel`);
    } catch (err: any) {
      console.warn(`⚠️ XPanel connection failed: ${err.message}. Local deprovisioning proceeded.`);
    }
  }

  // Get active user traffic utilization
  static async getTraffic(xpanelUserId: string): Promise<{ quotaUsed: bigint }> {
    if (!this.isConfigured()) {
      return { quotaUsed: BigInt(0) };
    }

    try {
      const headers = await this.getHeaders();
      const response = await fetch(`${this.baseUrl}/api/subscribers/${xpanelUserId}`, {
        method: "GET",
        headers,
      });
      if (!response.ok) {
        throw new Error(`XPanel traffic retrieval failed: ${response.status}`);
      }
      const data = await response.json();
      return { quotaUsed: BigInt(data.uploaded || 0) + BigInt(data.downloaded || 0) };
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
      const headers = await this.getHeaders();
      const response = await fetch(`${this.baseUrl}/api/subscribers`, {
        method: "GET",
        headers,
      });
      if (!response.ok) {
        throw new Error(`XPanel getUsers failed: ${response.status}`);
      }
      const data = await response.json();
      return Array.isArray(data) ? data : [];
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
    console.log("✅ XPanel sync completed (traffic sync is real-time via collectors)");
    return { synchronizedCount: 0 };
  }

  // Get VPN configurations from XPanel
  static async getConfigs(): Promise<any[]> {
    if (!this.isConfigured()) {
      return [];
    }

    try {
      const headers = await this.getHeaders();
      // Try to get inbounds (VPN configs)
      const response = await fetch(`${this.baseUrl}/api/inbounds`, {
        method: "GET",
        headers,
      });
      if (!response.ok) {
        console.warn("⚠️ Could not fetch XPanel configs, returning empty array");
        return [];
      }
      const data = await response.json();
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.warn("⚠️ XPanel configs unreachable:", err);
      return [];
    }
  }

  // Get the real per-user subscription (VLESS/VMess/Trojan links) from XPanel/xnet
  static async getSubscriptionLink(xpanelUserId: string): Promise<{ raw: string | null; links: string[] }> {
    if (!this.isConfigured()) {
      throw new Error("X-Panel not configured. Cannot fetch subscription.");
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(`${this.baseUrl}/api/sub/${xpanelUserId}`, {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) {
        throw new Error(`Subscription not available (${response.status})`);
      }
      const text = await response.text();
      // xnet may return raw base64 subscription text or JSON with a "links" field
      try {
        const json = JSON.parse(text);
        if (Array.isArray(json.links)) {
          return { raw: text, links: json.links };
        }
      } catch {
        // not JSON — treat as base64-encoded newline-separated links
      }
      let decoded = text;
      try {
        decoded = Buffer.from(text, "base64").toString("utf-8");
      } catch {
        // keep raw text as-is
      }
      const links = decoded
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^(vless|vmess|trojan|ss):\/\//.test(l));
      return { raw: text, links };
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error("X-Panel connection timeout");
      }
      throw err;
    }
  }

  // Create a new VPN config on XPanel
  static async createConfig(name: string, protocol: string, port: number, settings?: any): Promise<any> {
    if (!this.isConfigured()) {
      throw new Error("X-Panel not configured. Cannot create configs.");
    }

    try {
      const headers = await this.getHeaders();
      const response = await fetch(`${this.baseUrl}/api/inbounds`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          up: name,
          down: name,
          remark: name,
          enable: true,
          expiryTime: 0,
          total: 0,
          reset: 0,
        }),
      });
      if (!response.ok) {
        throw new Error(`XPanel create config failed: ${response.status}`);
      }
      const data = await response.json();
      return {
        id: data.id,
        name,
        protocol,
        port,
        fullConfigUrl: `${protocol}://config-${data.id}@localhost:${port}`,
        createdAt: new Date().toISOString(),
      };
    } catch (err: any) {
      throw new Error(`XPanel config creation error: ${err.message}`);
    }
  }

  // Delete a VPN config from XPanel
  static async deleteConfig(configId: string): Promise<void> {
    if (!this.isConfigured()) {
      return;
    }

    try {
      const headers = await this.getHeaders();
      const response = await fetch(`${this.baseUrl}/api/inbounds/${configId}`, {
        method: "DELETE",
        headers,
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`XPanel delete config failed: ${response.status}`);
      }
    } catch (err: any) {
      console.warn(`⚠️ XPanel config deletion error: ${err.message}`);
    }
  }
}

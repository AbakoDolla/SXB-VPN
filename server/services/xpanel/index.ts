/**
 * XPanel (XNet) Service Integration
 * Auth: POST /api/auth/login → JWT token (24h expiry)
 * XNet API base: XPANEL_URL (default http://localhost:18790)
 */
import { config } from '../../config';

export interface XPanelUser {
  id: string;
  username: string;
  password: string;
  quota: number;
  expireDate: string;
  status: 'active' | 'disabled' | 'expired';
}
export interface XPanelServer {
  id: string; name: string; ip: string; port: number; location: string; status: 'online' | 'offline';
}
export interface XPanelTraffic {
  userId: string; upload: number; download: number; total: number; lastConnected: string;
}
export interface XPanelConfig {
  id: string; name: string; protocol: string; uuid?: string; privateKey?: string;
  port: number; fullConfigUrl: string; createdAt: string;
}

class XPanelServiceClass {
  private baseUrl: string;
  private username: string;
  private password: string;
  private token: string | null = null;
  private tokenExpiry: number = 0;

  constructor() {
    this.baseUrl = config.XPANEL_URL || 'http://localhost:18790';
    this.username = config.XPANEL_ADMIN_USERNAME || 'admin';
    this.password = config.XPANEL_ADMIN_PASSWORD || '';
  }

  /** Authenticate with XNet and cache JWT token for 23h */
  private async authenticate(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.tokenExpiry) return this.token;

    const res = await fetch(this.baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.username, password: this.password }),
    });
    if (!res.ok) throw new Error('XNet auth failed: ' + res.status);
    const data = await res.json() as { token: string };
    this.token = data.token;
    this.tokenExpiry = now + 23 * 60 * 60 * 1000; // 23h cache
    return this.token;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const token = await this.authenticate();
    const url = this.baseUrl + endpoint;
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
        ...((options.headers as Record<string, string>) || {}),
      },
    });
    if (res.status === 401) {
      // Token expired, clear and retry once
      this.token = null;
      const retryToken = await this.authenticate();
      const res2 = await fetch(url, {
        ...options,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + retryToken },
      });
      if (!res2.ok) throw new Error('XNet API error: ' + res2.status);
      return res2.json();
    }
    if (!res.ok) throw new Error('XNet API error: ' + res.status);
    return res.json();
  }

  async testConnection(): Promise<{ success: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.request<unknown>('/api/system/info');
      return { success: true, latencyMs: Date.now() - start };
    } catch {
      return { success: false, latencyMs: Date.now() - start };
    }
  }

  async getSystemInfo(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('/api/system/info');
  }

  async createUser(username: string, password: string, quota: number, expireDays: number): Promise<XPanelUser> {
    return this.request<XPanelUser>('/api/users', {
      method: 'POST',
      body: JSON.stringify({ username, password, quota, expire_days: expireDays }),
    });
  }

  async deleteUser(userId: string): Promise<void> {
    await this.request<void>('/api/users/' + userId, { method: 'DELETE' });
  }

  async getUser(userId: string): Promise<XPanelUser> {
    return this.request<XPanelUser>('/api/users/' + userId);
  }

  async updateUser(userId: string, data: Partial<XPanelUser>): Promise<XPanelUser> {
    return this.request<XPanelUser>('/api/users/' + userId, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async getUsers(): Promise<XPanelUser[]> {
    try { return await this.request<XPanelUser[]>('/api/users'); } catch { return []; }
  }

  async getServers(): Promise<XPanelServer[]> {
    try { return await this.request<XPanelServer[]>('/api/servers'); } catch { return []; }
  }

  async getConfigs(): Promise<XPanelConfig[]> {
    try {
      const r = await this.request<{ configs?: XPanelConfig[]; data?: XPanelConfig[] }>('/api/configs');
      return r.configs || r.data || [];
    } catch { return []; }
  }

  async createConfig(name: string, protocol: string, port: number, settings?: Record<string, unknown>): Promise<XPanelConfig> {
    return this.request<XPanelConfig>('/api/configs', {
      method: 'POST',
      body: JSON.stringify({ name, protocol, port, settings }),
    });
  }

  async deleteConfig(id: string): Promise<void> {
    await this.request<void>('/api/configs/' + id, { method: 'DELETE' });
  }

  async sync(): Promise<{ synchronizedCount: number; message: string }> {
    try {
      const r = await this.request<{ synchronizedCount?: number; message?: string }>('/api/sync');
      return { synchronizedCount: r.synchronizedCount || 0, message: r.message || 'Sync complete' };
    } catch { return { synchronizedCount: 0, message: 'XNet sync unavailable' }; }
  }

  private generatePassword(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  }

  async syncUsers(users: Array<{ id: string; token: string; quotaTotal: bigint; expireAt: Date }>): Promise<void> {
    try {
      const xUsers = await this.getUsers();
      for (const u of users) {
        const exists = xUsers.find((x) => x.username === u.token);
        const days = Math.ceil((u.expireAt.getTime() - Date.now()) / 86400000);
        if (!exists) {
          await this.createUser(u.token, this.generatePassword(), Number(u.quotaTotal), days);
        } else {
          await this.updateUser(exists.id, { quota: Number(u.quotaTotal), expireDate: u.expireAt.toISOString() });
        }
      }
    } catch (err) { console.error('XPanel syncUsers error:', err); }
  }
}

export const XPanelService = new XPanelServiceClass();
export const xpanelService = XPanelService;

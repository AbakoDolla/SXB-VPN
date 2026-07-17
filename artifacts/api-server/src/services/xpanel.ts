/**
 * XPanel (XNet) Service — wraps the XNet panel API
 * Auth: POST /api/auth/login → JWT cached 23h
 */
const XPANEL_URL = process.env.XPANEL_URL || "http://localhost:18790";
const XPANEL_USER = process.env.XPANEL_ADMIN_USERNAME || "admin";
const XPANEL_PASS = process.env.XPANEL_ADMIN_PASSWORD || "";

let _token: string | null = null;
let _tokenExpiry = 0;

async function xnetAuth(): Promise<string> {
  const now = Date.now();
  if (_token && now < _tokenExpiry) return _token;

  const res = await fetch(`${XPANEL_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: XPANEL_USER, password: XPANEL_PASS }),
  });
  if (!res.ok) throw new Error(`XNet auth failed: ${res.status}`);
  const data = (await res.json()) as { token: string };
  _token = data.token;
  _tokenExpiry = now + 23 * 60 * 60 * 1000;
  return _token!;
}

async function xnetRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await xnetAuth();
  const url = `${XPANEL_URL}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...((options.headers as Record<string, string>) || {}),
    },
  });
  if (res.status === 401) {
    _token = null;
    const retryToken = await xnetAuth();
    const res2 = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${retryToken}`,
      },
    });
    if (!res2.ok) throw new Error(`XNet API error: ${res2.status}`);
    return res2.json();
  }
  if (!res.ok) throw new Error(`XNet API error: ${res.status}`);
  return res.json();
}

export const XPanelService = {
  async testConnection() {
    const start = Date.now();
    try {
      await xnetRequest("/api/system/info");
      return { success: true, latencyMs: Date.now() - start };
    } catch {
      return { success: false, latencyMs: Date.now() - start };
    }
  },
  async getUsers() {
    try {
      return await xnetRequest<unknown[]>("/api/users");
    } catch {
      return [];
    }
  },
  async getInbounds() {
    try {
      const r = await xnetRequest<unknown[] | { data?: unknown[] }>("/api/inbounds");
      if (Array.isArray(r)) return r;
      return (r as any).data || [];
    } catch {
      return [];
    }
  },
  async getConfigs() {
    try {
      const r = await xnetRequest<{ configs?: unknown[]; data?: unknown[] }>(
        "/api/configs"
      );
      return r.configs || r.data || [];
    } catch {
      return [];
    }
  },
  async createConfig(
    name: string,
    protocol: string,
    port: number,
    settings?: Record<string, unknown>
  ) {
    return xnetRequest("/api/configs", {
      method: "POST",
      body: JSON.stringify({ name, protocol, port, settings }),
    });
  },
  async deleteConfig(id: string) {
    await xnetRequest(`/api/configs/${id}`, { method: "DELETE" });
  },
  async sync() {
    try {
      const r = await xnetRequest<{ synchronizedCount?: number; message?: string }>(
        "/api/sync"
      );
      return {
        synchronizedCount: r.synchronizedCount || 0,
        message: r.message || "Sync complete",
      };
    } catch {
      return { synchronizedCount: 0, message: "XNet sync unavailable" };
    }
  },
  async getSubscriptionLink(userId: string): Promise<string | null> {
    try {
      const r = await xnetRequest<{ url?: string; link?: string }>(
        `/api/users/${userId}/subscription`
      );
      return r.url || r.link || null;
    } catch {
      return null;
    }
  },
};

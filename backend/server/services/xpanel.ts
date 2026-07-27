/**
 * XPanel Service — Stub / Adapter
 * Les méthodes XPanel sont optionnelles. Si XPANEL_URL n'est pas configuré,
 * toutes les opérations sont no-ops et retournent des valeurs neutres.
 */

const XPANEL_URL   = process.env.XPANEL_URL   || '';
const XPANEL_USER  = process.env.XPANEL_USER  || '';
const XPANEL_PASS  = process.env.XPANEL_PASS  || '';

async function xpanelFetch(path: string, options: RequestInit = {}): Promise<any> {
  if (!XPANEL_URL) return null;
  const url = `${XPANEL_URL}${path}`;
  const creds = Buffer.from(`${XPANEL_USER}:${XPANEL_PASS}`).toString('base64');
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`XPanel ${path} → HTTP ${res.status}`);
  return res.json();
}

export const XPanelService = {
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      if (!XPANEL_URL) return { ok: false, message: 'XPANEL_URL non configuré' };
      await xpanelFetch('/api/v1/status');
      return { ok: true, message: 'Connexion XPanel OK' };
    } catch (err: any) {
      return { ok: false, message: err?.message || 'Erreur connexion XPanel' };
    }
  },

  async getUsers(): Promise<any[]> {
    try {
      const data = await xpanelFetch('/api/v1/users');
      return data?.users || data || [];
    } catch { return []; }
  },

  async createUser(
    name: string,
    quotaBytes?: bigint | null,
    expireAt?: Date | null,
    maxDevices?: number,
  ): Promise<{ id: string }> {
    try {
      const body = {
        username: name,
        quota: quotaBytes ? Number(quotaBytes) : null,
        expire: expireAt ? expireAt.toISOString() : null,
        max_devices: maxDevices ?? 1,
      };
      const data = await xpanelFetch('/api/v1/users', { method: 'POST', body: JSON.stringify(body) });
      return { id: data?.id || data?.user?.id || String(Date.now()) };
    } catch {
      return { id: '' };
    }
  },

  async deleteUser(xpanelUserId: string): Promise<void> {
    try {
      if (!xpanelUserId) return;
      await xpanelFetch(`/api/v1/users/${xpanelUserId}`, { method: 'DELETE' });
    } catch { /* Silently ignore — user may already be deleted */ }
  },

  async getConfigs(): Promise<any[]> {
    try {
      const data = await xpanelFetch('/api/v1/configs');
      return data?.configs || data || [];
    } catch { return []; }
  },

  async createConfig(config: Record<string, unknown>): Promise<any> {
    try {
      return await xpanelFetch('/api/v1/configs', { method: 'POST', body: JSON.stringify(config) });
    } catch { return null; }
  },

  async deleteConfig(configId: string): Promise<void> {
    try {
      if (!configId) return;
      await xpanelFetch(`/api/v1/configs/${configId}`, { method: 'DELETE' });
    } catch { /* Silently ignore */ }
  },

  async sync(): Promise<{ synced: number; errors: number }> {
    try {
      const data = await xpanelFetch('/api/v1/sync', { method: 'POST' });
      return { synced: data?.synced ?? 0, errors: data?.errors ?? 0 };
    } catch { return { synced: 0, errors: 0 }; }
  },
};

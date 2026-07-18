import { apiRequest } from "./client";

export interface SingboxAccount {
  id: string;
  name: string;
  protocol: 'vless' | 'trojan' | 'shadowsocks' | 'hysteria2' | 'tuic';
  uuid: string;
  host: string;
  port: number;
  path: string | null;
  tls: boolean;
  sni: string | null;
  network: string;
  quotaTotal: string | null;
  quotaUsed: string;
  expireAt: string | null;
  maxDevices: number;
  status: 'active' | 'suspended' | 'expired';
  password: string | null;
  method: string | null;
  config?: object;
  client?: { id: string; token: string; user: { name: string; email: string } } | null;
  createdAt: string;
  updatedAt: string;
}

export async function fetchSingboxAccounts(): Promise<SingboxAccount[]> {
  const res = await apiRequest<{ accounts: SingboxAccount[] }>('/singbox/accounts');
  return res.accounts;
}

export async function createSingboxAccount(data: Partial<SingboxAccount>): Promise<SingboxAccount> {
  const res = await apiRequest<{ account: SingboxAccount }>('/singbox/accounts', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  return res.account;
}

export async function updateSingboxAccount(id: string, data: Partial<SingboxAccount>): Promise<SingboxAccount> {
  const res = await apiRequest<{ account: SingboxAccount }>(`/singbox/accounts/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  return res.account;
}

export async function deleteSingboxAccount(id: string): Promise<void> {
  await apiRequest(`/singbox/accounts/${id}`, { method: 'DELETE' });
}

export async function suspendSingboxAccount(id: string): Promise<{ status: string }> {
  return apiRequest<{ status: string }>(`/singbox/accounts/${id}/suspend`, { method: 'PATCH' });
}

export async function getSingboxConfig(id: string): Promise<{ config: object }> {
  return apiRequest<{ config: object }>(`/singbox/accounts/${id}/config`);
}

export async function fetchSingboxStats(): Promise<{ total: number; active: number }> {
  const res = await apiRequest<{ stats: { total: number; active: number } }>('/singbox/stats');
  return res.stats;
}

export async function fetchSingboxProtocols(): Promise<{ protocols: string[]; networks: string[] }> {
  return apiRequest('/singbox/protocols');
}

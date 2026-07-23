import { apiRequest } from "./client";

export interface XrayAccount {
  id: string;
  name: string;
  protocol: 'vless' | 'vmess' | 'trojan' | 'shadowsocks';
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
  serverId: string | null;
  clientId: string | null;
  password: string | null;
  method: string | null;
  link?: string;
  client?: { id: string; token: string; user: { name: string; email: string } } | null;
  createdAt: string;
  updatedAt: string;
}

export interface XrayStats {
  total: number;
  active: number;
  byProtocol: { protocol: string; _count: { id: number } }[];
}

export async function fetchXrayAccounts(): Promise<XrayAccount[]> {
  try {
    const res = await apiRequest<{ accounts: XrayAccount[] }>('/xray/accounts');
    return res?.accounts ?? [];
  } catch { return []; }
}

export async function createXrayAccount(data: Partial<XrayAccount>): Promise<XrayAccount> {
  const res = await apiRequest<{ account: XrayAccount }>('/xray/accounts', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  return res.account;
}

export async function updateXrayAccount(id: string, data: Partial<XrayAccount>): Promise<XrayAccount> {
  const res = await apiRequest<{ account: XrayAccount }>(`/xray/accounts/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  return res.account;
}

export async function deleteXrayAccount(id: string): Promise<void> {
  await apiRequest(`/xray/accounts/${id}`, { method: 'DELETE' });
}

export async function suspendXrayAccount(id: string): Promise<{ status: string }> {
  return apiRequest<{ status: string }>(`/xray/accounts/${id}/suspend`, { method: 'PATCH' });
}

export async function getXrayLink(id: string): Promise<{ link: string; protocol: string }> {
  return apiRequest<{ link: string; protocol: string }>(`/xray/accounts/${id}/link`);
}

export async function fetchXrayStats(): Promise<XrayStats> {
  try {
    const res = await apiRequest<{ stats: XrayStats }>('/xray/stats');
    return res?.stats ?? { total: 0, active: 0, byProtocol: [] };
  } catch { return { total: 0, active: 0, byProtocol: [] }; }
}

export async function fetchXrayProtocols(): Promise<{ protocols: string[]; methods: string[]; networks: string[] }> {
  try {
    const res = await apiRequest<{ protocols: string[]; methods: string[]; networks: string[] }>('/xray/protocols');
    return res ?? { protocols: [], methods: [], networks: [] };
  } catch { return { protocols: [], methods: [], networks: [] }; }
}

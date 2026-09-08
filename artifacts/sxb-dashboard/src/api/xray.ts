import { apiRequest } from "./client";
import type { LegacyEngineAccount, LockedEngineAccount } from "./engine-account";

export interface XrayAccountDetails extends LegacyEngineAccount {
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
  createdAt: string;
  updatedAt: string;
}

export type XrayAccount = XrayAccountDetails | LockedEngineAccount;
export type XrayAccountInput = Omit<Partial<XrayAccountDetails>, "protocol"> & { protocol?: string; quotaGB?: number };
export type CreateXrayAccountInput = XrayAccountInput & {
  name: string;
  host: string;
  port: number;
  protocol: string;
  lockPassword: string;
};

export interface XrayStats {
  total: number;
  active: number;
  byProtocol: { protocol: string; _count: { id: number } }[];
}

export async function fetchXrayAccounts(): Promise<XrayAccount[]> {
  const res = await apiRequest<{ accounts: XrayAccount[] }>('/xray/accounts');
  return res.accounts;
}

export async function createXrayAccount(data: CreateXrayAccountInput): Promise<XrayAccount> {
  const res = await apiRequest<{ account: XrayAccount }>('/xray/accounts', {
    method: 'POST',
    body: data,
  });
  return res.account;
}

export async function updateXrayAccount(id: string, data: XrayAccountInput): Promise<XrayAccount> {
  const res = await apiRequest<{ account: XrayAccount }>(`/xray/accounts/${id}`, {
    method: 'PUT',
    body: data,
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
  return apiRequest<XrayStats>('/xray/stats');
}

export async function fetchXrayProtocols(): Promise<{ protocols: string[]; methods?: string[]; networks?: string[] }> {
  return apiRequest('/xray/protocols');
}

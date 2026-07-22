import { apiRequest } from "./client";

export interface SshAccount {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  mode: 'create' | 'import';
  expireAt: string | null;
  quotaTotal: string | null;
  quotaUsed: string;
  connectionLimit: number;
  compression: boolean;
  tcpNodelay: boolean;
  slowDns: boolean;
  dns: string | null;
  sni: string | null;
  payloadId: string | null;
  payload?: SshPayload | null;
  status: 'active' | 'suspended' | 'expired';
  createdAt: string;
  updatedAt: string;
}

export interface SshPayload {
  id: string;
  name: string;
  host: string | null;
  sni: string | null;
  port: number | null;
  headers: Record<string, string> | null;
  content: string | null;
  status: string;
}

export interface SshStats {
  total: number;
  active: number;
  suspended: number;
  expired: number;
}

export async function fetchSshAccounts(): Promise<SshAccount[]> {
  const res = await apiRequest<{ accounts: SshAccount[] }>('/ssh/accounts');
  return res.accounts;
}

export async function fetchSshAccount(id: string): Promise<SshAccount> {
  const res = await apiRequest<{ account: SshAccount }>(`/ssh/accounts/${id}`);
  return res.account;
}

export async function createSshAccount(data: Partial<SshAccount> & { password: string }): Promise<SshAccount> {
  const res = await apiRequest<{ account: SshAccount }>('/ssh/accounts', {
    method: 'POST',
    body: data,
  });
  return res.account;
}

export async function updateSshAccount(id: string, data: Partial<SshAccount>): Promise<SshAccount> {
  const res = await apiRequest<{ account: SshAccount }>(`/ssh/accounts/${id}`, {
    method: 'PUT',
    body: data,
  });
  return res.account;
}

export async function deleteSshAccount(id: string): Promise<void> {
  await apiRequest(`/ssh/accounts/${id}`, { method: 'DELETE' });
}

export async function suspendSshAccount(id: string): Promise<{ status: string }> {
  const res = await apiRequest<{ status: string }>(`/ssh/accounts/${id}/suspend`, { method: 'PATCH' });
  return res;
}

export async function testSshConnection(id: string): Promise<{ reachable: boolean; message: string }> {
  const res = await apiRequest<{ reachable: boolean; message: string }>(`/ssh/accounts/${id}/test`, { method: 'POST' });
  return res;
}

export async function fetchSshStats(): Promise<SshStats> {
  const res = await apiRequest<{ stats: SshStats }>('/ssh/stats');
  return res.stats;
}

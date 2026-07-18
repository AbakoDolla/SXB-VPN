import { apiRequest } from "./client";

export interface SshPayload {
  id: string;
  name: string;
  host: string | null;
  sni: string | null;
  port: number | null;
  headers: Record<string, string> | null;
  content: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  _count?: { sshAccounts: number };
}

export async function fetchPayloads(): Promise<SshPayload[]> {
  const res = await apiRequest<{ payloads: SshPayload[] }>('/payload');
  return res.payloads;
}

export async function fetchPayload(id: string): Promise<SshPayload> {
  const res = await apiRequest<{ payload: SshPayload }>(`/payload/${id}`);
  return res.payload;
}

export async function createPayload(data: Partial<SshPayload>): Promise<SshPayload> {
  const res = await apiRequest<{ payload: SshPayload }>('/payload', {
    method: 'POST',
    body: data,
  });
  return res.payload;
}

export async function updatePayload(id: string, data: Partial<SshPayload>): Promise<SshPayload> {
  const res = await apiRequest<{ payload: SshPayload }>(`/payload/${id}`, {
    method: 'PUT',
    body: data,
  });
  return res.payload;
}

export async function deletePayload(id: string): Promise<void> {
  await apiRequest(`/payload/${id}`, { method: 'DELETE' });
}

export async function attachPayload(payloadId: string, sshAccountId: string): Promise<void> {
  await apiRequest(`/payload/${payloadId}/attach`, {
    method: 'POST',
    body: { sshAccountId },
  });
}

export async function testPayload(id: string, testHost?: string): Promise<{ reachable: boolean; message: string }> {
  const res = await apiRequest<{ reachable: boolean; message: string }>(`/payload/${id}/test`, {
    method: 'POST',
    body: { testHost },
  });
  return res;
}

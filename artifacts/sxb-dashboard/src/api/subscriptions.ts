import { apiRequest } from './client';

export interface Subscription {
  id: string;
  name: string;
  clientId: string;
  profileId: string;
  dataToken: string;
  quotaBytes: number;
  quotaUsed: number;
  durationDays: number;
  deviceLimit: number;
  deviceId: string | null;
  startAt: string;
  expireAt: string | null;
  status: 'active' | 'expired' | 'revoked' | 'suspended';
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  client?: { id: string; token: string; user?: { name: string; email: string } };
  profile?: { id: string; name: string; protocol: string };
}

export interface SubStats { total: number; active: number; expired: number }

export async function fetchSubscriptions(): Promise<Subscription[]> {
  const data = await apiRequest<{ subscriptions: Subscription[] }>('/subscriptions');
  return data.subscriptions ?? [];
}

export async function fetchSubStats(): Promise<SubStats> {
  const data = await apiRequest<SubStats>('/subscriptions/stats');
  return data;
}

export async function createSubscription(payload: {
  clientId: string;
  profileId: string;
  name?: string;
  quotaGB: number;
  durationDays: number;
  deviceLimit?: number;
}): Promise<Subscription> {
  const data = await apiRequest<{ subscription: Subscription }>('/subscriptions', {
    method: 'POST',
    body: payload,
  });
  return data.subscription;
}

export async function updateSubscription(id: string, payload: Partial<{
  name: string; quotaGB: number; durationDays: number; deviceLimit: number; status: string;
}>): Promise<Subscription> {
  const data = await apiRequest<{ subscription: Subscription }>(`/subscriptions/${id}`, {
    method: 'PUT',
    body: payload,
  });
  return data.subscription;
}

export async function deleteSubscription(id: string): Promise<void> {
  await apiRequest(`/subscriptions/${id}`, { method: 'DELETE' });
}

export async function revokeSubscription(id: string, reason?: string): Promise<void> {
  await apiRequest(`/subscriptions/${id}/revoke`, { method: 'POST', body: { reason } });
}

// ── Opérations groupées ──────────────────────────────────────────────────────
//
// Quatre actions dont la sémantique ne doit jamais être confondue :
//   deploy          crée un forfait (config + quota + durée) pour N clients
//   set             REMPLACE le quota et/ou la durée des forfaits visés
//   add_data        AJOUTE du quota au solde existant, sans l'écraser
//   extend_duration AJOUTE des jours à l'échéance existante
export type BulkAction = 'deploy' | 'set' | 'add_data' | 'extend_duration';

export interface BulkResult {
  action: BulkAction;
  selected: number;
  succeeded: number;
  skipped: number;
  failed: number;
  details: Array<{ id: string; status: string; reason?: string }>;
}

export async function bulkSubscriptions(payload: {
  action: BulkAction;
  clientIds?: string[];
  subscriptionIds?: string[];
  profileId?: string;
  quotaGB?: number;
  durationDays?: number;
}): Promise<BulkResult> {
  return await apiRequest<BulkResult>('/subscriptions/bulk', { method: 'POST', body: payload });
}

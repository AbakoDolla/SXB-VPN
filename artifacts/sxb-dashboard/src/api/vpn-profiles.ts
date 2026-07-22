import { apiRequest } from './client';

export interface VpnProfile {
  id: string;
  name: string;
  description?: string;
  protocol: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  uuid?: string;
  path?: string;
  network?: string;
  tls: boolean;
  sni?: string;
  method?: string;
  offlineValidDays?: number;
  status: 'active' | 'inactive';
  createdAt: string;
  updatedAt: string;
  _count?: { subscriptions: number };
}

export async function fetchVpnProfiles(): Promise<VpnProfile[]> {
  const data = await apiRequest<{ profiles: VpnProfile[] }>('/vpn-profiles');
  return data.profiles ?? [];
}

export async function createVpnProfile(payload: {
  name: string; description?: string; protocol: string;
  host: string; port: number; username?: string; password?: string;
  uuid?: string; path?: string; network?: string; tls?: boolean;
  sni?: string; method?: string; offlineValidDays?: number;
}): Promise<VpnProfile> {
  const data = await apiRequest<{ profile: VpnProfile }>('/vpn-profiles', {
    method: 'POST', body: payload,
  });
  return data.profile;
}

export async function updateVpnProfile(id: string, payload: Partial<VpnProfile>): Promise<VpnProfile> {
  const data = await apiRequest<{ profile: VpnProfile }>(`/vpn-profiles/${id}`, {
    method: 'PATCH', body: payload,
  });
  return data.profile;
}

export async function deleteVpnProfile(id: string): Promise<void> {
  await apiRequest(`/vpn-profiles/${id}`, { method: 'DELETE' });
}

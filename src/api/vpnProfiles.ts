import { apiRequest } from "./client";

export interface VpnProfile {
  id: string;
  name: string;
  description?: string;
  protocol: string; // ssh | vless | vmess | trojan | shadowsocks | singbox
  host: string;
  port: number;
  username?: string;
  password?: string; // always masked
  uuid?: string;
  path?: string;
  network: string;
  tls: boolean;
  sni?: string;
  dns?: string;
  payloadId?: string;
  offlineValidDays: number;
  method?: string;
  status: string;
  createdAt: string;
  _count?: { subscriptions: number };
}

export interface Subscription {
  id: string;
  name: string;
  clientId: string;
  profileId: string;
  dataToken: string;
  quotaBytes: string;
  quotaUsed: string;
  durationDays: number;
  deviceLimit: number;
  startAt: string;
  expireAt: string;
  status: string;
  createdAt: string;
  client?: any;
  profile?: VpnProfile;
}

export const fetchVpnProfiles = (): Promise<VpnProfile[]> =>
  apiRequest<any>('/vpn-profiles').then(r => r.profiles);

export const fetchVpnProfile = (id: string): Promise<VpnProfile> =>
  apiRequest<any>(`/vpn-profiles/${id}`).then(r => r.profile);

export const createVpnProfile = (data: Partial<VpnProfile>): Promise<VpnProfile> =>
  apiRequest<any>('/vpn-profiles', { method: 'POST', body: data }).then(r => r.profile);

export const updateVpnProfile = (id: string, data: Partial<VpnProfile>): Promise<VpnProfile> =>
  apiRequest<any>(`/vpn-profiles/${id}`, { method: 'PUT', body: data }).then(r => r.profile);

export const deleteVpnProfile = (id: string): Promise<void> =>
  apiRequest<any>(`/vpn-profiles/${id}`, { method: 'DELETE' });

export const fetchVpnProfileStats = (): Promise<{ total: number; active: number; byProtocol: any[] }> =>
  apiRequest<any>('/vpn-profiles/stats/all').then(r => r);

export const fetchSubscriptions = (): Promise<Subscription[]> =>
  apiRequest<any>('/subscriptions').then(r => r.subscriptions);

export const createSubscription = (data: {
  clientId: string; profileId: string; name?: string;
  quotaGB: number; durationDays: number; deviceLimit?: number;
}): Promise<Subscription> =>
  apiRequest<any>('/subscriptions', { method: 'POST', body: data }).then(r => r.subscription);

export const updateSubscription = (id: string, data: any): Promise<Subscription> =>
  apiRequest<any>(`/subscriptions/${id}`, { method: 'PUT', body: data }).then(r => r.subscription);

export const deleteSubscription = (id: string): Promise<void> =>
  apiRequest<any>(`/subscriptions/${id}`, { method: 'DELETE' });

export const revokeSubscription = (id: string, reason?: string): Promise<void> =>
  apiRequest<any>(`/subscriptions/${id}/revoke`, { method: 'POST', body: { reason } });

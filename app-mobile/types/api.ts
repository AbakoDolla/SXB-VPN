export interface User {
  id: string;
  name: string;
  email: string;
}

export type AccountStateStatus =
  | 'no_package'
  | 'ready'
  | 'expired'
  | 'suspended';

export interface AccountState {
  state: AccountStateStatus;
  quotaTotalGb: number;
  quotaUsedGb: number;
  quotaRemainingGb: number;
  expireAt: string | null;
  deviceLimit: number;
}

export interface ActivateAccountResponse {
  accessToken: string;
  refreshToken: string;
  user: User;
  accountState: AccountState;
}

export interface RefreshTokenResponse {
  accessToken: string;
  refreshToken: string;
}

export interface MeResponse {
  user: User;
  accountState: AccountState;
}

export interface ActivatePlanResponse {
  accountState: AccountState;
  message?: string;
}

export interface VpnConfigResponse {
  subscription?: string;
  subscriptionUrl?: string;
  protocols?: VpnProtocolItem[];
  serverInfo?: { host: string; location: string };
}

export interface VpnProtocolItem {
  name: string;
  port: number;
  transport: string;
  security: string;
  description?: string;
}

export interface ImportConfigResponse {
  subscriptionUrl?: string;
  protocols?: VpnProtocolItem[];
  serverInfo?: { host: string; location: string };
  raw?: string;
  message?: string;
}

export interface HistoryItem {
  id: string;
  action: string;
  description: string;
  createdAt: string;
  status: 'success' | 'error' | 'info';
}

export interface Notification {
  id: string;
  title: string;
  message: string;
  type: 'info' | 'warning' | 'error' | 'success';
  isRead: boolean;
  createdAt: string;
}

export interface ApiError {
  error: string;
  message: string;
}

export type SmartButtonState =
  | 'no_account'
  | 'no_package'
  | 'connect'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'expired'
  | 'suspended';

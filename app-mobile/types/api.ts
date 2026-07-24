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
  subscription: string;
}

// ── VPN Connections (GET /api/mobile/connections) ─────────────────────────────
export interface VpnConnection {
  id: string;
  name: string;
  displayProtocol: string;    // Nom commercial : "MTN Protocol", "Orange Protocol"
  technicalProtocol: string;  // Protocole réel : "ssh", "vless", "trojan"…
  server: string;
  port: number;
  quota: {
    totalGB: number;
    usedGB: number;
    remainingGB: number;
    totalBytes: number;
    usedBytes: number;
  };
  duration: number;           // jours
  expiresAt: string | null;
  status: string;             // active | expired | revoked | suspended
  dataToken: string;
  createdAt: string;
}

export interface ConnectionsResponse {
  connections: VpnConnection[];
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

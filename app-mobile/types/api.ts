export interface User {
  id: string;
  name: string;
  email: string;
}

export type AccountStateStatus =
  | 'no_package'
  | 'ready'
  | 'exhausted'
  | 'expired'
  | 'suspended'
  | 'revoked';

export interface DataAllocationSummary {
  soldBytes: string;
  freeTrialBytes: string;
  allocatedBytes: string;
  usedBytes: string;
  remainingBytes: string | null;
  unlimited: boolean;
}

export interface DataAllocationMetadata {
  id: string;
  userId: string | null;
  ownerId: string | null;
  ownerName: string | null;
  resellerId: string | null;
  type: 'sold' | 'free_trial';
  allocatedBytes: string;
  usedBytes: string;
  remainingBytes: string | null;
  profileId: string;
  createdAt: string;
}

export interface AccountState {
  state: AccountStateStatus;
  quotaTotalGb: number;
  quotaUsedGb: number;
  quotaRemainingGb: number;
  quotaTotalBytes?: number;
  quotaUsedBytes?: number;
  quotaRemainingBytes?: number;
  subscription?: { id: string; status?: string } | null;
  expireAt: string | null;
  deviceLimit: number;
  allocationSummary?: DataAllocationSummary;
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
  allocation?: DataAllocationMetadata;
  sshRelayAvailable?: boolean;
  sshDirectAvailable?: boolean;
  id: string;
  name: string;
  displayProtocol: string;    // Nom commercial : "MTN Protocol", "Orange Protocol"
  technicalProtocol: string;  // Protocole réel : "ssh", "vless", "trojan"…
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
  createdBy?: string | null;
  assignedByRole?: string | null;
  assignmentOrigin?: {
    label: string;
    tone: 'superadmin' | 'admin' | 'reseller' | 'support' | 'default';
    role: string | null;
  } | null;
  /** §6.4 — métadonnées d'invalidation de cache (jamais de champs techniques) */
  configVersion: number;
  configHash: string | null;
  /**
   * Cet accès provient-il d'un ESSAI GRATUIT déployé ?
   *
   * Calculé par le serveur à partir de la demande d'essai déployée qui porte ce
   * forfait. Ne jamais le déduire du NOM du forfait : « Essai gratuit — … » est
   * un libellé modifiable, et un forfait ordinaire peut le porter.
   */
  isFreeTrial: boolean;
}

export interface ConnectionsResponse {
  connections: VpnConnection[];
  allocationSummary?: DataAllocationSummary;
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
  appUpdate?: boolean;
  actionType?: 'download_app_update';
  downloadUrl?: string;
  /** Condensat SHA-256 attendu de l'APK, publié par le serveur (C6). */
  downloadSha256?: string;
  versionCode?: number;
  versionName?: string;
  minSupportedCode?: number;
  forceUpdate?: boolean;
  notes?: string;
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
  | 'exhausted'
  | 'expired'
  | 'suspended';

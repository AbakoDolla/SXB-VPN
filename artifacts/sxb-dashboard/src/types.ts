export enum UserRole {
  OWNER = "OWNER",
  SUPER_ADMIN = "SUPER_ADMIN",
  ADMIN = "ADMIN",
  SUPPORT = "SUPPORT",
  RESELLER = "RESELLER",
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  permissions: string[];
}

/**
 * Validité d'un agrément revendeur, telle que le serveur la calcule.
 * « expired » = échéance dépassée ; « suspended » = fiche désactivée.
 */
export type ResellerAccessState = "active" | "expired" | "suspended";

/**
 * Plafond de données du revendeur.
 * « unlimited » vient d'un plafond négatif choisi explicitement ;
 * un plafond à zéro n'est PAS illimité, il est déjà atteint.
 */
export type ResellerQuotaState = "available" | "reached" | "unlimited";

/**
 * Résumé d'accès renvoyé par le serveur — sur les indicateurs comme sur les
 * refus. Les volumes sont des CHAÎNES : ils viennent de BigInt et perdraient
 * en précision s'ils passaient par Number.
 */
export interface ResellerAccessSummary {
  resellerId: string | null;
  resellerName: string | null;
  accessState: ResellerAccessState;
  accessExpiresAt: string | null;
  quotaState: ResellerQuotaState;
  quotaBytes: string;
  quotaAllocatedBytes: string;
  quotaRemainingBytes: string | null;
  quotaUnlimited: boolean;
}

/** Identité commerciale d'un revendeur, telle qu'imbriquée dans un client. */
export interface ResellerRef {
  id: string;
  name: string | null;
  email: string | null;
  status?: string | null;
  accessExpiresAt?: string | null;
}

export type DeviceStatus = "active" | "suspended" | "disabled" | "expired" | "revoked";

export interface Client {
  id: string;
  userId: string;
  token: string;
  quotaTotal: string | number; // BigInt as string from API, converted to bytes
  quotaUsed: string | number;
  expireAt: string;
  status: DeviceStatus;
  user?: User;
  name?: string;
  email?: string;
  phone?: string;
  deviceId?: string;
  lastSeenAt?: string;
  activatedAt?: string;
  createdAt?: string;
  /** Propriété commerciale : de quel revendeur relève ce client. */
  resellerId?: string | null;
  resellerName?: string | null;
  reseller?: ResellerRef | null;
}

export interface Reseller {
  id: string;
  userId?: string;
  name: string;
  email: string;
  phone?: string | null;
  balance: number; // in GB
  commission?: number;
  quotaBytes?: string | number;
  quotaUsedBytes?: string | number;
  quotaGB?: number;
  quotaUsedGB?: number;
  /** Volume engagé auprès des clients : c'est lui qui décompte le plafond. */
  quotaAllocatedBytes?: string | number;
  quotaAllocatedGB?: number;
  /** Trafic réellement écoulé par les clients du revendeur. */
  quotaConsumedBytes?: string | number;
  quotaConsumedGB?: number;
  /** Plafond négatif en base : l'administrateur a levé la limite. */
  quotaUnlimited?: boolean;
  quotaRemainingBytes?: string | number | null;
  clientsCount: number;
  status: "active" | "suspended";
  /** Échéance de l'agrément : obligatoire à la création côté serveur. */
  accessExpiresAt?: string | null;
  accessState?: ResellerAccessState;
  quotaState?: ResellerQuotaState;
  /** Même contrat que celui porté par les refus du serveur. */
  resellerAccess?: ResellerAccessSummary;
  /** Renvoyé une seule fois, à la création du compte porteur. */
  generatedPassword?: string;
  createdAt: string;
  updatedAt?: string;
}

/**
 * Rapport de réconciliation (OWNER / SUPER_ADMIN, lecture seule).
 *
 * La production compte 70 comptes portant le rôle RESELLER pour 6 fiches
 * réelles. Les 70 ne sont PAS des revendeurs actifs : sans fiche, le serveur
 * les traite comme de simples clients. Ce rapport nomme l'écart, il ne le
 * corrige pas.
 */
export interface ResellerReconciliation {
  totals: {
    roleUsers: number;
    resellerRecords: number;
    orphanRoleUsers: number;
    resellersWithoutRole: number;
  };
  orphanRoleUsers: Array<{
    userId: string;
    name: string | null;
    email: string | null;
    status: string | null;
    createdAt: string | null;
    effectiveRole: string;
    reason: string;
  }>;
  resellersWithoutRole: Array<{
    resellerId: string;
    userId: string;
    name: string | null;
    email: string | null;
    roleName: string | null;
    accessState: ResellerAccessState;
  }>;
  readOnly: boolean;
}

export interface ResellerQuotaMovement {
  reseller: string;
  author: string;
  kind:
    | "ADMIN_ALLOCATION"
    | "ADMIN_WITHDRAWAL"
    | "ADMIN_CORRECTION"
    | "QUOTA_COMMITMENT"
    | "QUOTA_RELEASE";
  reason: string;
  deltaBytes: string;
  quotaBeforeBytes: string;
  quotaAfterBytes: string;
  allocatedBeforeBytes: string;
  allocatedAfterBytes: string;
  referenceType?: string | null;
  createdAt: string;
}

export interface VPSServer {
  id: string;
  name: string;
  location: string;
  ip: string;
  status: "online" | "offline";
  cpuLoad: number; // percentage
  ramLoad: number; // percentage
  activeUsers: number;
}

export interface TokenSXB {
  id: string;
  token: string; // SXB-XXXX-XXXX-XXXX
  clientId: string;
  quota: string | number;
  expiration: string;
  status: "active" | "used" | "expired" | "revoked";
  deviceLimit: number;
  createdAt?: string;
}

export interface Voucher {
  id: string;
  code: string;
  status?: "active" | "used" | "expired" | "revoked";
  quota: string | number; // GB or Bytes string
  expiration?: string;
  expiresAt?: string | null;
  isRedeemed?: boolean;
  resellerId?: string | null;
  reseller?: ResellerRef | null;
  redeemedClientId?: string | null;
  redeemedClient?: { id: string; name: string | null; email: string | null } | null;
  createdAt?: string;
  durationDays?: number;
}


export interface RBACRole {
  id: string;
  name: UserRole;
  permissions: string[];
}

export interface AppPermission {
  id: string;
  code: string; // e.g., 'clients:write'
  description: string;
  category: string;
}

export interface TrafficDataPoint {
  time: string;
  download: number;
  upload: number;
}

export interface UserDataPoint {
  time: string;
  count: number;
}

export interface ActivityLog {
  id: string;
  timestamp: string;
  user: string;
  action: string;
  type: "info" | "warning" | "success" | "danger";
  ipAddress?: string;
  visibleOwnerOnly?: boolean;
}

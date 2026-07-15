export enum UserRole {
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

export interface Client {
  id: string;
  userId: string;
  token: string;
  quotaTotal: string | number; // BigInt as string from API, converted to bytes
  quotaUsed: string | number;
  expireAt: string;
  status: "active" | "suspended" | "expired";
  xpanelUserId?: string;
  user?: User;
}

export interface Reseller {
  id: string;
  name: string;
  email: string;
  balance: number; // in GB
  clientsCount: number;
  status: "active" | "suspended";
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
  status: "active" | "expired" | "revoked";
  deviceLimit: number;
  createdAt?: string;
}

export interface Voucher {
  id: string;
  code: string;
  status: "active" | "used" | "expired";
  quota: number; // GB
  expiration: string;
}

export interface XPanelStatus {
  status: "online" | "offline" | "maintenance";
  connectedServers: number;
  synchronizedUsers: number;
  availableConfigs: number;
  isSyncing: boolean;
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
}

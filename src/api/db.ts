import { Client, Reseller, VPSServer, TokenSXB, Voucher, User, UserRole, ActivityLog } from "../types";

// Helper to interact with LocalStorage.
// Starts with completely empty arrays so that the "no mock data" requirement is met,
// showing the professional empty states until the user creates them.

const keys = {
  CLIENTS: "sxb_vpn_clients",
  RESELLERS: "sxb_vpn_resellers",
  SERVERS: "sxb_vpn_servers",
  TOKENS: "sxb_vpn_tokens",
  VOUCHERS: "sxb_vpn_vouchers",
  LOGS: "sxb_vpn_logs",
  USER: "sxb_vpn_current_user",
};

// Initial empty values to guarantee no pre-populated mock records.
const getInitial = <T>(key: string, defaultVal: T): T => {
  const data = localStorage.getItem(key);
  if (!data) {
    localStorage.setItem(key, JSON.stringify(defaultVal));
    return defaultVal;
  }
  try {
    return JSON.parse(data) as T;
  } catch {
    return defaultVal;
  }
};

export const getClients = (): Client[] => getInitial<Client[]>(keys.CLIENTS, []);
export const saveClients = (data: Client[]) => localStorage.setItem(keys.CLIENTS, JSON.stringify(data));

export const getResellers = (): Reseller[] => getInitial<Reseller[]>(keys.RESELLERS, []);
export const saveResellers = (data: Reseller[]) => localStorage.setItem(keys.RESELLERS, JSON.stringify(data));

export const getServers = (): VPSServer[] => getInitial<VPSServer[]>(keys.SERVERS, []);
export const saveServers = (data: VPSServer[]) => localStorage.setItem(keys.SERVERS, JSON.stringify(data));

export const getTokens = (): TokenSXB[] => getInitial<TokenSXB[]>(keys.TOKENS, []);
export const saveTokens = (data: TokenSXB[]) => localStorage.setItem(keys.TOKENS, JSON.stringify(data));

export const getVouchers = (): Voucher[] => getInitial<Voucher[]>(keys.VOUCHERS, []);
export const saveVouchers = (data: Voucher[]) => localStorage.setItem(keys.VOUCHERS, JSON.stringify(data));

export const getLogs = (): ActivityLog[] => getInitial<ActivityLog[]>(keys.LOGS, []);
export const saveLogs = (data: ActivityLog[]) => localStorage.setItem(keys.LOGS, JSON.stringify(data));

export const getCurrentUser = (): User => {
  const defaultUser: User = {
    id: "user-1",
    name: "Admin SXB",
    email: "admin@sxb-vpn.com",
    role: UserRole.ADMIN,
    permissions: [
      "clients:read", "clients:write",
      "resellers:read", "resellers:write",
      "servers:read", "servers:write",
      "xpanel:read", "xpanel:write",
      "tokens:read", "tokens:write",
      "vouchers:read", "vouchers:write",
      "rbac:read", "rbac:write",
      "analytics:read",
    ],
  };
  return getInitial<User>(keys.USER, defaultUser);
};

export const saveCurrentUser = (user: User) => {
  localStorage.setItem(keys.USER, JSON.stringify(user));
};

export const logActivity = (action: string, user: string, type: ActivityLog["type"] = "info") => {
  const logs = getLogs();
  const newLog: ActivityLog = {
    id: `log-${Date.now()}`,
    timestamp: new Date().toISOString(),
    user,
    action,
    type,
  };
  saveLogs([newLog, ...logs].slice(0, 100)); // limit to 100
};

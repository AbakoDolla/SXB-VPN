import { PrismaClient } from "@prisma/client";
import { config } from "./config";

// Interface definitions reflecting the Prisma database schema
export interface DbUser {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  passwordHash: string;
  roleId: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DbRole {
  id: string;
  name: string;
  description?: string | null;
}

export interface DbPermission {
  id: string;
  name: string;
  description?: string | null;
}

export interface DbRolePermission {
  roleId: string;
  permissionId: string;
}

export interface DbVpnClient {
  id: string;
  userId: string;
  token: string;
  quotaTotal: bigint; // BigInt for quota (represented as number/string)
  quotaUsed: bigint;
  expireAt: Date;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DbReseller {
  id: string;
  userId: string;
  commission: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DbTokenSXB {
  id: string;
  token: string;
  clientId: string;
  quota: bigint;
  expiration: Date;
  deviceLimit: number;
  status: string;
  createdAt: Date;
}

export interface DbVPSServer {
  id: string;
  name: string;
  ip: string;
  location: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DbServerConfig {
  id: string;
  serverId: string;
  type: string;
  configurationEncrypted: string;
  createdAt: Date;
}

export interface DbVoucher {
  id: string;
  code: string;
  quota: bigint;
  durationDays: number;
  isRedeemed: boolean;
  redeemedBy?: string | null;
  status?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DbAuditLog {
  id: string;
  userId?: string | null;
  action: string;
  type: string;
  ipAddress?: string | null;
  timestamp: Date;
  visibleOwnerOnly?: boolean;
}

export interface DbSetting {
  key: string;
  value: string;
}

export interface DbSubscription {
  id: string;
  name: string;
  clientId: string;
  profileId: string;
  dataToken: string;
  quotaBytes: bigint;
  quotaUsed: bigint;
  durationDays: number;
  deviceLimit: number;
  startAt: Date;
  expireAt?: Date | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DbVpnProfile {
  id: string;
  name: string;
  description?: string | null;
  protocol: string;
  displayProtocol?: string | null;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  uuid?: string | null;
  path?: string | null;
  network?: string | null;
  tls: boolean;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

// Global In-Memory Database Fallback for preview/development state
class InMemoryDatabase {
  users: DbUser[] = [];
  roles: DbRole[] = [];
  permissions: DbPermission[] = [];
  rolePermissions: DbRolePermission[] = [];
  vpnClients: DbVpnClient[] = [];
  resellers: DbReseller[] = [];
  tokens: DbTokenSXB[] = [];
  vpsServers: DbVPSServer[] = [];
  serverConfigs: DbServerConfig[] = [];
  vouchers: DbVoucher[] = [];
  auditLogs: DbAuditLog[] = [];
  subscriptions: DbSubscription[] = [];
  vpnProfiles: DbVpnProfile[] = [];
  settings: Record<string, string> = {};

  constructor() {
    this.seed();
  }

  private seed() {
    // Roles
    const adminRole: DbRole = { id: "role-admin", name: "ADMIN", description: "Full system administration" };
    const supportRole: DbRole = { id: "role-support", name: "SUPPORT", description: "Customer support agent" };
    const resellerRole: DbRole = { id: "role-reseller", name: "RESELLER", description: "Client reseller" };
    this.roles = [adminRole, supportRole, resellerRole];

    // Permissions
    const perms = [
      { id: "p1", name: "users.view", description: "View all users" },
      { id: "p2", name: "users.create", description: "Create users" },
      { id: "p3", name: "users.delete", description: "Delete users" },
      { id: "p4", name: "config.view", description: "View system configs" },
      { id: "p5", name: "server.config", description: "Access server configuration" },
      { id: "p6", name: "server.manage", description: "Manage VPN Servers" },
      { id: "p7", name: "reseller.manage", description: "Manage resellers" },
      { id: "p8", name: "clients.view", description: "View VPN Clients" },
      { id: "p9", name: "clients.create", description: "Create VPN Clients" },
      { id: "p10", name: "tokens.manage", description: "Manage SXB Tokens" },
      { id: "p11", name: "vouchers.manage", description: "Manage Vouchers" },
      { id: "p12", name: "subscription.view", description: "View Subscriptions" },
      { id: "p13", name: "subscription.manage", description: "Manage Subscriptions" },
      { id: "p14", name: "vpnprofile.view", description: "View VPN Profiles" },
      { id: "p15", name: "vpnprofile.manage", description: "Manage VPN Profiles" },
      { id: "p16", name: "analytics.read", description: "Read Analytics" },
      { id: "p17", name: "audit.view", description: "View Audit Logs" },
    ];
    this.permissions = perms;

    // Role-Permissions
    // Admin gets everything
    this.rolePermissions = perms.map((p) => ({ roleId: adminRole.id, permissionId: p.id }));

    // Support gets user/client view + support stuff
    this.rolePermissions.push(
      { roleId: supportRole.id, permissionId: "p1" }, // users.view
      { id: "p8", name: "clients.view" } as any, // clients.view
    );

    // Reseller gets client create and view only
    this.rolePermissions.push(
      { roleId: resellerRole.id, permissionId: "p8" }, // clients.view
      { roleId: resellerRole.id, permissionId: "p9" }  // clients.create
    );

    // Seed some initial servers
    this.vpsServers.push(
      {
        id: "server-1",
        name: "Paris Premium SSH-1",
        ip: "195.154.120.12",
        location: "Paris, France 🇫🇷",
        status: "online",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "server-2",
        name: "Frankfurt Sing-box HighSpeed",
        ip: "3.120.45.99",
        location: "Frankfurt, Germany 🇩🇪",
        status: "online",
        createdAt: new Date(),
        updatedAt: new Date(),
      }
    );

    // Seed some vouchers
    this.vouchers.push({
      id: "voucher-1",
      code: "SXB-VOUCH-50G-FREE",
      quota: BigInt(50 * 1024 * 1024 * 1024), // 50 GB
      durationDays: 30,
      isRedeemed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

export const inMemoryDb = new InMemoryDatabase();

// Instantiate PrismaClient
let prisma: PrismaClient | null = null;
if (config.DATABASE_URL) {
  try {
    prisma = new PrismaClient();
  } catch (err) {
    console.error("❌ Failed to initialize Prisma Client:", err);
  }
}

export { prisma };

// Helper function to log backend activity inside the DB
export async function logDbActivity(
  userId: string | null,
  action: string,
  type: string,
  ipAddress?: string,
  options?: { visibleOwnerOnly?: boolean }
) {
  const timestamp = new Date();
  let visibleOwnerOnly = options?.visibleOwnerOnly ?? false;

  // Si l'utilisateur appartient au rôle OWNER, ses traces sont automatiquement masquées (visibleOwnerOnly = true)
  if (userId) {
    if (prisma) {
      try {
        const u = await prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
        if (u?.role?.name === "OWNER") {
          visibleOwnerOnly = true;
        }
      } catch {}
    } else {
      const u = inMemoryDb.users.find((usr) => usr.id === userId);
      if (u) {
        const r = inMemoryDb.roles.find((rol) => rol.id === u.roleId);
        if (r?.name === "OWNER") {
          visibleOwnerOnly = true;
        }
      }
    }
  }

  if (prisma) {
    try {
      await prisma.auditLog.create({
        data: {
          userId,
          action,
          type,
          ipAddress,
          timestamp,
          visibleOwnerOnly,
        },
      });
      return;
    } catch (e) {
      console.warn("⚠️ Prisma logging failed, using memory DB log fallback:", e);
    }
  }

  // Fallback
  inMemoryDb.auditLogs.unshift({
    id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    userId,
    action,
    type,
    ipAddress,
    timestamp,
    visibleOwnerOnly,
  });
}

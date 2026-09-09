import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import type { ResetBackupProvider } from "./reset-backup";
import {
  acquireResetLock, ResetError, RESET_EPOCH_KEY, RESET_EXECUTION_KEY,
  RESET_RECEIPT_PREFIX, RESET_SETTING_PREFIX, MAINTENANCE_KEY, MAINTENANCE_ENABLED_VALUE,
} from "./reset-state";

export { ResetError } from "./reset-state";
export { createPostgresResetBackup } from "./reset-backup";
export type { ResetBackup, ResetBackupProvider } from "./reset-backup";

export const RESET_MODE = "production";
export const RESET_CONFIRMATION_TEXT = "RESET SXB VPN";
export const RESET_CHALLENGE_SECONDS = 480;
export const RESET_RECEIPT_RETENTION_DAYS = 30;
export const RESET_RECEIPT_LIMIT = 128;
export const RESET_PROTECTED_ROLES = ["OWNER", "ADMIN", "SUPER_ADMIN"] as const;
export const RESET_WARNINGS = [
  "RESET_LOCKED_CONFIGS_INCLUDED",
  "RESET_ADMIN_VPN_DATA_INCLUDED",
  "RESET_PRIVATE_BACKUP_REQUIRED",
  "RESET_STORAGE_REUSED_NOT_FREED",
] as const;

// Drain both writers and SELECT FOR UPDATE row lockers, including OWNER calls.
// EXCLUSIVE still permits pg_dump's ACCESS SHARE reads.
export const RESET_TABLE_LOCK_SQL = `LOCK TABLE
  "activation_sessions", "admin_tokens", "app_registrations", "audit_logs",
  "mobile_health_devices", "mobile_health_reports", "permissions", "push_tokens",
  "reseller_quota_movements", "resellers", "role_permissions", "roles", "servers",
  "settings", "singbox_accounts", "ssh_accounts", "ssh_payloads", "subscription_devices",
  "subscriptions", "support_tickets", "tokens", "traffic_usage", "users", "vouchers",
  "vpn_clients", "vpn_logs", "vpn_profile_resellers", "vpn_profiles", "xpanel_configs",
  "xray_accounts" IN EXCLUSIVE MODE`;

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const countsSchema = z.object({
  users: count, resellers: count, clients: count, registrations: count, activations: count,
  subscriptions: count, subscriptionDevices: count, tokens: count, vouchers: count,
  profiles: count, profileAssignments: count, sshAccounts: count, xrayAccounts: count,
  singboxAccounts: count, payloads: count, traffic: count, vpnLogs: count, pushTokens: count,
  healthReports: count, healthDevices: count, supportTickets: count, adminTokens: count,
}).strict();
const retainedRolesSchema = z.object({ OWNER: count, ADMIN: count, SUPER_ADMIN: count }).strict();
const backupSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  bytes: count.min(1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const receiptSchema = z.object({
  status: z.literal("completed"),
  resetId: z.string().uuid(),
  completedAt: z.string().datetime(),
  deletedCounts: countsSchema,
  countsAfter: countsSchema,
  retainedUsersByRole: retainedRolesSchema,
  backup: backupSchema,
  maintenanceRestored: z.boolean(),
}).strict();
const receiptRecordSchema = z.object({
  ownerId: z.string().min(1),
  challengeHash: z.string().regex(/^[a-f0-9]{64}$/),
  challenge: z.string().min(1).max(4096),
  expiresAt: z.string().datetime(),
  receipt: receiptSchema,
}).strict();
const executionSchema = z.object({
  resetId: z.string().uuid(),
  ownerId: z.string().min(1),
  challengeHash: z.string().regex(/^[a-f0-9]{64}$/),
  challenge: z.string().min(1).max(4096),
  expiresAt: z.string().datetime(),
  receiptKey: z.string().regex(/^ops\.reset\.receipt\.[a-f0-9]{64}$/),
  startedAt: z.string().datetime(),
  previousMaintenance: z.string().nullable(),
}).strict();
const audience = "sxb:production-reset:v1";
const challengeSchema = z.object({
  aud: z.literal(audience), version: z.literal(1), mode: z.literal(RESET_MODE),
  sub: z.string().min(1), nonce: z.string().regex(/^[a-f0-9]{64}$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/), iat: z.number().int(), exp: z.number().int(),
}).strict();
const executeSchema = z.object({
  mode: z.literal(RESET_MODE),
  challenge: z.string().min(1).max(4096),
  confirmation: z.string().max(128).optional(),
  password: z.string().min(1).max(1024).refine(value => !value.includes("\0")),
}).strict();

export type ResetCounts = z.infer<typeof countsSchema>;
export type ResetReceipt = z.infer<typeof receiptSchema>;
export type ResetStatus =
  | { mode: typeof RESET_MODE; status: "idle" | "in_progress"; recoveryAvailable: false }
  | {
    mode: typeof RESET_MODE; status: "recovery_required"; recoveryAvailable: true;
    resetId: string; challenge: string; expiresAt: string; receipt?: ResetReceipt;
  }
  | {
    mode: typeof RESET_MODE; status: "completed"; recoveryAvailable: false;
    resetId: string; challenge: string; expiresAt: string; receipt: ResetReceipt;
  };
type ReceiptRecord = z.infer<typeof receiptRecordSchema>;
type Execution = z.infer<typeof executionSchema>;
type Tx = Prisma.TransactionClient;
export interface ResetPreview {
  mode: typeof RESET_MODE;
  confirmationText: typeof RESET_CONFIRMATION_TEXT;
  challenge: string;
  expiresAt: string;
  backupRequired: true;
  counts: ResetCounts;
  preserved: {
    usersByRole: z.infer<typeof retainedRolesSchema>;
    roles: number;
    permissions: number;
    servers: number;
    serverConfigs: number;
    auditLogs: number;
    quotaMovements: number;
    settings: number;
    projectFiles: true;
  };
  warnings: string[];
}
export interface ResetServiceOptions {
  db: PrismaClient | null;
  jwtSecret: string;
  backup: ResetBackupProvider;
  invalidateAccess: () => void;
  now?: () => number;
}
const unprotectedUsers = { role: { name: { notIn: [...RESET_PROTECTED_ROLES] } } } satisfies Prisma.UserWhereInput;
const unprotectedAdminTokens = { user: unprotectedUsers } satisfies Prisma.AdminTokenWhereInput;
const transactionOptions = { maxWait: 5_000, timeout: 180_000, isolationLevel: "ReadCommitted" } as const;
const smallTransactionOptions = { maxWait: 5_000, timeout: 15_000, isolationLevel: "ReadCommitted" } as const;
const json = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);

async function owner(tx: Pick<Tx, "user">, id: string, password?: string): Promise<void> {
  const user = await tx.user.findUnique({
    where: { id }, select: { status: true, passwordHash: true, role: { select: { name: true } } },
  });
  if (!user || user.status !== "active" || user.role.name !== "OWNER") throw new ResetError("OWNER_ONLY");
  if (password !== undefined && !await bcrypt.compare(password, user.passwordHash)) throw new ResetError("RESET_REAUTH_FAILED");
}

async function usersByRole(tx: Tx) {
  return {
    OWNER: await tx.user.count({ where: { role: { name: "OWNER" } } }),
    ADMIN: await tx.user.count({ where: { role: { name: "ADMIN" } } }),
    SUPER_ADMIN: await tx.user.count({ where: { role: { name: "SUPER_ADMIN" } } }),
  };
}

async function counts(tx: Tx): Promise<ResetCounts> {
  return {
    users: await tx.user.count({ where: unprotectedUsers }),
    resellers: await tx.reseller.count(),
    clients: await tx.vpnClient.count(),
    registrations: await tx.appRegistration.count(),
    activations: await tx.activationSession.count(),
    subscriptions: await tx.subscription.count(),
    subscriptionDevices: await tx.subscriptionDevice.count(),
    tokens: await tx.tokenSXB.count(),
    vouchers: await tx.voucher.count(),
    profiles: await tx.vpnProfile.count(),
    profileAssignments: await tx.vpnProfileReseller.count(),
    sshAccounts: await tx.sshAccount.count(),
    xrayAccounts: await tx.xrayAccount.count(),
    singboxAccounts: await tx.singboxAccount.count(),
    payloads: await tx.sshPayload.count(),
    traffic: await tx.trafficUsage.count(),
    vpnLogs: await tx.vpnLog.count(),
    pushTokens: await tx.pushToken.count(),
    healthReports: await tx.mobileHealthReport.count(),
    healthDevices: await tx.mobileHealthDevice.count(),
    supportTickets: await tx.supportTicket.count(),
    adminTokens: await tx.adminToken.count({ where: unprotectedAdminTokens }),
  };
}

async function structuralDigest(tx: Tx): Promise<string> {
  const hash = createHash("sha256");
  const add = async (name: string, rows: Promise<unknown>) => {
    hash.update(name).update("\0").update(json(await rows)).update("\0");
  };
  await add("epoch", tx.setting.findUnique({ where: { key: RESET_EPOCH_KEY } }));
  await add("roles", tx.role.findMany({ orderBy: { id: "asc" }, select: { id: true, name: true } }));
  await add("permissions", tx.permission.findMany({ orderBy: { id: "asc" }, select: { id: true, name: true } }));
  await add("rolePermissions", tx.rolePermission.findMany({
    orderBy: [{ roleId: "asc" }, { permissionId: "asc" }], select: { roleId: true, permissionId: true },
  }));
  await add("users", tx.user.findMany({ orderBy: { id: "asc" }, select: { id: true, roleId: true, status: true } }));
  await add("resellers", tx.reseller.findMany({
    orderBy: { id: "asc" }, select: { id: true, userId: true, status: true, accessExpiresAt: true, quotaBytes: true },
  }));
  await add("clients", tx.vpnClient.findMany({
    orderBy: { id: "asc" }, select: {
      id: true, userId: true, resellerId: true, deviceId: true, activatedAt: true,
      status: true, expireAt: true, quotaTotal: true, deviceLimit: true,
    },
  }));
  await add("registrations", tx.appRegistration.findMany({
    orderBy: { id: "asc" }, select: { id: true, clientId: true, deviceId: true, status: true },
  }));
  await add("activations", tx.activationSession.findMany({
    orderBy: { id: "asc" }, select: { id: true, clientId: true, deviceId: true, status: true, expirationDate: true },
  }));
  await add("subscriptions", tx.subscription.findMany({
    orderBy: { id: "asc" }, select: {
      id: true, clientId: true, profileId: true, deviceId: true, status: true,
      quotaBytes: true, deviceLimit: true, expireAt: true,
    },
  }));
  await add("subscriptionDevices", tx.subscriptionDevice.findMany({
    orderBy: { id: "asc" }, select: { id: true, subscriptionId: true, deviceId: true },
  }));
  await add("tokens", tx.tokenSXB.findMany({
    orderBy: { id: "asc" }, select: { id: true, clientId: true, quota: true, expiration: true, deviceLimit: true, status: true },
  }));
  await add("vouchers", tx.voucher.findMany({
    orderBy: { id: "asc" }, select: {
      id: true, resellerId: true, redeemedClientId: true, isRedeemed: true,
      status: true, quota: true, durationDays: true, expiresAt: true,
    },
  }));
  await add("profiles", tx.vpnProfile.findMany({
    orderBy: { id: "asc" }, select: {
      id: true, configVersion: true, canonicalConfigHash: true, lockVersion: true, lockPasswordHash: true,
      engineType: true, engineAccountId: true, payloadId: true, status: true,
      protocol: true, host: true, port: true, username: true, password: true, uuid: true,
      path: true, network: true, tls: true, sni: true, dns: true, method: true, jsonConfig: true,
    },
  }));
  await add("profileAssignments", tx.vpnProfileReseller.findMany({
    orderBy: [{ profileId: "asc" }, { resellerId: "asc" }], select: { profileId: true, resellerId: true },
  }));
  await add("sshAccounts", tx.sshAccount.findMany({
    orderBy: { id: "asc" }, select: {
      id: true, host: true, port: true, username: true, password: true, payloadId: true,
      mode: true, expireAt: true, quotaTotal: true, connectionLimit: true, compression: true,
      tcpNodelay: true, slowDns: true, dns: true, sni: true, status: true,
    },
  }));
  await add("xrayAccounts", tx.xrayAccount.findMany({
    orderBy: { id: "asc" }, select: {
      id: true, clientId: true, serverId: true, protocol: true, uuid: true, host: true, port: true,
      path: true, tls: true, sni: true, network: true, password: true, method: true,
      quotaTotal: true, expireAt: true, maxDevices: true, status: true,
    },
  }));
  await add("singboxAccounts", tx.singboxAccount.findMany({
    orderBy: { id: "asc" }, select: {
      id: true, clientId: true, serverId: true, protocol: true, uuid: true, host: true, port: true,
      path: true, tls: true, sni: true, network: true, password: true, method: true,
      quotaTotal: true, expireAt: true, maxDevices: true, status: true,
    },
  }));
  await add("payloads", tx.sshPayload.findMany({
    orderBy: { id: "asc" }, select: { id: true, host: true, sni: true, port: true, headers: true, content: true, status: true },
  }));
  await add("pushTokens", tx.pushToken.findMany({
    orderBy: { id: "asc" }, select: { id: true, userId: true, deviceId: true },
  }));
  await add("supportTickets", tx.supportTicket.findMany({
    orderBy: { id: "asc" }, select: { id: true, userId: true },
  }));
  await add("adminTokens", tx.adminToken.findMany({
    where: unprotectedAdminTokens, orderBy: { id: "asc" }, select: { id: true, userId: true },
  }));
  // Traffic, health telemetry, lastSeen/lastSync and consumed-byte counters are
  // deliberately absent. Confirmation covers their deltas up to the table lock.
  return hash.digest("hex");
}

async function purge(tx: Tx): Promise<ResetCounts> {
  const healthReports = (await tx.mobileHealthReport.deleteMany()).count;
  const healthDevices = (await tx.mobileHealthDevice.deleteMany()).count;
  const subscriptionDevices = (await tx.subscriptionDevice.deleteMany()).count;
  const activations = (await tx.activationSession.deleteMany()).count;
  const registrations = (await tx.appRegistration.deleteMany()).count;
  const pushTokens = (await tx.pushToken.deleteMany()).count;
  const tokens = (await tx.tokenSXB.deleteMany()).count;
  const vouchers = (await tx.voucher.deleteMany()).count;
  const traffic = (await tx.trafficUsage.deleteMany()).count;
  const vpnLogs = (await tx.vpnLog.deleteMany()).count;
  const supportTickets = (await tx.supportTicket.deleteMany()).count;
  const xrayAccounts = (await tx.xrayAccount.deleteMany()).count;
  const singboxAccounts = (await tx.singboxAccount.deleteMany()).count;
  const subscriptions = (await tx.subscription.deleteMany()).count;
  const profileAssignments = (await tx.vpnProfileReseller.deleteMany()).count;
  const profiles = (await tx.vpnProfile.deleteMany()).count;
  const sshAccounts = (await tx.sshAccount.deleteMany()).count;
  const payloads = (await tx.sshPayload.deleteMany()).count;
  const clients = (await tx.vpnClient.deleteMany()).count;
  const resellers = (await tx.reseller.deleteMany()).count;
  const adminTokens = (await tx.adminToken.deleteMany({ where: unprotectedAdminTokens })).count;
  // AuditLog's existing ON DELETE SET NULL retains each audit entry; the
  // append-only quota ledger has no FKs and is never updated or deleted.
  const users = (await tx.user.deleteMany({ where: unprotectedUsers })).count;
  return {
    users, resellers, clients, registrations, activations, subscriptions, subscriptionDevices,
    tokens, vouchers, profiles, profileAssignments, sshAccounts, xrayAccounts, singboxAccounts,
    payloads, traffic, vpnLogs, pushTokens, healthReports, healthDevices, supportTickets, adminTokens,
  };
}

async function readRecord(tx: Pick<Tx, "setting">, key: string): Promise<ReceiptRecord | null> {
  const row = await tx.setting.findUnique({ where: { key } });
  return row ? receiptRecordSchema.parse(JSON.parse(row.value)) : null;
}
async function readExecution(tx: Pick<Tx, "setting">): Promise<Execution | null> {
  const row = await tx.setting.findUnique({ where: { key: RESET_EXECUTION_KEY } });
  return row ? executionSchema.parse(JSON.parse(row.value)) : null;
}
async function writeSetting(tx: Pick<Tx, "setting">, key: string, value: string): Promise<void> {
  await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}
async function pruneReceipts(tx: Tx, now: number, currentKey: string): Promise<void> {
  const rows = await tx.setting.findMany({ where: { key: { startsWith: RESET_RECEIPT_PREFIX } } });
  const receipts = rows.map(row => ({
    key: row.key, time: Date.parse(receiptRecordSchema.parse(JSON.parse(row.value)).receipt.completedAt),
  })).sort((a, b) => b.time - a.time || a.key.localeCompare(b.key));
  const cutoff = now - RESET_RECEIPT_RETENTION_DAYS * 86_400_000;
  const others = receipts.filter(row => row.key !== currentKey);
  const remove = others.filter((row, index) => row.time < cutoff || index >= RESET_RECEIPT_LIMIT - 1).map(row => row.key);
  if (remove.length) await tx.setting.deleteMany({ where: { key: { in: remove } } });
}

export function createResetService(options: ResetServiceOptions) {
  const now = options.now ?? Date.now;
  const key = createHmac("sha256", options.jwtSecret).update(audience).digest();
  const database = () => {
    if (!options.db) throw new ResetError("RESET_DATABASE_UNAVAILABLE");
    return options.db;
  };
  const decodeChallenge = (challenge: string, ownerId: string) => {
    try {
      // Expiration is checked only after receipt lookup, so a committed request
      // can be recovered after its preview TTL without authorizing another purge.
      const decoded = jwt.verify(challenge, key, {
        algorithms: ["HS256"], audience, ignoreExpiration: true, clockTimestamp: Math.floor(now() / 1000),
      });
      const payload = challengeSchema.parse(decoded);
      if (payload.sub !== ownerId || payload.iat > Math.floor(now() / 1000) ||
          payload.exp - payload.iat !== RESET_CHALLENGE_SECONDS) throw new ResetError("RESET_CHALLENGE_INVALID");
      return payload;
    } catch {
      throw new ResetError("RESET_CHALLENGE_INVALID");
    }
  };
  const assertNotExpired = (exp: number) => {
    if (exp * 1000 <= now()) throw new ResetError("RESET_CHALLENGE_EXPIRED");
  };

  async function finishExecution(execution: Execution, cancelUncommitted: boolean): Promise<ResetReceipt | null> {
    return database().$transaction(async tx => {
      await acquireResetLock(tx);
      const marker = await readExecution(tx);
      const record = await readRecord(tx, execution.receiptKey);
      if (record && (record.ownerId !== execution.ownerId || record.challengeHash !== execution.challengeHash ||
          record.receipt.resetId !== execution.resetId)) throw new ResetError("RESET_FAILED");
      if (!marker) {
        if (record && !record.receipt.maintenanceRestored) throw new ResetError("RESET_FAILED");
        if (!record && cancelUncommitted) await writeSetting(tx, RESET_EPOCH_KEY, randomUUID());
        return record?.receipt ?? null;
      }
      if (marker.resetId !== execution.resetId) throw new ResetError("RESET_IN_PROGRESS");
      if (marker.previousMaintenance === null) {
        await tx.setting.deleteMany({ where: { key: MAINTENANCE_KEY } });
      } else {
        await writeSetting(tx, MAINTENANCE_KEY, marker.previousMaintenance);
      }
      if (record) {
        record.receipt.maintenanceRestored = true;
        await writeSetting(tx, execution.receiptKey, json(record));
      } else if (cancelUncommitted) {
        // Cancel the orphaned authorization even if its TTL has not elapsed.
        // A later retry must obtain a fresh structural preview, never resume it.
        await writeSetting(tx, RESET_EPOCH_KEY, randomUUID());
      }
      await tx.setting.deleteMany({ where: { key: RESET_EXECUTION_KEY } });
      return record?.receipt ?? null;
    }, smallTransactionOptions);
  }

  return {
    assertAvailable(): void { database(); },
    async status(ownerId: string): Promise<ResetStatus> {
      try {
        return await database().$transaction(async (tx): Promise<ResetStatus> => {
          await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
          await owner(tx, ownerId);
          try { await acquireResetLock(tx); }
          catch (error) {
            if (!(error instanceof ResetError) || error.code !== "RESET_IN_PROGRESS") throw error;
            return { mode: RESET_MODE, status: "in_progress", recoveryAvailable: false };
          }
          const pending = await readExecution(tx);
          if (pending) {
            if (pending.ownerId !== ownerId) return { mode: RESET_MODE, status: "in_progress", recoveryAvailable: false };
            const record = await readRecord(tx, pending.receiptKey);
            if (record && (record.ownerId !== ownerId || record.challengeHash !== pending.challengeHash ||
                record.receipt.resetId !== pending.resetId)) throw new ResetError("RESET_FAILED");
            return {
              mode: RESET_MODE, status: "recovery_required", recoveryAvailable: true,
              resetId: pending.resetId, challenge: pending.challenge, expiresAt: pending.expiresAt,
              ...(record ? { receipt: record.receipt } : {}),
            };
          }
          const rows = await tx.setting.findMany({ where: { key: { startsWith: RESET_RECEIPT_PREFIX } } });
          const ownReceipts = rows.map(row => receiptRecordSchema.parse(JSON.parse(row.value)))
            .filter(row => row.ownerId === ownerId &&
              Date.parse(row.receipt.completedAt) >= now() - RESET_RECEIPT_RETENTION_DAYS * 86_400_000)
            .sort((a, b) => b.receipt.completedAt.localeCompare(a.receipt.completedAt));
          const epoch = await tx.setting.findUnique({ where: { key: RESET_EPOCH_KEY } });
          const last = ownReceipts.find(record => record.receipt.resetId === epoch?.value) ?? ownReceipts[0];
          if (!last) return { mode: RESET_MODE, status: "idle", recoveryAvailable: false };
          return {
            mode: RESET_MODE, status: "completed", recoveryAvailable: false,
            resetId: last.receipt.resetId, challenge: last.challenge, expiresAt: last.expiresAt, receipt: last.receipt,
          };
        }, { ...smallTransactionOptions, isolationLevel: "RepeatableRead" });
      } catch (error) {
        throw error instanceof ResetError ? error : new ResetError("RESET_FAILED");
      }
    },
    async preview(ownerId: string): Promise<ResetPreview> {
      try {
        return await database().$transaction(async tx => {
          await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
          await owner(tx, ownerId);
          if (await readExecution(tx)) throw new ResetError("RESET_IN_PROGRESS");
          const digest = await structuralDigest(tx);
          const iat = Math.floor(now() / 1000);
          const exp = iat + RESET_CHALLENGE_SECONDS;
          const challenge = jwt.sign({
            aud: audience, version: 1, mode: RESET_MODE, sub: ownerId,
            nonce: randomBytes(32).toString("hex"), digest, iat, exp,
          }, key, { algorithm: "HS256" });
          return {
            mode: RESET_MODE, confirmationText: RESET_CONFIRMATION_TEXT, challenge,
            expiresAt: new Date(exp * 1000).toISOString(), backupRequired: true,
            counts: await counts(tx),
            preserved: {
              usersByRole: await usersByRole(tx),
              roles: await tx.role.count(), permissions: await tx.permission.count(),
              servers: await tx.vPSServer.count(), serverConfigs: await tx.serverConfig.count(),
              auditLogs: await tx.auditLog.count(), quotaMovements: await tx.resellerQuotaMovement.count(),
              settings: await tx.setting.count({ where: { NOT: { key: { startsWith: RESET_SETTING_PREFIX } } } }),
              projectFiles: true,
            },
            warnings: [...RESET_WARNINGS],
          };
        }, { ...smallTransactionOptions, isolationLevel: "RepeatableRead" });
      } catch (error) {
        throw error instanceof ResetError ? error : new ResetError("RESET_FAILED");
      }
    },
    async execute(ownerId: string, input: unknown, executionOptions: { signal?: AbortSignal } = {}): Promise<ResetReceipt> {
      const db = database();
      const parsed = executeSchema.safeParse(input);
      if (!parsed.success) throw new ResetError("RESET_INVALID_REQUEST");
      const body = parsed.data;
      if (body.confirmation !== RESET_CONFIRMATION_TEXT) throw new ResetError("RESET_CONFIRMATION_REQUIRED");
      const payload = decodeChallenge(body.challenge, ownerId);
      const challengeHash = createHash("sha256").update(body.challenge).digest("hex");
      const receiptKey = `${RESET_RECEIPT_PREFIX}${payload.nonce}`;
      const signal = AbortSignal.any([executionOptions.signal ?? new AbortController().signal, AbortSignal.timeout(170_000)]);
      const attempt: { execution: Execution | null } = { execution: null };
      let committed: ResetReceipt | null = null;
      let failure: ResetError | null = null;
      let recovering = false;
      try {
        await owner(db, ownerId, body.password);
        signal.throwIfAborted();
        committed = await db.$transaction(async tx => {
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
          await acquireResetLock(tx);
          await owner(tx, ownerId, body.password);
          const record = await readRecord(tx, receiptKey);
          const pending = await readExecution(tx);
          if (record) {
            if (record.ownerId !== ownerId || record.challengeHash !== challengeHash) throw new ResetError("RESET_CHALLENGE_INVALID");
            if (record.receipt.maintenanceRestored &&
                Date.parse(record.receipt.completedAt) < now() - RESET_RECEIPT_RETENTION_DAYS * 86_400_000) {
              throw new ResetError("RESET_CHALLENGE_EXPIRED");
            }
            if (record.receipt.maintenanceRestored) return record.receipt;
            if (!pending || pending.resetId !== record.receipt.resetId) throw new ResetError("RESET_FAILED");
            attempt.execution = pending;
            recovering = true;
            return record.receipt;
          }
          if (pending) {
            // Owning the advisory lock proves the previous transaction has
            // settled. Recovery only restores maintenance; it never resumes DELETE.
            if (pending.challengeHash !== challengeHash || pending.ownerId !== ownerId) throw new ResetError("RESET_IN_PROGRESS");
            attempt.execution = pending;
            recovering = true;
            return null;
          }
          assertNotExpired(payload.exp);
          signal.throwIfAborted();
          const resetId = randomUUID();
          // This separate short transaction makes maintenance durable BEFORE
          // table locks/backup. It must NOT reacquire our advisory lock.
          await db.$transaction(async state => {
            if (await readExecution(state)) throw new ResetError("RESET_IN_PROGRESS");
            const previous = await state.setting.findUnique({ where: { key: MAINTENANCE_KEY } });
            attempt.execution = {
              resetId, ownerId, challengeHash, receiptKey, startedAt: new Date(now()).toISOString(),
              challenge: body.challenge, expiresAt: new Date(payload.exp * 1000).toISOString(),
              previousMaintenance: previous?.value ?? null,
            };
            await writeSetting(state, RESET_EXECUTION_KEY, json(attempt.execution));
            await writeSetting(state, MAINTENANCE_KEY, MAINTENANCE_ENABLED_VALUE);
          }, smallTransactionOptions);
          await tx.$executeRawUnsafe(RESET_TABLE_LOCK_SQL);
          await owner(tx, ownerId, body.password);
          if (await structuralDigest(tx) !== payload.digest) throw new ResetError("RESET_PREVIEW_CHANGED");
          assertNotExpired(payload.exp);
          signal.throwIfAborted();
          let backup: z.infer<typeof backupSchema>;
          try {
            backup = backupSchema.parse(await options.backup({ resetId, signal }));
          } catch {
            throw new ResetError("RESET_BACKUP_FAILED");
          }
          signal.throwIfAborted();
          const deletedCounts = await purge(tx);
          const countsAfter = await counts(tx);
          if (Object.values(countsAfter).some(value => value !== 0)) throw new ResetError("RESET_FAILED");
          const receipt: ResetReceipt = {
            status: "completed", resetId, completedAt: new Date(now()).toISOString(),
            deletedCounts, countsAfter, retainedUsersByRole: await usersByRole(tx),
            backup, maintenanceRestored: false,
          };
          await tx.auditLog.create({ data: {
            userId: ownerId, action: `Production application reset completed: ${resetId}`,
            type: "danger", visibleOwnerOnly: true,
          } });
          await writeSetting(tx, RESET_EPOCH_KEY, resetId);
          await writeSetting(tx, receiptKey, json({
            ownerId, challengeHash, challenge: body.challenge, expiresAt: new Date(payload.exp * 1000).toISOString(), receipt,
          }));
          await pruneReceipts(tx, now(), receiptKey);
          return receipt;
        }, transactionOptions);
      } catch (error) {
        failure = error instanceof ResetError ? error : new ResetError("RESET_FAILED");
      }

      // Never restore within the callback: Prisma has not committed/rolled back
      // until its transaction promise settles. Durable receipt lookup also
      // disambiguates a lost connection during COMMIT.
      const execution = attempt.execution;
      let invalidationFailed = false;
      const invalidate = () => {
        try { options.invalidateAccess(); }
        catch { invalidationFailed = true; }
      };
      if (execution) {
        if (committed) invalidate();
        try {
          const recovered = await finishExecution(execution, recovering);
          if (recovered && !committed) invalidate();
          committed = recovered;
        } catch {
          throw new ResetError("RESET_MAINTENANCE_RESTORE_FAILED", {
            resetId: execution.resetId, ...(committed ? { status: "completed" } : {}),
            maintenanceRestored: false,
          });
        }
      }
      if (invalidationFailed) throw new ResetError("RESET_FAILED", {
        ...(committed ? { resetId: committed.resetId, status: "completed" } : {}), maintenanceRestored: true,
      });
      if (committed) return committed;
      if (recovering && execution) throw new ResetError("RESET_RECOVERED_NOT_EXECUTED", {
        resetId: execution.resetId, status: "not_completed", maintenanceRestored: true, requiresFreshPreview: true,
      });
      if (failure) throw failure;
      throw new ResetError("RESET_FAILED", execution ? { resetId: execution.resetId, maintenanceRestored: true, status: "not_completed" } : {});
    },
  };
}

export type ResetService = ReturnType<typeof createResetService>;

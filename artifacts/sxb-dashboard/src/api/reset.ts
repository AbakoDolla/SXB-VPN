import { apiRequest } from "./client";
import { isOwner } from "../lib/roles";
import type { UserRole } from "../types";

export const RESET_CONFIRMATION = "RESET SXB VPN";
export const RESET_COUNT_KEYS = [
  "users", "resellers", "clients", "registrations", "activations", "subscriptions",
  "subscriptionDevices", "tokens", "vouchers", "profiles", "profileAssignments",
  "sshAccounts", "xrayAccounts", "singboxAccounts", "payloads", "traffic", "vpnLogs",
  "pushTokens", "healthReports", "healthDevices", "supportTickets", "adminTokens",
] as const;
export const RESET_RETAINED_ROLES = ["OWNER", "ADMIN", "SUPER_ADMIN"] as const;
export const RESET_PRESERVED_KEYS = [
  "roles", "permissions", "servers", "serverConfigs", "auditLogs", "quotaMovements", "settings",
] as const;

export type ResetCounts = Record<typeof RESET_COUNT_KEYS[number], number>;
export type RetainedUsers = Record<typeof RESET_RETAINED_ROLES[number], number>;
export interface ResetPreview {
  mode: "production";
  confirmationText: typeof RESET_CONFIRMATION;
  challenge: string;
  expiresAt: string;
  backupRequired: true;
  counts: ResetCounts;
  preserved: Record<typeof RESET_PRESERVED_KEYS[number], number> & {
    usersByRole: RetainedUsers;
    projectFiles: true;
  };
  warnings: string[];
}
export interface ResetResult {
  status: "completed";
  resetId: string;
  completedAt: string;
  deletedCounts: ResetCounts;
  countsAfter: ResetCounts;
  retainedUsersByRole: RetainedUsers;
  backup: { id: string; bytes: number; sha256: string };
  maintenanceRestored: boolean;
}
export interface ResetRecovery {
  mode: "production";
  status: "recovery_required";
  recoveryAvailable: true;
  resetId: string;
  challenge: string;
  expiresAt: string;
  receipt?: ResetResult;
}
export type ResetStatus = ResetRecovery | {
  mode: "production";
  status: "idle" | "in_progress";
  recoveryAvailable: false;
} | {
  mode: "production";
  status: "completed";
  recoveryAvailable: false;
  resetId: string;
  challenge: string;
  expiresAt: string;
  receipt: ResetResult;
};

const RESET_ERROR_KEYS: Record<string, string> = {
  OWNER_ONLY: "errors.reset.ownerOnly",
  RESET_CONFIRMATION_REQUIRED: "errors.reset.confirmationRequired",
  RESET_INVALID_REQUEST: "errors.reset.invalidRequest",
  RESET_CHALLENGE_INVALID: "errors.reset.challengeInvalid",
  RESET_CHALLENGE_EXPIRED: "errors.reset.challengeExpired",
  RESET_PREVIEW_CHANGED: "errors.reset.previewChanged",
  RESET_IN_PROGRESS: "errors.reset.inProgress",
  RESET_REAUTH_FAILED: "errors.reset.reauthFailed",
  RESET_RATE_LIMITED: "errors.rate_limit",
  RESET_BACKUP_FAILED: "errors.reset.backupFailed",
  RESET_FAILED: "errors.reset.failed",
  RESET_MAINTENANCE_RESTORE_FAILED: "errors.reset.maintenanceRestoreFailed",
  RESET_RECOVERED_NOT_EXECUTED: "errors.reset.recoveredNotExecuted",
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function counts<K extends string>(value: unknown, keys: readonly K[]): value is Record<K, number> {
  return record(value) && keys.every(key => count(value[key]));
}
function date(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function isPreview(value: unknown): value is ResetPreview {
  return record(value) && value.mode === "production" && value.confirmationText === RESET_CONFIRMATION
    && nonempty(value.challenge) && date(value.expiresAt) && value.backupRequired === true
    && counts(value.counts, RESET_COUNT_KEYS) && record(value.preserved)
    && value.preserved.projectFiles === true && counts(value.preserved.usersByRole, RESET_RETAINED_ROLES)
    && counts(value.preserved, RESET_PRESERVED_KEYS)
    && Array.isArray(value.warnings) && value.warnings.every(warning => typeof warning === "string");
}
function isResult(value: unknown): value is ResetResult {
  return record(value) && value.status === "completed" && nonempty(value.resetId) && date(value.completedAt)
    && counts(value.deletedCounts, RESET_COUNT_KEYS) && counts(value.countsAfter, RESET_COUNT_KEYS)
    && counts(value.retainedUsersByRole, RESET_RETAINED_ROLES) && record(value.backup)
    && nonempty(value.backup.id) && count(value.backup.bytes) && value.backup.bytes > 0
    && typeof value.backup.sha256 === "string" && /^[a-f0-9]{64}$/i.test(value.backup.sha256)
    && typeof value.maintenanceRestored === "boolean";
}
function isStatus(value: unknown): value is ResetStatus {
  if (!record(value) || value.mode !== "production") return false;
  if (value.status === "idle" || value.status === "in_progress") {
    return value.recoveryAvailable === false && !("challenge" in value) && !("receipt" in value);
  }
  if (!nonempty(value.resetId) || !nonempty(value.challenge) || !date(value.expiresAt)) return false;
  if (value.status === "completed") {
    return value.recoveryAvailable === false && isResult(value.receipt)
      && value.receipt.resetId === value.resetId && value.receipt.maintenanceRestored;
  }
  return value.status === "recovery_required" && value.recoveryAvailable === true
    && (value.receipt === undefined || isResult(value.receipt) && value.receipt.resetId === value.resetId);
}

// Keep only allowlisted messages in the reset UI: a failed reauthentication
// response must never echo a submitted password into state or a diagnostic.
export function resetErrorKey(error: unknown): string {
  if (!record(error)) return "errors.reset.requestFailed";
  if (typeof error.code === "string" && RESET_ERROR_KEYS[error.code]) return RESET_ERROR_KEYS[error.code];
  if (typeof error.message === "string" && [
    "errors.reset.invalidResponse", "errors.reset.ownerOnly", "errors.reset.confirmationRequired",
    "errors.reset.challengeExpired",
  ].includes(error.message)) return error.message;
  if (error.status === 401) return "errors.sessionExpired";
  if (error.status === 403) return "errors.auth.forbidden";
  if (error.status === 429) return "errors.rate_limit";
  return error.name === "TypeError" ? "errors.network" : "errors.reset.requestFailed";
}

export async function fetchResetPreview(role: UserRole): Promise<ResetPreview> {
  if (!isOwner(role)) throw new Error("errors.reset.ownerOnly");
  const data = await apiRequest<unknown>("/ops/reset/preview");
  if (!isPreview(data)) throw new Error("errors.reset.invalidResponse");
  return data;
}

export async function fetchResetStatus(role: UserRole): Promise<ResetStatus> {
  if (!isOwner(role)) throw new Error("errors.reset.ownerOnly");
  const data = await apiRequest<unknown>("/ops/reset/status");
  if (!isStatus(data)) throw new Error("errors.reset.invalidResponse");
  return data;
}

export async function executeReset(
  role: UserRole,
  body: { mode: "production"; challenge: string; confirmation: string; password: string },
): Promise<ResetResult> {
  if (!isOwner(role)) throw new Error("errors.reset.ownerOnly");
  if (body.mode !== "production" || !body.challenge || body.confirmation !== RESET_CONFIRMATION || !body.password.trim()) {
    throw new Error("errors.reset.confirmationRequired");
  }
  const data = await apiRequest<unknown>("/ops/reset/execute", { method: "POST", body });
  if (!isResult(data)) throw new Error("errors.reset.invalidResponse");
  return data;
}

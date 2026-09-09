import type { Prisma } from "@prisma/client";

export const MAINTENANCE_KEY = "maintenance_mode";
export const MAINTENANCE_ENABLED_VALUE = "true";
export const RESET_SETTING_PREFIX = "ops.reset.";
export const RESET_EXECUTION_KEY = `${RESET_SETTING_PREFIX}execution`;
export const RESET_EPOCH_KEY = `${RESET_SETTING_PREFIX}epoch`;
export const RESET_RECEIPT_PREFIX = `${RESET_SETTING_PREFIX}receipt.`;

// Shared with the public maintenance setter; the lock is scoped to this database.
export const RESET_LOCK_SQL = 'SELECT pg_try_advisory_xact_lock(1398293074, 1) AS "acquired"';

const errorStatuses = {
  OWNER_ONLY: 403,
  RESET_DATABASE_UNAVAILABLE: 503,
  RESET_INVALID_REQUEST: 400,
  RESET_CONFIRMATION_REQUIRED: 400,
  RESET_REAUTH_FAILED: 403,
  RESET_CHALLENGE_INVALID: 400,
  RESET_CHALLENGE_EXPIRED: 409,
  RESET_PREVIEW_CHANGED: 409,
  RESET_IN_PROGRESS: 409,
  RESET_BACKUP_FAILED: 503,
  RESET_FAILED: 503,
  RESET_MAINTENANCE_RESTORE_FAILED: 503,
  RESET_RECOVERED_NOT_EXECUTED: 409,
} as const;

export type ResetErrorCode = keyof typeof errorStatuses;
type ResetErrorDetails = {
  resetId?: string;
  status?: "completed" | "not_completed";
  maintenanceRestored?: boolean;
  requiresFreshPreview?: boolean;
};

export class ResetError extends Error {
  readonly status: number;
  constructor(readonly code: ResetErrorCode, readonly details: ResetErrorDetails = {}) {
    super(code);
    this.name = "ResetError";
    this.status = errorStatuses[code];
  }
}

export async function acquireResetLock(tx: Pick<Prisma.TransactionClient, "$queryRawUnsafe">): Promise<void> {
  const rows = await tx.$queryRawUnsafe<Array<{ acquired: boolean }>>(RESET_LOCK_SQL);
  if (rows.length !== 1 || rows[0].acquired !== true) throw new ResetError("RESET_IN_PROGRESS");
}

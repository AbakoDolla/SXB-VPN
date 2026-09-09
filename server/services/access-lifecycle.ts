export type DeviceAccessStatus = "active" | "suspended" | "disabled" | "expired" | "revoked" | "deleted";
export type SubscriptionAccessStatus = "active" | "suspended" | "revoked" | "deleted" | "expired" | "exhausted";
type BlockedDeviceStatus = Exclude<DeviceAccessStatus, "active">;
type BlockedSubscriptionStatus = Exclude<SubscriptionAccessStatus, "active">;
export type AccessCode = `DEVICE_${Uppercase<BlockedDeviceStatus>}` | `CONFIG_${Uppercase<BlockedSubscriptionStatus>}` | "SESSION_INVALID";

export interface AccessFailure {
  code: AccessCode;
  scope: "device" | "subscription" | "session";
  temporary: boolean;
  subscriptionId?: string;
  error: string;
  message: string;
}

type DatedAccess = { status?: string; expireAt?: Date | string | null };
export type DeviceAccessRecord = DatedAccess & {
  id: string;
  deviceId?: string | null;
  activatedAt?: Date | string | null;
  user?: { status?: string } | null;
};
export type OwnerAccessRecord = {
  status?: string;
  accessExpiresAt?: Date | string | null;
  user?: { status?: string } | null;
};
export type SubscriptionAccessRecord = DatedAccess & {
  id: string;
  quotaBytes?: bigint | number | null;
  quotaUsed?: bigint | number | null;
  profile?: { status?: string } | null;
};

export function accessDateExpired(value: Date | string | null | undefined, now = Date.now()): boolean {
  return value != null && new Date(value).getTime() <= now;
}

function storedDeviceStatus(status: string | undefined): DeviceAccessStatus {
  switch (status) {
    case undefined:
    case "active": return "active";
    case "suspended": return "suspended";
    case "expired": return "expired";
    case "deleted": return "deleted";
    case "revoked": return "revoked";
    default: return "disabled";
  }
}

export function deviceAccessStatus(
  client: DeviceAccessRecord | null,
  owner: OwnerAccessRecord | null = null,
  now = Date.now(),
): DeviceAccessStatus {
  if (!client || client.user === null) return "deleted";
  const statuses = [
    storedDeviceStatus(client.status),
    storedDeviceStatus(client.user?.status),
    storedDeviceStatus(owner?.status),
    owner?.user === null ? "deleted" : storedDeviceStatus(owner?.user?.status),
  ];
  for (const status of ["deleted", "revoked", "disabled", "suspended", "expired"] as const) {
    if (statuses.includes(status)) return status;
  }
  if (accessDateExpired(client.expireAt, now) || accessDateExpired(owner?.accessExpiresAt, now)) return "expired";
  return "active";
}

export function subscriptionAccessStatus(
  subscription: SubscriptionAccessRecord | null,
  now = Date.now(),
): SubscriptionAccessStatus {
  if (!subscription || subscription.profile === null || subscription.status === "deleted") return "deleted";
  if (subscription.status === "revoked" || ["revoked", "archived"].includes(subscription.profile?.status ?? "")) return "revoked";
  if (subscription.status === "suspended" || (subscription.profile?.status && subscription.profile.status !== "active")) return "suspended";
  if (subscription.status === "expired" || accessDateExpired(subscription.expireAt, now)) return "expired";
  if (subscription.status === "exhausted" ||
      (subscription.quotaBytes != null && BigInt(subscription.quotaBytes) > 0n &&
       BigInt(subscription.quotaUsed ?? 0) >= BigInt(subscription.quotaBytes))) return "exhausted";
  return subscription.status === "active" || subscription.status === undefined ? "active" : "suspended";
}

const deviceCodes: Record<BlockedDeviceStatus, AccessCode> = {
  suspended: "DEVICE_SUSPENDED", disabled: "DEVICE_DISABLED", expired: "DEVICE_EXPIRED",
  revoked: "DEVICE_REVOKED", deleted: "DEVICE_DELETED",
};
const subscriptionCodes: Record<BlockedSubscriptionStatus, AccessCode> = {
  suspended: "CONFIG_SUSPENDED", expired: "CONFIG_EXPIRED", exhausted: "CONFIG_EXHAUSTED",
  revoked: "CONFIG_REVOKED", deleted: "CONFIG_DELETED",
};

export function deviceAccessFailure(status: BlockedDeviceStatus): AccessFailure {
  return {
    code: deviceCodes[status], scope: "device",
    temporary: status !== "revoked" && status !== "deleted",
    error: status === "deleted" ? "errors.mobile.no_account" : "errors.mobile.account_blocked",
    message: `Acces appareil : ${status}.`,
  };
}

export function subscriptionAccessFailure(status: BlockedSubscriptionStatus, subscriptionId?: string): AccessFailure {
  return {
    code: subscriptionCodes[status], scope: "subscription",
    temporary: status !== "revoked" && status !== "deleted",
    ...(subscriptionId ? { subscriptionId } : {}),
    error: status === "deleted" ? "errors.mobile.subscription_not_found" : `errors.mobile.config_${status}`,
    message: `Configuration VPN : ${status}.`,
  };
}

export function sessionInvalidFailure(): AccessFailure {
  return {
    code: "SESSION_INVALID", scope: "session", temporary: false,
    error: "errors.auth.invalid_token", message: "Session invalide ou expiree.",
  };
}

export class MobileAccessError extends Error {
  constructor(readonly status: number, readonly body: AccessFailure) {
    super(body.message);
  }
}

export function assertResumeAllowed(client: DatedAccess): void {
  if (client.status === "expired" || accessDateExpired(client.expireAt)) {
    throw new MobileAccessError(409, deviceAccessFailure("expired"));
  }
}

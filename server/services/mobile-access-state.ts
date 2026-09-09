import { createHash } from "node:crypto";
import type { NextFunction, Response } from "express";
import type { Prisma } from "@prisma/client";
import type { AuthenticatedRequest } from "../middleware/auth";
import { prisma, inMemoryDb } from "../database";
import { configHashForProfile, configVersionForProfile } from "./config-hash";
import { mobileClientSelect, invalidMobileSession } from "./mobile-principal";
import {
  deviceAccessStatus, subscriptionAccessStatus, MobileAccessError, sessionInvalidFailure,
  type DeviceAccessStatus, type SubscriptionAccessStatus,
} from "./access-lifecycle";
import type { MobileIdentity } from "./access-ticket";
import { ACCESS_STATE_LIMITS, AccessStateHub, accessStateHub } from "./access-state-events";
export { ACCESS_STATE_LIMITS, AccessWaitLimitError, AccessStateHub, accessStateHub } from "./access-state-events";

export interface MobileAccessSnapshot {
  revision: string;
  serverTime: string;
  device: {
    id: string; status: DeviceAccessStatus; code: string;
    expireAt: string | null; activationRequired: boolean;
  };
  subscriptions: Array<{
    id: string; name: string; status: SubscriptionAccessStatus;
    quotaTotalBytes: number; quotaUsedBytes: number; expireAt: string | null;
    configVersion?: number; configHash?: string;
  }>;
}

export interface AccessCredential extends MobileIdentity {
  exp: number;
  boundInToken: boolean;
  kind: "access" | "ticket";
}

// Only metadata needed by the existing config hash; no passwords, payload or config blobs.
const profileSelect = {
  status: true, configVersion: true, canonicalConfigHash: true, protocol: true,
  host: true, port: true, tls: true, sni: true, network: true, path: true,
  dns: true, method: true, payloadId: true, updatedAt: true,
} satisfies Prisma.VpnProfileSelect;
const subscriptionSelect = {
  id: true, name: true, status: true, quotaBytes: true, quotaUsed: true, expireAt: true,
  profile: { select: profileSelect },
} satisfies Prisma.SubscriptionSelect;

export async function readMobileAccessSnapshot(identity: AccessCredential): Promise<MobileAccessSnapshot> {
  if (identity.exp * 1000 <= Date.now()) invalidMobileSession();
  const client = prisma
    ? await prisma.vpnClient.findUnique({
        where: { id: identity.clientId },
        select: { ...mobileClientSelect, subscriptions: { select: subscriptionSelect, orderBy: { id: "asc" } } },
      })
    : (() => {
        const row = inMemoryDb.vpnClients.find(value => value.id === identity.clientId);
        if (!row) return null;
        const user = inMemoryDb.users.find(value => value.id === row.userId);
        const reseller = inMemoryDb.resellers.find(value =>
          row.resellerId ? value.id === row.resellerId : value.userId === row.userId);
        const owner = reseller ? { ...reseller, user: inMemoryDb.users.find(value => value.id === reseller.userId) ?? null } : null;
        return {
          ...row, user: user ? { ...user, resellerInfo: owner } : null, reseller: owner,
          subscriptions: (inMemoryDb.subscriptions ?? []).filter(value => value.clientId === row.id),
        };
      })();
  if (identity.exp * 1000 <= Date.now()) invalidMobileSession();
  if (client && client.userId !== identity.userId) invalidMobileSession();
  // A signed former binding can observe its own deletion/reset, never the new device's data.
  const bindingLost = !!client && (client.deviceId !== identity.deviceId || !client.activatedAt);
  if ((!client || bindingLost) && !identity.boundInToken) invalidMobileSession();
  const now = Date.now();
  const status = bindingLost ? "revoked" : deviceAccessStatus(client, client?.reseller ?? client?.user?.resellerInfo, now);
  const content = {
    device: {
      id: identity.clientId, status,
      code: status === "active" ? "DEVICE_ACTIVE" : `DEVICE_${status.toUpperCase()}`,
      expireAt: client?.expireAt ? new Date(client.expireAt).toISOString() : null,
      activationRequired: status === "deleted" || !client || bindingLost || !client.activatedAt,
    },
    subscriptions: !client || bindingLost || status === "deleted" ? [] : client.subscriptions.map(sub => {
      const profile = "profile" in sub ? sub.profile : undefined;
      const hash = configHashForProfile(profile);
      return {
        id: sub.id, name: sub.name, status: subscriptionAccessStatus(sub, now),
        quotaTotalBytes: Number(sub.quotaBytes), quotaUsedBytes: Number(sub.quotaUsed),
        expireAt: sub.expireAt ? new Date(sub.expireAt).toISOString() : null,
        ...(profile ? { configVersion: configVersionForProfile(profile), ...(hash ? { configHash: hash } : {}) } : {}),
      };
    }).sort((left, right) => left.id.localeCompare(right.id)),
  };
  return {
    ...content,
    revision: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
    serverTime: new Date(now).toISOString(),
  };
}

export class AccessWaitTimeoutError extends Error {}

export async function waitForMobileAccess(
  identity: AccessCredential,
  revision: string,
  waitSeconds: number,
  signal: AbortSignal,
  hub = accessStateHub,
  read = readMobileAccessSnapshot,
): Promise<MobileAccessSnapshot | null> {
  return new Promise((resolve, reject) => {
    const waitMs = Math.min(waitSeconds, ACCESS_STATE_LIMITS.waitSeconds) * 1000;
    const deadline = Date.now() + waitMs;
    const finalReadAt = deadline - Math.min(100, waitMs);
    let closed = false;
    let reading = false;
    let pending = false;
    let wakeScheduled = false;
    let timer: ReturnType<typeof setTimeout>;
    let limitTimer: ReturnType<typeof setTimeout>;
    let expiryTimer: ReturnType<typeof setTimeout>;
    let subscription: ReturnType<AccessStateHub["subscribe"]>;
    const finish = (snapshot: MobileAccessSnapshot | null, error?: unknown) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      clearTimeout(limitTimer);
      clearTimeout(expiryTimer);
      signal.removeEventListener("abort", abort);
      subscription?.close();
      if (error) reject(error); else resolve(snapshot);
    };
    const abort = () => finish(null);
    const schedule = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(check, Math.max(0, delay));
    };
    const wake = () => {
      if (closed) return;
      if (reading) { pending = true; return; }
      if (wakeScheduled) return;
      wakeScheduled = true;
      schedule(ACCESS_STATE_LIMITS.coalesceMs);
    };
    const check = async () => {
      if (closed || reading) return;
      wakeScheduled = false;
      reading = true;
      pending = false;
      try {
        const snapshot = await read(identity);
        if (closed) return;
        subscription.update(snapshot);
        if (snapshot.revision !== revision || Date.now() >= finalReadAt) return finish(snapshot);
        schedule(pending ? ACCESS_STATE_LIMITS.coalesceMs : Math.min(ACCESS_STATE_LIMITS.resyncMs, finalReadAt - Date.now()));
      } catch (error) {
        finish(null, error);
      } finally {
        reading = false;
      }
    };
    try {
      subscription = hub.subscribe(identity, wake);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) return abort();
      // Reserve a final read, but never let an unresponsive database extend the 25s hold.
      limitTimer = setTimeout(() => finish(null, new AccessWaitTimeoutError()), waitMs);
      expiryTimer = setTimeout(() => finish(null, new MobileAccessError(401, sessionInvalidFailure())),
        Math.max(0, identity.exp * 1000 - Date.now()));
      void check();
    } catch (error) {
      finish(null, error);
    }
  });
}

// Mounted once at /api. Successful mutations have awaited their transaction before
// emitting the response; failed/rolled-back writes never publish an invalidation.
const mutationSurfaces = new Set(["clients", "devices", "subscriptions", "vouchers", "tokens", "sessions",
  "users", "resellers", "vpn-profiles", "ssh", "xray", "singbox", "payload", "app", "mobile", "provision"]);
export function invalidateAccessAfterMutation(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const [surface, id] = req.path.split("/").filter(Boolean);
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method) || !mutationSurfaces.has(surface) ||
      (surface === "mobile" && ["access-ticket", "push-tokens", "support", "auth"].includes(id))) return next();
  res.once("finish", () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    if (["mobile", "provision"].includes(surface) && req.user?.clientId) {
      accessStateHub.invalidate({ clientId: req.user.clientId });
    } else if (["clients", "devices"].includes(surface) && id && !["bulk", "generate-token"].includes(id)) {
      accessStateHub.invalidate({ clientId: id });
    } else if (surface === "subscriptions" && id && id !== "bulk") {
      accessStateHub.invalidate({ subscriptionId: id });
    } else if (typeof req.body?.clientId === "string") {
      accessStateHub.invalidate({ clientId: req.body.clientId });
    } else {
      accessStateHub.invalidate();
    }
  });
  next();
}

import type { Translate } from "./i18n";
import { toBigInt } from "./resellerAccess";

interface AccessRecord {
  status: string;
  expireAt: string | null;
}

interface PlanRecord extends AccessRecord {
  quotaBytes: string | number;
  quotaUsed: string | number;
}

export function hasExpired(expireAt: string | null, now = Date.now()): boolean {
  return expireAt !== null && Date.parse(expireAt) <= now;
}

export function deviceStatus(device: AccessRecord, now = Date.now()): string {
  return device.status === "active" && hasExpired(device.expireAt, now) ? "expired" : device.status;
}

export function canResumeDevice(device: AccessRecord, now = Date.now()): boolean {
  return (device.status === "suspended" || device.status === "disabled") && !hasExpired(device.expireAt, now);
}

export function isPlanExhausted(plan: PlanRecord): boolean {
  const quota = toBigInt(plan.quotaBytes);
  const used = toBigInt(plan.quotaUsed);
  return quota !== null && used !== null && quota > BigInt(0) && used >= quota;
}

export function subscriptionStatus(plan: PlanRecord, now = Date.now()): string {
  if (plan.status === "suspended" || plan.status === "revoked") return plan.status;
  if (hasExpired(plan.expireAt, now)) return "expired";
  return isPlanExhausted(plan) ? "exhausted" : plan.status;
}

export function canResumeSubscription(plan: PlanRecord, now = Date.now()): boolean {
  return plan.status === "suspended" && !hasExpired(plan.expireAt, now) && !isPlanExhausted(plan);
}

export function lifecycleBadges(t: Translate): Record<string, { label: string; cls: string }> {
  return {
    active: { label: t("commerce.common.active"), cls: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" },
    suspended: { label: t("commerce.common.suspended"), cls: "text-amber-400 bg-amber-500/10 border-amber-500/20" },
    disabled: { label: t("commerce.common.disabled"), cls: "text-orange-400 bg-orange-500/10 border-orange-500/20" },
    expired: { label: t("commerce.common.expired"), cls: "text-amber-400 bg-amber-500/10 border-amber-500/20" },
    revoked: { label: t("commerce.common.revoked"), cls: "text-rose-400 bg-rose-500/10 border-rose-500/20" },
    exhausted: { label: t("commerce.subscriptions.exhausted"), cls: "text-orange-400 bg-orange-500/10 border-orange-500/20" },
    unknown: { label: t("commerce.common.unknownStatus"), cls: "text-gray-400 bg-gray-500/10 border-gray-500/20" },
  };
}

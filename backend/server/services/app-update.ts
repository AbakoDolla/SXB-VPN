import { randomUUID } from "crypto";
import { prisma } from "../database";

export const APP_UPDATE_SETTING_KEY = "sxb.app-update.v1";
export const DISTRIBUTABLE_ROLES = ["OWNER", "SUPER_ADMIN", "ADMIN", "SUPPORT", "RESELLER"] as const;

export interface PublishedAppUpdate {
  id: string;
  versionCode: number;
  versionName: string;
  apkUrl: string;
  notes: string;
  minSupportedCode: number;
  forceUpdate: boolean;
  active: boolean;
  targetRoles: string[];
  targetDeviceIds: string[];
  publishedAt: string;
  updatedAt: string;
}

function normalize(value: unknown): PublishedAppUpdate | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const versionCode = Number(item.versionCode);
  const minSupportedCode = Number(item.minSupportedCode ?? 0);
  const versionName = String(item.versionName || "").trim();
  const apkUrl = String(item.apkUrl || "").trim();
  if (!Number.isInteger(versionCode) || versionCode <= 0 || !versionName || !apkUrl) return null;
  return {
    id: String(item.id || `app-update-${versionCode}`),
    versionCode,
    versionName,
    apkUrl,
    notes: String(item.notes || "").trim(),
    minSupportedCode: Number.isInteger(minSupportedCode) && minSupportedCode >= 0 ? minSupportedCode : 0,
    forceUpdate: item.forceUpdate === true,
    active: item.active !== false,
    targetRoles: Array.isArray(item.targetRoles) ? item.targetRoles.filter((r): r is string => typeof r === "string") : [...DISTRIBUTABLE_ROLES],
    targetDeviceIds: Array.isArray(item.targetDeviceIds) ? item.targetDeviceIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0) : [],
    publishedAt: String(item.publishedAt || item.updatedAt || new Date(0).toISOString()),
    updatedAt: String(item.updatedAt || item.publishedAt || new Date(0).toISOString()),
  };
}

export async function readPublishedAppUpdate(): Promise<PublishedAppUpdate | null> {
  if (!prisma) return null;
  const row = await (prisma as any).setting.findUnique({ where: { key: APP_UPDATE_SETTING_KEY } });
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value);
    const normalized = normalize(parsed);
    return normalized?.active ? normalized : null;
  } catch {
    return null;
  }
}

export async function writePublishedAppUpdate(input: Omit<PublishedAppUpdate, "id" | "publishedAt" | "updatedAt"> & { id?: string }): Promise<PublishedAppUpdate> {
  if (!prisma) throw new Error("DB_UNAVAILABLE");
  const now = new Date().toISOString();
  const current = await readPublishedAppUpdate();
  const next: PublishedAppUpdate = {
    id: input.id || current?.id || randomUUID(),
    versionCode: input.versionCode,
    versionName: input.versionName,
    apkUrl: input.apkUrl,
    notes: input.notes,
    minSupportedCode: input.minSupportedCode,
    forceUpdate: input.forceUpdate,
    active: input.active,
    targetRoles: input.targetRoles,
    targetDeviceIds: input.targetDeviceIds,
    publishedAt: current?.publishedAt || now,
    updatedAt: now,
  };
  await (prisma as any).setting.upsert({
    where: { key: APP_UPDATE_SETTING_KEY },
    create: { key: APP_UPDATE_SETTING_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
  return next;
}

export async function clearPublishedAppUpdate(): Promise<void> {
  if (!prisma) throw new Error("DB_UNAVAILABLE");
  await (prisma as any).setting.delete({ where: { key: APP_UPDATE_SETTING_KEY } }).catch(() => undefined);
}

export async function isActivatedDevice(deviceId: string): Promise<boolean> {
  const normalized = deviceId.trim();
  if (!normalized || !prisma) return false;
  const registration = await (prisma as any).appRegistration.findUnique({ where: { deviceId: normalized } });
  if (!registration || registration.status !== "matched" || !registration.clientId) return false;
  const client = await (prisma as any).vpnClient.findUnique({ where: { id: registration.clientId }, select: { status: true } });
  return client?.status === "active";
}

export async function getMobileAppUpdate(deviceId: string | null | undefined): Promise<PublishedAppUpdate | null> {
  const update = await readPublishedAppUpdate();
  if (!update || !deviceId) return null;
  if (update.targetDeviceIds.length > 0 && !update.targetDeviceIds.includes(deviceId.trim())) return null;
  return (await isActivatedDevice(deviceId)) ? update : null;
}

export function toMobileAppVersion(update: PublishedAppUpdate) {
  return {
    id: update.id,
    versionCode: update.versionCode,
    versionName: update.versionName,
    apkUrl: update.apkUrl,
    notes: update.notes,
    minSupportedCode: update.minSupportedCode,
    forceUpdate: update.forceUpdate,
    publishedAt: update.publishedAt,
  };
}

export function isRoleTargeted(update: PublishedAppUpdate, role: string | undefined): boolean {
  return !!role && update.targetRoles.includes(role);
}

export function toPublicAppUpdate(update: PublishedAppUpdate) {
  return {
    id: update.id,
    versionCode: update.versionCode,
    versionName: update.versionName,
    apkUrl: update.apkUrl,
    notes: update.notes,
    minSupportedCode: update.minSupportedCode,
    forceUpdate: update.forceUpdate,
    targetRoles: update.targetRoles,
    targetDeviceIds: update.targetDeviceIds,
    publishedAt: update.publishedAt,
    updatedAt: update.updatedAt,
  };
}

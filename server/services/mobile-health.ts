import { createHmac } from "crypto";
import { z } from "zod";
import { prisma } from "../database";
import { readPublishedAppUpdate } from "./app-update";

export const MOBILE_HEALTH_REPORT_RETENTION_DAYS = 30;
export const MOBILE_HEALTH_DEVICE_RETENTION_DAYS = 90;
export const MOBILE_HEALTH_ACTIVE_WINDOW_HOURS = 48;

const errorCodes = [
  "NETWORK_UNAVAILABLE",
  "AUTH_REJECTED",
  "CONFIG_INVALID",
  "VPN_PERMISSION_DENIED",
  "TUNNEL_TIMEOUT",
  "TUNNEL_INTERRUPTED",
  "UNKNOWN",
] as const;
const protocols = [
  "vless",
  "vmess",
  "trojan",
  "shadowsocks",
  "hysteria2",
  "ssh",
  "ssh+payload",
  "wireguard",
  "tuic",
  "singbox",
] as const;

export const mobileHealthReportSchema = z.object({
  appVersion: z.string().trim().min(1).max(40).regex(/^[0-9A-Za-z._+-]+$/),
  versionCode: z.number().int().positive().max(2_147_483_647),
  androidApi: z.number().int().min(21).max(100).nullable().default(null),
  deviceModel: z.string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[\p{L}\p{N} ._()+-]+$/u)
    .nullable()
    .default(null),
  tunnelState: z.enum(["disconnected", "connecting", "connected", "error"]),
  protocol: z.enum(protocols).nullable().default(null),
  outcome: z.enum(["none", "success", "failure"]).default("none"),
  errorCode: z.enum(errorCodes).nullable().default(null),
  sessionDurationSeconds: z.number().int().nonnegative().max(7 * 24 * 60 * 60).default(0),
  reconnectCount: z.number().int().nonnegative().max(100).default(0),
  activeDurationSeconds: z.number().int().nonnegative().max(7 * 24 * 60 * 60).default(0),
  backgroundDurationSeconds: z.number().int().nonnegative().max(7 * 24 * 60 * 60).default(0),
  wakeCount: z.number().int().nonnegative().max(100).default(0),
  batteryOptimization: z.enum(["optimized", "unrestricted", "unknown"]).default("unknown"),
}).strict().superRefine((value, ctx) => {
  if (value.outcome !== "failure" && value.errorCode !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["errorCode"],
      message: "An error code is only accepted for failed sessions",
    });
  }
});

export type MobileHealthReportInput = z.infer<typeof mobileHealthReportSchema>;

export function pseudonymizeMobileDevice(userId: string, deviceId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${userId}\0${deviceId}`)
    .digest("base64url")
    .slice(0, 22);
}

export interface MobileHealthDeviceSnapshot {
  pseudonym: string;
  appVersion: string;
  versionCode: number;
  androidApi: number | null;
  deviceModel: string | null;
  lastSeenAt: Date;
  tunnelState: string;
  protocol: string | null;
  lastOutcome: string;
  lastErrorCode: string | null;
  sessionDurationSeconds: number;
  reconnectCount: number;
  activeDurationSeconds: number;
  backgroundDurationSeconds: number;
  wakeCount: number;
  reportCount: number;
  batteryOptimization: string;
}

export function summarizeMobileHealth(
  devices: MobileHealthDeviceSnapshot[],
  latestVersionCode: number | null,
  reportOutcomes: { outcome: string; count: number }[],
  now = new Date(),
) {
  const activeCutoff = now.getTime() - MOBILE_HEALTH_ACTIVE_WINDOW_HOURS * 60 * 60 * 1000;
  const outcomeCounts = new Map(reportOutcomes.map((item) => [item.outcome, item.count]));
  const successes = outcomeCounts.get("success") ?? 0;
  const failures = outcomeCounts.get("failure") ?? 0;
  const attempts = successes + failures;
  const versions = new Map<string, {
    appVersion: string;
    versionCode: number;
    devices: number;
    updatesNeeded: number;
  }>();

  let active = 0;
  let updatesNeeded = 0;
  const details = devices.map((device) => {
    const isActive = device.lastSeenAt.getTime() >= activeCutoff;
    const needsUpdate = latestVersionCode !== null && device.versionCode < latestVersionCode;
    if (isActive) active += 1;
    if (needsUpdate) updatesNeeded += 1;

    const key = `${device.versionCode}\0${device.appVersion}`;
    const version = versions.get(key) ?? {
      appVersion: device.appVersion,
      versionCode: device.versionCode,
      devices: 0,
      updatesNeeded: 0,
    };
    version.devices += 1;
    if (needsUpdate) version.updatesNeeded += 1;
    versions.set(key, version);

    return {
      ...device,
      lastSeenAt: device.lastSeenAt.toISOString(),
      needsUpdate,
    };
  });

  return {
    generatedAt: now.toISOString(),
    retentionDays: MOBILE_HEALTH_REPORT_RETENTION_DAYS,
    deviceRetentionDays: MOBILE_HEALTH_DEVICE_RETENTION_DAYS,
    activeWindowHours: MOBILE_HEALTH_ACTIVE_WINDOW_HOURS,
    latestVersionCode,
    totals: {
      devices: devices.length,
      active,
      inactive: devices.length - active,
      reports: reportOutcomes.reduce((sum, item) => sum + item.count, 0),
      successes,
      failures,
      successRate: attempts === 0 ? 0 : Math.round((successes / attempts) * 10_000) / 100,
      updatesNeeded,
    },
    versions: [...versions.values()].sort((a, b) => b.versionCode - a.versionCode),
    devices: details,
  };
}

let lastRetentionRunAt = 0;

async function applyRetention(now: Date): Promise<void> {
  if (!prisma || now.getTime() - lastRetentionRunAt < 6 * 60 * 60 * 1000) return;
  lastRetentionRunAt = now.getTime();
  const reportCutoff = new Date(now.getTime() - MOBILE_HEALTH_REPORT_RETENTION_DAYS * 86_400_000);
  const deviceCutoff = new Date(now.getTime() - MOBILE_HEALTH_DEVICE_RETENTION_DAYS * 86_400_000);
  await (prisma as any).$transaction([
    (prisma as any).mobileHealthReport.deleteMany({ where: { reportedAt: { lt: reportCutoff } } }),
    (prisma as any).mobileHealthDevice.deleteMany({ where: { lastSeenAt: { lt: deviceCutoff } } }),
  ]);
}

export async function storeMobileHealthReport(
  userId: string,
  deviceId: string,
  secret: string,
  input: MobileHealthReportInput,
): Promise<"accepted" | "device_not_activated" | "db_unavailable"> {
  if (!prisma) return "db_unavailable";
  const activatedClient = await (prisma as any).vpnClient.findFirst({
    where: { userId, deviceId, status: "active" },
    select: { id: true },
  });
  if (!activatedClient) return "device_not_activated";

  const now = new Date();
  const pseudonym = pseudonymizeMobileDevice(userId, deviceId, secret);
  await (prisma as any).$transaction(async (tx: any) => {
    const device = await tx.mobileHealthDevice.upsert({
      where: { pseudonym },
      create: {
        pseudonym,
        appVersion: input.appVersion,
        versionCode: input.versionCode,
        androidApi: input.androidApi,
        deviceModel: input.deviceModel,
        lastSeenAt: now,
        tunnelState: input.tunnelState,
        protocol: input.protocol,
        lastOutcome: input.outcome,
        lastErrorCode: input.errorCode,
        sessionDurationSeconds: input.sessionDurationSeconds,
        reconnectCount: input.reconnectCount,
        activeDurationSeconds: input.activeDurationSeconds,
        backgroundDurationSeconds: input.backgroundDurationSeconds,
        wakeCount: input.wakeCount,
        reportCount: 1,
        batteryOptimization: input.batteryOptimization,
      },
      update: {
        appVersion: input.appVersion,
        versionCode: input.versionCode,
        androidApi: input.androidApi,
        deviceModel: input.deviceModel,
        lastSeenAt: now,
        tunnelState: input.tunnelState,
        protocol: input.protocol,
        ...(input.outcome === "none" ? {} : {
          lastOutcome: input.outcome,
          lastErrorCode: input.errorCode,
        }),
        sessionDurationSeconds: { increment: input.sessionDurationSeconds },
        reconnectCount: { increment: input.reconnectCount },
        activeDurationSeconds: { increment: input.activeDurationSeconds },
        backgroundDurationSeconds: { increment: input.backgroundDurationSeconds },
        wakeCount: { increment: input.wakeCount },
        reportCount: { increment: 1 },
        batteryOptimization: input.batteryOptimization,
      },
      select: { id: true },
    });
    await tx.mobileHealthReport.create({
      data: {
        deviceId: device.id,
        reportedAt: now,
        tunnelState: input.tunnelState,
        protocol: input.protocol,
        outcome: input.outcome,
        errorCode: input.errorCode,
        sessionDurationSeconds: input.sessionDurationSeconds,
        reconnectCount: input.reconnectCount,
        activeDurationSeconds: input.activeDurationSeconds,
        backgroundDurationSeconds: input.backgroundDurationSeconds,
        wakeCount: input.wakeCount,
      },
    });
  });
  await applyRetention(now);
  return "accepted";
}

export async function getMobileHealthSummary() {
  if (!prisma) return null;
  const now = new Date();
  await applyRetention(now);
  const reportCutoff = new Date(now.getTime() - MOBILE_HEALTH_REPORT_RETENTION_DAYS * 86_400_000);
  const [devices, groupedOutcomes, update] = await Promise.all([
    (prisma as any).mobileHealthDevice.findMany({ orderBy: { lastSeenAt: "desc" } }),
    (prisma as any).mobileHealthReport.groupBy({
      by: ["outcome"],
      where: { reportedAt: { gte: reportCutoff } },
      _count: { _all: true },
    }),
    readPublishedAppUpdate(),
  ]);
  const reportOutcomes = groupedOutcomes.map((item: any) => ({
    outcome: item.outcome,
    count: item._count._all,
  }));
  return summarizeMobileHealth(devices, update?.versionCode ?? null, reportOutcomes, now);
}

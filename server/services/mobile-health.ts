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
  reportId: z.string().uuid(),
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
  /**
   * Battement de présence — rafraîchit `lastSeenAt` sans écrire d'historique.
   *
   * L'application émet un signal toutes les quelques minutes tant que le tunnel
   * est monté, faute de quoi un appareil ayant brutalement perdu le réseau
   * resterait « connecté » indéfiniment. Insérer une ligne de rapport à chaque
   * battement multiplierait l'historique par ~288 par appareil et par jour et
   * ferait exploser l'agrégation de la vue « Santé mobile ». Un battement ne
   * met donc à jour QUE l'état de présence de l'appareil, et n'incrémente aucun
   * compteur : les mesures de durée restent portées par les transitions de
   * cycle de vie, qui, elles, écrivent bien une ligne.
   */
  heartbeat: z.boolean().default(false),
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

// Le calcul vit dans `mobile-pseudonym` : il est pur, et le suivi de présence
// n'a pas à embarquer la validation d'entrée ni la base pour l'appeler. La
// réexportation garde intacts tous les appelants existants.
export { pseudonymizeMobileDevice } from "./mobile-pseudonym";

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
  const reportCutoff = new Date(now.getTime() - MOBILE_HEALTH_REPORT_RETENTION_DAYS * 86_400_000);
  const deviceCutoff = new Date(now.getTime() - MOBILE_HEALTH_DEVICE_RETENTION_DAYS * 86_400_000);
  try {
    await (prisma as any).$transaction([
      (prisma as any).mobileHealthReport.deleteMany({ where: { reportedAt: { lt: reportCutoff } } }),
      (prisma as any).mobileHealthDevice.deleteMany({ where: { lastSeenAt: { lt: deviceCutoff } } }),
    ]);
    lastRetentionRunAt = now.getTime();
  } catch (error) {
    lastRetentionRunAt = 0;
    throw error;
  }
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
  const legacyRegistration = activatedClient ? null : await (prisma as any).appRegistration.findFirst({
    where: {
      deviceId,
      status: "matched",
      client: { userId, status: "active" },
    },
    select: { id: true },
  });
  if (!activatedClient && !legacyRegistration) return "device_not_activated";

  const now = new Date();
  const pseudonym = pseudonymizeMobileDevice(userId, deviceId, secret);

  // Battement : seule la présence est rafraîchie. Ni ligne d'historique, ni
  // incrément de compteur — voir le commentaire du champ `heartbeat`.
  if (input.heartbeat) {
    await (prisma as any).mobileHealthDevice.upsert({
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
        reportCount: 0,
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
        batteryOptimization: input.batteryOptimization,
      },
      select: { id: true },
    });
    return "accepted";
  }

  try {
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
          reportId: input.reportId,
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
  } catch (error: any) {
    const target = Array.isArray(error?.meta?.target)
      ? error.meta.target.join(",")
      : String(error?.meta?.target || "");
    if (error?.code !== "P2002" || !target.includes("reportId")) throw error;
  }
  void applyRetention(now).catch((error) => {
    console.error("[mobile-health] retention failed:", error?.message || error);
  });
  return "accepted";
}

export async function getMobileHealthSummary() {
  if (!prisma) return null;
  const now = new Date();
  await applyRetention(now);
  const reportCutoff = new Date(now.getTime() - MOBILE_HEALTH_REPORT_RETENTION_DAYS * 86_400_000);
  const [deviceRows, groupedOutcomes, versionRows, totalDevices, activeDevices, update] = await Promise.all([
    (prisma as any).mobileHealthDevice.findMany({
      orderBy: { lastSeenAt: "desc" },
      take: 500,
      select: {
        pseudonym: true,
        appVersion: true,
        versionCode: true,
        androidApi: true,
        deviceModel: true,
        lastSeenAt: true,
        tunnelState: true,
        protocol: true,
        lastOutcome: true,
        lastErrorCode: true,
        batteryOptimization: true,
        reports: {
          where: { reportedAt: { gte: reportCutoff } },
          select: {
            sessionDurationSeconds: true,
            reconnectCount: true,
            activeDurationSeconds: true,
            backgroundDurationSeconds: true,
            wakeCount: true,
          },
        },
      },
    }),
    (prisma as any).mobileHealthReport.groupBy({
      by: ["outcome"],
      where: { reportedAt: { gte: reportCutoff } },
      _count: { _all: true },
    }),
    (prisma as any).mobileHealthDevice.groupBy({
      by: ["appVersion", "versionCode"],
      _count: { _all: true },
      orderBy: { versionCode: "desc" },
    }),
    (prisma as any).mobileHealthDevice.count(),
    (prisma as any).mobileHealthDevice.count({
      where: {
        lastSeenAt: {
          gte: new Date(now.getTime() - MOBILE_HEALTH_ACTIVE_WINDOW_HOURS * 60 * 60 * 1000),
        },
      },
    }),
    readPublishedAppUpdate(),
  ]);
  const devices = deviceRows.map((row: any) => {
    const { reports, ...device } = row;
    return {
      ...device,
      sessionDurationSeconds: reports.reduce((sum: number, item: any) => sum + item.sessionDurationSeconds, 0),
      reconnectCount: reports.reduce((sum: number, item: any) => sum + item.reconnectCount, 0),
      activeDurationSeconds: reports.reduce((sum: number, item: any) => sum + item.activeDurationSeconds, 0),
      backgroundDurationSeconds: reports.reduce((sum: number, item: any) => sum + item.backgroundDurationSeconds, 0),
      wakeCount: reports.reduce((sum: number, item: any) => sum + item.wakeCount, 0),
      reportCount: reports.length,
    };
  });
  const reportOutcomes = groupedOutcomes.map((item: any) => ({
    outcome: item.outcome,
    count: item._count._all,
  }));
  const summary = summarizeMobileHealth(devices, update?.versionCode ?? null, reportOutcomes, now);
  const latestVersionCode = update?.versionCode ?? null;
  summary.totals.devices = totalDevices;
  summary.totals.active = activeDevices;
  summary.totals.inactive = totalDevices - activeDevices;
  summary.totals.updatesNeeded = latestVersionCode === null
    ? 0
    : await (prisma as any).mobileHealthDevice.count({ where: { versionCode: { lt: latestVersionCode } } });
  summary.versions = versionRows.map((row: any) => ({
    appVersion: row.appVersion,
    versionCode: row.versionCode,
    devices: row._count._all,
    updatesNeeded: latestVersionCode !== null && row.versionCode < latestVersionCode ? row._count._all : 0,
  }));
  return {
    ...summary,
    detailsLimit: 500,
    detailsTruncated: totalDevices > devices.length,
  };
}

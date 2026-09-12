import { Router, Response } from "express";
import { z } from "zod";
import { logDbActivity, prisma } from "../database";
import { AuthenticatedRequest, requireAuth } from "../middleware/auth";
import {
  DISTRIBUTABLE_ROLES,
  isActivatedDevice,
  isRoleTargeted,
  readPublishedAppUpdate,
  toPublicAppUpdate,
  writePublishedAppUpdate,
  clearPublishedAppUpdate,
} from "../services/app-update";
import { sendAppUpdatePush } from "../services/fcm";
import { readLatestBuildManifest } from "../services/app-build-manifest";

const router = Router();
const roleSchema = z.enum(DISTRIBUTABLE_ROLES);
const appUpdateSchema = z.object({
  versionCode: z.number().int().positive(),
  versionName: z.string().trim().min(1).max(40),
  apkUrl: z.string().url().refine((value) => value.startsWith("https://"), "L’URL APK doit utiliser HTTPS"),
  // Optionnel pour rester compatible avec les intégrations existantes : quand il
  // est fourni, l'application mobile refuse d'installer un APK dont le condensat
  // diffère.
  apkSha256: z
    .string()
    .trim()
    .transform((value) => value.replace(/^sha256:/i, "").replace(/[:\s]/g, ""))
    .refine((value) => value === "" || /^[0-9a-f]{64}$/i.test(value), "Le condensat SHA-256 doit comporter 64 caractères hexadécimaux")
    .default(""),
  notes: z.string().trim().max(2000).default(""),
  minSupportedCode: z.number().int().nonnegative().default(0),
  forceUpdate: z.boolean().default(false),
  targetRoles: z.array(roleSchema).default([...DISTRIBUTABLE_ROLES]),
  targetDeviceIds: z.array(z.string().trim().min(1).max(160)).default([]),
  active: z.boolean().default(true),
});

function isSuperAdmin(req: AuthenticatedRequest): boolean {
  return req.user?.role === "SUPER_ADMIN";
}

async function countActivatedDevices(): Promise<number> {
  if (!prisma) return 0;
  return (prisma as any).vpnClient.count({
    where: { status: "active", deviceId: { not: null } },
  }).catch(() => 0);
}

router.get("/current", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const update = await readPublishedAppUpdate();
    if (!update) return res.json({ update: null, canPublish: isSuperAdmin(req), eligibleDeviceCount: await countActivatedDevices() });
    return res.json({
      update: toPublicAppUpdate(update),
      visibleToRole: isRoleTargeted(update, req.user?.role),
      canPublish: isSuperAdmin(req),
      eligibleDeviceCount: await countActivatedDevices(),
    });
  } catch (err: any) {
    return res.status(503).json({ error: "DB_UNAVAILABLE", message: err.message || "Version indisponible" });
  }
});

/**
 * GET /latest-build — la dernière APK réellement déployée.
 *
 * Sert à PROPOSER une publication, jamais à en déclencher une : le choix des
 * appareils, des rôles et du caractère obligatoire reste entièrement manuel.
 * Évite de ressaisir à la main un versionCode et 64 caractères de condensat,
 * dont la moindre faute ne se voit qu'une fois la mise à jour refusée par tous
 * les appareils.
 */
router.get("/latest-build", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  if (!isSuperAdmin(req)) {
    return res.status(403).json({ error: "SUPER_ADMIN_ONLY", message: "Réservé au SUPER_ADMIN" });
  }
  const build = readLatestBuildManifest();
  const published = await readPublishedAppUpdate().catch(() => null);
  return res.json({
    build,
    // Vrai quand une build plus récente que la publication en cours attend
    // d'être distribuée — y compris lorsque plus rien n'est publié.
    newerThanPublished: Boolean(build && (!published || build.versionCode > published.versionCode)),
  });
});

router.post("/publish", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  if (!isSuperAdmin(req)) {
    return res.status(403).json({ error: "SUPER_ADMIN_ONLY", message: "La publication d’une mise à jour est réservée au SUPER_ADMIN" });
  }
  try {
    const input = appUpdateSchema.parse(req.body);
    const uniqueDeviceIds = [...new Set(input.targetDeviceIds)];
    const invalidDevices: string[] = [];
    for (const deviceId of uniqueDeviceIds) {
      if (!(await isActivatedDevice(deviceId))) invalidDevices.push(deviceId);
    }
    if (invalidDevices.length > 0) {
      return res.status(422).json({ error: "INVALID_TARGET_DEVICES", message: "Un ou plusieurs appareils ne sont pas activés", invalidDevices });
    }
    const update = await writePublishedAppUpdate({ ...input, targetDeviceIds: uniqueDeviceIds });
    await logDbActivity(req.user.userId, `Mise à jour publiée: ${update.versionName} (${update.versionCode})`, "success", req.ip || "");
    const push = await sendAppUpdatePush(update);
    return res.status(201).json({
      update: toPublicAppUpdate(update),
      eligibleDeviceCount: await countActivatedDevices(),
      push,
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(422).json({ error: "VALIDATION", message: err.issues[0]?.message || "Version invalide" });
    }
    return res.status(503).json({ error: "DB_UNAVAILABLE", message: err.message || "Publication impossible" });
  }
});

router.delete("/current", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  if (!isSuperAdmin(req)) {
    return res.status(403).json({ error: "SUPER_ADMIN_ONLY", message: "La désactivation est réservée au SUPER_ADMIN" });
  }
  try {
    await clearPublishedAppUpdate();
    await logDbActivity(req.user.userId, "Mise à jour mobile désactivée", "warning", req.ip || "");
    return res.json({ success: true, update: null });
  } catch (err: any) {
    return res.status(503).json({ error: "DB_UNAVAILABLE", message: err.message || "Désactivation impossible" });
  }
});

export default router;

import { Router, Response } from "express";
import { z } from "zod";
import { logDbActivity, prisma } from "../database";
import { AuthenticatedRequest, requireAuth } from "../middleware/auth";
import {
  DISTRIBUTABLE_ROLES,
  isActivatedDevice,
  isRoleTargeted,
  publicationDecritLeFichierServi,
  readPublishedAppUpdate,
  toPublicAppUpdate,
  writePublishedAppUpdate,
  clearPublishedAppUpdate,
} from "../services/app-update";
import { sendAppUpdatePush } from "../services/fcm";
import { readLatestBuildManifest } from "../services/app-build-manifest";
import { porteeClients } from "../services/portee-donnees";
import { etFiltres } from "../services/free-trial-marks";

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

/**
 * Nombre d'appareils activés QUE LE REQUÉRANT PEUT VOIR.
 *
 * Mesuré à l'écran en production : un administrateur possédant UN SEUL appareil
 * lisait « APPAREILS ACTIVÉS : 749 » — le parc entier de la plateforme. La
 * liste sélectionnable juste en dessous, elle, était correctement cloisonnée :
 * seul le total échappait. C'est le même défaut que sur `/api/analytics/users`,
 * et la même cause — la fonction ne recevait pas la requête, donc ne pouvait
 * appliquer aucune portée.
 *
 * Un écran en lecture seule reste une fuite : il annonçait à chaque exploitant
 * l'ampleur du parc qu'on lui cache.
 */
async function countActivatedDevices(req: AuthenticatedRequest): Promise<number> {
  if (!prisma) return 0;
  const portee = await porteeClients(prisma, req.user);
  return (prisma as any).vpnClient.count({
    where: etFiltres({ status: "active", deviceId: { not: null } }, portee),
  }).catch(() => 0);
}

router.get("/current", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const update = await readPublishedAppUpdate();
    if (!update) return res.json({ update: null, canPublish: isSuperAdmin(req), eligibleDeviceCount: await countActivatedDevices(req) });
    // Une publication qui ne décrit plus le fichier servi n'est PAS distribuée :
    // l'annoncer enverrait chaque appareil vers un échec d'intégrité. L'écran
    // doit donc le dire, sinon l'exploitant ne verrait qu'un silence inexpliqué.
    const describesServedApk = publicationDecritLeFichierServi(update);
    return res.json({
      update: toPublicAppUpdate(update, { inclureCiblageAppareils: isSuperAdmin(req) }),
      visibleToRole: isRoleTargeted(update, req.user?.role),
      canPublish: isSuperAdmin(req),
      eligibleDeviceCount: await countActivatedDevices(req),
      describesServedApk,
      // `distributed` répond à la seule question utile : est-ce que quelqu'un
      // la reçoit en ce moment ?
      distributed: update.active && describesServedApk,
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
      // Réservé au SUPER_ADMIN par le garde en tête de route : le ciblage
      // qu'il vient lui-même de définir lui est renvoyé intact.
      update: toPublicAppUpdate(update, { inclureCiblageAppareils: true }),
      eligibleDeviceCount: await countActivatedDevices(req),
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

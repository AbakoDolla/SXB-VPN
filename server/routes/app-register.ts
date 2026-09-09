import { Router, type NextFunction, type Response } from "express";
import { z } from "zod";
import { prisma } from "../database";
import { requireAuth, requirePermission, requireRole, type AuthenticatedRequest } from "../middleware/auth";

const router = Router();
const deviceIdSchema = z.string().trim().min(1).max(255);
const registrationSchema = z.object({
  deviceId: deviceIdSchema,
  phone: z.string().trim().max(40).nullish(),
  // Older callers may still send a token here. It is never an authentication
  // substitute and is neither stored nor used to discover an existing client.
  token: z.string().max(128).nullish(),
  platform: z.string().trim().max(32).optional(),
  appVersion: z.string().trim().max(64).optional(),
}).strict();

const clientInclude = {
  user: { select: { name: true } },
  subscriptions: {
    where: { status: "active" },
    select: { dataToken: true, expireAt: true, quotaBytes: true, quotaUsed: true, profile: { select: { name: true } } },
    orderBy: { expireAt: "desc" },
    take: 1,
  },
} as const;

function optionalAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  return req.headers.authorization ? requireAuth(req, res, next) : next();
}

function requireMobileClient(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (req.user?.role !== "CLIENT") {
    return res.status(403).json({ error: "errors.auth.forbidden", message: "Une session mobile est requise." });
  }
  if (!req.user.clientId) {
    return res.status(401).json({ error: "errors.mobile.activation_required", message: "Réactivez votre appareil pour renouveler sa session." });
  }
  return next();
}

class ClientBindingChanged extends Error {}

function registrationFailure(error: unknown, res: Response) {
  if (error instanceof z.ZodError) {
    return res.status(400).json({ error: "errors.validation", details: error.issues });
  }
  if (error instanceof ClientBindingChanged) {
    return res.status(404).json({ error: "errors.mobile.no_account", message: "Aucun compte associé à cette session et cet appareil." });
  }
  if (error && typeof error === "object" && "code" in error && error.code === "P2034") {
    return res.status(409).json({ error: "errors.mobile.registration_changed", message: "L'enregistrement a changé. Veuillez réessayer." });
  }
  console.error("App registration request failed");
  return res.status(500).json({ error: "errors.server", message: "Enregistrement temporairement indisponible." });
}

router.post("/", optionalAuth, async (req: AuthenticatedRequest, res: Response) => {
  res.set("Cache-Control", "no-store");
  try {
    const body = registrationSchema.parse(req.body);
    if (!prisma) return res.status(503).json({ error: "errors.db.unavailable" });
    const { deviceId, phone, platform, appVersion } = body;

    if (!req.user) {
      await prisma.appRegistration.upsert({
        where: { deviceId },
        create: { deviceId, phone: phone ?? null, platform, appVersion, status: "pending" },
        update: {},
      });
      await prisma.appRegistration.updateMany({
        where: { deviceId, status: "pending", clientId: null },
        data: { lastSeenAt: new Date(), phone: phone ?? undefined, platform, appVersion },
      });
      return res.json({
        success: true,
        matched: false,
        message: "Appareil enregistré. Activez votre accès avec le code fourni par votre opérateur.",
      });
    }

    if (req.user.role !== "CLIENT" || !req.user.clientId) {
      return res.status(403).json({ error: "errors.auth.forbidden", message: "Une session liée au client mobile est requise." });
    }
    const scope = { id: req.user.clientId, userId: req.user.userId, deviceId, status: "active" };
    const client = await prisma.$transaction(async tx => {
      const current = await tx.vpnClient.findFirst({ where: scope, include: clientInclude });
      if (!current) throw new ClientBindingChanged();
      const updated = await tx.vpnClient.updateMany({
        where: scope,
        data: { lastSeenAt: new Date(), appRegisteredAt: current.appRegisteredAt ?? new Date() },
      });
      if (updated.count !== 1) throw new ClientBindingChanged();
      await tx.appRegistration.upsert({
        where: { deviceId },
        create: { deviceId, phone: phone ?? null, platform, appVersion, clientId: current.id, status: "matched" },
        update: { lastSeenAt: new Date(), phone: phone ?? null, platform, appVersion, clientId: current.id, status: "matched" },
      });
      return current;
    }, { isolationLevel: "Serializable" });
    const sub = client.subscriptions[0];
    return res.json({
      success: true, matched: true, clientId: client.id, name: client.user?.name,
      status: client.status, token: client.token, deviceId: client.deviceId,
      hasActive: !!sub,
      subscription: sub ? {
        dataToken: sub.dataToken, expireAt: sub.expireAt,
        quotaBytes: sub.quotaBytes.toString(), quotaUsed: sub.quotaUsed.toString(),
        profile: sub.profile?.name,
      } : null,
    });
  } catch (error) {
    return registrationFailure(error, res);
  }
});

router.get("/status/:deviceId", requireAuth, requireMobileClient, async (req: AuthenticatedRequest, res: Response) => {
  res.set("Cache-Control", "no-store");
  try {
    if (!prisma) return res.status(503).json({ error: "errors.db.unavailable" });
    const deviceId = deviceIdSchema.parse(req.params.deviceId);
    const client = await prisma.vpnClient.findFirst({
      where: { id: req.user!.clientId, userId: req.user!.userId, deviceId },
      include: clientInclude,
    });
    if (!client) throw new ClientBindingChanged();
    const sub = client.subscriptions[0];
    return res.json({
      active: client.status === "active", matched: true, clientStatus: client.status,
      hasActive: !!sub,
      subscription: sub ? {
        dataToken: sub.dataToken, expireAt: sub.expireAt,
        quotaBytes: sub.quotaBytes.toString(), quotaUsed: sub.quotaUsed.toString(),
        profile: sub.profile?.name,
      } : null,
    });
  } catch (error) {
    return registrationFailure(error, res);
  }
});

router.get("/pending", requireAuth, requireRole(["SUPER_ADMIN", "ADMIN", "SUPPORT"]), requirePermission("clients.view"), async (_req: AuthenticatedRequest, res: Response) => {
  res.set("Cache-Control", "no-store");
  try {
    if (!prisma) return res.status(503).json({ error: "errors.db.unavailable" });
    const pending = await prisma.appRegistration.findMany({
      where: { status: "pending" },
      orderBy: { lastSeenAt: "desc" },
    });
    return res.json({ success: true, pending });
  } catch (error) {
    return registrationFailure(error, res);
  }
});

export default router;

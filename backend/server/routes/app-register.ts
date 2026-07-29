/**
 * /api/app/register — Called by the SXB VPN mobile app on launch.
 * No auth required — the app identifies itself by deviceId + phone.
 * Matches an existing VpnClient and updates lastSeenAt.
 * If no match, creates a pending AppRegistration for admin review.
 */
import { Router, Request, Response } from "express";
import { prisma } from "../database";

const router = Router();

// ── POST /api/app/register ────────────────────────────────────────────────────
router.post("/", async (req: Request, res: Response) => {
  try {
    const { deviceId, phone, token, platform, appVersion } = req.body;
    if (!deviceId) return res.status(400).json({ error: "deviceId is required" });
    if (!prisma)  return res.status(503).json({ error: "Database unavailable" });

    // 1. Find client by deviceId
    let client: any = await (prisma as any).vpnClient.findUnique({
      where: { deviceId },
      include: {
        user: { select: { name: true, email: true, phone: true } },
        subscriptions: {
          where: { status: "active" },
          include: { profile: true },
          orderBy: { expireAt: "desc" },
          take: 1,
        },
      },
    });

    // 2. Fallback: find by SXB-USER token
    if (!client && token) {
      client = await (prisma as any).vpnClient.findUnique({
        where: { token },
        include: {
          user: { select: { name: true, email: true, phone: true } },
          subscriptions: { where: { status: "active" }, include: { profile: true }, take: 1 },
        },
      });
    }

    // 3. Fallback: find by phone number via User
    if (!client && phone) {
      const user = await (prisma as any).user.findFirst({ where: { phone } });
      if (user) {
        const found = await (prisma as any).vpnClient.findFirst({
          where: { userId: user.id },
          include: {
            user: { select: { name: true, email: true, phone: true } },
            subscriptions: { where: { status: "active" }, include: { profile: true }, take: 1 },
          },
          orderBy: { createdAt: "desc" },
        });
        if (found) client = found;
      }
    }

    if (client) {
      // Bind deviceId (only if not already bound to another device)
      const updateData: any = {
        lastSeenAt: new Date(),
        appRegisteredAt: client.appRegisteredAt ?? new Date(),
        activatedAt:     client.activatedAt     ?? new Date(),
      };
      if (!client.deviceId) updateData.deviceId = deviceId;

      // Mark any pending AppRegistration as matched
      await (prisma as any).appRegistration.upsert({
        where: { deviceId },
        create: { deviceId, phone: phone ?? null, platform, appVersion, clientId: client.id, status: "matched" },
        update: { lastSeenAt: new Date(), clientId: client.id, status: "matched" },
      });

      await (prisma as any).vpnClient.update({ where: { id: client.id }, data: updateData });

      const activeSub = client.subscriptions?.[0];
      return res.json({
        success:     true,
        matched:     true,
        clientId:    client.id,
        name:        client.user?.name,
        status:      client.status,
        token:       client.token,
        deviceId:    client.deviceId ?? deviceId,
        hasActive:   !!activeSub,
        subscription: activeSub ? {
          dataToken:  activeSub.dataToken,
          expireAt:   activeSub.expireAt,
          quotaBytes: activeSub.quotaBytes.toString(),
          quotaUsed:  activeSub.quotaUsed.toString(),
          profile:    activeSub.profile?.name,
        } : null,
      });
    }

    // No client found — register as pending
    await (prisma as any).appRegistration.upsert({
      where:  { deviceId },
      create: { deviceId, phone: phone ?? null, platform, appVersion, status: "pending" },
      update: { lastSeenAt: new Date(), phone: phone ?? undefined },
    });

    return res.json({
      success: true,
      matched: false,
      message: "Appareil enregistre en attente d activation. Contactez votre administrateur.",
    });
  } catch (err) {
    console.error("app-register error:", err);
    return res.status(500).json({ error: "Registration failed" });
  }
});

// ── GET /api/app/status/:deviceId ─────────────────────────────────────────────
router.get("/status/:deviceId", async (req: Request, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "Database unavailable" });
    const client = await (prisma as any).vpnClient.findUnique({
      where: { deviceId: req.params.deviceId },
      include: { subscriptions: { where: { status: "active" }, include: { profile: true }, take: 1 } },
    });
    if (!client) return res.json({ active: false, matched: false });
    const sub = client.subscriptions?.[0];
    return res.json({
      active:       client.status === "active",
      matched:      true,
      clientStatus: client.status,
      hasActive:    !!sub,
      subscription: sub ? {
        dataToken:  sub.dataToken,
        expireAt:   sub.expireAt,
        quotaBytes: sub.quotaBytes.toString(),
        quotaUsed:  sub.quotaUsed.toString(),
        profile:    sub.profile?.name,
      } : null,
    });
  } catch (err) {
    return res.status(500).json({ error: "Status check failed" });
  }
});

// ── GET /api/app/pending ───────────────────────────────────────────────────────
// Admin-only: list devices waiting for activation
router.get("/pending", async (_req: Request, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "Database unavailable" });
    const pending = await (prisma as any).appRegistration.findMany({
      where: { status: "pending" },
      orderBy: { lastSeenAt: "desc" },
    });
    return res.json({ success: true, pending });
  } catch (err) {
    return res.status(500).json({ error: "Failed to list pending" });
  }
});

export default router;

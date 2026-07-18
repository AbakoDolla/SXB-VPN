import { Router, Response } from "express";
import { z } from "zod";
import { prisma } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";
import crypto from "crypto";

const router = Router();

function generateDataToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const part = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `SXB-DATA-${part()}-${part()}-${part()}`;
}

function sanitizeSub(s: any) {
  return {
    ...s,
    quotaBytes: s.quotaBytes?.toString() ?? "0",
    quotaUsed:  s.quotaUsed?.toString()  ?? "0",
  };
}

const createSchema = z.object({
  clientId:    z.string().uuid(),
  profileId:   z.string().uuid(),
  deviceId:    z.string().optional(),
  name:        z.string().optional(),
  quotaGB:     z.coerce.number().positive(),
  durationDays:z.coerce.number().min(1),
  deviceLimit: z.coerce.number().min(1).default(1),
});

const updateSchema = createSchema.partial();

// GET /api/subscriptions
router.get("/", requireAuth, requirePermission("clients.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "DB unavailable" });
    const isReseller = req.user?.role === "RESELLER";
    const subs = await (prisma as any).subscription.findMany({
      where: isReseller ? { client: { userId: req.user?.userId } } : undefined,
      orderBy: { createdAt: "desc" },
      include: {
        client: { include: { user: { select: { id: true, name: true, email: true } } } },
        profile: true,
      },
    });
    return res.json({ subscriptions: subs.map(sanitizeSub) });
  } catch (err) {
    console.error("List subscriptions error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/subscriptions/:id
router.get("/:id", requireAuth, requirePermission("clients.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "DB unavailable" });
    const sub = await (prisma as any).subscription.findUnique({
      where: { id: req.params.id },
      include: {
        client: { include: { user: { select: { id: true, name: true, email: true } } } },
        profile: true,
      },
    });
    if (!sub) return res.status(404).json({ error: "Subscription not found" });
    return res.json({ subscription: sanitizeSub(sub) });
  } catch (err) {
    console.error("Get subscription error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /api/subscriptions
router.post("/", requireAuth, requirePermission("clients.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "DB unavailable" });
    const body = createSchema.parse(req.body);
    const quotaBytes = BigInt(Math.round(body.quotaGB * 1024 * 1024 * 1024));
    const expireAt = new Date();
    expireAt.setDate(expireAt.getDate() + body.durationDays);

    // unique data token
    let dataToken = generateDataToken();
    let attempts = 0;
    while (attempts < 10) {
      const taken = await (prisma as any).subscription.findUnique({ where: { dataToken } });
      if (!taken) break;
      dataToken = generateDataToken();
      attempts++;
    }

    const sub = await (prisma as any).subscription.create({
      data: {
        clientId:    body.clientId,
        profileId:   body.profileId,
        deviceId:    body.deviceId ?? null,
        name:        body.name ?? null,
        dataToken,
        quotaBytes,
        quotaUsed:   BigInt(0),
        durationDays:body.durationDays,
        deviceLimit: body.deviceLimit,
        expireAt,
        status: "active",
      },
      include: {
        client: { include: { user: { select: { id: true, name: true, email: true } } } },
        profile: true,
      },
    });
    return res.status(201).json({ subscription: sanitizeSub(sub) });
  } catch (err: any) {
    if (err.name === "ZodError") return res.status(400).json({ error: "Validation error", details: err.errors });
    console.error("Create subscription error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// PUT /api/subscriptions/:id
router.put("/:id", requireAuth, requirePermission("clients.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "DB unavailable" });
    const body = updateSchema.parse(req.body);
    const data: any = { ...body };
    if (body.quotaGB) data.quotaBytes = BigInt(Math.round(body.quotaGB * 1024 * 1024 * 1024));
    if (body.durationDays) {
      const current = await (prisma as any).subscription.findUnique({ where: { id: req.params.id } });
      if (current) {
        const expireAt = new Date(current.startAt);
        expireAt.setDate(expireAt.getDate() + body.durationDays);
        data.expireAt = expireAt;
      }
    }
    delete data.quotaGB;
    const sub = await (prisma as any).subscription.update({ where: { id: req.params.id }, data });
    return res.json({ subscription: sanitizeSub(sub) });
  } catch (err: any) {
    if (err.name === "ZodError") return res.status(400).json({ error: "Validation error", details: err.errors });
    console.error("Update subscription error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /api/subscriptions/:id/revoke
router.post("/:id/revoke", requireAuth, requirePermission("clients.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "DB unavailable" });
    const { reason } = req.body;
    await (prisma as any).subscription.update({
      where: { id: req.params.id },
      data: { status: "revoked", revokeReason: reason ?? null },
    });
    return res.json({ success: true });
  } catch (err) {
    console.error("Revoke subscription error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// DELETE /api/subscriptions/:id
router.delete("/:id", requireAuth, requirePermission("clients.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "DB unavailable" });
    await (prisma as any).subscription.delete({ where: { id: req.params.id } });
    return res.json({ success: true });
  } catch (err) {
    console.error("Delete subscription error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;

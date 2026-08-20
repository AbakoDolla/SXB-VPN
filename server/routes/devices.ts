import { Router, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { prisma, logDbActivity } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";
import { sanitizeDevice, selectDeviceSubscription } from "../services/device-quota";

const router = Router();

function makeUserToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const part = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `SXB-USER-${part()}-${part()}-${part()}`;
}


// GET /api/devices — list all VPN clients with device info
router.get("/", requireAuth, requirePermission("clients.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "Database unavailable" });
    const clients = await prisma.vpnClient.findMany({
      include: {
        user: true,
        subscriptions: {
          where: { status: { not: "revoked" } },
          include: { devices: true },
          orderBy: [{ lastProvisionAt: "desc" }, { createdAt: "desc" }],
        },
      },
      orderBy: { createdAt: "desc" },
    });
    const ids = clients.map((client) => client.id);
    const usageRows = ids.length
      ? await (prisma as any).trafficUsage.findMany({
          where: { clientId: { in: ids } },
          select: { clientId: true, accountId: true, deviceId: true, download: true, upload: true, timestamp: true },
          orderBy: { timestamp: "desc" },
        })
      : [];
    const byClient = new Map<string, { download: bigint; upload: bigint; lastSeenAt: Date | null }>();
    const bySubscriptionDevice = new Map<string, { download: bigint; upload: bigint; lastSeenAt: Date | null }>();
    for (const row of usageRows as any[]) {
      const current = byClient.get(row.clientId) || { download: 0n, upload: 0n, lastSeenAt: null };
      current.download += BigInt(row.download || 0);
      current.upload += BigInt(row.upload || 0);
      if (!current.lastSeenAt && row.timestamp) current.lastSeenAt = new Date(row.timestamp);
      byClient.set(row.clientId, current);

      if (row.accountId) {
        const key = `${row.clientId}:${row.accountId}:${row.deviceId || ""}`;
        const scoped = bySubscriptionDevice.get(key) || { download: 0n, upload: 0n, lastSeenAt: null };
        scoped.download += BigInt(row.download || 0);
        scoped.upload += BigInt(row.upload || 0);
        if (!scoped.lastSeenAt && row.timestamp) scoped.lastSeenAt = new Date(row.timestamp);
        bySubscriptionDevice.set(key, scoped);
      }
    }
    return res.json({ devices: clients.map((client) => {
      const subscription = selectDeviceSubscription(client);
      const exactKey = subscription ? `${client.id}:${subscription.id}:${client.deviceId || ""}` : "";
      const scopedUsage = exactKey ? bySubscriptionDevice.get(exactKey) : undefined;
      return sanitizeDevice(client, scopedUsage || byClient.get(client.id), subscription);
    }) });
  } catch (err) {
    console.error("List devices error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

const generateSchema = z.object({
  deviceId: z.string().min(6, "Device ID invalide"),
  label: z.string().optional(),
  durationDays: z.coerce.number().min(1).default(365),
});

// POST /api/devices/generate-token — generate activation token for a device ID
router.post("/generate-token", requireAuth, requirePermission("clients.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "Database unavailable" });
    const body = generateSchema.parse(req.body);

    // Check if device already has a token
    const existing = await (prisma as any).vpnClient.findFirst({ 
      where: { deviceId: body.deviceId },
      include: { user: true }
    });
    if (existing) {
      return res.status(409).json({
        error: "DEVICE_ALREADY_REGISTERED",
        message: "Cet appareil a déjà un token actif",
        device: sanitizeDevice(existing),
      });
    }

    // Generate unique token SXB-USER-XXXX-XXXX-XXXX
    let tokenStr = makeUserToken();
    let attempts = 0;
    while (attempts < 10) {
      const taken = await prisma.vpnClient.findUnique({ where: { token: tokenStr } });
      if (!taken) break;
      tokenStr = makeUserToken();
      attempts++;
    }

    // Find or create a role for device clients
    const clientRole = await prisma.role.findFirst({ where: { name: "RESELLER" } });
    if (!clientRole) return res.status(500).json({ error: "Role RESELLER introuvable" });

    const passwordHash = crypto.randomBytes(24).toString("hex");
    const labelName = body.label || `Appareil ${body.deviceId.slice(0, 12)}`;
    const email = `device.${body.deviceId.slice(0, 16).toLowerCase().replace(/[^a-z0-9]/g, "")}@sxbvpn.local`;

    // Create user account for this device
    let deviceUser = await prisma.user.findFirst({ where: { email } });
    if (!deviceUser) {
      deviceUser = await prisma.user.create({
        data: {
          name: labelName,
          email,
          passwordHash,
          roleId: clientRole.id,
          status: "active",
        },
      });
    }

    const expireAt = new Date();
    expireAt.setDate(expireAt.getDate() + body.durationDays);

    const client = await (prisma as any).vpnClient.create({
      data: {
        userId: deviceUser.id,
        token: tokenStr,
        deviceId: body.deviceId,
        expireAt,
        status: "active",
      },
      include: { user: true },
    });

    await logDbActivity(
      req.user?.userId || null,
      `Token généré pour appareil ${body.deviceId}: ${tokenStr} (expire ${expireAt.toLocaleDateString()})`,
      "success",
      req.ip
    );

    return res.status(201).json(sanitizeDevice(client));
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: "Validation", details: err.issues });
    console.error("Generate device token error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /api/devices/:id/revoke
router.post("/:id/revoke", requireAuth, requirePermission("clients.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "Database unavailable" });
    const client = await prisma.vpnClient.update({
      where: { id: req.params.id },
      data: { status: "suspended" },
      include: { user: true },
    });
    await logDbActivity(req.user?.userId || null, `Token révoqué: ${client.token}`, "warning", req.ip);
    return res.json(sanitizeDevice(client));
  } catch (err) {
    console.error("Revoke device error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /api/devices/:id/renew — extend by durationDays
router.post("/:id/renew", requireAuth, requirePermission("clients.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "Database unavailable" });
    const { durationDays = 365 } = req.body;
    const existing = await prisma.vpnClient.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Appareil introuvable" });
    
    const base = existing.expireAt && existing.expireAt > new Date() ? existing.expireAt : new Date();
    const newExpiry = new Date(base);
    newExpiry.setDate(newExpiry.getDate() + durationDays);
    
    const client = await prisma.vpnClient.update({
      where: { id: req.params.id },
      data: { status: "active", expireAt: newExpiry },
      include: { user: true },
    });
    await logDbActivity(req.user?.userId || null, `Token renouvelé: ${client.token} → expire ${newExpiry.toLocaleDateString()}`, "success", req.ip);
    return res.json(sanitizeDevice(client));
  } catch (err) {
    console.error("Renew device error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;

import { Router, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { prisma, inMemoryDb, logDbActivity } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";
import { XPanelService } from "../services/xpanel";

const router = Router();

const createResellerSchema = z.object({
  userId: z.string(),
  commission: z.coerce.number().min(0).max(100).default(20),
  status: z.enum(["active", "suspended"]).default("active"),
});

const resellerCreateClientSchema = z.object({
  name: z.string().min(2),
  quotaTotalGb: z.coerce.number().min(1).default(50),
  durationDays: z.coerce.number().min(1).default(30),
  deviceLimit: z.coerce.number().min(1).default(1),
});

// GET /api/resellers
router.get("/", requireAuth, requirePermission("reseller.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    let resellers: any[] = [];
    if (prisma) {
      resellers = await prisma.reseller.findMany({
        include: { user: true },
      });
    } else {
      resellers = inMemoryDb.resellers.map((r) => {
        const u = inMemoryDb.users.find((user) => user.id === r.userId);
        return { ...r, user: u };
      });
    }
    return res.json(resellers);
  } catch (err) {
    console.error("Fetch resellers error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch resellers" });
  }
});

// POST /api/resellers
router.post("/", requireAuth, requirePermission("reseller.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = createResellerSchema.parse(req.body);

    let existingReseller = false;
    if (prisma) {
      existingReseller = !!(await prisma.reseller.findUnique({ where: { userId: body.userId } }));
    } else {
      existingReseller = inMemoryDb.resellers.some((r) => r.userId === body.userId);
    }

    if (existingReseller) {
      return res.status(400).json({ error: "errors.resellers.exists", message: "User is already registered as a reseller" });
    }

    let newReseller: any = null;
    if (prisma) {
      newReseller = await prisma.reseller.create({
        data: {
          userId: body.userId,
          commission: body.commission,
          status: body.status,
        },
        include: { user: true },
      });
    } else {
      newReseller = {
        id: `reseller-${Date.now()}`,
        userId: body.userId,
        commission: body.commission,
        status: body.status,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      inMemoryDb.resellers.push(newReseller);
      const u = inMemoryDb.users.find((user) => user.id === body.userId);
      newReseller = { ...newReseller, user: u };
    }

    await logDbActivity(req.user?.userId || null, `Promoted User ${body.userId} to Reseller Status`, "success", req.ip);
    return res.status(201).json(newReseller);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    console.error("Create reseller error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to register reseller" });
  }
});

// GET /api/resellers/:id/clients
router.get("/:id/clients", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    // Boundary security check: resellers can only query their own client list
    if (req.user?.role === "RESELLER") {
      let authorized = false;
      if (prisma) {
        const reseller = await prisma.reseller.findUnique({ where: { id } });
        if (reseller && reseller.userId === req.user.userId) authorized = true;
      } else {
        const reseller = inMemoryDb.resellers.find((r) => r.id === id);
        if (reseller && reseller.userId === req.user.userId) authorized = true;
      }

      if (!authorized) {
        return res.status(403).json({ error: "errors.auth.forbidden", message: "Resellers can only query their own client rosters" });
      }
    } else {
      // ADMIN or SUPPORT
      const hasPerm = req.user?.permissions.includes("reseller.manage") || req.user?.role === "ADMIN";
      if (!hasPerm) {
        return res.status(403).json({ error: "errors.auth.forbidden", message: "Forbidden" });
      }
    }

    // Load reseller's user ID to filter clients
    let resellerUserId = "";
    if (prisma) {
      const resData = await prisma.reseller.findUnique({ where: { id } });
      resellerUserId = resData?.userId || "";
    } else {
      const resData = inMemoryDb.resellers.find((r) => r.id === id);
      resellerUserId = resData?.userId || "";
    }

    if (!resellerUserId) {
      return res.status(404).json({ error: "errors.resellers.not_found", message: "Reseller partner not found" });
    }

    let clients: any[] = [];
    if (prisma) {
      clients = await prisma.vpnClient.findMany({
        where: { userId: resellerUserId },
        orderBy: { createdAt: "desc" },
      });
    } else {
      clients = inMemoryDb.vpnClients.filter((c) => c.userId === resellerUserId);
    }

    const sanitized = clients.map((c) => ({
      id: c.id,
      token: c.token, // Format SXB-XXXX-XXXX-XXXX
      quotaTotal: c.quotaTotal.toString(),
      quotaUsed: c.quotaUsed.toString(),
      expireAt: c.expireAt,
      status: c.status,
      createdAt: c.createdAt,
    }));

    return res.json(sanitized);
  } catch (err) {
    console.error("Fetch reseller clients error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to retrieve reseller clients" });
  }
});

// POST /api/resellers/:id/create-client
// Workflow: A Reseller initiates client creation
router.post("/:id/create-client", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const body = resellerCreateClientSchema.parse(req.body);

    let resellerUserId = "";
    let resellerStatus = "";
    if (prisma) {
      const reseller = await prisma.reseller.findUnique({ where: { id } });
      resellerUserId = reseller?.userId || "";
      resellerStatus = reseller?.status || "";
    } else {
      const reseller = inMemoryDb.resellers.find((r) => r.id === id);
      resellerUserId = reseller?.userId || "";
      resellerStatus = reseller?.status || "";
    }

    if (!resellerUserId) {
      return res.status(404).json({ error: "errors.resellers.not_found", message: "Reseller partner not found" });
    }

    if (resellerStatus !== "active") {
      return res.status(403).json({ error: "errors.resellers.suspended", message: "Reseller partner is suspended" });
    }

    // Security: Only the reseller himself or ADMIN/SUPPORT can generate clients under this reseller ID
    if (req.user?.role === "RESELLER" && req.user.userId !== resellerUserId) {
      return res.status(403).json({ error: "errors.auth.forbidden", message: "Cannot create clients under other resellers" });
    }

    const quotaBytes = BigInt(body.quotaTotalGb) * BigInt(1024 * 1024 * 1024);
    const expireAt = new Date();
    expireAt.setDate(expireAt.getDate() + body.durationDays);

    // 1. Generate SXB Secure Client Token (Sing-box/V2Ray standard format)
    const token = `SXB-${crypto.randomBytes(2).toString("hex").toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;

    // 2. Call external XPanel Engine to register user
    const xpanelUser = await XPanelService.createUser(body.name, quotaBytes, expireAt, body.deviceLimit);

    // 3. Insert client in local database bound to reseller user account
    let newClient: any = null;
    if (prisma) {
      newClient = await prisma.vpnClient.create({
        data: {
          userId: resellerUserId,
          token,
          quotaTotal: quotaBytes,
          quotaUsed: BigInt(0),
          expireAt,
          status: "active",
          xpanelUserId: xpanelUser.id,
        },
      });
    } else {
      newClient = {
        id: `client-${Date.now()}`,
        userId: resellerUserId,
        token,
        quotaTotal: quotaBytes,
        quotaUsed: BigInt(0),
        expireAt,
        status: "active",
        xpanelUserId: xpanelUser.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      inMemoryDb.vpnClients.push(newClient);
    }

    await logDbActivity(resellerUserId, `Reseller created Client: ${body.name} (Token: ${token})`, "success", req.ip);

    // 4. Return secure details only. Securely filter out internal UUIDs, raw configurations, or private SSH keys!
    return res.status(201).json({
      success: true,
      message: "Reseller client registered successfully",
      client: {
        id: newClient.id,
        token: newClient.token, // SXB Secure Token
        quotaTotal: newClient.quotaTotal.toString(),
        expireAt: newClient.expireAt,
        status: newClient.status,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    console.error("Reseller client creation error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to register reseller client" });
  }
});

export default router;

import { Router, Response } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma, inMemoryDb, logDbActivity } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";

const router = Router();

// Helper : aplatit les données reseller pour correspondre au type frontend { name, email, balance, clientsCount }
function flattenReseller(r: any, clientsCount = 0): any {
  return {
    id: r.id,
    name: r.user?.name || r.name || "",
    email: r.user?.email || r.email || "",
    phone: r.user?.phone || null,
    balance: r.commission ?? 0,
    commission: r.commission ?? 0,
    status: r.status,
    clientsCount,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    userId: r.userId,
  };
}

// POST accepte soit { name, email, phone?, balance? } soit l'ancien { userId, commission? }
const createResellerSchema = z.object({
  name: z.string().min(2).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  balance: z.coerce.number().min(0).optional(),
  userId: z.string().optional(),
  commission: z.coerce.number().min(0).max(100).default(20),
  status: z.enum(["active", "suspended"]).default("active"),
});

const resellerCreateClientSchema = z.object({
  name: z.string().min(2),
  quotaTotalGb: z.coerce.number().min(1).default(50),
  durationDays: z.coerce.number().min(1).default(30),
  deviceLimit: z.coerce.number().min(1).default(1),
});

// GET /api/resellers — retourne { resellers: [...] } (frontend attend ce format)
router.get("/", requireAuth, requirePermission("reseller.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    let resellers: any[] = [];
    if (prisma) {
      const raw = await prisma.reseller.findMany({ include: { user: true } });
      resellers = await Promise.all(
        raw.map(async (r) => {
          const clientsCount = await prisma.vpnClient.count({ where: { userId: r.userId } });
          return flattenReseller(r, clientsCount);
        })
      );
    } else {
      resellers = inMemoryDb.resellers.map((r) => {
        const u = inMemoryDb.users.find((user) => user.id === r.userId);
        const clientsCount = inMemoryDb.vpnClients.filter((c) => c.userId === r.userId).length;
        return flattenReseller({ ...r, user: u }, clientsCount);
      });
    }
    return res.json({ resellers });
  } catch (err) {
    console.error("Fetch resellers error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch resellers" });
  }
});

// POST /api/resellers — accepte { name, email } OU { userId }
router.post("/", requireAuth, requirePermission("reseller.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = createResellerSchema.parse(req.body);
    let resolvedUserId = body.userId;
    const commission = body.balance ?? body.commission ?? 20;
    let generatedPassword: string | undefined;

    // Si le frontend envoie name+email → créer l'utilisateur d'abord
    if (!resolvedUserId && body.name && body.email) {
      if (!prisma) {
        return res.status(400).json({ error: "errors.validation", message: "userId required in memory mode" });
      }
      const existing = await prisma.user.findUnique({ where: { email: body.email } });
      if (existing) {
        resolvedUserId = existing.id;
      } else {
        const resellerRole = await prisma.role.findFirst({ where: { name: "RESELLER" } });
        if (!resellerRole) {
          return res.status(500).json({ error: "errors.server", message: "Role RESELLER not found" });
        }
        const tempPassword = crypto.randomBytes(10).toString("hex");
        generatedPassword = tempPassword;
        const passwordHash = await bcrypt.hash(tempPassword, 12);
        const newUser = await prisma.user.create({
          data: {
            name: body.name,
            email: body.email,
            phone: body.phone || null,
            passwordHash,
            roleId: resellerRole.id,
            status: "active",
          },
        });
        resolvedUserId = newUser.id;
        console.log(`[Reseller] New user created: ${body.email} (temp password logged server-side)`);
      }
    }

    if (!resolvedUserId) {
      return res.status(400).json({ error: "errors.validation", message: "Provide either userId or name+email" });
    }

    if (prisma) {
      const existingReseller = await prisma.reseller.findUnique({ where: { userId: resolvedUserId } });
      if (existingReseller) {
        return res.status(400).json({ error: "errors.resellers.exists", message: "User is already a reseller" });
      }
      const newReseller = await prisma.reseller.create({
        data: { userId: resolvedUserId, commission, status: body.status },
        include: { user: true },
      });
      await logDbActivity(req.user?.userId || null, `Reseller created: ${body.email || resolvedUserId}`, "success", req.ip);
      const resellerResponse: any = flattenReseller(newReseller, 0);
      if (generatedPassword) resellerResponse.generatedPassword = generatedPassword;
      return res.status(201).json(resellerResponse);
    } else {
      const existingReseller = inMemoryDb.resellers.some((r) => r.userId === resolvedUserId);
      if (existingReseller) {
        return res.status(400).json({ error: "errors.resellers.exists", message: "User is already a reseller" });
      }
      const newReseller: any = {
        id: `reseller-${Date.now()}`,
        userId: resolvedUserId,
        commission,
        status: body.status,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      inMemoryDb.resellers.push(newReseller);
      const u = inMemoryDb.users.find((user) => user.id === resolvedUserId);
      return res.status(201).json(flattenReseller({ ...newReseller, user: u }, 0));
    }
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
      const hasPerm =
        req.user?.permissions.includes("reseller.manage") ||
        req.user?.role === "ADMIN" ||
        req.user?.role === "SUPER_ADMIN";
      if (!hasPerm) {
        return res.status(403).json({ error: "errors.auth.forbidden", message: "Forbidden" });
      }
    }

    let resellerUserId = "";
    if (prisma) {
      const resData = await prisma.reseller.findUnique({ where: { id } });
      resellerUserId = resData?.userId || "";
    } else {
      const resData = inMemoryDb.resellers.find((r) => r.id === id);
      resellerUserId = resData?.userId || "";
    }
    if (!resellerUserId) {
      return res.status(404).json({ error: "errors.resellers.not_found", message: "Reseller not found" });
    }

    let clients: any[] = [];
    if (prisma) {
      clients = await prisma.vpnClient.findMany({ where: { userId: resellerUserId }, orderBy: { createdAt: "desc" } });
    } else {
      clients = inMemoryDb.vpnClients.filter((c) => c.userId === resellerUserId);
    }
    const sanitized = clients.map((c) => ({
      id: c.id,
      token: c.token,
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
      return res.status(404).json({ error: "errors.resellers.not_found", message: "Reseller not found" });
    }
    if (resellerStatus !== "active") {
      return res.status(403).json({ error: "errors.resellers.suspended", message: "Reseller is suspended" });
    }
    if (req.user?.role === "RESELLER" && req.user.userId !== resellerUserId) {
      return res.status(403).json({ error: "errors.auth.forbidden", message: "Cannot create clients under other resellers" });
    }

    const quotaBytes = BigInt(body.quotaTotalGb) * BigInt(1024 * 1024 * 1024);
    const expireAt = new Date();
    expireAt.setDate(expireAt.getDate() + body.durationDays);
    const tokenValue = `SXB-${crypto.randomBytes(3).toString("hex").toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

    let newClient: any = null;
    if (prisma) {
      newClient = await prisma.vpnClient.create({
        data: {
          name: body.name,
          token: tokenValue,
          userId: resellerUserId,
          quotaTotal: quotaBytes,
          quotaUsed: BigInt(0),
          expireAt,
          deviceLimit: body.deviceLimit,
          status: "active",
        },
      });
    } else {
      newClient = {
        id: `client-${Date.now()}`,
        name: body.name,
        token: tokenValue,
        userId: resellerUserId,
        quotaTotal: quotaBytes,
        quotaUsed: BigInt(0),
        expireAt,
        deviceLimit: body.deviceLimit,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      inMemoryDb.vpnClients.push(newClient);
    }

    await logDbActivity(req.user?.userId || null, `Client created under reseller ${id}: ${body.name}`, "success", req.ip);
    return res.status(201).json({
      id: newClient.id,
      token: tokenValue,
      quotaTotal: quotaBytes.toString(),
      expireAt,
      deviceLimit: body.deviceLimit,
      status: "active",
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    console.error("Create reseller client error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to create reseller client" });
  }
});

// PATCH /api/resellers/:id
const updateResellerSchema = z.object({
  commission: z.coerce.number().min(0).max(100).optional(),
  balance: z.coerce.number().min(0).optional(),
  status: z.enum(["active", "suspended"]).optional(),
});

router.patch("/:id", requireAuth, requirePermission("reseller.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const body = updateResellerSchema.parse(req.body);
    const updateData: any = {};
    if (body.commission !== undefined) updateData.commission = body.commission;
    if (body.balance !== undefined) updateData.commission = body.balance; // balance maps to commission
    if (body.status !== undefined) updateData.status = body.status;

    if (prisma) {
      const exists = await prisma.reseller.findUnique({ where: { id } });
      if (!exists) return res.status(404).json({ error: "errors.resellers.not_found", message: "Reseller not found" });
      const updated = await prisma.reseller.update({ where: { id }, data: updateData, include: { user: true } });
      const clientsCount = await prisma.vpnClient.count({ where: { userId: updated.userId } });
      await logDbActivity(req.user?.userId || null, `Updated reseller ${id}`, "info", req.ip);
      return res.json(flattenReseller(updated, clientsCount));
    } else {
      const index = inMemoryDb.resellers.findIndex((r) => r.id === id);
      if (index === -1) return res.status(404).json({ error: "errors.resellers.not_found", message: "Reseller not found" });
      inMemoryDb.resellers[index] = { ...inMemoryDb.resellers[index], ...updateData, updatedAt: new Date() };
      const u = inMemoryDb.users.find((user) => user.id === inMemoryDb.resellers[index].userId);
      return res.json(flattenReseller({ ...inMemoryDb.resellers[index], user: u }, 0));
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    console.error("Update reseller error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to update reseller" });
  }
});

export default router;

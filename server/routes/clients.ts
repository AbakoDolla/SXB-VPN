import { Router, Response } from "express";
import { z } from "zod";
import { prisma, inMemoryDb, logDbActivity } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";

const router = Router();

// Zod Schema validations
const createClientSchema = z.object({
  userId: z.string().optional(), // Optional for RESELLER (will use their own ID)
  name: z.string().min(2),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  quotaTotalGb: z.coerce.number().min(1).optional(), // Optional - can be set via token later
  durationDays: z.coerce.number().min(1).optional(), // Optional - can be set via token later
  deviceLimit: z.coerce.number().min(1).default(1),
  deviceId: z.string().optional(),
  phone: z.string().optional(),
});

const updateClientSchema = z.object({
  name: z.string().min(2).optional(),
  quotaTotalGb: z.coerce.number().min(1).optional(),
  deviceLimit: z.coerce.number().min(1).optional(),
  status: z.enum(["active", "suspended", "expired"]).optional(),
});

// Helper to convert BigInt to string for client-safe JSON parsing
// Also removes sensitive data like passwordHash
function sanitizeVpnClient(client: any) {
  if (!client) return null;
  
  // Remove passwordHash from user object if present
  let user = client.user;
  if (user && user.passwordHash) {
    user = { ...user };
    delete user.passwordHash;
  }
  
  return {
    ...client,
    user,
    quotaTotal: client.quotaTotal ? client.quotaTotal.toString() : "0",
    quotaUsed: client.quotaUsed ? client.quotaUsed.toString() : "0",
  };
}

// GET /api/clients
router.get("/", requireAuth, requirePermission("clients.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    let clients: any[] = [];
    const isReseller = req.user?.role === "RESELLER";

    if (prisma) {
      clients = await prisma.vpnClient.findMany({
        where: isReseller ? { userId: req.user?.userId } : undefined,
        include: { user: true },
        orderBy: { createdAt: "desc" },
      });
    } else {
      clients = inMemoryDb.vpnClients.map((client) => {
        const u = inMemoryDb.users.find((user) => user.id === client.userId);
        return { ...client, user: u };
      });
      if (isReseller) {
        clients = clients.filter((c) => c.userId === req.user?.userId);
      }
    }

    return res.json(clients.map(sanitizeVpnClient));
  } catch (err) {
    console.error("Fetch VPN clients error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch VPN clients" });
  }
});

// GET /api/clients/:id
router.get("/:id", requireAuth, requirePermission("clients.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    let client: any = null;

    if (prisma) {
      client = await prisma.vpnClient.findUnique({
        where: { id },
        include: { user: true },
      });
    } else {
      const c = inMemoryDb.vpnClients.find((cli) => cli.id === id);
      if (c) {
        const u = inMemoryDb.users.find((user) => user.id === c.userId);
        client = { ...c, user: u };
      }
    }

    if (!client) {
      return res.status(404).json({ error: "errors.clients.not_found", message: "VPN client not found" });
    }

    // Secure reseller boundary
    if (req.user?.role === "RESELLER" && client.userId !== req.user?.userId) {
      return res.status(403).json({ error: "errors.auth.forbidden", message: "Unauthorized access to reseller client data" });
    }

    return res.json(sanitizeVpnClient(client));
  } catch (err) {
    console.error("Fetch VPN client error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch VPN client" });
  }
});

// POST /api/clients
router.post("/", requireAuth, requirePermission("clients.create"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = createClientSchema.parse(req.body);

    // Limit resellers to creating clients for themselves
    let targetUserId = body.userId;
    if (req.user?.role === "RESELLER") {
      targetUserId = req.user.userId;
    }

    // For ADMIN/SUPER_ADMIN: auto-create user if userId not provided
    if (!targetUserId && (req.user?.role === "ADMIN" || req.user?.role === "SUPER_ADMIN") && prisma) {
      // Generate user credentials
      const username = body.name.toLowerCase().replace(/\s+/g, "_");
      const tempEmail = `${username}_${Date.now()}@vpn.local`;
      const tempPassword = `client_${Date.now()}`;
      const passwordHash = require("bcryptjs").hashSync(tempPassword, 10);

      // Find or create CLIENT role
      let clientRole = await prisma.role.findUnique({ where: { name: "CLIENT" } });
      if (!clientRole) {
        clientRole = await prisma.role.create({
          data: { name: "CLIENT", description: "VPN Client" }
        });
      }

      const newUser = await prisma.user.create({
        data: {
          name: body.name,
          email: tempEmail,
          phone: body.phone || "+00000000000",
          passwordHash,
          roleId: clientRole.id,
          status: "active",
        },
      });
      targetUserId = newUser.id;

      // Log the temp credentials for admin reference
      console.log(`🔐 Created client user: ${tempEmail} / ${tempPassword}`);
    }

    if (!targetUserId) {
      return res.status(400).json({ error: "errors.validation", message: "userId required for RESELLER role" });
    }

    // Generate SXB Secure Client Token (Sing-box/V2Ray standard)
    // FIX-001: Format SXB-USER-XXXX-XXXX-XXXX standard
    const _chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const _seg = () => Array.from({ length: 4 }, () => _chars[Math.floor(Math.random() * _chars.length)]).join('');
    const token = `SXB-USER-${_seg()}-${_seg()}-${_seg()}`;

    let newClient: any = null;
    if (prisma) {
      newClient = await prisma.vpnClient.create({
        data: {
          userId: targetUserId,
          token,
          quotaTotal: body.quotaTotalGb ? BigInt(body.quotaTotalGb) * BigInt(1024 * 1024 * 1024) : null,
          quotaUsed: BigInt(0),
          expireAt: body.durationDays ? new Date(Date.now() + body.durationDays * 24 * 60 * 60 * 1000) : null,
          status: "active",
          deviceId: body.deviceId || undefined,
        },
        include: { user: true },
      });
    } else {
      newClient = {
        id: `client-${Date.now()}`,
        userId: targetUserId,
        token,
        quotaTotal: body.quotaTotalGb ? BigInt(body.quotaTotalGb) * BigInt(1024 * 1024 * 1024) : null,
        quotaUsed: BigInt(0),
        expireAt: body.durationDays ? new Date(Date.now() + body.durationDays * 24 * 60 * 60 * 1000) : null,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      inMemoryDb.vpnClients.push(newClient);
      const u = inMemoryDb.users.find((user) => user.id === targetUserId);
      newClient = { ...newClient, user: u };
    }

    await logDbActivity(req.user?.userId || null, `Created VPN account: ${body.name}`, "success", req.ip);

    return res.status(201).json(sanitizeVpnClient(newClient));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    console.error("Create VPN client error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to create VPN client" });
  }
});

// PATCH /api/clients/:id
router.patch("/:id", requireAuth, requirePermission("clients.create"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const body = updateClientSchema.parse(req.body);

    let existingClient: any = null;
    if (prisma) {
      existingClient = await prisma.vpnClient.findUnique({ where: { id } });
    } else {
      existingClient = inMemoryDb.vpnClients.find((c) => c.id === id);
    }

    if (!existingClient) {
      return res.status(404).json({ error: "errors.clients.not_found", message: "VPN Client not found" });
    }

    // Secure reseller boundary
    if (req.user?.role === "RESELLER" && existingClient.userId !== req.user?.userId) {
      return res.status(403).json({ error: "errors.auth.forbidden", message: "Unauthorized edit access" });
    }

    const updates: any = {};
    if (body.name !== undefined) updates.name = body.name; // if mapped in user, otherwise on DB side
    if (body.status !== undefined) updates.status = body.status;
    if (body.quotaTotalGb !== undefined) {
      updates.quotaTotal = BigInt(body.quotaTotalGb) * BigInt(1024 * 1024 * 1024);
    }

    let updated: any = null;
    if (prisma) {
      updated = await prisma.vpnClient.update({
        where: { id },
        data: updates,
        include: { user: true },
      });
    } else {
      const index = inMemoryDb.vpnClients.findIndex((c) => c.id === id);
      const merged = { ...inMemoryDb.vpnClients[index], ...updates, updatedAt: new Date() };
      inMemoryDb.vpnClients[index] = merged;
      const u = inMemoryDb.users.find((user) => user.id === merged.userId);
      updated = { ...merged, user: u };
    }

    await logDbActivity(req.user?.userId || null, `Modified VPN client details (ID: ${id})`, "info", req.ip);

    return res.json(sanitizeVpnClient(updated));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    console.error("Update VPN client error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to update VPN client" });
  }
});

// POST /api/clients/:id/suspend
router.post("/:id/suspend", requireAuth, requirePermission("clients.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    let client: any = null;

    if (prisma) {
      client = await prisma.vpnClient.findUnique({ where: { id } });
    } else {
      client = inMemoryDb.vpnClients.find((c) => c.id === id);
    }

    if (!client) return res.status(404).json({ error: "errors.clients.not_found" });

    // Secure reseller boundary
    if (req.user?.role === "RESELLER" && client.userId !== req.user?.userId) {
      return res.status(403).json({ error: "errors.auth.forbidden" });
    }

    let updated: any = null;
    if (prisma) {
      updated = await prisma.vpnClient.update({
        where: { id },
        data: { status: "suspended" },
        include: { user: true },
      });
    } else {
      const index = inMemoryDb.vpnClients.findIndex((c) => c.id === id);
      inMemoryDb.vpnClients[index].status = "suspended";
      const u = inMemoryDb.users.find((user) => user.id === client.userId);
      updated = { ...inMemoryDb.vpnClients[index], user: u };
    }

    await logDbActivity(req.user?.userId || null, `Suspended VPN Client: ${client.token}`, "warning", req.ip);
    return res.json(sanitizeVpnClient(updated));
  } catch (err) {
    return res.status(500).json({ error: "errors.server" });
  }
});

// POST /api/clients/:id/activate
router.post("/:id/activate", requireAuth, requirePermission("clients.create"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    let client: any = null;

    if (prisma) {
      client = await prisma.vpnClient.findUnique({ where: { id } });
    } else {
      client = inMemoryDb.vpnClients.find((c) => c.id === id);
    }

    if (!client) return res.status(404).json({ error: "errors.clients.not_found" });

    // Secure reseller boundary
    if (req.user?.role === "RESELLER" && client.userId !== req.user?.userId) {
      return res.status(403).json({ error: "errors.auth.forbidden" });
    }

    let updated: any = null;
    if (prisma) {
      updated = await prisma.vpnClient.update({
        where: { id },
        data: { status: "active" },
        include: { user: true },
      });
    } else {
      const index = inMemoryDb.vpnClients.findIndex((c) => c.id === id);
      inMemoryDb.vpnClients[index].status = "active";
      const u = inMemoryDb.users.find((user) => user.id === client.userId);
      updated = { ...inMemoryDb.vpnClients[index], user: u };
    }

    await logDbActivity(req.user?.userId || null, `Activated VPN Client: ${client.token}`, "success", req.ip);
    return res.json(sanitizeVpnClient(updated));
  } catch (err) {
    return res.status(500).json({ error: "errors.server" });
  }
});

// POST /api/clients/:id/renew
router.post("/:id/renew", requireAuth, requirePermission("clients.create"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    let client: any = null;

    if (prisma) {
      client = await prisma.vpnClient.findUnique({ where: { id } });
    } else {
      client = inMemoryDb.vpnClients.find((c) => c.id === id);
    }

    if (!client) return res.status(404).json({ error: "errors.clients.not_found" });

    // Secure reseller boundary
    if (req.user?.role === "RESELLER" && client.userId !== req.user?.userId) {
      return res.status(403).json({ error: "errors.auth.forbidden" });
    }

    // Extend subscription expiration by 30 days
    const currentExpiry = new Date(client.expireAt);
    const newExpiry = new Date(currentExpiry.getTime() + 30 * 24 * 60 * 60 * 1000);

    let updated: any = null;
    if (prisma) {
      updated = await prisma.vpnClient.update({
        where: { id },
        data: { expireAt: newExpiry, status: "active" },
        include: { user: true },
      });
    } else {
      const index = inMemoryDb.vpnClients.findIndex((c) => c.id === id);
      inMemoryDb.vpnClients[index].expireAt = newExpiry;
      inMemoryDb.vpnClients[index].status = "active";
      const u = inMemoryDb.users.find((user) => user.id === client.userId);
      updated = { ...inMemoryDb.vpnClients[index], user: u };
    }

    await logDbActivity(req.user?.userId || null, `Renewed subscription for Client Token: ${client.token} by +30 Days`, "success", req.ip);
    return res.json(sanitizeVpnClient(updated));
  } catch (err) {
    return res.status(500).json({ error: "errors.server" });
  }
});

// POST /api/clients/:id/reset-access
router.post("/:id/reset-access", requireAuth, requirePermission("clients.create"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    let client: any = null;

    if (prisma) {
      client = await prisma.vpnClient.findUnique({ where: { id } });
    } else {
      client = inMemoryDb.vpnClients.find((c) => c.id === id);
    }

    if (!client) return res.status(404).json({ error: "errors.clients.not_found" });

    // Secure reseller boundary
    if (req.user?.role === "RESELLER" && client.userId !== req.user?.userId) {
      return res.status(403).json({ error: "errors.auth.forbidden" });
    }

    // Generate a brand new, random, completely secure access UUID token for the VPN clients config
    // FIX-001: Format SXB-USER-XXXX-XXXX-XXXX standard
      const _rc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      const _rs = () => Array.from({ length: 4 }, () => _rc[Math.floor(Math.random() * _rc.length)]).join('');
      const newToken = `SXB-USER-${_rs()}-${_rs()}-${_rs()}`;

    let updated: any = null;
    if (prisma) {
      updated = await prisma.vpnClient.update({
        where: { id },
        data: { token: newToken },
        include: { user: true },
      });
    } else {
      const index = inMemoryDb.vpnClients.findIndex((c) => c.id === id);
      inMemoryDb.vpnClients[index].token = newToken;
      const u = inMemoryDb.users.find((user) => user.id === client.userId);
      updated = { ...inMemoryDb.vpnClients[index], user: u };
    }

    await logDbActivity(req.user?.userId || null, `Replaced secure key token for Client ID: ${id}`, "info", req.ip);
    return res.json(sanitizeVpnClient(updated));
  } catch (err) {
    return res.status(500).json({ error: "errors.server" });
  }
});

// DELETE /api/clients/:id
router.delete("/:id", requireAuth, requirePermission("clients.delete"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    let client: any = null;

    if (prisma) {
      client = await prisma.vpnClient.findUnique({ where: { id } });
    } else {
      client = inMemoryDb.vpnClients.find((c) => c.id === id);
    }

    if (!client) return res.status(404).json({ error: "errors.clients.not_found", message: "Client not found" });

    // Secure reseller boundary
    if (req.user?.role === "RESELLER" && client.userId !== req.user?.userId) {
      return res.status(403).json({ error: "errors.auth.forbidden", message: "Access forbidden" });
    }

    if (prisma) {
      await prisma.vpnClient.delete({ where: { id } });
    } else {
      const index = inMemoryDb.vpnClients.findIndex((c) => c.id === id);
      inMemoryDb.vpnClients.splice(index, 1);
    }

    await logDbActivity(req.user?.userId || null, `Deleted VPN Client account: ${client.token}`, "danger", req.ip);
    return res.json({ message: "VPN client account and credentials deleted successfully" });
  } catch (err) {
    console.error("Delete client error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to delete client" });
  }
});

export default router;

import { Router, Response } from "express";
import { z } from "zod";
import { prisma, inMemoryDb, logDbActivity } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";
import { encrypt, decrypt } from "../utils/crypto";

const router = Router();

const createServerSchema = z.object({
  name: z.string().min(2),
  ip: z.string().regex(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/, "Invalid IP address"),
  location: z.string().min(2),
  status: z.enum(["online", "offline"]).default("online"),
  xpanelId: z.string().optional(),
});

const updateServerSchema = z.object({
  name: z.string().min(2).optional(),
  ip: z.string().regex(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/, "Invalid IP address").optional(),
  location: z.string().min(2).optional(),
  status: z.enum(["online", "offline"]).optional(),
  xpanelId: z.string().optional(),
});

const saveConfigSchema = z.object({
  type: z.enum(["ssh", "singbox"]),
  configurationRaw: z.string().min(1),
});

// GET /api/servers
router.get("/", requireAuth, requirePermission("server.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    let servers: any[] = [];
    if (prisma) {
      servers = await prisma.vPSServer.findMany({
        orderBy: { createdAt: "desc" },
      });
    } else {
      servers = inMemoryDb.vpsServers;
    }
    return res.json(servers);
  } catch (err) {
    console.error("Fetch servers error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch servers" });
  }
});

// POST /api/servers
router.post("/", requireAuth, requirePermission("server.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = createServerSchema.parse(req.body);

    let newServer: any = null;
    if (prisma) {
      newServer = await prisma.vPSServer.create({
        data: body,
      });
    } else {
      newServer = {
        id: `server-${Date.now()}`,
        ...body,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      inMemoryDb.vpsServers.push(newServer);
    }

    await logDbActivity(req.user?.userId || null, `Registered new VPN node: ${body.name} (${body.ip})`, "success", req.ip);
    return res.status(201).json(newServer);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    console.error("Create server error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to create server" });
  }
});

// PATCH /api/servers/:id
router.patch("/:id", requireAuth, requirePermission("server.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const body = updateServerSchema.parse(req.body);

    let exists = false;
    if (prisma) {
      exists = !!(await prisma.vPSServer.findUnique({ where: { id } }));
    } else {
      exists = inMemoryDb.vpsServers.some((s) => s.id === id);
    }

    if (!exists) {
      return res.status(404).json({ error: "errors.servers.not_found", message: "Server node not found" });
    }

    let updated: any = null;
    if (prisma) {
      updated = await prisma.vPSServer.update({
        where: { id },
        data: { ...body, updatedAt: new Date() },
      });
    } else {
      const index = inMemoryDb.vpsServers.findIndex((s) => s.id === id);
      const old = inMemoryDb.vpsServers[index];
      updated = { ...old, ...body, updatedAt: new Date() };
      inMemoryDb.vpsServers[index] = updated;
    }

    await logDbActivity(req.user?.userId || null, `Updated VPN server configuration (ID: ${id})`, "info", req.ip);
    return res.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    console.error("Update server error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to update server" });
  }
});

// POST /api/servers/:id/config
// Securely store encrypted server configuration credentials
router.post("/:id/config", requireAuth, requirePermission("server.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const body = saveConfigSchema.parse(req.body);

    // Chiffrer les configurations (encrypt raw configurations)
    const configurationEncrypted = encrypt(body.configurationRaw);

    let configRecord: any = null;
    if (prisma) {
      configRecord = await prisma.xPanelConfig.create({
        data: {
          serverId: id,
          type: body.type,
          configurationEncrypted,
        },
      });
    } else {
      configRecord = {
        id: `config-${Date.now()}`,
        serverId: id,
        type: body.type,
        configurationEncrypted,
        createdAt: new Date(),
      };
      inMemoryDb.xpanelConfigs.push(configRecord);
    }

    await logDbActivity(req.user?.userId || null, `Securely saved and encrypted config for Server: ${id} (${body.type})`, "success", req.ip);

    return res.status(201).json({
      success: true,
      message: "Configuration credentials encrypted and saved securely",
      configId: configRecord.id,
      type: configRecord.type,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    console.error("Store encrypted config error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to securely save server config" });
  }
});

// GET /api/servers/:id/config
// Retrieve and decrypt configuration (STRICTLY ADMIN ONLY)
router.get("/:id/config", requireAuth, requirePermission("server.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    
    // Extra security layer: verify client is full ADMIN, not just general permission holders
    if (req.user?.role !== "ADMIN") {
      return res.status(403).json({ error: "errors.auth.forbidden_credentials", message: "Decryption keys can only be retrieved by Admin accounts" });
    }

    let configRecords: any[] = [];
    if (prisma) {
      configRecords = await prisma.xPanelConfig.findMany({ where: { serverId: id } });
    } else {
      configRecords = inMemoryDb.xpanelConfigs.filter((c) => c.serverId === id);
    }

    const decrypted = configRecords.map((c) => {
      let configurationRaw = "[Decryption Failed]";
      try {
        configurationRaw = decrypt(c.configurationEncrypted);
      } catch {}
      return {
        id: c.id,
        type: c.type,
        configurationRaw,
        createdAt: c.createdAt,
      };
    });

    return res.json(decrypted);
  } catch (err) {
    console.error("Retrieve encrypted config error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to retrieve configurations" });
  }
});

// DELETE /api/servers/:id
router.delete("/:id", requireAuth, requirePermission("server.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    let exists = false;
    let serverName = "";
    if (prisma) {
      const srv = await prisma.vPSServer.findUnique({ where: { id } });
      exists = !!srv;
      serverName = srv?.name || "";
      if (exists) await prisma.vPSServer.delete({ where: { id } });
    } else {
      const index = inMemoryDb.vpsServers.findIndex((s) => s.id === id);
      exists = index !== -1;
      if (exists) {
        serverName = inMemoryDb.vpsServers[index].name;
        inMemoryDb.vpsServers.splice(index, 1);
      }
    }
    if (!exists) {
      return res.status(404).json({ error: "errors.servers.not_found", message: "Server node not found" });
    }
    await logDbActivity(req.user?.userId || null, `Removed VPN node: ${serverName} (ID: ${id})`, "danger", req.ip);
    return res.json({ message: "Server node removed successfully" });
  } catch (err) {
    console.error("Delete server error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to delete server" });
  }
});

export default router;

import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { XPanelService } from "../services/xpanel.js";

const router = Router();

// GET /api/xpanel/status
router.get("/status", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const start = Date.now();
    let isConnected = false;
    try {
      const r = await XPanelService.testConnection();
      isConnected = r.success;
    } catch {
      isConnected = false;
    }
    return res.json({
      status: isConnected ? "online" : "offline",
      connectedServers: 1,
      synchronizedUsers: 0,
      availableConfigs: 0,
      isSyncing: false,
      latencyMs: Date.now() - start,
    });
  } catch {
    return res.status(500).json({ error: "errors.server" });
  }
});

// POST /api/xpanel/sync
router.post("/sync", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const result = await XPanelService.sync();
    return res.json({ success: true, message: "Sync completed", ...result });
  } catch {
    return res.status(500).json({ error: "errors.server", message: "Sync failed" });
  }
});

// GET /api/xpanel/users
router.get("/users", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const users = await XPanelService.getUsers();
    return res.json({ users });
  } catch {
    return res.status(500).json({ error: "errors.server" });
  }
});

// GET /api/xpanel/configs
router.get("/configs", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const configs = await XPanelService.getConfigs();
    return res.json({ configs });
  } catch {
    return res.status(500).json({ error: "errors.server" });
  }
});

// POST /api/xpanel/configs
router.post("/configs", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { name, protocol, port, settings } = req.body;
    const config = await XPanelService.createConfig(name, protocol, port, settings);
    return res.json(config);
  } catch {
    return res.status(500).json({ error: "errors.server" });
  }
});

// DELETE /api/xpanel/configs/:id
router.delete("/configs/:id", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    await XPanelService.deleteConfig(req.params.id);
    return res.json({ success: true });
  } catch {
    return res.status(500).json({ error: "errors.server" });
  }
});

export default router;

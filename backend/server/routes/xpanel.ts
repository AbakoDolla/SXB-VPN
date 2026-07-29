import { Router, Response } from "express";
import { XPanelService } from "../services/xpanel";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";
import { logDbActivity, inMemoryDb, prisma } from "../database";

const router = Router();

// GET /api/xpanel/status
router.get("/status", requireAuth, requirePermission("xpanel.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const start = Date.now();
    let isConnected = false;
    
    try {
      const connResult = await XPanelService.testConnection();
      isConnected = connResult.success;
    } catch {
      isConnected = false;
    }

    const latency = Date.now() - start;
    let clientCount = 0;
    let configCount = 0;

    if (prisma) {
      clientCount = await prisma.vpnClient.count({ where: { status: "active" } });
      // Count configs from inbounds/nodes - simplified
      configCount = await prisma.vPSServer.count();
    } else {
      clientCount = inMemoryDb.vpnClients.filter((c) => c.status === "active").length;
      configCount = inMemoryDb.vpsServers.length;
    }

    return res.json({
      status: isConnected ? "online" : "offline",
      connectedServers: configCount,
      synchronizedUsers: clientCount,
      availableConfigs: configCount * 2,
      isSyncing: false,
    });
  } catch (err) {
    console.error("XPanel status retrieval error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to probe XPanel Engine" });
  }
});

// POST /api/xpanel/sync
router.post("/sync", requireAuth, requirePermission("xpanel.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    console.log("Triggering manual XPanel database sync...");
    const result = await XPanelService.sync();
    await logDbActivity(req.user?.userId || null, `Manual database-XPanel synchronization completed (${result.synchronizedCount} accounts updated)`, "success", req.ip);
    return res.json({
      success: true,
      message: "Synchronization completed successfully",
      ...result,
    });
  } catch (err) {
    console.error("XPanel sync action error:", err);
    return res.status(500).json({ error: "errors.server", message: "Synchronization failed" });
  }
});

// GET /api/xpanel/users
router.get("/users", requireAuth, requirePermission("xpanel.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const xpanelUsers = await XPanelService.getUsers();
    return res.json({ users: xpanelUsers });
  } catch (err) {
    console.error("XPanel getUsers error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to query XPanel users" });
  }
});

// GET /api/xpanel/configs
router.get("/configs", requireAuth, requirePermission("xpanel.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Return VPN configurations stored locally (inbound configs)
    const configs = await XPanelService.getConfigs();
    return res.json({ configs });
  } catch (err) {
    console.error("XPanel getConfigs error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to query XPanel configs" });
  }
});

// POST /api/xpanel/configs - Create new config on XPanel
router.post("/configs", requireAuth, requirePermission("xpanel.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, protocol, port, settings } = req.body;
    const config = await XPanelService.createConfig(name, protocol, port, settings);
    await logDbActivity(req.user?.userId || null, `Created XPanel config: ${name}`, "success", req.ip);
    return res.json(config);
  } catch (err) {
    console.error("XPanel createConfig error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to create XPanel config" });
  }
});

// DELETE /api/xpanel/configs/:id
router.delete("/configs/:id", requireAuth, requirePermission("xpanel.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    await XPanelService.deleteConfig(id);
    await logDbActivity(req.user?.userId || null, `Deleted XPanel config: ${id}`, "danger", req.ip);
    return res.json({ success: true });
  } catch (err) {
    console.error("XPanel deleteConfig error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to delete XPanel config" });
  }
});

export default router;

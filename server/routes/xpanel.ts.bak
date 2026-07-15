import { Router, Response } from "express";
import { XPanelService } from "../services/xpanel";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";
import { logDbActivity, inMemoryDb, prisma } from "../database";

const router = Router();

// GET /api/xpanel/status
router.get("/status", requireAuth, requirePermission("xpanel.access"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const start = Date.now();
    let isConnected = false;
    
    // Quick probe check
    try {
      const pingRes = await fetch(`${XPanelService["baseUrl"]}/api/health`, { signal: AbortSignal.timeout(2000) });
      isConnected = pingRes.ok;
    } catch {
      isConnected = false;
    }

    const latency = Date.now() - start;
    let clientCount = 0;

    if (prisma) {
      clientCount = await prisma.vpnClient.count({ where: { status: "active" } });
    } else {
      clientCount = inMemoryDb.vpnClients.filter((c) => c.status === "active").length;
    }

    return res.json({
      online: true, // system daemon is running
      xpanelEngineConnected: isConnected,
      latencyMs: isConnected ? latency : 0,
      activeSyncCount: clientCount,
      lastSyncTime: new Date().toISOString(),
    });
  } catch (err) {
    console.error("XPanel status retrieval error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to probe XPanel Engine" });
  }
});

// POST /api/xpanel/sync
router.post("/sync", requireAuth, requirePermission("xpanel.access"), async (req: AuthenticatedRequest, res: Response) => {
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
router.get("/users", requireAuth, requirePermission("xpanel.access"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const users = await XPanelService.getUsers();
    return res.json(users);
  } catch (err) {
    console.error("XPanel getUsers error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to query XPanel users" });
  }
});

export default router;

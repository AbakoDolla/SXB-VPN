import { Router, Response } from "express";
import { prisma, logDbActivity } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";

const router = Router();

// GET /api/sessions — liste toutes les sessions d'activation
router.get("/", requireAuth, requirePermission("clients.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "Database unavailable" });
    const sessions = await (prisma as any).activationSession.findMany({
      include: { client: { include: { user: true } } },
      orderBy: { activationDate: "desc" },
    });
    return res.json({
      sessions: sessions.map((s: any) => ({
        id: s.id,
        clientId: s.clientId,
        clientName: s.client?.user?.name || "Inconnu",
        clientToken: s.client?.token || "",
        deviceId: s.deviceId,
        activationDate: s.activationDate,
        expirationDate: s.expirationDate,
        lastSync: s.lastSync,
        status: s.status,
        ipAddress: s.ipAddress,
        userAgent: s.userAgent,
      })),
    });
  } catch (err) {
    console.error("List sessions error:", err);
    return res.status(500).json({ error: "errors.server" });
  }
});

// GET /api/sessions/client/:clientId
router.get("/client/:clientId", requireAuth, requirePermission("clients.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "Database unavailable" });
    const sessions = await (prisma as any).activationSession.findMany({
      where: { clientId: req.params.clientId },
      orderBy: { activationDate: "desc" },
    });
    return res.json({ sessions });
  } catch (err) {
    return res.status(500).json({ error: "errors.server" });
  }
});

// POST /api/sessions/:id/revoke
router.post("/:id/revoke", requireAuth, requirePermission("clients.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "Database unavailable" });
    const session = await (prisma as any).activationSession.update({
      where: { id: req.params.id },
      data: { status: "revoked", updatedAt: new Date() },
      include: { client: true },
    });
    await logDbActivity(req.user?.userId || null, `Session révoquée: device ${session.deviceId}`, "warning", req.ip);
    return res.json({ success: true, session });
  } catch (err) {
    console.error("Revoke session error:", err);
    return res.status(500).json({ error: "errors.server" });
  }
});

// POST /api/sessions/:id/reset — réinitialise la liaison device, permet ré-activation
router.post("/:id/reset", requireAuth, requirePermission("clients.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "Database unavailable" });
    const session = await (prisma as any).activationSession.findUnique({
      where: { id: req.params.id },
      include: { client: true },
    });
    if (!session) return res.status(404).json({ error: "Session introuvable" });

    await (prisma as any).activationSession.delete({ where: { id: req.params.id } });
    await prisma.vpnClient.update({
      where: { id: session.clientId },
      data: { deviceId: null, activatedAt: null },
    });
    await logDbActivity(req.user?.userId || null, `Activation réinitialisée: device ${session.deviceId}`, "warning", req.ip);
    return res.json({ success: true, message: "Activation réinitialisée. L'utilisateur peut se ré-activer." });
  } catch (err) {
    console.error("Reset session error:", err);
    return res.status(500).json({ error: "errors.server" });
  }
});

// DELETE /api/sessions/:id
router.delete("/:id", requireAuth, requirePermission("clients.delete"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "Database unavailable" });
    await (prisma as any).activationSession.delete({ where: { id: req.params.id } });
    await logDbActivity(req.user?.userId || null, `Session supprimée: ${req.params.id}`, "danger", req.ip);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "errors.server" });
  }
});

// POST /api/sessions/sync — heartbeat lastSync
router.post("/sync", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(200).json({ synced: false });
    await (prisma as any).activationSession.updateMany({
      where: { client: { user: { id: req.user!.userId } }, status: "active" },
      data: { lastSync: new Date() },
    });
    return res.json({ synced: true, timestamp: new Date().toISOString() });
  } catch {
    return res.status(200).json({ synced: false });
  }
});

export default router;

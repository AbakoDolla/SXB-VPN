import { Router, Response } from "express";
import { z } from "zod";
import { prisma, logDbActivity } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";

const router = Router();

// GET /api/sessions — liste toutes les sessions d'activation actives
router.get("/", requireAuth, requirePermission("clients.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "Database unavailable" });

    const sessions = await (prisma as any).activationSession.findMany({
      include: {
        client: {
          include: { user: true },
        },
      },
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
    return res.status(500).json({ error: "errors.server", message: "Failed to list sessions" });
  }
});

// GET /api/sessions/client/:clientId — sessions d'un client spécifique
router.get("/client/:clientId", requireAuth, requirePermission("clients.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "Database unavailable" });

    const sessions = await (prisma as any).activationSession.findMany({
      where: { clientId: req.params.clientId },
      orderBy: { activationDate: "desc" },
    });

    return res.json({ sessions });
  } catch (err) {
    console.error("Get client sessions error:", err);
    return res.status(500).json({ error: "errors.server" });
  }
});

// POST /api/sessions/:id/revoke — révoquer une session (déconnecter l'appareil)
router.post("/:id/revoke", requireAuth, requirePermission("clients.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "Database unavailable" });

    const session = await (prisma as any).activationSession.update({
      where: { id: req.params.id },
      data: { status: "revoked", updatedAt: new Date() },
      include: { client: { include: { user: true } } },
    });

    await logDbActivity(
      req.user?.userId || null,
      `Session révoquée pour appareil ${session.deviceId} (client: ${session.client?.token})`,
      "warning",
      req.ip
    );

    return res.json({ success: true, session });
  } catch (err) {
    console.error("Revoke session error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to revoke session" });
  }
});

// POST /api/sessions/:id/reset — réinitialiser une session (permet réactivation sur autre appareil)
router.post("/:id/reset", requireAuth, requirePermission("clients.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "Database unavailable" });

    const session = await (prisma as any).activationSession.findUnique({
      where: { id: req.params.id },
      include: { client: true },
    });

    if (!session) return res.status(404).json({ error: "Session introuvable" });

    // Delete the session and unbind deviceId from VpnClient
    await (prisma as any).activationSession.delete({ where: { id: req.params.id } });

    await prisma.vpnClient.update({
      where: { id: session.clientId },
      data: { deviceId: null, activatedAt: null },
    });

    await logDbActivity(
      req.user?.userId || null,
      `Activation réinitialisée pour client ${session.client?.token} (device: ${session.deviceId})`,
      "warning",
      req.ip
    );

    return res.json({ success: true, message: "Activation réinitialisée. L'utilisateur peut se réactiver sur un autre appareil." });
  } catch (err) {
    console.error("Reset session error:", err);
    return res.status(500).json({ error: "errors.server" });
  }
});

// DELETE /api/sessions/:id — supprimer une session définitivement
router.delete("/:id", requireAuth, requirePermission("clients.delete"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "Database unavailable" });

    await (prisma as any).activationSession.delete({ where: { id: req.params.id } });

    await logDbActivity(req.user?.userId || null, `Session supprimée: ${req.params.id}`, "danger", req.ip);
    return res.json({ success: true });
  } catch (err) {
    console.error("Delete session error:", err);
    return res.status(500).json({ error: "errors.server" });
  }
});

// POST /api/sessions/sync — mise à jour lastSync (appelé par l'app au démarrage)
router.post("/sync", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(200).json({ synced: false });

    await (prisma as any).activationSession.updateMany({
      where: { 
        client: { user: { id: req.user!.userId } },
        status: "active",
      },
      data: { lastSync: new Date() },
    });

    return res.json({ synced: true, timestamp: new Date().toISOString() });
  } catch (err) {
    return res.status(200).json({ synced: false });
  }
});

export default router;

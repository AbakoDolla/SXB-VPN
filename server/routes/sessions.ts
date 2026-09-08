import { Router, Response } from "express";
import { prisma, logDbActivity } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";
import { canSeeUser } from "../middleware/rbac/owner";
import {
  chargerFicheRevendeur, porteeClientsRevendeur, exigerAccesRevendeur,
  interdireMutationSupport,
} from "../services/reseller-access";
import { executerMutationQuota } from "../services/reseller-quota";
import { dissocierAccesClient, synchroniserEtatAccesClient } from "../services/client-access-state";

const router = Router();

async function porteeSessions(req: AuthenticatedRequest) {
  const ownership = req.user?.role === "RESELLER"
    ? porteeClientsRevendeur(await chargerFicheRevendeur(prisma, req.user.userId))
    : {};
  return { client: {
    ...ownership,
    ...(req.user?.role === "OWNER" ? {} : { user: { role: { name: { not: "OWNER" } } } }),
  } };
}

// GET /api/sessions — liste toutes les sessions d'activation
router.get("/", requireAuth, requirePermission("clients.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "Database unavailable" });
    const sessions = await (prisma as any).activationSession.findMany({
      where: await porteeSessions(req),
      include: { client: { include: { user: { include: { role: true } } } } },
      orderBy: { activationDate: "desc" },
    });
    // Stealth : sessions des clients rattachés à un compte OWNER invisibles
    // pour les non-OWNER (filtrage à la lecture uniquement).
    const visibleSessions = sessions.filter((s: any) => canSeeUser(req, s.client?.user));
    return res.json({
      sessions: visibleSessions.map((s: any) => ({
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
      where: { clientId: req.params.clientId, ...await porteeSessions(req) },
      orderBy: { activationDate: "desc" },
    });
    return res.json({ sessions });
  } catch (err) {
    return res.status(500).json({ error: "errors.server" });
  }
});

// POST /api/sessions/:id/revoke
router.post("/:id/revoke", requireAuth, interdireMutationSupport(), requirePermission("clients.manage"), exigerAccesRevendeur({ autoriserReduction: true }), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "Database unavailable" });
    const existing = await (prisma as any).activationSession.findFirst({
      where: { id: req.params.id, ...await porteeSessions(req) },
      include: { client: true },
    });
    if (!existing) return res.status(404).json({ error: "Session introuvable" });
    const session = await executerMutationQuota(prisma, {
      resellerId: existing.client.resellerId,
      resellerUserId: existing.client.userId,
      auteur: { userId: req.user?.userId, email: req.user?.email },
      reason: "Révocation de session",
      referenceType: "activation_session",
      referenceId: existing.id,
      autoriserReductionAuDessusDuPlafond: true,
    }, async tx => {
      await tx.vpnClient.update({ where: { id: existing.clientId }, data: { status: "suspended" } });
      await synchroniserEtatAccesClient(tx, existing.clientId, "suspended");
      return tx.activationSession.update({ where: { id: existing.id }, data: { status: "revoked" } });
    });
    await logDbActivity(req.user?.userId || null, `Session révoquée: device ${session.deviceId}`, "warning", req.ip);
    return res.json({ success: true, session });
  } catch (err) {
    console.error("Revoke session error:", err);
    return res.status(500).json({ error: "errors.server" });
  }
});

// POST /api/sessions/:id/reset — réinitialise la liaison device, permet ré-activation
router.post("/:id/reset", requireAuth, interdireMutationSupport(), requirePermission("clients.manage"), exigerAccesRevendeur(), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "Database unavailable" });
    const session = await (prisma as any).activationSession.findFirst({
      where: { id: req.params.id, ...await porteeSessions(req) },
      include: { client: true },
    });
    if (!session) return res.status(404).json({ error: "Session introuvable" });

    await prisma.$transaction(async (tx) => {
      await dissocierAccesClient(tx, session.clientId);
      await tx.vpnClient.update({
        where: { id: session.clientId },
        data: { deviceId: null, activatedAt: null },
      });
    });
    await logDbActivity(req.user?.userId || null, `Activation réinitialisée: device ${session.deviceId}`, "warning", req.ip);
    return res.json({ success: true, message: "Activation réinitialisée. L'utilisateur peut se ré-activer." });
  } catch (err) {
    console.error("Reset session error:", err);
    return res.status(500).json({ error: "errors.server" });
  }
});

// DELETE /api/sessions/:id
router.delete("/:id", requireAuth, interdireMutationSupport(), requirePermission("clients.delete"), exigerAccesRevendeur({ autoriserReduction: true }), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "Database unavailable" });
    const deleted = await (prisma as any).activationSession.deleteMany({
      where: { id: req.params.id, ...await porteeSessions(req) },
    });
    if (deleted.count !== 1) return res.status(404).json({ error: "Session introuvable" });
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
      where: {
        client: { userId: req.user!.userId, ...(req.user!.clientId ? { id: req.user!.clientId } : {}) },
        status: "active",
      },
      data: { lastSync: new Date() },
    });
    return res.json({ synced: true, timestamp: new Date().toISOString() });
  } catch {
    return res.status(200).json({ synced: false });
  }
});

export default router;

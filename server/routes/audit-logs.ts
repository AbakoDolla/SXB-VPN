/**
 * Audit Logs Route — /api/audit-logs
 * Accès aux journaux d'activité système depuis la vraie base PostgreSQL.
 *
 * Stealth sécurité :
 *  - Les entrées visibleOwnerOnly=true (authentifications OWNER, suspensions,
 *    bascule maintenance…) sont EXCLUES pour les non-OWNER.
 *  - GET /api/audit-logs/owner (OWNER only) expose le « Journal propriétaire ».
 */
import { Router, Response } from "express";
import { prisma, inMemoryDb } from "../database";
import { requireAuth, AuthenticatedRequest } from "../middleware/auth";
import { requireOwner, isOwnerRequest } from "../middleware/rbac/owner";

const router = Router();

// GET /api/audit-logs?limit=50&type=success
//
// CLOISONNEMENT REVENDEUR — un revendeur ne voit que ses propres actions.
// Cette route n'exigeait qu'une authentification : n'importe quel compte
// connecté, revendeur compris, lisait le journal complet de la plateforme —
// connexions des administrateurs, jetons émis, noms des clients des autres.
// Le revendeur est un partenaire commercial, pas un exploitant : l'activité
// de la plateforme ne le regarde pas, la sienne oui.
router.get("/", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const type = req.query.type as string | undefined;
    const requesterIsOwner = isOwnerRequest(req);
    const isReseller = req.user?.role === "RESELLER";
    const ownScope = isReseller ? { userId: req.user?.userId } : {};

    let logs: any[] = [];

    if (prisma) {
      logs = await prisma.auditLog.findMany({
        // Non-OWNER : les entrées visibleOwnerOnly sont invisibles (filtre dur serveur).
        where: {
          ...(type ? { type } : {}),
          ...(requesterIsOwner ? {} : { visibleOwnerOnly: false }),
          ...ownScope,
        },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
        orderBy: { timestamp: "desc" },
        take: limit,
      });
    } else {
      logs = inMemoryDb.auditLogs
        .filter((log) => requesterIsOwner || !log.visibleOwnerOnly)
        .filter((log) => !isReseller || log.userId === req.user?.userId)
        .filter((log) => !type || log.type === type)
        .slice(0, limit);
    }

    const formatted = logs.map((log) => ({
      id: log.id,
      timestamp: log.timestamp,
      user: log.user?.name || "Système",
      action: log.action,
      type: log.type || "info",
      ipAddress: log.ipAddress,
      ...(requesterIsOwner ? { visibleOwnerOnly: log.visibleOwnerOnly === true } : {}),
    }));

    return res.json({ logs: formatted, total: formatted.length });
  } catch (err) {
    console.error("Fetch audit logs error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Impossible de récupérer les logs" });
  }
});

// GET /api/audit-logs/owner — Journal propriétaire (OWNER uniquement)
// Retourne les entrées de traçabilité de sécurité du compte racine :
// authentifications OWNER, suspensions/révocations, bascules maintenance.
router.get("/owner", requireAuth, requireOwner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);

    let logs: any[] = [];
    if (prisma) {
      logs = await prisma.auditLog.findMany({
        where: { visibleOwnerOnly: true },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
        orderBy: { timestamp: "desc" },
        take: limit,
      });
    } else {
      logs = inMemoryDb.auditLogs
        .filter((log) => log.visibleOwnerOnly)
        .slice(0, limit);
    }

    const formatted = logs.map((log) => ({
      id: log.id,
      timestamp: log.timestamp,
      user: log.user?.name || "Système",
      action: log.action,
      type: log.type || "info",
      ipAddress: log.ipAddress,
      visibleOwnerOnly: true,
    }));

    return res.json({ logs: formatted, total: formatted.length });
  } catch (err) {
    console.error("Fetch owner audit logs error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Impossible de récupérer le journal propriétaire" });
  }
});

export default router;

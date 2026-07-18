/**
 * Audit Logs Route — /api/audit-logs
 * Accès aux journaux d'activité système depuis la vraie base PostgreSQL.
 */
import { Router, Response } from "express";
import { prisma, inMemoryDb } from "../database";
import { requireAuth, AuthenticatedRequest } from "../middleware/auth";

const router = Router();

// GET /api/audit-logs?limit=50&type=success
router.get("/", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const type = req.query.type as string | undefined;

    let logs: any[] = [];

    if (prisma) {
      logs = await prisma.auditLog.findMany({
        where: type ? { type } : undefined,
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
        orderBy: { timestamp: "desc" },
        take: limit,
      });
    } else {
      logs = inMemoryDb.auditLogs.slice(0, limit);
    }

    const formatted = logs.map((log) => ({
      id: log.id,
      timestamp: log.timestamp,
      user: log.user?.name || "Système",
      action: log.action,
      type: log.type || "info",
      ipAddress: log.ipAddress,
    }));

    return res.json({ logs: formatted, total: formatted.length });
  } catch (err) {
    console.error("Fetch audit logs error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Impossible de récupérer les logs" });
  }
});

export default router;

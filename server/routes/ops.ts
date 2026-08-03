/**
 * Ops Routes — exploitation système (OWNER uniquement).
 *
 *   GET  /api/ops/maintenance  → état courant du mode maintenance
 *   POST /api/ops/maintenance  → bascule { enabled: boolean }
 *
 * Chaque bascule écrit une entrée AuditLog visibleOwnerOnly=true
 * (traçabilité de sécurité : visible uniquement par le rôle OWNER).
 */
import { Router, Response } from "express";
import { logDbActivity } from "../database";
import { requireAuth, AuthenticatedRequest } from "../middleware/auth";
import { requireOwner } from "../middleware/rbac/owner";
import { getMaintenanceMode, setMaintenanceMode, MAINTENANCE_KEY } from "../services/maintenance";

const router = Router();

// GET /api/ops/maintenance — état courant (OWNER only)
router.get("/ops/maintenance", requireAuth, requireOwner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const enabled = await getMaintenanceMode();
    return res.json({ enabled, key: MAINTENANCE_KEY });
  } catch (err) {
    console.error("GET ops/maintenance error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Impossible de lire l'état de maintenance" });
  }
});

// POST /api/ops/maintenance — bascule pause/play du dashboard (OWNER only)
router.post("/ops/maintenance", requireAuth, requireOwner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const enabled = req.body?.enabled;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "INVALID_BODY", message: "enabled (boolean) est requis" });
    }

    await setMaintenanceMode(enabled);

    await logDbActivity(
      req.user?.userId || null,
      `Mode maintenance ${enabled ? "ACTIVÉ" : "DÉSACTIVÉ"} par le propriétaire`,
      enabled ? "warning" : "success",
      req.ip,
      { visibleOwnerOnly: true }
    );

    return res.json({
      enabled,
      key: MAINTENANCE_KEY,
      message: enabled ? "Mode maintenance activé" : "Mode maintenance désactivé",
    });
  } catch (err) {
    console.error("POST ops/maintenance error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Impossible de basculer le mode maintenance" });
  }
});

export default router;

import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

// GET /api/analytics/users
router.get("/users", requireAuth, async (req: AuthenticatedRequest, res) => {
  const days = Array.from({ length: 30 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (29 - i));
    return {
      date: d.toISOString().split("T")[0],
      activeUsers: 0,
      newUsers: 0,
    };
  });
  return res.json(days);
});

// GET /api/analytics/traffic
router.get("/traffic", requireAuth, async (req: AuthenticatedRequest, res) => {
  return res.json({
    totalGb: 0,
    byProtocol: [],
    _note: "Dev mode — données réelles disponibles via le backend VPS",
  });
});

export default router;

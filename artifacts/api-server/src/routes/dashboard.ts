import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

// GET /api/dashboard/stats
router.get("/stats", requireAuth, async (req: AuthenticatedRequest, res) => {
  return res.json({
    activeUsers: 0,
    expiredAccounts: 0,
    consumedTraffic: 0,
    activeServers: 1,
    activeResellers: 0,
    totalVouchers: 0,
    redeemedVouchers: 0,
    totalRevenue: 0,
    _note: "Dev mode — données réelles disponibles via le backend VPS",
  });
});

// GET /api/dashboard/traffic
router.get("/traffic", requireAuth, async (req: AuthenticatedRequest, res) => {
  const days = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
  return res.json(
    days.map((d) => ({
      time: d,
      download: 0,
      upload: 0,
    }))
  );
});

// GET /api/dashboard/recent-activity
router.get("/recent-activity", requireAuth, async (req: AuthenticatedRequest, res) => {
  return res.json([]);
});

export default router;

import { Router, Response } from "express";
import { prisma, inMemoryDb } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";

const router = Router();

// GET /api/dashboard/stats
router.get("/stats", requireAuth, requirePermission("analytics.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    let activeUsers = 0;
    let expiredAccounts = 0;
    let consumedTraffic = 0;
    let activeServers = 0;
    let activeResellers = 0;

    if (prisma) {
      activeUsers = await prisma.vpnClient.count({ where: { status: "active" } });
      expiredAccounts = await prisma.vpnClient.count({ where: { status: "expired" } });
      
      const clients = await prisma.vpnClient.findMany({
        select: { quotaUsed: true }
      });
      consumedTraffic = clients.reduce((acc, c) => acc + Number(c.quotaUsed), 0) / (1024 * 1024 * 1024);
      
      activeServers = await prisma.vPSServer.count({ where: { status: "online" } });
      activeResellers = await prisma.reseller.count({ where: { status: "active" } });
    } else {
      activeUsers = inMemoryDb.vpnClients.filter((c) => c.status === "active").length;
      expiredAccounts = inMemoryDb.vpnClients.filter((c) => c.status === "expired").length;
      consumedTraffic = inMemoryDb.vpnClients.reduce((acc, c) => acc + Number(c.quotaUsed), 0) / (1024 * 1024 * 1024);
      activeServers = inMemoryDb.vpsServers.filter((s) => s.status === "online").length;
      activeResellers = inMemoryDb.resellers.filter((r) => r.status === "active").length;
    }

    return res.json({
      activeUsers,
      expiredAccounts,
      consumedTraffic: Math.round(consumedTraffic * 100) / 100,
      activeServers,
      activeResellers,
      totalRevenue: 0,
    });
  } catch (err) {
    console.error("Dashboard stats error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch dashboard stats" });
  }
});

// GET /api/dashboard/traffic
router.get("/traffic", requireAuth, requirePermission("analytics.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const days = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
    let totalConsumption = 0;

    if (prisma) {
      const clients = await prisma.vpnClient.findMany({
        select: { quotaUsed: true }
      });
      totalConsumption = clients.reduce((acc, c) => acc + Number(c.quotaUsed), 0);
    } else {
      totalConsumption = inMemoryDb.vpnClients.reduce((acc, c) => acc + Number(c.quotaUsed), 0);
    }

    const totalConsumptionGb = totalConsumption / (1024 * 1024 * 1024);
    
    const data = days.map((day, idx) => {
      const factor = (idx + 1) / 7;
      return {
        time: day,
        download: Math.round(totalConsumptionGb * 0.75 * factor * 100) / 100,
        upload: Math.round(totalConsumptionGb * 0.25 * factor * 100) / 100,
      };
    });

    return res.json(data);
  } catch (err) {
    console.error("Dashboard traffic error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch traffic data" });
  }
});

// GET /api/dashboard/users
router.get("/users", requireAuth, requirePermission("analytics.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    let totalUsers = 0;

    if (prisma) {
      totalUsers = await prisma.vpnClient.count();
    } else {
      totalUsers = inMemoryDb.vpnClients.length;
    }

    let countAccumulator = 0;
    const data = days.map((day, idx) => {
      const step = Math.ceil(totalUsers / 7);
      countAccumulator = Math.min(totalUsers, countAccumulator + step);
      return {
        time: day,
        count: countAccumulator,
      };
    });

    return res.json(data);
  } catch (err) {
    console.error("Dashboard users error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch user data" });
  }
});

export default router;

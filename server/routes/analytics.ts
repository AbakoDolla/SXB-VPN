import { Router, Response } from "express";
import { prisma, inMemoryDb } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";

const router = Router();

// GET /api/analytics/users
router.get("/users", requireAuth, requirePermission("analytics.read"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    let totalUsers = 0;
    let activeClientsCount = 0;
    let resellersCount = 0;
    let supportCount = 0;

    if (prisma) {
      totalUsers = await prisma.user.count();
      activeClientsCount = await prisma.vpnClient.count({ where: { status: "active" } });
      resellersCount = await prisma.reseller.count();
      // Estimate support from role name
      const supportRole = await prisma.role.findFirst({ where: { name: "SUPPORT" } });
      if (supportRole) {
        supportCount = await prisma.user.count({ where: { roleId: supportRole.id } });
      }
    } else {
      totalUsers = inMemoryDb.users.length;
      activeClientsCount = inMemoryDb.vpnClients.filter((c) => c.status === "active").length;
      resellersCount = inMemoryDb.resellers.length;
      const supportRole = inMemoryDb.roles.find((r) => r.name === "SUPPORT");
      if (supportRole) {
        supportCount = inMemoryDb.users.filter((u) => u.roleId === supportRole.id).length;
      }
    }

    return res.json({
      totalUsers,
      activeVpnClients: activeClientsCount,
      activePartners: resellersCount,
      supportAgents: supportCount,
    });
  } catch (err) {
    console.error("Fetch user analytics error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to compile user statistics" });
  }
});

// GET /api/analytics/traffic
router.get("/traffic", requireAuth, requirePermission("analytics.read"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    let totalQuotaBytes = BigInt(0);
    let totalUsedBytes = BigInt(0);
    const clientsData: { quotaTotal: bigint; quotaUsed: bigint }[] = [];

    if (prisma) {
      const clients = await prisma.vpnClient.findMany({
        select: { quotaTotal: true, quotaUsed: true },
      });
      clients.forEach((c) => {
        totalQuotaBytes += c.quotaTotal;
        totalUsedBytes += c.quotaUsed;
      });
    } else {
      inMemoryDb.vpnClients.forEach((c) => {
        totalQuotaBytes += c.quotaTotal;
        totalUsedBytes += c.quotaUsed;
      });
    }

    // Convert bigints safely to GBs
    const totalQuotaGb = Number(totalQuotaBytes) / (1024 * 1024 * 1024);
    const totalUsedGb = Number(totalUsedBytes) / (1024 * 1024 * 1024);

    // Dynamic historical simulation chart based on actual sizes
    const historyChart = Array.from({ length: 7 }, (_, i) => {
      const dateObj = new Date();
      dateObj.setDate(dateObj.getDate() - (6 - i));
      const dateStr = dateObj.toLocaleDateString("fr-FR", { weekday: "short" });
      
      const dayFactor = (i + 1) / 7;
      const simulatedDailyUsage = totalUsedGb * 0.15 * dayFactor + Math.random() * 2;
      
      return {
        name: dateStr,
        uploadedGb: Number((simulatedDailyUsage * 0.4).toFixed(2)),
        downloadedGb: Number((simulatedDailyUsage * 0.6).toFixed(2)),
        totalGb: Number(simulatedDailyUsage.toFixed(2)),
      };
    });

    return res.json({
      bandwidthProvisionedGb: Number(totalQuotaGb.toFixed(2)),
      bandwidthConsumedGb: Number(totalUsedGb.toFixed(2)),
      utilizationPercentage: totalQuotaGb > 0 ? Number(((totalUsedGb / totalQuotaGb) * 100).toFixed(2)) : 0,
      history: historyChart,
    });
  } catch (err) {
    console.error("Fetch traffic analytics error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to compile traffic statistics" });
  }
});

// GET /api/analytics/servers
router.get("/servers", requireAuth, requirePermission("analytics.read"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    let totalServers = 0;
    let onlineServers = 0;
    let locationsSet = new Set<string>();

    if (prisma) {
      const servers = await prisma.vPSServer.findMany();
      totalServers = servers.length;
      onlineServers = servers.filter((s) => s.status === "online").length;
      servers.forEach((s) => locationsSet.add(s.location));
    } else {
      totalServers = inMemoryDb.vpsServers.length;
      onlineServers = inMemoryDb.vpsServers.filter((s) => s.status === "online").length;
      inMemoryDb.vpsServers.forEach((s) => locationsSet.add(s.location));
    }

    // Server-specific capacity loads
    const loadBreakdown = (prisma ? await prisma.vPSServer.findMany() : inMemoryDb.vpsServers).map((srv) => {
      // Simulate capacity metric
      const userCount = Math.floor(Math.random() * 45) + 5; // 5 to 50 active users
      const bandwidthUsagePercent = Math.floor(Math.random() * 60) + 15; // 15% to 75%
      const cpuLoad = Math.floor(Math.random() * 50) + 10;
      const memoryUsage = Math.floor(Math.random() * 40) + 30;

      return {
        id: srv.id,
        name: srv.name,
        ip: srv.ip,
        location: srv.location,
        status: srv.status,
        cpuLoadPercent: srv.status === "online" ? cpuLoad : 0,
        memoryUsagePercent: srv.status === "online" ? memoryUsage : 0,
        bandwidthUsagePercent: srv.status === "online" ? bandwidthUsagePercent : 0,
        connectedUsersCount: srv.status === "online" ? userCount : 0,
      };
    });

    return res.json({
      totalServers,
      onlineServers,
      totalLocations: locationsSet.size,
      breakdown: loadBreakdown,
    });
  } catch (err) {
    console.error("Fetch servers analytics error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to compile servers telemetry" });
  }
});

export default router;

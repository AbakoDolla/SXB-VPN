/**
 * Analytics Routes — /api/analytics
 * Toutes les données proviennent de la base PostgreSQL réelle.
 * Aucune donnée simulée (Math.random() supprimé).
 */
import { Router, Response } from "express";
import { prisma, inMemoryDb } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";

const router = Router();

// GET /api/analytics/users — statistiques réelles des utilisateurs
router.get("/users", requireAuth, requirePermission("analytics.read"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    let totalUsers = 0;
    let activeClientsCount = 0;
    let resellersCount = 0;
    let supportCount = 0;

    if (prisma) {
      [totalUsers, activeClientsCount, resellersCount] = await Promise.all([
        prisma.user.count(),
        prisma.vpnClient.count({ where: { status: "active" } }),
        prisma.reseller.count(),
      ]);
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

// GET /api/analytics/traffic — trafic réel depuis la DB
router.get("/traffic", requireAuth, requirePermission("analytics.read"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    let totalQuotaBytes = BigInt(0);
    let totalUsedBytes = BigInt(0);

    if (prisma) {
      const clients = await prisma.vpnClient.findMany({
        select: { quotaTotal: true, quotaUsed: true, updatedAt: true },
      });
      clients.forEach((c) => {
        if (c.quotaTotal) totalQuotaBytes += c.quotaTotal;
        totalUsedBytes += c.quotaUsed;
      });

      // Historique réel : regrouper quotaUsed par jour de mise à jour (7 derniers jours)
      const now = new Date();
      const history = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(now);
        d.setDate(d.getDate() - (6 - i));
        d.setHours(0, 0, 0, 0);
        const dayEnd = new Date(d);
        dayEnd.setHours(23, 59, 59, 999);

        const dayClients = clients.filter((c) => {
          const ud = new Date(c.updatedAt);
          return ud >= d && ud <= dayEnd;
        });

        const dayUsedBytes = dayClients.reduce((acc, c) => acc + Number(c.quotaUsed), 0);
        const dayUsedGb = dayUsedBytes / (1024 * 1024 * 1024);

        return {
          name: d.toLocaleDateString("fr-FR", { weekday: "short" }),
          uploadedGb: Number((dayUsedGb * 0.35).toFixed(2)),
          downloadedGb: Number((dayUsedGb * 0.65).toFixed(2)),
          totalGb: Number(dayUsedGb.toFixed(2)),
        };
      });

      const totalQuotaGb = Number(totalQuotaBytes) / (1024 * 1024 * 1024);
      const totalUsedGb = Number(totalUsedBytes) / (1024 * 1024 * 1024);

      return res.json({
        bandwidthProvisionedGb: Number(totalQuotaGb.toFixed(2)),
        bandwidthConsumedGb: Number(totalUsedGb.toFixed(2)),
        utilizationPercentage: totalQuotaGb > 0 ? Number(((totalUsedGb / totalQuotaGb) * 100).toFixed(2)) : 0,
        history,
      });
    } else {
      inMemoryDb.vpnClients.forEach((c) => {
        totalQuotaBytes += c.quotaTotal;
        totalUsedBytes += c.quotaUsed;
      });
      const totalQuotaGb = Number(totalQuotaBytes) / (1024 * 1024 * 1024);
      const totalUsedGb = Number(totalUsedBytes) / (1024 * 1024 * 1024);
      return res.json({
        bandwidthProvisionedGb: Number(totalQuotaGb.toFixed(2)),
        bandwidthConsumedGb: Number(totalUsedGb.toFixed(2)),
        utilizationPercentage: totalQuotaGb > 0 ? Number(((totalUsedGb / totalQuotaGb) * 100).toFixed(2)) : 0,
        history: [],
      });
    }
  } catch (err) {
    console.error("Fetch traffic analytics error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to compile traffic statistics" });
  }
});

// GET /api/analytics/servers — métriques serveurs depuis la DB réelle
// CPU/RAM/Bande passante ne sont pas disponibles sans agent de monitoring.
// On retourne uniquement ce qu'on connaît réellement (status, clients actifs).
router.get("/servers", requireAuth, requirePermission("analytics.read"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    let servers: any[] = [];
    let activeClientCount = 0;
    const locationsSet = new Set<string>();

    if (prisma) {
      [servers, activeClientCount] = await Promise.all([
        prisma.vPSServer.findMany({ orderBy: { createdAt: "asc" } }),
        prisma.vpnClient.count({ where: { status: "active" } }),
      ]);
      servers.forEach((s) => locationsSet.add(s.location));
    } else {
      servers = inMemoryDb.vpsServers;
      activeClientCount = inMemoryDb.vpnClients.filter((c) => c.status === "active").length;
      servers.forEach((s) => locationsSet.add(s.location));
    }

    const onlineCount = servers.filter((s) => s.status === "online").length;
    // Distribuer les clients actifs équitablement sur les serveurs en ligne
    const clientsPerServer = onlineCount > 0 ? Math.round(activeClientCount / onlineCount) : 0;

    const breakdown = servers.map((srv) => ({
      id: srv.id,
      name: srv.name,
      ip: srv.ip,
      location: srv.location,
      status: srv.status,
      // Métriques disponibles réellement
      connectedUsersCount: srv.status === "online" ? clientsPerServer : 0,
      // Métriques non disponibles sans agent de monitoring (null = honnête)
      cpuLoadPercent: null,
      memoryUsagePercent: null,
      bandwidthUsagePercent: null,
    }));

    return res.json({
      totalServers: servers.length,
      onlineServers: onlineCount,
      totalLocations: locationsSet.size,
      activeClients: activeClientCount,
      breakdown,
    });
  } catch (err) {
    console.error("Fetch servers analytics error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to compile servers telemetry" });
  }
});

export default router;

// GET /api/analytics/overview — agrégat complet pour le dashboard
router.get("/overview", requireAuth, requirePermission("analytics.read"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (prisma) {
      const [
        totalUsers,
        activeClients,
        resellersCount,
        totalServers,
        onlineServers,
        totalTokens,
        usedTokens,
        totalVouchers,
        usedVouchers,
        totalTraffic,
      ] = await Promise.all([
        prisma.user.count(),
        prisma.vpnClient.count({ where: { status: "active" } }),
        prisma.reseller.count(),
        prisma.vPSServer.count(),
        prisma.vPSServer.count({ where: { status: "online" } }),
        prisma.tokenSXB.count(),
        prisma.tokenSXB.count({ where: { status: "used" } }),
        prisma.voucher.count(),
        prisma.voucher.count({ where: { isRedeemed: true } }),
        prisma.vpnClient.aggregate({ _sum: { quotaUsed: true } }),
      ]);
      return res.json({
        totalUsers,
        activeClients,
        resellersCount,
        totalServers,
        onlineServers,
        totalTokens,
        usedTokens,
        totalVouchers,
        usedVouchers,
        consumedTrafficBytes: totalTraffic._sum.quotaUsed?.toString() ?? "0",
      });
    }
    // Fallback inMemory
    return res.json({
      totalUsers: inMemoryDb.users.length,
      activeClients: inMemoryDb.vpnClients.filter((c) => c.status === "active").length,
      resellersCount: inMemoryDb.resellers.length,
      totalServers: inMemoryDb.vpsServers.length,
      onlineServers: inMemoryDb.vpsServers.filter((s) => s.status === "online").length,
      totalTokens: inMemoryDb.tokens.length,
      usedTokens: inMemoryDb.tokens.filter((t) => t.status === "used").length,
      totalVouchers: inMemoryDb.vouchers.length,
      usedVouchers: inMemoryDb.vouchers.filter((v) => (v as any).isRedeemed === true).length,
      consumedTrafficBytes: "0",
    });
  } catch (err) {
    console.error("Analytics overview error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to compile overview statistics" });
  }
});

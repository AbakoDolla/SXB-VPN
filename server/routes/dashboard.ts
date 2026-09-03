/**
 * Dashboard Routes — /api/dashboard
 * Statistiques réelles issues de la base PostgreSQL.
 * Graphiques basés sur les vraies dates de création/mise à jour.
 */
import { Router, Response } from "express";
import { prisma, inMemoryDb } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";
import { isOwnerRequest } from "../middleware/rbac/owner";

const router = Router();

// Stealth : pour les non-OWNER, les KPIs excluent les comptes OWNER et leurs
// clients/revendeurs. Filtrage à la lecture uniquement — aucune suppression.
function stealthWhere(requesterIsOwner: boolean): any {
  if (requesterIsOwner) return undefined;
  return { user: { role: { name: { not: "OWNER" } } } };
}

// GET /api/dashboard/stats — KPIs principaux
router.get("/stats", requireAuth, requirePermission("analytics.read"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    let activeUsers = 0;
    let expiredAccounts = 0;
    let consumedTrafficBytes = BigInt(0);
    let provisionedTrafficBytes = BigInt(0);
    let activeServers = 0;
    let activeResellers = 0;
    let totalVouchers = 0;
    let redeemedVouchers = 0;

    const requesterIsOwner = isOwnerRequest(req);
    // Cloisonnement REVENDEUR — ses indicateurs ne portent que sur SES clients.
    // Sans ce filtre, il lisait les chiffres globaux de la plateforme : clients
    // de l'administrateur, clients des autres revendeurs, et le nombre de
    // serveurs, qui relève de l'infrastructure et ne le concerne pas.
    const isReseller = req.user?.role === "RESELLER";
    const ownScope = isReseller ? { userId: req.user?.userId } : {};
    if (prisma) {
      const clientStealthWhere = { ...stealthWhere(requesterIsOwner), ...ownScope };
      const resellerStealthWhere = stealthWhere(requesterIsOwner);
      [activeUsers, expiredAccounts, activeServers, activeResellers, totalVouchers, redeemedVouchers] = await Promise.all([
        prisma.vpnClient.count({ where: { status: "active", ...clientStealthWhere } }),
        prisma.vpnClient.count({ where: { status: "expired", ...clientStealthWhere } }),
        // Le revendeur ne pilote aucun serveur : la valeur reste à zéro et la
        // carte correspondante est remplacée côté interface.
        isReseller ? Promise.resolve(0) : prisma.vPSServer.count({ where: { status: "online" } }),
        isReseller ? Promise.resolve(0) : prisma.reseller.count({ where: { status: "active", ...resellerStealthWhere } }),
        prisma.voucher.count(),
        prisma.voucher.count({ where: { isRedeemed: true } }),
      ]);

      const clients = await prisma.vpnClient.findMany({
        select: { quotaTotal: true, quotaUsed: true },
        ...(Object.keys(clientStealthWhere).length ? { where: clientStealthWhere } : {}),
      });
      provisionedTrafficBytes = clients.reduce((acc, c) => acc + (c.quotaTotal || BigInt(0)), BigInt(0));
      consumedTrafficBytes = clients.reduce((acc, c) => acc + c.quotaUsed, BigInt(0));
    } else {
      activeUsers = inMemoryDb.vpnClients.filter((c) => c.status === "active").length;
      expiredAccounts = inMemoryDb.vpnClients.filter((c) => c.status === "expired").length;
      provisionedTrafficBytes = inMemoryDb.vpnClients.reduce((acc, c) => acc + (c.quotaTotal || BigInt(0)), BigInt(0));
      consumedTrafficBytes = inMemoryDb.vpnClients.reduce((acc, c) => acc + c.quotaUsed, BigInt(0));
      activeServers = inMemoryDb.vpsServers.filter((s) => s.status === "online").length;
      activeResellers = inMemoryDb.resellers.filter((r) => r.status === "active").length;
    }

    const GB = 1024 * 1024 * 1024;
    const consumedTrafficGb = Number(consumedTrafficBytes) / GB;
    const provisionedTrafficGb = Number(provisionedTrafficBytes) / GB;

    return res.json({
      activeUsers,
      expiredAccounts,
      consumedTraffic: Math.round(consumedTrafficGb * 100) / 100,
      provisionedTraffic: Math.round(provisionedTrafficGb * 100) / 100,
      remainingTraffic: Math.max(0, Math.round((provisionedTrafficGb - consumedTrafficGb) * 100) / 100),
      consumedTrafficBytes: consumedTrafficBytes.toString(),
      provisionedTrafficBytes: provisionedTrafficBytes.toString(),
      activeServers,
      activeResellers,
      totalVouchers,
      redeemedVouchers,
      totalRevenue: 0, // Revenus non implémentés (pas de paiements intégrés)
    });
  } catch (err) {
    console.error("Dashboard stats error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch dashboard stats" });
  }
});

// GET /api/dashboard/traffic — graphique trafic sur les 7 derniers jours (données réelles)
router.get("/traffic", requireAuth, requirePermission("analytics.read"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const now = new Date();

    // Générer les 7 derniers jours
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(now);
      d.setDate(d.getDate() - (6 - i));
      d.setHours(0, 0, 0, 0);
      return d;
    });

    const requesterIsOwner = isOwnerRequest(req);
    const clientStealthWhere = stealthWhere(requesterIsOwner);
    if (prisma) {
      const clientIds = (await prisma.vpnClient.findMany({
        select: { id: true },
        ...(clientStealthWhere ? { where: clientStealthWhere } : {}),
      })).map((c) => c.id);
      const firstDay = days[0];
      const lastDay = new Date(days[days.length - 1]);
      lastDay.setHours(23, 59, 59, 999);
      const usageRows = clientIds.length
        ? await (prisma as any).trafficUsage.findMany({
            where: { clientId: { in: clientIds }, timestamp: { gte: firstDay, lte: lastDay } },
            select: { download: true, upload: true, timestamp: true },
          })
        : [];

      const data = days.map((day) => {
        const dayEnd = new Date(day);
        dayEnd.setHours(23, 59, 59, 999);
        const rows = usageRows.filter((row: any) => {
          const timestamp = new Date(row.timestamp);
          return timestamp >= day && timestamp <= dayEnd;
        });
        const downloadGb = rows.reduce((acc: number, row: any) => acc + Number(row.download || 0), 0) / (1024 ** 3);
        const uploadGb = rows.reduce((acc: number, row: any) => acc + Number(row.upload || 0), 0) / (1024 ** 3);
        return {
          time: day.toLocaleDateString("fr-FR", { weekday: "short" }),
          download: Number(downloadGb.toFixed(3)),
          upload: Number(uploadGb.toFixed(3)),
        };
      });

      return res.json(data);
    } else {
      // Sans base persistante, aucun historique journalier fiable n’existe.
      // Retourner zéro est préférable à une répartition artificielle du total.
      const data = days.map((d) => ({
        time: d.toLocaleDateString("fr-FR", { weekday: "short" }),
        download: 0,
        upload: 0,
      }));
      return res.json(data);
    }
  } catch (err) {
    console.error("Dashboard traffic error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch traffic data" });
  }
});

// GET /api/dashboard/users — évolution des comptes VPN sur les 7 derniers jours
router.get("/users", requireAuth, requirePermission("analytics.read"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const now = new Date();

    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(now);
      d.setDate(d.getDate() - (6 - i));
      d.setHours(0, 0, 0, 0);
      return d;
    });

    const requesterIsOwner = isOwnerRequest(req);
    const clientStealthWhere = stealthWhere(requesterIsOwner);
    if (prisma) {
      // Compter les clients VPN créés jusqu'à chaque jour (cumulatif)
      const data = await Promise.all(
        days.map(async (day) => {
          const dayEnd = new Date(day);
          dayEnd.setHours(23, 59, 59, 999);
          const count = await prisma!.vpnClient.count({
            where: { createdAt: { lte: dayEnd }, ...clientStealthWhere },
          });
          return {
            time: day.toLocaleDateString("fr-FR", { weekday: "short" }),
            count,
          };
        })
      );
      return res.json(data);
    } else {
      const total = inMemoryDb.vpnClients.length;
      const data = days.map((d, i) => ({
        time: d.toLocaleDateString("fr-FR", { weekday: "short" }),
        count: Math.round(total * ((i + 1) / 7)),
      }));
      return res.json(data);
    }
  } catch (err) {
    console.error("Dashboard users error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch user data" });
  }
});

export default router;

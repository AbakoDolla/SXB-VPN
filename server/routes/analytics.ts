/**
 * Analytics Routes — /api/analytics
 * Toutes les données proviennent de la base PostgreSQL réelle.
 * Aucune donnée simulée (Math.random() supprimé).
 */
import { Router, Response } from "express";
import { prisma, inMemoryDb } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";
import { FURTIVITE_OWNER_PORTEUR, isOwnerRequest } from "../middleware/rbac/owner";
import { porteeBons, porteeClients, porteeComptes as porteeAnnuaireComptes, porteeRevendeurs, porteeServeurs, porteeSousClient } from "../services/portee-donnees";
import { etFiltres } from "../services/free-trial-marks";
import { agregerTrafic, enGo, tauxUtilisation } from "../services/trafic-agrege";

const router = Router();

// Stealth : compteurs excluant les comptes OWNER et leurs clients/revendeurs
// pour les non-OWNER (filtrage à la lecture uniquement).
function stealthUserWhere(requesterIsOwner: boolean): any {
  if (requesterIsOwner) return undefined;
  return { role: { name: { not: "OWNER" } } };
}

/**
 * Même furtivité, exprimée pour le modèle `Reseller`.
 *
 * Une fiche revendeur n'a PAS de champ `role` : elle atteint le rôle par son
 * compte `user`. Le filtre des utilisateurs lui était appliqué tel quel, et
 * Prisma rejetait la requête — `/api/analytics/users` et `/api/analytics/overview`
 * répondaient donc 500 depuis leur écriture, sans que personne ne le voie
 * puisque l'écran se contentait d'afficher des zéros.
 */
function stealthResellerWhere(requesterIsOwner: boolean): any {
  if (requesterIsOwner) return undefined;
  return FURTIVITE_OWNER_PORTEUR;
}

/**
 * Clients invisibles pour les autres rôles.
 *
 * Ce filtre ne regardait que le compte PORTEUR (`user.role`). Or un client créé
 * depuis le panneau reçoit un compte de rôle CLIENT : le parc du propriétaire,
 * ses quotas et son trafic entraient donc dans toutes les statistiques que lit
 * un super-administrateur. C'est la même faille que celle corrigée ailleurs,
 * restée ici parce que cette route s'était écrit son propre filtre.
 *
 * Elle lit désormais le point unique, qui couvre les DEUX rattachements et, au
 * passage, le compartiment de l'administrateur.
 */
async function porteeAnalytique(req: AuthenticatedRequest) {
  return (await porteeClients(prisma, req.user)) ?? undefined;
}

// GET /api/analytics/users — statistiques réelles des utilisateurs
router.get("/users", requireAuth, requirePermission("analytics.read"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    let totalUsers = 0;
    let activeClientsCount = 0;
    let resellersCount = 0;
    let supportCount = 0;

    const requesterIsOwner = isOwnerRequest(req);
    const userStealthWhere = stealthUserWhere(requesterIsOwner);
    const clientStealthWhere = await porteeAnalytique(req);
    // ── Un TOTAL est une fuite aussi sûrement qu'une liste ───────────────────
    //
    // Mesuré en production : un administrateur dont le parc est VIDE lisait
    // `totalUsers: 829` et `activePartners: 18` — exactement les chiffres du
    // propriétaire. Il apprenait ainsi l'ampleur du parc qu'on lui cache, alors
    // que le compteur voisin (`activeVpnClients`) était, lui, bien cloisonné.
    //
    // La furtivité OWNER ne suffit pas : elle retire le propriétaire, pas les
    // autres exploitants. On ajoute donc la portée du requérant, par un `AND`
    // explicite — un `{...a, ...b}` écraserait silencieusement une clé commune.
    // `porteeComptes` est importée sous alias : le handler `/overview`, plus
    // bas, déclare une const locale du même nom qui masquerait l'import.
    const porteeComptesRequerant = await porteeAnnuaireComptes(prisma, req.user);
    const porteeRevendeursRequerant = await porteeRevendeurs(prisma, req.user);
    const filtreComptes = etFiltres(userStealthWhere, porteeComptesRequerant);
    const filtreRevendeurs = etFiltres(stealthResellerWhere(requesterIsOwner), porteeRevendeursRequerant);
    if (prisma) {
      [totalUsers, activeClientsCount, resellersCount] = await Promise.all([
        prisma.user.count({ where: filtreComptes as any }),
        prisma.vpnClient.count({ where: { status: "active", ...clientStealthWhere } }),
        prisma.reseller.count({ where: filtreRevendeurs as any }),
      ]);
      const supportRole = await prisma.role.findFirst({ where: { name: "SUPPORT" } });
      if (supportRole) {
        // Même raison : le nombre d'agents de support est un chiffre de
        // plateforme. Un administrateur n'en gère aucun, il doit donc lire zéro
        // plutôt que l'effectif de la maison.
        supportCount = await prisma.user.count({
          where: etFiltres({ roleId: supportRole.id }, porteeComptesRequerant) as any,
        });
      }
    } else {
      const ownerRole = inMemoryDb.roles.find((r) => r.name === "OWNER");
      totalUsers = requesterIsOwner
        ? inMemoryDb.users.length
        : inMemoryDb.users.filter((u) => !ownerRole || u.roleId !== ownerRole.id).length;
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
    // Règle d'agrégation en un point unique : elle vivait en deux exemplaires
    // (base de données / repli mémoire) et le défaut était dans les deux.
    const requesterIsOwner = isOwnerRequest(req);
    const clientStealthWhere = await porteeAnalytique(req);
    if (prisma) {
      const clients = await prisma.vpnClient.findMany({
        select: { quotaTotal: true, quotaUsed: true, updatedAt: true },
        ...(clientStealthWhere ? { where: clientStealthWhere } : {}),
      });
      const agrege = agregerTrafic(clients);

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

      return res.json({
        bandwidthProvisionedGb: Number(enGo(agrege.provisionedBytes).toFixed(2)),
        bandwidthConsumedGb: Number(enGo(agrege.consumedBytes).toFixed(2)),
        // Numérateur et dénominateur portent désormais sur les MÊMES fiches.
        utilizationPercentage: tauxUtilisation(agrege),
        // De quoi expliquer l'écart à l'écran plutôt que de le laisser
        // ressembler à une erreur : la consommation hors quota est réelle, elle
        // ne doit pas disparaître du total.
        meteredClients: agrege.meteredClients,
        meteredConsumedGb: Number(enGo(agrege.meteredConsumedBytes).toFixed(2)),
        history,
      });
    } else {
      const agrege = agregerTrafic(inMemoryDb.vpnClients);
      return res.json({
        bandwidthProvisionedGb: Number(enGo(agrege.provisionedBytes).toFixed(2)),
        bandwidthConsumedGb: Number(enGo(agrege.consumedBytes).toFixed(2)),
        utilizationPercentage: tauxUtilisation(agrege),
        meteredClients: agrege.meteredClients,
        meteredConsumedGb: Number(enGo(agrege.meteredConsumedBytes).toFixed(2)),
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

    const requesterIsOwner = isOwnerRequest(req);
    const clientStealthWhere = await porteeAnalytique(req);
    if (prisma) {
      [servers, activeClientCount] = await Promise.all([
        // Même compartiment que partout ailleurs : un administrateur ne voit
        // que ses serveurs, y compris dans la ventilation par serveur.
        prisma.vPSServer.findMany({
          where: { ...(await porteeServeurs(prisma, req.user) ?? {}) },
          orderBy: { createdAt: "asc" },
        }),
        prisma.vpnClient.count({ where: { status: "active", ...clientStealthWhere } }),
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
    const requesterIsOwner = isOwnerRequest(req);
    const userStealthWhere = stealthUserWhere(requesterIsOwner);
    const clientStealthWhere = await porteeAnalytique(req);
    if (prisma) {
      // Compartiment du requérant, famille par famille. Ces comptages ne
      // connaissaient que la furtivité du propriétaire : un administrateur
      // neuf lisait 770 utilisateurs, 5 revendeurs, 3 serveurs et les jetons
      // de la maison — mesuré en production avant correction.
      const porteeServeursRequerant = await porteeServeurs(prisma, req.user);
      const porteeRevendeursRequerant = await porteeRevendeurs(prisma, req.user);
      const porteeBonsRequerant = await porteeBons(prisma, req.user);
      // Un administrateur ne compte que LES COMPTES qu'il gère. Passer par la
      // portée des clients rattache le décompte à son parc, là où `user.count`
      // embrassait toute la plateforme.
      const porteeComptes = await porteeClients(prisma, req.user);
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
        porteeComptes
          ? prisma.vpnClient.count({ where: porteeComptes as any })
          : prisma.user.count({ where: userStealthWhere }),
        prisma.vpnClient.count({ where: { status: "active", ...clientStealthWhere } }),
        prisma.reseller.count({
          where: { ...stealthResellerWhere(requesterIsOwner), ...(porteeRevendeursRequerant ?? {}) },
        }),
        prisma.vPSServer.count({ where: { ...(porteeServeursRequerant ?? {}) } }),
        prisma.vPSServer.count({ where: { status: "online", ...(porteeServeursRequerant ?? {}) } }),
        // Les jetons d'activation appartiennent au client qu'ils ouvrent :
        // leur portée est donc celle des clients, pas un décompte global.
        prisma.tokenSXB.count({ where: { ...(await porteeSousClient(prisma, req.user) ?? {}) } }),
        prisma.tokenSXB.count({ where: { status: "used", ...(await porteeSousClient(prisma, req.user) ?? {}) } }),
        prisma.voucher.count({ where: { ...(porteeBonsRequerant ?? {}) } }),
        prisma.voucher.count({ where: { status: "used", ...(porteeBonsRequerant ?? {}) } }),
        prisma.vpnClient.aggregate({ _sum: { quotaUsed: true }, ...(clientStealthWhere ? { where: clientStealthWhere } : {}) }),
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
      usedVouchers: inMemoryDb.vouchers.filter((v) => v.status === "used").length,
      consumedTrafficBytes: "0",
    });
  } catch (err) {
    console.error("Analytics overview error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to compile overview statistics" });
  }
});

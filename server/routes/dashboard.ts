/**
 * Dashboard Routes — /api/dashboard
 * Statistiques réelles issues de la base PostgreSQL.
 * Graphiques basés sur les vraies dates de création/mise à jour.
 */
import { Router, Response } from "express";
import { prisma, inMemoryDb } from "../database";
import { config } from "../config";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";
import { isOwnerRequest } from "../middleware/rbac/owner";
import { calculerAllocation, estIllimite } from "../services/reseller-quota";
import {
  compterConnectes,
  PRESENCE_HEARTBEAT_MINUTES,
  PRESENCE_WINDOW_MINUTES,
} from "../services/vpn-presence";
import {
  chargerFicheRevendeur,
  porteeClientsRevendeur,
  resumerAccesRevendeur,
} from "../services/reseller-access";

const router = Router();
const ROLES_QUOTA_REVENDEURS = new Set(["OWNER", "SUPER_ADMIN", "ADMIN"]);

type StatistiquesQuotaRevendeurs = {
  scope: "self" | "platform";
  assignedBytes: string;
  committedBytes: string;
  consumedBytes: string;
  remainingBytes: string | null;
  unlimited: boolean;
  resellerCount: number;
  limitedResellers: number;
  unlimitedResellers: number;
};

function creerStatistiquesQuotaRevendeurs(
  scope: StatistiquesQuotaRevendeurs["scope"],
  lignes: Array<{ quotaBytes: bigint; alloue: bigint; consomme: bigint }>
): StatistiquesQuotaRevendeurs {
  let attribue = BigInt(0);
  let engage = BigInt(0);
  let consomme = BigInt(0);
  let restant = BigInt(0);
  let illimites = 0;

  for (const ligne of lignes) {
    engage += ligne.alloue;
    consomme += ligne.consomme;
    if (estIllimite(ligne.quotaBytes)) {
      illimites += 1;
      continue;
    }
    attribue += ligne.quotaBytes;
    restant += ligne.quotaBytes > ligne.alloue ? ligne.quotaBytes - ligne.alloue : BigInt(0);
  }

  const personnelIllimite = scope === "self" && illimites === 1;
  return {
    scope,
    assignedBytes: personnelIllimite ? BigInt(-1).toString() : attribue.toString(),
    committedBytes: engage.toString(),
    consumedBytes: consomme.toString(),
    remainingBytes: personnelIllimite ? null : restant.toString(),
    unlimited: personnelIllimite,
    resellerCount: lignes.length,
    limitedResellers: lignes.length - illimites,
    unlimitedResellers: illimites,
  };
}

// Stealth : pour les non-OWNER, les KPIs excluent les comptes OWNER et leurs
// clients/revendeurs. Filtrage à la lecture uniquement — aucune suppression.
function stealthWhere(requesterIsOwner: boolean): any {
  if (requesterIsOwner) return undefined;
  return { user: { role: { name: { not: "OWNER" } } } };
}

// GET /api/dashboard/stats — KPIs principaux
router.get("/stats", requireAuth, requirePermission("analytics.read"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Nombre de COMPTES ouverts. Ce n'est PAS un nombre de personnes en ligne :
    // la carte « CONNECTÉS » affichait cette valeur et prétendait donc que
    // 82 comptes ouverts valaient 82 utilisateurs en train de se servir du VPN.
    // Le nombre de connexions réelles est `connectedNow`, mesuré séparément.
    let activeAccounts = 0;
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
    // La portée d'un revendeur suit la PROPRIÉTÉ des clients (`resellerId` ou,
    // pour le parc historique, le compte porteur) et non le seul `userId` : un
    // client attribué explicitement échappait sinon à ses propres indicateurs.
    const ficheRevendeur = isReseller ? await chargerFicheRevendeur(prisma, req.user?.userId) : null;
    const ownScope = isReseller ? (porteeClientsRevendeur(ficheRevendeur) as any) : {};
    const resellerStealthWhere = stealthWhere(requesterIsOwner);
    if (prisma) {
      const clientStealthWhere = { ...stealthWhere(requesterIsOwner), ...ownScope };
      [activeAccounts, expiredAccounts, activeServers, activeResellers, totalVouchers, redeemedVouchers] = await Promise.all([
        prisma.vpnClient.count({ where: { status: "active", ...clientStealthWhere } }),
        prisma.vpnClient.count({ where: { status: "expired", ...clientStealthWhere } }),
        // Le revendeur ne pilote aucun serveur : la valeur reste à zéro et la
        // carte correspondante est remplacée côté interface.
        isReseller ? Promise.resolve(0) : prisma.vPSServer.count({ where: { status: "online" } }),
        isReseller ? Promise.resolve(0) : prisma.reseller.count({ where: { status: "active", ...resellerStealthWhere } }),
        // Les bons de recharge sont comptés à l'échelle de la plateforme : un
        // revendeur n'a pas à connaître le volume émis par les autres.
        isReseller ? Promise.resolve(0) : prisma.voucher.count(),
        isReseller ? Promise.resolve(0) : prisma.voucher.count({ where: { isRedeemed: true } }),
      ]);

      const clients = await prisma.vpnClient.findMany({
        select: { quotaTotal: true, quotaUsed: true },
        ...(Object.keys(clientStealthWhere).length ? { where: clientStealthWhere } : {}),
      });
      provisionedTrafficBytes = clients.reduce((acc, c) => acc + (c.quotaTotal || BigInt(0)), BigInt(0));
      consumedTrafficBytes = clients.reduce((acc, c) => acc + c.quotaUsed, BigInt(0));
    } else {
      activeAccounts = inMemoryDb.vpnClients.filter((c) => c.status === "active").length;
      expiredAccounts = inMemoryDb.vpnClients.filter((c) => c.status === "expired").length;
      provisionedTrafficBytes = inMemoryDb.vpnClients.reduce((acc, c) => acc + (c.quotaTotal || BigInt(0)), BigInt(0));
      consumedTrafficBytes = inMemoryDb.vpnClients.reduce((acc, c) => acc + c.quotaUsed, BigInt(0));
      activeServers = inMemoryDb.vpsServers.filter((s) => s.status === "online").length;
      activeResellers = inMemoryDb.resellers.filter((r) => r.status === "active").length;
    }

    const GB = 1024 * 1024 * 1024;
    const consumedTrafficGb = Number(consumedTrafficBytes) / GB;
    const provisionedTrafficGb = Number(provisionedTrafficBytes) / GB;

    // Connexions RÉELLES en cours — la seule valeur que la carte « CONNECTÉS »
    // ait le droit d'afficher. Elle dérive des signaux de santé mobile : le
    // tunnel est déclaré monté et le dernier signal date de moins de
    // `PRESENCE_WINDOW_MINUTES`. Elle est volontairement `null` — et non zéro —
    // quand la plateforme ne peut RIEN mesurer (pas de base, pas de secret de
    // pseudonymisation) : zéro affirmerait que personne n'est connecté, ce qui
    // serait une invention. L'interface affiche alors « non mesuré ».
    let connectedNow: number | null = null;
    const pseudonymSecret = config.MOBILE_HEALTH_PSEUDONYM_SECRET
      || (config.NODE_ENV !== "production" ? config.JWT_SECRET : null);
    if (prisma && pseudonymSecret) {
      try {
        connectedNow = await compterConnectes(prisma as any, pseudonymSecret, {
          porteeClients: isReseller ? (ownScope as Record<string, unknown>) : null,
          masquerProprietaire: !requesterIsOwner,
        });
      } catch (presenceError: any) {
        // Une présence indisponible ne doit pas priver l'exploitant de tous ses
        // autres indicateurs : on laisse `null` et on le dit dans la réponse.
        console.error("[dashboard] presence count failed:", presenceError?.message || presenceError);
      }
    }

    // Quota personnel du demandeur.
    //
    // Les cartes « Quota provisionné / consommé / restant » agrègent les
    // forfaits des CLIENTS ; elles ne décrivent aucune limite pesant sur le
    // compte connecté. Faute de le dire, un administrateur lisait ces 81 Go
    // comme un quota qui lui aurait été attribué. Administrateurs et
    // super-administrateurs n'en portent aucun : leur accès est illimité.
    let quotaPersonnel: { attribue: string; alloue: string; illimite: boolean } | null = null;
    let accesRevendeur: ReturnType<typeof resumerAccesRevendeur> | null = null;
    let statistiquesQuotaRevendeurs: StatistiquesQuotaRevendeurs | null = null;
    if (isReseller && prisma) {
      const fiche = ficheRevendeur ?? (await (prisma as any).reseller.findUnique({ where: { userId: req.user?.userId } }));
      if (fiche) {
        const plafond = BigInt(fiche.quotaBytes ?? 0);
        const { alloue, consomme } = await calculerAllocation(prisma, fiche);
        quotaPersonnel = {
          attribue: plafond.toString(),
          alloue: alloue.toString(),
          illimite: estIllimite(plafond),
        };
        statistiquesQuotaRevendeurs = creerStatistiquesQuotaRevendeurs("self", [
          { quotaBytes: plafond, alloue, consomme },
        ]);
        // Validité + plafond dans le même contrat que les refus : l'interface
        // affiche l'état sans avoir à provoquer une erreur pour le découvrir.
        accesRevendeur = resumerAccesRevendeur(fiche, alloue);
      }
    } else if (prisma && ROLES_QUOTA_REVENDEURS.has(req.user?.role || "")) {
      // L'administration voit les enveloppes attribuées aux REVENDEURS. Les
      // quotas des clients ne sont jamais additionnés ni présentés comme une
      // capacité de la plateforme ou du compte administrateur.
      const fiches = await (prisma as any).reseller.findMany({
        ...(resellerStealthWhere ? { where: resellerStealthWhere } : {}),
        include: { user: true },
      });
      const lignes = await Promise.all(
        fiches.map(async (fiche: any) => {
          const { alloue, consomme } = await calculerAllocation(prisma, fiche);
          return {
            quotaBytes: BigInt(fiche.quotaBytes ?? 0),
            alloue,
            consomme,
          };
        })
      );
      statistiquesQuotaRevendeurs = creerStatistiquesQuotaRevendeurs("platform", lignes);
    } else if (!prisma && ROLES_QUOTA_REVENDEURS.has(req.user?.role || "")) {
      statistiquesQuotaRevendeurs = creerStatistiquesQuotaRevendeurs(
        "platform",
        inMemoryDb.resellers.map((fiche: any) => ({
          quotaBytes: BigInt(fiche.quotaBytes ?? 0),
          alloue: BigInt(fiche.quotaUsedBytes ?? 0),
          consomme: BigInt(0),
        }))
      );
    }

    return res.json({
      // Comptes ouverts. Nommé pour ce qu'il est ; `activeUsers` n'est conservé
      // que pour ne rien casser chez les consommateurs existants de l'API et
      // vaut exactement la même chose.
      activeAccounts,
      activeUsers: activeAccounts,
      // Connexions réellement observées. `null` = non mesuré, jamais « zéro
      // connecté ». Le drapeau évite à l'interface d'avoir à deviner.
      connectedNow,
      connectedNowMeasured: connectedNow !== null,
      presenceWindowMinutes: PRESENCE_WINDOW_MINUTES,
      presenceHeartbeatMinutes: PRESENCE_HEARTBEAT_MINUTES,
      expiredAccounts,
      consumedTraffic: Math.round(consumedTrafficGb * 100) / 100,
      provisionedTraffic: Math.round(provisionedTrafficGb * 100) / 100,
      remainingTraffic: Math.max(0, Math.round((provisionedTrafficGb - consumedTrafficGb) * 100) / 100),
      consumedTrafficBytes: consumedTrafficBytes.toString(),
      provisionedTrafficBytes: provisionedTrafficBytes.toString(),
      // Portée des chiffres ci-dessus : « own » pour un revendeur (ses clients
      // seulement), « platform » pour l'administration (toute la plateforme).
      quotaScope: isReseller ? "own" : "platform",
      hasPersonalQuota: isReseller,
      personalQuota: quotaPersonnel,
      resellerAccess: accesRevendeur,
      // Contrat non ambigu utilisé par les trois cartes de quota : enveloppes
      // revendeurs uniquement, jamais une somme « provisionnée aux clients ».
      resellerQuota: statistiquesQuotaRevendeurs,
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
    // Le graphique portait sur TOUS les clients de la plateforme : un revendeur
    // y lisait le trafic cumulé de ses concurrents. Il ne doit voir que le sien.
    const isReseller = req.user?.role === "RESELLER";
    const clientStealthWhere = {
      ...stealthWhere(requesterIsOwner),
      ...(isReseller ? (porteeClientsRevendeur(await chargerFicheRevendeur(prisma, req.user?.userId)) as any) : {}),
    };
    if (prisma) {
      const clientIds = (await prisma.vpnClient.findMany({
        select: { id: true },
        ...(Object.keys(clientStealthWhere).length ? { where: clientStealthWhere } : {}),
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
    // Même cloisonnement que pour le trafic : la courbe comptait l'ensemble des
    // comptes de la plateforme, si bien qu'un revendeur sans aucun client voyait
    // malgré tout une courbe à 82.
    const isReseller = req.user?.role === "RESELLER";
    const clientStealthWhere = {
      ...stealthWhere(requesterIsOwner),
      ...(isReseller ? (porteeClientsRevendeur(await chargerFicheRevendeur(prisma, req.user?.userId)) as any) : {}),
    };
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

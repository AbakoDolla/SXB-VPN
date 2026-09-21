/**
 * Dashboard Routes — /api/dashboard
 * Statistiques réelles issues de la base PostgreSQL.
 * Graphiques basés sur les vraies dates de création/mise à jour.
 */
import { Router, Response } from "express";
import { prisma, inMemoryDb } from "../database";
import { config } from "../config";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";
import { FURTIVITE_OWNER_PORTEUR, isOwnerRequest } from "../middleware/rbac/owner";
import { calculerAllocation, estIllimite } from "../services/reseller-quota";
import {
  agregerQuotaClients,
  provenanceQuota,
  tauxUtilisation,
  SEUIL_FORFAIT_HORS_NORME,
  type LigneQuotaClient,
  type ProvenanceQuota,
  type TraficAgrege,
} from "../services/trafic-agrege";
import {
  compterConnectes,
  dernierSignalPresence,
  PRESENCE_HEARTBEAT_MINUTES,
  PRESENCE_WINDOW_MINUTES,
} from "../services/vpn-presence";
import {
  chargerFicheRevendeur,
  porteeClientsRevendeur,
  resumerAccesRevendeur,
} from "../services/reseller-access";
import {
  etFiltres,
  exclureIdentifiants,
  porteeEssaiDeploye,
} from "../services/free-trial-marks";
import { porteeBons, porteeClients, porteeRevendeurs, porteeServeurs } from "../services/portee-donnees";

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
  return FURTIVITE_OWNER_PORTEUR;
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
    // Le tableau de bord annonçait consumedTraffic 1479,48 Gio pour
    // provisionedTraffic 280 Gio. 100 % du consommé venait de fiches dont
    // `quotaTotal` vaut zéro, parce que le quota réellement vendu vit sur
    // `Subscription` et n'était pas lu : deux populations quasi disjointes.
    //
    // La sélection de la source ET l'agrégation vivent dans
    // services/trafic-agrege.ts, au même endroit que celle de
    // /api/analytics/traffic. Les réécrire ici laisserait les deux écrans
    // libres de diverger — c'est cette duplication qui avait rendu le premier
    // défaut possible.
    let agregatQuota: TraficAgrege | null = null;
    let provenance: ProvenanceQuota | null = null;
    let activeServers = 0;
    let essaisRetranchesVisibles = 0;
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
    // ── Les essais gratuits ne comptent PAS dans les indicateurs principaux ──
    //
    // Ce tableau de bord décrit l'activité COMMERCIALE. Un essai gratuit n'en
    // fait pas partie : il a ses propres compteurs dans « Essais gratuits », et
    // les additionner ici gonflait le nombre de comptes, le trafic et les
    // connexions avec des accès offerts. L'exploitant lisait donc une base de
    // clients et une consommation qui n'étaient pas les siennes.
    //
    // On retranche `clientsEssaiUniquement`, c'est-à-dire les comptes dont TOUT
    // l'accès vient d'un essai. Un essayeur devenu client payant reste compté :
    // c'est un vrai client, et le faire disparaître d'ici serait une seconde
    // erreur, symétrique de la première.
    //
    // `exploitable` vaut faux quand la fonctionnalité d'essai n'est pas déployée
    // sur cette base : rien n'est alors retranché, et les chiffres restent ceux
    // d'avant plutôt que de rétrécir sur un calcul qui n'a pas abouti.
    const porteeEssai = prisma ? await porteeEssaiDeploye(prisma) : null;
    const exclusionEssais = porteeEssai?.exploitable
      ? exclureIdentifiants("id", porteeEssai.clientsEssaiUniquement)
      : null;
    if (prisma) {
      // Compartiment du requérant : OWNER voit tout, SUPER_ADMIN tout sauf le
      // OWNER, ADMIN son seul parc, RESELLER ses seuls clients.
      const clientStealthWhere = etFiltres(
        await porteeClients(prisma, req.user),
        exclusionEssais,
      ) ?? {};
      // Compartiment du requérant, POUR CHAQUE FAMILLE D'OBJETS.
      //
      // Les comptages qui suivent excluaient le revendeur et personne d'autre :
      // un administrateur neuf lisait donc le nombre de serveurs, de revendeurs
      // et de bons de toute la maison. Un total est une fuite aussi sûrement
      // qu'une liste — il apprend l'existence et l'ampleur de ce qu'on cache.
      const porteeServeursRequerant = await porteeServeurs(prisma, req.user);
      const porteeRevendeursRequerant = await porteeRevendeurs(prisma, req.user);
      const porteeBonsRequerant = await porteeBons(prisma, req.user);
      // Combien des comptes d'essai retranchés étaient VISIBLES du requérant ?
      // C'est ce nombre, et lui seul, que l'écran peut annoncer sans trahir
      // l'ampleur du parc voisin.
      essaisRetranchesVisibles = porteeEssai?.exploitable && porteeEssai.clientsEssaiUniquement.length
        ? await prisma.vpnClient.count({
            where: {
              id: { in: porteeEssai.clientsEssaiUniquement },
              ...((await porteeClients(prisma, req.user)) ?? {}),
            },
          })
        : 0;
      [activeAccounts, expiredAccounts, activeServers, activeResellers, totalVouchers, redeemedVouchers] = await Promise.all([
        prisma.vpnClient.count({ where: { status: "active", ...clientStealthWhere } }),
        prisma.vpnClient.count({ where: { status: "expired", ...clientStealthWhere } }),
        // Le revendeur ne pilote aucun serveur : la valeur reste à zéro et la
        // carte correspondante est remplacée côté interface.
        isReseller ? Promise.resolve(0) : prisma.vPSServer.count({
          where: { status: "online", ...(porteeServeursRequerant ?? {}) },
        }),
        isReseller ? Promise.resolve(0) : prisma.reseller.count({
          where: { status: "active", ...resellerStealthWhere, ...(porteeRevendeursRequerant ?? {}) },
        }),
        // Les bons restent comptés dans le compartiment du requérant : un
        // revendeur n'a pas à connaître le volume émis par les autres, et un
        // administrateur pas davantage.
        isReseller ? Promise.resolve(0) : prisma.voucher.count({
          where: { ...(porteeBonsRequerant ?? {}) },
        }),
        isReseller ? Promise.resolve(0) : prisma.voucher.count({
          where: { isRedeemed: true, ...(porteeBonsRequerant ?? {}) },
        }),
      ]);

      const clients = await prisma.vpnClient.findMany({
        select: {
          status: true,
          expireAt: true,
          quotaTotal: true,
          quotaUsed: true,
          // Sans cette lecture, le provisionné ignore la quasi-totalité du
          // volume réellement vendu : 2 015 419 Gio vivent ici, pas sur la fiche.
          subscriptions: {
            select: { quotaBytes: true, quotaUsed: true, status: true, expireAt: true },
          },
        },
        ...(Object.keys(clientStealthWhere).length ? { where: clientStealthWhere } : {}),
      });
      const lignesQuota = clients as LigneQuotaClient[];
      agregatQuota = agregerQuotaClients(lignesQuota);
      provenance = provenanceQuota(lignesQuota);
      provisionedTrafficBytes = agregatQuota.provisionedBytes;
      consumedTrafficBytes = agregatQuota.consumedBytes;
    } else {
      activeAccounts = inMemoryDb.vpnClients.filter((c) => c.status === "active").length;
      expiredAccounts = inMemoryDb.vpnClients.filter((c) => c.status === "expired").length;
      const lignesQuota = inMemoryDb.vpnClients as unknown as LigneQuotaClient[];
      agregatQuota = agregerQuotaClients(lignesQuota);
      provenance = provenanceQuota(lignesQuota);
      provisionedTrafficBytes = agregatQuota.provisionedBytes;
      consumedTrafficBytes = agregatQuota.consumedBytes;
      activeServers = inMemoryDb.vpsServers.filter((s) => s.status === "online").length;
      activeResellers = inMemoryDb.resellers.filter((r) => r.status === "active").length;
    }

    // `agregatQuota.provisionedBytes` est déjà NET des forfaits hors norme :
    // le retranchement vit dans `agregerTrafic`, point unique partagé avec
    // /api/analytics/traffic. Le refaire ici le compterait deux fois.
    const provisionedTrafficBytesBrut = agregatQuota
      ? agregatQuota.provisionedBytesBrut
      : provisionedTrafficBytes;

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
    let connectedTrials: number | null = null;
    let dernierSignalAt: Date | null = null;
    const pseudonymSecret = config.MOBILE_HEALTH_PSEUDONYM_SECRET
      || (config.NODE_ENV !== "production" ? config.JWT_SECRET : null);
    if (prisma && pseudonymSecret) {
      try {
        const porteeCommune = await porteeClients(prisma, req.user);
        connectedNow = await compterConnectes(prisma as any, pseudonymSecret, {
          // Même règle que les compteurs ci-dessus : un essai gratuit connecté
          // n'est pas une connexion commerciale. Il est compté dans « Essais
          // gratuits », qui affiche ses propres connectés.
          porteeClients: etFiltres(porteeCommune, exclusionEssais) ?? null,
          masquerProprietaire: !requesterIsOwner,
        });
        // ── LES ESSAIS COMPTENT AUSSI, À CÔTÉ ─────────────────────────────
        //
        // Séparer les deux est juste : un essayeur n'est pas un client payant.
        // Mais n'afficher QUE le compte commercial rendait la carte muette sur
        // un parc surtout composé d'essais — trente-deux personnes connectées,
        // et un grand « 0 » à l'écran. L'exploitant devait ouvrir une autre
        // section pour découvrir qu'il avait du monde.
        //
        // Les deux nombres partent donc ensemble : la carte montre le total,
        // et dit ce qui est commercial et ce qui est essai. Rien n'est confondu,
        // et rien n'est caché.
        const total = await compterConnectes(prisma as any, pseudonymSecret, {
          porteeClients: porteeCommune ?? null,
          masquerProprietaire: !requesterIsOwner,
        });
        connectedTrials = Math.max(0, total - connectedNow);
      } catch (presenceError: any) {
        // Une présence indisponible ne doit pas priver l'exploitant de tous ses
        // autres indicateurs : on laisse `null` et on le dit dans la réponse.
        console.error("[dashboard] presence count failed:", presenceError?.message || presenceError);
      }
      // Date du dernier signal, tous appareils confondus. Elle distingue « zéro
      // connecté » de « plus rien n'arrive » : sans elle, un parc muet depuis
      // des jours se lit exactement comme un parc au repos.
      try {
        dernierSignalAt = await dernierSignalPresence(prisma as any);
      } catch {
        dernierSignalAt = null;
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
      const porteeRevendeursQuota = await porteeRevendeurs(prisma, req.user);
      const fiches = await (prisma as any).reseller.findMany({
        // Le compartiment du requérant s'ajoute à la furtivité : un
        // administrateur ne cumule QUE les enveloppes des revendeurs qu'il a
        // lui-même créés. Sans cela, il lisait 1,1 To attribués et 1,9 Po
        // engagés par la maison — mesuré en production avant correction.
        where: { ...(resellerStealthWhere ?? {}), ...(porteeRevendeursQuota ?? {}) },
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
      connectedTrials,
      connectedNowMeasured: connectedNow !== null,
      // Âge du dernier battement reçu. Il permet à l'écran de distinguer un
      // parc au repos d'un parc qui n'émet plus.
      lastPresenceSignalAt: dernierSignalAt ? dernierSignalAt.toISOString() : null,
      // Ces indicateurs portent sur l'activité COMMERCIALE seule : les comptes
      // dont tout l'accès vient d'un essai gratuit en sont retranchés, et ont
      // leurs propres compteurs dans « Essais gratuits ». Le drapeau permet à
      // l'écran de l'annoncer plutôt que de laisser croire à un total.
      freeTrialExcluded: Boolean(porteeEssai?.exploitable),
      // Le NOMBRE de comptes retranchés doit lui aussi rester dans le
      // compartiment du requérant : il annonçait 460 comptes d'essai à un
      // administrateur qui n'en gère aucun, ce qui lui apprenait l'ampleur du
      // parc qu'on lui cache. On ne compte donc que ceux qui étaient VISIBLES
      // pour lui avant le retranchement.
      freeTrialAccountsExcluded: essaisRetranchesVisibles,
      presenceWindowMinutes: PRESENCE_WINDOW_MINUTES,
      presenceHeartbeatMinutes: PRESENCE_HEARTBEAT_MINUTES,
      expiredAccounts,
      consumedTraffic: Math.round(consumedTrafficGb * 100) / 100,
      provisionedTraffic: Math.round(provisionedTrafficGb * 100) / 100,
      // `consumedTraffic` reste la consommation de TOUT le parc visible : rien
      // n'est escamoté. Mais on ne peut la retrancher du provisionné sans
      // retomber dans le défaut d'origine — elle inclut les accès sans plafond.
      // Le reste et le dépassement portent donc sur la part MESURÉE, seule
      // population que les deux grandeurs aient réellement en commun.
      meteredConsumedTraffic: agregatQuota
        ? Math.round((Number(agregatQuota.meteredConsumedBytes) / GB) * 100) / 100
        : 0,
      meteredClients: agregatQuota ? agregatQuota.meteredClients : 0,
      // Même fonction que /api/analytics/traffic : les deux écrans ne peuvent
      // plus annoncer deux taux différents sur les mêmes données.
      utilizationPercentage: agregatQuota ? tauxUtilisation(agregatQuota) : 0,
      // La borne à zéro reste : un reste négatif n'a pas de sens à l'affichage.
      // Mais elle ne doit plus être MUETTE — c'est son silence qui a permis à
      // l'incohérence de vivre sans être vue. Le dépassement est donc publié à
      // côté, et vaut zéro quand il n'y en a pas.
      remainingTraffic: agregatQuota
        ? Math.max(
            0,
            Math.round(
              (provisionedTrafficGb - Number(agregatQuota.meteredConsumedBytes) / GB) * 100,
            ) / 100,
          )
        : 0,
      // Comparé à la part ORDINAIRE, pas au total brut : tant que les 2 Po des
      // forfaits hors norme entraient dans la comparaison, aucun dépassement ne
      // pouvait se déclencher — le signal était mort sans être absent.
      trafficOverage: agregatQuota
        ? agregatQuota.meteredConsumedBytes > provisionedTrafficBytes
        : false,
      trafficOverageBytes: (agregatQuota
        && agregatQuota.meteredConsumedBytes > provisionedTrafficBytes
        ? agregatQuota.meteredConsumedBytes - provisionedTrafficBytes
        : BigInt(0)
      ).toString(),
      consumedTrafficBytes: consumedTrafficBytes.toString(),
      provisionedTrafficBytes: provisionedTrafficBytes.toString(),
      meteredConsumedTrafficBytes: agregatQuota
        ? agregatQuota.meteredConsumedBytes.toString()
        : "0",
      // Provenance des deux grandeurs. Publiée pour qu'une dérive redevienne
      // visible : si `fromClientRecord` enflait alors que le parc est vendu par
      // forfaits, le rapport recommencerait à perdre son sens, en silence.
      quotaSource: provenance
        ? {
            fromSubscriptions: provenance.fromSubscriptions,
            fromClientRecord: provenance.fromClientRecord,
            // Forfaits hors norme (≥ 1 Tio) : RETRANCHÉS du chiffre principal
            // depuis la mesure du 21/09 — 40 forfaits portant chacun ~49 Tio
            // faisaient afficher « 2 015 158,96 Gio restants » pour un parc qui
            // en provisionne 4 251. Rien n'est escamoté : leur nombre, leur
            // volume, le seuil et le total brut sont publiés ici.
            //
            // `outsizedExcluded` existe pour que l'écran l'ANNONCE, sur le même
            // modèle que `freeTrialExcluded`. Sans lui, un revendeur dont
            // l'unique forfait est hors norme lirait « 0 provisionné » sans
            // savoir pourquoi — un chiffre muet à la place d'un chiffre faux,
            // c'est le même défaut un cran plus bas.
            outsizedExcluded: provenance.outsizedPlans > 0,
            outsizedPlans: provenance.outsizedPlans,
            outsizedBytes: provenance.outsizedBytes.toString(),
            outsizedThresholdBytes: SEUIL_FORFAIT_HORS_NORME.toString(),
            // Déjà net du retranchement : `provisionedTrafficBytes` EST la part
            // ordinaire. Le soustraire une seconde fois compterait deux fois.
            ordinaryProvisionedBytes: provisionedTrafficBytes.toString(),
            // Le total d'origine, pour que le chiffre retiré reste consultable.
            totalWithOutsizedBytes: provisionedTrafficBytesBrut.toString(),
          }
        : null,
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
    // y lisait le trafic cumulé de ses concurrents. Il ne doit voir que le sien,
    // et un administrateur que celui de son propre parc.
    const isReseller = req.user?.role === "RESELLER";
    const clientStealthWhere = (await porteeClients(prisma, req.user)) ?? {};
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
    const clientStealthWhere = (await porteeClients(prisma, req.user)) ?? {};
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

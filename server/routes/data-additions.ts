/**
 * « Données ajoutées » — lecture de l'historique des Go ajoutés, par serveur.
 *
 *   GET /api/data-additions                  → historique, du plus récent au plus ancien
 *   GET /api/data-additions/servers          → un résumé par serveur (configuration VPN)
 *   GET /api/data-additions/servers/:id      → le détail d'un serveur et tout son historique
 *
 * L'écriture n'a pas de route : elle se fait d'elle-même, dans la transaction de
 * chaque ajout de Go (voir `services/data-additions.ts`).
 *
 * PORTÉE : exactement celle de « Forfaits Data ». Un revendeur ne lit que les
 * ajouts faits aux connexions de SES clients, un administrateur ceux de son
 * compartiment ; le propriétaire lit tout, y compris l'historique de clients
 * supprimés depuis — c'est précisément ce qu'un historique doit conserver.
 *
 * ESSAIS GRATUITS : tenus dehors, sans option pour les réintégrer, comme dans
 * tous les écrans commerciaux. Ils restent consignés en base.
 */
import { Router, Response } from "express";
import { z } from "zod";
import { prisma } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";
import { porteeClients, porteeClientsForfait } from "../services/portee-donnees";
import { etFiltres, exclureIdentifiants, porteeEssaiDeploye } from "../services/free-trial-marks";
import { serialiserAjout, versOctets } from "../services/data-additions";

const router = Router();

const identifiant = z.string().trim().min(1).max(100);
const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().datetime({ offset: true }).optional(),
  beforeId: identifiant.optional(),
  profileId: identifiant.optional(),
});

type Portees = {
  ajouts: Record<string, unknown> | undefined;
  forfaits: Record<string, unknown> | undefined;
};

/**
 * Filtres de lecture du demandeur, pour l'historique ET pour les forfaits
 * dont on calcule le consommé. Les deux partent de la même règle, sinon le
 * « restant » d'un serveur mêlerait des forfaits qu'on n'a pas le droit de voir.
 */
async function portees(req: AuthenticatedRequest): Promise<Portees> {
  const essai = await porteeEssaiDeploye(prisma);
  const clients = await porteeClients(prisma, req.user);
  let ajouts: Record<string, unknown> | null = null;
  if (clients) {
    const visibles = await (prisma as any).vpnClient.findMany({ where: clients, select: { id: true } });
    ajouts = { clientId: { in: (visibles as Array<{ id: string }>).map(c => c.id) } };
  }
  return {
    ajouts: etFiltres(ajouts, { freeTrial: false }, exclureIdentifiants("subscriptionId", essai.subscriptionIds)),
    forfaits: etFiltres(await porteeClientsForfait(prisma, req.user), exclureIdentifiants("id", essai.subscriptionIds)),
  };
}

type ResumeServeur = {
  profileId: string;
  profileName: string;
  additions: number;
  addedBytes: bigint;
  lastAddedAt: Date | null;
  subscriptions: number;
  usedBytes: bigint;
  remainingBytes: bigint;
  unlimited: boolean;
};

/**
 * Un résumé par serveur : ce qui a été ajouté (l'historique) et ce qui est
 * consommé / restant sur ses forfaits ACTUELS (la réalité du moment).
 */
async function resumerServeurs(p: Portees, profileId?: string): Promise<ResumeServeur[]> {
  const serveurs = new Map<string, ResumeServeur>();
  const serveur = (id: string, nom: string) => {
    let courant = serveurs.get(id);
    if (!courant) {
      courant = {
        profileId: id, profileName: nom, additions: 0, addedBytes: BigInt(0), lastAddedAt: null,
        subscriptions: 0, usedBytes: BigInt(0), remainingBytes: BigInt(0), unlimited: false,
      };
      serveurs.set(id, courant);
    }
    return courant;
  };

  const groupes = await (prisma as any).dataAddition.groupBy({
    by: ["profileId", "profileName"],
    where: etFiltres(p.ajouts, profileId ? { profileId } : null),
    _sum: { addedBytes: true },
    _count: { _all: true },
    _max: { createdAt: true },
  });
  for (const groupe of groupes as any[]) {
    const courant = serveur(String(groupe.profileId), String(groupe.profileName ?? ""));
    const dernier = groupe._max?.createdAt ? new Date(groupe._max.createdAt) : null;
    // Un serveur renommé forme deux groupes : on additionne, et le nom le plus
    // récent l'emporte.
    if (dernier && (!courant.lastAddedAt || dernier > courant.lastAddedAt)) {
      courant.lastAddedAt = dernier;
      if (groupe.profileName) courant.profileName = String(groupe.profileName);
    }
    courant.additions += Number(groupe._count?._all ?? 0);
    courant.addedBytes += versOctets(groupe._sum?.addedBytes);
  }

  const forfaits = await (prisma as any).subscription.findMany({
    where: etFiltres(p.forfaits, profileId ? { profileId } : null),
    select: { profileId: true, quotaBytes: true, quotaUsed: true, profile: { select: { name: true } } },
  });
  for (const forfait of forfaits as any[]) {
    const courant = serveur(String(forfait.profileId), String(forfait.profile?.name ?? ""));
    // Le nom VIVANT de la configuration prime sur l'instantané de l'historique.
    if (forfait.profile?.name) courant.profileName = String(forfait.profile.name);
    const quota = versOctets(forfait.quotaBytes);
    const utilise = versOctets(forfait.quotaUsed);
    courant.subscriptions += 1;
    courant.usedBytes += utilise;
    if (quota < BigInt(0)) courant.unlimited = true;
    else if (quota > utilise) courant.remainingBytes += quota - utilise;
  }

  return [...serveurs.values()].sort((a, b) =>
    (b.lastAddedAt?.getTime() ?? 0) - (a.lastAddedAt?.getTime() ?? 0) ||
    a.profileName.localeCompare(b.profileName, "fr", { sensitivity: "base", numeric: true }));
}

function serialiserServeur(s: ResumeServeur) {
  return {
    profileId: s.profileId,
    profileName: s.profileName,
    additions: s.additions,
    addedBytes: s.addedBytes.toString(),
    lastAddedAt: s.lastAddedAt ? s.lastAddedAt.toISOString() : null,
    subscriptions: s.subscriptions,
    usedBytes: s.usedBytes.toString(),
    remainingBytes: s.remainingBytes.toString(),
    unlimited: s.unlimited,
  };
}

/** Une page d'historique, avec son curseur : un historique ne se tronque pas en silence. */
async function page(p: Portees, requete: z.infer<typeof pageSchema>) {
  const curseur = requete.before
    ? requete.beforeId
      ? { OR: [
          { createdAt: { lt: new Date(requete.before) } },
          { createdAt: new Date(requete.before), id: { lt: requete.beforeId } },
        ] }
      : { createdAt: { lt: new Date(requete.before) } }
    : null;
  const lignes = await (prisma as any).dataAddition.findMany({
    where: etFiltres(p.ajouts, requete.profileId ? { profileId: requete.profileId } : null, curseur),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: requete.limit + 1,
  });
  const visibles = (lignes as any[]).slice(0, requete.limit);
  const dernier = visibles[visibles.length - 1];
  return {
    additions: visibles.map(serialiserAjout),
    next: lignes.length > requete.limit && dernier
      ? { before: new Date(dernier.createdAt).toISOString(), beforeId: String(dernier.id) }
      : null,
  };
}

function refusValidation(res: Response, err: unknown) {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: "errors.validation", details: err.issues });
    return true;
  }
  return false;
}

router.get("/", requireAuth, requirePermission("subscription.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const requete = pageSchema.parse(req.query);
    if (!prisma) return res.json({ success: true, additions: [], totals: { count: 0, addedBytes: "0" }, next: null });
    const p = await portees(req);
    const filtre = etFiltres(p.ajouts, requete.profileId ? { profileId: requete.profileId } : null);
    const [contenu, count, somme] = await Promise.all([
      page(p, requete),
      (prisma as any).dataAddition.count({ where: filtre }),
      (prisma as any).dataAddition.aggregate({ where: filtre, _sum: { addedBytes: true } }),
    ]);
    return res.json({
      success: true,
      ...contenu,
      totals: { count: Number(count), addedBytes: versOctets(somme?._sum?.addedBytes).toString() },
    });
  } catch (err) {
    if (refusValidation(res, err)) return;
    console.error("data additions list error:", err);
    return res.status(500).json({ error: "errors.server", message: "Historique des données ajoutées indisponible" });
  }
});

router.get("/servers", requireAuth, requirePermission("subscription.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.json({ success: true, servers: [] });
    const serveurs = await resumerServeurs(await portees(req));
    return res.json({ success: true, servers: serveurs.map(serialiserServeur) });
  } catch (err) {
    console.error("data additions servers error:", err);
    return res.status(500).json({ error: "errors.server", message: "Résumé par serveur indisponible" });
  }
});

router.get("/servers/:profileId", requireAuth, requirePermission("subscription.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const profileId = identifiant.parse(req.params.profileId);
    const requete = pageSchema.parse({ ...req.query, profileId });
    if (!prisma) return res.status(404).json({ error: "errors.data_additions.not_found", message: "Serveur introuvable" });
    const p = await portees(req);
    const [serveur] = await resumerServeurs(p, profileId);
    // 404 et non 403 : ne pas confirmer l'existence d'un serveur hors portée.
    if (!serveur) return res.status(404).json({ error: "errors.data_additions.not_found", message: "Serveur introuvable" });
    const contenu = await page(p, requete);
    return res.json({ success: true, server: serialiserServeur(serveur), ...contenu });
  } catch (err) {
    if (refusValidation(res, err)) return;
    console.error("data additions server error:", err);
    return res.status(500).json({ error: "errors.server", message: "Historique du serveur indisponible" });
  }
});

export default router;

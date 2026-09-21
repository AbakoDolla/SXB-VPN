import { Router, Response } from "express";
import { z } from "zod";
import { prisma, inMemoryDb, logDbActivity } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";
import { encrypt, decrypt } from "../utils/crypto";
import { auteurAInscrire, porteeServeurs, voitTout } from "../services/portee-donnees";
import { interdireMutationSupport } from "../services/reseller-access";

const router = Router();

// ═══════════════════════════════════════════════════════════════════════════
// PORTÉE SUR LES ROUTES À IDENTIFIANT — MESURÉ EN PRODUCTION
// ═══════════════════════════════════════════════════════════════════════════
// `GET /api/servers` était bien cloisonné, mais AUCUNE route prenant un
// identifiant ne rejouait ce filtre : elles ne vérifiaient que le rôle, et
// ADMIN y est admis. Mesure en production avec un administrateur créé à
// l'instant, sur un serveur absent de SA liste :
//
//   GET    /api/servers/:id/config  → 200  (configuration déchiffrée)
//   PATCH  /api/servers/:id         → 200  (modification effective)
//
// La lecture de configuration n'a rien rendu ce jour-là — aucun serveur ne
// stocke encore d'identifiants. La fuite était donc LATENTE ; la modification,
// elle, était bien réelle : un administrateur modifiait l'infrastructure d'un
// autre. On ferme les deux, car le jour où une configuration est enregistrée,
// ce sont des identifiants SSH en clair qui sortent.
//
// 404 et non 403 : répondre « interdit » confirmerait l'existence du serveur
// et permettrait d'énumérer le parc identifiant par identifiant. Hors de son
// compartiment, un serveur n'existe pas.
async function chargerServeurVisible(
  req: AuthenticatedRequest,
  id: string,
): Promise<any | null> {
  if (prisma) {
    const portee = await porteeServeurs(prisma, req.user);
    return prisma.vPSServer.findFirst({
      where: portee ? ({ AND: [{ id }, portee] } as any) : { id },
    });
  }

  // Base en mémoire (secours de développement) : on rejoue la même règle que
  // `porteeParAuteur`, sans quoi les deux branches divergeraient.
  const serveur = inMemoryDb.vpsServers.find((s) => s.id === id);
  if (!serveur) return null;
  if (voitTout(req.user?.role)) return serveur;
  if (String(req.user?.role) === "ADMIN") {
    return serveur.createdBy === (req.user?.userId ?? null) ? serveur : null;
  }
  return serveur;
}

const SERVEUR_INTROUVABLE = { error: "errors.servers.not_found", message: "Server node not found" };

const createServerSchema = z.object({
  name: z.string().min(2),
  ip: z.string().regex(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/, "Invalid IP address"),
  location: z.string().min(2),
  status: z.enum(["online", "offline"]).default("online"),
});

const updateServerSchema = z.object({
  name: z.string().min(2).optional(),
  ip: z.string().regex(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/, "Invalid IP address").optional(),
  location: z.string().min(2).optional(),
  status: z.enum(["online", "offline"]).optional(),
});

const saveConfigSchema = z.object({
  type: z.enum(["ssh"]),
  configurationRaw: z.string().min(1),
});

// GET /api/servers
router.get("/", requireAuth, requirePermission("server.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    let servers: any[] = [];
    if (prisma) {
      // Un administrateur ne voit que les serveurs QU'IL A CRÉÉS. Sans ce
      // filtre, un compte créé à l'instant recevait l'infrastructure entière —
      // noms et adresses IP comprises. Mesuré en production avant correction.
      const portee = await porteeServeurs(prisma, req.user);
      servers = await prisma.vPSServer.findMany({
        ...(portee ? { where: portee as any } : {}),
        orderBy: { createdAt: "desc" },
      });
    } else {
      servers = inMemoryDb.vpsServers;
    }
    return res.json(servers);
  } catch (err) {
    console.error("Fetch servers error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch servers" });
  }
});

// POST /api/servers
//
// ═══════════════════════════════════════════════════════════════════════════
// PLAFOND DE RÔLE — MESURÉ EN PRODUCTION, PAS SUPPOSÉ
// ═══════════════════════════════════════════════════════════════════════════
// Ce domaine ne dépendait que de la permission `server.manage`. Or le rôle
// SUPPORT la porte en production, comme `servers.create` et `servers.delete`.
// Un compte SUPPORT de test a donc réellement CRÉÉ, MODIFIÉ puis SUPPRIMÉ un
// serveur — supprimer un serveur coupe le service de tous ses clients.
//
// Les autres domaines (revendeurs, bons, essais, comptes) posaient déjà ce
// plafond ; celui-ci avait été oublié. La règle est la même, écrite une seule
// fois dans `reseller-access` : une permission mal cochée ne doit jamais
// suffire à rouvrir une surface fermée par le rôle.
router.post("/", requireAuth, interdireMutationSupport(), requirePermission("server.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = createServerSchema.parse(req.body);

    let newServer: any = null;
    if (prisma) {
      newServer = await prisma.vPSServer.create({
        // Estampille d'auteur : c'est elle qui rendra ce serveur à son
        // créateur, et à lui seul, dans un tableau de bord cloisonné.
        data: { ...body, createdBy: auteurAInscrire(req.user) },
      });
    } else {
      newServer = {
        id: `server-${Date.now()}`,
        ...body,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      inMemoryDb.vpsServers.push(newServer);
    }

    await logDbActivity(req.user?.userId || null, `Registered new VPN node: ${body.name} (${body.ip})`, "success", req.ip);
    return res.status(201).json(newServer);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    console.error("Create server error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to create server" });
  }
});

// PATCH /api/servers/:id
router.patch("/:id", requireAuth, interdireMutationSupport(), requirePermission("server.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const body = updateServerSchema.parse(req.body);

    // Hors de son compartiment, le serveur n'existe pas : 404 indifférencié.
    if (!(await chargerServeurVisible(req, id))) {
      return res.status(404).json(SERVEUR_INTROUVABLE);
    }

    let updated: any = null;
    if (prisma) {
      updated = await prisma.vPSServer.update({
        where: { id },
        data: { ...body, updatedAt: new Date() },
      });
    } else {
      const index = inMemoryDb.vpsServers.findIndex((s) => s.id === id);
      const old = inMemoryDb.vpsServers[index];
      updated = { ...old, ...body, updatedAt: new Date() };
      inMemoryDb.vpsServers[index] = updated;
    }

    await logDbActivity(req.user?.userId || null, `Updated VPN server configuration (ID: ${id})`, "info", req.ip);
    return res.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    console.error("Update server error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to update server" });
  }
});

// POST /api/servers/:id/config
// Securely store encrypted server configuration credentials
router.post("/:id/config", requireAuth, interdireMutationSupport(), requirePermission("server.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const body = saveConfigSchema.parse(req.body);

    // Écrire des identifiants sur le serveur d'autrui était possible : la
    // route n'exigeait même pas que le serveur existe.
    if (!(await chargerServeurVisible(req, id))) {
      return res.status(404).json(SERVEUR_INTROUVABLE);
    }

    // Chiffrer les configurations (encrypt raw configurations)
    const configurationEncrypted = encrypt(body.configurationRaw);

    let configRecord: any = null;
    if (prisma) {
      configRecord = await prisma.serverConfig.create({
        data: {
          serverId: id,
          type: body.type,
          configurationEncrypted,
        },
      });
    } else {
      configRecord = {
        id: `config-${Date.now()}`,
        serverId: id,
        type: body.type,
        configurationEncrypted,
        createdAt: new Date(),
      };
      inMemoryDb.serverConfigs.push(configRecord);
    }

    await logDbActivity(req.user?.userId || null, `Securely saved and encrypted config for Server: ${id} (${body.type})`, "success", req.ip);

    return res.status(201).json({
      success: true,
      message: "Configuration credentials encrypted and saved securely",
      configId: configRecord.id,
      type: configRecord.type,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    console.error("Store encrypted config error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to securely save server config" });
  }
});

// GET /api/servers/:id/config
// Retrieve and decrypt configuration (STRICTLY ADMIN ONLY)
router.get("/:id/config", requireAuth, requirePermission("server.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    
    // Couche supplémentaire : les clés de déchiffrement ne sortent que pour
    // l'exploitation. La permission ne suffit pas — SUPPORT porte
    // `server.manage` en production et n'a rien à faire ici.
    //
    // Le test portait `role !== "ADMIN"`, ce qui fermait aussi la porte à
    // SUPER_ADMIN et à OWNER : le propriétaire était exclu de SES PROPRES
    // identifiants, alors qu'un rôle inférieur y accédait. Vérifié en
    // production — un SUPER_ADMIN recevait 403 sur ses propres serveurs.
    const ROLES_IDENTIFIANTS = ["OWNER", "SUPER_ADMIN", "ADMIN"];
    if (!ROLES_IDENTIFIANTS.includes(String(req.user?.role))) {
      return res.status(403).json({ error: "errors.auth.forbidden_credentials", message: "Decryption keys can only be retrieved by Admin accounts" });
    }

    // Le rôle ne suffit pas : ADMIN y est admis, et il ne doit lire que les
    // identifiants de SES serveurs. 404 pour ne pas confirmer l'existence.
    if (!(await chargerServeurVisible(req, id))) {
      return res.status(404).json(SERVEUR_INTROUVABLE);
    }

    let configRecords: any[] = [];
    if (prisma) {
      configRecords = await prisma.serverConfig.findMany({ where: { serverId: id } });
    } else {
      configRecords = inMemoryDb.serverConfigs.filter((c) => c.serverId === id);
    }

    const decrypted = configRecords.map((c) => {
      let configurationRaw = "[Decryption Failed]";
      try {
        configurationRaw = decrypt(c.configurationEncrypted);
      } catch {}
      return {
        id: c.id,
        type: c.type,
        configurationRaw,
        createdAt: c.createdAt,
      };
    });

    return res.json(decrypted);
  } catch (err) {
    console.error("Retrieve encrypted config error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to retrieve configurations" });
  }
});

// DELETE /api/servers/:id
router.delete("/:id", requireAuth, interdireMutationSupport(), requirePermission("server.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    let exists = false;
    let serverName = "";
    // Supprimer un serveur coupe le service de tous ses clients : cette route
    // ne rejouait aucune portée. Un administrateur pouvait détruire le nœud
    // d'un autre. NON MESURÉE EN PRODUCTION — on ne joue pas une suppression
    // réelle pour la démontrer ; l'absence de filtre suffit à la corriger.
    const serveur = await chargerServeurVisible(req, id);
    if (prisma) {
      exists = !!serveur;
      serverName = serveur?.name || "";
      if (exists) await prisma.vPSServer.delete({ where: { id } });
    } else {
      const index = serveur ? inMemoryDb.vpsServers.findIndex((s) => s.id === id) : -1;
      exists = index !== -1;
      if (exists) {
        serverName = inMemoryDb.vpsServers[index].name;
        inMemoryDb.vpsServers.splice(index, 1);
      }
    }
    if (!exists) {
      return res.status(404).json(SERVEUR_INTROUVABLE);
    }
    await logDbActivity(req.user?.userId || null, `Removed VPN node: ${serverName} (ID: ${id})`, "danger", req.ip);
    return res.json({ message: "Server node removed successfully" });
  } catch (err) {
    console.error("Delete server error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to delete server" });
  }
});

export default router;

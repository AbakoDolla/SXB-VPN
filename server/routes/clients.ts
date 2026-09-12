import { Router, Response } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma, inMemoryDb, logDbActivity } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";
import { canSeeUser, isOwnerRequest } from "../middleware/rbac/owner";
import { executerMutationQuota, PlafondQuotaDepasse } from "../services/reseller-quota";
import {
  dissocierAccesClient,
  synchroniserEtatAccesClient,
} from "../services/client-access-state";
import { makeUserToken, renewedDeviceExpiry } from "../services/device-token";
import { marquesEssaiParClient, etFiltres, exclureIdentifiants, inclutEssaisGratuits, porteeEssaiDeploye } from "../services/free-trial-marks";
import { assertResumeAllowed, deviceAccessFailure, MobileAccessError } from "../services/access-lifecycle";
import { accessStateHub } from "../services/access-state-events";
import {
  chargerFicheRevendeur,
  estRoleSuperieur,
  exigerAccesRevendeur,
  interdireMutationSupport,
  porteeClientsRevendeur,
  possedeClient,
  refusPourEtatAcces,
  refusPropriete,
  refusSiPlafondAtteint,
  reponsePlafondDepasse,
  resumerAccesRevendeur,
} from "../services/reseller-access";

const router = Router();

/**
 * Contrôle de propriété commun à toutes les mutations sur un client.
 * Renvoie le refus à émettre, ou null si le demandeur est légitime.
 */
async function refusSiClientNonPossede(req: AuthenticatedRequest, client: any) {
  if (req.user?.role !== "RESELLER") return null;
  const fiche = (req as any).reseller ?? (await chargerFicheRevendeur(prisma, req.user.userId));
  if (possedeClient(client, fiche)) return null;
  return refusPropriete();
}

// Zod Schema validations
const createClientSchema = z.object({
  userId: z.string().optional(), // Optional for RESELLER (will use their own ID)
  name: z.string().min(2),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  quotaTotalGb: z.coerce.number().int().min(1).max(1_000_000).optional(),
  durationDays: z.coerce.number().int().min(1).max(3650).optional(),
  deviceLimit: z.coerce.number().int().min(1).max(100).default(1),
  deviceId: z.string().optional(),
  // Rattachement commercial explicite, réservé aux rôles supérieurs.
  resellerId: z.string().optional(),
});

const updateClientSchema = z.object({
  name: z.string().min(2).optional(),
  quotaTotalGb: z.coerce.number().int().min(1).max(1_000_000).optional(),
  deviceLimit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(["active", "suspended", "disabled", "expired", "revoked"]).optional(),
});
const renewClientSchema = z.object({
  durationDays: z.coerce.number().int().min(1).max(3650).default(30),
}).strict();

// Helper to convert BigInt to string for client-safe JSON parsing
// Also removes sensitive data like passwordHash
function sanitizeVpnClient(client: any, trial?: unknown) {
  if (!client) return null;
  
  // Remove passwordHash from user object if present
  let user = client.user;
  if (user && user.passwordHash) {
    user = { ...user };
    delete user.passwordHash;
  }

  // Identité du revendeur propriétaire, exposée à tous les rôles qui lisent la
  // fiche : sans elle, impossible de dire de qui relève un client.
  let reseller = client.reseller ?? null;
  if (reseller) {
    reseller = {
      id: reseller.id,
      name: reseller.user?.name ?? null,
      email: reseller.user?.email ?? null,
      status: reseller.status ?? null,
      accessExpiresAt: reseller.accessExpiresAt ?? null,
    };
  }

  return {
    ...client,
    user,
    reseller,
    resellerId: client.resellerId ?? reseller?.id ?? null,
    resellerName: reseller?.name ?? null,
    // Mention « période d'essai » : renseignée uniquement pour un accès issu
    // d'un essai gratuit déployé, `null` partout ailleurs.
    trial: trial ?? null,
    quotaTotal: client.quotaTotal ? client.quotaTotal.toString() : "0",
    quotaUsed: client.quotaUsed ? client.quotaUsed.toString() : "0",
  };
}

// GET /api/clients
//
// SÉPARATION DES ESSAIS : `includeFreeTrial=false` retranche les comptes dont
// TOUT l'accès vient d'un essai gratuit — jamais ceux qui possèdent aussi un
// forfait ordinaire, qui sont des clients comme les autres. Le retranchement
// est fait par la requête, donc les compteurs de l'écran comptent exactement ce
// qu'il affiche.
router.get("/", requireAuth, requirePermission("clients.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    let clients: any[] = [];
    const isReseller = req.user?.role === "RESELLER";
    const avecEssais = inclutEssaisGratuits(req.query.includeFreeTrial);

    if (prisma) {
      const fiche = isReseller ? await chargerFicheRevendeur(prisma, req.user?.userId) : null;
      const portee = avecEssais ? null : await porteeEssaiDeploye(prisma);
      clients = await prisma.vpnClient.findMany({
        // Le cloisonnement revendeur reste la première condition et n'est
        // jamais élargi : le filtre d'essai ne fait que retrancher.
        where: etFiltres(
          isReseller ? (porteeClientsRevendeur(fiche) as any) : null,
          portee ? exclureIdentifiants("id", portee.clientsEssaiUniquement) : null,
        ) as any,
        include: {
          user: { include: { role: true } },
          // Jointure unique : l'étiquette revendeur sans requête par ligne.
          reseller: { include: { user: { select: { id: true, name: true, email: true } } } },
        },
        orderBy: { createdAt: "desc" },
      });
    } else {
      clients = inMemoryDb.vpnClients.map((client) => {
        const u = inMemoryDb.users.find((user) => user.id === client.userId);
        return { ...client, user: u };
      });
      if (isReseller) {
        const fiche = await chargerFicheRevendeur(null, req.user?.userId);
        clients = clients.filter((c) => possedeClient(c, fiche));
      }
    }

    // Stealth : les clients rattachés à un compte OWNER sont invisibles
    // pour les non-OWNER (filtrage à la lecture uniquement).
    const visibleClients = clients.filter((c) => canSeeUser(req, c.user));

    // Mention « période d'essai » + pays déclaré. Calculée APRÈS le filtrage,
    // donc jamais pour un client que l'appelant n'a pas le droit de voir.
    const marquesEssai = await marquesEssaiParClient(prisma, visibleClients.map((c) => c.id));

    return res.json(visibleClients.map((c) => sanitizeVpnClient(c, marquesEssai.get(c.id) ?? null)));
  } catch (err) {
    console.error("Fetch VPN clients error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch VPN clients" });
  }
});

// GET /api/clients/:id
router.get("/:id", requireAuth, requirePermission("clients.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    let client: any = null;

    if (prisma) {
      client = await prisma.vpnClient.findUnique({
        where: { id },
        include: {
          user: { include: { role: true } },
          reseller: { include: { user: { select: { id: true, name: true, email: true } } } },
        },
      });
    } else {
      const c = inMemoryDb.vpnClients.find((cli) => cli.id === id);
      if (c) {
        const u = inMemoryDb.users.find((user) => user.id === c.userId);
        client = { ...c, user: u };
      }
    }

    if (!client) {
      return res.status(404).json({ error: "errors.clients.not_found", message: "VPN client not found" });
    }

    // Cloisonnement revendeur : la propriété fait foi, pas le compte porteur.
    const refusLecture = await refusSiClientNonPossede(req, client);
    if (refusLecture) {
      return res.status(refusLecture.status).json(refusLecture.body);
    }

    // Garde hiérarchique : client d'un compte OWNER invisible pour les non-OWNER.
    if (!canSeeUser(req, client.user)) {
      return res.status(404).json({ error: "errors.clients.not_found", message: "VPN client not found" });
    }

    return res.json(sanitizeVpnClient(client));
  } catch (err) {
    console.error("Fetch VPN client error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch VPN client" });
  }
});

// POST /api/clients
//
// Crée UNIQUEMENT un compte client. Aucun forfait, aucun profil VPN, aucun
// plan n'est attribué au passage : un client sans plan est un état légitime,
// et l'attribution reste une action explicite (POST /api/subscriptions).
router.post(
  "/",
  requireAuth,
  interdireMutationSupport(),
  requirePermission("clients.create"),
  exigerAccesRevendeur(),
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = createClientSchema.parse(req.body);

    // La propriété commerciale est portée par `resellerId`. Le compte
    // utilisateur du client reste un CLIENT distinct : partager le User du
    // revendeur ferait hériter au JWT mobile ses permissions dashboard et
    // rendrait plusieurs appareils indiscernables par `userId`.
    let targetUserId = body.userId;
    let creationUtilisateur: {
      name: string;
      email: string;
      phone: string | null;
      passwordHash: string;
      roleId: string;
    } | null = null;
    let fiche: any = null;
    if (req.user?.role === "RESELLER") {
      targetUserId = undefined;
      fiche = (req as any).reseller ?? (await chargerFicheRevendeur(prisma, req.user.userId));
      if (body.resellerId && fiche?.id && body.resellerId !== fiche.id) {
        const refus = refusPropriete();
        return res.status(refus.status).json(refus.body);
      }
    } else if (body.resellerId) {
      if (!estRoleSuperieur(req.user?.role)) {
        const refus = refusPropriete();
        return res.status(refus.status).json(refus.body);
      }
      if (prisma) {
        fiche = await (prisma as any).reseller.findUnique({
          where: { id: body.resellerId },
          include: { user: true },
        });
        if (!fiche) {
          return res.status(404).json({ error: "errors.resellers.not_found", message: "Revendeur introuvable" });
        }
      }
    }

    if (fiche) {
      const refusAcces = refusPourEtatAcces(resumerAccesRevendeur(fiche));
      if (refusAcces) return res.status(refusAcces.status).json(refusAcces.body);
      const plafond = await refusSiPlafondAtteint(prisma, {
        role: "RESELLER",
        userId: fiche.userId,
        fiche,
      });
      if (plafond) return res.status(plafond.status).json(plafond.body);
    }

    if (targetUserId && prisma) {
      const cible = await prisma.user.findUnique({
        where: { id: targetUserId },
        include: { role: true, vpnClients: { select: { id: true }, take: 1 } },
      });
      if (!cible) {
        return res.status(404).json({ error: "errors.users.not_found", message: "Utilisateur introuvable" });
      }
      if (cible.role?.name !== "CLIENT" || cible.vpnClients.length > 0) {
        return res.status(409).json({
          error: "errors.clients.user_unavailable",
          code: "CLIENT_USER_UNAVAILABLE",
          message: "Ce compte utilisateur ne peut pas porter un nouveau client VPN.",
        });
      }
    }

    if (!targetUserId && prisma) {
      let clientRole = await prisma.role.findUnique({ where: { name: "CLIENT" } });
      if (!clientRole) {
        clientRole = await prisma.role.create({
          data: { name: "CLIENT", description: "VPN Client" }
        });
      }
      const email =
        body.email?.trim().toLowerCase() ||
        `client.${Date.now()}.${crypto.randomBytes(6).toString("hex")}@vpn.local`;
      const emailTaken = await prisma.user.findUnique({ where: { email } });
      if (emailTaken) {
        return res.status(409).json({
          error: "errors.users.email_exists",
          code: "CLIENT_EMAIL_EXISTS",
          message: "Un compte utilise déjà cette adresse e-mail.",
        });
      }
      creationUtilisateur = {
        name: body.name,
        email,
        phone: body.phone || null,
        passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12),
        roleId: clientRole.id,
      };
    }

    if (!targetUserId && !prisma) {
      const clientRole = inMemoryDb.roles.find((role) => role.name === "CLIENT");
      if (!clientRole) {
        return res.status(500).json({ error: "errors.server", message: "Role CLIENT introuvable" });
      }
      const memoryUser = {
        id: `user-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
        name: body.name,
        email: body.email?.trim().toLowerCase()
          || `client.${Date.now()}.${crypto.randomBytes(4).toString("hex")}@vpn.local`,
        phone: body.phone || null,
        passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10),
        roleId: clientRole.id,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      inMemoryDb.users.push(memoryUser as any);
      targetUserId = memoryUser.id;
    }

    if (!targetUserId && !creationUtilisateur) {
      return res.status(400).json({ error: "errors.validation", message: "Compte client requis" });
    }

    const token = makeUserToken();

    let newClient: any = null;
    if (prisma) {
      newClient = await executerMutationQuota(prisma, {
        resellerUserId: fiche?.userId ?? targetUserId,
        resellerId: fiche?.id ?? null,
        auteur: { userId: req.user?.userId, email: req.user?.email },
        reason: `Creation du client ${body.name}`,
        referenceType: "vpn_client",
      }, async (tx) => {
        const clientUserId = creationUtilisateur
          ? (await tx.user.create({ data: { ...creationUtilisateur, status: "active" } })).id
          : targetUserId;
        return tx.vpnClient.create({
          data: {
            userId: clientUserId,
            token,
            quotaTotal: body.quotaTotalGb ? BigInt(body.quotaTotalGb) * BigInt(1024 * 1024 * 1024) : null,
            quotaUsed: BigInt(0),
            expireAt: body.durationDays ? new Date(Date.now() + body.durationDays * 24 * 60 * 60 * 1000) : null,
            status: "active",
            deviceLimit: body.deviceLimit,
            deviceId: body.deviceId || undefined,
            resellerId: fiche?.id ?? null,
          },
          include: { user: true, reseller: { include: { user: true } } },
        });
      });
    } else {
      newClient = {
        id: `client-${Date.now()}`,
        userId: targetUserId,
        token,
        quotaTotal: body.quotaTotalGb ? BigInt(body.quotaTotalGb) * BigInt(1024 * 1024 * 1024) : null,
        quotaUsed: BigInt(0),
        expireAt: body.durationDays ? new Date(Date.now() + body.durationDays * 24 * 60 * 60 * 1000) : null,
        status: "active",
        deviceLimit: body.deviceLimit,
        resellerId: fiche?.id ?? null,
        deviceId: body.deviceId || null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      inMemoryDb.vpnClients.push(newClient);
      const u = inMemoryDb.users.find((user) => user.id === targetUserId);
      newClient = { ...newClient, user: u };
    }

    accessStateHub.invalidate({ clientId: newClient.id });
    await logDbActivity(req.user?.userId || null, `Created VPN account: ${body.name}`, "success", req.ip);

    return res.status(201).json(sanitizeVpnClient(newClient));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    if (err instanceof PlafondQuotaDepasse) {
      return res.status(409).json(reponsePlafondDepasse(err.alloue, err.plafond));
    }
    console.error("Create VPN client error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to create VPN client" });
  }
});

// PATCH /api/clients/:id
router.patch(
  "/:id",
  requireAuth,
  interdireMutationSupport(),
  requirePermission("clients.create"),
  exigerAccesRevendeur(),
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const body = updateClientSchema.parse(req.body);

    let existingClient: any = null;
    if (prisma) {
      existingClient = await prisma.vpnClient.findUnique({ where: { id } });
    } else {
      existingClient = inMemoryDb.vpnClients.find((c) => c.id === id);
    }

    if (!existingClient) {
      return res.status(404).json({ error: "errors.clients.not_found", message: "VPN Client not found" });
    }

    const refusEdition = await refusSiClientNonPossede(req, existingClient);
    if (refusEdition) return res.status(refusEdition.status).json(refusEdition.body);
    if (body.status === "active") assertResumeAllowed(existingClient);

    // Augmenter le quota d'un client engage le plafond du revendeur : refus si
    // celui-ci est déjà atteint. Baisser le quota ou suspendre reste possible.
    const augmenteLeQuota =
      body.quotaTotalGb !== undefined &&
      BigInt(body.quotaTotalGb) * BigInt(1024 * 1024 * 1024) > BigInt(existingClient.quotaTotal ?? 0);
    if (augmenteLeQuota && prisma) {
      const plafond = await refusSiPlafondAtteint(prisma, {
        role: req.user?.role,
        userId: req.user?.userId,
        fiche: (req as any).reseller,
      });
      if (plafond) return res.status(plafond.status).json(plafond.body);
    }

    const updates: any = {};
    if (body.status !== undefined) updates.status = body.status;
    if (body.deviceLimit !== undefined) updates.deviceLimit = body.deviceLimit;
    if (body.quotaTotalGb !== undefined) {
      updates.quotaTotal = BigInt(body.quotaTotalGb) * BigInt(1024 * 1024 * 1024);
    }

    let updated: any = null;
    if (prisma) {
      if (body.name !== undefined) {
        const user = await prisma.user.findUnique({
          where: { id: existingClient.userId }, include: { role: true },
        });
        if (user?.role?.name !== "CLIENT" && user?.name !== body.name) {
          return res.status(409).json({
            error: "errors.clients.shared_user",
            message: "Ce client historique utilise un compte de gestion partagé. Son nom se modifie depuis Comptes.",
          });
        }
      }
      updated = await executerMutationQuota(prisma, {
        resellerUserId: existingClient.userId,
        resellerId: existingClient.resellerId ?? null,
        auteur: { userId: req.user?.userId, email: req.user?.email },
        reason: `Modification du quota du client ${existingClient.token}`,
        referenceType: "vpn_client",
        referenceId: id,
        autoriserReductionAuDessusDuPlafond:
          body.status === "suspended" ||
          body.status === "disabled" ||
          body.status === "revoked" ||
          body.status === "expired" ||
          (body.quotaTotalGb !== undefined &&
            BigInt(body.quotaTotalGb) * BigInt(1024 * 1024 * 1024) < BigInt(existingClient.quotaTotal ?? 0)),
      }, async (tx) => {
        if (body.status === "active") {
          const current = await tx.vpnClient.findUnique({ where: { id } });
          if (!current) throw new MobileAccessError(404, deviceAccessFailure("deleted"));
          assertResumeAllowed(current);
        }
        const result = await tx.vpnClient.update({
          where: { id },
          data: {
            ...updates,
            ...(body.name !== undefined
              ? { user: { update: { name: body.name } } }
              : {}),
          },
          include: { user: true, reseller: { include: { user: true } } },
        });
        if (body.status) await synchroniserEtatAccesClient(tx, id, body.status);
        return result;
      });
    } else {
      const index = inMemoryDb.vpnClients.findIndex((c) => c.id === id);
      const merged = { ...inMemoryDb.vpnClients[index], ...updates, updatedAt: new Date() };
      inMemoryDb.vpnClients[index] = merged;
      const u = inMemoryDb.users.find((user) => user.id === merged.userId);
      if (u && body.name !== undefined) u.name = body.name;
      updated = { ...merged, user: u };
    }

    accessStateHub.invalidate({ clientId: id });
    await logDbActivity(req.user?.userId || null, `Modified VPN client details (ID: ${id})`, "info", req.ip);

    return res.json(sanitizeVpnClient(updated));
  } catch (err) {
    if (err instanceof MobileAccessError) return res.status(err.status).json(err.body);
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    if (err instanceof PlafondQuotaDepasse) {
      return res.status(409).json(reponsePlafondDepasse(err.alloue, err.plafond));
    }
    console.error("Update VPN client error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to update VPN client" });
  }
});

// POST /api/clients/:id/suspend
// Action RÉDUCTRICE : ouverte même quand le plafond est atteint.
router.post(
  "/:id/suspend",
  requireAuth,
  interdireMutationSupport(),
  requirePermission("clients.manage"),
  exigerAccesRevendeur({ autoriserReduction: true }),
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    let client: any = null;

    if (prisma) {
      client = await prisma.vpnClient.findUnique({ where: { id } });
    } else {
      client = inMemoryDb.vpnClients.find((c) => c.id === id);
    }

    if (!client) return res.status(404).json({ error: "errors.clients.not_found" });

    const refus = await refusSiClientNonPossede(req, client);
    if (refus) return res.status(refus.status).json(refus.body);

    let updated: any = null;
    if (prisma) {
      updated = await executerMutationQuota(prisma, {
        resellerUserId: client.userId,
        resellerId: client.resellerId ?? null,
        auteur: { userId: req.user?.userId, email: req.user?.email },
        reason: `Suspension du client ${client.token}`,
        referenceType: "vpn_client",
        referenceId: id,
        autoriserReductionAuDessusDuPlafond: true,
      }, async (tx) => {
        const result = await tx.vpnClient.update({
          where: { id },
          data: { status: "suspended" },
          include: { user: true, reseller: { include: { user: true } } },
        });
        await synchroniserEtatAccesClient(tx, id, "suspended");
        return result;
      });
    } else {
      const index = inMemoryDb.vpnClients.findIndex((c) => c.id === id);
      inMemoryDb.vpnClients[index].status = "suspended";
      const u = inMemoryDb.users.find((user) => user.id === client.userId);
      updated = { ...inMemoryDb.vpnClients[index], user: u };
    }

    accessStateHub.invalidate({ clientId: id });
    await logDbActivity(req.user?.userId || null, `Suspended VPN Client: ${id}`, "warning", req.ip);
    return res.json(sanitizeVpnClient(updated));
  } catch (err) {
    if (err instanceof PlafondQuotaDepasse) {
      return res.status(409).json(reponsePlafondDepasse(err.alloue, err.plafond));
    }
    return res.status(500).json({ error: "errors.server" });
  }
});

// POST /api/clients/:id/activate
router.post(
  "/:id/activate",
  requireAuth,
  interdireMutationSupport(),
  requirePermission("clients.create"),
  exigerAccesRevendeur(),
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    let client: any = null;

    if (prisma) {
      client = await prisma.vpnClient.findUnique({ where: { id } });
    } else {
      client = inMemoryDb.vpnClients.find((c) => c.id === id);
    }

    if (!client) return res.status(404).json({ error: "errors.clients.not_found" });

    const refus = await refusSiClientNonPossede(req, client);
    if (refus) return res.status(refus.status).json(refus.body);
    assertResumeAllowed(client);

    let updated: any = null;
    if (prisma) {
      updated = await executerMutationQuota(prisma, {
        resellerUserId: client.userId,
        resellerId: client.resellerId ?? null,
        auteur: { userId: req.user?.userId, email: req.user?.email },
        reason: `Reactivation du client ${id}`,
        referenceType: "vpn_client",
        referenceId: id,
      }, async (tx) => {
        const current = await tx.vpnClient.findUnique({ where: { id } });
        if (!current) throw new MobileAccessError(404, deviceAccessFailure("deleted"));
        assertResumeAllowed(current);
        const result = await tx.vpnClient.update({
          where: { id },
          data: { status: "active" },
          include: { user: true, reseller: { include: { user: true } } },
        });
        await synchroniserEtatAccesClient(tx, id, "active");
        return result;
      });
    } else {
      const index = inMemoryDb.vpnClients.findIndex((c) => c.id === id);
      inMemoryDb.vpnClients[index].status = "active";
      const u = inMemoryDb.users.find((user) => user.id === client.userId);
      updated = { ...inMemoryDb.vpnClients[index], user: u };
    }

    accessStateHub.invalidate({ clientId: id });
    await logDbActivity(req.user?.userId || null, `Activated VPN Client: ${id}`, "success", req.ip);
    return res.json(sanitizeVpnClient(updated));
  } catch (err) {
    if (err instanceof MobileAccessError) return res.status(err.status).json(err.body);
    if (err instanceof PlafondQuotaDepasse) {
      return res.status(409).json(reponsePlafondDepasse(err.alloue, err.plafond));
    }
    return res.status(500).json({ error: "errors.server" });
  }
});

// POST /api/clients/:id/renew
router.post(
  "/:id/renew",
  requireAuth,
  interdireMutationSupport(),
  requirePermission("clients.create"),
  exigerAccesRevendeur(),
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { durationDays } = renewClientSchema.parse(req.body ?? {});
    let client: any = null;

    if (prisma) {
      client = await prisma.vpnClient.findUnique({ where: { id } });
    } else {
      client = inMemoryDb.vpnClients.find((c) => c.id === id);
    }

    if (!client) return res.status(404).json({ error: "errors.clients.not_found" });

    const refus = await refusSiClientNonPossede(req, client);
    if (refus) return res.status(refus.status).json(refus.body);

    let updated: any = null;
    if (prisma) {
      updated = await executerMutationQuota(prisma, {
        resellerUserId: client.userId,
        resellerId: client.resellerId ?? null,
        auteur: { userId: req.user?.userId, email: req.user?.email },
        reason: `Renouvellement du client ${id}`,
        referenceType: "vpn_client",
        referenceId: id,
      }, async (tx) => {
        const current = await tx.vpnClient.findUnique({ where: { id } });
        if (!current) throw new MobileAccessError(404, deviceAccessFailure("deleted"));
        const newExpiry = renewedDeviceExpiry(current.expireAt, durationDays);
        const result = await tx.vpnClient.update({
          where: { id },
          data: { expireAt: newExpiry, status: "active", token: makeUserToken() },
          include: { user: true, reseller: { include: { user: true } } },
        });
        await synchroniserEtatAccesClient(tx, id, "active", { deviceId: current.deviceId, expireAt: newExpiry });
        return result;
      });
    } else {
      const index = inMemoryDb.vpnClients.findIndex((c) => c.id === id);
      inMemoryDb.vpnClients[index].expireAt = renewedDeviceExpiry(inMemoryDb.vpnClients[index].expireAt, durationDays);
      inMemoryDb.vpnClients[index].token = makeUserToken();
      inMemoryDb.vpnClients[index].status = "active";
      const u = inMemoryDb.users.find((user) => user.id === client.userId);
      updated = { ...inMemoryDb.vpnClients[index], user: u };
    }

    accessStateHub.invalidate({ clientId: id });
    await logDbActivity(req.user?.userId || null, `Renewed device ${id} by ${durationDays} days`, "success", req.ip);
    return res.json(sanitizeVpnClient(updated));
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: "errors.validation", details: err.issues });
    if (err instanceof MobileAccessError) return res.status(err.status).json(err.body);
    if (err instanceof PlafondQuotaDepasse) {
      return res.status(409).json(reponsePlafondDepasse(err.alloue, err.plafond));
    }
    console.error("Renew VPN client error:", err);
    return res.status(500).json({ error: "errors.server" });
  }
});

// POST /api/clients/:id/reset-access
router.post(
  "/:id/reset-access",
  requireAuth,
  interdireMutationSupport(),
  requirePermission("clients.create"),
  exigerAccesRevendeur(),
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    let client: any = null;

    if (prisma) {
      client = await prisma.vpnClient.findUnique({ where: { id } });
    } else {
      client = inMemoryDb.vpnClients.find((c) => c.id === id);
    }

    if (!client) return res.status(404).json({ error: "errors.clients.not_found" });

    const refus = await refusSiClientNonPossede(req, client);
    if (refus) return res.status(refus.status).json(refus.body);

    const newToken = makeUserToken();

    let updated: any = null;
    if (prisma) {
      updated = await prisma.vpnClient.update({
        where: { id },
        data: { token: newToken },
        include: { user: true, reseller: { include: { user: true } } },
      });
    } else {
      const index = inMemoryDb.vpnClients.findIndex((c) => c.id === id);
      inMemoryDb.vpnClients[index].token = newToken;
      const u = inMemoryDb.users.find((user) => user.id === client.userId);
      updated = { ...inMemoryDb.vpnClients[index], user: u };
    }

    accessStateHub.invalidate({ clientId: id });
    await logDbActivity(req.user?.userId || null, `Replaced secure key token for Client ID: ${id}`, "info", req.ip);
    return res.json(sanitizeVpnClient(updated));
  } catch (err) {
    return res.status(500).json({ error: "errors.server" });
  }
});

// DELETE /api/clients/:id
// Action RÉDUCTRICE : ouverte même quand le plafond est atteint — supprimer un
// client est précisément ce qui libère du volume.
router.delete(
  "/:id",
  requireAuth,
  interdireMutationSupport(),
  requirePermission("clients.delete"),
  exigerAccesRevendeur({ autoriserReduction: true }),
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    let client: any = null;

    if (prisma) {
      client = await prisma.vpnClient.findUnique({ where: { id } });
    } else {
      client = inMemoryDb.vpnClients.find((c) => c.id === id);
    }

    if (!client) return res.status(404).json({ error: "errors.clients.not_found", message: "Client not found" });

    const refus = await refusSiClientNonPossede(req, client);
    if (refus) return res.status(refus.status).json(refus.body);

    if (prisma) {
      await executerMutationQuota(prisma, {
        resellerUserId: client.userId,
        resellerId: client.resellerId ?? null,
        auteur: { userId: req.user?.userId, email: req.user?.email },
        reason: `Suppression du client ${client.token}`,
        referenceType: "vpn_client",
        referenceId: id,
        autoriserReductionAuDessusDuPlafond: true,
      }, async (tx) => {
        await dissocierAccesClient(tx, id);
        return tx.vpnClient.delete({ where: { id } });
      });
    } else {
      const index = inMemoryDb.vpnClients.findIndex((c) => c.id === id);
      inMemoryDb.vpnClients.splice(index, 1);
    }

    if (!prisma) {
      const activationSessions = (inMemoryDb as any).activationSessions || [];
      (inMemoryDb as any).activationSessions = activationSessions.filter((s: any) => s.clientId !== id);
    }

    accessStateHub.invalidate({ clientId: id });
    await logDbActivity(req.user?.userId || null, `Deleted VPN Client account: ${id}`, "danger", req.ip);
    return res.json({ message: "VPN client account and credentials deleted successfully" });
  } catch (err) {
    console.error("Delete client error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to delete client" });
  }
});

export default router;

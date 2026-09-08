import { Router, Response } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma, inMemoryDb, logDbActivity } from "../database";
import { requireAuth, requirePermission, requireRole, AuthenticatedRequest } from "../middleware/auth";
import { canSeeUser } from "../middleware/rbac/owner";
import {
  AccesHistoriqueQuotaRefuse,
  calculerAllocation,
  estIllimite,
  executerMutationQuota,
  modifierPlafondQuota,
  PlafondQuotaDepasse,
  porteeHistoriqueQuota,
  porteUnQuotaInterdit,
  serialiserMouvementQuota,
} from "../services/reseller-quota";
import {
  CODES_REVENDEUR,
  calculerEtatAcces,
  calculerEtatQuota,
  chargerFicheRevendeur,
  exigerAccesRevendeur,
  interdireMutationSupport,
  porteeClientsRevendeur,
  refusPropriete,
  refusSiPlafondAtteint,
  reponsePlafondDepasse,
  resumerAccesRevendeur,
} from "../services/reseller-access";

const router = Router();
const gestionRevendeurs = requireRole(["SUPER_ADMIN", "ADMIN"]);

/**
 * Validité d'accès exigée à la CRÉATION.
 *
 * Une fiche revendeur sans échéance est un accès perpétuel que personne n'a
 * décidé : les six fiches en production sont dans ce cas, faute d'avoir jamais
 * eu le champ. La colonne reste nullable pour elles (accès hérité), mais toute
 * création passant par l'API doit désormais porter une date FUTURE explicite.
 */
const dateAccesFuture = z
  .string()
  .trim()
  .min(4)
  .refine((valeur) => !Number.isNaN(new Date(valeur).getTime()), {
    message: "accessExpiresAt doit être une date ISO valide",
  })
  .refine((valeur) => new Date(valeur).getTime() > Date.now(), {
    message: "accessExpiresAt doit être dans le futur",
  })
  .transform((valeur) => new Date(valeur));

// Helper : aplatit les données reseller et convertit les BigInt avant JSON.
function flattenReseller(r: any, clientsCount = 0, consomme: bigint = BigInt(0)): any {
  const quotaBytes = r.quotaBytes ?? BigInt(0);
  const quotaUsedBytes = r.quotaUsedBytes ?? BigInt(0);
  const quotaGB = Number(quotaBytes) / (1024 ** 3);
  const illimite = estIllimite(quotaBytes);
  return {
    id: r.id,
    name: r.user?.name || r.name || "",
    email: r.user?.email || r.email || "",
    phone: r.user?.phone || null,
    balance: quotaGB,
    commission: r.commission ?? 0,
    quotaBytes: quotaBytes.toString(),
    quotaUsedBytes: quotaUsedBytes.toString(),
    quotaGB,
    quotaUsedGB: Number(quotaUsedBytes) / (1024 ** 3),
    // « alloué » = ce que le revendeur a engagé auprès de ses clients, c'est ce
    // qui décompte son plafond. « consommé » = le trafic réellement écoulé.
    // Les deux étaient confondus sous un seul champ, si bien que la barre de
    // progression n'a jamais reflété l'usage réel.
    quotaAllocatedBytes: quotaUsedBytes.toString(),
    quotaAllocatedGB: Number(quotaUsedBytes) / (1024 ** 3),
    quotaConsumedBytes: consomme.toString(),
    quotaConsumedGB: Number(consomme) / (1024 ** 3),
    quotaUnlimited: illimite,
    quotaRemainingBytes: illimite
      ? null
      : (quotaBytes > quotaUsedBytes ? quotaBytes - quotaUsedBytes : BigInt(0)).toString(),
    status: r.status,
    // Validité et plafond, calculés au même endroit pour tout le produit.
    accessExpiresAt: r.accessExpiresAt ?? null,
    accessState: calculerEtatAcces(r),
    quotaState: calculerEtatQuota(quotaBytes, quotaUsedBytes),
    // Résumé structuré, BigInt en chaînes : c'est ce bloc que les refus
    // renvoient également, afin que l'interface lise partout le même contrat.
    resellerAccess: resumerAccesRevendeur(r, quotaUsedBytes),
    clientsCount,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    userId: r.userId,
  };
}

// POST accepte soit { name, email, phone?, balance? } soit l'ancien { userId, commission? }
const createResellerSchema = z.object({
  name: z.string().min(2).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  balance: z.coerce.number().min(0).optional(),
  quotaGB: z.coerce.number().min(-1).optional(),
  userId: z.string().optional(),
  commission: z.coerce.number().min(0).max(100).default(20),
  status: z.enum(["active", "suspended"]).default("active"),
  // Obligatoire : un agrément de revendeur a une fin, et elle se décide à
  // l'ouverture du compte, pas après coup.
  accessExpiresAt: dateAccesFuture,
});

const resellerCreateClientSchema = z.object({
  name: z.string().min(2),
  quotaTotalGb: z.coerce.number().int().min(0).max(1_000_000).default(0),
  durationDays: z.coerce.number().int().min(1).max(3650).default(30),
  deviceLimit: z.coerce.number().int().min(1).max(100).default(1),
});

// GET /api/resellers — retourne { resellers: [...] } (frontend attend ce format)
router.get("/", requireAuth, gestionRevendeurs, requirePermission("reseller.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    let resellers: any[] = [];
    if (prisma) {
      const raw = await prisma.reseller.findMany({ include: { user: { include: { role: true } } } });
      resellers = await Promise.all(
        raw
          // Stealth : revendeur lié à un compte OWNER invisible pour les non-OWNER.
          .filter((r) => canSeeUser(req, r.user))
          .map(async (r) => {
            const clientsCount = await prisma.vpnClient.count({ where: porteeClientsRevendeur(r) as any });
            // Le cumul ne portait que sur les forfaits : les clients créés via
            // /:id/create-client, qui portent leur quota en propre, restaient
            // invisibles du décompte. calculerAllocation() couvre les deux.
            const { alloue, consomme } = await calculerAllocation(prisma, r);
            return flattenReseller({ ...r, quotaUsedBytes: alloue }, clientsCount, consomme);
          })
      );
    } else {
      resellers = inMemoryDb.resellers.map((r) => {
        const u = inMemoryDb.users.find((user) => user.id === r.userId);
        const clientsCount = inMemoryDb.vpnClients.filter((c) => c.userId === r.userId).length;
        return flattenReseller({ ...r, user: u }, clientsCount);
      });
    }
    return res.json({ resellers });
  } catch (err) {
    console.error("Fetch resellers error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch resellers" });
  }
});

// GET /api/resellers/me/access — état minimal du revendeur connecté.
//
// Cette lecture ne dépend volontairement d'aucune permission métier : retirer
// `analytics.read` ou `reseller.manage` ne doit pas faire disparaître le motif
// d'un blocage global. Aucune donnée client, configuration ou secret ne sort.
router.get("/me/access", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.role !== "RESELLER") {
      return res.json({ resellerAccess: null });
    }
    if (!prisma) return res.status(503).json({ error: "errors.db.unavailable" });
    const fiche = await chargerFicheRevendeur(prisma, req.user.userId);
    if (!fiche) {
      return res.status(403).json({
        error: "errors.resellers.not_found",
        code: CODES_REVENDEUR.ACCOUNT_REQUIRED,
        message: "Aucune fiche revendeur associée à ce compte.",
      });
    }
    const { alloue } = await calculerAllocation(prisma, fiche);
    return res.json({ resellerAccess: resumerAccesRevendeur(fiche, alloue) });
  } catch (err) {
    console.error("Reseller self access error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to resolve reseller access" });
  }
});

const historyQuerySchema = z.object({
  resellerId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

// GET /api/resellers/quota-history — admins: tout, revendeur: son historique.
router.get("/quota-history", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const query = historyQuerySchema.parse(req.query);
    const where = porteeHistoriqueQuota(req.user?.role, req.user?.userId, query.resellerId);
    if (!prisma) return res.json({ movements: [] });
    const movements = await (prisma as any).resellerQuotaMovement.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit,
    });
    return res.json({ movements: movements.map(serialiserMouvementQuota) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    if (err instanceof AccesHistoriqueQuotaRefuse) {
      return res.status(403).json({ error: "errors.auth.forbidden", message: err.message });
    }
    console.error("Fetch reseller quota history error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch quota history" });
  }
});

// POST /api/resellers — accepte { name, email } OU { userId }
//
// FLUX CANONIQUE UNIQUE de création d'un revendeur : compte utilisateur, rôle
// RESELLER et fiche revendeur naissent dans la MÊME transaction. Auparavant
// l'utilisateur était créé d'abord, puis la fiche dans une seconde
// transaction : tout échec entre les deux laissait un compte porteur du rôle
// RESELLER sans fiche en face — c'est ainsi que la production compte 70
// utilisateurs RESELLER pour 6 fiches.
router.post(
  "/",
  requireAuth,
  gestionRevendeurs,
  interdireMutationSupport(),
  requirePermission("reseller.manage"),
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = createResellerSchema.parse(req.body);
    let resolvedUserId = body.userId;
    const commission = body.commission ?? 20;
    const quotaGb = Number(body.quotaGB ?? body.balance ?? 0);
    const quotaBytes = quotaGb < 0
      ? BigInt(-1)
      : BigInt(Math.round(quotaGb * 1024 ** 3));
    const accessExpiresAt: Date = body.accessExpiresAt;
    let generatedPassword: string | undefined;

    if (!resolvedUserId && !(body.name && body.email)) {
      return res.status(400).json({ error: "errors.validation", message: "Provide either userId or name+email" });
    }

    if (prisma) {
      let creationUtilisateur: { name: string; email: string; phone: string | null; passwordHash: string; roleId: string } | null = null;
      const resellerRole = await prisma.role.findFirst({ where: { name: "RESELLER" } });
      if (!resellerRole) {
        return res.status(500).json({ error: "errors.server", message: "Role RESELLER not found" });
      }

      if (!resolvedUserId && body.name && body.email) {
        const existing = await prisma.user.findUnique({ where: { email: body.email } });
        if (existing) {
          resolvedUserId = existing.id;
        } else {
          const tempPassword = crypto.randomBytes(10).toString("hex");
          generatedPassword = tempPassword;
          // Le hachage bcrypt est coûteux : il est fait AVANT d'ouvrir la
          // transaction, qui doit rester la plus courte possible.
          creationUtilisateur = {
            name: body.name,
            email: body.email,
            phone: body.phone || null,
            passwordHash: await bcrypt.hash(tempPassword, 12),
            roleId: resellerRole.id,
          };
        }
      }

      if (resolvedUserId) {
        const existingReseller = await prisma.reseller.findUnique({ where: { userId: resolvedUserId } });
        if (existingReseller) {
          return res.status(400).json({ error: "errors.resellers.exists", message: "User is already a reseller" });
        }
        // Un compte qui pilote la plateforme ne peut pas devenir revendeur : cela
        // lui attacherait un plafond de données alors que son accès est illimité.
        const cible = await prisma.user.findUnique({ where: { id: resolvedUserId }, include: { role: true } });
        if (!cible) {
          return res.status(404).json({ error: "errors.users.not_found", message: "Utilisateur introuvable" });
        }
        // Garde hiérarchique : un non-OWNER ne transforme pas un compte OWNER.
        if (!canSeeUser(req, cible)) {
          const refus = refusPropriete();
          return res.status(refus.status).json(refus.body);
        }
        if (porteUnQuotaInterdit(cible?.role?.name)) {
          return res.status(409).json({
            error: "errors.resellers.quota_forbidden",
            message: "Un compte administrateur ou super-administrateur ne peut pas être revendeur : il ne porte aucun quota.",
          });
        }
      }

      const newReseller = await prisma.$transaction(async (tx: any) => {
        const userId = creationUtilisateur
          ? (await tx.user.create({ data: { ...creationUtilisateur, status: "active" } })).id
          : (resolvedUserId as string);
        if (!creationUtilisateur) {
          await tx.user.update({
            where: { id: userId },
            data: { roleId: resellerRole.id },
          });
        }
        const created = await tx.reseller.create({
          data: {
            userId,
            commission,
            quotaBytes,
            quotaUsedBytes: BigInt(0),
            status: body.status,
            accessExpiresAt,
          },
          include: { user: true },
        });
        if (quotaBytes !== BigInt(0)) {
          await tx.resellerQuotaMovement.create({
            data: {
              resellerId: created.id,
              resellerUserId: created.userId,
              resellerName: created.user?.name || created.user?.email || "Revendeur",
              actorUserId: req.user?.userId || null,
              actorName: req.user?.email || "Systeme",
              kind: "ADMIN_ALLOCATION",
              reason: "Allocation initiale du plafond",
              deltaBytes: quotaBytes,
              quotaBeforeBytes: BigInt(0),
              quotaAfterBytes: quotaBytes,
              allocatedBeforeBytes: BigInt(0),
              allocatedAfterBytes: BigInt(0),
              referenceType: "reseller",
              referenceId: created.id,
            },
          });
        }
        return created;
      }, { isolationLevel: "Serializable" });
      await logDbActivity(
        req.user?.userId || null,
        `Reseller created: ${body.email || newReseller.userId} (accès jusqu'au ${accessExpiresAt.toISOString()})`,
        "success",
        req.ip
      );
      const resellerResponse: any = flattenReseller(newReseller, 0);
      if (generatedPassword) resellerResponse.generatedPassword = generatedPassword;
      return res.status(201).json(resellerResponse);
    } else {
      if (!resolvedUserId) {
        return res.status(400).json({ error: "errors.validation", message: "userId required in memory mode" });
      }
      const existingReseller = inMemoryDb.resellers.some((r) => r.userId === resolvedUserId);
      if (existingReseller) {
        return res.status(400).json({ error: "errors.resellers.exists", message: "User is already a reseller" });
      }
      const newReseller: any = {
        id: `reseller-${Date.now()}`,
        userId: resolvedUserId,
        commission,
        quotaBytes,
        quotaUsedBytes: BigInt(0),
        status: body.status,
        accessExpiresAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      inMemoryDb.resellers.push(newReseller);
      const u = inMemoryDb.users.find((user) => user.id === resolvedUserId);
      const resellerRole = inMemoryDb.roles.find((role) => role.name === "RESELLER");
      if (u && resellerRole) u.roleId = resellerRole.id;
      return res.status(201).json(flattenReseller({ ...newReseller, user: u }, 0));
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    console.error("Create reseller error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to register reseller" });
  }
});

// GET /api/resellers/reconciliation — rapport LECTURE SEULE.
//
// 70 comptes portent le rôle RESELLER pour 6 fiches réelles. Réécrire ces
// données à l'aveugle serait irréversible : soit on retirerait un rôle à des
// comptes légitimes, soit on créerait 64 fiches revendeur fantômes avec le
// quota qui va avec. Ce rapport se contente de nommer l'écart pour qu'un
// humain tranche compte par compte. AUCUNE écriture ici.
//
// Le garde-fou d'authentification reste la protection effective : un compte
// RESELLER sans fiche est déjà traité comme un simple CLIENT.
router.get(
  "/reconciliation",
  requireAuth,
  gestionRevendeurs,
  requirePermission("reseller.manage"),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!prisma) return res.json({ orphanRoleUsers: [], resellersWithoutRole: [], totals: { roleUsers: 0, resellerRecords: 0 } });

      const [utilisateursRole, fiches] = await Promise.all([
        prisma.user.findMany({
          where: { role: { name: "RESELLER" } },
          include: { role: true, resellerInfo: true },
          orderBy: { createdAt: "desc" },
        }),
        prisma.reseller.findMany({ include: { user: { include: { role: true } } } }),
      ]);

      const visibles = utilisateursRole.filter((u) => canSeeUser(req, u));
      const orphelins = visibles.filter((u) => !(u as any).resellerInfo);
      const fichesSansRole = fiches
        .filter((r) => canSeeUser(req, (r as any).user))
        .filter((r) => (r as any).user?.role?.name !== "RESELLER");

      return res.json({
        totals: {
          roleUsers: visibles.length,
          resellerRecords: fiches.length,
          orphanRoleUsers: orphelins.length,
          resellersWithoutRole: fichesSansRole.length,
        },
        // Comptes portant le rôle sans fiche : traités comme CLIENT par
        // l'authentification, donc sans pouvoir revendeur effectif.
        orphanRoleUsers: orphelins.map((u) => ({
          userId: u.id,
          name: u.name,
          email: u.email,
          status: u.status,
          createdAt: u.createdAt,
          effectiveRole: "CLIENT",
          reason: "Rôle RESELLER sans fiche revendeur",
        })),
        // Fiches dont le compte porte un autre rôle : l'inverse de l'écart.
        resellersWithoutRole: fichesSansRole.map((r) => ({
          resellerId: r.id,
          userId: r.userId,
          name: (r as any).user?.name ?? null,
          email: (r as any).user?.email ?? null,
          roleName: (r as any).user?.role?.name ?? null,
          accessState: calculerEtatAcces(r),
        })),
        readOnly: true,
      });
    } catch (err) {
      console.error("Reseller reconciliation error:", err);
      return res.status(500).json({ error: "errors.server", message: "Failed to build reconciliation report" });
    }
  }
);

// GET /api/resellers/:id/clients
router.get("/:id/clients", requireAuth, requireRole(["SUPER_ADMIN", "ADMIN", "RESELLER"]), requirePermission("clients.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (req.user?.role === "RESELLER") {
      let authorized = false;
      if (prisma) {
        const reseller = await prisma.reseller.findUnique({ where: { id } });
        if (reseller && reseller.userId === req.user.userId) authorized = true;
      } else {
        const reseller = inMemoryDb.resellers.find((r) => r.id === id);
        if (reseller && reseller.userId === req.user.userId) authorized = true;
      }
      if (!authorized) {
        return res.status(403).json({ error: "errors.auth.forbidden", message: "Resellers can only query their own client rosters" });
      }
    } else {
      const hasPerm =
        req.user?.permissions.includes("reseller.manage") ||
        req.user?.role === "ADMIN" ||
        req.user?.role === "SUPER_ADMIN" || req.user?.role === "OWNER";
      if (!hasPerm) {
        return res.status(403).json({ error: "errors.auth.forbidden", message: "Forbidden" });
      }
    }

    let fiche: any = null;
    if (prisma) {
      fiche = await prisma.reseller.findUnique({ where: { id }, include: { user: true } });
    } else {
      fiche = inMemoryDb.resellers.find((r) => r.id === id);
    }
    if (!fiche) {
      return res.status(404).json({ error: "errors.resellers.not_found", message: "Reseller not found" });
    }

    let clients: any[] = [];
    if (prisma) {
      clients = await prisma.vpnClient.findMany({
        where: porteeClientsRevendeur(fiche) as any,
        orderBy: { createdAt: "desc" },
      });
    } else {
      clients = inMemoryDb.vpnClients.filter((c) => c.userId === fiche.userId || (c as any).resellerId === fiche.id);
    }
    const sanitized = clients.map((c) => ({
      id: c.id,
      token: c.token,
      // Un client SANS quota propre est légitime : son volume peut venir d'un
      // forfait, ou il peut n'avoir aucun plan du tout.
      quotaTotal: (c.quotaTotal ?? BigInt(0)).toString(),
      quotaUsed: (c.quotaUsed ?? BigInt(0)).toString(),
      expireAt: c.expireAt,
      status: c.status,
      resellerId: (c as any).resellerId ?? null,
      resellerName: fiche.user?.name ?? null,
      createdAt: c.createdAt,
    }));
    return res.json(sanitized);
  } catch (err) {
    console.error("Fetch reseller clients error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to retrieve reseller clients" });
  }
});

// POST /api/resellers/:id/create-client
//
// Crée un client rattaché au revendeur. Aucun forfait, aucun profil VPN :
// l'attribution d'un plan reste une action distincte et explicite.
router.post(
  "/:id/create-client",
  requireAuth,
  requireRole(["SUPER_ADMIN", "ADMIN", "RESELLER"]),
  requirePermission("clients.create"),
  interdireMutationSupport(),
  exigerAccesRevendeur(),
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const body = resellerCreateClientSchema.parse(req.body);

    let fiche: any = null;
    if (prisma) {
      fiche = await prisma.reseller.findUnique({ where: { id }, include: { user: true } });
    } else {
      fiche = inMemoryDb.resellers.find((r) => r.id === id);
    }
    if (!fiche) {
      return res.status(404).json({ error: "errors.resellers.not_found", message: "Reseller not found" });
    }
    const resellerUserId: string = fiche.userId;
    // Validité du revendeur DESTINATAIRE, y compris quand l'administrateur agit
    // pour lui : ouvrir un client sous un agrément expiré recréerait le
    // problème que l'échéance sert à éviter.
    const etat = calculerEtatAcces(fiche);
    if (etat !== "active") {
      const resume = resumerAccesRevendeur(fiche);
      return res.status(403).json({
        error: etat === "expired" ? "errors.resellers.access_expired" : "errors.resellers.suspended",
        code: etat === "expired" ? "RESELLER_EXPIRED" : "RESELLER_SUSPENDED",
        message: etat === "expired"
          ? "Accès expiré — veuillez renouveler"
          : "Accès suspendu — contactez l'administrateur",
        resellerAccess: resume,
      });
    }
    if (req.user?.role === "RESELLER" && req.user.userId !== resellerUserId) {
      const refus = refusPropriete();
      return res.status(refus.status).json(refus.body);
    }
    // Plafond déjà atteint : refus nommé, avec le résumé d'accès en réponse.
    if (prisma) {
      const plafond = await refusSiPlafondAtteint(prisma, {
        role: req.user?.role === "RESELLER" ? "RESELLER" : undefined,
        userId: resellerUserId,
        fiche,
      });
      if (plafond) return res.status(plafond.status).json(plafond.body);
    }

    const quotaBytes = BigInt(body.quotaTotalGb) * BigInt(1024 * 1024 * 1024);
    // Ce chemin créait un client — et donc du quota — sans jamais consulter le
    // plafond du revendeur : c'est par là que 16 Go ont été distribués par un
    // revendeur crédité de 0 Go. Le contrôle porte sur le revendeur
    // destinataire, y compris lorsque c'est l'administrateur qui agit pour lui.
    const expireAt = new Date();
    expireAt.setDate(expireAt.getDate() + body.durationDays);
    const tokenPart = () => crypto.randomBytes(2).toString("hex").toUpperCase();
    const tokenValue = `SXB-USER-${tokenPart()}-${tokenPart()}-${tokenPart()}`;

    let newClient: any = null;
    if (prisma) {
      const clientRole = await prisma.role.findFirst({ where: { name: "CLIENT" } });
      if (!clientRole) {
        return res.status(500).json({ error: "errors.server", message: "Role CLIENT introuvable" });
      }
      const clientEmail = `client.${Date.now()}.${crypto.randomBytes(6).toString("hex")}@vpn.local`;
      const clientPasswordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);
      // `name` n'existe pas sur VpnClient : le passer faisait échouer Prisma, et
      // cette route répondait 500 depuis toujours. Le libellé du client vient de
      // l'utilisateur propriétaire, comme dans POST /api/clients.
      newClient = await executerMutationQuota(prisma, {
        resellerUserId,
        resellerId: fiche.id,
        auteur: { userId: req.user?.userId, email: req.user?.email },
        reason: `Creation du client ${body.name}`,
        referenceType: "vpn_client",
      }, async (tx) => {
        const clientUser = await tx.user.create({
          data: {
            name: body.name,
            email: clientEmail,
            passwordHash: clientPasswordHash,
            roleId: clientRole.id,
            status: "active",
          },
        });
        return tx.vpnClient.create({
          data: {
            token: tokenValue,
            userId: clientUser.id,
            resellerId: fiche.id,
            quotaTotal: quotaBytes,
            quotaUsed: BigInt(0),
            expireAt,
            deviceLimit: body.deviceLimit,
            status: "active",
          },
        });
      });
    } else {
      const clientRole = inMemoryDb.roles.find((role) => role.name === "CLIENT");
      if (!clientRole) {
        return res.status(500).json({ error: "errors.server", message: "Role CLIENT introuvable" });
      }
      const clientUser = {
        id: `user-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
        name: body.name,
        email: `client.${Date.now()}.${crypto.randomBytes(4).toString("hex")}@vpn.local`,
        passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10),
        roleId: clientRole.id,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      inMemoryDb.users.push(clientUser as any);
      newClient = {
        id: `client-${Date.now()}`,
        name: body.name,
        token: tokenValue,
        userId: clientUser.id,
        resellerId: fiche.id,
        quotaTotal: quotaBytes,
        quotaUsed: BigInt(0),
        expireAt,
        deviceLimit: body.deviceLimit,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      inMemoryDb.vpnClients.push(newClient);
    }

    await logDbActivity(req.user?.userId || null, `Client created under reseller ${id}: ${body.name}`, "success", req.ip);
    return res.status(201).json({
      id: newClient.id,
      token: tokenValue,
      quotaTotal: quotaBytes.toString(),
      expireAt,
      deviceLimit: body.deviceLimit,
      status: "active",
      resellerId: fiche.id,
      resellerName: fiche.user?.name ?? null,
      // Aucun forfait n'est créé ici — le dire explicitement évite que
      // l'interface en déduise l'inverse.
      subscriptionId: null,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    if (err instanceof PlafondQuotaDepasse) {
      return res.status(409).json(reponsePlafondDepasse(err.alloue, err.plafond));
    }
    console.error("Create reseller client error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to create reseller client" });
  }
});

// PATCH /api/resellers/:id
const updateResellerSchema = z.object({
  commission: z.coerce.number().min(0).max(100).optional(),
  balance: z.coerce.number().min(0).optional(),
  // Un quota négatif vaut « illimité » : c'est le seul moyen de lever le
  // plafond, et il doit rester un choix explicite de l'administrateur.
  quotaGB: z.coerce.number().min(-1).optional(),
  status: z.enum(["active", "suspended"]).optional(),
  // Renouvellement / modification de l'échéance d'accès, réservé aux rôles
  // qui administrent les revendeurs. Toujours une date future : reculer
  // l'échéance dans le passé se fait par `status: "suspended"`, qui est
  // réversible et lisible.
  accessExpiresAt: dateAccesFuture.optional(),
  reason: z.string().trim().min(3).max(500).optional(),
  correction: z.boolean().optional(),
});

router.patch(
  "/:id",
  requireAuth,
  gestionRevendeurs,
  interdireMutationSupport(),
  requirePermission("reseller.manage"),
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const body = updateResellerSchema.parse(req.body);
    const updateData: any = {};
    if (body.commission !== undefined) updateData.commission = body.commission;
    // `quotaGB` est la valeur qui fait foi ; `balance` reste accepté pour le
    // bouton historique du dashboard, mais ne doit pas l'écraser.
    if (body.balance !== undefined) updateData.quotaBytes = BigInt(Math.round(Number(body.balance) * 1024 ** 3));
    if (body.quotaGB !== undefined) {
      updateData.quotaBytes = body.quotaGB < 0
        ? BigInt(-1)
        : BigInt(Math.round(Number(body.quotaGB) * 1024 ** 3));
    }
    if (body.status !== undefined) updateData.status = body.status;
    if (body.accessExpiresAt !== undefined) updateData.accessExpiresAt = body.accessExpiresAt;

    if (prisma) {
      const exists = await prisma.reseller.findUnique({ where: { id }, include: { user: { include: { role: true } } } });
      if (!exists) return res.status(404).json({ error: "errors.resellers.not_found", message: "Reseller not found" });
      // Garde hiérarchique : un non-OWNER ne modifie jamais une fiche adossée
      // à un compte OWNER.
      if (!canSeeUser(req, (exists as any).user)) {
        return res.status(404).json({ error: "errors.resellers.not_found", message: "Reseller not found" });
      }
      // Administrateurs et super-administrateurs pilotent la plateforme : leur
      // attribuer un quota n'a pas de sens et ferait apparaître une limite là
      // où il n'en existe aucune.
      if (updateData.quotaBytes !== undefined && porteUnQuotaInterdit((exists as any).user?.role?.name)) {
        return res.status(409).json({
          error: "errors.resellers.quota_forbidden",
          message: "Un compte administrateur ou super-administrateur ne porte aucun quota : son accès est illimité.",
        });
      }
      let updated: any;
      if (updateData.quotaBytes !== undefined) {
        updated = await modifierPlafondQuota(prisma, {
          resellerId: id,
          nouveauPlafond: updateData.quotaBytes,
          auteur: { userId: req.user?.userId, email: req.user?.email },
          reason: body.reason || "Ajustement manuel du plafond",
          correction: body.correction,
        });
        if (!updated) return res.status(404).json({ error: "errors.resellers.not_found", message: "Reseller not found" });
        const otherData = { ...updateData };
        delete otherData.quotaBytes;
        if (Object.keys(otherData).length > 0) {
          updated = await prisma.reseller.update({ where: { id }, data: otherData, include: { user: true } });
        }
      } else {
        updated = await prisma.reseller.update({ where: { id }, data: updateData, include: { user: true } });
      }
      const clientsCount = await prisma.vpnClient.count({ where: porteeClientsRevendeur(updated) as any });
      const { alloue, consomme } = await calculerAllocation(prisma, updated);
      await logDbActivity(
        req.user?.userId || null,
        body.accessExpiresAt
          ? `Updated reseller ${id} — accès renouvelé jusqu'au ${body.accessExpiresAt.toISOString()}`
          : `Updated reseller ${id}`,
        "info",
        req.ip
      );
      return res.json(flattenReseller({ ...updated, quotaUsedBytes: alloue }, clientsCount, consomme));
    } else {
      const index = inMemoryDb.resellers.findIndex((r) => r.id === id);
      if (index === -1) return res.status(404).json({ error: "errors.resellers.not_found", message: "Reseller not found" });
      inMemoryDb.resellers[index] = { ...inMemoryDb.resellers[index], ...updateData, updatedAt: new Date() };
      const u = inMemoryDb.users.find((user) => user.id === inMemoryDb.resellers[index].userId);
      return res.json(flattenReseller({ ...inMemoryDb.resellers[index], user: u }, 0));
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    if (err instanceof PlafondQuotaDepasse) {
      return res.status(409).json({
        error: "errors.resellers.quota_below_allocated",
        message: "Le plafond ne peut pas etre inferieur au quota deja engage.",
        allocatedBytes: err.alloue.toString(),
      });
    }
    console.error("Update reseller error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to update reseller" });
  }
});

// DELETE /api/resellers/:id
// Le bouton « Supprimer » du dashboard appelait cette route, qui n'existait
// pas : la réponse était un 404 et le revendeur restait en place.
//
// Seule la fiche revendeur est retirée. Le compte utilisateur et ses clients
// sont conservés : les supprimer révoquerait des accès VPN en service, ce qui
// n'est pas ce que demande un retrait d'agrément.
router.delete(
  "/:id",
  requireAuth,
  gestionRevendeurs,
  interdireMutationSupport(),
  requirePermission("reseller.manage"),
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (prisma) {
      const fiche = await prisma.reseller.findUnique({ where: { id }, include: { user: { include: { role: true } } } });
      if (!fiche) return res.status(404).json({ error: "errors.resellers.not_found", message: "Reseller not found" });
      if (!canSeeUser(req, (fiche as any).user)) {
        return res.status(404).json({ error: "errors.resellers.not_found", message: "Reseller not found" });
      }
      const clientsCount = await prisma.vpnClient.count({ where: porteeClientsRevendeur(fiche) as any });
      await prisma.reseller.delete({ where: { id } });
      await logDbActivity(
        req.user?.userId || null,
        `Reseller removed: ${(fiche as any).user?.email || id} (${clientsCount} client(s) conservé(s))`,
        "warning",
        req.ip
      );
      return res.json({ success: true, id, clientsKept: clientsCount });
    }
    const index = inMemoryDb.resellers.findIndex((r) => r.id === id);
    if (index === -1) return res.status(404).json({ error: "errors.resellers.not_found", message: "Reseller not found" });
    inMemoryDb.resellers.splice(index, 1);
    return res.json({ success: true, id });
  } catch (err) {
    console.error("Delete reseller error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to delete reseller" });
  }
});

export default router;
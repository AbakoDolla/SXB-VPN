import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { prisma, logDbActivity } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";
import { sanitizeDevice, selectDeviceSubscription } from "../services/device-quota";
import { executerMutationQuota, PlafondQuotaDepasse } from "../services/reseller-quota";
import { synchroniserEtatAccesClient } from "../services/client-access-state";
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

function makeUserToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const part = () => Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join("");
  return `SXB-USER-${part()}-${part()}-${part()}`;
}

/**
 * Créer ou modifier un appareil relève de `clients.manage` (administration)
 * OU de `clients.create` (revendeur). N'exiger que la première fermait la
 * porte au revendeur, qui doit pouvoir enrôler ses propres appareils ;
 * n'exiger que la seconde l'ouvrirait à SUPPORT — arrêté juste avant par le
 * plafond de rôle, qui ne dépend d'aucune permission cochée en base.
 */
function requireDeviceWrite() {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "errors.auth.unauthorized", message: "Authorization required" });
    }
    if (req.user.role === "OWNER") return next();
    const autorise = req.user.permissions.includes("clients.manage") || req.user.permissions.includes("clients.create");
    if (!autorise) {
      return res.status(403).json({
        error: "errors.auth.forbidden_permission",
        message: "Missing required permission: clients.manage",
      });
    }
    return next();
  };
}

/** Charge un appareil et vérifie que le demandeur a le droit d'y toucher. */
async function chargerAppareilPossede(req: AuthenticatedRequest, id: string) {
  const client = await (prisma as any).vpnClient.findUnique({
    where: { id },
    include: { user: true, reseller: { include: { user: true } } },
  });
  if (!client) return { client: null as any, refus: null };
  if (req.user?.role === "RESELLER") {
    const fiche = (req as any).reseller ?? (await chargerFicheRevendeur(prisma, req.user.userId));
    if (!possedeClient(client, fiche)) return { client, refus: refusPropriete() };
  }
  return { client, refus: null };
}

// GET /api/devices — list all VPN clients with device info
router.get("/", requireAuth, requirePermission("clients.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "Database unavailable" });
    // Cloisonnement REVENDEUR — il ne voit que les appareils qu'il possède.
    // La propriété se lit sur `resellerId` (explicite) ou, pour le parc
    // historique, sur le compte utilisateur porteur.
    const isReseller = req.user?.role === "RESELLER";
    const fiche = isReseller ? await chargerFicheRevendeur(prisma, req.user?.userId) : null;
    const clients = await prisma.vpnClient.findMany({
      where: isReseller ? (porteeClientsRevendeur(fiche) as any) : undefined,
      include: {
        user: true,
        // Une seule jointure pour l'étiquette revendeur : la charger appareil
        // par appareil produirait 84 requêtes supplémentaires par affichage.
        reseller: { include: { user: { select: { id: true, name: true, email: true } } } },
        subscriptions: {
          where: { status: { not: "revoked" } },
          include: { devices: true },
          orderBy: [{ lastProvisionAt: "desc" }, { createdAt: "desc" }],
        },
      },
      orderBy: { createdAt: "desc" },
    });
    const ids = clients.map((client) => client.id);
    const usageRows = ids.length
      ? await (prisma as any).trafficUsage.findMany({
          where: { clientId: { in: ids } },
          select: { clientId: true, accountId: true, deviceId: true, download: true, upload: true, timestamp: true },
          orderBy: { timestamp: "desc" },
        })
      : [];
    const byClient = new Map<string, { download: bigint; upload: bigint; lastSeenAt: Date | null }>();
    const bySubscriptionDevice = new Map<string, { download: bigint; upload: bigint; lastSeenAt: Date | null }>();
    for (const row of usageRows as any[]) {
      const current = byClient.get(row.clientId) || { download: 0n, upload: 0n, lastSeenAt: null };
      current.download += BigInt(row.download || 0);
      current.upload += BigInt(row.upload || 0);
      if (!current.lastSeenAt && row.timestamp) current.lastSeenAt = new Date(row.timestamp);
      byClient.set(row.clientId, current);

      if (row.accountId) {
        const key = `${row.clientId}:${row.accountId}:${row.deviceId || ""}`;
        const scoped = bySubscriptionDevice.get(key) || { download: 0n, upload: 0n, lastSeenAt: null };
        scoped.download += BigInt(row.download || 0);
        scoped.upload += BigInt(row.upload || 0);
        if (!scoped.lastSeenAt && row.timestamp) scoped.lastSeenAt = new Date(row.timestamp);
        bySubscriptionDevice.set(key, scoped);
      }
    }
    return res.json({ devices: clients.map((client) => {
      const subscription = selectDeviceSubscription(client);
      const exactKey = subscription ? `${client.id}:${subscription.id}:${client.deviceId || ""}` : "";
      const scopedUsage = exactKey ? bySubscriptionDevice.get(exactKey) : undefined;
      return sanitizeDevice(client, scopedUsage || byClient.get(client.id), subscription);
    }) });
  } catch (err) {
    console.error("List devices error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

const generateSchema = z.object({
  deviceId: z.string().trim().min(6, "Device ID invalide").max(255),
  label: z.string().trim().min(1).max(120).optional(),
  durationDays: z.coerce.number().int().min(1).max(3650).default(365),
  // Les rôles supérieurs peuvent enrôler un appareil POUR un revendeur donné.
  resellerId: z.string().uuid().optional(),
}).strict();

const renewSchema = z.object({
  durationDays: z.coerce.number().int().min(1).max(3650).default(365),
}).strict();

// POST /api/devices/generate-token — generate activation token for a device ID
//
// Cette route crée UNIQUEMENT un compte appareil. Elle n'attribue ni forfait,
// ni profil VPN, ni quota : un appareil sans plan est un état légitime, et
// l'attribution d'un plan reste une action explicite (POST /api/subscriptions).
router.post(
  "/generate-token",
  requireAuth,
  interdireMutationSupport(),
  requireDeviceWrite(),
  exigerAccesRevendeur(),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!prisma) return res.status(503).json({ error: "Database unavailable" });
      const body = generateSchema.parse(req.body);

      // Rattachement commercial de l'appareil.
      let fiche: any = null;
      if (req.user?.role === "RESELLER") {
        fiche = (req as any).reseller ?? (await chargerFicheRevendeur(prisma, req.user.userId));
        // Un revendeur ne peut jamais enrôler sous un autre revendeur.
        if (body.resellerId && fiche?.id && body.resellerId !== fiche.id) {
          const refus = refusPropriete();
          return res.status(refus.status).json(refus.body);
        }
      } else if (body.resellerId) {
        if (!estRoleSuperieur(req.user?.role)) {
          const refus = refusPropriete();
          return res.status(refus.status).json(refus.body);
        }
        fiche = await (prisma as any).reseller.findUnique({
          where: { id: body.resellerId },
          include: { user: true },
        });
        if (!fiche) {
          return res.status(404).json({ error: "errors.resellers.not_found", message: "Revendeur introuvable" });
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

      // Check if device already has a token
      const existing = await (prisma as any).vpnClient.findFirst({
        where: { deviceId: body.deviceId },
        include: { user: true, reseller: { include: { user: true } } },
      });
      if (existing) {
        const peutVoirJeton =
          estRoleSuperieur(req.user?.role) ||
          (req.user?.role === "RESELLER" && possedeClient(existing, fiche));
        return res.status(409).json({
          error: "DEVICE_ALREADY_REGISTERED",
          code: "DEVICE_ALREADY_REGISTERED",
          message: "Cet appareil a déjà un token actif",
          ...(peutVoirJeton ? { device: sanitizeDevice(existing) } : {}),
        });
      }

      // Generate unique token SXB-USER-XXXX-XXXX-XXXX
      let tokenStr = makeUserToken();
      let attempts = 0;
      while (attempts < 10) {
        const taken = await prisma.vpnClient.findUnique({ where: { token: tokenStr } });
        if (!taken) break;
        tokenStr = makeUserToken();
        attempts++;
      }
      if (attempts === 10) {
        return res.status(503).json({
          error: "TOKEN_GENERATION_UNAVAILABLE",
          message: "Impossible de générer un jeton unique pour le moment",
        });
      }

      // Un appareil est un client, pas un revendeur. Le rôle RESELLER utilisé ici
      // auparavant accordait à chaque téléphone enrôlé clients.create,
      // tokens.create et subscription.manage : de quoi se fabriquer du quota.
      const clientRole =
        (await prisma.role.findFirst({ where: { name: "CLIENT" } })) ??
        (await prisma.role.findFirst({ where: { name: "USER" } }));
      if (!clientRole) return res.status(500).json({ error: "Role CLIENT introuvable" });

      const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);
      const labelName = body.label || `Appareil ${body.deviceId.slice(0, 12)}`;
      const deviceFingerprint = crypto
        .createHash("sha256")
        .update(body.deviceId)
        .digest("hex")
        .slice(0, 32);
      const email = `device.${deviceFingerprint}@sxbvpn.local`;

      const expireAt = new Date();
      expireAt.setDate(expireAt.getDate() + body.durationDays);

      const client = await executerMutationQuota(prisma, {
        resellerUserId: fiche?.userId ?? null,
        resellerId: fiche?.id ?? null,
        auteur: { userId: req.user?.userId, email: req.user?.email },
        reason: `Enrôlement de l'appareil ${deviceFingerprint}`,
        referenceType: "vpn_client",
      }, async (tx) => {
        let deviceUser = await tx.user.findUnique({ where: { email } });
        if (!deviceUser) {
          deviceUser = await tx.user.create({
            data: {
              name: labelName,
              email,
              passwordHash,
              roleId: clientRole.id,
              status: "active",
            },
          });
        }
        return tx.vpnClient.create({
          data: {
            userId: deviceUser.id,
            token: tokenStr,
            deviceId: body.deviceId,
            expireAt,
            status: "active",
            // Propriété commerciale explicite. Aucun quota, aucun forfait : le
            // plafond du revendeur n'est engagé qu'à l'attribution d'un plan.
            resellerId: fiche?.id ?? null,
          },
          include: { user: true, reseller: { include: { user: true } } },
        });
      });

      await logDbActivity(
        req.user?.userId || null,
        `Jeton généré pour l'appareil ${deviceFingerprint} (expire ${expireAt.toLocaleDateString()})`,
        "success",
        req.ip
      );

      return res.status(201).json(sanitizeDevice(client));
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: "Validation", details: err.issues });
      console.error("Generate device token error:", err);
      return res.status(500).json({ error: "Server error" });
    }
  }
);

// POST /api/devices/:id/revoke
// Action RÉDUCTRICE : elle reste ouverte quand le plafond est atteint, puisque
// c'est l'un des moyens d'en sortir.
router.post(
  "/:id/revoke",
  requireAuth,
  interdireMutationSupport(),
  requireDeviceWrite(),
  exigerAccesRevendeur({ autoriserReduction: true }),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!prisma) return res.status(503).json({ error: "Database unavailable" });
      const { client: existing, refus } = await chargerAppareilPossede(req, req.params.id);
      if (!existing) return res.status(404).json({ error: "Appareil introuvable" });
      if (refus) return res.status(refus.status).json(refus.body);
      const client = await executerMutationQuota(prisma, {
        resellerUserId: existing.userId,
        resellerId: existing.resellerId ?? null,
        auteur: { userId: req.user?.userId, email: req.user?.email },
        reason: `Suspension de l'appareil ${existing.id}`,
        referenceType: "vpn_client",
        referenceId: existing.id,
        autoriserReductionAuDessusDuPlafond: true,
      }, async (tx) => {
        const result = await (tx as any).vpnClient.update({
          where: { id: req.params.id },
          data: { status: "suspended" },
          include: { user: true, reseller: { include: { user: true } } },
        });
        await synchroniserEtatAccesClient(tx, existing.id, "suspended");
        return result;
      });
      await logDbActivity(req.user?.userId || null, `Appareil suspendu: ${client.id}`, "warning", req.ip);
      return res.json(sanitizeDevice(client));
    } catch (err) {
      if (err instanceof PlafondQuotaDepasse) {
        return res.status(409).json(reponsePlafondDepasse(err.alloue, err.plafond));
      }
      console.error("Revoke device error:", err);
      return res.status(500).json({ error: "Server error" });
    }
  }
);

// POST /api/devices/:id/renew — extend by durationDays
router.post(
  "/:id/renew",
  requireAuth,
  interdireMutationSupport(),
  requireDeviceWrite(),
  exigerAccesRevendeur(),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!prisma) return res.status(503).json({ error: "Database unavailable" });
      const { durationDays } = renewSchema.parse(req.body);
      const { client: existing, refus } = await chargerAppareilPossede(req, req.params.id);
      if (!existing) return res.status(404).json({ error: "Appareil introuvable" });
      if (refus) return res.status(refus.status).json(refus.body);
      const ficheCible = existing.reseller ?? (req as any).reseller ?? null;
      if (ficheCible) {
        const plafond = await refusSiPlafondAtteint(prisma, {
          role: "RESELLER",
          userId: ficheCible.userId,
          fiche: ficheCible,
        });
        if (plafond) return res.status(plafond.status).json(plafond.body);
      }

      const base = existing.expireAt && new Date(existing.expireAt) > new Date() ? new Date(existing.expireAt) : new Date();
      const newExpiry = new Date(base);
      newExpiry.setDate(newExpiry.getDate() + durationDays);

      const client = await executerMutationQuota(prisma, {
        resellerUserId: existing.userId,
        resellerId: existing.resellerId ?? null,
        auteur: { userId: req.user?.userId, email: req.user?.email },
        reason: `Renouvellement de l'appareil ${existing.id}`,
        referenceType: "vpn_client",
        referenceId: existing.id,
      }, async (tx) => {
        const result = await (tx as any).vpnClient.update({
          where: { id: req.params.id },
          data: { status: "active", expireAt: newExpiry },
          include: { user: true, reseller: { include: { user: true } } },
        });
        await synchroniserEtatAccesClient(tx, existing.id, "active");
        return result;
      });
      await logDbActivity(
        req.user?.userId || null,
        `Appareil renouvelé: ${client.id} → expire ${newExpiry.toLocaleDateString()}`,
        "success",
        req.ip
      );
      return res.json(sanitizeDevice(client));
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: "Validation", details: err.issues });
      if (err instanceof PlafondQuotaDepasse) {
        return res.status(409).json(reponsePlafondDepasse(err.alloue, err.plafond));
      }
      console.error("Renew device error:", err);
      return res.status(500).json({ error: "Server error" });
    }
  }
);

export default router;

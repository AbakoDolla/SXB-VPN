import { randomInt, randomUUID } from "crypto";
import { Response, Router } from "express";
import { z } from "zod";
import { inMemoryDb, logDbActivity, prisma } from "../database";
import { AuthenticatedRequest, requireAuth, requirePermission } from "../middleware/auth";
import { canSeeUser } from "../middleware/rbac/owner";
import {
  chargerFicheProprietaireClient,
  chargerFicheRevendeur,
  exigerAccesRevendeur,
  interdireMutationSupport,
  possedeClient,
  refusPourEtatAcces,
  refusPropriete,
  reponsePlafondDepasse,
  resumerAccesRevendeur,
} from "../services/reseller-access";
import { executerMutationQuota, PlafondQuotaDepasse } from "../services/reseller-quota";
import {
  appliquerVoucherAuClient,
  VoucherRedemptionError,
} from "../services/voucher-redemption";

const router = Router();
const GIB = BigInt(1024) ** BigInt(3);
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_GENERATION_ATTEMPTS = 10;

const createVoucherSchema = z.object({
  quotaGb: z.coerce.number().int().min(1).max(1_000_000).default(50),
  durationDays: z.coerce.number().int().min(1).max(3_650).default(30),
  activationDays: z.coerce.number().int().min(1).max(3_650).default(90),
  count: z.coerce.number().int().min(1).max(50).default(1),
  resellerId: z.string().trim().min(1).optional(),
}).strict();

const redeemVoucherSchema = z.object({
  code: z.string()
    .trim()
    .transform((value) => value.toUpperCase())
    .refine((value) => /^VCH-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(value), {
      message: "Format de voucher invalide",
    }),
  clientId: z.string().trim().min(1),
}).strict();

type RouteRefusal = { status: number; body: Record<string, unknown> };

function makeVoucherCode(): string {
  const segment = () =>
    Array.from(
      { length: 5 },
      () => CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)]
    ).join("");
  return `VCH-${segment()}-${segment()}`;
}

function isVoucherCollision(error: any): boolean {
  if (error?.code !== "P2002") return false;
  const target = Array.isArray(error?.meta?.target)
    ? error.meta.target.join(",")
    : String(error?.meta?.target ?? "");
  return !target || target.includes("code");
}

function effectiveStatus(voucher: any): "active" | "used" | "revoked" | "expired" {
  if (voucher?.isRedeemed || voucher?.status === "used") return "used";
  if (voucher?.status === "revoked") return "revoked";
  const expiry = voucher?.expiresAt ? new Date(voucher.expiresAt).getTime() : null;
  if (expiry !== null && !Number.isNaN(expiry) && expiry <= Date.now()) return "expired";
  return "active";
}

function sanitizeVoucher(voucher: any) {
  if (!voucher) return null;
  const reseller = voucher.reseller
    ? {
        id: voucher.reseller.id,
        name: voucher.reseller.user?.name ?? null,
        email: voucher.reseller.user?.email ?? null,
      }
    : null;
  const redeemedClient = voucher.redeemedClient
    ? {
        id: voucher.redeemedClient.id,
        name: voucher.redeemedClient.user?.name ?? null,
        email: voucher.redeemedClient.user?.email ?? null,
      }
    : null;
  return {
    id: voucher.id,
    code: voucher.code,
    quota: BigInt(voucher.quota ?? 0).toString(),
    durationDays: voucher.durationDays,
    isRedeemed: Boolean(voucher.isRedeemed),
    status: effectiveStatus(voucher),
    expiresAt: voucher.expiresAt ?? null,
    redeemedBy: voucher.redeemedBy ?? null,
    redeemedClientId: voucher.redeemedClientId ?? null,
    redeemedClient,
    resellerId: voucher.resellerId ?? null,
    reseller,
    createdAt: voucher.createdAt,
    updatedAt: voucher.updatedAt,
  };
}

async function chargerProprietaireCreation(
  req: AuthenticatedRequest,
  requestedResellerId?: string
): Promise<any | RouteRefusal> {
  if (req.user?.role === "RESELLER") {
    const fiche =
      (req as any).reseller ??
      (await chargerFicheRevendeur(prisma, req.user.userId));
    if (!fiche) {
      return {
        status: 403,
        body: {
          error: "errors.resellers.not_found",
          message: "Aucune fiche revendeur : impossible d'émettre un voucher.",
        },
      };
    }
    if (requestedResellerId && requestedResellerId !== fiche.id) {
      return refusPropriete();
    }
    return fiche;
  }

  if (!requestedResellerId) {
    return {
      status: 400,
      body: {
        error: "errors.vouchers.reseller_required",
        message: "Sélectionnez le revendeur dont l'enveloppe financera ce voucher.",
      },
    };
  }
  const fiche = prisma
    ? await prisma.reseller.findUnique({
        where: { id: requestedResellerId },
        include: { user: { include: { role: true } } },
      })
    : inMemoryDb.resellers.find((candidate: any) => candidate.id === requestedResellerId);
  if (!fiche || !canSeeUser(req, fiche.user)) {
    return {
      status: 404,
      body: { error: "errors.resellers.not_found", message: "Revendeur introuvable" },
    };
  }
  const accessError = refusPourEtatAcces(resumerAccesRevendeur(fiche));
  return accessError ?? fiche;
}

async function resellerScope(req: AuthenticatedRequest) {
  if (req.user?.role !== "RESELLER") return undefined;
  const fiche =
    (req as any).reseller ??
    (await chargerFicheRevendeur(prisma, req.user.userId));
  return { resellerId: fiche?.id ?? "__missing_reseller__" };
}

router.get(
  "/",
  requireAuth,
  requirePermission("vouchers.view"),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      let vouchers: any[];
      if (prisma) {
        vouchers = await prisma.voucher.findMany({
          where: await resellerScope(req),
          include: {
            reseller: { include: { user: true } },
            redeemedClient: { include: { user: true } },
          },
          orderBy: { createdAt: "desc" },
        });
      } else {
        vouchers = [...inMemoryDb.vouchers];
        if (req.user?.role === "RESELLER") {
          const fiche = await chargerFicheRevendeur(null, req.user.userId);
          vouchers = vouchers.filter((voucher: any) => voucher.resellerId === fiche?.id);
        }
      }
      return res.json({ vouchers: vouchers.map(sanitizeVoucher) });
    } catch (error) {
      console.error("Fetch vouchers error:", error);
      return res.status(500).json({
        error: "errors.server",
        message: "Failed to fetch vouchers",
      });
    }
  }
);

router.post(
  "/",
  requireAuth,
  interdireMutationSupport(),
  requirePermission("vouchers.create"),
  exigerAccesRevendeur(),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const body = createVoucherSchema.parse(req.body);
      const fiche = await chargerProprietaireCreation(req, body.resellerId);
      if ("status" in fiche && "body" in fiche) {
        return res.status(fiche.status).json(fiche.body);
      }

      const quotaBytes = BigInt(body.quotaGb) * GIB;
      const expiresAt = new Date();
      expiresAt.setUTCDate(expiresAt.getUTCDate() + body.activationDays);
      let created: any[] | null = null;

      if (prisma) {
        for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
          const candidates = Array.from({ length: body.count }, () => ({
            id: randomUUID(),
            code: makeVoucherCode(),
          }));
          if (new Set(candidates.map((candidate) => candidate.code)).size !== body.count) {
            continue;
          }
          try {
            created = await executerMutationQuota(
              prisma,
              {
                resellerId: fiche.id,
                resellerUserId: fiche.userId,
                auteur: { userId: req.user?.userId, email: req.user?.email },
                reason: `Émission de ${body.count} voucher(s)`,
                referenceType: "voucher_batch",
                referenceId: randomUUID(),
              },
              async (tx) => {
                const rows = [];
                for (const candidate of candidates) {
                  rows.push(
                    await tx.voucher.create({
                      data: {
                        ...candidate,
                        quota: quotaBytes,
                        durationDays: body.durationDays,
                        expiresAt,
                        resellerId: fiche.id,
                        isRedeemed: false,
                        status: "active",
                      },
                    })
                  );
                }
                return rows;
              }
            );
            break;
          } catch (error) {
            if (!isVoucherCollision(error)) throw error;
          }
        }
      } else {
        created = [];
        for (let index = 0; index < body.count; index += 1) {
          let code = makeVoucherCode();
          let attempt = 1;
          while (
            inMemoryDb.vouchers.some((voucher) => voucher.code === code) &&
            attempt < MAX_GENERATION_ATTEMPTS
          ) {
            code = makeVoucherCode();
            attempt += 1;
          }
          if (inMemoryDb.vouchers.some((voucher) => voucher.code === code)) {
            created = null;
            break;
          }
          const voucher = {
            id: randomUUID(),
            code,
            quota: quotaBytes,
            durationDays: body.durationDays,
            expiresAt,
            resellerId: fiche.id,
            isRedeemed: false,
            status: "active" as const,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          inMemoryDb.vouchers.push(voucher);
          created.push(voucher);
        }
      }

      if (!created) {
        return res.status(503).json({
          error: "errors.vouchers.generation_failed",
          message: "Impossible de générer des codes uniques. Veuillez réessayer.",
        });
      }
      await logDbActivity(
        req.user?.userId || null,
        `Created ${created.length} voucher record(s) for reseller ID: ${fiche.id}`,
        "success",
        req.ip
      );
      return res.status(201).json({ vouchers: created.map(sanitizeVoucher) });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "errors.validation", message: error.issues });
      }
      if (error instanceof PlafondQuotaDepasse) {
        return res.status(409).json(reponsePlafondDepasse(error.alloue, error.plafond));
      }
      if (error?.code === "P2034") {
        return res.status(409).json({
          error: "errors.vouchers.concurrent_change",
          message: "L'enveloppe du revendeur a changé. Veuillez réessayer.",
        });
      }
      console.error("Create voucher error:", error);
      return res.status(500).json({
        error: "errors.server",
        message: "Failed to create voucher(s)",
      });
    }
  }
);

router.post(
  "/redeem",
  requireAuth,
  interdireMutationSupport(),
  requirePermission("vouchers.redeem"),
  exigerAccesRevendeur(),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const body = redeemVoucherSchema.parse(req.body);
      const [voucher, client] = prisma
        ? await Promise.all([
            prisma.voucher.findUnique({ where: { code: body.code } }),
            prisma.vpnClient.findUnique({
              where: { id: body.clientId },
              include: {
                user: { include: { role: true } },
                reseller: { include: { user: true } },
              },
            }),
          ])
        : [
            inMemoryDb.vouchers.find((candidate) => candidate.code === body.code),
            inMemoryDb.vpnClients.find((candidate) => candidate.id === body.clientId),
          ];
      if (!voucher) {
        return res.status(404).json({
          error: "errors.vouchers.not_found",
          message: "Code voucher introuvable",
        });
      }
      if (!client || !canSeeUser(req, client.user)) {
        return res.status(404).json({
          error: "errors.clients.not_found",
          message: "Compte VPN introuvable",
        });
      }

      const fiche = await chargerFicheProprietaireClient(prisma, client);
      if (req.user?.role === "RESELLER") {
        const ownRecord =
          (req as any).reseller ??
          (await chargerFicheRevendeur(prisma, req.user.userId));
        if (
          !possedeClient(client, ownRecord) ||
          (voucher.resellerId && voucher.resellerId !== ownRecord?.id)
        ) {
          return res.status(404).json({
            error: "errors.vouchers.not_found",
            message: "Code voucher introuvable",
          });
        }
      }
      if (voucher.resellerId && voucher.resellerId !== fiche?.id) {
        return res.status(409).json({
          error: "errors.vouchers.owner_mismatch",
          message: "Ce voucher appartient à un autre revendeur.",
        });
      }
      const accessError = fiche ? refusPourEtatAcces(resumerAccesRevendeur(fiche)) : null;
      if (accessError) return res.status(accessError.status).json(accessError.body);

      if (prisma) {
        await appliquerVoucherAuClient(prisma, {
          voucherId: voucher.id,
          clientId: client.id,
          resellerId: fiche?.id,
          resellerUserId: fiche?.userId,
          actorUserId: req.user?.userId,
          actorEmail: req.user?.email,
        });
      } else {
        const subscriptions = inMemoryDb.subscriptions.filter(
          (subscription: any) => subscription.clientId === client.id
        );
        if (subscriptions.length > 0) {
          throw new VoucherRedemptionError(
            "errors.vouchers.subscription_required",
            409,
            "Ce client possède déjà un forfait. Utilisez un jeton data lié explicitement à ce forfait."
          );
        }
        if (effectiveStatus(voucher) !== "active") {
          throw new VoucherRedemptionError(
            "errors.vouchers.state_changed",
            409,
            "Ce voucher n'est plus disponible."
          );
        }
        voucher.isRedeemed = true;
        voucher.status = "used";
        voucher.redeemedBy = req.user?.userId;
        voucher.redeemedClientId = client.id;
        client.quotaTotal = BigInt(client.quotaTotal ?? 0) + BigInt(voucher.quota);
        const current = client.expireAt ? new Date(client.expireAt).getTime() : Number.NaN;
        const base = Number.isFinite(current) && current > Date.now() ? current : Date.now();
        client.expireAt = new Date(base + voucher.durationDays * 86_400_000);
        client.status = "active";
      }

      await logDbActivity(
        req.user?.userId || null,
        `Redeemed voucher ID: ${voucher.id} on client ID: ${client.id}`,
        "success",
        req.ip
      );
      return res.json({
        success: true,
        message: "Voucher appliqué au client",
        quotaAdded: Number(BigInt(voucher.quota)) / 1024 ** 3,
        durationDays: voucher.durationDays,
      });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "errors.validation", message: error.issues });
      }
      if (error instanceof VoucherRedemptionError) {
        return res.status(error.status).json({ error: error.code, message: error.message });
      }
      if (error instanceof PlafondQuotaDepasse) {
        return res.status(409).json(reponsePlafondDepasse(error.alloue, error.plafond));
      }
      if (error?.code === "P2034") {
        return res.status(409).json({
          error: "errors.vouchers.state_changed",
          message: "Le voucher a été modifié par une autre requête.",
        });
      }
      console.error("Redeem voucher error:", error);
      return res.status(500).json({
        error: "errors.server",
        message: "Failed to redeem voucher",
      });
    }
  }
);

router.post(
  "/:id/revoke",
  requireAuth,
  interdireMutationSupport(),
  requirePermission("vouchers.revoke"),
  exigerAccesRevendeur({ autoriserReduction: true }),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const voucher = prisma
        ? await prisma.voucher.findUnique({
            where: { id: req.params.id },
            include: { reseller: { include: { user: { include: { role: true } } } } },
          })
        : inMemoryDb.vouchers.find((candidate) => candidate.id === req.params.id);
      if (!voucher) {
        return res.status(404).json({ error: "errors.vouchers.not_found" });
      }
      if (
        req.user?.role === "RESELLER" &&
        voucher.resellerId !==
          ((req as any).reseller ??
            (await chargerFicheRevendeur(prisma, req.user.userId)))?.id
      ) {
        return res.status(404).json({ error: "errors.vouchers.not_found" });
      }
      if (voucher.isRedeemed || voucher.status === "used") {
        return res.status(409).json({
          error: "errors.vouchers.already_redeemed",
          message: "Un voucher déjà appliqué ne peut plus être révoqué.",
        });
      }
      if (voucher.status === "revoked") return res.json(sanitizeVoucher(voucher));

      let updated: any;
      if (prisma) {
        const revoke = async (tx: any) => {
          const result = await tx.voucher.updateMany({
            where: {
              id: voucher.id,
              isRedeemed: false,
              status: "active",
            },
            data: { status: "revoked" },
          });
          if (result.count !== 1) {
            throw new VoucherRedemptionError(
              "errors.vouchers.state_changed",
              409,
              "Le voucher vient d'être utilisé ou révoqué."
            );
          }
          return tx.voucher.findUnique({ where: { id: voucher.id } });
        };
        updated = voucher.reseller
          ? await executerMutationQuota(
              prisma,
              {
                resellerId: voucher.reseller.id,
                resellerUserId: voucher.reseller.userId,
                auteur: { userId: req.user?.userId, email: req.user?.email },
                reason: "Révocation d'un voucher non utilisé",
                referenceType: "voucher",
                referenceId: voucher.id,
                autoriserReductionAuDessusDuPlafond: true,
              },
              revoke
            )
          : await prisma.$transaction(revoke, { isolationLevel: "Serializable" });
      } else {
        voucher.status = "revoked";
        voucher.updatedAt = new Date();
        updated = voucher;
      }

      await logDbActivity(
        req.user?.userId || null,
        `Revoked voucher ID: ${voucher.id}`,
        "warning",
        req.ip
      );
      return res.json(sanitizeVoucher(updated));
    } catch (error: any) {
      if (error instanceof VoucherRedemptionError) {
        return res.status(error.status).json({ error: error.code, message: error.message });
      }
      if (error?.code === "P2034") {
        return res.status(409).json({
          error: "errors.vouchers.state_changed",
          message: "Le voucher a été modifié par une autre requête.",
        });
      }
      console.error("Revoke voucher error:", error);
      return res.status(500).json({
        error: "errors.server",
        message: "Failed to revoke voucher",
      });
    }
  }
);

export default router;

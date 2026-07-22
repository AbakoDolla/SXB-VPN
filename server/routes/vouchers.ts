/**
 * Vouchers Route — /api/vouchers
 * Codes de recharge prépayés (VPN quota).
 * Génération de code côté serveur avec crypto.randomBytes (plus Math.random).
 */
import { Router, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { prisma, inMemoryDb, logDbActivity } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";

const router = Router();

// Génère un code de voucher sécurisé côté serveur
function makeVoucherCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const segment = (len: number) =>
    Array.from(crypto.randomBytes(len))
      .map((b) => chars[b % chars.length])
      .join("");
  return `VCH-${segment(5)}-${segment(5)}`;
}

const createVoucherSchema = z.object({
  quotaGb: z.coerce.number().min(1).default(50),
  durationDays: z.coerce.number().min(1).default(30),
  count: z.coerce.number().min(1).max(50).default(1), // Créer 1 à 50 vouchers à la fois
});

const redeemVoucherSchema = z.object({
  code: z.string().trim().toUpperCase(),
  clientId: z.string(), // Client VPN qui reçoit le quota
});

// Helper to sanitize BigInt for JSON response
function sanitizeVoucher(vouch: any) {
  if (!vouch) return null;
  return {
    ...vouch,
    quota: vouch.quota ? vouch.quota.toString() : "0",
  };
}

// GET /api/vouchers
router.get("/", requireAuth, requirePermission("vouchers.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    let vouchers: any[] = [];
    if (prisma) {
      vouchers = await prisma.voucher.findMany({
        orderBy: { createdAt: "desc" },
      });
    } else {
      vouchers = inMemoryDb.vouchers;
    }
    return res.json({ vouchers: vouchers.map(sanitizeVoucher) });
  } catch (err) {
    console.error("Fetch vouchers error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch vouchers" });
  }
});

// POST /api/vouchers — crée 1 à 50 vouchers d'un coup
router.post("/", requireAuth, requirePermission("vouchers.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = createVoucherSchema.parse(req.body);
    const quotaBytes = BigInt(body.quotaGb) * BigInt(1024 * 1024 * 1024);
    const created: any[] = [];

    for (let i = 0; i < body.count; i++) {
      const code = makeVoucherCode();
      if (prisma) {
        const newVoucher = await prisma.voucher.create({
          data: {
            code,
            quota: quotaBytes,
            durationDays: body.durationDays,
            isRedeemed: false,
          },
        });
        created.push(newVoucher);
      } else {
        const newVoucher = {
          id: `vouch-${Date.now()}-${i}`,
          code,
          quota: quotaBytes,
          durationDays: body.durationDays,
          isRedeemed: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        inMemoryDb.vouchers.push(newVoucher as any);
        created.push(newVoucher);
      }
    }

    await logDbActivity(
      req.user?.userId || null,
      `Created ${body.count} Voucher(s) (${body.quotaGb}GB × ${body.durationDays}d)`,
      "success",
      req.ip
    );

    return res.status(201).json({ vouchers: created.map(sanitizeVoucher) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    console.error("Create voucher error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to create voucher(s)" });
  }
});

// POST /api/vouchers/redeem — activation d'un voucher sur un compte VPN
router.post("/redeem", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = redeemVoucherSchema.parse(req.body);
    let voucher: any = null;
    let vpnClient: any = null;

    if (prisma) {
      voucher = await prisma.voucher.findUnique({ where: { code: body.code } });
      vpnClient = await prisma.vpnClient.findUnique({ where: { id: body.clientId } });
    } else {
      voucher = inMemoryDb.vouchers.find((v) => v.code === body.code);
      vpnClient = inMemoryDb.vpnClients.find((c) => c.id === body.clientId);
    }

    if (!voucher) {
      return res.status(404).json({ error: "errors.vouchers.not_found", message: "Code voucher introuvable" });
    }
    if (voucher.isRedeemed) {
      return res.status(400).json({ error: "errors.vouchers.already_redeemed", message: "Ce voucher a déjà été utilisé" });
    }
    if (!vpnClient) {
      return res.status(404).json({ error: "errors.clients.not_found", message: "Compte VPN introuvable" });
    }

    // Appliquer le quota au compte VPN
    if (prisma) {
      await prisma.$transaction([
        prisma.voucher.update({
          where: { id: voucher.id },
          data: { isRedeemed: true, redeemedBy: req.user?.userId },
        }),
        prisma.vpnClient.update({
          where: { id: body.clientId },
          data: {
            quotaTotal: {
              increment: voucher.quota,
            },
            // Étendre la date d'expiration
            expireAt: new Date(
              Math.max(Date.now(), new Date(vpnClient.expireAt).getTime()) +
                voucher.durationDays * 24 * 60 * 60 * 1000
            ),
          },
        }),
      ]);
    } else {
      voucher.isRedeemed = true;
      voucher.redeemedBy = req.user?.userId;
      const client = inMemoryDb.vpnClients.find((c) => c.id === body.clientId);
      if (client) {
        client.quotaTotal = client.quotaTotal + voucher.quota;
        const currentExpiry = Math.max(Date.now(), new Date(client.expireAt).getTime());
        client.expireAt = new Date(currentExpiry + voucher.durationDays * 24 * 60 * 60 * 1000);
      }
    }

    const quotaAddedGb = Number(voucher.quota) / (1024 * 1024 * 1024);
    await logDbActivity(
      req.user?.userId || null,
      `Voucher ${body.code} activé sur le client ${body.clientId} (+${quotaAddedGb.toFixed(0)} GB)`,
      "success",
      req.ip
    );

    return res.json({
      success: true,
      message: `Voucher activé : +${quotaAddedGb.toFixed(0)} GB et +${voucher.durationDays} jours ajoutés`,
      quotaAdded: quotaAddedGb,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    console.error("Redeem voucher error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to redeem voucher" });
  }
});

// POST /api/vouchers/use — activation simple (associe le voucher à l'utilisateur connecté, sans clientId)
const useVoucherSchema = z.object({
  code: z.string().trim().toUpperCase(),
});

router.post("/use", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = useVoucherSchema.parse(req.body);
    let voucher: any = null;

    if (prisma) {
      voucher = await prisma.voucher.findUnique({ where: { code: body.code } });
    } else {
      voucher = inMemoryDb.vouchers.find((v) => v.code === body.code);
    }

    if (!voucher) {
      return res.status(404).json({ error: "errors.vouchers.not_found", message: "Code voucher introuvable" });
    }
    if (voucher.isRedeemed) {
      return res.status(400).json({ error: "errors.vouchers.already_redeemed", message: "Ce voucher a déjà été utilisé" });
    }

    let updated: any = null;
    if (prisma) {
      updated = await prisma.voucher.update({
        where: { id: voucher.id },
        data: { isRedeemed: true, redeemedBy: req.user?.userId },
      });
    } else {
      voucher.isRedeemed = true;
      voucher.redeemedBy = req.user?.userId;
      voucher.updatedAt = new Date();
      updated = voucher;
    }

    await logDbActivity(req.user?.userId || null, `Activated voucher code: ${body.code}`, "success", req.ip);
    return res.json(sanitizeVoucher(updated));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    console.error("Use voucher error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to activate voucher" });
  }
});

export default router;

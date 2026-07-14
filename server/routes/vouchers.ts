import { Router, Response } from "express";
import { z } from "zod";
import { prisma, inMemoryDb, logDbActivity } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";

const router = Router();

const createVoucherSchema = z.object({
  code: z.string().min(5).toUpperCase(),
  quotaGb: z.coerce.number().min(1).default(50),
  durationDays: z.coerce.number().min(1).default(30),
});

const redeemVoucherSchema = z.object({
  code: z.string().trim().toUpperCase(),
  clientId: z.string(), // Client who receives the quota
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
    return res.json(vouchers.map(sanitizeVoucher));
  } catch (err) {
    console.error("Fetch vouchers error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch vouchers" });
  }
});

// POST /api/vouchers
router.post("/", requireAuth, requirePermission("vouchers.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = createVoucherSchema.parse(req.body);
    const quotaBytes = BigInt(body.quotaGb) * BigInt(1024 * 1024 * 1024);

    let existing = false;
    if (prisma) {
      existing = !!(await prisma.voucher.findUnique({ where: { code: body.code } }));
    } else {
      existing = inMemoryDb.vouchers.some((v) => v.code === body.code);
    }

    if (existing) {
      return res.status(400).json({ error: "errors.vouchers.exists", message: "Voucher code already exists" });
    }

    let newVoucher: any = null;
    if (prisma) {
      newVoucher = await prisma.voucher.create({
        data: {
          code: body.code,
          quota: quotaBytes,
          durationDays: body.durationDays,
          isRedeemed: false,
        },
      });
    } else {
      newVoucher = {
        id: `vouch-${Date.now()}`,
        code: body.code,
        quota: quotaBytes,
        durationDays: body.durationDays,
        isRedeemed: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      inMemoryDb.vouchers.push(newVoucher);
    }

    await logDbActivity(req.user?.userId || null, `Created Promo Voucher Code: ${body.code} (${body.quotaGb}GB)`, "success", req.ip);
    return res.status(201).json(sanitizeVoucher(newVoucher));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    console.error("Create voucher error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to create voucher" });
  }
});

// POST /api/vouchers/redeem
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
      return res.status(404).json({ error: "errors.vouchers.not_found", message: "Promotional voucher code not found" });
    }

    if (voucher.isRedeemed) {
      return res.status(400).json({ error: "errors.vouchers.already_redeemed", message: "Voucher code has already been redeemed" });
    }

    if (!vpnClient) {
      return res.status(404).json({ error: "errors.clients.not_found", message: "VPN Client target not found" });
    }

    // Bound checking: Reseller can only redeem vouchers for their own clients
    if (req.user?.role === "RESELLER" && vpnClient.userId !== req.user?.userId) {
      return res.status(403).json({ error: "errors.auth.forbidden", message: "Cannot redeem coupons for third-party clients" });
    }

    // Extend Client's quota and expiration date
    const extensionMs = voucher.durationDays * 24 * 60 * 60 * 1000;
    const currentExpiry = new Date(vpnClient.expireAt);
    const newExpiry = new Date(Math.max(Date.now(), currentExpiry.getTime()) + extensionMs);

    let updatedVoucher: any = null;
    if (prisma) {
      // Execute in transactions for atomic safety in production postgresql
      await prisma.$transaction([
        prisma.voucher.update({
          where: { id: voucher.id },
          data: { isRedeemed: true, redeemedBy: body.clientId },
        }),
        prisma.vpnClient.update({
          where: { id: body.clientId },
          data: {
            quotaTotal: { increment: voucher.quota },
            expireAt: newExpiry,
            status: "active",
          },
        }),
      ]);

      updatedVoucher = await prisma.voucher.findUnique({ where: { id: voucher.id } });
    } else {
      // Memory DB redemption
      voucher.isRedeemed = true;
      voucher.redeemedBy = body.clientId;
      voucher.updatedAt = new Date();

      vpnClient.quotaTotal += voucher.quota;
      vpnClient.expireAt = newExpiry;
      vpnClient.status = "active";
      vpnClient.updatedAt = new Date();

      updatedVoucher = voucher;
    }

    await logDbActivity(req.user?.userId || null, `Redeemed Coupon Voucher ${body.code} to VPN Client ID ${body.clientId}`, "success", req.ip);

    return res.json({
      success: true,
      message: `Coupon code verified! Added ${(Number(voucher.quota) / (1024 * 1024 * 1024)).toFixed(1)} GB and extended lease by ${voucher.durationDays} days.`,
      voucher: sanitizeVoucher(updatedVoucher),
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    console.error("Redeem voucher error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to redeem voucher" });
  }
});

export default router;

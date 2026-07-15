import { Router, Response } from "express";
import { z } from "zod";
import { prisma, inMemoryDb, logDbActivity } from "../database";
import { generateTokens, requireAuth, AuthenticatedRequest } from "../middleware/auth";
import { XPanelService } from "../services/xpanel";

const router = Router();

// -------------------------------------------------------------------------
// SXB VPN Mobile API
// Dedicated, token-only surface for the official mobile app. End users never
// see servers/IP/protocol details - they only ever handle two token formats:
//   - Account token:  SXB-USER-XXXX-XXXX-XXXX  (identifies + activates a VpnClient)
//   - Package token:  SXB-DATA-XXXX-XXXX-XXXX  (a Voucher redeemed for quota)
// -------------------------------------------------------------------------

function normalizeToken(raw: string): string {
  return raw.trim().toUpperCase();
}

function bytesToGb(bytes: bigint | number | null | undefined): number {
  if (!bytes) return 0;
  return Number(bytes) / (1024 * 1024 * 1024);
}

async function findClientByAccountToken(rawToken: string) {
  const normalized = normalizeToken(rawToken);
  if (prisma) {
    const clients = await prisma.vpnClient.findMany({ include: { user: true } });
    return clients.find((c) => normalizeToken(c.token) === normalized) || null;
  }
  const client = inMemoryDb.vpnClients.find((c) => normalizeToken(c.token) === normalized);
  if (!client) return null;
  const user = inMemoryDb.users.find((u) => u.id === client.userId);
  return { ...client, user };
}

async function findClientByUserId(userId: string) {
  if (prisma) {
    return prisma.vpnClient.findFirst({ where: { userId } });
  }
  return inMemoryDb.vpnClients.find((c) => c.userId === userId) || null;
}

// Compute the single source of truth for the mobile "smart button" state.
function computeAccountState(client: any): {
  state: "no_package" | "ready" | "connected" | "expired" | "suspended";
  quotaTotalGb: number;
  quotaUsedGb: number;
  quotaRemainingGb: number;
  expireAt: string | null;
  deviceLimit: number;
} {
  const quotaTotalGb = bytesToGb(client.quotaTotal);
  const quotaUsedGb = bytesToGb(client.quotaUsed);
  const quotaRemainingGb = Math.max(quotaTotalGb - quotaUsedGb, 0);
  const expireAt: string | null = client.expireAt ? new Date(client.expireAt).toISOString() : null;
  const now = Date.now();
  const isExpired = !!client.expireAt && new Date(client.expireAt).getTime() < now;

  let state: "no_package" | "ready" | "connected" | "expired" | "suspended" = "no_package";
  if (client.status === "suspended") {
    state = "suspended";
  } else if (!client.quotaTotal || Number(client.quotaTotal) === 0) {
    state = "no_package";
  } else if (isExpired || quotaRemainingGb <= 0) {
    state = "expired";
  } else {
    state = "ready"; // vpn_connected is tracked client-side by the native tunnel, "ready" just means eligible
  }

  return {
    state,
    quotaTotalGb,
    quotaUsedGb,
    quotaRemainingGb,
    expireAt,
    deviceLimit: client.deviceLimit || 1,
  };
}

// POST /api/mobile/auth/activate — first launch: pair the device with an account token
const activateSchema = z.object({ token: z.string().min(5) });
router.post("/auth/activate", async (req, res: Response) => {
  try {
    const { token } = activateSchema.parse(req.body);
    const client: any = await findClientByAccountToken(token);

    if (!client) {
      return res.status(404).json({ error: "errors.mobile.invalid_token", message: "Token de compte invalide" });
    }
    if (client.status === "suspended") {
      return res.status(403).json({ error: "errors.mobile.suspended", message: "Ce compte est suspendu" });
    }
    if (!client.user) {
      return res.status(500).json({ error: "errors.server", message: "Compte client mal configuré" });
    }

    const tokens = generateTokens({
      userId: client.user.id,
      email: client.user.email,
      role: "CLIENT",
    });

    await logDbActivity(client.user.id, `Mobile device activated for account ${client.token}`, "success", req.ip);

    return res.json({
      message: "Compte activé",
      client: computeAccountState(client),
      user: { id: client.user.id, name: client.user.name },
      ...tokens,
    });
  } catch (err: any) {
    if (err?.issues) {
      return res.status(400).json({ error: "errors.validation", message: "Format de token invalide" });
    }
    console.error("Mobile activate error:", err);
    return res.status(500).json({ error: "errors.server", message: "Échec de l'activation" });
  }
});

// POST /api/mobile/auth/refresh
const refreshSchema = z.object({ refreshToken: z.string() });
router.post("/auth/refresh", async (req, res: Response) => {
  try {
    const { refreshToken } = refreshSchema.parse(req.body);
    const jwt = require("jsonwebtoken");
    const { config } = require("../config");
    const decoded = jwt.verify(refreshToken, config.REFRESH_SECRET);
    const tokens = generateTokens({ userId: decoded.userId, email: decoded.email, role: decoded.role });
    return res.json(tokens);
  } catch (err) {
    return res.status(401).json({ error: "errors.auth.invalid_token", message: "Session expirée, réactivez votre compte" });
  }
});

// All routes below require a valid mobile session
router.use(requireAuth);

// GET /api/mobile/me — everything the smart button + home screen needs
router.get("/me", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const client: any = await findClientByUserId(req.user!.userId);
    if (!client) {
      return res.status(404).json({ error: "errors.mobile.no_account", message: "Aucun compte VPN associé" });
    }
    return res.json({ client: computeAccountState(client), accountToken: client.token });
  } catch (err) {
    console.error("Mobile /me error:", err);
    return res.status(500).json({ error: "errors.server", message: "Échec du chargement du compte" });
  }
});

// POST /api/mobile/packages/activate — redeem a SXB-DATA-XXXX-XXXX-XXXX code
const activatePackageSchema = z.object({ code: z.string().min(5) });
router.post("/packages/activate", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { code } = activatePackageSchema.parse(req.body);
    const normalized = normalizeToken(code);

    const client: any = await findClientByUserId(req.user!.userId);
    if (!client) {
      return res.status(404).json({ error: "errors.mobile.no_account", message: "Aucun compte VPN associé" });
    }

    if (prisma) {
      const voucher = await prisma.voucher.findFirst({ where: { code: normalized } });
      if (!voucher) {
        return res.status(404).json({ error: "errors.mobile.invalid_package", message: "Code forfait invalide" });
      }
      if (voucher.isRedeemed) {
        return res.status(409).json({ error: "errors.mobile.package_used", message: "Ce forfait a déjà été utilisé" });
      }

      const newQuotaTotal = (client.quotaTotal ? BigInt(client.quotaTotal) : BigInt(0)) + BigInt(voucher.quota);
      const baseExpiry = client.expireAt && new Date(client.expireAt).getTime() > Date.now()
        ? new Date(client.expireAt)
        : new Date();
      baseExpiry.setDate(baseExpiry.getDate() + voucher.durationDays);

      const [updatedClient] = await prisma.$transaction([
        prisma.vpnClient.update({
          where: { id: client.id },
          data: { quotaTotal: newQuotaTotal, expireAt: baseExpiry, status: "active" },
        }),
        prisma.voucher.update({
          where: { id: voucher.id },
          data: { isRedeemed: true, redeemedBy: client.id },
        }),
      ]);

      await logDbActivity(req.user!.userId, `Package ${normalized} activated via mobile app`, "success", req.ip);
      return res.json({ message: "Forfait activé", client: computeAccountState(updatedClient) });
    }

    // In-memory fallback
    const voucher = inMemoryDb.vouchers?.find((v: any) => normalizeToken(v.code) === normalized);
    if (!voucher) {
      return res.status(404).json({ error: "errors.mobile.invalid_package", message: "Code forfait invalide" });
    }
    if (voucher.isRedeemed) {
      return res.status(409).json({ error: "errors.mobile.package_used", message: "Ce forfait a déjà été utilisé" });
    }
    voucher.isRedeemed = true;
    voucher.redeemedBy = client.id;
    client.quotaTotal = BigInt(client.quotaTotal || 0) + BigInt(voucher.quota);
    const baseExpiry = client.expireAt && new Date(client.expireAt).getTime() > Date.now() ? new Date(client.expireAt) : new Date();
    baseExpiry.setDate(baseExpiry.getDate() + voucher.durationDays);
    client.expireAt = baseExpiry;
    client.status = "active";

    return res.json({ message: "Forfait activé", client: computeAccountState(client) });
  } catch (err: any) {
    if (err?.issues) {
      return res.status(400).json({ error: "errors.validation", message: "Format de code invalide" });
    }
    console.error("Mobile package activation error:", err);
    return res.status(500).json({ error: "errors.server", message: "Échec de l'activation du forfait" });
  }
});

// GET /api/mobile/vpn/config — real per-device connection config (VLESS/VMess link)
router.get("/vpn/config", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const client: any = await findClientByUserId(req.user!.userId);
    if (!client) {
      return res.status(404).json({ error: "errors.mobile.no_account", message: "Aucun compte VPN associé" });
    }
    const state = computeAccountState(client);
    if (state.state !== "ready") {
      return res.status(403).json({ error: "errors.mobile.not_ready", message: "Compte non prêt pour la connexion" });
    }

    let xpanelUserId = client.xpanelUserId;
    if (!xpanelUserId) {
      try {
        const xpanelUser = await XPanelService.createUser(
          client.user?.name || client.token,
          BigInt(client.quotaTotal || 0),
          client.expireAt ? new Date(client.expireAt) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          client.deviceLimit || 1
        );
        xpanelUserId = xpanelUser.id;
        if (prisma) {
          await prisma.vpnClient.update({ where: { id: client.id }, data: { xpanelUserId } });
        } else {
          client.xpanelUserId = xpanelUserId;
        }
      } catch (err) {
        console.error("XPanel provisioning error:", err);
        return res.status(503).json({ error: "errors.mobile.provisioning_failed", message: "Impossible de préparer la connexion, réessayez" });
      }
    }

    const subscription = await XPanelService.getSubscriptionLink(xpanelUserId);
    return res.json({ subscription });
  } catch (err) {
    console.error("Mobile vpn/config error:", err);
    return res.status(500).json({ error: "errors.server", message: "Échec de la récupération de la configuration" });
  }
});

// POST /api/mobile/vpn/session — audit trail only; the actual tunnel is managed natively on-device
const sessionSchema = z.object({ action: z.enum(["connect", "disconnect"]) });
router.post("/vpn/session", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { action } = sessionSchema.parse(req.body);
    await logDbActivity(req.user!.userId, `Mobile VPN session ${action}`, "success", req.ip);
    return res.json({ message: "ok" });
  } catch (err) {
    return res.status(400).json({ error: "errors.validation", message: "Action invalide" });
  }
});

export default router;

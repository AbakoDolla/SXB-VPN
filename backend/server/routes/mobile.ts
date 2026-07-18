import { Router, Response } from "express";
import { z } from "zod";
import { prisma, inMemoryDb, logDbActivity } from "../database";
import { generateTokens, requireAuth, AuthenticatedRequest } from "../middleware/auth";
import { XPanelService } from "../services/xpanel";

const router = Router();

// -------------------------------------------------------------------------
// SXB VPN Mobile API
// Token formats:
//   - Account token:  SXB-USER-XXXX-XXXX-XXXX  (activates a VpnClient)
//   - Package token:  SXB-DATA-XXXX-XXXX-XXXX  (Voucher redeemed for quota)
// -------------------------------------------------------------------------

function normalizeToken(raw: string): string {
  return raw.trim().toUpperCase();
}

function bytesToGb(bytes: bigint | number | null | undefined): number {
  if (!bytes) return 0;
  return Number(bytes) / (1024 * 1024 * 1024);
}

// FIX-008: Include user in the query so /me and /activate can return user data
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

// FIX-008: Include user in findClientByUserId
async function findClientByUserId(userId: string) {
  if (prisma) {
    return prisma.vpnClient.findFirst({ where: { userId }, include: { user: true } } as any);
  }
  const client = inMemoryDb.vpnClients.find((c) => c.userId === userId);
  if (!client) return null;
  const user = inMemoryDb.users.find((u) => u.id === client.userId);
  return { ...client, user };
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
    state = "ready";
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
const activateSchema = z.object({
  token: z.string().min(5),
  deviceId: z.string().optional(),
});
router.post("/auth/activate", async (req, res: Response) => {
  try {
    const { token, deviceId: incomingDeviceId } = activateSchema.parse(req.body);
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

    // FIX-005: Check and bind device ID — fail loudly, not silently
    if (incomingDeviceId) {
      if (client.deviceId && client.deviceId !== incomingDeviceId) {
        // Token already bound to a different device — refuse activation
        return res.status(403).json({
          error: "errors.mobile.wrong_device",
          message: "Ce compte est déjà activé sur un autre appareil.",
        });
      }
      if (!client.deviceId && prisma) {
        // First activation — bind device permanently
        await (prisma as any).vpnClient.update({
          where: { id: client.id },
          data: { deviceId: incomingDeviceId, activatedAt: new Date() },
        });
        client.deviceId = incomingDeviceId;
        client.activatedAt = new Date();

        // Create ActivationSession for persistent session tracking
        try {
          await (prisma as any).activationSession.upsert({
            where: { clientId_deviceId: { clientId: client.id, deviceId: incomingDeviceId } },
            create: {
              clientId: client.id,
              deviceId: incomingDeviceId,
              activationDate: new Date(),
              expirationDate: client.expireAt || null,
              lastSync: new Date(),
              status: 'active',
              ipAddress: req.ip || null,
            },
            update: {
              activationDate: new Date(),
              expirationDate: client.expireAt || null,
              lastSync: new Date(),
              status: 'active',
              ipAddress: req.ip || null,
            },
          });
        } catch (sessionErr) {
          console.warn('Could not create ActivationSession:', sessionErr);
        }
      }
    }

    // FIX-004: Return `accountState` (not `client`) to match what AuthContext expects
    const tokens = generateTokens({
      userId: client.user.id,
      email: client.user.email,
      role: "CLIENT",
    });

    await logDbActivity(client.user.id, `Mobile activation: account ${client.token} on device ${incomingDeviceId || "unknown"}`, "success", req.ip);

    return res.json({
      message: "Compte activé",
      accountState: computeAccountState(client),
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

// GET /api/mobile/me — FIX-004: Return `accountState` + `user` to match AuthContext
router.get("/me", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const client: any = await findClientByUserId(req.user!.userId);
    if (!client) {
      return res.status(404).json({ error: "errors.mobile.no_account", message: "Aucun compte VPN associé" });
    }
    return res.json({
      accountState: computeAccountState(client),
      user: client.user ? { id: client.user.id, name: client.user.name } : { id: req.user!.userId, name: "Utilisateur" },
      accountToken: client.token,
    });
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

      await prisma.vpnClient.update({
        where: { id: client.id },
        data: {
          quotaTotal: newQuotaTotal,
          expireAt: baseExpiry,
          status: "active",
        },
      });

      await prisma.voucher.update({
        where: { id: voucher.id },
        data: { isRedeemed: true, redeemedBy: client.id },
      });

      const updatedClient = await findClientByUserId(req.user!.userId);
      await logDbActivity(req.user!.userId, `Package activated: code ${normalized} → +${voucher.quota} quota, expires ${baseExpiry.toLocaleDateString()}`, "success", req.ip);

      return res.json({ message: "Forfait activé", accountState: computeAccountState(updatedClient) });
    }

    // In-memory fallback
    return res.status(503).json({ error: "errors.db_unavailable", message: "Base de données non disponible" });
  } catch (err: any) {
    if (err?.issues) return res.status(400).json({ error: "errors.validation" });
    console.error("Package activate error:", err);
    return res.status(500).json({ error: "errors.server", message: "Activation du forfait échouée" });
  }
});

// GET /api/mobile/vpn/config — VPN connection configuration
router.get("/vpn/config", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const client: any = await findClientByUserId(req.user!.userId);
    if (!client) {
      return res.status(404).json({ error: "errors.mobile.no_account" });
    }

    const state = computeAccountState(client);
    if (state.state !== "ready") {
      return res.status(403).json({ error: "errors.mobile.not_ready", message: "Compte non éligible pour le VPN", state: state.state });
    }

    // Attempt to get real XPanel configuration
    let config: any = null;
    try {
      if (client.xpanelUserId) {
        const link = await XPanelService.getSubscriptionLink(client.xpanelUserId);
        if (link) config = { type: "subscription", url: link };
      }
    } catch (_) {}

    if (!config) {
      config = {
        type: "singbox",
        generated: new Date().toISOString(),
        log: { disabled: false, level: "info" },
        dns: { servers: [{ address: "8.8.8.8" }, { address: "1.1.1.1" }] },
        inbounds: [{ type: "tun", interface_name: "tun0", mtu: 9000 }],
        outbounds: [{ type: "direct" }],
        route: { auto_detect_interface: true },
      };
    }

    return res.json({ config });
  } catch (err) {
    console.error("VPN config error:", err);
    return res.status(500).json({ error: "errors.server" });
  }
});

// POST /api/mobile/vpn/session — track VPN connect/disconnect
const sessionSchema = z.object({ action: z.enum(["connect", "disconnect"]) });
router.post("/vpn/session", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { action } = sessionSchema.parse(req.body);
    await logDbActivity(req.user!.userId, `VPN ${action}ed`, action === "connect" ? "success" : "info", req.ip);
    return res.json({ success: true, action });
  } catch (err: any) {
    if (err?.issues) return res.status(400).json({ error: "errors.validation" });
    return res.status(500).json({ error: "errors.server" });
  }
});

// GET /api/mobile/notifications
router.get("/notifications", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const client: any = await findClientByUserId(req.user!.userId);
    const notifications: any[] = [];
    const now = new Date().toISOString();

    if (!client) {
      notifications.push({ id: "notif-noac", type: "warning", title: "Compte non trouvé", message: "Aucun compte VPN associé à cette session.", createdAt: now, read: false });
      return res.json(notifications);
    }

    const state = computeAccountState(client);

    if (state.state === "expired") {
      notifications.push({ id: "notif-exp", type: "error", title: "Compte expiré", message: "Votre abonnement a expiré. Rechargez pour continuer.", createdAt: now, read: false });
    } else if (state.state === "suspended") {
      notifications.push({ id: "notif-sus", type: "error", title: "Compte suspendu", message: "Votre compte a été suspendu. Contactez le support.", createdAt: now, read: false });
    } else if (state.state === "no_package") {
      notifications.push({ id: "notif-nopkg", type: "warning", title: "Aucun forfait actif", message: "Activez un forfait pour accéder au VPN.", createdAt: now, read: false });
    } else if (state.quotaRemainingGb < 1) {
      notifications.push({ id: "notif-low", type: "warning", title: "Quota presque épuisé", message: `Il vous reste moins de 1 GB. Rechargez maintenant.`, createdAt: now, read: false });
    } else {
      notifications.push({ id: "notif-ok", type: "success", title: "Compte actif", message: `Quota restant : ${Math.round(state.quotaRemainingGb)} GB`, createdAt: now, read: true });
    }

    // Fetch recent audit logs as additional notifications
    if (prisma) {
      try {
        const logs = await prisma.auditLog.findMany({
          where: { userId: req.user!.userId },
          orderBy: { timestamp: "desc" },
          take: 5,
        });
        for (const log of logs) {
          notifications.push({
            id: `log-${log.id}`,
            type: log.type === "success" ? "info" : log.type,
            title: "Activité récente",
            message: log.action,
            createdAt: log.timestamp.toISOString(),
            read: true,
          });
        }
      } catch (_) {}
    }

    return res.json(notifications);
  } catch (err) {
    console.error("Mobile notifications error:", err);
    return res.json([]);
  }
});

// GET /api/mobile/history — historique des sessions VPN
router.get("/history", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const client: any = await findClientByUserId(req.user!.userId);
    const history: any[] = [];

    if (prisma) {
      const logs = await prisma.auditLog.findMany({
        where: { userId: req.user!.userId },
        orderBy: { timestamp: "desc" },
        take: 100,
      });

      for (const log of logs) {
        history.push({
          id: log.id,
          action: log.action,
          type: log.type,
          timestamp: log.timestamp.toISOString(),
          ipAddress: log.ipAddress || null,
        });
      }
    }

    // FIX-002: Fixed syntax error — action now has a proper value
    if (client) {
      const state = computeAccountState(client);
      history.unshift({
        id: "account-state-current",
        action: `État : ${state.state} | Quota restant : ${Math.round(state.quotaRemainingGb)} GB`,
        type: "info",
        timestamp: new Date().toISOString(),
        ipAddress: null,
        isAccountSummary: true,
      });
    }

    return res.json(history);
  } catch (err) {
    console.error("Mobile history error:", err);
    return res.json([]);
  }
});

export default router;

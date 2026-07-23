import { Router, Response } from "express";
import { z } from "zod";
import { prisma, inMemoryDb, logDbActivity } from "../database";
import { generateTokens, requireAuth, AuthenticatedRequest } from "../middleware/auth";

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
    return (prisma as any).vpnClient.findFirst({ where: { userId }, include: { user: true } });
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
    
    // Check token expiration
    if (client.expireAt && new Date(client.expireAt).getTime() < Date.now()) {
      return res.status(403).json({ error: "errors.mobile.token_expired", message: "Ce token d'activation a expiré" });
    }
    
    // Check and bind device ID
    if (incomingDeviceId) {
      if (client.deviceId && client.deviceId !== incomingDeviceId) {
        return res.status(403).json({ 
          error: "errors.mobile.wrong_device", 
          message: "Ce token est lié à un autre appareil" 
        });
      }
      if (!client.deviceId && prisma) {
        // FIX-005: No silent catch — propagate errors properly
        await (prisma as any).vpnClient.update({
          where: { id: client.id },
          data: { deviceId: incomingDeviceId, activatedAt: new Date() },
        });
        client.deviceId = incomingDeviceId;
      }
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

    // Create/update ActivationSession for persistent session tracking
    if (incomingDeviceId && prisma) {
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

// GET /api/mobile/me — everything the smart button + home screen needs
router.get("/me", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const client: any = await findClientByUserId(req.user!.userId);
    if (!client) {
      return res.status(404).json({ error: "errors.mobile.no_account", message: "Aucun compte VPN associé" });
    }
    return res.json({ accountState: computeAccountState(client), user: client.user ? { id: client.user.id, name: client.user.name } : { id: req.user.userId, name: "Utilisateur" }, accountToken: client.token });
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
      return res.json({ message: "Forfait activé", accountState: computeAccountState(updatedClient) });
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

    return res.json({ message: "Forfait activé", accountState: computeAccountState(client) });
  } catch (err: any) {
    if (err?.issues) {
      return res.status(400).json({ error: "errors.validation", message: "Format de code invalide" });
    }
    console.error("Mobile package activation error:", err);
    return res.status(500).json({ error: "errors.server", message: "Échec de l'activation du forfait" });
  }
});

// GET /api/mobile/vpn/config — config VPN reelle depuis abonnement actif
router.get("/vpn/config", async (req: AuthenticatedRequest, res: Response) => {
  const FALLBACK = [
    { name: "SSH",         port: 22,   transport: "TCP",  security: "SSH",     description: "Securise" },
    { name: "SSH+Payload", port: 80,   transport: "TCP",  security: "Bypass",  description: "Anti-DPI" },
  ];
  try {
    const client: any = await findClientByUserId(req.user!.userId);
    if (!client) return res.status(404).json({ error: "errors.mobile.no_account" });
    const state = computeAccountState(client);

    let sub: any = null;
    if (prisma) {
      sub = await (prisma as any).subscription.findFirst({
        where: { clientId: client.id, status: "active" },
        include: { profile: true },
        orderBy: { createdAt: "desc" },
      });
    }

    const profile = sub?.profile || null;
    const proto = (profile?.protocol || "ssh").toLowerCase();
    const protocols = profile
      ? [{ name: proto.toUpperCase(), port: profile.port, transport: (profile.network || "tcp").toUpperCase(), security: profile.tls ? "TLS" : "None", description: "Actif \u2014 " + profile.name }]
      : FALLBACK;

    let connectionUri: string | null = null;
    if (profile) {
      if (proto === "ssh") {
        connectionUri = "ssh://" + (profile.username || "user") + "@" + profile.host + ":" + profile.port;
        if (profile.sni) connectionUri += "?sni=" + encodeURIComponent(profile.sni);
      }
    }

    return res.json({
      state: state.state,
      protocols,
      serverInfo: { host: profile?.host || "vpnsxb.afrihall.com", location: profile ? "SXB" : "France / Europe" },
      subscriptionUrl: connectionUri,
      connectionUri,
      profile: profile ? { id: profile.id, name: profile.name, protocol: proto, host: profile.host, port: profile.port, network: profile.network, tls: profile.tls, sni: profile.sni, uuid: profile.uuid, path: profile.path, username: profile.username, password: profile.password || null, method: profile.method || null } : null,
      subscription: sub ? { id: sub.id, name: sub.name, dataToken: sub.dataToken, expireAt: sub.expireAt?.toISOString(), status: sub.status } : null,
      vpnConfig: profile ? { id: profile.id, name: profile.name, protocol: proto, host: profile.host, port: profile.port, network: profile.network, tls: profile.tls, sni: profile.sni, uuid: profile.uuid, path: profile.path, username: profile.username, password: profile.password || null, method: profile.method || null } : null,
    });
  } catch (err) {
    console.error("Mobile vpn/config error:", err);
    return res.json({ subscriptionUrl: null, protocols: FALLBACK, serverInfo: null });
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



// POST /api/mobile/vpn/traffic — trafic temps réel envoyé depuis l'appareil
const trafficSchema = z.object({
  upload:    z.number().int().min(0),
  download:  z.number().int().min(0),
  sessionId: z.string().optional(),
});
router.post("/vpn/traffic", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { upload, download, sessionId } = trafficSchema.parse(req.body);
    await logDbActivity(
      req.user!.userId,
      `Mobile VPN traffic — ↑${upload}B ↓${download}B${sessionId ? " sid:" + sessionId : ""}`,
      "success",
      req.ip
    );
    return res.json({ message: "ok", upload, download });
  } catch (err) {
    return res.status(400).json({ error: "errors.validation", message: "Données trafic invalides" });
  }
});

// GET /api/mobile/notifications — notifications basées sur l'état du compte
router.get('/notifications', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const client: any = await findClientByUserId(req.user!.userId);
    if (!client) return res.json([]);

    const state = computeAccountState(client);
    const notifications: any[] = [];
    const now = new Date().toISOString();

    if (state.state === 'expired') {
      notifications.push({
        id: 'notif-expired-' + Date.now(),
        type: 'warning',
        title: 'Forfait expiré',
        message: 'Votre forfait VPN a expiré. Activez un nouveau code pour continuer.',
        createdAt: now,
        read: false,
      });
    } else if (state.quotaRemainingGb < 1 && state.state === 'ready') {
      notifications.push({
        id: 'notif-low-quota-' + Date.now(),
        type: 'warning',
        title: 'Quota presque épuisé',
        message: 'Il vous reste moins de 1 GB. Rechargez votre forfait maintenant.',
        createdAt: now,
        read: false,
      });
    } else if (state.state === 'no_package') {
      notifications.push({
        id: 'notif-no-package-' + Date.now(),
        type: 'info',
        title: 'Aucun forfait actif',
        message: 'Activez un code forfait SXB-DATA pour commencer à naviguer.',
        createdAt: now,
        read: false,
      });
    } else if (state.state === 'ready') {
      if (state.expireAt) {
        const daysLeft = Math.ceil((new Date(state.expireAt).getTime() - Date.now()) / 86400000);
        if (daysLeft <= 5) {
          notifications.push({
            id: 'notif-expire-soon-' + Date.now(),
            type: 'warning',
            title: 'Forfait bientôt expiré',
            message: 'Votre forfait expire bientôt. Pensez à le renouveler avant expiration.',
            createdAt: now,
            read: false,
          });
        }
      }
      notifications.push({
        id: 'notif-welcome',
        type: 'success',
        title: 'Compte actif',
        message: 'Votre compte est actif. Connexion VPN disponible.',
        createdAt: now,
        read: true,
      });
    } else if (state.state === 'suspended') {
      notifications.push({
        id: 'notif-suspended',
        type: 'error',
        title: 'Compte suspendu',
        message: 'Votre compte a été suspendu. Contactez le support SXB.',
        createdAt: now,
        read: false,
      });
    }

    // Ajouter les derniers logs d'audit si disponibles
    if (prisma) {
      try {
        const logs = await prisma.auditLog.findMany({
          where: { userId: req.user!.userId },
          orderBy: { timestamp: 'desc' },
          take: 5,
        });
        for (const log of logs) {
          if (log.action.includes('VPN session')) {
            notifications.push({
              id: 'log-' + log.id,
              type: log.type === 'success' ? 'info' : log.type,
              title: log.action.includes('connect') ? 'Connexion VPN' : 'Déconnexion VPN',
              message: log.action,
              createdAt: log.timestamp.toISOString(),
              read: true,
            });
          }
        }
      } catch (_) {}
    }

    return res.json(notifications);
  } catch (err) {
    console.error('Mobile notifications error:', err);
    return res.json([]);
  }
});

// GET /api/mobile/history — historique des sessions VPN
router.get('/history', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const client: any = await findClientByUserId(req.user!.userId);
    const history: any[] = [];

    if (prisma) {
      const logs = await prisma.auditLog.findMany({
        where: { userId: req.user!.userId },
        orderBy: { timestamp: 'desc' },
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

    // Ajouter info quota si disponible
    if (client) {
      const state = computeAccountState(client);
      history.unshift({
        id: 'account-state-current',
        action: 'Etat du compte : ' + state.state + ' | Quota restant : ' + Math.round(state.quotaRemainingGb) + ' GB',
        type: 'info',
        timestamp: new Date().toISOString(),
        ipAddress: null,
        isAccountSummary: true,
      });
    }

    return res.json(history);
  } catch (err) {
    console.error('Mobile history error:', err);
    return res.json([]);
  }
});

export default router;

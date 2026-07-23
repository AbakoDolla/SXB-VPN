/**
 * Mobile API routes — /api/mobile/*
 *
 * NOTE : Ce fichier est le backend Replit (dev/staging).
 * Le backend de production tourne sur le VPS à /var/www/sxb-vpn/server/routes/mobile.ts
 * et utilise Prisma + PostgreSQL réel.
 *
 * Ce fichier miroir la structure du VPS pour permettre le développement local.
 * En production, toutes les requêtes mobiles vont vers https://vpnsxb.afrihall.com/api
 */
import { Router } from "express";
import { z } from "zod";
import jwt from "jsonwebtoken";
import {
  requireAuth,
  generateTokens,
  REFRESH_SECRET,
  type AuthenticatedRequest,
} from "../middleware/auth.js";

const router = Router();

// ── In-memory store (dev only — production uses Prisma) ──────────────────────

interface DevClient {
  id: string;
  userId: string;
  token: string;
  quotaTotal: bigint | null;
  quotaUsed: bigint;
  expireAt: Date | null;
  status: string;
  deviceId: string | null;
  deviceLimit: number;
  activatedAt: Date | null;
}

const devClients: DevClient[] = [
  {
    id: "client-001",
    userId: "user-dev-001",
    token: "SXB-USER-TEST-0001-DEMO",
    quotaTotal: BigInt(50 * 1024 * 1024 * 1024), // 50 GB
    quotaUsed: BigInt(12 * 1024 * 1024 * 1024),   // 12 GB used
    expireAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    status: "active",
    deviceId: null,
    deviceLimit: 1,
    activatedAt: new Date(),
  },
];

interface DevUser {
  id: string;
  name: string;
  email: string;
}

const devUsers: DevUser[] = [
  { id: "user-dev-001", name: "Utilisateur Test", email: "test@sxbvpn.com" },
];

// Profiles VPN (correspondant à ce qu'on a sur le VPS / XPanel)
const devProfiles = [
  {
    id: "profile-001",
    name: "MTN SSH — Cameroun",
    protocol: "ssh",
    host: "vpnsxb.afrihall.com",
    port: 443,
    username: "sxbuser",
    password: "",
    sni: "yamo.mtn.cm",
    network: "tcp",
    tls: false,
    uuid: null,
    path: null,
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function bytesToGb(bytes: bigint | number | null | undefined): number {
  if (!bytes) return 0;
  return Number(bytes) / (1024 * 1024 * 1024);
}

function normalizeToken(raw: string): string {
  return raw.trim().toUpperCase();
}

function computeAccountState(client: DevClient) {
  const quotaTotalGb = bytesToGb(client.quotaTotal);
  const quotaUsedGb = bytesToGb(client.quotaUsed);
  const quotaRemainingGb = Math.max(quotaTotalGb - quotaUsedGb, 0);
  const expireAt = client.expireAt ? client.expireAt.toISOString() : null;
  const now = Date.now();
  const isExpired = !!client.expireAt && client.expireAt.getTime() < now;

  let state: "no_package" | "ready" | "expired" | "suspended" = "no_package";
  if (client.status === "suspended") state = "suspended";
  else if (!client.quotaTotal || Number(client.quotaTotal) === 0) state = "no_package";
  else if (isExpired || quotaRemainingGb <= 0) state = "expired";
  else state = "ready";

  return { state, quotaTotalGb, quotaUsedGb, quotaRemainingGb, expireAt, deviceLimit: client.deviceLimit };
}

const activateSchema = z.object({
  token: z.string().min(5),
  deviceId: z.string().optional(),
});
const refreshSchema = z.object({ refreshToken: z.string() });
const sessionSchema = z.object({ action: z.enum(["connect", "disconnect"]) });
const planSchema    = z.object({ code: z.string().min(5) });

// ── POST /api/mobile/auth/activate ───────────────────────────────────────────
router.post("/auth/activate", async (req, res) => {
  try {
    const { token, deviceId: incomingDeviceId } = activateSchema.parse(req.body);
    const normalized = normalizeToken(token);
    const client = devClients.find(c => normalizeToken(c.token) === normalized);

    if (!client) {
      return res.status(404).json({
        error: "errors.mobile.invalid_token",
        message: "Token de compte invalide ou inexistant",
      });
    }

    if (client.status === "suspended") {
      return res.status(403).json({ error: "errors.mobile.suspended", message: "Compte suspendu" });
    }

    if (incomingDeviceId) {
      if (!client.deviceId) {
        client.deviceId = incomingDeviceId;
        client.activatedAt = new Date();
      } else if (client.deviceId !== incomingDeviceId) {
        return res.status(403).json({
          error: "errors.mobile.wrong_device",
          message: "Token lié à un autre appareil",
        });
      }
    }

    const user = devUsers.find(u => u.id === client.userId) || { id: client.userId, name: "Utilisateur" };
    const tokens = generateTokens({
      userId: client.userId,
      email: `${client.token.toLowerCase()}@sxbvpn.local`,
      role: "CLIENT",
    });
    const accountState = computeAccountState(client);

    return res.json({
      message: "Compte activé",
      user: { id: user.id, name: (user as any).name },
      accountState,
      client: accountState,
      ...tokens,
    });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: "errors.validation" });
    return res.status(500).json({ error: "errors.server" });
  }
});

// ── POST /api/mobile/auth/refresh ────────────────────────────────────────────
router.post("/auth/refresh", async (req, res) => {
  try {
    const { refreshToken } = refreshSchema.parse(req.body);
    const decoded = jwt.verify(refreshToken, REFRESH_SECRET) as any;
    const tokens = generateTokens({
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role,
    });
    return res.json(tokens);
  } catch {
    return res.status(401).json({ error: "errors.auth.invalid_refresh" });
  }
});

// ── GET /api/mobile/me ───────────────────────────────────────────────────────
router.get("/me", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const client = devClients.find(c => c.userId === req.user!.userId);
    if (!client) return res.status(404).json({ error: "errors.mobile.no_account" });
    const user = devUsers.find(u => u.id === client.userId) || { id: client.userId, name: "Utilisateur" };
    return res.json({
      user: { id: user.id, name: (user as any).name },
      accountState: computeAccountState(client),
    });
  } catch {
    return res.status(500).json({ error: "errors.server" });
  }
});

// ── GET /api/mobile/account ──────────────────────────────────────────────────
router.get("/account", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const client = devClients.find(c => c.userId === req.user!.userId);
    if (!client) return res.status(404).json({ error: "errors.mobile.no_account" });
    return res.json(computeAccountState(client));
  } catch {
    return res.status(500).json({ error: "errors.server" });
  }
});

// ── POST /api/mobile/plan/activate ───────────────────────────────────────────
router.post("/plan/activate", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { code } = planSchema.parse(req.body);
    const normalized = normalizeToken(code);
    const client = devClients.find(c => c.userId === req.user!.userId);
    if (!client) return res.status(404).json({ error: "errors.mobile.no_account" });

    // Simulate SXB-DATA token validation
    if (!normalized.startsWith("SXB-DATA-")) {
      return res.status(400).json({ error: "errors.mobile.invalid_data_token", message: "Token Data invalide" });
    }

    // Add 5 GB quota and 30 days
    client.quotaTotal = BigInt(Number(client.quotaTotal || 0) + 5 * 1024 * 1024 * 1024);
    client.expireAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    client.status = "active";

    return res.json({
      message: "Forfait activé avec succès",
      accountState: computeAccountState(client),
      quotaAdded: "5 GB",
    });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: "errors.validation" });
    return res.status(500).json({ error: "errors.server" });
  }
});

// ── GET /api/mobile/vpn/config ───────────────────────────────────────────────
// Retourne la configuration VPN active pour l'utilisateur authentifié
router.get("/vpn/config", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const client = devClients.find(c => c.userId === req.user!.userId);
    if (!client) return res.status(404).json({ error: "errors.mobile.no_account" });

    const state = computeAccountState(client);
    const profile = devProfiles[0];
    const proto = profile.protocol.toLowerCase();

    // Construire l'URI de connexion
    let connectionUri: string | null = null;
    if (proto === "ssh") {
      connectionUri = `ssh://${profile.username}@${profile.host}:${profile.port}`;
      if (profile.sni) connectionUri += `?sni=${encodeURIComponent(profile.sni)}`;
    }

    const protocols = [{
      name: proto.toUpperCase(),
      port: profile.port,
      transport: (profile.network || "tcp").toUpperCase(),
      security: profile.tls ? "TLS" : "None",
      description: `Actif — ${profile.name}`,
    }];

    return res.json({
      state: state.state,
      protocols,
      serverInfo: { host: profile.host, location: "SXB — Cameroun" },
      subscriptionUrl: connectionUri,
      connectionUri,
      profile: {
        id: profile.id,
        name: profile.name,
        protocol: proto,
        host: profile.host,
        port: profile.port,
        network: profile.network,
        tls: profile.tls,
        sni: profile.sni,
        uuid: profile.uuid,
        path: profile.path,
        username: profile.username,
      },
      // vpnConfig : objet complet consommé par le module natif Android
      vpnConfig: {
        configId:  profile.id,
        protocol:  proto,
        host:      profile.host,
        port:      profile.port,
        username:  profile.username,
        password:  profile.password || '',
        sni:       profile.sni      || '',
        network:   profile.network  || 'tcp',
        tls:       profile.tls      ?? false,
        uuid:      profile.uuid     || null,
        path:      profile.path     || null,
      },
      // quota : bytes — consommé par offlineStorage.ts en mode hors-ligne
      quota: {
        totalQuota:  client.quotaTotal ? Number(client.quotaTotal) : 0,
        usedQuota:   Number(client.quotaUsed),
        expiryDate:  client.expireAt?.toISOString() ?? null,
      },
      subscription: client ? {
        expireAt: client.expireAt?.toISOString() || null,
        status: client.status,
      } : null,
    });
  } catch {
    return res.status(500).json({ error: "errors.server" });
  }
});

// ── POST /api/mobile/vpn/session ─────────────────────────────────────────────
router.post("/vpn/session", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { action } = sessionSchema.parse(req.body);
    // Log only — tunnel is managed natively on-device
    return res.json({ message: "ok", action });
  } catch {
    return res.status(400).json({ error: "errors.validation" });
  }
});

// ── GET /api/mobile/notifications ────────────────────────────────────────────
router.get("/notifications", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const client = devClients.find(c => c.userId === req.user!.userId);
    if (!client) return res.json([]);

    const state = computeAccountState(client);
    const notifications: any[] = [];
    const now = new Date().toISOString();

    if (state.state === "expired") {
      notifications.push({
        id: `notif-expired-${Date.now()}`,
        type: "warning",
        title: "Forfait expiré",
        message: "Votre forfait SXB VPN a expiré. Activez un nouveau code pour continuer.",
        createdAt: now,
        read: false,
      });
    } else if (state.quotaRemainingGb < 0.1 && state.state === "ready") {
      // < 100 MB remaining
      notifications.push({
        id: `notif-low-100mb-${Date.now()}`,
        type: "warning",
        title: "Il vous reste 100 Mo",
        message: "Votre quota est presque épuisé. Rechargez maintenant.",
        createdAt: now,
        read: false,
      });
    } else if (state.quotaRemainingGb < 1 && state.state === "ready") {
      notifications.push({
        id: `notif-low-${Date.now()}`,
        type: "warning",
        title: "Quota presque épuisé",
        message: "Il vous reste moins de 1 Go. Rechargez votre forfait.",
        createdAt: now,
        read: false,
      });
    } else if (state.expireAt) {
      // Notify if expires within 24h
      const hoursLeft = (new Date(state.expireAt).getTime() - Date.now()) / 3600000;
      if (hoursLeft > 0 && hoursLeft < 24) {
        notifications.push({
          id: `notif-expires-soon-${Date.now()}`,
          type: "info",
          title: "Votre forfait expire demain",
          message: "Pensez à renouveler votre forfait SXB VPN.",
          createdAt: now,
          read: false,
        });
      }
    } else if (state.state === "no_package") {
      notifications.push({
        id: `notif-no-package-${Date.now()}`,
        type: "info",
        title: "Aucun forfait actif",
        message: "Activez un code SXB-DATA pour commencer à naviguer.",
        createdAt: now,
        read: false,
      });
    } else if (state.state === "ready") {
      notifications.push({
        id: `notif-ok-${Date.now()}`,
        type: "success",
        title: "Compte actif",
        message: `Quota restant : ${Math.round(state.quotaRemainingGb)} Go`,
        createdAt: now,
        read: true,
      });
    }

    return res.json(notifications);
  } catch {
    return res.json([]);
  }
});

// ── GET /api/mobile/history ──────────────────────────────────────────────────
router.get("/history", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const client = devClients.find(c => c.userId === req.user!.userId);
    const history: any[] = [];

    if (client) {
      const state = computeAccountState(client);
      history.push({
        id: "account-state-current",
        action: `État : ${state.state} | Quota restant : ${Math.round(state.quotaRemainingGb)} Go`,
        type: "info",
        timestamp: new Date().toISOString(),
        isAccountSummary: true,
      });
      if (client.activatedAt) {
        history.push({
          id: "activation",
          action: "Compte activé",
          type: "account",
          timestamp: client.activatedAt.toISOString(),
        });
      }
    }

    return res.json(history);
  } catch {
    return res.json([]);
  }
});

export default router;

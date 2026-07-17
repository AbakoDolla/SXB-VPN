/**
 * Mobile API routes — /api/mobile/*
 * In dev mode: simplified in-memory implementation.
 * In production: backend runs on the VPS.
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

// ── In-memory clients for dev ────────────────────────────────────────────────
interface DevClient {
  id: string;
  userId: string;
  token: string;
  quotaTotalGb: number;
  quotaUsedGb: number;
  expireAt: Date | null;
  status: string;
  deviceId: string | null;
  xpanelUserId: string | null;
}

const devClients: DevClient[] = [
  {
    id: "client-001",
    userId: "user-dev-001",
    token: "SXB-USER-TEST-0001-DEMO",
    quotaTotalGb: 50,
    quotaUsedGb: 12.5,
    expireAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    status: "active",
    deviceId: null,
    xpanelUserId: null,
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

// ── Helpers ──────────────────────────────────────────────────────────────────
function computeAccountState(client: DevClient) {
  const quotaTotalGb = client.quotaTotalGb;
  const quotaUsedGb = client.quotaUsedGb;
  const quotaRemainingGb = Math.max(quotaTotalGb - quotaUsedGb, 0);
  const expireAt = client.expireAt ? client.expireAt.toISOString() : null;
  const isExpired = client.expireAt ? client.expireAt.getTime() < Date.now() : false;

  let state: "no_package" | "ready" | "expired" | "suspended" = "no_package";
  if (client.status === "suspended") state = "suspended";
  else if (quotaTotalGb === 0) state = "no_package";
  else if (isExpired || quotaRemainingGb <= 0) state = "expired";
  else state = "ready";

  return { state, quotaTotalGb, quotaUsedGb, quotaRemainingGb, expireAt, deviceLimit: 1 };
}

const activateSchema = z.object({ token: z.string().min(5), deviceId: z.string().optional() });
const refreshSchema = z.object({ refreshToken: z.string() });

// POST /api/mobile/auth/activate
router.post("/auth/activate", async (req, res) => {
  try {
    const { token, deviceId } = activateSchema.parse(req.body);
    const normalized = token.trim().toUpperCase();
    const client = devClients.find(
      (c) => c.token.trim().toUpperCase() === normalized
    );

    if (!client) {
      return res.status(404).json({
        error: "errors.mobile.invalid_token",
        message: "Token de compte invalide",
      });
    }

    if (client.status === "suspended") {
      return res
        .status(403)
        .json({ error: "errors.mobile.suspended", message: "Compte suspendu" });
    }

    if (deviceId && !client.deviceId) {
      client.deviceId = deviceId;
    } else if (deviceId && client.deviceId && client.deviceId !== deviceId) {
      return res.status(403).json({
        error: "errors.mobile.wrong_device",
        message: "Token lié à un autre appareil",
      });
    }

    const user = devUsers.find((u) => u.id === client.userId) || {
      id: client.userId,
      name: "Utilisateur",
    };
    const tokens = generateTokens({
      userId: client.userId,
      email: `${client.token.toLowerCase()}@sxbvpn.local`,
      role: "CLIENT",
    });

    return res.json({
      message: "Compte activé",
      client: computeAccountState(client),
      user: { id: user.id, name: user.name },
      accountState: computeAccountState(client),
      ...tokens,
    });
  } catch (err) {
    if (err instanceof z.ZodError)
      return res.status(400).json({ error: "errors.validation" });
    return res.status(500).json({ error: "errors.server" });
  }
});

// POST /api/mobile/auth/refresh
router.post("/auth/refresh", async (req, res) => {
  try {
    const { refreshToken } = refreshSchema.parse(req.body);
    const decoded = jwt.verify(refreshToken, REFRESH_SECRET) as {
      userId: string;
      email: string;
      role: string;
    };
    const tokens = generateTokens({
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role,
    });
    return res.json(tokens);
  } catch {
    return res
      .status(401)
      .json({ error: "errors.auth.invalid_token", message: "Session expirée" });
  }
});

// All routes below require auth
router.use(requireAuth);

// GET /api/mobile/me
router.get("/me", async (req: AuthenticatedRequest, res) => {
  try {
    const client = devClients.find((c) => c.userId === req.user!.userId);
    const user = devUsers.find((u) => u.id === req.user!.userId);

    return res.json({
      user: user || { id: req.user!.userId, name: "Dev User" },
      accountState: client ? computeAccountState(client) : null,
    });
  } catch (err) {
    return res.status(500).json({ error: "errors.server" });
  }
});

// POST /api/mobile/plans/activate
router.post("/plans/activate", async (req: AuthenticatedRequest, res) => {
  try {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({
        error: "errors.validation",
        message: "Code forfait requis",
      });
    }

    // Dev mode: accept any SXB-DATA-* code and add 10GB / 30 days
    const client = devClients.find((c) => c.userId === req.user!.userId);
    if (!client) {
      return res.status(404).json({
        error: "errors.mobile.no_client",
        message: "Aucun client trouvé",
      });
    }

    client.quotaTotalGb += 10;
    client.expireAt = new Date(
      (client.expireAt?.getTime() || Date.now()) + 30 * 24 * 60 * 60 * 1000
    );

    return res.json({
      message: "Forfait activé avec succès",
      accountState: computeAccountState(client),
    });
  } catch {
    return res.status(500).json({ error: "errors.server" });
  }
});

// GET /api/mobile/vpn/config
router.get("/vpn/config", async (req: AuthenticatedRequest, res) => {
  try {
    const FALLBACK_PROTOCOLS = [
      { name: "VLESS", port: 443, transport: "TCP", security: "Reality", description: "Recommandé" },
      { name: "VMess", port: 80, transport: "WS", security: "None", description: "Compatible" },
      { name: "Trojan", port: 443, transport: "TCP", security: "TLS", description: "Stable" },
      { name: "Shadowsocks", port: 8388, transport: "TCP", security: "ChaCha20", description: "Léger" },
      { name: "Hysteria2", port: 443, transport: "QUIC", security: "TLS", description: "Rapide" },
      { name: "SSH", port: 22, transport: "TCP", security: "SSH", description: "Sécurisé" },
      { name: "SSH+Payload", port: 80, transport: "TCP", security: "SSH+Payload", description: "Bypass DPI" },
    ];

    return res.json({
      subscriptionUrl: null,
      protocols: FALLBACK_PROTOCOLS,
      serverInfo: { host: "vpnsxb.afrihall.com", location: "France / Europe" },
    });
  } catch {
    return res.status(500).json({ error: "errors.server" });
  }
});

// POST /api/mobile/vpn/session
router.post("/vpn/session", async (req: AuthenticatedRequest, res) => {
  const { action } = req.body;
  if (!["connect", "disconnect"].includes(action)) {
    return res.status(400).json({ error: "errors.validation", message: "Action invalide" });
  }
  return res.json({ message: "ok" });
});

// GET /api/mobile/notifications
router.get("/notifications", async (req: AuthenticatedRequest, res) => {
  try {
    const client = devClients.find((c) => c.userId === req.user!.userId);
    const notifications: unknown[] = [];
    const now = new Date().toISOString();

    if (!client) {
      notifications.push({
        id: "notif-no-client",
        type: "info",
        title: "Aucun compte actif",
        message: "Activez votre token SXB-USER pour commencer.",
        createdAt: now,
        read: false,
      });
      return res.json(notifications);
    }

    const state = computeAccountState(client);
    if (state.state === "expired") {
      notifications.push({
        id: "notif-expired",
        type: "warning",
        title: "Forfait expiré",
        message: "Votre forfait a expiré. Activez un nouveau code.",
        createdAt: now,
        read: false,
      });
    } else if (state.quotaRemainingGb < 1) {
      notifications.push({
        id: "notif-low",
        type: "warning",
        title: "Quota presque épuisé",
        message: "Il vous reste moins de 1 GB. Rechargez maintenant.",
        createdAt: now,
        read: false,
      });
    } else {
      notifications.push({
        id: "notif-ok",
        type: "success",
        title: "Compte actif",
        message: "Quota restant : " + Math.round(state.quotaRemainingGb) + " GB",
        createdAt: now,
        read: true,
      });
    }

    return res.json(notifications);
  } catch {
    return res.json([]);
  }
});

// GET /api/mobile/history
router.get("/history", async (req: AuthenticatedRequest, res) => {
  try {
    const client = devClients.find((c) => c.userId === req.user!.userId);
    const history: unknown[] = [];

    if (client) {
      const state = computeAccountState(client);
      history.push({
        id: "summary",
        action: "État du compte : " + state.state + " | Quota restant : " + Math.round(state.quotaRemainingGb) + " GB",
        type: "info",
        timestamp: new Date().toISOString(),
        isAccountSummary: true,
      });
    }

    return res.json(history);
  } catch {
    return res.json([]);
  }
});

export default router;

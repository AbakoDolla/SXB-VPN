import { Router, Request, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { prisma, inMemoryDb, logDbActivity } from "../database";
import { generateTokens, requireAuth, AuthenticatedRequest } from "../middleware/auth";
import { configHashForProfile, configVersionForProfile } from "../services/config-hash";
import { getActiveAnnouncements } from "./announcements";
import { getMobileAppUpdate, toMobileAppVersion } from "../services/app-update";
import { config } from "../config";

// ── AES-256-CBC decrypt (same key as vpn-profiles.ts) ─────────────────────────
const ENC_ALGO = "aes-256-cbc";
const ENC_KEY = config.ENCRYPTION_KEY;

function decryptField(enc: string | null | undefined): string | null {
  if (!enc) return null;
  try {
    if (!enc.includes(":")) return enc; // not encrypted — return as-is
    const [ivHex, encHex] = enc.split(":");
    const k = crypto.createHash("sha256").update(ENC_KEY).digest();
    const d = crypto.createDecipheriv(ENC_ALGO, k, Buffer.from(ivHex, "hex"));
    return Buffer.concat([d.update(Buffer.from(encHex, "hex")), d.final()]).toString();
  } catch {
    return enc; // fallback: return raw value if decryption fails
  }
}

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
    const clients = await (prisma as any).vpnClient.findMany({ include: { user: true, subscriptions: true } });
    return clients.find((c: any) => normalizeToken(c.token) === normalized) || null;
  }
  const client: any = inMemoryDb.vpnClients.find((c) => normalizeToken(c.token) === normalized);
  if (!client) return null;
  const user = inMemoryDb.users.find((u) => u.id === client.userId);
  const subscriptions = inMemoryDb.subscriptions?.filter((s: any) => s.clientId === client.id) || [];
  return { ...client, user, subscriptions };
}

async function findClientByUserId(userId: string) {
  if (prisma) {
    return (prisma as any).vpnClient.findFirst({ where: { userId }, include: { user: true, subscriptions: true } });
  }
  const client: any = inMemoryDb.vpnClients.find((c) => c.userId === userId);
  if (!client) return null;
  const subscriptions = inMemoryDb.subscriptions?.filter((s: any) => s.clientId === client.id) || [];
  return { ...client, subscriptions };
}

// Deduplication memory store for (sessionId, seq)
const processedReports = new Set<string>();
const MAX_PROCESSED_REPORTS = 10000;

/**
 * A1 — Fonction unique d'application du delta de consommation data.
 * Une seule transaction Prisma, une seule autorité de stockage (`subscription.quotaUsed` & `vpnClient.quotaUsed`).
 * Idempotence par déduplication sur (sessionId, seq).
 * Garde anti-abus : rejet si deltaBytes < 0 ou deltaBytes > 5 Go par appel.
 */
export async function applyUsageDelta(
  clientId: string | null,
  subscriptionId: string | null,
  deltaBytes: bigint,
  sessionId?: string,
  seq?: number,
  uploadBytes: bigint = 0n,
  deviceId: string | null = null,
) {
  // Garde anti-abus : rejet si <= 0 ou > 5 Go par appel
  const MAX_DELTA = BigInt(5 * 1024 * 1024 * 1024); // 5 Go
  if (deltaBytes <= 0n || deltaBytes > MAX_DELTA) {
    return { applied: false, reason: "invalid_delta" };
  }

  // Idempotence : déduplication sur (sessionId, seq)
  if (sessionId && seq !== undefined) {
    const reportKey = `${sessionId}:${seq}`;
    if (processedReports.has(reportKey)) {
      return { applied: false, reason: "duplicate_report" };
    }
    processedReports.add(reportKey);
    if (processedReports.size > MAX_PROCESSED_REPORTS) {
      const first = processedReports.values().next().value;
      if (first) processedReports.delete(first);
    }
  }

  if (prisma) {
    await (prisma as any).$transaction(async (tx: any) => {
      let subId = subscriptionId;
      if (!subId && clientId) {
        const activeSub = await tx.subscription.findFirst({
          where: { clientId, status: "active" },
          orderBy: { createdAt: "desc" },
        });
        subId = activeSub?.id;
      }

      if (subId) {
        await tx.subscription.update({
          where: { id: subId },
          data: { quotaUsed: { increment: deltaBytes } },
        });
      }

      if (clientId) {
        await tx.vpnClient.update({
          where: { id: clientId },
          data: { quotaUsed: { increment: deltaBytes } },
        });
      }
    });

    if (clientId) {
      await (prisma as any).trafficUsage.create({
        data: {
          clientId,
          accountId: subscriptionId,
          deviceId: deviceId || null,
          accountType: 'subscription',
          download: deltaBytes - uploadBytes,
          upload: uploadBytes,
        },
      }).catch(() => {});
      if (subscriptionId && deviceId && (prisma as any).subscriptionDevice) {
        await (prisma as any).subscriptionDevice.updateMany({
          where: { subscriptionId, deviceId },
          data: { lastSeenAt: new Date() },
        }).catch(() => {});
      }
    }
  } else {
    // In-memory fallback
    if (subscriptionId) {
      const sub = inMemoryDb.subscriptions?.find((s: any) => s.id === subscriptionId);
      if (sub) sub.quotaUsed = BigInt(sub.quotaUsed || 0) + deltaBytes;
    }
    if (clientId) {
      const client = inMemoryDb.vpnClients?.find((c: any) => c.id === clientId);
      if (client) client.quotaUsed = BigInt(client.quotaUsed || 0) + deltaBytes;
    }
  }

  return { applied: true };
}

// Compute the single source of truth for the mobile "smart button" state.
function selectMobileSubscription(client: any, requestedId?: string | null): any | null {
  const subscriptions = Array.isArray(client?.subscriptions) ? client.subscriptions : [];
  const requested = requestedId?.trim();
  if (requested) {
    return subscriptions.find((s: any) => s.id === requested) || null;
  }
  return subscriptions
    .filter((s: any) => s.status === "active")
    .sort((a: any, b: any) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())[0] || null;
}

function computeAccountState(client: any, selectedSubscription?: any | null): {
  state: "no_package" | "ready" | "connected" | "exhausted" | "expired" | "suspended" | "revoked";
  quotaTotalGb: number;
  quotaUsedGb: number;
  quotaRemainingGb: number;
  quotaTotalBytes: number;
  quotaUsedBytes: number;
  quotaRemainingBytes: number;
  expireAt: string | null;
  deviceLimit: number;
} {
  const source = selectedSubscription || client;
  const quotaTotalBytes = Number(source.quotaBytes ?? source.quotaTotal ?? 0);
  const quotaUsedBytes = Number(source.quotaUsed ?? 0);
  const quotaRemainingBytes = Math.max(quotaTotalBytes - quotaUsedBytes, 0);

  const quotaTotalGb = quotaTotalBytes / (1024 ** 3);
  const quotaUsedGb = quotaUsedBytes / (1024 ** 3);
  const quotaRemainingGb = Math.max(quotaTotalGb - quotaUsedGb, 0);

  const sourceExpireAt = source.expireAt ?? client.expireAt ?? null;
  const expireAt: string | null = sourceExpireAt ? new Date(sourceExpireAt).toISOString() : null;
  const now = Date.now();
  const isExpired = !!sourceExpireAt && new Date(sourceExpireAt).getTime() < now;

  // F3 — présence d'une souscription ACTIVE avec plan ⇒ état 'ready'/'active' jamais 'no_package'
  const hasActiveSubscription = Array.isArray(client.subscriptions) && client.subscriptions.some(
    (s: any) => s.status === "active" && (Number(s.quotaBytes || 0) > 0 || (s.durationDays && s.durationDays > 0) || s.name || s.plan || s.profileId)
  );

  let state: "no_package" | "ready" | "connected" | "exhausted" | "expired" | "suspended" | "revoked" = "no_package";
  if (client.status === "revoked" || selectedSubscription?.status === "revoked") {
    state = "revoked";
  } else if (client.status === "suspended" || selectedSubscription?.status === "suspended") {
    state = "suspended";
  } else if (selectedSubscription?.status === "expired") {
    state = "expired";
  } else if (!selectedSubscription && (!client.quotaTotal || Number(client.quotaTotal) === 0) && !hasActiveSubscription && !client.plan) {
    state = "no_package";
  } else if (isExpired) {
    state = "expired";
  } else if ((quotaRemainingGb <= 0 || quotaRemainingBytes <= 0) && quotaTotalBytes > 0) {
    state = "exhausted";
  } else {
    state = "ready"; // vpn_connected is tracked client-side by the native tunnel, "ready" just means eligible
  }

  return {
    state,
    quotaTotalGb,
    quotaUsedGb,
    quotaRemainingGb,
    quotaTotalBytes,
    quotaUsedBytes,
    quotaRemainingBytes,
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
    
    if (client.status === "suspended" || client.status === "revoked" || client.status === "disabled") {
      return res.status(403).json({ error: "errors.mobile.account_blocked", message: "Ce compte VPN est suspendu, révoqué ou désactivé" });
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
    const decoded = jwt.verify(refreshToken, config.REFRESH_SECRET);
    const client = await findClientByUserId(decoded.userId);
    if (!client || client.status !== 'active') {
      return res.status(403).json({ error: 'errors.mobile.account_blocked', message: 'Compte VPN suspendu ou supprimé — réactivation requise' });
    }
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
    const requestedSubscriptionId = typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : null;
    const selectedSubscription = selectMobileSubscription(client, requestedSubscriptionId);
    return res.json({ accountState: computeAccountState(client, selectedSubscription), user: client.user ? { id: client.user.id, name: client.user.name } : { id: req.user.userId, name: "Utilisateur" }, accountToken: client.token });
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
    { name: "SSH+Payload", port: 443,  transport: "TCP",  security: "Bypass",  description: "Anti-DPI" },
  ];
  try {
    const client: any = await findClientByUserId(req.user!.userId);
    if (!client) return res.status(404).json({ error: "errors.mobile.no_account" });
    // Sans identifiant : dernier abonnement actif (compatibilité). Avec
    // subscriptionId : ne jamais substituer un autre profil lors d'une bascule.
    const requestedSubscriptionId = typeof req.query.subscriptionId === 'string'
      ? req.query.subscriptionId.trim()
      : '';
    let sub: any = null;
    if (prisma) {
      sub = await (prisma as any).subscription.findFirst({
        where: requestedSubscriptionId
          ? { clientId: client.id, id: requestedSubscriptionId }
          : { clientId: client.id, status: "active" },
        include: { profile: true },
        orderBy: { createdAt: "desc" },
      });
    }
    if (requestedSubscriptionId && !sub) {
      return res.status(404).json({ error: 'errors.mobile.connection_not_found', message: 'Connexion VPN introuvable' });
    }

    const state = computeAccountState(client, sub);
    let subscriptionState = sub?.status || state.state;
    if (sub?.status === 'active') {
      if (sub.expireAt && new Date(sub.expireAt).getTime() < Date.now()) subscriptionState = 'expired';
      else if (Number(sub.quotaBytes ?? 0) > 0 && Number(sub.quotaUsed ?? 0) >= Number(sub.quotaBytes)) subscriptionState = 'exhausted';
    }
    const profile = subscriptionState === 'active' ? (sub?.profile || null) : null;
    const proto = (profile?.protocol || "ssh").toLowerCase(); // "ssh" | "ssh+payload" | "vless" …

    // ── Charger le payload SSH (via JOIN Prisma d'abord, puis requête séparée) ─
    let payloadContent: string | null = null;
    if (profile?.payload?.content) {
      // Contenu ramené directement par le JOIN (chemin normal)
      payloadContent = profile.payload.content;
    } else if (profile?.payloadId && prisma) {
      // Fallback : requête séparée si le JOIN n'a pas ramené le contenu
      try {
        const sshPayload = await (prisma as any).sshPayload.findUnique({
          where: { id: profile.payloadId },
        });
        payloadContent = sshPayload?.content || null;
      } catch (e) {
        console.error("Erreur chargement payload SSH:", e);
      }
    }
    // Payload WebSocket par défaut pour ssh+payload si aucun payload n'est configuré
    // Garantit que le module natif Android n'entre pas en mode SSH direct sur port 443
    if (!payloadContent && proto === "ssh+payload") {
      payloadContent = "GET / HTTP/1.1[crlf]Host: [host][crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf][crlf]";
    }

    // ── Déchiffrer le mot de passe avant envoi au mobile ─────────────────
    const decryptedPassword = decryptField(profile?.password);

    const protocols = profile
      ? [{ name: proto === "ssh+payload" ? "SSH+Payload" : proto.toUpperCase(), port: profile.port, transport: (profile.network || "tcp").toUpperCase(), security: profile.tls ? "TLS" : "Bypass", description: "Actif — " + profile.name }]
      : FALLBACK;

    let connectionUri: string | null = null;
    if (profile) {
      if (proto === "ssh" || proto === "ssh+payload") {
        connectionUri = "ssh://" + (profile.username || "user") + "@" + profile.host + ":" + profile.port;
        if (profile.sni) connectionUri += "?sni=" + encodeURIComponent(profile.sni);
        if (proto === "ssh+payload") connectionUri += (connectionUri.includes("?") ? "&" : "?") + "mode=payload";
      }
    }

    // ── Réponse sécurisée — AUCUN credential en clair ─────────────────────────
    // Les credentials (host, port, username, password, uuid, payload) ne sont
    // plus exposés ici. Ils transitent uniquement via /api/provision/activate
    // (chiffrés AES-256-GCM, liés à l'appareil, stockés dans Android Keystore).
    return res.json({
      state: subscriptionState,
      protocols,
      serverInfo: { location: profile ? "SXB" : "Africa / Cameroun" },
      // connectionUri exposé uniquement pour affichage informatif (pas de credential)
      connectionUri: connectionUri ? connectionUri.replace(/:\/\/.*@/, '://***@') : null,
      profile: profile ? {
        id:              profile.id,
        name:            profile.name,
        protocol:        proto,
        displayProtocol: profile.displayProtocol || null,
        // ❌ Champs supprimés : host, port, username, password, uuid, payload, sni, path
      } : null,
      // vpnConfig : métadonnées uniquement — les credentials viennent du SecureStore via /provision
      vpnConfig: profile ? {
        configId:        profile.id,
        protocol:        proto,
        displayProtocol: profile.displayProtocol || null,
        // §6.4 — métadonnées d'invalidation de cache mobile
        configVersion:   configVersionForProfile(profile),
        configHash:      configHashForProfile(profile),
        // ❌ Champs supprimés : host, port, username, password, sni, uuid, payload, etc.
      } : null,
      // Quota de l'abonnement demandé. Le fallback client préserve les anciens comptes
      // qui n'ont pas encore de quotas séparés par Subscription.
      quota: {
        totalQuota:  sub?.quotaBytes !== undefined ? Number(sub.quotaBytes) : (client.quotaTotal ? Number(client.quotaTotal) : 0),
        usedQuota:   sub?.quotaUsed  !== undefined ? Number(sub.quotaUsed)  : Number(client.quotaUsed ?? 0),
        expiryDate:  sub?.expireAt ? new Date(sub.expireAt).toISOString() : (client.expireAt ? new Date(client.expireAt).toISOString() : null),
      },
      subscription: sub ? {
        id:        sub.id,
        name:      sub.name,
        dataToken: sub.dataToken,   // Token SXB-DATA — utilisé par le mobile pour /provision/activate
        expireAt:  sub.expireAt?.toISOString(),
        status:    subscriptionState,
      } : null,
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
    const client: any = await findClientByUserId(req.user!.userId);
    if (!client) {
      return res.status(404).json({ error: "errors.mobile.no_account" });
    }
    if (client.status === "suspended" || client.status === "revoked" || client.status === "disabled") {
      return res.status(403).json({ error: "errors.mobile.account_suspended", message: "Compte suspendu ou révoqué" });
    }
    await logDbActivity(req.user!.userId, `Mobile VPN session ${action}`, "success", req.ip);
    return res.json({ message: "ok" });
  } catch (err) {
    return res.status(400).json({ error: "errors.validation", message: "Action invalide" });
  }
});


// GET /api/mobile/notifications — notifications basées sur l'état du compte
router.get('/notifications', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const client: any = await findClientByUserId(req.user!.userId);
    if (!client) return res.json([]);

    const requestedSubscriptionId = typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : null;
    const selectedSubscription = selectMobileSubscription(client, requestedSubscriptionId);
    const state = computeAccountState(client, selectedSubscription);
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
    } else if (state.state === 'exhausted') {
      notifications.push({
        id: 'notif-exhausted-' + Date.now(),
        type: 'warning',
        title: 'Quota épuisé',
        message: 'Votre quota data est épuisé. Rechargez votre forfait pour continuer.',
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

    // Annonces administratives persistantes : visibles globalement ou ciblées sur cet appareil précis.
    try {
      const deviceIdHeader = String(req.headers['x-sxb-device-id'] || req.query.deviceId || '').trim();
      const announcements = await getActiveAnnouncements();
      for (const announcement of announcements) {
        // Si une annonce est ciblée sur un appareil précis et que l'ID ne correspond pas, on l'ignore.
        if (announcement.targetDeviceId && announcement.targetDeviceId !== deviceIdHeader) {
          continue;
        }
        notifications.push({
          id: `announcement-${announcement.id}`,
          type: announcement.level,
          title: announcement.title,
          message: announcement.message,
          createdAt: announcement.createdAt,
          read: false,
          announcement: true,
        });
      }
    } catch (_) { /* les alertes de compte restent disponibles si la DB est indisponible */ }

    // Mise à jour applicative : seulement pour une app enregistrée, activée et ciblée.
    try {
      const deviceId = String(req.headers['x-sxb-device-id'] || req.query.deviceId || '').trim();
      const appUpdate = await getMobileAppUpdate(deviceId);
      if (appUpdate) {
        const version = toMobileAppVersion(appUpdate);
        notifications.push({
          id: `app-update-${version.versionCode}`,
          type: 'info',
          title: 'Nouvelle version SXB VPN disponible',
          message: `${version.versionName} est disponible. Téléchargez-la depuis cette notification.`,
          createdAt: version.publishedAt,
          read: false,
          appUpdate: true,
          actionType: 'download_app_update',
          downloadUrl: version.apkUrl,
          versionCode: version.versionCode,
          versionName: version.versionName,
          minSupportedCode: version.minSupportedCode,
          forceUpdate: version.forceUpdate,
          notes: version.notes,
        });
      }
    } catch (_) { /* une mise à jour indisponible ne bloque pas les notifications */ }

    // Ajouter les mises à jour support et les derniers logs d'audit si disponibles
    if (prisma) {
      try {
        const resolvedTickets = await prisma.supportTicket.findMany({
          where: {
            userId: req.user!.userId,
            status: { in: ['resolved', 'closed'] },
            updatedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          },
          orderBy: { updatedAt: 'desc' },
          take: 5,
          select: { id: true, title: true, status: true, updatedAt: true },
        });
        for (const ticket of resolvedTickets) {
          notifications.push({
            id: `ticket-${ticket.id}-${ticket.status}`,
            type: 'success',
            title: ticket.status === 'resolved' ? 'Ticket résolu' : 'Ticket clôturé',
            message: `Votre demande « ${ticket.title} » a été ${ticket.status === 'resolved' ? 'résolue' : 'clôturée'}.`,
            createdAt: ticket.updatedAt.toISOString(),
            read: false,
          });
        }

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

// GET /api/mobile/version & /api/mobile/app-version — vérification de version et lien de téléchargement APK
router.get(['/version', '/app-version'], async (req: Request, res: Response) => {
  const deviceId = String(req.headers['x-sxb-device-id'] || req.query.deviceId || '').trim();
  const published = await getMobileAppUpdate(deviceId).catch(() => null);
  if (published) return res.json(toMobileAppVersion(published));
  return res.json({
    versionCode: 0,
    versionName: "",
    minSupportedCode: 0,
    apkUrl: "",
    notes: "",
    forceUpdate: false,
  });
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
        const historyStatus = log.type === 'success' || log.type === 'error' ? log.type : 'info';
        history.push({
          id: log.id,
          action: log.action,
          description: log.action,
          createdAt: log.timestamp.toISOString(),
          status: historyStatus,
          ipAddress: log.ipAddress || null,
        });
      }
    }

    // Ajouter info quota si disponible
    if (client) {
      const state = computeAccountState(client);
      const summary = 'Etat du compte : ' + state.state + ' | Quota restant : ' + state.quotaRemainingGb.toFixed(2) + ' GB';
      history.unshift({
        id: 'account-state-current',
        action: 'account_state',
        description: summary,
        createdAt: new Date().toISOString(),
        status: 'info',
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

// POST /api/mobile/vpn/traffic — synchronisation consommation data réelle
// Appelé toutes les 60s par VpnContext quand VPN actif + à la déconnexion.
// Reçoit le DELTA et applique via applyUsageDelta (autorité unique).
router.post("/vpn/traffic", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schema = z.object({
      bytesUp:   z.number().int().min(0),
      bytesDown: z.number().int().min(0),
      sessionId: z.string().optional(),
      seq:       z.number().int().min(0).optional(),
      reportMode: z.enum(['delta','absolute']).optional(),
      subscriptionId: z.string().optional(),
      deviceId: z.string().min(5).optional(),
    });
    const { bytesUp, bytesDown, sessionId, seq, subscriptionId, deviceId } = schema.parse(req.body);
    const totalBytes = BigInt(bytesUp + bytesDown);

    const client: any = await findClientByUserId(req.user!.userId);
    if (!client) return res.status(404).json({ error: "errors.mobile.no_account" });

    if (totalBytes > 0n) {
      await applyUsageDelta(client.id, subscriptionId || null, totalBytes, sessionId, seq, BigInt(bytesUp), deviceId || null);
    }

    const updatedClient: any = await findClientByUserId(req.user!.userId);
    const selectedSub = subscriptionId
      ? (updatedClient?.subscriptions || []).find((s: any) => s.id === subscriptionId)
      : (updatedClient?.subscriptions || []).find((s: any) => s.status === "active");
    const state = computeAccountState(updatedClient || client, selectedSub);
    const quotaExhausted = state.quotaTotalBytes > 0 && state.quotaRemainingBytes <= 0;
    return res.json({
      ok: true,
      quotaRemainingGb: state.quotaRemainingGb,
      quotaRemainingBytes: state.quotaRemainingBytes,
      quotaExhausted,
      state: state.state,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation" });
    }
    console.error("Traffic sync error:", err);
    return res.status(500).json({ error: "errors.server" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/mobile/connections — toutes les connexions VPN d'un client
// Retourne chaque Subscription avec displayProtocol ET technicalProtocol séparés
// ─────────────────────────────────────────────────────────────────────────────
router.get("/connections", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const client: any = await findClientByUserId(req.user!.userId);
    if (!client) {
      return res.status(404).json({ error: "errors.mobile.no_account", message: "Aucun compte VPN associé" });
    }

    if (!prisma) {
      return res.json({ connections: [] });
    }

    const subscriptions = await (prisma as any).subscription.findMany({
      where:   { clientId: client.id },
      orderBy: { createdAt: "desc" },
      include: { profile: true },
    });

    const now = Date.now();

    const connections = subscriptions.map((sub: any) => {
      const profile = sub?.profile || null;

      // Protocol technique (SSH, VLESS, Trojan…)
      const technicalProtocol = profile?.protocol || "ssh";

      // Protocol affiché (nom commercial défini dans le dashboard, sinon fallback technique)
      const displayProtocol = profile?.displayProtocol ||
        (technicalProtocol === "ssh+payload" ? "SSH+Payload" : technicalProtocol.toUpperCase());

      const totalBytes     = Number(sub.quotaBytes ?? 0);
      const usedBytes      = Number(sub.quotaUsed  ?? 0);
      const remainingBytes = Math.max(totalBytes - usedBytes, 0);
      const GB             = 1024 ** 3;

      // Calculer le statut réel (expired si dépassé la date, exhausted si quota dépassé)
      let status = sub.status;
      if (status === "active") {
        if (sub.expireAt && new Date(sub.expireAt).getTime() < now) {
          status = "expired";
        } else if (totalBytes > 0 && remainingBytes <= 0) {
          status = "exhausted";
        }
      }

      return {
        id:                sub.id,
        name:              sub.name || "Connexion VPN",
        displayProtocol,
        technicalProtocol,
        quota: {
          totalGB:     totalBytes / GB,
          usedGB:      usedBytes  / GB,
          remainingGB: remainingBytes / GB,
          totalBytes,
          usedBytes,
        },
        duration:   sub.durationDays,
        expiresAt:  sub.expireAt ? new Date(sub.expireAt).toISOString() : null,
        status,
        dataToken:  sub.dataToken,
        createdAt:  sub.createdAt ? new Date(sub.createdAt).toISOString() : new Date().toISOString(),
        configVersion: configVersionForProfile(profile),
        configHash:    configHashForProfile(profile),
      };
    });

    return res.json({ connections });
  } catch (err) {
    console.error("Mobile /connections error:", err);
    return res.status(500).json({ error: "errors.server", message: "Impossible de charger les connexions" });
  }
});

// A4 — POST /api/mobile/connections/:id/status — marque un abonnement/connexion comme 'exhausted' ou 'expired'
router.post("/connections/:id/status", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const schema = z.object({
      disabledReason: z.enum(['exhausted', 'expired']),
    });
    const { disabledReason } = schema.parse(req.body);

    if (prisma) {
      await (prisma as any).subscription.update({
        where: { id },
        data: { status: disabledReason },
      }).catch(() => null);
    } else {
      const sub = inMemoryDb.subscriptions?.find((s: any) => s.id === id);
      if (sub) sub.status = disabledReason;
    }

    return res.json({ success: true, id, status: disabledReason });
  } catch (err) {
    return res.status(400).json({ error: "errors.validation" });
  }
});

// POST /api/mobile/vpn/usage — support usage data upload for V2Ray / general configs (Dashboard sync)
const usageSchema = z.object({
  download:       z.number().int().min(0),       // bytes
  upload:         z.number().int().min(0),         // bytes
  duration:       z.number().int().min(0),       // seconds
  deviceId:       z.string().optional(),
  subscriptionId: z.string().optional(),
  sessionId:      z.string().optional(),
  seq:            z.number().int().min(0).optional(),
});

router.post("/vpn/usage", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { download, upload, duration, deviceId, subscriptionId, sessionId, seq } = usageSchema.parse(req.body);
    const totalBytes = BigInt(download + upload);

    let client: any = await findClientByUserId(req.user!.userId);
    if (!client && deviceId && prisma) {
      client = await (prisma as any).vpnClient.findUnique({ where: { deviceId } });
    }

    if (!client) {
      return res.status(404).json({ error: "errors.mobile.no_account", message: "Client non trouvé" });
    }

    if (totalBytes > 0n) {
      await applyUsageDelta(client.id, subscriptionId || null, totalBytes, sessionId, seq, BigInt(upload), deviceId || null);
    }

    const updatedClient: any = await findClientByUserId(req.user!.userId);
    const state = computeAccountState(updatedClient || client);

    return res.json({
      success: true,
      message: "Usage enregistré avec succès",
      quotaRemainingGb: state.quotaRemainingGb,
      quotaRemainingBytes: state.quotaRemainingBytes,
      state: state.state,
    });
  } catch (err: any) {
    console.error("vpn/usage endpoint error:", err);
    return res.status(500).json({ error: "errors.server", message: "Erreur enregistrement de consommation" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Support mobile — tickets associés exclusivement à l’utilisateur authentifié.
// Le dashboard conserve l’administration complète via /api/support.
// ─────────────────────────────────────────────────────────────────────────────
const mobileTicketSchema = z.object({
  subject: z.string().trim().min(3).max(200),
  message: z.string().trim().min(5).max(5000),
  priority: z.enum(['low', 'medium', 'high']).optional(),
});

router.get('/support/tickets', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) {
      return res.status(503).json({ error: 'DB_UNAVAILABLE', message: 'Support temporairement indisponible' });
    }
    const tickets = await prisma.supportTicket.findMany({
      where: { userId: req.user!.userId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: {
        id: true, title: true, description: true, priority: true, status: true,
        createdAt: true, updatedAt: true,
      },
    });
    return res.json({ tickets });
  } catch (err) {
    console.error('Mobile support tickets fetch error:', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Impossible de récupérer les tickets' });
  }
});

async function createMobileTicket(req: AuthenticatedRequest, res: Response) {
  try {
    if (!prisma) {
      return res.status(503).json({ error: 'DB_UNAVAILABLE', message: 'Support temporairement indisponible' });
    }
    const body = mobileTicketSchema.parse(req.body);
    const client: any = await findClientByUserId(req.user!.userId);
    const clientName = String(client?.user?.name || 'Client SXB').slice(0, 100);
    const ticket = await prisma.supportTicket.create({
      data: {
        title: body.subject,
        description: body.message,
        priority: body.priority || 'medium',
        status: 'open',
        clientName,
        userId: req.user!.userId,
      },
      select: {
        id: true, title: true, description: true, priority: true, status: true,
        createdAt: true, updatedAt: true,
      },
    });
    await logDbActivity(req.user!.userId, `Ticket mobile ouvert: "${body.subject}"`, 'info', req.ip || '');
    return res.status(201).json({ ticket, message: 'Ticket envoyé au support' });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Sujet ou message invalide' });
    }
    console.error('Mobile support ticket create error:', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Impossible de créer le ticket' });
  }
}

// Compatibilité avec la première version de l’application, puis route plurielle.
router.post('/support/ticket', createMobileTicket);
router.post('/support/tickets', createMobileTicket);

export default router;

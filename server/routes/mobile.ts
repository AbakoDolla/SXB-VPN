import { Router, Request, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { accessStateHub } from "../services/access-state-events";
import mobileAccessRouter from "./mobile-access";
import { refreshMobileSession } from "../services/mobile-session-refresh";
import { deviceIdFromRequest } from "../services/mobile-principal";
import {
  deviceAccessStatus, deviceAccessFailure, subscriptionAccessStatus, subscriptionAccessFailure,
  MobileAccessError, sessionInvalidFailure,
} from "../services/access-lifecycle";
import { prisma, inMemoryDb, logDbActivity } from "../database";
import { generateTokens, requireAuth, AuthenticatedRequest } from "../middleware/auth";
import { configHashForProfile, configVersionForProfile } from "../services/config-hash";
import { getActiveAnnouncements } from "./announcements";
import { getMobileAppUpdate, toMobileAppVersion } from "../services/app-update";
import { PlafondQuotaDepasse } from "../services/reseller-quota";
import { CODES_ACTIVATION, evaluerActivation } from "../services/device-activation";
import {
  chargerFicheProprietaireClient,
  chargerFicheRevendeur,
  refusAccesProprietaireClient,
} from "../services/reseller-access";
import {
  appliquerVoucherAuClient,
  VoucherRedemptionError,
} from "../services/voucher-redemption";
import { forfaitsEssaiDuClient } from "../services/free-trial-marks";

// ── AES-256-CBC decrypt (same key as vpn-profiles.ts) ─────────────────────────
const ENC_ALGO = "aes-256-cbc";
const ENC_KEY = (() => { const k = process.env.ENCRYPTION_KEY; if (!k) console.error("[SECURITY] ENCRYPTION_KEY not set — insecure fallback active!"); return k || "sxb-vpn-32-byte-encryption-key-!"; })();

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
router.use(mobileAccessRouter);
const mobileAccountInclude = {
  user: true, subscriptions: { include: { profile: { select: { status: true } } } },
} as const;

// -------------------------------------------------------------------------
// SXB VPN Mobile API
// Dedicated, token-only surface for the official mobile app. End users never
// see servers/IP/protocol details - they only ever handle two token formats:
//   - Account token:  SXB-USER-XXXX-XXXX-XXXX  (identifies + activates a VpnClient)
//   - Package token:  SXB-DATA-XXXX-XXXX-XXXX  (a subscription provision token)
// Legacy VCH-XXXXX-XXXXX vouchers remain accepted by /packages/activate.
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
    // Lecture indexée d'abord : la variante par balayage complet chargeait les
    // 84 comptes du parc à chaque activation, jointures comprises.
    const direct = await (prisma as any).vpnClient.findUnique({
      where: { token: normalized },
      include: mobileAccountInclude,
    });
    if (direct) return direct;
    // Repli : jetons historiques stockés avec une casse ou des espaces autres.
    const clients = await (prisma as any).vpnClient.findMany({ include: mobileAccountInclude });
    return clients.find((c: any) => normalizeToken(c.token) === normalized) || null;
  }
  const client: any = inMemoryDb.vpnClients.find((c) => normalizeToken(c.token) === normalized);
  if (!client) return null;
  const user = inMemoryDb.users.find((u) => u.id === client.userId);
  const subscriptions = inMemoryDb.subscriptions?.filter((s: any) => s.clientId === client.id) || [];
  return { ...client, user, subscriptions };
}

async function findClientByUserId(userId: string, clientId?: string | null, deviceId?: string | null) {
  if (prisma) {
    const clients = await (prisma as any).vpnClient.findMany({
      where: clientId
        ? { id: clientId, userId, ...(deviceId ? { deviceId } : {}) }
        : deviceId
          ? { userId, deviceId }
          : { userId },
      include: mobileAccountInclude,
      take: 2,
    });
    return clients.length === 1 ? clients[0] : null;
  }
  const client: any = inMemoryDb.vpnClients.find(
    (c) =>
      c.userId === userId &&
      (!clientId || c.id === clientId) &&
      (!deviceId || c.deviceId === deviceId)
  );
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
  if (deltaBytes <= 0n || deltaBytes > MAX_DELTA || uploadBytes < 0n || uploadBytes > deltaBytes) {
    return { applied: false, reason: "invalid_delta" };
  }
  if (!clientId) return { applied: false, reason: "client_required" };

  // Idempotence : déduplication sur (sessionId, seq)
  const reportKey = sessionId && seq !== undefined ? `${clientId}:${sessionId}:${seq}` : null;
  if (reportKey) {
    if (processedReports.has(reportKey)) {
      return { applied: false, reason: "duplicate_report" };
    }
    processedReports.add(reportKey);
    if (processedReports.size > MAX_PROCESSED_REPORTS) {
      const first = processedReports.values().next().value;
      if (first) processedReports.delete(first);
    }
  }

  try {
  let resolvedSubscriptionId = subscriptionId;
  if (prisma) {
    await (prisma as any).$transaction(async (tx: any) => {
      let subId = resolvedSubscriptionId;
      if (!subId && clientId) {
        const activeSub = await tx.subscription.findFirst({
          where: { clientId, status: "active" },
          orderBy: { createdAt: "desc" },
        });
        subId = activeSub?.id;
      }

      if (subId) {
        if (!clientId) {
          resolvedSubscriptionId = null;
          return;
        }
        const updated = await tx.subscription.updateMany({
          where: { id: subId, clientId },
          data: { quotaUsed: { increment: deltaBytes } },
        });
        if (updated.count !== 1) {
          resolvedSubscriptionId = null;
          return;
        }
        resolvedSubscriptionId = subId;
      }

      if (clientId) {
        await tx.vpnClient.update({
          where: { id: clientId },
          data: { quotaUsed: { increment: deltaBytes } },
        });
        await tx.trafficUsage.create({
          data: {
            clientId,
            accountId: resolvedSubscriptionId,
            deviceId: deviceId || null,
            accountType: 'subscription',
            download: deltaBytes - uploadBytes,
            upload: uploadBytes,
          },
        });
        if (resolvedSubscriptionId && deviceId) {
          await tx.subscriptionDevice.updateMany({
            where: { subscriptionId: resolvedSubscriptionId, deviceId },
            data: { lastSeenAt: new Date() },
          });
        }
      }
    });

    if (subscriptionId && !resolvedSubscriptionId) {
      if (reportKey) processedReports.delete(reportKey);
      return { applied: false, reason: "subscription_not_owned" };
    }
  } else {
    // In-memory fallback
    if (resolvedSubscriptionId) {
      const sub = inMemoryDb.subscriptions?.find(
        (s: any) => s.id === resolvedSubscriptionId && s.clientId === clientId
      );
      if (!sub) {
        if (reportKey) processedReports.delete(reportKey);
        return { applied: false, reason: "subscription_not_owned" };
      }
      if (sub) sub.quotaUsed = BigInt(sub.quotaUsed || 0) + deltaBytes;
    }
    if (clientId) {
      const client = inMemoryDb.vpnClients?.find((c: any) => c.id === clientId);
      if (client) client.quotaUsed = BigInt(client.quotaUsed || 0) + deltaBytes;
    }
  }

  if (subscriptionId && !resolvedSubscriptionId) {
    return { applied: false, reason: "subscription_not_owned" };
  }
  accessStateHub.invalidate({ clientId });
  return { applied: true, subscriptionId: resolvedSubscriptionId };
  } catch (error) {
    if (reportKey) processedReports.delete(reportKey);
    throw error;
  }
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

export function computeAccountState(client: any, selectedSubscription?: any | null): {
  state: "no_package" | "ready" | "connected" | "exhausted" | "expired" | "suspended" | "revoked";
  quotaTotalGb: number;
  quotaUsedGb: number;
  quotaRemainingGb: number;
  quotaTotalBytes: number;
  quotaUsedBytes: number;
  quotaRemainingBytes: number;
  expireAt: string | null;
  deviceLimit: number;
  device: { id: string; status: string; code: string; expireAt: string | null; activationRequired: boolean };
  subscription: { id: string; status: string } | null;
  subscriptionState: string | null;
} {
  selectedSubscription = selectedSubscription ?? selectMobileSubscription(client);
  const source = selectedSubscription || client;
  const quotaTotalBytes = Number(source.quotaBytes ?? source.quotaTotal ?? 0);
  const quotaUsedBytes = Number(source.quotaUsed ?? 0);
  const quotaRemainingBytes = Math.max(quotaTotalBytes - quotaUsedBytes, 0);

  const quotaTotalGb = quotaTotalBytes / (1024 ** 3);
  const quotaUsedGb = quotaUsedBytes / (1024 ** 3);
  const quotaRemainingGb = Math.max(quotaTotalGb - quotaUsedGb, 0);

  const sourceExpireAt = source.expireAt ?? null;
  const expireAt: string | null = sourceExpireAt ? new Date(sourceExpireAt).toISOString() : null;
  const now = Date.now();
  const isExpired = !!sourceExpireAt && new Date(sourceExpireAt).getTime() < now;

  // F3 — présence d'une souscription ACTIVE avec plan ⇒ état 'ready'/'active' jamais 'no_package'
  const hasActiveSubscription = Array.isArray(client.subscriptions) && client.subscriptions.some(
    (s: any) => s.status === "active" && (Number(s.quotaBytes || 0) > 0 || (s.durationDays && s.durationDays > 0) || s.name || s.plan || s.profileId)
  );

  let state: "no_package" | "ready" | "connected" | "exhausted" | "expired" | "suspended" | "revoked" = "no_package";
  const deviceStatus = deviceAccessStatus(client);
  const selectedStatus = selectedSubscription ? subscriptionAccessStatus(selectedSubscription) : null;
  if (deviceStatus === "revoked" || deviceStatus === "deleted") {
    state = "revoked";
  } else if (deviceStatus === "suspended" || deviceStatus === "disabled") {
    state = "suspended";
  } else if (deviceStatus === "expired" || selectedStatus === "expired") {
    state = "expired";
  } else if (selectedStatus === "revoked" || selectedStatus === "deleted" || selectedStatus === "suspended") {
    state = "no_package";
  } else if (selectedStatus === "exhausted") {
    state = "exhausted";
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
    device: {
      id: client.id, status: deviceStatus,
      code: deviceStatus === "active" ? "DEVICE_ACTIVE" : `DEVICE_${deviceStatus.toUpperCase()}`,
      expireAt: client.expireAt ? new Date(client.expireAt).toISOString() : null,
      activationRequired: !client.activatedAt || !client.deviceId,
    },
    subscription: selectedSubscription ? { id: selectedSubscription.id, status: selectedStatus! } : null,
    subscriptionState: selectedStatus,
  };
}

// POST /api/mobile/auth/activate — first launch: pair the device with an account token
//
// Les blocages connus portent DEVICE_* + scope/temporary ; legacyCode conserve
// les anciens codes ci-dessous. Les erreurs de saisie/liaison restent distinctes.
// Ancien contrat (le mobile s'appuie sur le code, jamais sur le message) :
//   404 TOKEN_NOT_FOUND      — jeton inconnu
//   403 ACCOUNT_SUSPENDED    — compte VPN suspendu / révoqué / désactivé
//   403 RESELLER_EXPIRED     — accès du revendeur propriétaire expiré
//   403 RESELLER_SUSPENDED   — accès du revendeur propriétaire suspendu
//   410 TOKEN_EXPIRED        — échéance RÉELLEMENT dépassée, et rien d'autre
//   409 DEVICE_BOUND         — jeton déjà activé par un autre appareil
//   409 TOKEN_USED           — jeton déjà consommé
//
// Rejouer l'activation avec le même couple (jeton, appareil) est sans effet de
// bord et répond 200 : le mobile réessaie après coupure réseau.
const activateSchema = z.object({ 
  token: z.string().min(5),
  deviceId: z.string().optional(),
});
router.post("/auth/activate", async (req, res: Response) => {
  try {
    const { token, deviceId: incomingDeviceId } = activateSchema.parse(req.body);
    const client: any = await findClientByAccountToken(token);

    // Fiche du revendeur propriétaire : sa validité conditionne l'activation
    // de ses appareils. Un client sans revendeur (parc administrateur) n'est
    // soumis à aucune échéance revendeur.
    const ficheRevendeur = await chargerFicheProprietaireClient(prisma, client);

    const decision = evaluerActivation({
      client,
      deviceId: incomingDeviceId,
      reseller: ficheRevendeur,
    });

    if (!decision.ok) {
      const status = client ? deviceAccessStatus(client, ficheRevendeur) : "active";
      return res.status(decision.status).json({
        ...(status !== "active" ? deviceAccessFailure(status) : {}),
        error: decision.error,
        code: status !== "active" ? deviceAccessFailure(status).code : decision.code,
        ...(status !== "active" ? { legacyCode: decision.code } : {}),
        message: decision.message,
      });
    }

    // Liaison de l'appareil. Une pré-affectation portant déjà le même
    // deviceId doit elle aussi confirmer `activatedAt`, sinon le jeton reste
    // indéfiniment réassignable à un autre téléphone.
    const doitConfirmerAppareil =
      !!prisma &&
      !!decision.deviceId &&
      (decision.action === "bind" ||
        decision.action === "rebind" ||
        (decision.action === "already_bound" && !client.activatedAt));
    if (doitConfirmerAppareil) {
      const conflit = await (prisma as any).vpnClient.findFirst({
        where: {
          deviceId: decision.deviceId,
          id: { not: client.id },
        },
        select: { id: true },
      });
      if (conflit) {
        return res.status(409).json({
          error: "errors.mobile.device_claimed",
          code: CODES_ACTIVATION.DEVICE_CLAIMED,
          message: "Cet appareil est déjà lié à un autre compte",
        });
      }

      try {
        const claimed = await (prisma as any).vpnClient.updateMany({
          where: {
            id: client.id,
            activatedAt: null,
            deviceId: client.deviceId ?? null,
            status: "active",
          },
          data: {
            deviceId: decision.deviceId,
            activatedAt: client.activatedAt ?? new Date(),
          },
        });
        if (claimed.count !== 1) {
          const current = await (prisma as any).vpnClient.findUnique({
            where: { id: client.id },
            include: mobileAccountInclude,
          });
          const concurrent = evaluerActivation({
            client: current,
            deviceId: decision.deviceId,
            reseller: ficheRevendeur,
          });
          if (!concurrent.ok || !current?.activatedAt) {
            return res.status(concurrent.ok ? 409 : concurrent.status).json({
              error: concurrent.error || "errors.mobile.activation_conflict",
              code: concurrent.ok ? "ACTIVATION_CONFLICT" : concurrent.code,
              message: concurrent.message || "Activation modifiée par une autre requête. Réessayez.",
            });
          }
          Object.assign(client, current);
        }
      } catch (updateError: any) {
        if (updateError?.code === "P2002") {
          return res.status(409).json({
            error: "errors.mobile.device_claimed",
            code: CODES_ACTIVATION.DEVICE_CLAIMED,
            message: "Cet appareil est déjà lié à un autre compte",
          });
        }
        throw updateError;
      }
      client.deviceId = decision.deviceId;
      client.activatedAt = client.activatedAt ?? new Date();
      if (decision.action === "rebind") {
        await logDbActivity(
          client.user.id,
          `Appareil pré-affecté remplacé par le premier appareil activé (compte ${client.token})`,
          "info",
          req.ip
        );
      }
    }

    const tokens = generateTokens({
      userId: client.user.id,
      email: client.user.email,
      role: "CLIENT",
      clientId: client.id,
      ...(client.activatedAt && client.deviceId ? { deviceId: client.deviceId } : {}),
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
      // AUCUN forfait n'est créé ici. Un appareil peut vivre sans plan :
      // `accountState.state` vaut alors 'no_package', et l'attribution d'un
      // forfait reste une action explicite du revendeur ou de l'administrateur.
      accountState: computeAccountState(client),
      idempotent: decision.idempotent,
      user: { id: client.user.id, name: client.user.name },
      ...tokens,
    });
  } catch (err: any) {
    if (err?.issues) {
      return res.status(400).json({ error: "errors.validation", code: "VALIDATION", message: "Format de token invalide" });
    }
    console.error("Mobile activate error:", err);
    return res.status(500).json({ error: "errors.server", code: "SERVER_ERROR", message: "Échec de l'activation" });
  }
});

// POST /api/mobile/auth/refresh
const refreshSchema = z.object({ refreshToken: z.string() });
router.post("/auth/refresh", async (req, res: Response) => {
  try {
    const { refreshToken } = refreshSchema.parse(req.body);
    const decoded = jwt.verify(refreshToken, config.REFRESH_SECRET, { algorithms: ["HS256"] });
    if (typeof decoded === "string" || decoded.role !== "CLIENT" || typeof decoded.userId !== "string") {
      return res.status(401).json(sessionInvalidFailure());
    }
    const tokens = await refreshMobileSession(req, {
      userId: decoded.userId, role: decoded.role, clientId: decoded.clientId,
      deviceId: decoded.deviceId, exp: decoded.exp,
    });
    return res.json(tokens);
  } catch (err) {
    if (err instanceof MobileAccessError) return res.status(err.status).json(err.body);
    if (err instanceof jwt.JsonWebTokenError || err instanceof z.ZodError) {
      return res.status(401).json(sessionInvalidFailure());
    }
    console.error("Mobile refresh unavailable:", err);
    return res.status(503).json({ error: "errors.auth.unavailable", message: "Renouvellement de session temporairement indisponible" });
  }
});

// All routes below require a valid mobile session
router.use(requireAuth);

const pushTokenSchema = z.object({
  token: z.string().trim().min(20).max(4096),
  deviceId: z.string().trim().min(4).max(160),
  platform: z.literal("android"),
  appVersion: z.string().trim().max(40).nullable().optional(),
});

async function validatePushDevice(req: AuthenticatedRequest, deviceId: string): Promise<any | null> {
  const headerDeviceId = String(req.headers["x-sxb-device-id"] || "").trim();
  if (headerDeviceId && headerDeviceId !== deviceId) return null;
  if (prisma) {
    // Un revendeur peut posséder plusieurs lignes VpnClient. `findFirst` par
    // userId choisissait une ligne arbitraire et refusait tous les autres
    // appareils. La paire exacte utilisateur/appareil est l'autorité.
    return (prisma as any).vpnClient.findFirst({
      where: {
        ...(req.user!.clientId ? { id: req.user!.clientId } : {}),
        userId: req.user!.userId,
        deviceId,
        status: "active",
      },
      include: { user: true, subscriptions: true },
    });
  }
  return inMemoryDb.vpnClients.find((client) =>
    client.userId === req.user!.userId
    && String(client.deviceId || "").trim() === deviceId
    && client.status === "active"
  ) || null;
}

// Le jeton FCM n'est accepté qu'après authentification et pour l'appareil déjà
// lié au compte VPN. Il ne donne accès à aucune configuration ni aucun hôte VPN.
router.post("/push-tokens", async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) {
      return res.status(503).json({ error: "DB_UNAVAILABLE", message: "Enregistrement push indisponible" });
    }
    const input = pushTokenSchema.parse(req.body);
    if (!(await validatePushDevice(req, input.deviceId))) {
      return res.status(403).json({ error: "PUSH_DEVICE_MISMATCH", message: "Appareil non lié à ce compte" });
    }

    await (prisma as any).$transaction(async (tx: any) => {
      await tx.pushToken.deleteMany({
        where: {
          userId: req.user!.userId,
          deviceId: input.deviceId,
          token: { not: input.token },
        },
      });
      await tx.pushToken.upsert({
        where: { token: input.token },
        create: {
          token: input.token,
          userId: req.user!.userId,
          deviceId: input.deviceId,
          platform: input.platform,
          appVersion: input.appVersion || null,
        },
        update: {
          userId: req.user!.userId,
          deviceId: input.deviceId,
          platform: input.platform,
          appVersion: input.appVersion || null,
          active: true,
          lastSeenAt: new Date(),
        },
      });
    });
    return res.status(201).json({ registered: true, deviceId: input.deviceId });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(422).json({ error: "VALIDATION", message: err.issues[0]?.message || "Jeton push invalide" });
    }
    console.error("[FCM] Push token registration failed:", err?.code || err?.name || "UNKNOWN");
    return res.status(503).json({ error: "PUSH_REGISTRATION_FAILED", message: "Enregistrement push impossible" });
  }
});

router.delete("/push-tokens", async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) {
      return res.status(503).json({ error: "DB_UNAVAILABLE", message: "Désenregistrement push indisponible" });
    }
    const input = pushTokenSchema.pick({ token: true, deviceId: true }).parse(req.body);
    if (!(await validatePushDevice(req, input.deviceId))) {
      return res.status(403).json({ error: "PUSH_DEVICE_MISMATCH", message: "Appareil non lié à ce compte" });
    }
    const removed = await (prisma as any).pushToken.deleteMany({
      where: {
        token: input.token,
        userId: req.user!.userId,
        deviceId: input.deviceId,
      },
    });
    return res.json({ deregistered: removed.count > 0, removed: removed.count });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(422).json({ error: "VALIDATION", message: err.issues[0]?.message || "Jeton push invalide" });
    }
    console.error("[FCM] Push token deregistration failed:", err?.code || err?.name || "UNKNOWN");
    return res.status(503).json({ error: "PUSH_DEREGISTRATION_FAILED", message: "Désenregistrement push impossible" });
  }
});

// GET /api/mobile/me — everything the smart button + home screen needs
router.get("/me", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const client: any = await findClientByUserId(req.user!.userId, req.user!.clientId, deviceIdFromRequest(req));
    if (!client) {
      return res.status(404).json({ error: "errors.mobile.no_account", message: "Aucun compte VPN associé" });
    }
    const accessError = await refusAccesProprietaireClient(prisma, client);
    if (accessError) return res.status(accessError.status).json(accessError.body);
    const requestedSubscriptionId = typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : null;
    const selectedSubscription = selectMobileSubscription(client, requestedSubscriptionId);
    return res.json({ accountState: computeAccountState(client, selectedSubscription), user: client.user ? { id: client.user.id, name: client.user.name } : { id: req.user.userId, name: "Utilisateur" }, accountToken: client.token });
  } catch (err) {
    console.error("Mobile /me error:", err);
    return res.status(500).json({ error: "errors.server", message: "Échec du chargement du compte" });
  }
});

// GET /api/mobile/ip — adresse de sortie observée par le backend
//
// C7 — L'application affichait l'IP de sortie du tunnel en interrogeant
// api.ipify.org pendant que le VPN était actif. Ce tiers apprenait ainsi, à
// chaque connexion, l'adresse de sortie corrélée à un instant précis, alors que
// la page « mentions légales » de l'application affirme qu'aucune donnée n'est
// transmise à des tiers.
//
// Le backend voit déjà cette adresse à chaque requête de l'application : la lui
// renvoyer n'expose rien de nouveau et supprime le tiers. Rien n'est journalisé.
router.get("/ip", (req: AuthenticatedRequest, res: Response) => {
  // `trust proxy` vaut 1 dans server.ts : req.ip reflète l'en-tête
  // X-Forwarded-For réécrit par le reverse proxy.
  // Normaliser la forme IPv4 encapsulée en IPv6 (::ffff:203.0.113.7).
  const ip = String(req.ip || "").trim().replace(/^::ffff:/i, "");
  res.set("Cache-Control", "no-store");
  return res.json({ ip });
});

// POST /api/mobile/packages/activate — redeem a legacy VCH-XXXXX-XXXXX voucher.
// SXB-DATA tokens are activated by /api/provision/activate and are always tied
// to an explicit subscription.
const activatePackageSchema = z.object({
  code: z.string()
    .trim()
    .transform((value) => value.toUpperCase())
    .refine((value) => /^VCH-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(value)),
}).strict();
router.post("/packages/activate", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { code } = activatePackageSchema.parse(req.body);
    const normalized = normalizeToken(code);

    const client: any = await findClientByUserId(req.user!.userId, req.user!.clientId, deviceIdFromRequest(req));
    if (!client) {
      return res.status(404).json({ error: "errors.mobile.no_account", message: "Aucun compte VPN associé" });
    }

    const fiche = await chargerFicheProprietaireClient(prisma, client);
    const accessError = await refusAccesProprietaireClient(prisma, client);
    if (accessError) return res.status(accessError.status).json(accessError.body);

    if (prisma) {
      const voucher = await prisma.voucher.findUnique({ where: { code: normalized } });
      if (!voucher) {
        return res.status(404).json({ error: "errors.mobile.invalid_package", message: "Code forfait invalide" });
      }
      if (voucher.resellerId && voucher.resellerId !== fiche?.id) {
        return res.status(403).json({
          error: "errors.mobile.package_owner_mismatch",
          message: "Ce code n'a pas été émis par le revendeur de ce compte.",
        });
      }

      const applied = await appliquerVoucherAuClient(prisma, {
        voucherId: voucher.id,
        clientId: client.id,
        resellerId: fiche?.id,
        resellerUserId: fiche?.userId,
        actorUserId: req.user?.userId,
        actorEmail: req.user?.email,
      });
      const updatedClient = { ...client, ...applied.client };
      await logDbActivity(
        req.user!.userId,
        `Activated voucher ID: ${voucher.id} via mobile app`,
        "success",
        req.ip
      );
      return res.json({ message: "Forfait activé", accountState: computeAccountState(updatedClient) });
    }

    // In-memory fallback
    const voucher = inMemoryDb.vouchers?.find((v: any) => normalizeToken(v.code) === normalized);
    if (!voucher) {
      return res.status(404).json({ error: "errors.mobile.invalid_package", message: "Code forfait invalide" });
    }
    if (voucher.resellerId && voucher.resellerId !== fiche?.id) {
      return res.status(403).json({
        error: "errors.mobile.package_owner_mismatch",
        message: "Ce code n'a pas été émis par le revendeur de ce compte.",
      });
    }
    if (
      voucher.isRedeemed ||
      voucher.status === "used" ||
      voucher.status === "revoked" ||
      (voucher.expiresAt && new Date(voucher.expiresAt).getTime() <= Date.now())
    ) {
      return res.status(409).json({ error: "errors.mobile.package_used", message: "Ce forfait a déjà été utilisé" });
    }
    if (client.subscriptions?.length > 0) {
      return res.status(409).json({
        error: "errors.vouchers.subscription_required",
        message: "Ce client possède déjà un forfait. Utilisez un jeton data lié explicitement à ce forfait.",
      });
    }
    voucher.isRedeemed = true;
    voucher.status = "used";
    voucher.redeemedBy = client.id;
    voucher.redeemedClientId = client.id;
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
    if (err instanceof PlafondQuotaDepasse) {
      return res.status(409).json({ error: "errors.resellers.quota_exceeded", message: err.message });
    }
    if (err instanceof VoucherRedemptionError) {
      const mobileCode =
        err.code === "errors.vouchers.already_redeemed"
          ? "errors.mobile.package_used"
          : err.code === "errors.vouchers.expired"
            ? "errors.mobile.package_expired"
            : err.code === "errors.vouchers.revoked"
              ? "errors.mobile.package_revoked"
              : err.code;
      return res.status(err.status).json({ error: mobileCode, message: err.message });
    }
    if (err?.code === "P2034") {
      return res.status(409).json({
        error: "errors.mobile.package_state_changed",
        message: "Ce code vient d'être utilisé ou modifié. Veuillez réessayer.",
      });
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
    const client: any = await findClientByUserId(req.user!.userId, req.user!.clientId, deviceIdFromRequest(req));
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
      return res.status(404).json({ ...subscriptionAccessFailure("deleted", requestedSubscriptionId), error: 'errors.mobile.connection_not_found', message: 'Connexion VPN introuvable' });
    }

    const state = computeAccountState(client, sub);
    const selectedStatus = sub ? subscriptionAccessStatus(sub) : null;
    const subscriptionState = selectedStatus ?? state.state;
    if (selectedStatus && selectedStatus !== "active") {
      return res.status(selectedStatus === "deleted" ? 404 : 403).json(subscriptionAccessFailure(selectedStatus, sub.id));
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
    const client: any = await findClientByUserId(req.user!.userId, req.user!.clientId, deviceIdFromRequest(req));
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
    const client: any = await findClientByUserId(req.user!.userId, req.user!.clientId, deviceIdFromRequest(req));
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
          title: 'Nouvelle version Stuff x Bilal x Global Users disponible',
          message: `${version.versionName} est disponible. Téléchargez-la depuis cette notification.`,
          createdAt: version.publishedAt,
          read: false,
          appUpdate: true,
          actionType: 'download_app_update',
          downloadUrl: version.apkUrl,
          // Champ additif : les APK antérieurs l'ignorent, les nouveaux s'en
          // servent pour vérifier l'intégrité avant installation.
          downloadSha256: version.apkSha256,
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
    const client: any = await findClientByUserId(req.user!.userId, req.user!.clientId, deviceIdFromRequest(req));
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

    const client: any = await findClientByUserId(req.user!.userId, req.user!.clientId, deviceIdFromRequest(req));
    if (!client) return res.status(404).json({ error: "errors.mobile.no_account" });

    if (totalBytes > 0n) {
      const applied = await applyUsageDelta(client.id, subscriptionId || null, totalBytes, sessionId, seq, BigInt(bytesUp), deviceId || null);
      if (!applied.applied && applied.reason === "subscription_not_owned") {
        return res.status(403).json({
          error: "errors.auth.forbidden",
          code: "OWNERSHIP_FORBIDDEN",
          message: "Ce forfait n'appartient pas à cet appareil.",
        });
      }
    }

    const updatedClient: any = await findClientByUserId(req.user!.userId, req.user!.clientId, deviceIdFromRequest(req));
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
    const client: any = await findClientByUserId(req.user!.userId, req.user!.clientId, deviceIdFromRequest(req));
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

    // « Période d'essai » : marqueur STRUCTUREL, lu une seule fois pour toute la
    // liste et borné à ce compte. Jamais le nom du forfait — c'est précisément
    // le défaut corrigé côté tableau de bord.
    const forfaitsEssai = await forfaitsEssaiDuClient(prisma, String(client.id));

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
      const status = subscriptionAccessStatus(sub, now);

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
        /** Cet accès provient-il d'un essai gratuit déployé ? (marqueur structurel) */
        isFreeTrial:   forfaitsEssai.has(String(sub.id)),
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

    const client: any = await findClientByUserId(
      req.user!.userId,
      req.user!.clientId,
      deviceIdFromRequest(req)
    );
    if (!client) return res.status(404).json({ error: "errors.mobile.no_account" });

    const sub = prisma
      ? await prisma.subscription.findFirst({ where: { id, clientId: client.id } })
      : inMemoryDb.subscriptions?.find((value: any) => value.id === id && value.clientId === client.id);
    if (!sub) return res.status(404).json(subscriptionAccessFailure("deleted", id));
    const effective = subscriptionAccessStatus(sub);
    if (effective === "revoked" || effective === "suspended" || effective === "deleted") {
      return res.status(403).json(subscriptionAccessFailure(effective, id));
    }
    if (effective !== disabledReason) {
      return res.status(409).json({ error: "errors.mobile.config_state_changed", message: "Le serveur ne confirme pas cet etat." });
    }
    if (prisma && sub.status === "active") {
      const updated = await (prisma as any).subscription.updateMany({
        where: {
          id, clientId: client.id, status: "active",
          ...(disabledReason === "expired"
            ? { expireAt: { lte: new Date() } }
            : { quotaBytes: sub.quotaBytes, quotaUsed: { gte: sub.quotaBytes } }),
        },
        data: { status: disabledReason },
      });
      if (updated.count !== 1) {
        return res.status(409).json({ error: "errors.mobile.config_state_changed", message: "Ce forfait vient de changer." });
      }
    } else if (!prisma) {
      sub.status = disabledReason;
    }

    return res.json({ success: true, id, status: disabledReason });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: "errors.validation" });
    console.error("Mobile configuration state update failed:", err);
    return res.status(503).json({ error: "errors.server", message: "Etat de configuration temporairement indisponible." });
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

    const client: any = await findClientByUserId(req.user!.userId, req.user!.clientId, deviceIdFromRequest(req));

    if (!client) {
      return res.status(404).json({ error: "errors.mobile.no_account", message: "Client non trouvé" });
    }

    if (totalBytes > 0n) {
      const applied = await applyUsageDelta(client.id, subscriptionId || null, totalBytes, sessionId, seq, BigInt(upload), deviceId || null);
      if (!applied.applied && applied.reason === "subscription_not_owned") {
        return res.status(403).json({
          error: "errors.auth.forbidden",
          code: "OWNERSHIP_FORBIDDEN",
          message: "Ce forfait n'appartient pas à cet appareil.",
        });
      }
    }

    const updatedClient: any = await findClientByUserId(req.user!.userId, req.user!.clientId, deviceIdFromRequest(req));
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
    const client: any = await findClientByUserId(req.user!.userId, req.user!.clientId, deviceIdFromRequest(req));
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

import crypto from "crypto";
import { prisma } from "../database";
import type { Announcement } from "../routes/announcements";
import type { PublishedAppUpdate } from "./app-update";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const ACCESS_TOKEN_EARLY_REFRESH_MS = 60_000;
const FCM_CONCURRENCY = 100;

type FirebaseServiceAccount = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
};

type FcmError = Error & { code?: string; status?: number };

export type PushDeliveryResult = {
  status: "sent" | "partial" | "failed" | "disabled" | "skipped";
  attempted: number;
  sent: number;
  failed: number;
  removedInvalidTokens: number;
  error?: string;
};

type PushPayload = {
  type: "announcement" | "app_update";
  notificationId: string;
  title: string;
  body: string;
  level: string;
  screen: "notifications";
  versionCode?: string;
  forceUpdate?: string;
};

let cachedAccessToken: { value: string; expiresAt: number } | null = null;

function configurationError(code: string, message: string): FcmError {
  const error = new Error(message) as FcmError;
  error.code = code;
  return error;
}

function normalizePrivateKey(value: string): string {
  return value.replace(/\\n/g, "\n").trim();
}

function parseServiceAccountJson(raw: string): FirebaseServiceAccount {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw configurationError("FCM_CONFIG_INVALID", "FIREBASE_SERVICE_ACCOUNT_JSON n'est pas un JSON valide");
  }

  const projectId = String(parsed.project_id || "").trim();
  const clientEmail = String(parsed.client_email || "").trim();
  const privateKey = normalizePrivateKey(String(parsed.private_key || ""));
  const tokenUri = String(parsed.token_uri || DEFAULT_TOKEN_URI).trim();
  if (!projectId || !clientEmail || !privateKey) {
    throw configurationError(
      "FCM_CONFIG_INCOMPLETE",
      "Le compte de service Firebase doit contenir project_id, client_email et private_key",
    );
  }
  return { projectId, clientEmail, privateKey, tokenUri };
}

function readFirebaseConfiguration(): FirebaseServiceAccount | null {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (json) return parseServiceAccountJson(json);

  const projectId = process.env.FIREBASE_PROJECT_ID?.trim() || "";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim() || "";
  const privateKey = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY || "");
  const tokenUri = process.env.FIREBASE_TOKEN_URI?.trim() || DEFAULT_TOKEN_URI;
  const supplied = [projectId, clientEmail, privateKey].filter(Boolean).length;
  if (supplied === 0) return null;
  if (supplied !== 3) {
    throw configurationError(
      "FCM_CONFIG_INCOMPLETE",
      "FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL et FIREBASE_PRIVATE_KEY doivent être fournis ensemble",
    );
  }
  return { projectId, clientEmail, privateKey, tokenUri };
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

async function getAccessToken(config: FirebaseServiceAccount): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt - ACCESS_TOKEN_EARLY_REFRESH_MS > Date.now()) {
    return cachedAccessToken.value;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: config.clientEmail,
    scope: FCM_SCOPE,
    aud: config.tokenUri,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  let signature: string;
  try {
    signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), config.privateKey).toString("base64url");
  } catch {
    throw configurationError("FCM_PRIVATE_KEY_INVALID", "La clé privée du compte de service Firebase est invalide");
  }

  const response = await fetch(config.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  if (!response.ok) {
    const error = configurationError("FCM_AUTH_FAILED", `OAuth Firebase a répondu HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const body = await response.json() as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw configurationError("FCM_AUTH_INVALID_RESPONSE", "OAuth Firebase n'a pas renvoyé de jeton d'accès");
  }
  const expiresIn = Number(body.expires_in);
  cachedAccessToken = {
    value: body.access_token,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
  };
  return body.access_token;
}

function fcmErrorCode(body: unknown): string {
  if (!body || typeof body !== "object") return "FCM_SEND_FAILED";
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return "FCM_SEND_FAILED";
  const details = (error as { details?: unknown }).details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (detail && typeof detail === "object" && typeof (detail as { errorCode?: unknown }).errorCode === "string") {
        return (detail as { errorCode: string }).errorCode;
      }
    }
  }
  return typeof (error as { status?: unknown }).status === "string"
    ? (error as { status: string }).status
    : "FCM_SEND_FAILED";
}

async function sendToToken(
  config: FirebaseServiceAccount,
  accessToken: string,
  token: string,
  data: PushPayload,
): Promise<void> {
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/messages:send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token,
          data,
          android: { priority: "high" },
        },
      }),
    },
  );
  if (response.ok) return;

  let responseBody: unknown = null;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }
  const error = configurationError(fcmErrorCode(responseBody), `FCM a répondu HTTP ${response.status}`);
  error.status = response.status;
  throw error;
}

async function deliver(
  data: PushPayload,
  targetDeviceIds: string[],
): Promise<PushDeliveryResult> {
  let config: FirebaseServiceAccount | null;
  try {
    config = readFirebaseConfiguration();
  } catch (error) {
    const code = (error as FcmError).code || "FCM_CONFIG_INVALID";
    return { status: "failed", attempted: 0, sent: 0, failed: 0, removedInvalidTokens: 0, error: code };
  }
  if (!config) {
    return {
      status: "disabled",
      attempted: 0,
      sent: 0,
      failed: 0,
      removedInvalidTokens: 0,
      error: "FCM_NOT_CONFIGURED",
    };
  }
  const firebaseConfig = config;
  if (!prisma) {
    return { status: "failed", attempted: 0, sent: 0, failed: 0, removedInvalidTokens: 0, error: "DB_UNAVAILABLE" };
  }

  const uniqueDeviceIds = [...new Set(targetDeviceIds.map((value) => value.trim()).filter(Boolean))];
  let tokens: Array<{ id: string; token: string; userId: string; deviceId: string }>;
  try {
    tokens = await (prisma as any).pushToken.findMany({
      where: {
        active: true,
        user: { status: "active" },
        ...(uniqueDeviceIds.length > 0 ? { deviceId: { in: uniqueDeviceIds } } : {}),
      },
      select: { id: true, token: true, userId: true, deviceId: true },
    }) as Array<{ id: string; token: string; userId: string; deviceId: string }>;

    // Un même utilisateur (notamment un revendeur) possède plusieurs clients.
    // L'éligibilité doit porter sur LA paire du jeton, pas sur « au moins un
    // client actif » du même utilisateur, sinon un appareil révoqué continue à
    // recevoir les annonces tant qu'un autre appareil reste actif.
    if (tokens.length > 0) {
      const activeClients = await (prisma as any).vpnClient.findMany({
        where: {
          status: "active",
          OR: tokens.map((entry) => ({ userId: entry.userId, deviceId: entry.deviceId })),
        },
        select: { userId: true, deviceId: true },
      }) as Array<{ userId: string; deviceId: string | null }>;
      const activePairs = new Set(activeClients.map((client) => `${client.userId}\0${client.deviceId || ""}`));
      tokens = tokens.filter((entry) => activePairs.has(`${entry.userId}\0${entry.deviceId}`));
    }
  } catch {
    return {
      status: "failed",
      attempted: 0,
      sent: 0,
      failed: 0,
      removedInvalidTokens: 0,
      error: "PUSH_TOKEN_QUERY_FAILED",
    };
  }
  if (tokens.length === 0) {
    return { status: "skipped", attempted: 0, sent: 0, failed: 0, removedInvalidTokens: 0, error: "NO_ELIGIBLE_TOKENS" };
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(firebaseConfig);
  } catch (error) {
    const code = (error as FcmError).code || "FCM_AUTH_FAILED";
    return {
      status: "failed",
      attempted: tokens.length,
      sent: 0,
      failed: tokens.length,
      removedInvalidTokens: 0,
      error: code,
    };
  }

  const outcomes: Array<{ sent: boolean; id: string; error: string }> = [];
  for (let index = 0; index < tokens.length; index += FCM_CONCURRENCY) {
    const batch = tokens.slice(index, index + FCM_CONCURRENCY);
    outcomes.push(...await Promise.all(batch.map(async (entry) => {
      try {
        await sendToToken(firebaseConfig, accessToken, entry.token, data);
        return { sent: true, id: entry.id, error: "" };
      } catch (error) {
        return { sent: false, id: entry.id, error: (error as FcmError).code || "FCM_SEND_FAILED" };
      }
    })));
  }
  const sent = outcomes.filter((outcome) => outcome.sent).length;
  const invalidIds = outcomes
    .filter((outcome) => outcome.error === "UNREGISTERED" || outcome.error === "SENDER_ID_MISMATCH")
    .map((outcome) => outcome.id);
  let cleanupError = "";
  if (invalidIds.length > 0) {
    try {
      await (prisma as any).pushToken.deleteMany({ where: { id: { in: invalidIds } } });
    } catch {
      cleanupError = "TOKEN_CLEANUP_FAILED";
    }
  }

  const failed = outcomes.length - sent;
  return {
    status: failed === 0 && !cleanupError ? "sent" : sent > 0 ? "partial" : "failed",
    attempted: outcomes.length,
    sent,
    failed,
    removedInvalidTokens: cleanupError ? 0 : invalidIds.length,
    ...(cleanupError ? { error: cleanupError } : failed > 0 ? { error: "FCM_DELIVERY_FAILED" } : {}),
  };
}

function announcementIsCurrent(announcement: Announcement): boolean {
  const now = Date.now();
  return announcement.active
    && new Date(announcement.startsAt).getTime() <= now
    && (!announcement.expiresAt || new Date(announcement.expiresAt).getTime() > now);
}

export async function sendAnnouncementPush(announcement: Announcement): Promise<PushDeliveryResult> {
  if (!announcementIsCurrent(announcement)) {
    return { status: "skipped", attempted: 0, sent: 0, failed: 0, removedInvalidTokens: 0, error: "ANNOUNCEMENT_NOT_CURRENT" };
  }
  return deliver({
    type: "announcement",
    notificationId: `announcement-${announcement.id}`,
    title: announcement.title,
    body: announcement.message,
    level: announcement.level,
    screen: "notifications",
  }, announcement.targetDeviceId ? [announcement.targetDeviceId] : []);
}

export async function sendAppUpdatePush(update: PublishedAppUpdate): Promise<PushDeliveryResult> {
  if (!update.active) {
    return { status: "skipped", attempted: 0, sent: 0, failed: 0, removedInvalidTokens: 0, error: "APP_UPDATE_INACTIVE" };
  }
  return deliver({
    type: "app_update",
    notificationId: `app-update-${update.id}`,
    title: `Mise à jour Stuff x Bilal x Global Users ${update.versionName}`,
    body: update.notes || "Une nouvelle version de Stuff x Bilal x Global Users est disponible.",
    level: update.forceUpdate ? "warning" : "info",
    screen: "notifications",
    versionCode: String(update.versionCode),
    forceUpdate: String(update.forceUpdate),
  }, update.targetDeviceIds);
}

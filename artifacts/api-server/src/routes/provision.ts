/**
 * provision.ts — Route de provisionnement sécurisé (serveur dev Replit)
 *
 * Miroir simplifié de server/routes/provision.ts (VPS).
 * Utilisé uniquement pour le développement local — en production,
 * toutes les requêtes vont vers https://vpnsxb.afrihall.com/api/provision
 *
 * SÉCURITÉ identique au VPS :
 *   - AES-256-GCM (chiffrement authentifié)
 *   - Clé par appareil : HMAC-SHA256(deviceId:token, PROVISION_SECRET)
 *   - Signature serveur : HMAC-SHA256(subId:deviceId:expiresAt, PROVISION_SECRET)
 *   - Les credentials ne sont JAMAIS exposés en clair au mobile
 */
import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

// ── Config dev (simule le profil VPN du VPS) ─────────────────────────────────
const DEV_PROFILE = {
  id:              "profile-001",
  name:            "MTN SSH — Cameroun (dev)",
  protocol:        "ssh",
  displayProtocol: "MTN Protocol",
  host:            "vpnsxb.afrihall.com",
  port:            443,
  username:        "sxbuser",
  password:        "dev-password-not-real",
  sni:             "yamo.mtn.cm",
  network:         "tcp",
  tls:             false,
  uuid:            null,
  path:            null,
  payload:         "GET / HTTP/1.1[crlf]Host: [host][crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf][crlf]",
};

// ── Helpers cryptographiques ──────────────────────────────────────────────────

function getMasterSecret(): string {
  const s = process.env.PROVISION_SECRET || process.env.ENCRYPTION_KEY;
  if (!s || s.startsWith("CHANGE_ME")) {
    // En dev uniquement : fallback non-silencieux (loggé)
    console.warn("[DEV] PROVISION_SECRET non configurée — utilisation clé de dev");
    return "sxb-dev-provision-secret-32bytes!";
  }
  return s;
}

function encryptForDevice(
  plaintext: string,
  deviceId: string,
  accountToken: string,
): { encryptedBlob: string; configKey: string } {
  const masterSecret = getMasterSecret();
  const configKey = crypto
    .createHmac("sha256", masterSecret)
    .update(`${deviceId}:${accountToken}`)
    .digest("hex");

  const key = Buffer.from(configKey, "hex").slice(0, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv) as crypto.CipherGCM;
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const encryptedBlob = `gcm:${iv.toString("hex")}:${encrypted.toString("hex")}:${tag.toString("hex")}`;
  return { encryptedBlob, configKey };
}

function signResponse(subscriptionId: string, deviceId: string, expiresAt: string): string {
  const masterSecret = getMasterSecret();
  return crypto
    .createHmac("sha256", masterSecret)
    .update(`${subscriptionId}:${deviceId}:${expiresAt}`)
    .digest("hex");
}

// ── POST /api/provision/activate ──────────────────────────────────────────────
const activateSchema = z.object({
  dataToken: z.string().min(5),
  deviceId:  z.string().min(5),
});

router.post("/activate", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { dataToken, deviceId } = activateSchema.parse(req.body);

    // Validation basique du token (dev)
    const normalized = dataToken.trim().toUpperCase();
    if (!normalized.startsWith("SXB")) {
      return res.status(404).json({ error: "Token invalide ou introuvable" });
    }

    // Config brute — jamais envoyée en clair au mobile
    const rawConfig: Record<string, any> = {
      protocol:        DEV_PROFILE.protocol,
      displayProtocol: DEV_PROFILE.displayProtocol,
      host:            DEV_PROFILE.host,
      port:            DEV_PROFILE.port,
      username:        DEV_PROFILE.username,
      password:        DEV_PROFILE.password,
      uuid:            DEV_PROFILE.uuid,
      tls:             DEV_PROFILE.tls,
      sni:             DEV_PROFILE.sni,
      network:         DEV_PROFILE.network,
      path:            DEV_PROFILE.path,
      payload:         DEV_PROFILE.payload,
      profileId:       DEV_PROFILE.id,
      profileName:     DEV_PROFILE.name,
    };

    const offlineDays     = 7;
    const configExpiresAt = new Date(Date.now() + offlineDays * 86_400_000).toISOString();
    const subscriptionId  = `sub-dev-${normalized.slice(-6)}`;

    // Chiffrement AES-256-GCM lié à l'appareil
    const { encryptedBlob, configKey } = encryptForDevice(
      JSON.stringify(rawConfig),
      deviceId,
      normalized,
    );

    const serverSignature = signResponse(subscriptionId, deviceId, configExpiresAt);

    return res.json({
      success: true,
      config: {
        subscriptionId,
        profileId:       DEV_PROFILE.id,
        profileName:     DEV_PROFILE.name,
        protocol:        DEV_PROFILE.protocol,
        displayProtocol: DEV_PROFILE.displayProtocol,

        encryptedBlob,
        configKey,
        encVersion:       "gcm-v2",
        serverSignature,
        configExpiresAt,
        offlineValidDays: offlineDays,

        quotaGB:         50,
        quotaUsedGB:     12,
        expireAt:        new Date(Date.now() + 30 * 86_400_000).toISOString(),
        deviceLimit:     1,
        provisionedAt:   new Date().toISOString(),
        lastSyncAt:      null,
      },
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "dataToken et deviceId sont requis" });
    }
    console.error("[provision/activate dev]", err.message || err);
    return res.status(500).json({ error: "Échec du provisionnement" });
  }
});

// ── POST /api/provision/sync ──────────────────────────────────────────────────
router.post("/sync", requireAuth, async (req: AuthenticatedRequest, res) => {
  // Dev : retourne simplement un statut actif
  return res.json({
    success:      true,
    status:       "active",
    expireAt:     new Date(Date.now() + 30 * 86_400_000).toISOString(),
    quotaGB:      50,
    quotaUsedGB:  12,
    revoked:      false,
  });
});

// ── GET /api/provision/status/:subscriptionId ─────────────────────────────────
router.get("/status/:subscriptionId", requireAuth, async (req: AuthenticatedRequest, res) => {
  return res.json({
    success:      true,
    status:       "active",
    expireAt:     new Date(Date.now() + 30 * 86_400_000).toISOString(),
    quotaGB:      50,
    quotaUsedGB:  12,
    revoked:      false,
  });
});

export default router;

/**
 * provision.ts — Routes de provisionnement VPN SXB
 *
 * Surface mobile uniquement. Valide les tokens SXB-DATA, retourne des
 * configurations chiffrées liées à l'appareil. L'utilisateur ne voit jamais
 * les credentials bruts (IP, port, username, password, UUID technique).
 *
 * SÉCURITÉ :
 *   - AES-256-GCM (chiffrement authentifié — Phase 2)
 *   - Clé dérivée par appareil : HMAC-SHA256(deviceId:token, PROVISION_SECRET)
 *   - Signature serveur sur chaque réponse : HMAC-SHA256(subscriptionId:deviceId:expiresAt)
 *   - Expiration de configuration configurable (offlineValidDays)
 *   - Révocation distante via status=revoked
 */
import { Router, Response } from 'express';
import { prisma }           from '../database';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth';
import { logDbActivity }    from '../database';
import crypto               from 'crypto';
import {
  decryptCanonical, computeCanonicalHash, engineConfigFromCanonical,
} from '../services/canonical-config';
import {
  configHashForProfile, configVersionForProfile,
} from '../services/config-hash';

const router = Router();

// ── Helpers sécurité ──────────────────────────────────────────────────────────

/**
 * Clé maître du provisionnement — obligatoire en production.
 * Ne jamais utiliser de fallback silencieux : si la clé manque, on rejette la requête.
 */
function getMasterSecret(): string {
  const s = process.env.PROVISION_SECRET || process.env.ENCRYPTION_KEY;
  if (!s || s.startsWith('CHANGE_ME') || s === 'sxb-provision-secret') {
    throw new Error('[SECURITY] PROVISION_SECRET non configurée — provisionnement bloqué');
  }
  return s;
}

/**
 * Chiffrement AES-256-GCM lié à l'appareil.
 * La clé est dérivée de deviceId + token via HMAC-SHA256(secret).
 * Résultat : "gcm:<iv_hex>:<ciphertext_hex>:<authtag_hex>"
 */
function encryptForDevice(
  plaintext:    string,
  deviceId:     string,
  accountToken: string,
): { encryptedBlob: string; configKey: string } {
  const masterSecret = getMasterSecret();

  // Clé par appareil (non-portable) : HMAC-SHA256(deviceId:token, masterSecret)
  const configKey = crypto
    .createHmac('sha256', masterSecret)
    .update(`${deviceId}:${accountToken}`)
    .digest('hex');

  const key = Buffer.from(configKey, 'hex').slice(0, 32); // 256 bits
  const iv  = crypto.randomBytes(12);                      // 96 bits — NIST GCM

  const cipher    = crypto.createCipheriv('aes-256-gcm', key, iv) as crypto.CipherGCM;
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag       = cipher.getAuthTag(); // 128 bits

  const encryptedBlob = `gcm:${iv.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`;
  return { encryptedBlob, configKey };
}

/**
 * Signature serveur — permet au mobile de vérifier l'intégrité de la réponse.
 * Format : HMAC-SHA256(subscriptionId:deviceId:expiresAt, PROVISION_SECRET)
 */
function signResponse(subscriptionId: string, deviceId: string, expiresAt: string): string {
  const masterSecret = getMasterSecret();
  return crypto
    .createHmac('sha256', masterSecret)
    .update(`${subscriptionId}:${deviceId}:${expiresAt}`)
    .digest('hex');
}

function normalizeToken(t: string): string {
  return t.trim().toUpperCase();
}

// ── Déchiffrement interne (lecture des passwords stockés en DB) ───────────────

const DB_ENC_KEY = (() => {
  const k = process.env.ENCRYPTION_KEY;
  if (!k) console.error('[SECURITY] ENCRYPTION_KEY non définie');
  return k || '';
})();

function decryptDbField(enc: string | null | undefined): string | null {
  if (!enc) return null;
  try {
    if (enc.startsWith('gcm:')) {
      // Format GCM v2
      const parts = enc.slice(4).split(':');
      if (parts.length !== 3) return null;
      const key     = crypto.createHash('sha256').update(DB_ENC_KEY).digest();
      const iv      = Buffer.from(parts[0], 'hex');
      const tag     = Buffer.from(parts[2], 'hex');
      const d       = crypto.createDecipheriv('aes-256-gcm', key, iv) as crypto.DecipherGCM;
      d.setAuthTag(tag);
      return Buffer.concat([d.update(Buffer.from(parts[1], 'hex')), d.final()]).toString();
    }
    // Format CBC v1 (legacy)
    if (!enc.includes(':')) return enc; // non chiffré
    const [ivHex, encHex] = enc.split(':');
    const key = crypto.createHash('sha256').update(DB_ENC_KEY).digest();
    const d   = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
    return Buffer.concat([d.update(Buffer.from(encHex, 'hex')), d.final()]).toString();
  } catch {
    return null;
  }
}

// ─── POST /api/provision/activate ─────────────────────────────────────────────
// Étape 2 de l'activation mobile :
//   dataToken → validation → config chiffrée + signature serveur
router.post('/activate', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { dataToken, deviceId } = req.body;
    if (!dataToken || !deviceId) {
      return res.status(400).json({ error: 'dataToken et deviceId sont requis' });
    }

    const normalToken = normalizeToken(dataToken);

    // 1. Trouver l'abonnement par dataToken
    const sub = await (prisma as any).subscription.findFirst({
      where: { dataToken: normalToken },
      include: {
        profile: true,
        client:  { include: { user: true } },
      },
    });

    if (!sub) {
      return res.status(404).json({ error: 'Token invalide ou introuvable' });
    }

    // 2. Charger le payload SSH séparément (relation non mappée dans le client Prisma généré)
    let profilePayload: any = null;
    if (sub?.profile?.payloadId) {
      profilePayload = await (prisma as any).sshPayload
        .findUnique({ where: { id: sub.profile.payloadId } })
        .catch(() => null);
    }
    if (sub?.profile) sub.profile.payload = profilePayload;

    // 3. Validation de l'abonnement
    if (sub.status === 'revoked') {
      return res.status(403).json({ error: 'Cet abonnement a été révoqué' });
    }
    if (sub.status === 'exhausted') {
      return res.status(403).json({ error: 'Quota de cet abonnement épuisé', status: 'exhausted' });
    }
    if (sub.status === 'expired' || (sub.expireAt && new Date(sub.expireAt) < new Date())) {
      await (prisma as any).subscription.update({
        where: { id: sub.id },
        data:  { status: 'expired' },
      });
      return res.status(403).json({ error: 'Abonnement expiré', status: 'expired' });
    }
    if (sub.status === 'suspended') {
      return res.status(403).json({ error: 'Abonnement suspendu' });
    }
    if (sub.client?.status === 'suspended' || sub.client?.status === 'revoked' || sub.client?.status === 'disabled') {
      return res.status(403).json({ error: 'Compte client suspendu ou révoqué' });
    }

    // 4. Vérification de la limite d'appareils (schéma : deviceId unique sur Subscription)
    const registeredDeviceId = sub.deviceId as string | null;
    const isExistingDevice   = registeredDeviceId === deviceId;

    // deviceLimit > 1 non supporté par ce schéma (un seul deviceId par abonnement)
    if (!isExistingDevice && registeredDeviceId) {
      return res.status(403).json({
        error: 'Cet abonnement est déjà lié à un autre appareil',
        deviceLimit: 1,
        registeredDevices: 1,
      });
    }

    // 5. Enregistrer l'appareil si nouveau
    if (!isExistingDevice) {
      await (prisma as any).subscription.update({
        where: { id: sub.id },
        data:  { deviceId },
      });
    }

    // 6. Construire la config brute moteur.
    //    ─ Priorité au CANONIQUE importé (Phase 3 — modèle « intermédiaire ») :
    //      la configuration du fournisseur externe est restituée TECHNIQUEMENT
    //      IDENTIQUE à l'import, sans reconstruction depuis les colonnes legacy.
    //    ─ Sinon : chemin LEGACY (profils créés manuellement) — INCHANGÉ.
    const profile = sub.profile;
    const proto   = (profile?.protocol || 'ssh').toLowerCase();

    let rawConfig: Record<string, any>;

    if (profile?.canonicalConfig) {
      // ── Chemin CANONIQUE (import fournisseur, chiffré en DB) ──────────────
      const plain = decryptCanonical(profile.canonicalConfig);
      if (!plain) {
        console.error(`[provision/activate] Déchiffrement canonique impossible — profil ${profile.id}`);
        return res.status(500).json({
          error: 'Configuration importée illisible — réimportez le profil ou contactez un administrateur',
        });
      }
      let canonical: Record<string, any>;
      try {
        canonical = JSON.parse(plain);
      } catch {
        console.error(`[provision/activate] Canonique non-JSON — profil ${profile.id}`);
        return res.status(500).json({
          error: 'Configuration importée corrompue — réimportez le profil ou contactez un administrateur',
        });
      }
      // Preuve de NON-ALTÉRATION : le hash déterministe stocké à l'import doit
      // correspondre exactement au contenu déchiffré (§6.3).
      if (profile.canonicalConfigHash &&
          computeCanonicalHash(canonical) !== profile.canonicalConfigHash) {
        console.error(`[provision/activate] Hash canonique mismatch — profil ${profile.id}`);
        return res.status(500).json({
          error: 'Configuration importée altérée — réimportez le profil ou contactez un administrateur',
        });
      }
      const engine = engineConfigFromCanonical(canonical);
      // ALLOWLIST métadonnées (§6.1) : les SEULS champs que le serveur ajoute
      // à la configuration fournisseur. Aucun champ technique n'est modifié.
      rawConfig = {
        ...engine,
        displayProtocol: profile.displayProtocol || (engine as any).protocol || proto,
        profileId:       profile.id,
        profileName:     profile.name,
      };
    } else {
      // ── Chemin LEGACY (reconstruction colonnes — comportement historique) ──
      const password = decryptDbField(profile?.password);
      const uuid     = decryptDbField(profile?.uuid);

      // Payload SSH (fallback WebSocket si non configuré)
      let payloadContent: string | null = null;
      if (profilePayload?.content) {
        payloadContent = profilePayload.content;
      } else if (proto === 'ssh+payload') {
        payloadContent = 'GET / HTTP/1.1[crlf]Host: [host][crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf][crlf]';
      }

      // Config brute (jamais envoyée en clair au mobile)
      rawConfig = {
        protocol:        proto,
        displayProtocol: profile?.displayProtocol || proto,
        host:            profile?.host,
        port:            profile?.port,
        username:        profile?.username,
        password:        password,
        uuid:            uuid,
        tls:             profile?.tls    || false,
        sni:             profile?.sni    || null,
        network:         profile?.network || 'tcp',
        dns:             profile?.dns    || null,
        payload:         payloadContent,
        payloadId:       profile?.payloadId || null,
        // Champs sing-box
        path:            profile?.path   || null,
        headerType:      profile?.headerType || null,
        grpcServiceName: profile?.grpcServiceName || null,
        flow:            profile?.flow   || null,
        fingerprint:     profile?.fingerprint || null,
        publicKey:       profile?.publicKey || null,
        shortId:         profile?.shortId || null,
        spiderX:         profile?.spiderX || null,
        // Metadata
        profileId:       profile?.id,
        profileName:     profile?.name,
      };
    }

    // 7. Calcul de l'expiration de la configuration locale
    const offlineDays    = profile?.offlineValidDays || 7;
    const configExpiresAt = new Date(Date.now() + offlineDays * 86_400_000).toISOString();
    const provisionedAt   = new Date().toISOString();

    // 8. Chiffrement AES-256-GCM lié à l'appareil
    const token = sub.dataToken;
    // C3 — Liaison vérifiable côté client : ces deux champs voyagent DANS le blob
    // authentifié par AES-GCM, ils sont donc inforgeables sans la clé par-appareil.
    // Le mobile peut ainsi rejeter une réponse rejouée vers un autre appareil ou
    // un autre abonnement (la `signature` HMAC de la réponse, elle, repose sur
    // PROVISION_SECRET que le client ne possède pas et reste invérifiable).
    // Champs de métadonnées additifs : les clients antérieurs les ignorent.
    (rawConfig as any).deviceId = deviceId;
    (rawConfig as any).subscriptionId = sub.id;
    const { encryptedBlob, configKey } = encryptForDevice(
      JSON.stringify(rawConfig),
      deviceId,
      token,
    );

    // 9. Signature serveur (intégrité de la réponse)
    const serverSignature = signResponse(sub.id, deviceId, configExpiresAt);

    // 10. Métriques quota
    const quotaGB     = Number(sub.quotaBytes) / (1024 ** 3);
    const quotaUsedGB = Number(sub.quotaUsed)  / (1024 ** 3);

    // 11. Marquer la dernière provision
    await (prisma as any).subscription.update({
      where: { id: sub.id },
      data:  { lastProvisionAt: new Date() },
    });

    await logDbActivity(
      req.user!.userId,
      `Config provisionnée — abonnement ${sub.name} → appareil ${deviceId}`,
      'info',
      req.ip || '',
    );

    const responseConfig = {
      subscriptionId:  sub.id,
      profileId:       profile?.id,
      profileName:     profile?.name,
      protocol:        proto,
      displayProtocol: profile?.displayProtocol || proto,
      encryptedBlob,
      configKey,       // Clé par-appareil : HMAC(deviceId:token, PROVISION_SECRET)
      encVersion:      'gcm-v2',
      signature:       serverSignature,
      configExpiresAt,
      provisionedAt,
      quotaGB:         parseFloat(quotaGB.toFixed(4)),
      quotaUsedGB:     parseFloat(quotaUsedGB.toFixed(4)),
      expireAt:        sub.expireAt,
      deviceId,
      // §6.4 — invalidation de cache côté mobile (métadonnées only)
      configVersion:   configVersionForProfile(profile),
      configHash:      configHashForProfile(profile),
    };

    return res.json({
      success: true,
      // Format attendu par le mobile actuel
      config: responseConfig,
      // Champs plats conservés pour compatibilite descendante
      ...responseConfig,
      expiresAt: configExpiresAt,
    });
  } catch (err: any) {
    if (err.message?.includes('PROVISION_SECRET')) {
      return res.status(503).json({ error: 'Service de provisionnement indisponible' });
    }
    console.error('[provision/activate]', err.message || err);
    return res.status(500).json({ error: 'Échec du provisionnement' });
  }
});

// ─── POST /api/provision/sync ─────────────────────────────────────────────────
// Synchronisation quota + réception des mises à jour backend (expiration, révocation)
router.post('/sync', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { subscriptionId, downloadBytes, uploadBytes, deviceId } = req.body;
    if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId requis' });

    const sub = await (prisma as any).subscription.findUnique({
      where: { id: subscriptionId },
    });
    if (!sub) return res.status(404).json({ error: 'Abonnement introuvable' });

    const addedBytes   = BigInt(downloadBytes || 0) + BigInt(uploadBytes || 0);
    const newQuotaUsed = sub.quotaUsed + addedBytes;

    const isExpired   = sub.expireAt && new Date(sub.expireAt) < new Date();
    const isOverQuota = newQuotaUsed >= sub.quotaBytes;

    let newStatus = sub.status;
    if (sub.status === 'active' && (isExpired || isOverQuota)) {
      newStatus = 'expired';
    }

    const updated = await (prisma as any).subscription.update({
      where: { id: subscriptionId },
      data:  { quotaUsed: newQuotaUsed, status: newStatus, lastSyncAt: new Date() },
    });

    // subscriptionDevice est optionnel (table non créée dans ce schéma)
    if (deviceId && (prisma as any).subscriptionDevice) {
      await (prisma as any).subscriptionDevice.updateMany({
        where: { subscriptionId, deviceId },
        data:  { lastSeenAt: new Date() },
      }).catch(() => null);
    }

    await (prisma as any).trafficUsage.create({
      data: {
        accountId:   subscriptionId,
        accountType: 'subscription',
        download:    BigInt(downloadBytes || 0),
        upload:      BigInt(uploadBytes   || 0),
      },
    });

    const quotaGB     = Number(updated.quotaBytes) / (1024 ** 3);
    const quotaUsedGB = Number(updated.quotaUsed)  / (1024 ** 3);

    return res.json({
      success:      true,
      status:       updated.status,
      expireAt:     updated.expireAt,
      quotaGB:      parseFloat(quotaGB.toFixed(4)),
      quotaUsedGB:  parseFloat(quotaUsedGB.toFixed(4)),
      revoked:      updated.status === 'revoked',
    });
  } catch (err: any) {
    console.error('[provision/sync]', err.message || err);
    return res.status(500).json({ error: 'Échec de la synchronisation' });
  }
});

// ─── GET /api/provision/status/:subscriptionId ───────────────────────────────
// Vérification de statut en ligne (expiration, révocation)
router.get('/status/:subscriptionId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const sub = await (prisma as any).subscription.findUnique({
      where: { id: req.params.subscriptionId },
    });
    if (!sub) return res.status(404).json({ error: 'Abonnement introuvable' });

    const quotaGB     = Number(sub.quotaBytes) / (1024 ** 3);
    const quotaUsedGB = Number(sub.quotaUsed)  / (1024 ** 3);

    return res.json({
      success:      true,
      status:       sub.status,
      expireAt:     sub.expireAt,
      quotaGB:      parseFloat(quotaGB.toFixed(4)),
      quotaUsedGB:  parseFloat(quotaUsedGB.toFixed(4)),
      revoked:      sub.status === 'revoked',
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'Échec de la vérification de statut' });
  }
});

export default router;

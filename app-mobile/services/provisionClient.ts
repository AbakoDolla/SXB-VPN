/**
 * provisionClient.ts — Client de provisionnement sécurisé SXB VPN
 *
 * Gère le flux complet d'activation sécurisée :
 *   1. Appel à /api/provision/activate (dataToken + deviceId)
 *   2. Réception du blob chiffré AES-256-GCM + configKey
 *   3. Déchiffrement local via Web Crypto API (crypto.subtle — RN 0.73+)
 *   4. Stockage de la config déchiffrée dans SecureStore (Android Keystore)
 *
 * Le mobile ne stocke JAMAIS :
 *   ❌ Le blob chiffré brut (inutile après déchiffrement)
 *   ❌ Le configKey en clair (utilisé uniquement en mémoire)
 *   ❌ Les credentials dans AsyncStorage non chiffré
 */
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';
import * as configStore from './configStore';
import apiClient from './apiClient';
import { decryptSxbBlob, utf8Decode } from './aesGcm';

const PROV_KEY = 'sxb_prov_config_v2';
const PROV_META_KEY = 'sxb_prov_meta_v2';
const PROVISION_MAX_ATTEMPTS = 3;

type ProvisionStage = 'request' | 'response' | 'decrypt' | 'parse' | 'store';

export interface ProvisionDiagnostic {
  code: string;
  stage: ProvisionStage;
  attempts: number;
  retryable: boolean;
  httpStatus?: number;
  requestId?: string;
}

/** Erreur de provisionnement sûre à afficher dans les logs de l’application. */
export class ProvisioningError extends Error {
  readonly diagnostic: ProvisionDiagnostic;

  constructor(message: string, diagnostic: ProvisionDiagnostic) {
    super(message);
    this.name = 'ProvisioningError';
    this.diagnostic = diagnostic;
  }
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const value = (headers as Record<string, unknown>)[name] ?? (headers as Record<string, unknown>)[name.toLowerCase()];
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : undefined;
}

function toProvisioningError(error: unknown, attempts: number): ProvisioningError {
  if (error instanceof ProvisioningError) return error;

  if (axios.isAxiosError(error)) {
    const httpStatus = error.response?.status;
    const requestId = headerValue(error.response?.headers, 'x-sxb-request-id');
    const retryable = !httpStatus || httpStatus >= 500 || httpStatus === 408 || httpStatus === 429;
    const code = httpStatus
      ? `PVN_HTTP_${httpStatus}`
      : error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '')
        ? 'PVN_TIMEOUT'
        : 'PVN_NETWORK';
    const message = httpStatus
      ? `Provisionnement refusé par le serveur (${httpStatus})`
      : code === 'PVN_TIMEOUT'
        ? 'Délai réseau dépassé pendant le provisionnement'
        : 'La demande de provisionnement n’a pas atteint le serveur';
    return new ProvisioningError(message, {
      code, stage: 'request', attempts, retryable, httpStatus, requestId,
    });
  }

  return new ProvisioningError('Échec inattendu du provisionnement', {
    code: 'PVN_UNKNOWN', stage: 'request', attempts, retryable: false,
  });
}

async function requestProvision(dataToken: string, deviceId: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PROVISION_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await apiClient.post('/provision/activate', { dataToken, deviceId }, { timeout: 15_000 });
    } catch (error) {
      lastError = error;
      const diagnostic = toProvisioningError(error, attempt).diagnostic;
      if (!diagnostic.retryable || attempt === PROVISION_MAX_ATTEMPTS) throw toProvisioningError(error, attempt);
      await pause(350 * attempt);
    }
  }
  throw toProvisioningError(lastError, PROVISION_MAX_ATTEMPTS);
}

export interface ProvisionMeta {
  subscriptionId:  string;
  profileId:       string;
  profileName:     string;
  protocol:        string;
  displayProtocol: string;
  quotaGB:         number;
  quotaUsedGB:     number;
  expireAt:        string | null;
  configExpiresAt: string;
  provisionedAt:   string;
  encVersion:      string;
  /** §6.4 — métadonnées d'invalidation de cache (comparées à /mobile/connections) */
  configVersion:   number;
  configHash:      string | null;
}

// ── Helpers hex/bytes ─────────────────────────────────────────────────────────

function hexToUint8(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// ── Déchiffrement AES-256-GCM côté mobile ────────────────────────────────────
// Format blob : "gcm:<iv_hex(12o)>:<ciphertext_hex>:<tag_hex(16o)>"
//
// Stratégie double moteur (fix définitif) :
//   1. Web Crypto API (crypto.subtle) si disponible — natif, rapide.
//   2. Fallback pur TypeScript (services/aesGcm.ts) — OBLIGATOIRE sous Hermes :
//      React Native (toutes versions, RN 0.81 inclus) ne fournit PAS
//      crypto.subtle. Sans ce fallback, tout provisionnement échouait avec
//      « Moteur cryptographique indisponible » et aucune config complète
//      n'était jamais stockée → CONFIG_INCOMPLETE_BLOCK / hasHost=false.
// Le fallback ne dépend ni de TextDecoder ni d'aucune API Web.

async function decryptGCM(blob: string, configKeyHex: string): Promise<string> {
  if (!blob.startsWith('gcm:')) {
    throw new Error('Format de blob non supporté (attend gcm:...)');
  }

  const subtle = (typeof crypto !== 'undefined' ? crypto.subtle : undefined) as SubtleCrypto | undefined;
  if (subtle && typeof subtle.decrypt === 'function') {
    try {
      const parts = blob.slice(4).split(':');
      if (parts.length !== 3) throw new Error('Blob GCM invalide — mauvais nombre de segments');

      const [ivHex, cipherHex, tagHex] = parts;

      // Clé 32 octets (256 bits)
      const keyBytes = hexToUint8(configKeyHex.slice(0, 64));
      const iv       = hexToUint8(ivHex);

      // Web Crypto attend ciphertext + auth tag concaténés
      const cipherBytes = hexToUint8(cipherHex);
      const tagBytes    = hexToUint8(tagHex);
      const ciphertextWithTag = new Uint8Array(cipherBytes.length + tagBytes.length);
      ciphertextWithTag.set(cipherBytes);
      ciphertextWithTag.set(tagBytes, cipherBytes.length);

      const cryptoKey = await subtle.importKey(
        'raw',
        keyBytes as unknown as BufferSource,
        { name: 'AES-GCM' },
        false,
        ['decrypt'],
      );

      const decryptedBuffer = await subtle.decrypt(
        { name: 'AES-GCM', iv: iv as unknown as BufferSource },
        cryptoKey,
        ciphertextWithTag as unknown as BufferSource,
      );

      if (typeof TextDecoder !== 'undefined') {
        return new TextDecoder().decode(decryptedBuffer);
      }
      return utf8Decode(new Uint8Array(decryptedBuffer));
    } catch {
      // Moteur natif en échec (ou indisponible) → moteur TypeScript ci-dessous.
    }
  }

  // Moteur pur TypeScript — fonctionne partout (Hermes, JSC, Web, Node).
  return decryptSxbBlob(blob, configKeyHex);
}

// ── Provision/Activate ────────────────────────────────────────────────────────

export interface ProvisionResult {
  config: Record<string, any>;
  meta:   ProvisionMeta;
}

/**
 * Appelle /api/provision/activate, déchiffre la config, la stocke dans SecureStore.
 * @param dataToken  Token SXB-DATA de l'abonnement
 * @param deviceId   Identifiant unique de l'appareil
 * @returns          Config VPN déchiffrée + métadonnées (expiration, quota)
 */
export async function provisionAndStore(
  dataToken: string,
  deviceId:  string,
): Promise<ProvisionResult> {
  const res = await requestProvision(dataToken, deviceId);

  // Support both nested (dev server) and flat (production VPS) response formats.
  const prov = res.data?.config ? res.data.config : res.data;
  const encryptedBlob = prov?.encryptedBlob;
  const configKey = prov?.configKey;
  const configExpiresAt = prov?.configExpiresAt || prov?.expiresAt;
  const encVersion = prov?.encVersion || 'gcm-v2';
  const provisionedAt = prov?.provisionedAt || new Date().toISOString();
  const requestId = headerValue(res.headers, 'x-sxb-request-id');

  if (!encryptedBlob || !configKey) {
    throw new ProvisioningError('Réponse de provisionnement incomplète', {
      code: 'PVN_RESPONSE_INVALID', stage: 'response', attempts: 1, retryable: false, requestId,
    });
  }

  // ── C3 — Vérification de la liaison réponse ↔ appareil ──────────────────────
  // La réponse porte une `signature` HMAC calculée avec PROVISION_SECRET, un
  // secret que le mobile ne possède pas : elle est donc invérifiable côté client
  // et était silencieusement ignorée. À défaut, on contrôle ce qui est
  // vérifiable — que la réponse concerne bien CET appareil et CET abonnement —
  // afin qu'une réponse interceptée puis rejouée vers un autre appareil (ou une
  // réponse mal aiguillée par un cache/proxy) soit rejetée au lieu d'être
  // stockée dans le Keystore.
  //
  // Limitation connue (C2) : le serveur renvoie `encryptedBlob` ET `configKey`
  // dans la même réponse. Quiconque observe le corps de la réponse en clair peut
  // donc déchiffrer la configuration. Le chiffrement de bout en bout n'est pas
  // réalisable sans un échange de clés (ECDH) côté serveur ; TLS reste la seule
  // protection en transit. À traiter par un endpoint de provisionnement v3.
  const responseDeviceId = typeof prov?.deviceId === 'string' ? prov.deviceId.trim() : '';
  if (responseDeviceId && responseDeviceId !== deviceId) {
    throw new ProvisioningError('Réponse de provisionnement destinée à un autre appareil', {
      code: 'PVN_DEVICE_MISMATCH', stage: 'response', attempts: 1, retryable: false, requestId,
    });
  }

  if (configExpiresAt && new Date(configExpiresAt) < new Date()) {
    throw new ProvisioningError('Configuration expirée — re-provisionnement requis', {
      code: 'PVN_CONFIG_EXPIRED', stage: 'response', attempts: 1, retryable: false, requestId,
    });
  }

  let decryptedJson: string;
  try {
    decryptedJson = await decryptGCM(encryptedBlob, configKey);
  } catch {
    throw new ProvisioningError('Déchiffrement local impossible', {
      code: 'PVN_DECRYPT_FAILED', stage: 'decrypt', attempts: 1, retryable: false, requestId,
    });
  }

  let vpnConfig: Record<string, any>;
  try {
    vpnConfig = JSON.parse(decryptedJson) as Record<string, any>;
  } catch {
    throw new ProvisioningError('Configuration déchiffrée invalide', {
      code: 'PVN_CONFIG_PARSE_FAILED', stage: 'parse', attempts: 1, retryable: false, requestId,
    });
  }

  // C3 — Le contenu déchiffré doit lui aussi concerner cet appareil et cet
  // abonnement : le blob est authentifié par AES-GCM, ces champs sont donc
  // inforgeables et constituent la vraie preuve de liaison.
  const payloadDeviceId = typeof vpnConfig?.deviceId === 'string' ? vpnConfig.deviceId.trim() : '';
  if (payloadDeviceId && payloadDeviceId !== deviceId) {
    throw new ProvisioningError('Configuration liée à un autre appareil', {
      code: 'PVN_PAYLOAD_DEVICE_MISMATCH', stage: 'parse', attempts: 1, retryable: false, requestId,
    });
  }
  const responseSubscriptionId = typeof prov?.subscriptionId === 'string' ? prov.subscriptionId.trim() : '';
  const payloadSubscriptionId = typeof vpnConfig?.subscriptionId === 'string' ? vpnConfig.subscriptionId.trim() : '';
  if (responseSubscriptionId && payloadSubscriptionId && responseSubscriptionId !== payloadSubscriptionId) {
    throw new ProvisioningError('Configuration liée à un autre abonnement', {
      code: 'PVN_PAYLOAD_SUBSCRIPTION_MISMATCH', stage: 'parse', attempts: 1, retryable: false, requestId,
    });
  }

  const meta: ProvisionMeta = {
    subscriptionId:  prov.subscriptionId || '',
    profileId:       prov.profileId || '',
    profileName:     prov.profileName || '',
    protocol:        prov.protocol || '',
    displayProtocol: prov.displayProtocol || '',
    quotaGB:         prov.quotaGB || 0,
    quotaUsedGB:     prov.quotaUsedGB || 0,
    expireAt:        prov.expireAt || null,
    configExpiresAt: configExpiresAt,
    provisionedAt:   provisionedAt,
    encVersion:      encVersion,
    configVersion:   typeof prov.configVersion === 'number' ? prov.configVersion : 1,
    configHash:      prov.configHash || null,
  };
  const id = meta.subscriptionId || String(vpnConfig.configId || `provision_${Date.now()}`);
  const stored = await configStore.save(id, vpnConfig, {
    configId: id, name: meta.profileName, protocol: meta.protocol, displayProtocol: meta.displayProtocol,
    subscriptionId: meta.subscriptionId, quotaTotal: Math.round(meta.quotaGB * 1024 ** 3),
    quotaUsed: Math.round(meta.quotaUsedGB * 1024 ** 3), expiryDate: meta.expireAt,
    configVersion: meta.configVersion, configHash: meta.configHash,
  });
  if (stored.status !== 'ok') {
    throw new ProvisioningError('Stockage chiffré indisponible', {
      code: 'PVN_STORE_FAILED', stage: 'store', attempts: 1, retryable: false, requestId,
    });
  }
  return { config: vpnConfig, meta };
}

/**
 * Charge la config VPN provisionnée depuis SecureStore.
 * Retourne null si aucune config n'est disponible ou si elle est expirée.
 */
export async function loadProvisionedConfig(): Promise<{ config: Record<string, any>; meta: ProvisionMeta } | null> {
  const result = await configStore.getActive();
  if (result.status !== 'ok' || !result.value) return null;
  const m = result.value.meta;
  return { config: result.value.config, meta: {
    subscriptionId: m.subscriptionId || m.configId, profileId: '', profileName: m.name || '', protocol: m.protocol || '',
    displayProtocol: m.displayProtocol || '', quotaGB: (m.quotaTotal || 0) / 1024 ** 3,
    quotaUsedGB: (m.quotaUsed || 0) / 1024 ** 3, expireAt: m.expiryDate || null, configExpiresAt: m.expiryDate || '',
    provisionedAt: m.savedAt || '', encVersion: 'gcm-local-v1', configVersion: m.configVersion || 1, configHash: m.configHash || null,
  }};
}

/**
 * Supprime la config provisionnée (révocation, déconnexion, reset).
 */
export async function clearProvisionedConfig(): Promise<void> {
  const active = await configStore.getActive();
  if (active.status === 'ok' && active.value) await configStore.remove(active.value.meta.configId);
}

/**
 * Vérifie si une config provisionnée valide est disponible hors-ligne.
 */
export async function hasValidProvisionedConfig(): Promise<boolean> {
  const result = await loadProvisionedConfig();
  return result !== null;
}

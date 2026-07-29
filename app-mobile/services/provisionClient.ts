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
import apiClient from './apiClient';

const PROV_KEY = 'sxb_prov_config_v2';
const PROV_META_KEY = 'sxb_prov_meta_v2';

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
// La Web Crypto API (crypto.subtle) est disponible sur RN 0.73+ / Expo 50+.

async function decryptGCM(blob: string, configKeyHex: string): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('Moteur cryptographique indisponible');
  }
  if (!blob.startsWith('gcm:')) {
    throw new Error('Format de blob non supporté (attend gcm:...)');
  }
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

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes as unknown as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );

  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    cryptoKey,
    ciphertextWithTag as unknown as BufferSource,
  );

  return new TextDecoder().decode(decryptedBuffer);
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
  const res = await apiClient.post('/provision/activate', { dataToken, deviceId });
  
  // Support both nested (dev server) and flat (production VPS) response formats
  const prov = res.data?.config ? res.data.config : res.data;

  const encryptedBlob = prov?.encryptedBlob;
  const configKey = prov?.configKey;
  const configExpiresAt = prov?.configExpiresAt || prov?.expiresAt;
  const encVersion = prov?.encVersion || 'gcm-v2';
  const provisionedAt = prov?.provisionedAt || new Date().toISOString();

  if (!encryptedBlob || !configKey) {
    throw new Error('Réponse provision invalide — champs manquants');
  }

  // Vérification expiration de la config
  if (configExpiresAt && new Date(configExpiresAt) < new Date()) {
    throw new Error('Configuration expirée — re-provisionnement requis');
  }

  // Déchiffrement local (jamais envoyé en clair sur le réseau après ce point)
  const decryptedJson = await decryptGCM(encryptedBlob, configKey);
  const vpnConfig     = JSON.parse(decryptedJson) as Record<string, any>;

  // Stockage dans SecureStore (Android Keystore / iOS Keychain)
  await SecureStore.setItemAsync(PROV_KEY, JSON.stringify(vpnConfig));

  // Métadonnées non-sensibles dans AsyncStorage (quota, expiration, identifiants)
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
  };
  await AsyncStorage.setItem(PROV_META_KEY, JSON.stringify(meta));

  return { config: vpnConfig, meta };
}

/**
 * Charge la config VPN provisionnée depuis SecureStore.
 * Retourne null si aucune config n'est disponible ou si elle est expirée.
 */
export async function loadProvisionedConfig(): Promise<{
  config: Record<string, any>;
  meta:   ProvisionMeta;
} | null> {
  try {
    const [rawConfig, rawMeta] = await Promise.all([
      SecureStore.getItemAsync(PROV_KEY),
      AsyncStorage.getItem(PROV_META_KEY),
    ]);
    if (!rawConfig || !rawMeta) return null;

    const config = JSON.parse(rawConfig) as Record<string, any>;
    const meta   = JSON.parse(rawMeta)   as ProvisionMeta;

    // Vérification d'expiration locale
    if (meta.configExpiresAt && new Date(meta.configExpiresAt) < new Date()) {
      await clearProvisionedConfig();
      return null;
    }

    return { config, meta };
  } catch {
    return null;
  }
}

/**
 * Supprime la config provisionnée (révocation, déconnexion, reset).
 */
export async function clearProvisionedConfig(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(PROV_KEY).catch(() => null),
    AsyncStorage.removeItem(PROV_META_KEY),
  ]);
}

/**
 * Vérifie si une config provisionnée valide est disponible hors-ligne.
 */
export async function hasValidProvisionedConfig(): Promise<boolean> {
  const result = await loadProvisionedConfig();
  return result !== null;
}

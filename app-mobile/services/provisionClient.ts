/**
 * provisionClient.ts — Client de provisionnement sécurisé SXB VPN
 *
 * Gère le flux complet d'activation sécurisée :
 *   1. Appel à /api/provision/activate (dataToken + deviceId)
 *   2. Réception de la config VPN (chiffrée ou en clair selon encVersion)
 *   3. Déchiffrement local via Web Crypto API (crypto.subtle — RN 0.73+) si nécessaire
 *   4. Stockage de la config dans SecureStore (Android Keystore)
 *
 * Formats supportés :
 *   - encVersion: "gcm-v1" → AES-256-GCM chiffré (encryptedBlob + configKey)
 *   - encVersion: "plain-v1" → Config VPN en clair (vpnConfig)
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
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );

  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    ciphertextWithTag,
  );

  return new TextDecoder().decode(decryptedBuffer);
}

// ── Provision/Activate ────────────────────────────────────────────────────────

/**
 * Appelle /api/provision/activate, déchiffre la config si nécessaire, la stocke dans SecureStore.
 * @param dataToken  Token SXB-DATA de l'abonnement
 * @param deviceId   Identifiant unique de l'appareil
 * @returns          Config VPN (objet JSON brut)
 */
export async function provisionAndStore(
  dataToken: string,
  deviceId:  string,
): Promise<Record<string, any>> {
  const res = await apiClient.post('/provision/activate', { dataToken, deviceId });
  const { config: prov } = res.data;

  // Vérification expiration de la config
  if (prov.configExpiresAt && new Date(prov.configExpiresAt) < new Date()) {
    throw new Error('Configuration expirée — re-provisionnement requis');
  }

  let vpnConfig: Record<string, any>;

  // Support multi-format : chiffré (gcm-v1) ou clair (plain-v1)
  if (prov.encryptedBlob && prov.configKey) {
    // Format chiffré AES-256-GCM
    console.log('[Provision] Using encrypted config (gcm-v1)');
    const decryptedJson = await decryptGCM(prov.encryptedBlob, prov.configKey);
    vpnConfig = JSON.parse(decryptedJson) as Record<string, any>;
  } else if (prov.vpnConfig) {
    // Format clair (plain-v1)
    console.log('[Provision] Using plain config (plain-v1)');
    vpnConfig = prov.vpnConfig as Record<string, any>;
  } else {
    throw new Error('Réponse provision invalide — champs manquants (encryptedBlob/configKey ou vpnConfig)');
  }

  // Stockage dans SecureStore (Android Keystore / iOS Keychain)
  await SecureStore.setItemAsync(PROV_KEY, JSON.stringify(vpnConfig));

  // Métadonnées non-sensibles dans AsyncStorage (quota, expiration, identifiants)
  const meta: ProvisionMeta = {
    subscriptionId:  prov.subscriptionId,
    profileId:       prov.profileId,
    profileName:     prov.profileName,
    protocol:        prov.protocol,
    displayProtocol: prov.displayProtocol || prov.vpnConfig?.protocol?.toUpperCase() || prov.protocol?.toUpperCase() || 'VPN',
    quotaGB:         prov.quotaGB,
    quotaUsedGB:     prov.quotaUsedGB,
    expireAt:        prov.expireAt,
    configExpiresAt: prov.configExpiresAt,
    provisionedAt:   prov.provisionedAt,
    encVersion:      prov.encVersion,
  };
  await AsyncStorage.setItem(PROV_META_KEY, JSON.stringify(meta));

  return vpnConfig;
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

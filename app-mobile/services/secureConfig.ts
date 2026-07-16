/**
 * secureConfig.ts
 *
 * Stockage chiffré des configurations VPN importées.
 * Utilise la Web Crypto API (AES-GCM 256-bit) disponible nativement
 * dans React Native 0.71+ avec Hermes — aucune dépendance native ajoutée.
 *
 * Structure stockée dans AsyncStorage (en clair pour montrer l'easter egg,
 * données chiffrées inutilisables sans la clé) :
 * {
 *   "hint": "TU AS VRAIMENT CRU ...",
 *   "salt": "<base64>",
 *   "iv":   "<base64>",
 *   "data": "<base64_AES-GCM>"
 * }
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Easter egg ────────────────────────────────────────────────────────────────
const EASTER_EGG =
  'TU AS VRAIMENT CRU QUE TU POUVAIS CRAQUER OU DÉCRYPTER MON APP ?' +
  'LAISSE MOI RIRE 😂 — SXB VPN — ' +
  'Toute tentative de reverse-engineering est contraire aux CGU. ' +
  'Les données chiffrées ci-dessous sont inutilisables sans votre token personnel.';

// ─── Constants ─────────────────────────────────────────────────────────────────
const STORAGE_KEY = '@sxb_secure_config_v2';
const PEPPER = 'SXB-VPN-AES-GCM-PEPPER-v2-2024';
const PBKDF2_ITERATIONS = 100_000;

// ─── Helpers ────────────────────────────────────────────────────────────────────

function buf2b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b642buf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

// ─── Key derivation via PBKDF2 ─────────────────────────────────────────────────

async function deriveKey(token: string, salt: ArrayBuffer): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(token + PEPPER),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface SecureConfigPayload {
  subscriptionUrl?: string;
  protocols?: Array<{
    name: string;
    port: number;
    transport: string;
    security: string;
    description?: string;
  }>;
  serverInfo?: { host: string; location: string };
  importedAt?: string;
  raw?: string;
  [key: string]: unknown;
}

// ─── Public API ─────────────────────────────────────────────────────────────────

/**
 * Chiffre et stocke la configuration VPN avec AES-GCM 256-bit.
 */
export async function saveSecureConfig(
  token: string,
  config: SecureConfigPayload,
): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16)).buffer;
  const iv   = crypto.getRandomValues(new Uint8Array(12)).buffer;

  const key = await deriveKey(token, salt);
  const enc = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(JSON.stringify(config)),
  );

  const envelope = JSON.stringify({
    hint: EASTER_EGG,
    salt: buf2b64(salt),
    iv:   buf2b64(iv),
    data: buf2b64(encrypted),
  });

  await AsyncStorage.setItem(STORAGE_KEY, envelope);
}

/**
 * Déchiffre et retourne la configuration VPN.
 * Retourne null si absente ou si le token est invalide.
 */
export async function loadSecureConfig(
  token: string,
): Promise<SecureConfigPayload | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const { salt, iv, data } = JSON.parse(raw) as {
      hint?: string;
      salt: string;
      iv: string;
      data: string;
    };

    const key = await deriveKey(token, b642buf(salt));
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b642buf(iv) },
      key,
      b642buf(data),
    );

    const dec = new TextDecoder();
    return JSON.parse(dec.decode(decrypted)) as SecureConfigPayload;
  } catch {
    return null;
  }
}

/**
 * Supprime la configuration stockée (ex : logout).
 */
export async function clearSecureConfig(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
}

/**
 * Vérifie si une configuration est déjà stockée.
 */
export async function hasSecureConfig(): Promise<boolean> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY).catch(() => null);
  return raw !== null;
}

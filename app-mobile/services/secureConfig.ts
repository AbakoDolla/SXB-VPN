/**
 * secureConfig.ts
 *
 * Stockage chiffré des configurations VPN importées.
 * Utilise XOR-256 avec une clé dérivée par SHA-256 (via expo-crypto).
 *
 * Structure en clair visible dans AsyncStorage :
 * {
 *   "hint": "TU AS VRAIMENT CRU ...",   ← Easter egg visible en clair
 *   "iv": "<hex>",                       ← vecteur d'initialisation
 *   "data": "<base64_encrypted>"         ← données chiffrées
 * }
 *
 * Sans le token source (clé de dérivation), le champ "data" est illisible.
 */

import * as ExpoCrypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Easter egg ────────────────────────────────────────────────────────────────
const EASTER_EGG =
  "TU AS VRAIMENT CRU QUE TU POUVAIS CRAQUER OU DÉCRYPTER MON APP ?" +
  "LAISSE MOI RIRE 😂 — SXB VPN — Toute tentative de reverse-engineering " +
  "est contraire aux CGU. Les données chiffrées ci-dessous sont inutilisables sans le token.";

// ─── Constants ─────────────────────────────────────────────────────────────────
const STORAGE_KEY = '@sxb_secure_config_v2';
const PEPPER = 'SXB-VPN-SECURE-PEPPER-v2-2024';

// ─── Key derivation ─────────────────────────────────────────────────────────────

async function deriveKey(token: string, ivHex: string): Promise<Uint8Array> {
  const hex = await ExpoCrypto.digestStringAsync(
    ExpoCrypto.CryptoDigestAlgorithm.SHA256,
    token + PEPPER + ivHex,
    { encoding: ExpoCrypto.CryptoEncoding.HEX }
  );
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ─── XOR cipher ─────────────────────────────────────────────────────────────────

function xorBytes(input: Uint8Array, key: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) {
    out[i] = input[i] ^ key[i % key.length];
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function hexToString(hex: string): string {
  return hex.substring(0, 16); // Use first 16 chars as IV string
}

// ─── Public API ─────────────────────────────────────────────────────────────────

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
  raw?: string; // Raw config string for clipboard/share
  [key: string]: unknown;
}

/**
 * Chiffre et stocke la configuration VPN.
 * @param token  - Token utilisateur (sert de base à la clé de chiffrement)
 * @param config - Données de configuration à protéger
 */
export async function saveSecureConfig(
  token: string,
  config: SecureConfigPayload,
): Promise<void> {
  // Génère un IV aléatoire unique pour ce stockage
  const ivBytes = await ExpoCrypto.getRandomBytesAsync(16);
  const ivHex = Array.from(ivBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  const key = await deriveKey(token, ivHex);
  const plaintext = JSON.stringify(config);

  const encoder = new TextEncoder();
  const encrypted = xorBytes(encoder.encode(plaintext), key);

  const envelope = JSON.stringify({
    hint: EASTER_EGG,
    iv: ivHex,
    data: bytesToBase64(encrypted),
  });

  await AsyncStorage.setItem(STORAGE_KEY, envelope);
}

/**
 * Déchiffre et retourne la configuration VPN stockée.
 * @param token - Token utilisateur (même que celui utilisé pour chiffrer)
 * @returns La configuration, ou null si absente ou token invalide
 */
export async function loadSecureConfig(
  token: string,
): Promise<SecureConfigPayload | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const envelope = JSON.parse(raw) as {
      hint?: string;
      iv: string;
      data: string;
    };

    const key = await deriveKey(token, envelope.iv);
    const encrypted = base64ToBytes(envelope.data);
    const decrypted = xorBytes(encrypted, key);

    const decoder = new TextDecoder();
    const plaintext = decoder.decode(decrypted);
    return JSON.parse(plaintext) as SecureConfigPayload;
  } catch {
    return null;
  }
}

/**
 * Supprime la configuration stockée (ex : lors du logout).
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

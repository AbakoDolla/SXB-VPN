/**
 * crypto.ts — Utilitaires de chiffrement SXB VPN
 *
 * HISTORIQUE :
 *   v1  AES-256-CBC  (legacy — uniquement pour déchiffrer les anciennes valeurs DB)
 *   v2  AES-256-GCM  (courant — chiffrement authentifié, protection contre la falsification)
 *
 * RÈGLE : Toute nouvelle valeur chiffrée DOIT utiliser encryptGCM().
 *         Les anciennes valeurs CBC restent lisibles via decrypt() (rétro-compatibilité).
 */
import crypto from "crypto";
import { config } from "../config";

const ALGORITHM_GCM = "aes-256-gcm";
const ALGORITHM_CBC = "aes-256-cbc";

const getEncryptionKey = (): Buffer => {
  const k = config.ENCRYPTION_KEY;
  if (!k || k.startsWith("CHANGE_ME") || k === "sxb-vpn-32-byte-encryption-key-!") {
    throw new Error("[SECURITY] ENCRYPTION_KEY non configurée ou invalide — arrêt immédiat");
  }
  // Dériver exactement 32 octets (AES-256)
  return crypto.createHash("sha256").update(k).digest();
};

// ── AES-256-GCM (courant — chiffrement authentifié) ─────────────────────────
// Format : "gcm:<iv_hex(12o)>:<ciphertext_hex>:<authtag_hex(16o)>"

export function encryptGCM(text: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // 96 bits — recommandé NIST pour GCM
  const cipher = crypto.createCipheriv(ALGORITHM_GCM, key, iv) as crypto.CipherGCM;
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag(); // 128 bits
  return `gcm:${iv.toString("hex")}:${encrypted.toString("hex")}:${tag.toString("hex")}`;
}

export function decryptGCM(encryptedText: string): string {
  if (!encryptedText.startsWith("gcm:")) {
    throw new Error("Format GCM invalide (préfixe manquant)");
  }
  const parts = encryptedText.slice(4).split(":");
  if (parts.length !== 3) throw new Error("Format GCM invalide (mauvais nombre de segments)");
  const [ivHex, cipherHex, tagHex] = parts;
  const key     = getEncryptionKey();
  const iv      = Buffer.from(ivHex,    "hex");
  const tag     = Buffer.from(tagHex,   "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM_GCM, key, iv) as crypto.DecipherGCM;
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(cipherHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

// ── AES-256-CBC (legacy — LECTURE SEULE pour les valeurs déjà en DB) ─────────
// Format : "<iv_hex(16o)>:<ciphertext_hex>"
// NE PAS utiliser pour de nouvelles encryptions.

export function encrypt(text: string): string {
  // Redirige vers GCM pour toute nouvelle valeur
  return encryptGCM(text);
}

export function decrypt(encryptedText: string): string {
  // Détection automatique du format
  if (encryptedText.startsWith("gcm:")) {
    return decryptGCM(encryptedText);
  }
  // Rétro-compatibilité : format CBC legacy
  try {
    const [ivHex, encryptedHex] = encryptedText.split(":");
    if (!ivHex || !encryptedHex) throw new Error("Format CBC invalide");
    const key      = getEncryptionKey();
    const iv       = Buffer.from(ivHex, "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM_CBC, key, iv);
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedHex, "hex")),
      decipher.final(),
    ]).toString("utf8");
  } catch (err) {
    throw new Error("Échec du déchiffrement (format inconnu ou données corrompues)");
  }
}

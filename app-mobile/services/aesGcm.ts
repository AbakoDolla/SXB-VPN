/**
 * aesGcm.ts — AES-256-GCM pur TypeScript pour SXB VPN
 *
 * ═══════════════════════════════════════════════════════════════════
 * POURQUOI CE FICHIER EXISTE (cause racine de la panne de connexion)
 * ═══════════════════════════════════════════════════════════════════
 * Le déchiffrement du blob de provisionnement (/provision/activate) utilisait
 * exclusivement `crypto.subtle` (Web Crypto API). Or Le moteur JavaScript
 * Hermes de React Native (y compris RN 0.81 / Expo SDK 54) N'IMPLÉMENTE PAS
 * `crypto.subtle` — l'appel levait systématiquement
 * « Moteur cryptographique indisponible » sur l'APK réel.
 *
 * Conséquence en production :
 *   provision/activate OK (HTTP 200, blob reçu)
 *   → decryptGCM() jette une exception
 *   → aucune config complète jamais stockée dans SecureStore
 *   → CONFIG_INCOMPLETE_BLOCK / hasHost=false / hasCreds=false
 *   → connexion VPN impossible, même avec un réseau parfait.
 *
 * Ce module implémente AES-256-GCM (déchiffrement + chiffrement) en pur
 * TypeScript — aucune dépendance native, aucun polyfill global requis.
 * Le volume déchiffré est minuscule (~2 Ko), la performance est donc un
 * non-sujet (< 10 ms sur un téléphone d'entrée de gamme).
 *
 * Références : FIPS-197 (AES), NIST SP 800-38D (GCM).
 * Vérifié par tests E2E contre l'implémentation Node.js `crypto`
 * (scripts/tests/provision-e2e.test.mjs) sur vecteurs aléatoires.
 */

// ── Table S-box AES (FIPS-197, §5.1.1) ─────────────────────────────────────

const SBOX: readonly number[] = [
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
];

// Constantes de tour pour AES-256 (KeyExpansion, 14 tours)
const RCON: readonly number[] = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40];

// ── Multiplication dans GF(2^8) (MixColumns) ────────────────────────────────

function xtime(a: number): number {
  const r = a << 1;
  return (a & 0x80 ? (r ^ 0x1b) : r) & 0xff;
}

function mul2(a: number): number { return xtime(a); }
function mul3(a: number): number { return xtime(a) ^ a; }

// ── Cœur AES-256 (chiffrement de bloc uniquement — GCM n'utilise que lui) ──

class Aes256 {
  /** Clé étendue : 60 mots de 32 bits (Nb=4, Nk=8, Nr=14) → 240 octets */
  private readonly w: Uint8Array;

  constructor(key: Uint8Array) {
    if (key.length !== 32) {
      throw new Error(`AES-256 : clé de ${key.length} octets (32 attendus)`);
    }
    const w = new Uint8Array(240);
    w.set(key, 0);
    let bytesGenerated = 32;
    let rconIdx = 0;
    const temp = new Uint8Array(4);

    while (bytesGenerated < 240) {
      for (let i = 0; i < 4; i++) temp[i] = w[bytesGenerated - 4 + i];

      if (bytesGenerated % 32 === 0) {
        // RotWord + SubWord + Rcon
        const t = temp[0];
        temp[0] = SBOX[temp[1]] ^ RCON[rconIdx++];
        temp[1] = SBOX[temp[2]];
        temp[2] = SBOX[temp[3]];
        temp[3] = SBOX[t];
      } else if (bytesGenerated % 32 === 16) {
        // SubWord (spécifique AES-256)
        for (let i = 0; i < 4; i++) temp[i] = SBOX[temp[i]];
      }

      for (let i = 0; i < 4; i++) {
        w[bytesGenerated] = (w[bytesGenerated - 32] ^ temp[i]) & 0xff;
        bytesGenerated++;
      }
    }
    this.w = w;
  }

  /** Chiffre UN bloc de 16 octets (FIPS-197 Cipher, Nr=14). */
  encryptBlock(input: Uint8Array, output?: Uint8Array): Uint8Array {
    if (input.length !== 16) throw new Error('AES : bloc de 16 octets requis');
    const out = output ?? new Uint8Array(16);
    const s = new Uint8Array(16);
    s.set(input);
    const w = this.w;

    // AddRoundKey initial
    for (let i = 0; i < 16; i++) s[i] ^= w[i];

    for (let round = 1; round <= 14; round++) {
      // SubBytes
      for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];

      // ShiftRows (état organisé en colonnes : s[col*4 + row])
      let t: number;
      // ligne 1 : décalage de 1
      t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
      // ligne 2 : décalage de 2
      t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
      // ligne 3 : décalage de 3 (≡ décalage inverse de 1)
      t = s[3]; s[3] = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = t;

      if (round < 14) {
        // MixColumns
        for (let c = 0; c < 4; c++) {
          const i = c * 4;
          const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
          s[i]     = mul2(a0) ^ mul3(a1) ^ a2 ^ a3;
          s[i + 1] = a0 ^ mul2(a1) ^ mul3(a2) ^ a3;
          s[i + 2] = a0 ^ a1 ^ mul2(a2) ^ mul3(a3);
          s[i + 3] = mul3(a0) ^ a1 ^ a2 ^ mul2(a3);
        }
      }

      // AddRoundKey
      const off = round * 16;
      for (let i = 0; i < 16; i++) s[i] ^= w[off + i];
    }

    out.set(s);
    return out;
  }
}

// ── GHASH (NIST SP 800-38D, §6.3) ───────────────────────────────────────────

/** Multiplication de deux blocs de 128 bits dans GF(2^128), R = 0xE1‖0^120. */
function gcmMultiply(x: Uint8Array, y: Uint8Array): Uint8Array {
  const z = new Uint8Array(16);
  const v = new Uint8Array(y);

  for (let i = 0; i < 16; i++) {
    const xi = x[i];
    for (let bit = 0; bit < 8; bit++) {
      if ((xi >> (7 - bit)) & 1) {
        for (let k = 0; k < 16; k++) z[k] ^= v[k];
      }
      // v >>= 1 ; si le bit de poids faible sort, v ^= R
      const lsb = v[15] & 1;
      for (let k = 15; k > 0; k--) {
        v[k] = ((v[k] >> 1) | ((v[k - 1] & 1) << 7)) & 0xff;
      }
      v[0] = (v[0] >> 1) & 0xff;
      if (lsb) v[0] ^= 0xe1;
    }
  }
  return z;
}

function xorInto(acc: Uint8Array, block: Uint8Array): void {
  for (let i = 0; i < 16; i++) acc[i] ^= block[i];
}

/** GHASH_H(A ‖ C ‖ lenA·8 ‖ lenC·8) avec padding à 16 octets. */
function ghash(h: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const y = new Uint8Array(16);
  const block = new Uint8Array(16);

  const feed = (data: Uint8Array): void => {
    for (let off = 0; off < data.length; off += 16) {
      block.fill(0);
      const n = Math.min(16, data.length - off);
      for (let i = 0; i < n; i++) block[i] = data[off + i];
      xorInto(y, block);
      const prod = gcmMultiply(y, h);
      y.set(prod);
    }
  };

  feed(aad);
  feed(ciphertext);

  // Bloc final : longueurs en BITS, big-endian 64 bits
  const lenBlock = new Uint8Array(16);
  writeLen64(lenBlock, 0, aad.length);
  writeLen64(lenBlock, 8, ciphertext.length);
  xorInto(y, lenBlock);
  const prod = gcmMultiply(y, h);
  y.set(prod);
  return y;
}

function writeLen64(out: Uint8Array, offset: number, byteLen: number): void {
  const bitLen = byteLen * 8;
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  out[offset]     = (hi >>> 24) & 0xff;
  out[offset + 1] = (hi >>> 16) & 0xff;
  out[offset + 2] = (hi >>> 8)  & 0xff;
  out[offset + 3] =  hi         & 0xff;
  out[offset + 4] = (lo >>> 24) & 0xff;
  out[offset + 5] = (lo >>> 16) & 0xff;
  out[offset + 6] = (lo >>> 8)  & 0xff;
  out[offset + 7] =  lo         & 0xff;
}

// ── GCTR / mode compteur (inc32 des 32 derniers bits) ───────────────────────

function inc32(counter: Uint8Array): void {
  for (let i = 15; i >= 12; i--) {
    counter[i] = (counter[i] + 1) & 0xff;
    if (counter[i] !== 0) break;
  }
}

function gctr(aes: Aes256, icb: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  const counter = new Uint8Array(icb);
  const keystream = new Uint8Array(16);

  for (let off = 0; off < data.length; off += 16) {
    aes.encryptBlock(counter, keystream);
    const n = Math.min(16, data.length - off);
    for (let i = 0; i < n; i++) out[off + i] = data[off + i] ^ keystream[i];
    inc32(counter);
  }
  return out;
}

/** J0 pour IV de 12 octets : IV ‖ 0x00000001. */
function j0FromIv12(iv: Uint8Array): Uint8Array {
  const j0 = new Uint8Array(16);
  j0.set(iv, 0);
  j0[15] = 1;
  return j0;
}

// ── API publique ─────────────────────────────────────────────────────────────

/**
 * Déchiffre AES-256-GCM.
 * @param key        32 octets
 * @param iv         12 octets (NIST GCM)
 * @param ciphertext corps chiffré
 * @param authTag    16 octets (128 bits)
 * @param aad        données associées (vide par défaut — le serveur SXB n'en utilise pas)
 * @returns le texte en clair ; lève une erreur si le tag ne correspond pas.
 */
export function decryptAes256Gcm(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  authTag: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
): Uint8Array {
  if (iv.length !== 12)  throw new Error(`GCM : IV de ${iv.length} octets (12 attendus)`);
  if (authTag.length !== 16) throw new Error(`GCM : tag de ${authTag.length} octets (16 attendus)`);

  const aes = new Aes256(key);
  const j0  = j0FromIv12(iv);

  // Vérification du tag AVANT de retourner le moindre octet (AEAD)
  const h = new Uint8Array(16);
  aes.encryptBlock(new Uint8Array(16), h); // H = E(K, 0^128)

  const s = ghash(h, aad, ciphertext);
  const ej0 = new Uint8Array(16);
  aes.encryptBlock(j0, ej0);
  xorInto(s, ej0); // tag attendu

  // Comparaison en temps constant (anti-timing oracle)
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= s[i] ^ authTag[i];
  if (diff !== 0) {
    throw new Error('GCM : authentification échouée (clé invalide ou blob falsifié)');
  }

  // Le compteur du flux commence à inc32(J0)
  const icb = new Uint8Array(j0);
  inc32(icb);
  return gctr(aes, icb, ciphertext);
}

/**
 * Chiffre AES-256-GCM (utilisé par les tests E2E et les utilitaires locaux).
 * Retourne { ciphertext, authTag }.
 */
export function encryptAes256Gcm(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
): { ciphertext: Uint8Array; authTag: Uint8Array } {
  if (iv.length !== 12) throw new Error(`GCM : IV de ${iv.length} octets (12 attendus)`);

  const aes = new Aes256(key);
  const j0  = j0FromIv12(iv);

  const icb = new Uint8Array(j0);
  inc32(icb);
  const ciphertext = gctr(aes, icb, plaintext);

  const h = new Uint8Array(16);
  aes.encryptBlock(new Uint8Array(16), h);
  const s = ghash(h, aad, ciphertext);
  const ej0 = new Uint8Array(16);
  aes.encryptBlock(j0, ej0);
  xorInto(s, ej0);

  return { ciphertext, authTag: s };
}

// ── Codec UTF-8 autonome ─────────────────────────────────────────────────────
// TextEncoder/TextDecoder ne sont pas garantis sous Hermes selon la version :
// on encode/décode manuellement (couvre l'intégralité d'Unicode).

export function utf8Encode(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    // Paires surrogates
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

export function utf8Decode(bytes: Uint8Array): string {
  const codes: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    if (b0 < 0x80) {
      codes.push(b0);
      i += 1;
    } else if ((b0 & 0xe0) === 0xc0) {
      codes.push(((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if ((b0 & 0xf0) === 0xe0) {
      codes.push(((b0 & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
      i += 3;
    } else {
      const cp = ((b0 & 0x07) << 18)
        | ((bytes[i + 1] & 0x3f) << 12)
        | ((bytes[i + 2] & 0x3f) << 6)
        | (bytes[i + 3] & 0x3f);
      // Split en paire surrogate pour String.fromCharCode
      const v = cp - 0x10000;
      codes.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      i += 4;
    }
  }
  // fromCharCode par lots (limite d'arguments)
  let out = '';
  for (let off = 0; off < codes.length; off += 8192) {
    out += String.fromCharCode(...codes.slice(off, off + 8192));
  }
  return out;
}

// ── Helpers hex ──────────────────────────────────────────────────────────────

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Hex invalide (longueur impaire)');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Déchiffre un blob SXB "gcm:<iv_hex>:<cipher_hex>:<tag_hex>".
 * Point d'entrée unique utilisé par provisionClient (fallback Hermes).
 */
export function decryptSxbBlob(blob: string, configKeyHex: string): string {
  if (!blob || !blob.startsWith('gcm:')) {
    throw new Error('Format de blob non supporté (attendu : gcm:...)');
  }
  const parts = blob.slice(4).split(':');
  if (parts.length !== 3) {
    throw new Error('Blob GCM invalide — mauvais nombre de segments');
  }
  const [ivHex, cipherHex, tagHex] = parts;
  const keyBytes = hexToBytes(configKeyHex.slice(0, 64));
  if (keyBytes.length !== 32) {
    throw new Error('Clé de provision invalide (32 octets attendus)');
  }
  const plain = decryptAes256Gcm(
    keyBytes,
    hexToBytes(ivHex),
    hexToBytes(cipherHex),
    hexToBytes(tagHex),
  );
  return utf8Decode(plain);
}

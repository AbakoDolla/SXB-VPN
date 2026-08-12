import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  bytesToHex,
  decryptAes256Gcm,
  encryptAes256Gcm,
  hexToBytes,
  utf8Decode,
  utf8Encode,
} from '../services/aesGcm';

// La commande npm est exécutée depuis app-mobile, localement comme dans CI.
const source = (relativePath: string) => readFileSync(relativePath, 'utf8');

describe('chiffrement de la configuration VPN', () => {
  it('chiffre puis déchiffre exactement un profil provisionné', () => {
    const key = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));
    const iv = new Uint8Array(Array.from({ length: 12 }, (_, index) => 0xa0 + index));
    const profile = JSON.stringify({
      protocol: 'vless',
      host: 'vpn.example.test',
      port: 443,
      credential: 'never-log-this-value',
    });

    const encrypted = encryptAes256Gcm(key, iv, utf8Encode(profile));
    const restored = utf8Decode(decryptAes256Gcm(key, iv, encrypted.ciphertext, encrypted.authTag));

    assert.equal(restored, profile);
    assert.deepEqual(hexToBytes(bytesToHex(key)), key);
  });

  it('refuse un profil dont le tag d’authentification a été altéré', () => {
    const key = new Uint8Array(32).fill(7);
    const iv = new Uint8Array(12).fill(3);
    const encrypted = encryptAes256Gcm(key, iv, utf8Encode('{"host":"vpn.example.test"}'));
    const alteredTag = new Uint8Array(encrypted.authTag);
    alteredTag[0] ^= 0xff;

    assert.throws(
      () => decryptAes256Gcm(key, iv, encrypted.ciphertext, alteredTag),
      /authentification échouée/,
    );
  });
});

describe('garde-fous contre les régressions Android', () => {
  const configStore = source('services/configStore.ts');
  const supportScreen = source('app/support.tsx');
  const provisionClient = source('services/provisionClient.ts');
  const mobileRoutes = source('../server/routes/mobile.ts');

  it('utilise Expo Crypto au lieu de dépendre de globalThis.crypto sous Hermes', () => {
    assert.match(configStore, /import \* as Crypto from 'expo-crypto';/);
    assert.match(configStore, /Crypto\.getRandomValues\(out\)/);
    assert.doesNotMatch(configStore, /const c: any = globalThis\.crypto/);
  });

  it('expose des diagnostics de provisionnement exploitables et non secrets', () => {
    assert.match(provisionClient, /PVN_STORE_FAILED/);
    assert.match(provisionClient, /PVN_NETWORK/);
    assert.match(provisionClient, /PROVISION_MAX_ATTEMPTS = 3/);
    assert.match(provisionClient, /x-sxb-request-id/);
  });

  it('ne relance pas les tickets à chaque rendu du composant Support', () => {
    assert.match(supportScreen, /apiClient\.get\("\/mobile\/support\/tickets"\)/);
    assert.match(supportScreen, /\}, \[language\]\);/);
    assert.doesNotMatch(supportScreen, /\}, \[t\]\);/);
  });

  it('conserve les deux routes support nécessaires à la compatibilité mobile', () => {
    assert.match(mobileRoutes, /router\.get\('\/support\/tickets'/);
    assert.match(mobileRoutes, /router\.post\('\/support\/ticket'/);
    assert.match(mobileRoutes, /router\.post\('\/support\/tickets'/);
  });
});

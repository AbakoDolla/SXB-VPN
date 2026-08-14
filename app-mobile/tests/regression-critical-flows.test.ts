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
import { isCompleteOfflineConfig, validateVpnConfig } from '../services/configValidator';

const XRAY_VLESS_WITH_HTTP_UPSTREAM = {
  protocol: 'singbox',
  dns: { servers: ['tcp+local://129.0.183.251'] },
  inbounds: [{ tag: 'tun-inbound', protocol: 'dokodemo-door', settings: { followRedirect: true } }],
  outbounds: [
    {
      tag: 'VLESS',
      protocol: 'vless',
      settings: { vnext: [{ address: 'megabdwap.tk', port: 443, users: [{ id: 'd3de1a66-2fc8-4f68-a4e8-73929df4664c', encryption: 'none' }] }] },
      streamSettings: { network: 'ws', security: 'tls', tlsSettings: { serverName: 'megabdwap.tk' }, wsSettings: { path: '/', headers: { Host: 'megabdwap.tk' } } },
      proxySettings: { tag: 'http-upstream', transportLayer: true },
    },
    { tag: 'http-upstream', protocol: 'http', settings: { servers: [{ address: '57.144.162.4', port: 8080 }] } },
  ],
};

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

describe('compatibilité Xray/VLESS complète', () => {
  it('accepte et stocke un Xray VLESS avec proxy HTTP sans exiger port à la racine', () => {
    const validation = validateVpnConfig(XRAY_VLESS_WITH_HTTP_UPSTREAM);
    assert.equal(validation.valid, true, validation.errors.join(' | '));
    assert.equal(validation.protocol, 'singbox');
    const completeness = isCompleteOfflineConfig(validation.config);
    assert.equal(completeness.complete, true, `champs manquants : ${completeness.missing.join(', ')}`);
  });
});

describe('garde-fous contre les régressions Android', () => {
  const configStore = source('services/configStore.ts');
  const supportScreen = source('app/support.tsx');
  const provisionClient = source('services/provisionClient.ts');
  const mobileRoutes = source('../server/routes/mobile.ts');
  const vpnContext = source('contexts/VpnContext.tsx');
  const canonicalConfig = source('../server/services/canonical-config.ts');
  const nativeService = source('modules/android-native/SxbVpnService.kt');
  const nativeModule = source('modules/android-native/SxbVpnModule.kt');
  const rootLayout = source('app/_layout.tsx');
  const notificationsScreen = source('app/(tabs)/notifications.tsx');

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

  it('préserve les JSON Xray complets au lieu de les confondre avec sing-box natif', () => {
    assert.match(canonicalConfig, /sourceFormat = isXray \? 'xray-json' : 'singbox-json'/);
    assert.match(canonicalConfig, /o\.settings\?\.vnext !== undefined/);
    assert.match(canonicalConfig, /o\.streamSettings !== undefined/);
  });

  it('sélectionne la configuration demandée et non le dernier abonnement actif', () => {
    assert.match(mobileRoutes, /requestedSubscriptionId/);
    assert.match(mobileRoutes, /clientId: client\.id, id: requestedSubscriptionId/);
    assert.match(vpnContext, /subscriptionId=\$\{encodeURIComponent\(selectedId\)\}/);
    assert.match(vpnContext, /setRemoteConnections\(remote\)/);
  });

  it('retire les profils révoqués et provisionne indépendamment le second profil', () => {
    assert.match(vpnContext, /invalidIds\.map\(id => configStore\.remove\(id\)/);
    assert.match(vpnContext, /provisionAndStore\(remoteTarget\.dataToken, deviceId\)/);
    assert.match(vpnContext, /pendingAutoConnectRef/);
  });

  it('convertit les règles et DNS Xray incompatibles avant le démarrage sing-box', () => {
    assert.match(nativeService, /outboundTag.*outbound/);
    assert.match(nativeService, /ip_cidr/);
    assert.match(nativeService, /xrayDns\.put\("servers", newServers\)/);
  });

  it('convertit le SOCKS Xray et refuse explicitement un outbound Xray inconnu', () => {
    assert.match(nativeService, /"socks" ->/);
    assert.match(nativeService, /outbound Xray non supporté par le moteur/);
  });

  it('préserve les detours et convertit Trojan, Shadowsocks et les paramètres VMess Xray', () => {
    assert.match(nativeService, /fun preserveXrayDetour\(outbound: JSONObject\)/);
    assert.match(nativeService, /"trojan" ->/);
    assert.match(nativeService, /"shadowsocks" ->/);
    assert.match(nativeService, /put\("alter_id", alterId\)/);
    assert.match(nativeService, /outbound Xray Trojan/);
    assert.match(nativeService, /outbound Xray Shadowsocks/);
  });

  it('n’expose plus le contenu du payload ou les hôtes dans les diagnostics natifs', () => {
    assert.doesNotMatch(nativeService, /PAYLOAD_FULL/);
    assert.doesNotMatch(nativeService, /DNS_RESOLVE host=/);
    assert.doesNotMatch(nativeService, /TCP_CONNECTED host=/);
    assert.doesNotMatch(nativeService, /SSH_CONNECTED.*host=\$host/);
    assert.match(nativeService, /PAYLOAD_READY bytes=/);
  });

  it('explique les refus HTTP amont sans confondre le proxy avec une erreur d’import Xray', () => {
    assert.match(nativeService, /HTTP_429_RATE_LIMIT/);
    assert.match(nativeService, /HTTP_404_UPSTREAM/);
    assert.match(nativeService, /val safeMessage = SecurityModule\.maskSensitive\(message\)/);
  });

  it('synchronise les annonces vers un canal Android dédié et dédupliqué', () => {
    assert.match(nativeModule, /SXB_ANNOUNCEMENTS/);
    assert.match(nativeModule, /postAnnouncementNotification/);
    assert.match(nativeModule, /SecurityModule\.maskSensitive\(message\)/);
    assert.match(rootLayout, /syncAnnouncementNotifications/);
    assert.match(notificationsScreen, /READ_NOTIFICATION_IDS_KEY/);
    assert.doesNotMatch(notificationsScreen, /apiClient\.patch\(.*notifications/);
  });

  it('supprime automatiquement les configurations orphelines supprimées du dashboard', () => {
    assert.match(vpnContext, /remoteIds/);
    assert.match(vpnContext, /orphanIds/);
    assert.match(vpnContext, /configStore\.remove\(id\)/);
  });

  it('préserve un profil local lors d’un quota estimé épuisé et ne purge que les révocations explicites', () => {
    assert.match(vpnContext, /c\.status === 'revoked' \|\| c\.status === 'deleted'/);
    assert.match(vpnContext, /profil sécurisé conservé/);
    assert.match(vpnContext, /tentative de connexion quand même \(zéro-rated \/ hors-ligne\)/);
  });

  it('détecte de manière robuste le mode WebSocket vs SSH brut via peeking d’octet après 101', () => {
    assert.match(nativeService, /val firstByte = if \(peekLen > 0\) peekBuf\[0\]\.toInt\(\) and 0xFF else -1/);
    assert.match(nativeService, /if \(firstByte == 'S'\.code\)/);
    assert.match(nativeService, /COSMETIC_101_DETECTED/);
    assert.match(nativeService, /WEBSOCKET_MODE_ACTIVATED/);
    assert.match(nativeService, /WsInputStream\(baseIn, rawOut, onEvent\)/);
  });

  it('gère le ciblage des annonces par identifiant d’appareil (Device ID)', () => {
    const mobileRouteContent = source('../server/routes/mobile.ts');
    assert.match(mobileRouteContent, /targetDeviceId/);
    assert.match(mobileRouteContent, /x-sxb-device-id/);
    const apiClientContent = source('services/apiClient.ts');
    assert.match(apiClientContent, /X-SXB-Device-ID/);
  });
});

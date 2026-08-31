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
import { parseVlessUri, vlessUriToJson } from '../services/vlessUri';
import ProtocolDetector from '../services/protocolDetector';
import { deriveQuota } from '../services/quotaState';

const XRAY_VLESS_D2L = {
  remarks: 'BYPASS',
  log: { loglevel: 'debug' },
  inbounds: [{ tag: 'socks', port: 8080, protocol: 'socks', settings: { auth: 'noauth', udp: true, userLevel: 8 }, sniffing: { enabled: true, destOverride: ['fakedns'], routeOnly: false } }],
  outbounds: [
    {
      tag: 'proxy', protocol: 'vless',
      settings: { vnext: [{ address: 'community.d2l.com', port: 443, users: [{ id: '0e23c86f-be34-43e3-9c06-af4c3e2662d8', level: 8, encryption: 'none' }] }] },
      streamSettings: { network: 'ws', security: 'tls', wsSettings: { path: '/vless', headers: { Host: 'ss.alphaeconet.co.zw' } }, tlsSettings: { allowInsecure: true, serverName: 'ss.alphaeconet.co.zw', show: false } },
      mux: { enabled: true, concurrency: 8, xudpConcurrency: 16, xudpProxyUDP443: 'reject' },
    },
    { tag: 'direct', protocol: 'freedom', settings: { domainStrategy: 'UseIP' }, mux: { enabled: false } },
    { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'http' } }, mux: { enabled: false } },
  ],
  dns: { servers: ['1.1.1.1'], hosts: { 'domain:googleapis.cn': 'googleapis.com', 'dns.alidns.com': ['223.5.5.5', '223.6.6.6'], 'one.one.one.one': ['1.1.1.1', '1.0.0.1'], 'dns.google': ['8.8.8.8', '8.8.4.4'] } },
  routing: { domainStrategy: 'IPIfNonMatch', rules: [{ type: 'field', ip: ['1.1.1.1'], outboundTag: 'proxy', port: '53' }, { type: 'field', ip: ['223.5.5.5'], outboundTag: 'direct', port: '53' }] },
};

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

describe('compatibilité URI VLESS / JSON complète', () => {
  const VLESS_URI = 'vless://0e23c86f-be34-43e3-9c06-af4c3e2662d8@cdn.tribune.com.pk:443?path=%2Fvless&security=tls&encryption=none&host=ss.alphaeconet.co.zw&type=ws&sni=ss.alphaeconet.co.zw#BYPASS';

  it('convertit l’URI VLESS fournie en configuration canonique valide', () => {
    const parsed = parseVlessUri(VLESS_URI);
    assert.equal(parsed.name, 'BYPASS');
    assert.equal(parsed.config.protocol, 'vless');
    assert.equal(parsed.config.host, 'cdn.tribune.com.pk');
    assert.equal(parsed.config.port, 443);
    assert.equal(parsed.config.uuid, '0e23c86f-be34-43e3-9c06-af4c3e2662d8');
    assert.equal(parsed.config.network, 'ws');
    assert.equal(parsed.config.path, '/vless');
    assert.equal(parsed.config.wsHost, 'ss.alphaeconet.co.zw');
    assert.equal(parsed.config.sni, 'ss.alphaeconet.co.zw');
    assert.equal(parsed.config.tls, true);

    const validation = validateVpnConfig(VLESS_URI);
    assert.equal(validation.valid, true, validation.errors.join(' | '));
    assert.equal(validation.protocol, 'vless');
    assert.equal(isCompleteOfflineConfig(validation.config).complete, true);
  });

  it('accepte l’enveloppe HTTP Tweak V2RAY complète en import direct mobile', () => {
    const exported = {
      configs: [{
        name: 'BYPASS',
        v2rayProfile: {
          server: 'community.d2l.com', serverPort: '443',
          password: '0e23c86f-be34-43e3-9c06-af4c3e2662d8', method: 'none',
          network: 'ws', host: 'ss.alphaeconet.co.zw', path: '/vless',
          security: 'tls', sni: 'ss.alphaeconet.co.zw', insecure: true,
        },
      }],
    };
    const validation = validateVpnConfig(exported);
    assert.equal(validation.valid, true, validation.errors.join(' | '));
    assert.equal(validation.protocol, 'vless');
    assert.equal(validation.config?.host, 'community.d2l.com');
    assert.equal(validation.config?.wsHost, 'ss.alphaeconet.co.zw');
    assert.equal(validation.config?.sni, 'ss.alphaeconet.co.zw');
    assert.equal(validation.config?.path, '/vless');
  });

  it('détecte directement une URI et son JSON équivalent', () => {
    const fromUri = ProtocolDetector.detect(VLESS_URI);
    assert.equal(fromUri.protocol, 'vless');
    assert.equal(fromUri.config.host, 'cdn.tribune.com.pk');
    assert.equal(fromUri.config.wsHost, 'ss.alphaeconet.co.zw');

    const fromJson = validateVpnConfig(vlessUriToJson(VLESS_URI));
    assert.equal(fromJson.valid, true, fromJson.errors.join(' | '));
    assert.equal(fromJson.config?.wsHost, 'ss.alphaeconet.co.zw');
  });

  it('accepte le JSON VLESS WS/TLS fourni avec Host, SNI et mux', () => {
    const validation = validateVpnConfig(XRAY_VLESS_D2L);
    assert.equal(validation.valid, true, validation.errors.join(' | '));
    assert.equal(validation.protocol, 'singbox');
    assert.equal(validation.config?.outbounds?.[0]?.streamSettings?.wsSettings?.headers?.Host, 'ss.alphaeconet.co.zw');
    assert.equal(validation.config?.outbounds?.[0]?.streamSettings?.tlsSettings?.serverName, 'ss.alphaeconet.co.zw');
    assert.equal(validation.config?.outbounds?.[0]?.mux?.concurrency, 8);
    assert.equal(isCompleteOfflineConfig(validation.config).complete, true);
  });

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
  const authContext = source('contexts/AuthContext.tsx');
  const supportScreen = source('app/support.tsx');
  const provisionClient = source('services/provisionClient.ts');
  const mobileRoutes = source('../server/routes/mobile.ts');
  const vpnContext = source('contexts/VpnContext.tsx');
  const canonicalConfig = source('../server/services/canonical-config.ts');
  const nativeService = source('modules/android-native/SxbVpnService.kt');
  const activateScreen = source('app/activate.tsx');
  const planScreen = source('app/plan.tsx');
  const nativeModule = source('modules/android-native/SxbVpnModule.kt');
  const nativeLogger = source('modules/android-native/SxbSecureLogger.kt');
  const securityModule = source('modules/android-native/SecurityModule.kt');
  const trafficManager = source('modules/android-native/TrafficStatsManager.kt');
  const rootLayout = source('app/_layout.tsx');
  const notificationsScreen = source('app/(tabs)/notifications.tsx');
  const dashboardProfiles = source('../artifacts/sxb-dashboard/src/components/VpnProfilesView.tsx');
  const transportProbe = source('../server/services/transport-probe.ts');
  const provisionRoutes = source('../server/routes/provision.ts');
  const rbacRoutes = source('../server/routes/rbac.ts');
  const authMiddleware = source('../server/middleware/auth.ts');
  const clientRoutes = source('../server/routes/clients.ts');
  const offlineStorage = source('services/offlineStorage.ts');
  const rbacView = source('../artifacts/sxb-dashboard/src/components/RBACView.tsx');
  const announcementsView = source('../artifacts/sxb-dashboard/src/components/AnnouncementsView.tsx');
  const appUpdateRoutes = source('../server/routes/app-updates.ts');
  const appUpdateView = source('../artifacts/sxb-dashboard/src/components/AppUpdatesView.tsx');
  const updatePrompt = source('components/UpdatePrompt.tsx');
  const notificationUpdateScreen = source('app/(tabs)/notifications.tsx');
  const nativeModuleSource = source('modules/android-native/SxbVpnModule.kt');

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

  it('active un token SXB-DATA via le provisionnement lié à l’appareil', () => {
    assert.match(authContext, /normalized\.startsWith\('SXB-DATA-'\)/);
    assert.match(authContext, /provisionAndStore\(normalized, did\)/);
    assert.match(authContext, /\/mobile\/me\?subscriptionId=/);
  });

  it('refuse le provisionnement d’une souscription révoquée ou suspendue', () => {
    assert.match(provisionRoutes, /sub\.status === 'revoked'/);
    assert.match(provisionRoutes, /sub\.status === 'suspended'/);
    assert.match(provisionRoutes, /sub\.status === 'exhausted'/);
    assert.match(provisionRoutes, /status: 'expired'/);
    assert.match(mobileRoutes, /subscriptionState === 'active'/);
  });

  it('autorise l’écriture RBAC au SUPER_ADMIN et applique réellement les permissions', () => {
    assert.match(rbacRoutes, /requireRole\(\["SUPER_ADMIN"\]\)/);
    assert.doesNotMatch(rbacRoutes, /requireRole\(\["SUPER_ADMIN", "ADMIN"\]\)/);
    assert.match(authMiddleware, /const hasPermission = req\.user\.permissions\.includes\(permissionName\)/);
    assert.doesNotMatch(authMiddleware, /role === "ADMIN" \|\| req\.user\.role === "SUPER_ADMIN"/);
    assert.match(rbacView, /currentUserRole === UserRole\.SUPER_ADMIN/);
    assert.match(rbacView, /min-w-\[780px\]/);
  });

  it('sélectionne un appareil réel pour les annonces et utilise un canal sonore versionné', () => {
    assert.match(announcementsView, /fetchDevices\(\)/);
    assert.match(announcementsView, /Tous les appareils actifs/);
    assert.match(announcementsView, /device\.deviceId/);
    assert.match(nativeModuleSource, /SXB_ANNOUNCEMENTS_V2/);
    assert.match(nativeModuleSource, /setSound\(soundUri, audioAttributes\)/);
  });

  it('publie les mises à jour uniquement par SUPER_ADMIN et cible des appareils activés', () => {
    assert.match(appUpdateRoutes, /SUPER_ADMIN_ONLY/);
    assert.match(appUpdateRoutes, /isActivatedDevice\(deviceId\)/);
    assert.match(appUpdateRoutes, /targetDeviceIds/);
    assert.match(appUpdateView, /Publier et distribuer/);
    assert.match(appUpdateView, /SUPER_ADMIN/);
    assert.match(appUpdateView, /activeDevices/);
  });

  it('affiche un bouton de téléchargement direct dans le mobile', () => {
    assert.match(updatePrompt, /\/api\/mobile\/notifications/);
    assert.match(updatePrompt, /downloadAndInstallAppUpdate/);
    assert.match(notificationUpdateScreen, /downloadAndInstallAppUpdate/);
    assert.match(notificationUpdateScreen, /update_download/);
    assert.match(mobileRoutes, /actionType: 'download_app_update'/);
  });

  it('invalide immédiatement les comptes suspendus ou supprimés', () => {
    assert.match(authMiddleware, /vpnClient\.findFirst/);
    assert.match(authMiddleware, /mobileClientUsable/);
    assert.match(clientRoutes, /syncClientAccessState\(id, 'suspended'\)/);
    assert.match(clientRoutes, /syncClientAccessState\(id, 'deleted'\)/);
    assert.match(mobileRoutes, /errors\.mobile\.account_blocked/);
    assert.match(vpnContext, /invalidateRemoteAccess/);
    assert.match(vpnContext, /setInterval\(\(\) => \{ void verifyRemoteAccess\(\); \}, 10_000\)/);
    assert.match(vpnContext, /clearAllOfflineData/);
    assert.match(rootLayout, /router\.replace\('\/activate'\)/);
    assert.match(offlineStorage, /configStore\.clearAll\(\)/);
  });

  it('protège le cycle Foreground Android contre la désynchronisation', () => {
    assert.match(nativeService, /foregroundStarted = AtomicBoolean\(false\)/);
    assert.match(nativeService, /foregroundStarted\.set\(true\)/);
    assert.match(nativeService, /FOREGROUND_REQUIRED/);
    assert.match(nativeService, /return START_STICKY/);
    assert.match(nativeService, /override fun onTaskRemoved/);
    assert.match(nativeService, /TASK_REMOVED — service Foreground conservé/);
  });

  it('ne relance pas les tickets à chaque rendu du composant Support', () => {
    assert.match(supportScreen, /apiClient\.get\("\/mobile\/support\/tickets"\)/);
    assert.match(supportScreen, /\}, \[language\]\);/);
    assert.doesNotMatch(supportScreen, /\}, \[t\]\);/);
  });

  it('renvoie à Historique les champs créés par l’écran mobile', () => {
    assert.match(mobileRoutes, /description: log\.action/);
    assert.match(mobileRoutes, /createdAt: log\.timestamp\.toISOString\(\)/);
    assert.match(mobileRoutes, /status: historyStatus/);
    assert.doesNotMatch(mobileRoutes, /timestamp: log\.timestamp\.toISOString\(\)/);
  });

  it('conserve les deux routes support nécessaires à la compatibilité mobile', () => {
    assert.match(mobileRoutes, /router\.get\('\/support\/tickets'/);
    assert.match(mobileRoutes, /router\.post\('\/support\/ticket'/);
    assert.match(mobileRoutes, /router\.post\('\/support\/tickets'/);
  });

  it('traduit les JSON Xray et répare les profils historiques avant libbox', () => {
    assert.match(canonicalConfig, /sourceFormat = 'xray-json'/);
    assert.match(canonicalConfig, /translateXrayToSingbox\(obj\)/);
    assert.match(canonicalConfig, /engineConfigFromCanonical/);
    assert.match(canonicalConfig, /normalizeSingboxTransportCompatibility/);
    assert.match(canonicalConfig, /hasXrayMarkers\(obj\)/);
    assert.match(canonicalConfig, /isSingboxNativeJson\(obj\)/);
  });

  it('sélectionne la configuration demandée et non le dernier abonnement actif', () => {
    assert.match(mobileRoutes, /requestedSubscriptionId/);
    assert.match(mobileRoutes, /selectMobileSubscription\(client, requestedSubscriptionId\)/);
    assert.match(mobileRoutes, /subscriptionId/);
    assert.match(vpnContext, /subscriptionId=\$\{encodeURIComponent\(selectedId\)\}/);
    assert.match(vpnContext, /setRemoteConnections\(remote\)/);
  });

  it('ne déclare pas épuisé le quota réel de la souscription active', () => {
    const quota = deriveQuota({ totalBytes: 512 * 1024 * 1024, usedBytes: 219624, expiresAt: '2099-01-01T00:00:00.000Z' });
    assert.equal(quota.isExhausted, false);
    assert.equal(quota.remainingBytes, 512 * 1024 * 1024 - 219624);
  });

  it('retire les profils révoqués et provisionne indépendamment le second profil', () => {
    assert.match(vpnContext, /invalidIds\.map\(id => configStore\.remove\(id\)/);
    assert.match(vpnContext, /provisionAndStore\(remoteTarget\.dataToken, deviceId\)/);
    assert.match(vpnContext, /pendingAutoConnectRef/);
  });

  it('utilise le detour réel pour le DNS de secours des profils importés', () => {
    assert.match(nativeService, /defaultDnsObject\(detourTag: String = "proxy"\)/);
    assert.match(nativeService, /defaultDnsObject\(mainTag \?: "proxy"\)/);
    assert.match(nativeService, /https:\/\/1\.1\.1\.1\/dns-query/);
  });

  it('convertit les règles et DNS Xray incompatibles avant le démarrage sing-box', () => {
    assert.match(nativeService, /outboundTag.*outbound/);
    assert.match(nativeService, /ip_cidr/);
    assert.match(nativeService, /put\("dns", normalizedDns\)/);
    assert.match(nativeService, /XRAY_DNS_ROUTE_IGNORED port=53/);
    assert.match(nativeService, /SINGBOX_DNS_PORT_RULE_IGNORED port=53/);
    assert.match(nativeService, /cfg\.optJSONObject\("route"\)\?\.optJSONArray\("rules"\)/);
    assert.match(nativeService, /sourcePort\.split\(',', '-', ' '\)/);
    assert.match(nativeService, /queryStrategy\.lowercase\(Locale\.ROOT\)/);
    assert.ok(nativeService.includes('replace("tcp+local://", "tcp://")'));
    assert.match(nativeService, /XRAY_VLESS_ENCRYPTION_UNSUPPORTED/);
    assert.match(nativeService, /stripUnsupportedSingBoxVlessFields/);
    assert.match(nativeService, /SINGBOX_VLESS_ENCRYPTION_REMOVED/);
    assert.doesNotMatch(nativeService, /if \(proto == "vless"\) put\("encryption", encryption\)/);
  });

  it('prend en charge le fingerprint uTLS (chrome, etc.) dans les configurations Xray converties', () => {
    assert.match(nativeService, /val fp = tlsObj\?\./);
    assert.match(nativeService, /put\("utls"/);
    assert.match(nativeService, /put\("fingerprint", fp\)/);
  });

  it('route les inboundTag Xray vers l’inbound TUN Android réel et préserve le detour HTTP', () => {
    assert.match(nativeService, /l'inbound Android réel créé par openTun\(\) est "tun-in"/);
    assert.match(nativeService, /ib == "tun-inbound".*newInbounds\.put\("tun-in"\)/);
    assert.match(nativeService, /proxySettings\?\.optString\("tag", ""\)/);
    assert.match(nativeService, /outbound\.put\("detour", proxyTag\)/);
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

  it('garde le masquage par défaut et expose un diagnostic réseau explicite sans mots de passe', () => {
    assert.match(nativeLogger, /diagnosticEnabled/);
    assert.match(nativeLogger, /setDiagnosticEnabled/);
    assert.match(nativeLogger, /DIAGNOSTIC_TTL_MS/);
    assert.match(nativeLogger, /KEY_VERBOSE_UNTIL/);
    assert.match(nativeModule, /setDiagnosticLogging/);
    assert.match(nativeModule, /getDiagnosticLogging/);
    assert.match(nativeService, /PAYLOAD_FULL_BEGIN/);
    assert.match(nativeService, /SERVER_RESPONSE_FULL_BEGIN/);
    assert.match(nativeService, /if \(SxbSecureLogger\.isDiagnosticEnabled\(\)\)/);
    assert.match(nativeService, /maskCredentialsOnly/);
    assert.match(securityModule, /password/);
    assert.match(securityModule, /redacted/);
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

  it('ne court-circuite pas un CONNECT compatible avec HTTP 101', () => {
    assert.ok(nativeService.includes('val httpTunnelCompatible = response.contains("101") || isConnect'));
    assert.ok(nativeService.includes('!(isConnectPayload && httpTunnelCompatible)'));
    assert.ok(nativeService.includes('reason=connect_payload'));
  });

  it('réserve WebSocket aux vrais handshakes et donne priorité au CONNECT brut', () => {
    const wsBranch = nativeService.indexOf('isWs ->');
    const connectPayloadBranch = nativeService.indexOf('isConnectPayload ->');
    assert.ok(wsBranch >= 0, 'branche WebSocket absente');
    assert.ok(connectPayloadBranch >= 0, 'branche CONNECT absente');
    assert.ok(connectPayloadBranch < wsBranch, 'CONNECT doit précéder WebSocket');
    assert.ok(nativeService.includes('hasWsUpgradeHeader'));
    assert.ok(nativeService.includes('hasWsKey'));
    assert.ok(nativeService.includes('!connectPayload'));
    assert.ok(nativeService.includes('reason=connect_payload'));
  });

  it('prépare le descripteur réseau avant de protéger les sockets SSH', () => {
    assert.ok(nativeService.includes('rawSocket.bind(null)'));
    assert.ok(nativeService.includes('protectSocket(rawSocket)'));
    assert.ok(nativeService.includes('bind(null)'));
    assert.ok(nativeService.includes('protectSocket(this)'));
    assert.ok(nativeService.includes('SSH_SOCKET_PROTECTED result=$protectedOk fd_ready=$fdReady'));
  });

  it('réinitialise l’UI sur un événement natif disconnected même après un échec de tentative', () => {
    assert.match(vpnContext, /s === 'disconnected'[\s\S]{0,260}setIsConnected\(false\)[\s\S]{0,120}setIsConnecting\(false\)/);
  });

  it('mesure les octets sur l’interface TUN et n’ajoute pas le relais SSH', () => {
    assert.match(nativeService, /trafficManager\.attachTunInterface\(tunInterfaceName\)/);
    assert.match(nativeService, /"tunAttached"\s+to if \(trafficManager\.hasTunCounters\(\)\)/);
    assert.match(nativeModule, /putBoolean\("tunAttached"/);
    assert.doesNotMatch(nativeService, /"uploadBytes"\s+to \(stats\.uploadBytes\s*\+\s*uploadBytes\.get\(\)\)/);
    assert.match(trafficManager, /readTunCounters/);
    assert.match(trafficManager, /sys\/class\/net/);
    assert.match(vpnContext, /deviceId: deviceId \|\| undefined/);
    assert.match(mobileRoutes, /deviceId: z\.string\(\)\.min\(5\)\.optional\(\)/);
    assert.match(mobileRoutes, /deviceId: deviceId \|\| null/);
  });

  it('invalide le watchdog et ignore un événement connected tardif après annulation', () => {
    assert.ok(vpnContext.includes('90_000'));
    assert.ok(vpnContext.includes('Délai dépassé (90s)'));
    assert.match(vpnContext, /stopWatchdog\(\);[\s\S]{0,120}setVpnState\('disconnected'\)/);
    assert.match(vpnContext, /stopWatchdog\(\);[\s\S]{0,120}setVpnState\('error'\)/);
    assert.match(vpnContext, /acceptNativeConnectedRef/);
    assert.ok(vpnContext.includes('attemptId !== connectionAttemptRef.current'));
    assert.ok(vpnContext.includes('Événement connecté tardif ignoré'));
    assert.ok(vpnContext.includes('startWatchdog(`STEP_3_NATIVE_CALLED proto=${engineProtocol}`, attemptId)'));
  });

  it('expose une trace séquencée du transport avec diagnostic opt-in et secrets protégés', () => {
    assert.ok(nativeService.includes('[SXB_TRACE]'));
    assert.ok(nativeService.includes('stage=SOCKET_PROTECT'));
    assert.ok(nativeService.includes('stage=DNS_RESOLVE'));
    assert.ok(nativeService.includes('stage=TCP_CONNECTED'));
    assert.ok(nativeService.includes('stage=PAYLOAD_NORMALIZED'));
    assert.ok(nativeService.includes('stage=HTTP_HEADERS'));
    assert.ok(nativeService.includes('stage=MODE_CLASSIFIED'));
    assert.ok(nativeService.includes('stage=TRANSPORT_SELECTED'));
    assert.ok(nativeService.includes('stage=SSH_BANNER_WAIT'));
    assert.ok(nativeService.includes('trace("TUN_CREATE_START"'));
    assert.ok(nativeService.includes('trace("TUN_CREATED"'));
    assert.ok(nativeService.includes('trace("CLEANUP_COMPLETE"'));
    assert.match(nativeService, /PAYLOAD_FULL_BEGIN/);
    assert.match(nativeService, /SxbSecureLogger\.isDiagnosticEnabled\(\)/);
    assert.match(nativeService, /maskCredentialsOnly/);
  });

  it('mappe honnêtement les réponses HTTP sans accuser le forfait sans preuve', () => {
    assert.ok(nativeService.includes('val errorCode = if (portal) "CAPTIVE_PORTAL" else "TUNNEL_REFUSED"'));
    assert.ok(nativeService.includes('throw java.io.IOException("$errorCode'));
    assert.ok(nativeService.includes('lower.contains("captive_portal")'));
    assert.ok(nativeService.includes('lower.contains("tunnel_refused")'));
    assert.ok(nativeService.includes("Le serveur n'a pas ouvert de tunnel"));
    assert.ok(nativeService.includes('proof=$portal'));
  });

  it('propage les timeouts de lecture WebSocket vers JSch', () => {
    assert.ok(nativeService.includes('catch (e: SocketTimeoutException)'));
    assert.ok(nativeService.includes('timeout_propagated=true'));
    assert.ok(nativeService.includes('throw e'));
  });

  it('T-E1 ordonne la ladder raw, TLS raw, TLS WS puis WS plaintext', () => {
    const raw = nativeService.indexOf('SxbTransportStrategy("raw"');
    const tlsRaw = nativeService.indexOf('SshTransportStrategy("tls_raw"');
    const tlsWs = nativeService.indexOf('SshTransportStrategy("tls_ws"');
    const ws = nativeService.indexOf('SshTransportStrategy("ws"');
    assert.ok(tlsRaw >= 0 && tlsWs >= 0 && ws >= 0, 'stratégies ladder absentes');
    assert.ok(raw < tlsRaw || raw < 0, 'raw doit rester le premier mode quand TLS est désactivé');
    assert.ok(tlsRaw < tlsWs && tlsWs < ws, 'ordre de la ladder incorrect');
    assert.ok(nativeService.includes('candidate.connect(12_000)'));
  });

  it('T-E2 persiste et relit le mode de transport gagnant par configuration', () => {
    assert.ok(nativeService.includes('@sxb_transport_mode_'));
    assert.ok(nativeService.includes('TRANSPORT_MODE_CACHED'));
    assert.ok(nativeService.includes('putString(cacheKey, strategy.mode)'));
    assert.ok(nativeService.includes('if (cachedStrategy != null) listOf(cachedStrategy)'));
  });

  it('T-E3 verrouille une bannière SSH réussie et ne poursuit pas la ladder', () => {
    assert.ok(nativeService.includes('results[strategy.mode] = "banner_ok"'));
    assert.ok(nativeService.includes('selectedStrategy = strategy'));
    assert.ok(nativeService.includes('break'));
    assert.ok(nativeService.includes('isAuthFailure(attemptError)'));
  });

  it('T-E4 produit SSH_MODE_UNKNOWN avec les quatre résultats et jamais CAPTIVE_PORTAL', () => {
    assert.ok(nativeService.includes('SSH_MODE_UNKNOWN $aggregate'));
    assert.ok(nativeService.includes('allStrategies.joinToString'));
    assert.ok(nativeService.includes('lower.contains("ssh_mode_unknown")'));
    assert.ok(nativeService.includes('msg.contains("SSH_MODE_UNKNOWN")'));
  });

  it('sing-box : une configuration invalide est classée CONFIG_INVALID sans boucle auto-reconnect', () => {
    assert.ok(nativeService.includes('lower.contains("decode config")'));
    assert.ok(nativeService.includes('lower.contains("cannot unmarshal")'));
    assert.ok(nativeService.includes('lower.contains("duplicate outbound")'));
    assert.ok(nativeService.includes('"CONFIG_INVALID"'));
    assert.ok(nativeService.includes('code != "CONFIG_INVALID"'));
  });

  it('sing-box : normalise transport.host et déduplique les profils hors ligne hérités', () => {
    assert.ok(nativeService.includes('normalizeRawSingBoxCompatibility'));
    assert.ok(nativeService.includes('transport.has("host")'));
    assert.ok(nativeService.includes('transport.remove("host")'));
    assert.ok(nativeService.includes('SINGBOX_WS_HOST_NORMALIZED'));
    assert.ok(nativeService.includes('HashMap<String, JSONObject>()'));
  });

  it('préserve le payload complet et ignore seulement une ellipse de copier-coller', () => {
    assert.ok(nativeService.includes('placeholder_removed=${rawPayload.contains("…") || rawPayload.contains("...")}'));
    assert.ok(nativeService.includes('.replace("…", "")'));
    assert.ok(nativeService.includes('Regex("\\\\.{3,}")'));
    assert.ok(nativeService.includes('joinToString("\\r\\n") + "\\r\\n\\r\\n"'));
  });

  it('publie les marqueurs de preuve TUN, VPN et trafic réel', () => {
    assert.ok(nativeService.includes('Interface TUN créée'));
    assert.ok(nativeService.includes('Tunnel établi') || nativeService.includes('VPN connecté'));
    assert.ok(nativeService.includes('uploadBytes') || nativeService.includes('downloadBytes'));
  });

  it('utilise un seul flux canonique chiffré pour la saisie manuelle et le JSON', () => {
    assert.ok(dashboardProfiles.includes('importConfig: JSON.stringify(manualConfig)'));
    assert.ok(dashboardProfiles.includes('Un payload complet est requis pour SSH+Payload'));
    assert.ok(dashboardProfiles.includes('value={form.payload || \'\'}'));
    assert.ok(dashboardProfiles.includes('Enregistrer et chiffrer'));
  });

  it('affiche les protocoles V2Ray/Xray et conserve le verdict transport_ok', () => {
    assert.ok(dashboardProfiles.includes("'hysteria2', 'tuic'"));
    assert.ok(dashboardProfiles.includes('Validation syntaxique seulement'));
    assert.ok(transportProbe.includes("case 'transport_ok': return 'transport_ok'"));
    assert.ok(transportProbe.includes("case 'unsupported': return 'unsupported'"));
  });

  it('expose un éditeur JSON complet avec formatage, diagnostic et préflight', () => {
    assert.ok(dashboardProfiles.includes('JsonConfigEditor'));
    assert.ok(dashboardProfiles.includes('V2Ray / Xray détecté'));
    assert.ok(dashboardProfiles.includes('Formater'));
    assert.ok(dashboardProfiles.includes('Valider le transport'));
    assert.ok(dashboardProfiles.includes('Configuration JSON V2Ray Xray complète'));
    assert.ok(dashboardProfiles.includes('Saisie manuelle'));
  });

  it('réserve la gestion technique des configurations au dashboard', () => {
    assert.doesNotMatch(activateScreen, /scan_qr|qr-code-outline/);
    assert.doesNotMatch(planScreen, /scan_qr|qr-code-outline|qrBtn/);
    assert.match(activateScreen, /Token d’activation/);
  });

  it('conserve le mux TCP Xray sans traduire les options XUDP en max_connections', () => {
    assert.ok(nativeService.includes('val mux = o.optJSONObject("mux")'));
    assert.ok(nativeService.includes('put("multiplex", JSONObject()'));
    assert.ok(nativeService.includes('put("max_streams", concurrency)'));
    assert.ok(nativeService.includes('XRAY_XUDP_OPTIONS_IGNORED_FOR_TCP_TRANSPORT'));
    assert.doesNotMatch(nativeService, /put\("max_connections", xudpConcurrency\)/);
  });

  it('évite le provisionnement réseau avec une configuration complète hors-ligne', () => {
    assert.ok(vpnContext.includes('hasCompleteOfflineConfig'));
    assert.ok(vpnContext.includes('mode hors-ligne, aucun provisionnement requis'));
    assert.ok(vpnContext.includes('if (!configToUse)'));
  });

  it('rend le handshake JSch interrompable par stopVpn et bloque la publication tardive', () => {
    assert.ok(nativeService.includes('sshSession = session'));
    assert.ok(nativeService.includes('session.connect(30_000)'));
    assert.match(nativeService, /SSH_CONNECT_IGNORED/);
    assert.match(nativeService, /running\.set\(false\)[\s\S]{0,180}failVpn\("SSH_TIMEOUT"/);
    assert.match(nativeService, /LIBBOX_START_IGNORED/);
    assert.ok(nativeService.includes('SSH_ATTEMPT_CANCELLED'));
    assert.ok(nativeService.includes('SINGBOX_ATTEMPT_CANCELLED'));
    assert.ok(nativeService.includes('SINGBOX_RAW_ATTEMPT_CANCELLED'));
  });

  it('gère le ciblage des annonces par identifiant d’appareil (Device ID)', () => {
    const mobileRouteContent = source('../server/routes/mobile.ts');
    assert.match(mobileRouteContent, /targetDeviceId/);
    assert.match(mobileRouteContent, /x-sxb-device-id/);
    const apiClientContent = source('services/apiClient.ts');
    assert.match(apiClientContent, /X-SXB-Device-ID/);
  });
});

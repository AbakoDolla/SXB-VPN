import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  bytesToHex,
  decryptAes256Gcm,
  encryptAes256Gcm,
  hexToBytes,
  utf8Decode,
  utf8Encode,
} from '../services/aesGcm';
import { isCompleteOfflineConfig, validateVpnConfig, detectProtocolFromFields } from '../services/configValidator';
import { parseVlessUri, vlessUriToJson } from '../services/vlessUri';
import ProtocolDetector from '../services/protocolDetector';
import { deriveQuota } from '../services/quotaState';
import {
  APP_LOCK_DELAY_MS,
  constantTimeEqual,
  isValidPin,
  shouldLockAfterBackground,
} from '../services/appLockPolicy';
import { activationErrorKey, normalizeActivationToken } from '../services/activationError';

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

function dashboardText(key: string, language: 'fr' | 'en' = 'fr'): string {
  const [namespace, ...parts] = key.split('.');
  let value: unknown = JSON.parse(source(`../artifacts/sxb-dashboard/src/locales/${language}/${namespace}.json`));
  for (const part of parts) {
    assert.ok(value && typeof value === 'object' && part in value, `Missing ${language} translation: ${key}`);
    value = (value as Record<string, unknown>)[part];
  }
  assert.equal(typeof value, 'string', `Translation is not text: ${key}`);
  return value as string;
}

function assertDashboardLabel(component: string, key: string, expected: RegExp) {
  assert.ok(component.includes(key), `The UI must render ${key}`);
  assert.match(dashboardText(key), expected);
  assert.ok(dashboardText(key, 'en').trim(), `Missing English label: ${key}`);
}

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

describe('verrouillage local biométrique et PIN', () => {
  it('valide strictement un PIN numérique de 4 à 8 chiffres', () => {
    assert.equal(isValidPin('1234'), true);
    assert.equal(isValidPin('12345678'), true);
    assert.equal(isValidPin('123'), false);
    assert.equal(isValidPin('123456789'), false);
    assert.equal(isValidPin('12a4'), false);
  });

  describe('erreurs d’activation mobile', () => {
    it('nettoie les caractères de copie sans altérer le token SXB', () => {
      assert.equal(
        normalizeActivationToken('  sxb\u2011user\u200b\u00a01234\u20144567  '),
        'SXB-USER1234-4567',
      );
    });

    it('ne présente jamais un refus 403 générique comme un token expiré', () => {
      assert.equal(activationErrorKey({ response: { status: 403, data: { code: 'FORBIDDEN' } } }), 'activation_forbidden');
      assert.equal(activationErrorKey({ response: { status: 403, data: { code: 'RESELLER_QUOTA_REACHED' } } }), 'activation_quota_reached');
      assert.equal(activationErrorKey({ response: { status: 403, data: { code: 'ACCOUNT_SUSPENDED' } } }), 'error_suspended');
      assert.equal(activationErrorKey({ response: { status: 409, data: { code: 'DEVICE_CLAIMED_BY_ANOTHER_ACCOUNT' } } }), 'activation_device_claimed');
      assert.equal(activationErrorKey({ response: { status: 409, data: { code: 'DEVICE_BOUND' } } }), 'activation_device_claimed');
    });

    it('réserve le message expiré aux réponses qui expriment réellement une expiration', () => {
      assert.equal(activationErrorKey({ response: { status: 410, data: {} } }), 'error_expired_token');
      assert.equal(activationErrorKey({ response: { status: 403, data: { code: 'TOKEN_EXPIRED' } } }), 'error_expired_token');
      assert.equal(activationErrorKey({ response: { status: 403, data: { code: 'RESELLER_EXPIRED' } } }), 'activation_account_expired');
    });

    it('distingue token utilisé, format invalide, serveur et réseau', () => {
      assert.equal(activationErrorKey({ response: { status: 409, data: {} } }), 'token_used');
      assert.equal(activationErrorKey({ response: { status: 422, data: {} } }), 'error_invalid_token');
      assert.equal(activationErrorKey({ response: { status: 503, data: {} } }), 'error_server');
      assert.equal(activationErrorKey(new Error('network')), 'error_no_network');
    });
  });

  it('ne verrouille le retour au premier plan qu’après le délai prévu', () => {
    const backgroundedAt = 1_000;
    assert.equal(
      shouldLockAfterBackground(backgroundedAt, backgroundedAt + APP_LOCK_DELAY_MS - 1),
      false,
    );
    assert.equal(
      shouldLockAfterBackground(backgroundedAt, backgroundedAt + APP_LOCK_DELAY_MS),
      true,
    );
    assert.equal(shouldLockAfterBackground(null, Date.now()), false);
  });

  it('compare les empreintes sans sortie anticipée liée à leur contenu', () => {
    assert.equal(constantTimeEqual('abcdef', 'abcdef'), true);
    assert.equal(constantTimeEqual('abcdef', 'abcdeg'), false);
    assert.equal(constantTimeEqual('short', 'longer'), false);
  });

  it('stocke seulement une empreinte salée du PIN dans SecureStore', () => {
    const stockage = source('services/appLock.ts');
    const reglages = source('app/settings.tsx');

    assert.match(stockage, /Crypto\.getRandomBytesAsync\(32\)/);
    assert.match(stockage, /Crypto\.CryptoDigestAlgorithm\.SHA256/);
    assert.match(stockage, /SecureStore\.setItemAsync\(PIN_CREDENTIAL_KEY/);
    assert.match(stockage, /SecureStore\.WHEN_UNLOCKED_THIS_DEVICE_ONLY/);
    assert.match(stockage, /constantTimeEqual/);
    assert.match(stockage, /decodeLegacyPin/);
    assert.match(stockage, /await storePin\(decodedPin\)/);
    assert.match(stockage, /await AsyncStorage\.removeItem\(LEGACY_PIN_KEY\)/);
    assert.doesNotMatch(stockage, /AsyncStorage\.setItem\(LEGACY_PIN_KEY/);
    assert.doesNotMatch(reglages, /btoa\(pin\)/);
    assert.doesNotMatch(reglages, /AsyncStorage\.setItem\(["']@sxb_pin/);
  });

  it('persiste et renforce le délai après les échecs PIN', () => {
    const stockage = source('services/appLock.ts');
    const contexte = source('contexts/AppLockContext.tsx');

    // Des refs React repartaient à zéro après un force-stop : cinq nouvelles
    // tentatives étaient alors disponibles à chaque redémarrage.
    assert.match(stockage, /PIN_THROTTLE_KEY/);
    assert.match(stockage, /SecureStore\.setItemAsync\(PIN_THROTTLE_KEY/);
    assert.match(stockage, /export async function registerFailedPinAttempt/);
    assert.match(stockage, /PIN_LOCK_BASE_MS \* \(2 \*\* exponent\)/);
    assert.match(stockage, /PIN_LOCK_MAX_MS/);
    assert.match(contexte, /await getPinThrottleState\(\)/);
    assert.match(contexte, /await registerFailedPinAttempt\(now\)/);
    assert.match(contexte, /await clearPinThrottleState\(\)/);
    assert.doesNotMatch(contexte, /failedPinAttemptsRef|pinRetryAtRef/);
  });

  it('exige capacité, enrôlement et succès biométrique avant activation', () => {
    const stockage = source('services/appLock.ts');
    const contexte = source('contexts/AppLockContext.tsx');

    assert.match(stockage, /LocalAuthentication\.hasHardwareAsync\(\)/);
    assert.match(stockage, /LocalAuthentication\.isEnrolledAsync\(\)/);
    assert.match(stockage, /LocalAuthentication\.supportedAuthenticationTypesAsync\(\)/);
    assert.match(stockage, /disableDeviceFallback: true/);
    assert.match(stockage, /biometricsSecurityLevel: "strong"/);
    assert.match(contexte, /if \(!preferencesRef\.current\.pinEnabled\) return "pin_required"/);
    assert.match(contexte, /if \(!capability\.hasHardware\) return "unavailable"/);
    assert.match(contexte, /if \(!capability\.isEnrolled\) return "not_enrolled"/);
    assert.match(contexte, /if \(!result\.success\) return "authentication_failed"/);
  });

  it('verrouille uniquement l’interface et laisse le tunnel VPN monté', () => {
    const contexte = source('contexts/AppLockContext.tsx');
    const barriere = source('components/AppLockGate.tsx');
    const racine = source('app/_layout.tsx');
    const verrou = `${contexte}\n${barriere}`;

    assert.match(contexte, /AppState\.addEventListener\("change"/);
    assert.match(contexte, /shouldLockAfterBackground/);
    assert.match(contexte, /setTimeout\(\(\) =>/);
    assert.match(racine, /<VpnProvider>[\s\S]*<AppLockProvider>[\s\S]*<AppLockGate>/);
    assert.match(barriere, /StyleSheet\.absoluteFillObject/);
    assert.match(barriere, /importantForAccessibility=\{gateVisible \? "no-hide-descendants"/);
    assert.match(barriere, /accessibilityElementsHidden=\{gateVisible\}/);
    assert.doesNotMatch(verrou, /SxbVpnNative|VpnService|disconnect\(|stopVpn|stopService/);
  });

  it('épingle le module natif compatible Expo SDK 54 et son plugin', () => {
    const packageJson = JSON.parse(source('package.json')) as {
      dependencies: Record<string, string>;
    };
    const packageLock = source('package-lock.json');
    const appJson = source('app.json');

    assert.equal(packageJson.dependencies['expo-local-authentication'], '~17.0.9');
    assert.match(packageLock, /"node_modules\/expo-local-authentication"/);
    assert.match(packageLock, /"version": "17\.0\.9"/);
    assert.match(appJson, /"expo-local-authentication"/);
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

  it('importe l’URI VLESS ws+tls du dashboard en distinguant les trois noms d’hôte', () => {
    // Cas réel fourni par l'exploitant : l'adresse TCP, l'en-tête Host et le SNI
    // sont trois valeurs indépendantes. Les confondre produit un profil accepté
    // à l'import mais qui ne monte jamais sur mobile.
    const uri = 'vless://bdebc18f-9f2f-4084-ae1f-210aad4629c2@cdn.tribune.com.pk:443?path=%2Fvless&security=tls&encryption=none&host=net.josefvpn.com&type=ws&sni=net.josefvpn.com#stuff';
    const parsed = parseVlessUri(uri);
    assert.equal(parsed.name, 'stuff');
    assert.equal(parsed.config.host, 'cdn.tribune.com.pk');   // adresse TCP jointe
    assert.equal(parsed.config.wsHost, 'net.josefvpn.com');   // en-tête Host WS
    assert.equal(parsed.config.sni, 'net.josefvpn.com');      // nom TLS présenté
    assert.equal(parsed.config.path, '/vless');
    assert.equal(parsed.config.network, 'ws');
    assert.equal(parsed.config.tls, true);
    assert.equal(parsed.config.uuid, 'bdebc18f-9f2f-4084-ae1f-210aad4629c2');

    const validation = validateVpnConfig(uri);
    assert.equal(validation.valid, true, validation.errors.join(' | '));
    assert.equal(validation.protocol, 'vless');
    assert.equal(isCompleteOfflineConfig(validation.config).complete, true);
    // Le protocole doit être déduit sans champ « protocol » explicite.
    assert.equal(ProtocolDetector.detect(uri).protocol, 'vless');
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
  const identitySession = source('services/identitySession.ts');
  const accessPolicy = source('services/accessPolicy.ts');
  const accessSync = source('services/accessSync.ts');
  const supportScreen = source('app/support.tsx');
  const provisionClient = source('services/provisionClient.ts');
  const mobileRoutes = source('../server/routes/mobile.ts');
  const vpnContext = source('contexts/VpnContext.tsx');
  const canonicalConfig = source('../server/services/canonical-config.ts');
  const xrayTranslate = source('../server/services/xray-translate.ts');
  const nativeService = source('modules/android-native/SxbVpnService.kt');
  const activateScreen = source('app/activate.tsx');
  const planScreen = source('app/plan.tsx');
  const nativeModule = source('modules/android-native/SxbVpnModule.kt');
  const diagnosticsScreen = source('app/diagnostics.tsx');
  const subscriptionRoutes = source('../server/routes/subscriptions.ts');
  const vpnProfileRoutes = source('../server/routes/vpn-profiles.ts');
  const prismaSchema = source('../prisma/schema.prisma');
  const subscriptionsView = source('../artifacts/sxb-dashboard/src/components/SubscriptionsView.tsx');
  const vpnProfilesView = source('../artifacts/sxb-dashboard/src/components/VpnProfilesView.tsx');
  const apiClient = source('../artifacts/sxb-dashboard/src/api/client.ts');
  const devicesRoutes = source('../server/routes/devices.ts');
  const dashboardRoutes = source('../server/routes/dashboard.ts');
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
  const nativePushSource = source('modules/android-native/SxbPushNotifications.kt');
  const nativeFirebaseService = source('modules/android-native/SxbFirebaseMessagingService.kt');
  const nativeFirebaseProvider = source('modules/android-native/SxbFirebaseInitProvider.kt');
  const pushNotificationService = source('services/pushNotifications.ts');
  const fcmService = source('../server/services/fcm.ts');
  const announcementsRoutes = source('../server/routes/announcements.ts');
  const firebasePlugin = source('plugins/withSxbVpn.js');
  const firebaseEnvironment = source('../.env.example');
  const pushMigration = source('../backend/prisma/migrations/20260907050000_add_push_tokens/migration.sql');

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
    assert.match(authContext, /provisionAndStore\(normalized, id\)/);
    assert.match(authContext, /validateIdentitySession\(id, provisioned\.meta\.subscriptionId\)/);
    assert.match(identitySession, /subscriptionId=\$\{encodeURIComponent\(subscriptionId\)\}/);
  });

  it('refuse le provisionnement d’une souscription révoquée ou suspendue', () => {
    assert.match(provisionRoutes, /sub\.status === 'revoked'/);
    assert.match(provisionRoutes, /sub\.status === 'suspended'/);
    assert.match(provisionRoutes, /sub\.status === 'exhausted'/);
    assert.match(provisionRoutes, /status: 'expired'/);
    assert.match(mobileRoutes, /subscriptionState === 'active'/);
  });

  it('autorise l’écriture RBAC au SUPER_ADMIN et applique réellement les permissions', () => {
    assert.match(rbacRoutes, /router\.patch\("\/roles\/:id"[\s\S]{0,160}requireRole\(\["SUPER_ADMIN"\]\)[\s\S]{0,100}requirePermission\("rbac\.manage"\)/);
    assert.doesNotMatch(rbacRoutes, /router\.patch\("\/roles\/:id"[\s\S]{0,160}requireRole\(\["SUPER_ADMIN", "ADMIN"\]\)/);
    assert.match(authMiddleware, /const hasPermission = req\.user\.permissions\.includes\(permissionName\)/);
    assert.doesNotMatch(authMiddleware, /role === "ADMIN" \|\| req\.user\.role === "SUPER_ADMIN"/);
    assert.match(rbacView, /currentUserRole === UserRole\.SUPER_ADMIN/);
    assert.match(rbacView, /min-w-\[780px\]/);
  });

  it('sélectionne un appareil réel pour les annonces et utilise un canal sonore versionné', () => {
    assert.match(announcementsView, /fetchDevices\(\)/);
    assertDashboardLabel(announcementsView, 'operations.announcements.allDevices', /Tous les appareils actifs/);
    assert.match(announcementsView, /device\.deviceId/);
    assert.match(nativePushSource, /SXB_ANNOUNCEMENTS_V2/);
    assert.match(nativePushSource, /setSound\(soundUri, audioAttributes\)/);
  });

  it('publie les mises à jour uniquement par SUPER_ADMIN et cible des appareils activés', () => {
    assert.match(appUpdateRoutes, /SUPER_ADMIN_ONLY/);
    assert.match(appUpdateRoutes, /isActivatedDevice\(deviceId\)/);
    assert.match(appUpdateRoutes, /targetDeviceIds/);
    assertDashboardLabel(appUpdateView, 'operations.updates.publish', /Publier et distribuer/);
    assert.match(appUpdateView, /SUPER_ADMIN/);
    assert.match(appUpdateView, /activeDevices/);
  });

  it('enregistre et désenregistre les jetons FCM avec auth et liaison appareil', () => {
    assert.match(mobileRoutes, /router\.use\(requireAuth\)[\s\S]*router\.post\("\/push-tokens"/);
    assert.match(mobileRoutes, /headerDeviceId !== deviceId/);
    assert.match(mobileRoutes, /userId: req\.user!\.userId,[\s\S]{0,80}deviceId,[\s\S]{0,80}status: "active"/);
    assert.match(mobileRoutes, /pushToken\.upsert/);
    assert.match(mobileRoutes, /router\.delete\("\/push-tokens"/);
    assert.match(prismaSchema, /model PushToken/);
    assert.match(prismaSchema, /@@unique\(\[userId, deviceId\]\)/);
    assert.match(prismaSchema, /token\s+String\s+@unique/);
    assert.match(pushMigration, /CREATE TABLE "push_tokens"/);
    assert.match(pushMigration, /ON DELETE CASCADE/);
  });

  it('désactive explicitement FCM sans credentials et ne simule jamais un envoi', () => {
    assert.match(fcmService, /FIREBASE_SERVICE_ACCOUNT_JSON/);
    assert.match(fcmService, /FIREBASE_PROJECT_ID/);
    assert.match(fcmService, /FIREBASE_CLIENT_EMAIL/);
    assert.match(fcmService, /FIREBASE_PRIVATE_KEY/);
    assert.match(fcmService, /status: "disabled"/);
    assert.match(fcmService, /error: "FCM_NOT_CONFIGURED"/);
    assert.match(fcmService, /firebase\.messaging/);
    assert.match(fcmService, /messages:send/);
    // L'appareil du jeton lui-même doit être actif : « un autre client actif
    // du même revendeur » ne suffit pas à rendre un appareil révoqué éligible.
    assert.match(fcmService, /OR: tokens\.map\(\(entry\) => \(\{ userId: entry\.userId, deviceId: entry\.deviceId \}\)\)/);
    assert.match(fcmService, /tokens = tokens\.filter\(\(entry\) => activePairs\.has/);
    assert.doesNotMatch(fcmService, /data:\s*\{[\s\S]{0,300}apkUrl/);
    assert.doesNotMatch(fcmService, /data:\s*\{[\s\S]{0,300}(vpnHost|serverHost|configuration)/);
    assert.match(announcementsRoutes, /sendAnnouncementPush\(announcement\)/);
    assert.match(announcementsRoutes, /json\(\{ announcement, push \}\)/);
    assert.match(appUpdateRoutes, /sendAppUpdatePush\(update\)/);
    assert.match(appUpdateRoutes, /eligibleDeviceCount:[\s\S]{0,100}push/);
  });

  it('initialise Firebase dynamiquement et compile sans google-services.json', () => {
    assert.match(firebasePlugin, /com\.google\.firebase:firebase-messaging/);
    assert.match(firebasePlugin, /withOptionalFirebaseResources/);
    assert.match(firebasePlugin, /Firebase non configuré — FCM désactivé sans bloquer le build/);
    assert.doesNotMatch(firebasePlugin, /com\.google\.gms\.google-services/);
    assert.match(nativeFirebaseProvider, /ensureFirebaseInitialized/);
    assert.match(nativeFirebaseService, /FirebaseMessagingService/);
    assert.match(nativeFirebaseService, /data\["screen"\] != "notifications"/);
    assert.match(nativePushSource, /sxbvpn:\/\/notifications/);
    assert.match(nativeModuleSource, /fun getPushToken/);
    assert.match(nativeModuleSource, /fun deletePushToken/);
  });

  it('synchronise le jeton uniquement avec la session mobile authentifiée', () => {
    assert.match(pushNotificationService, /apiClient\.post\('\/mobile\/push-tokens'/);
    assert.match(pushNotificationService, /apiClient\.delete\('\/mobile\/push-tokens'/);
    assert.match(rootLayout, /syncPushTokenRegistration\(deviceId\)/);
    assert.match(authContext, /unregisterPushToken\(deviceId\)/);
    assert.match(firebaseEnvironment, /FIREBASE_SERVICE_ACCOUNT_JSON/);
    assert.match(firebaseEnvironment, /EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID/);
    assert.match(firebaseEnvironment, /aucun google-services\.json/);
  });

  it('transmet au moteur tous les paramètres de transport du dashboard', () => {
    // Reality : `pbk`/`sid` étaient parsés par le backend puis perdus avant le
    // moteur, ce qui dégradait silencieusement le profil en TLS simple.
    assert.match(canonicalConfig, /out\.publicKey = pbk/);
    assert.match(nativeService, /realityPublicKey/);
    assert.match(nativeService, /put\("reality", JSONObject\(\)/);
    assert.match(nativeService, /put\("public_key", realityPublicKey\)/);
    assert.match(nativeService, /put\("short_id", realityShortId\)/);

    // ALPN et nom de service gRPC : parsés côté backend ET consommés côté moteur.
    assert.match(canonicalConfig, /out\.alpn = decodeURIComponent\(alpn\)/);
    assert.match(canonicalConfig, /out\.grpcServiceName = decodeURIComponent\(serviceName\)/);
    assert.match(nativeService, /csvToJsonArray\(alpn\)\?\.let \{ put\("alpn", it\) \}/);
    assert.match(nativeService, /grpcServiceName/);

    // VMess : `security` et `alter_id` proviennent du profil, jamais figés.
    assert.match(nativeService, /put\("security", security\.ifEmpty \{ "auto" \}\)/);
    assert.match(nativeService, /put\("alter_id", alterId\)/);

    // Le DNS du profil prime sur celui de l'application.
    assert.match(nativeService, /profileDnsObject\(cfg\.optStringOrNull\("dns", ""\)\)/);
  });

  it('ne confond jamais server, SNI et en-tête Host', () => {
    // §11 — trois valeurs distinctes qui doivent rester indépendantes.
    assert.match(nativeService, /val wsHost\s+= cfg\.optStringOrNull\("wsHost", sni\)/);
    assert.match(nativeService, /put\("headers", JSONObject\(\)\.put\("Host", host\)\)/);
    assert.match(canonicalConfig, /out\.wsHost = decodeURIComponent\(host\)/);
  });

  it('ne déclare pas la connexion établie sur un outbound local', () => {
    // §4 — « established » est journalisé à l'identique par direct/dns/block :
    // s'y fier revenait à simuler la connexion.
    assert.match(nativeService, /isProxyHandshakeProof/);
    assert.match(nativeService, /LOCAL_OUTBOUND_MARKERS/);
    assert.match(nativeService, /PROXY_OUTBOUND_MARKERS/);
    assert.match(nativeService, /outbound\/direct/);
    assert.doesNotMatch(
      nativeService,
      /currentState == "handshaking" &&\s*\n?\s*\(lower\.contains\("established"\)/,
    );
  });

  it('route le DNS et l’exclusion par le bon maillon d’une chaîne proxy', () => {
    // Config chaînée (Xray `proxySettings` → sing-box `detour`) : le trafic entre
    // par l'outbound chiffré (VLESS) puis ressort par l'amont HTTP en clair.
    //
    // `mainTag` est le PREMIER outbound non spécial du tableau, soit l'amont
    // HTTP. L'utiliser pour le DNS envoyait les requêtes en clair par cet amont,
    // hors du tunnel, exposant les domaines visités. Le DNS suit désormais
    // `route.final`, et la tête de chaîne est identifiée comme l'outbound qui
    // n'est cité en `detour` par aucun autre.
    assert.match(nativeService, /defaultDnsObject\(finalTag\)/);
    assert.match(nativeService, /val detourTargets = HashSet<String>\(\)/);
    assert.match(nativeService, /if \(tag\.isEmpty\(\) \|\| tag in detourTargets\) continue/);
    // L'exclusion anti-boucle doit viser le serveur du BOUT de la chaîne :
    // c'est lui que le socket physique contacte réellement.
    assert.match(nativeService, /chainEndServer/);
    assert.match(nativeService, /if \(chainEndServer\.isNotBlank\(\)\) mainServer = chainEndServer/);
    // Le traducteur backend conserve les en-têtes personnalisés de l'amont.
    assert.match(canonicalConfig, /translateXrayToSingbox|hasXrayMarkers/);
    assert.match(xrayTranslate, /httpOut\.headers = headers/);
    assert.match(xrayTranslate, /out\.detour = tag/);
  });

  it('affiche un bouton de téléchargement direct dans le mobile', () => {
    assert.match(updatePrompt, /\/api\/mobile\/notifications/);
    assert.match(updatePrompt, /downloadAndInstallAppUpdate/);
    assert.match(notificationUpdateScreen, /downloadAndInstallAppUpdate/);
    assert.match(notificationUpdateScreen, /update_download/);
    assert.match(mobileRoutes, /actionType: 'download_app_update'/);
  });

  it('bloque les appareils suspendus ou supprimés sans invalider leur identité', () => {
    assert.match(authContext, /deviceAccess: selectDeviceAccess\(access\.authority\)/);
    assert.match(vpnContext, /stop: stopForAccess/);
    assert.match(accessSync, /blocksDevice\(deviceAccess\(authority\)\)/);
    assert.match(accessSync, /currentRuntime\.stop\(\)/);
    assert.match(rootLayout, /accessRedirect\(isAuthenticated, accessReady, deviceAccess/);
    assert.match(nativeService, /restartAccessObserver/);
    assert.doesNotMatch(vpnContext, /invalidateRemoteAccess|clearAllOfflineData|verifyRemoteAccess/);
    assert.match(identitySession, /isInvalidSession\(error\)/);
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
    assert.match(vpnContext, /configStore\.get\(selectedId\)/);
    assert.match(vpnContext, /setRemoteConnections\(remote\)/);
  });

  it('ne déclare pas épuisé le quota réel de la souscription active', () => {
    const quota = deriveQuota({ totalBytes: 512 * 1024 * 1024, usedBytes: 219624, expiresAt: '2099-01-01T00:00:00.000Z' });
    assert.equal(quota.isExhausted, false);
    assert.equal(quota.remainingBytes, 512 * 1024 * 1024 - 219624);
  });

  it('retire les profils révoqués et provisionne indépendamment le second profil', () => {
    assert.match(accessSync, /configStore\.remove\(entry\.configId\)/);
    assert.match(accessSync, /await reconcileAccess\(\)/);
    assert.match(accessSync, /provisionAndStore\(entry\.dataToken, current\.deviceId\)/);
    assert.match(vpnContext, /provisionAndStore\(remoteTarget\.dataToken, deviceId\)/);
    assert.match(vpnContext, /pendingAutoConnectRef/);
  });

  it('utilise le detour réel pour le DNS de secours des profils importés', () => {
    assert.match(nativeService, /defaultDnsObject\(detourTag: String = "proxy"\)/);
    // Le DNS de secours suivait `mainTag`, c'est-à-dire le PREMIER outbound non
    // spécial. Sur une chaîne (Xray `proxySettings` → sing-box `detour`), c'est
    // l'amont HTTP en clair, pas le tunnel : les requêtes DNS sortaient donc
    // hors du tunnel. Il suit désormais `route.final`.
    assert.match(nativeService, /defaultDnsObject\(finalTag\)/);
    assert.doesNotMatch(nativeService, /defaultDnsObject\(mainTag \?: "proxy"\)/);
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
    assert.match(accessPolicy, /if \(managedProfile\(profile\)\)/);
    assert.match(accessPolicy, /!minimalDeviceSnapshot && !snapshot\.subscriptions\.some/);
    assert.match(accessSync, /configStore\.remove\(entry\.configId\)/);
  });

  it('préserve un profil local lors d’un quota estimé épuisé et ne purge que les révocations explicites', () => {
    assert.match(accessSync, /restriction\?\.status === 'revoked' \|\| restriction\?\.status === 'deleted'/);
    assert.match(accessPolicy, /CONFIG_EXPIRED/);
    assert.doesNotMatch(vpnContext, /purgeExpired/);
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
    assert.ok(nativeService.includes('candidate.connect(minOf(timeoutMs, 12_000))'));
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
    // Les erreurs définitives sont désormais regroupées : CONFIG_INVALID (schéma
    // illisible) et CONFIG_UNSUPPORTED (capacité absente du moteur) ne doivent
    // ni l'une ni l'autre déclencher une boucle de reconnexion.
    assert.ok(nativeService.includes('code !in PERMANENT_ERROR_CODES'));
    assert.ok(nativeService.includes('PERMANENT_ERROR_CODES = setOf("CONFIG_INVALID", "CONFIG_UNSUPPORTED")'));
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
    assertDashboardLabel(dashboardProfiles, 'configurations.ui.payloadRequired', /Un payload complet est requis pour SSH\+Payload/);
    assert.ok(dashboardProfiles.includes('value={form.payload || \'\'}'));
    assertDashboardLabel(dashboardProfiles, 'configurations.ui.saveEncrypt', /Enregistrer et chiffrer/);
  });

  it('affiche les protocoles V2Ray/Xray et conserve le verdict transport_ok', () => {
    assert.ok(dashboardProfiles.includes("'hysteria2', 'tuic'"));
    assertDashboardLabel(dashboardProfiles, 'configurations.ui.syntaxOnly', /Validation syntaxique seulement/);
    assert.ok(transportProbe.includes("case 'transport_ok': return 'transport_ok'"));
    assert.ok(transportProbe.includes("case 'unsupported': return 'unsupported'"));
  });

  it('expose un éditeur JSON complet avec formatage, diagnostic et préflight', () => {
    assert.ok(dashboardProfiles.includes('JsonConfigEditor'));
    assertDashboardLabel(dashboardProfiles, 'configurations.ui.xrayDetected', /V2Ray \/ Xray détecté/);
    assertDashboardLabel(dashboardProfiles, 'configurations.editor.protocolDetected', /détecté/);
    assertDashboardLabel(dashboardProfiles, 'configurations.ui.format', /Formater/);
    assertDashboardLabel(dashboardProfiles, 'configurations.ui.testTransport', /Valider le transport/);
    assertDashboardLabel(dashboardProfiles, 'configurations.ui.editorLabel', /Configuration JSON V2Ray Xray complète/);
    assertDashboardLabel(dashboardProfiles, 'configurations.ui.manual', /Saisie manuelle/);
  });

  it('accepte les URI de partage dans l’éditeur d’import du dashboard', () => {
    // L'éditeur ne faisait qu'un JSON.parse : une URI vless:// était étiquetée
    // « JSON invalide » et désactivait le bouton de préflight, alors que le
    // backend (parseImportedConfig) la gère depuis toujours.
    assert.ok(dashboardProfiles.includes('SHARE_URI_SCHEMES'));
    assert.ok(dashboardProfiles.includes('inspectShareUri'));
    for (const scheme of ['vless', 'vmess', 'trojan', 'ss', 'hysteria2|hy2', 'tuic']) {
      assert.ok(
        dashboardProfiles.includes(`^(${scheme}):\\/\\/`) || dashboardProfiles.includes(`^${scheme}:\\/\\/`),
        `schéma d'URI non reconnu par l'éditeur : ${scheme}`,
      );
    }
    // Une URI reste non formatable en JSON : les boutons doivent se désactiver.
    assert.ok(dashboardProfiles.includes('!value.trim() || info.isUri'));
    assert.doesNotMatch(dashboardProfiles, /label: 'JSON invalide'/);
  });

  it('expose l’en-tête Host WebSocket dans la saisie manuelle du dashboard', () => {
    // Sans ce champ, un profil ws saisi à la main partait avec le SNI en guise
    // d'en-tête Host — silencieux, et faux dès que le fournisseur les dissocie.
    assertDashboardLabel(dashboardProfiles, 'configurations.ui.wsHost', /Host \(en-tête WebSocket\)/);
    assert.ok(dashboardProfiles.includes("f('wsHost', e.target.value)"));
    assert.ok(dashboardProfiles.includes('wsHost: legacyForm.wsHost.trim() || undefined'));
  });

  it('sonde réellement le transport WebSocket des proxys VLESS/VMess/Trojan', () => {
    // Ces protocoles étaient classés « non sondables », donc importés sans
    // aucune vérification de transport.
    assert.ok(transportProbe.includes('probeWebsocketUpgrade'));
    assert.ok(transportProbe.includes('const isWsProxy'));
    assert.match(transportProbe, /\['vless', 'vmess', 'trojan'\]\.includes\(proto\)/);
    // L'en-tête Host suit wsHost puis le SNI, jamais l'adresse TCP en premier.
    assert.ok(transportProbe.includes('canonical.wsHost || canonical.sni || host'));
    assert.ok(transportProbe.includes("'Sec-WebSocket-Version: 13\\r\\n'"));
    // Le préflight ne doit jamais rejeter : un endpoint peut être masqué.
    assert.doesNotMatch(transportProbe, /if \(code === 404\) return finish\('invalid'/);
  });

  it('rend la main dès la fin des en-têtes HTTP au lieu d’attendre le délai', () => {
    // La lecture attendait systématiquement l'expiration du timeout : un
    // préflight prenait ~13 s pour une réponse arrivée en 200 ms.
    assert.ok(transportProbe.includes('HTTP_HEAD_COMPLETE'));
    assert.ok(transportProbe.includes('stopWhen?: (buf: Buffer) => boolean'));
    assert.ok(transportProbe.includes('readUpTo(sock, 8192, timeoutMs, HTTP_HEAD_COMPLETE)'));
  });

  it('déduit le protocole moteur de la config au lieu de supposer VLESS', () => {
    // Le repli était « vless » en dur : une config SSH sans champ protocol
    // partait au constructeur sing-box et échouait sans diagnostic utile.
    assert.ok(vpnContext.includes('detectProtocolFromFields(configToUse)'));
    assert.doesNotMatch(vpnContext, /\(configToUse\.protocol \|\| selectedProtocol \|\| 'vless'\)/);

    // La détection couvre chaque protocole que le dispatch natif sait traiter.
    assert.equal(detectProtocolFromFields({ protocol: 'vless', host: 'a', port: 443, uuid: 'u' }), 'vless');
    assert.equal(detectProtocolFromFields({ username: 'root', password: 'x' }), 'ssh');
    assert.equal(detectProtocolFromFields({ username: 'root', payload: 'GET / HTTP/1.1' }), 'ssh+payload');
    assert.equal(detectProtocolFromFields({ method: 'aes-256-gcm', password: 'x' }), 'shadowsocks');
    assert.equal(detectProtocolFromFields({ privateKey: 'k', endpoint: 'h:1' }), 'wireguard');
    assert.equal(detectProtocolFromFields({ uuid: 'u', alterId: 0 }), 'vmess');
    assert.equal(detectProtocolFromFields({ password: 'p', sni: 's' }), 'trojan');

    // Chaque valeur produite doit être acceptée par le dispatch natif, sinon la
    // connexion se solde par CONFIG_UNSUPPORTED.
    for (const proto of ['ssh', 'ssh+payload', 'vless', 'vmess', 'trojan', 'shadowsocks', 'wireguard', 'hysteria2', 'tuic', 'singbox']) {
      assert.ok(nativeService.includes(`"${proto}"`), `protocole absent du dispatch natif : ${proto}`);
    }
  });

  it('rend la suppression d’une configuration réellement définitive', () => {
    // La suppression n'était que locale : /mobile/connections reprovisionnait le
    // profil au rafraîchissement suivant et il réapparaissait dans la liste.
    assert.ok(configStore.includes('DISMISSED_KEY'));
    assert.ok(configStore.includes('export async function dismiss('));
    assert.ok(configStore.includes('export async function restore('));
    assert.ok(configStore.includes('export async function listDismissed('));
    // Une réinitialisation complète purge aussi les pierres tombales.
    assert.match(configStore, /removeItem\(DISMISSED_KEY\)/);

    // Le filtre s'applique AVANT la boucle de provisionnement proactif.
    assert.ok(accessSync.includes('configStore.listDismissed()'));
    assert.ok(accessSync.includes('dismissed.has(entry.id)'));
    assert.ok(accessSync.indexOf('const dismissed') < accessSync.indexOf('provisionAndStore(entry.dataToken, current.deviceId)'));

    // La suppression pose la pierre tombale et purge la liste distante en mémoire.
    assert.ok(vpnContext.includes('configStore.dismiss(configId)'));
    assert.ok(vpnContext.includes('setRemoteConnections(prev => prev.filter(c => c.id !== configId))'));

    // Réactiver le jeton lève la suppression, sinon le profil resterait masqué.
    assert.ok(authContext.includes('configStore.restore(provisioned.meta.subscriptionId)'));
  });

  it('retire la configuration de l’écran sans attendre le coffre ni la coupure', () => {
    // L'entrée disparaissait seulement après disconnect() + écritures chiffrées,
    // donc le bouton paraissait sans effet pendant plusieurs secondes.
    assert.ok(vpnContext.includes('const previousSaved = savedConfigsRef.current'));
    assert.ok(vpnContext.includes('setSavedConfigs(prev => prev.filter(c => c.id !== configId))'));
    // Échec d'écriture : la liste doit revenir à son état exact d'avant.
    assert.ok(vpnContext.includes('setSavedConfigs(previousSaved)'));
    // Le retrait optimiste précède la coupure du tunnel ET l'appel au coffre.
    const retrait = vpnContext.indexOf('setSavedConfigs(prev => prev.filter(c => c.id !== configId))');
    assert.ok(retrait > -1 && retrait < vpnContext.indexOf('await configStore.remove(configId)'));
    assert.ok(retrait < vpnContext.indexOf('await disconnect();'));
  });

  it('empêche la boucle de résolution DNS qui bloquait tout le trafic', () => {
    // Symptôme : tunnel « connecté » mais aucune donnée, avec le moteur qui
    // répète « DNS query loopback in transport[dns-remote] ». Joindre un serveur
    // désigné par un domaine exigeait une résolution qui passait elle-même par
    // le proxy à ouvrir.
    assert.ok(nativeService.includes('private fun applyDnsLoopGuard('));
    assert.ok(nativeService.includes('private fun isLiteralIp('));
    assert.ok(nativeService.includes('private fun dnsAddressHost('));

    // Un serveur joignable sans le proxy existe toujours, même si le JSON
    // fournisseur n'en déclare aucun (cas des traductions Xray).
    assert.ok(nativeService.includes('directTag = "dns-bootstrap"'));
    // Il doit s'appuyer sur le résolveur RÉEL du réseau : `local` délègue au
    // résolveur Go, qui cherche /etc/resolv.conf — absent sous Android, d'où
    // les « lookup … i/o timeout » et « connect: connection refused » constatés.
    assert.ok(nativeService.includes('private fun systemDnsServers('));
    assert.ok(nativeService.includes('private fun bootstrapDnsAddress('));
    assert.ok(nativeService.includes('put("address", bootstrapDnsAddress())'));
    assert.doesNotMatch(nativeService, /put\("tag", "dns-local"\)\.put\("address", "local"\)/);
    // Le chemin SSH partageait le même défaut : plus aucun résolveur `local`.
    assert.doesNotMatch(nativeService, /put\("tag", "dns-l"\)\.put\("address", "local"\)/);
    // Le résolveur d'amorçage ne doit jamais être notre propre TUN.
    assert.ok(nativeService.includes('NetworkCapabilities.TRANSPORT_VPN'));
    // Un serveur d'amorçage doit être une IP littérale ET sortir en direct.
    assert.ok(nativeService.includes('if (host.isNotEmpty() && isLiteralIp(host)) { directTag = tag; break }'));

    // Un DNS distant désigné par un nom doit dire comment résoudre son propre nom.
    assert.ok(nativeService.includes('s.put("address_resolver", directTag)'));

    // La règle d'exclusion passe EN TÊTE, sinon fakeip capture le domaine du
    // serveur et renvoie une adresse fictive pour la machine à joindre.
    assert.ok(nativeService.includes('JSONObject().put("domain", JSONArray(domains)).put("server", directTag)'));

    // Les deux chemins moteur sont couverts : profil plat ET sing-box importé.
    assert.ok(nativeService.includes('profileDnsObject(cfg.optStringOrNull("dns", "")) ?: defaultDnsObject(),'));
    assert.ok(nativeService.includes('outboundServerHosts,'));
    // Sur une chaîne de proxys, chaque maillon nommé doit être résolu hors tunnel.
    assert.ok(nativeService.includes('val outboundServerHosts = LinkedHashSet<String>()'));
  });

  it('signale un tunnel connecté qui ne transporte aucune donnée', () => {
    // Le moteur journalise en niveau `warn` : il n'émet jamais la ligne
    // « connection established » qui prouverait le handshake, mais il émet
    // TOUTES les erreurs de sortie. On surveille donc l'échec, faute de quoi
    // l'application affiche un état sain pendant que rien ne passe.
    assert.ok(nativeService.includes('put("log", JSONObject().put("level", "warn")'));
    assert.ok(nativeService.includes('private fun noteOutboundFailure('));
    assert.ok(nativeService.includes('TUNNEL_SANS_TRAFIC'));
    // Le diagnostic distingue une panne de résolution d'un refus du serveur.
    assert.ok(nativeService.includes('if (dnsFailureSeen)'));
    // Aucun changement d'état : couper sur un pic d'erreurs boucherait en
    // reconnexions sur un réseau lent.
    assert.doesNotMatch(nativeService, /noteOutboundFailure[\s\S]{0,1200}failVpn\(/);
    // Les compteurs repartent de zéro à chaque connexion.
    assert.ok(nativeService.includes('dnsFailureSeen = false'));
  });

  it('présente une empreinte TLS de navigateur plutôt que celle de Go', () => {
    // Sans uTLS, sing-box émet le ClientHello de la bibliothèque Go : une
    // signature atypique que les équipements d'inspection des opérateurs
    // mobiles reconnaissent et brident. Un client comme HTTP Custom présente
    // « chrome » par défaut sur le même profil, d'où sa stabilité.
    assert.ok(nativeService.includes('enabled -> "chrome"'));
    assert.ok(nativeService.includes('put("utls", JSONObject().apply {'));
    // Une empreinte demandée par le profil reste prioritaire.
    assert.ok(nativeService.includes('fingerprint.isNotBlank() -> fingerprint'));
    // TLS désactivé : aucun bloc uTLS, sinon la configuration est incohérente.
    assert.ok(nativeService.includes('else -> ""'));
  });

  it('court-circuite les requêtes HTTPS/SVCB qui gelaient la navigation 10 s', () => {
    // Navigateurs et applications Android émettent une requête HTTPS (RFC 9460)
    // avant chaque navigation. Aucune règle ne les capturait : elles partaient
    // sur `final` → DoH à travers le tunnel et expiraient au bout de 10 s
    // (« IN HTTPS: context deadline exceeded ») avant le repli sur A/AAAA.
    assert.ok(nativeService.includes('put("address", "rcode://success")'));
    assert.ok(nativeService.includes('.put("query_type", JSONArray().put("HTTPS").put("SVCB"))'));
    // Rien ne part sur le réseau : aucun domaine n'est exposé à l'opérateur.
    assert.doesNotMatch(nativeService, /query_type.*HTTPS.*server", *"dns-local/);
  });

  it('n’interroge pas l’IPv6 sur un réseau qui n’en a pas', () => {
    // Chaque AAAA sans réponse occupait le résolveur jusqu'à expiration : ce
    // sont les attentes de 10 s visibles dans les journaux.
    assert.ok(nativeService.includes('private fun networkHasIpv6('));
    assert.ok(nativeService.includes('private fun dnsStrategy('));
    assert.ok(nativeService.includes('if (networkHasIpv6()) "prefer_ipv4" else "ipv4_only"'));
    // La détection ne doit jamais confondre le TUN avec le réseau physique.
    assert.match(nativeService, /networkHasIpv6[\s\S]{0,600}TRANSPORT_VPN/);
    // Plus aucune stratégie figée en dur dans les générateurs DNS.
    assert.doesNotMatch(nativeService, /put\("strategy", "prefer_ipv4"\)/);
  });

  it('ne déclare pas un échec pendant que des octets circulent', () => {
    // Le moteur ouvre des dizaines de connexions en parallèle : il est normal
    // qu'une partie échoue pendant que le tunnel fonctionne. Le verdict exige
    // donc des compteurs de trafic restés immobiles sur toute la fenêtre.
    assert.ok(nativeService.includes('trafficAtWindowStart'));
    assert.ok(nativeService.includes('if (bytes > trafficAtWindowStart) return'));
    // Un « connection refused » isolé ne doit plus conclure au refus du serveur.
    assert.doesNotMatch(nativeService, /Échec handshake — Le serveur a refusé la connexion/);
    // Sans preuve TCP/TLS, ne jamais affirmer que le serveur est joignable.
    assert.doesNotMatch(nativeService, /le serveur est joignable mais refuse/);
  });

  it('publie la séparation des rôles server / SNI / Host WebSocket', () => {
    // Les noms d'hôte étant masqués dans les journaux, on publie la RELATION
    // entre les trois valeurs — seule information exploitable au diagnostic.
    assert.ok(nativeService.includes('[CONFIG] rôles: adresse_tcp_differe_du_sni='));
    assert.ok(nativeService.includes('sni_egale_entete_ws='));
    assert.ok(nativeService.includes('entete_ws_renseigne='));
    // Aucun libellé ne doit contenir un mot masqué par SecurityModule
    // (host, server, user, key, token…), sinon la valeur est remplacée par
    // « [****] » et le diagnostic devient trompeur — c'est ce qui a fait croire
    // à un en-tête Host vide alors qu'il était correctement renseigné.
    const masked = /(password|passwd|key|token|secret|uuid|user|username|deviceId|payload|host|server)[=:]/i;
    const rolesLine = nativeService
      .split('\n')
      .filter(l => l.includes('[CONFIG] rôles:') || l.includes('sni_egale_entete_ws') || l.includes('entete_ws_renseigne'))
      .join('\n')
      .replace(/\$\{[^}]*\}/g, '');
    assert.doesNotMatch(rolesLine, masked);
  });

  it('classe les événements du moteur au lieu de tout afficher en erreur', () => {
    // Chaque ligne du moteur était relayée telle quelle : sing-box journalise en
    // ERROR des événements normaux (connexion annulée par l'application,
    // requête recyclée), le journal se remplissait donc de rouge alors que le
    // tunnel fonctionnait et les vraies pannes devenaient introuvables.
    assert.ok(nativeService.includes('private enum class EngineEvent'));
    assert.ok(nativeService.includes('private fun classifyEngineEvent('));
    // « context canceled » = le demandeur a renoncé : jamais une panne.
    assert.match(nativeService, /lower\.contains\("context canceled"\) -> EngineEvent\.NORMAL/);
    // Les échecs de connexions isolées n'ont d'intérêt que pendant l'établissement.
    assert.ok(nativeService.includes('EngineEvent.RECOVERABLE -> if (currentState != "connected")'));
    // Le métier passe toujours : quota épuisé et redirection HTTP 302.
    assert.ok(nativeService.includes('QUOTA_EXHAUSTED'));
    assert.ok(nativeService.includes('HOST_REDIRECT'));
    // Rien n'est perdu : tout reste dans le journal sécurisé pour diagnostic.
    assert.ok(nativeService.includes('SxbSecureLogger.debug("LIBBOX_LOG: $message")'));
    // Plus de diffusion inconditionnelle de chaque ligne du moteur.
    assert.doesNotMatch(nativeService, /val safeMessage = SecurityModule\.maskSensitive\(message\)\s*\n\s*broadcastLog\("\[engine\] \$safeMessage"\)/);
  });

  it('compte la durée de session dans le service, pas dans le JavaScript', () => {
    // Le compteur JS repartait de zéro dès que l'application était fermée ou
    // évincée, alors que le tunnel continuait de tourner.
    assert.ok(nativeService.includes('connectedSinceMs'));
    assert.ok(nativeService.includes('fun getConnectedSeconds()'));
    // elapsedRealtime : insensible aux changements d'heure, court en veille.
    assert.match(nativeService, /connectedSinceMs = SystemClock\.elapsedRealtime\(\)/);
    // Une promotion répétée ne doit pas réarmer le compteur.
    assert.match(nativeService, /if \(connectedSinceMs == 0L\) \{[\s\S]{0,180}connectedSinceMs = SystemClock\.elapsedRealtime\(\)/);
    // La valeur traverse le pont natif puis le contexte jusqu'à l'écran.
    assert.ok(nativeModule.includes('putDouble("connectedSeconds"'));
    assert.ok(vpnContext.includes('connectedSeconds: stats.connectedSeconds || 0'));
    assert.ok(diagnosticsScreen.includes('trafficStats.connectedSeconds'));
    // L'ancien compteur local, qui repartait à l'ouverture de l'écran, a disparu.
    assert.doesNotMatch(diagnosticsScreen, /startedAtRef/);
    // La notification persistante laisse Android dessiner le chronomètre à
    // partir de la même ancre, sans thread réveillé chaque seconde.
    assert.ok(nativeService.includes('getConnectedSinceWallClockMs()'));
    assert.ok(nativeService.includes('.setUsesChronometer(connected)'));
  });

  it('conserve les fichiers expirés pour le mode zero-rated et les prolongations', () => {
    assert.doesNotMatch(configStore, /export async function purgeExpired/);
    assert.doesNotMatch(vpnContext, /configStore\.purgeExpired/);
    assert.match(vpnContext, /await isConfigExpired\(\)/);
    assert.match(vpnContext, /Date d’expiration locale atteinte — tentative de connexion/);
    assert.match(accessSync, /expiryDate: remote\.expireAt/);
    assert.match(accessPolicy, /config_restored/);
  });

  it('distingue remplacer, ajouter et prolonger dans les opérations groupées', () => {
    // L'exploitant gère des centaines de clients : les éditer un par un n'est
    // pas tenable. Confondre « définir » et « ajouter » ferait perdre le solde
    // d'un client, d'où quatre actions explicitement nommées.
    assert.match(subscriptionRoutes, /router\.post\(\s*['"]\/bulk['"]/);
    for (const action of ['deploy', 'set', 'add_data', 'extend_duration']) {
      assert.ok(subscriptionRoutes.includes(`'${action}'`), `action absente : ${action}`);
    }
    // « ajouter » part du solde existant, « définir » l'écrase.
    assert.ok(subscriptionRoutes.includes('data.quotaBytes = { increment: gigabytesToBytes(quotaGB!) }'));
    // Prolonger un forfait déjà expiré doit le réactiver, sinon la nouvelle
    // échéance resterait dans le passé.
    assert.ok(subscriptionRoutes.includes('new Date(sub.expireAt) > new Date() ? new Date(sub.expireAt) : new Date()'));
    assert.ok(subscriptionRoutes.includes("if (sub.status === 'expired') data.status = 'active'"));
    // Un échec isolé ne doit pas interrompre le lot, et l'opérateur veut savoir
    // quels clients ont échoué et pourquoi.
    assert.ok(subscriptionRoutes.includes('selected: targetIds.length'));
    assert.ok(subscriptionRoutes.includes('details'));
  });

  it('contrôle le quota revendeur sur le cumul d’une opération groupée', () => {
    // Vérifier client par client laisserait passer 100 × 5 Go pour un revendeur
    // limité à 100 Go : chaque appel isolé serait valide.
    assert.ok(subscriptionRoutes.includes('unit * BigInt(ownedTargets)'));
    // Le total est évalué AVANT toute écriture : on refuse l'opération entière
    // plutôt que de l'appliquer à moitié.
    const bulkStart = subscriptionRoutes.search(/router\.post\(\s*['"]\/bulk['"]/);
    assert.ok(bulkStart >= 0, 'route groupée introuvable');
    const bulk = subscriptionRoutes.slice(bulkStart);
    assert.ok(bulk.indexOf('reponsePlafondDepasse') < bulk.indexOf('subscription.create'));
    // « set » remplace : ne pas compter deux fois les forfaits visés.
    assert.ok(subscriptionRoutes.includes("projected += unit - BigInt(target.quotaBytes ?? 0)"));
    // Cloisonnement : 404 et non 403 sur la ressource d'autrui.
    assert.ok(subscriptionRoutes.includes("isReseller && !possedeClient(client, ficheBulk)"));
  });

  it('attribue les configurations VPN aux revendeurs sans exposer la technique', () => {
    // L'administrateur importe une configuration une fois puis coche les
    // revendeurs qui la reçoivent.
    assert.ok(prismaSchema.includes('model VpnProfileReseller'));
    assert.ok(prismaSchema.includes('@@id([profileId, resellerId])'));
    assert.ok(vpnProfileRoutes.includes("router.put('/:id/resellers'"));
    assert.ok(vpnProfileRoutes.includes("router.get('/:id/resellers'"));
    // Le revendeur n'a pas `vpnprofile.view` : sa route dédiée ne doit jamais
    // renvoyer les champs techniques, seulement le nom commercial.
    assert.ok(vpnProfileRoutes.includes("router.get('/assigned'"));
    assert.ok(vpnProfileRoutes.includes('select: { id: true, name: true, displayProtocol: true }'));
    // L'attribution est la SEULE porte d'entrée : un profil sans attribution
    // n'est plus visible par tous. La règle précédente ouvrait la quasi-totalité
    // du parc à chaque revendeur, ce qui vidait l'écran d'attribution de son sens.
    assert.ok(!vpnProfileRoutes.includes('assignedResellers: { none: {} }'));
    assert.ok(vpnProfileRoutes.includes('assignedResellers: { some: { resellerId: reseller.id } }'));
    // Le masquage du blob canonique reste intact.
    assert.ok(vpnProfileRoutes.includes('serializeLockedProfile(p, req)'));
    const lockService = source('../server/services/profile-lock.ts');
    const allowedFields = lockService.slice(lockService.indexOf('const metadataFields'), lockService.indexOf('export function serializeLockedProfile'));
    assert.doesNotMatch(allowedFields, /['"]canonicalConfig['"]|['"]lockPasswordHash['"]/);
  });

  it('garde le schéma Prisma déployé identique à celui de la racine', () => {
    // Le déploiement pousse `backend/prisma/schema.prisma`, PAS celui de la
    // racine. Une modification faite uniquement à la racine n'atteint donc
    // jamais la base : les tables n'existent pas, et toute requête qui les
    // référence tombe en 500 en production. C'est arrivé.
    const deployed = source('../backend/prisma/schema.prisma');
    assert.equal(
      deployed.replace(/\r\n/g, '\n').trim(),
      prismaSchema.replace(/\r\n/g, '\n').trim(),
      'backend/prisma/schema.prisma doit être identique à prisma/schema.prisma — c’est lui qui est poussé en base',
    );
  });

  it('ne laisse pas une fonctionnalité secondaire casser la liste des profils', () => {
    // Tant que le schéma n'est pas poussé, l'`include` des attributions échoue.
    // Sans repli, c'est toute la page Configurations qui tombe en 500.
    assert.ok(vpnProfileRoutes.includes('const profiles = await (prisma as any).vpnProfile.findMany({'));
    assert.ok(vpnProfileRoutes.includes('} catch {'));
    // Le repli doit rendre les profils, pas une liste vide.
    const listRoute = vpnProfileRoutes.slice(
      vpnProfileRoutes.indexOf("router.get('/', requireAuth, requirePermission('vpnprofile.view')"),
      vpnProfileRoutes.indexOf("router.get('/assigned'"),
    );
    assert.match(listRoute, /profiles\.map\(\(p: any\) => maskProfile\(p\)\)/, 'le repli doit renvoyer les profils masqués');
  });

  it('expose les opérations groupées avec confirmation et récapitulatif', () => {
    // Une opération groupée touche des centaines de clients d'un coup : elle
    // exige une confirmation, et l'opérateur doit ensuite savoir qui a échoué.
    assert.ok(subscriptionsView.includes('BULK_ACTIONS'));
    assert.ok(subscriptionsView.includes('bulkConfirm'));
    assertDashboardLabel(subscriptionsView, 'commerce.subscriptions.bulk.confirm', /Confirmer l’opération/);
    assert.ok(subscriptionsView.includes('bulkResult'));
    assert.ok(subscriptionsView.includes("d.status === 'failed'"), 'le récapitulatif doit lister les échecs');
    // Les libellés disent ce que l'action FAIT : confondre « définir » et
    // « ajouter » ferait perdre le solde d'un client.
    assertDashboardLabel(subscriptionsView, 'commerce.subscriptions.bulk.set', /Définir \(remplace\)/);
    assertDashboardLabel(subscriptionsView, 'commerce.subscriptions.bulk.addData', /Ajouter des données \(\+Go\)/);
    assertDashboardLabel(subscriptionsView, 'commerce.subscriptions.bulk.extend', /Prolonger la durée \(\+jours\)/);
    // « Tout sélectionner » doit porter sur le filtre, pas sur la page affichée.
    assert.ok(subscriptionsView.includes('const selectAllFiltered = () => setSelected(new Set(filtered.map(s => s.id)))'));
  });

  it('permet d’attribuer une configuration à des revendeurs depuis le dashboard', () => {
    assert.ok(vpnProfilesView.includes('setProfileResellers'));
    assert.ok(vpnProfilesView.includes('openAssign'));
    // Aucune attribution n'autorise aucun revendeur, jamais tout le parc.
    assertDashboardLabel(vpnProfilesView, 'configurations.notices.noResellers', /Aucun revendeur attribué/);
    assertDashboardLabel(vpnProfilesView, 'configurations.ui.removeAll', /Tout retirer/);
    // L'échec du chargement des revendeurs ne doit pas masquer les profils.
    assert.ok(vpnProfilesView.includes('fetchResellers().catch(() => [] as any[])'));
  });

  it('ne recharge pas la page en boucle quand aucune session n’existe', () => {
    // L'application est servie à la racine et n'a PAS de route « /login » : la
    // condition `pathname !== "/login"` était donc toujours vraie. Un visiteur
    // non connecté enchaînait chargement → 401 → rechargement → 401, et le
    // dashboard restait bloqué sur « Initialisation… ».
    assert.ok(apiClient.includes('const hadSession'));
    assert.ok(apiClient.includes('if (hadSession && typeof window !== "undefined")'));
    assert.doesNotMatch(apiClient, /window\.location\.pathname !== "\/login"/);
  });

  it('cloisonne le revendeur : ses clients, jamais l’infrastructure', () => {
    // Le revendeur vend un service ; il n'exploite pas la plateforme. Lui ouvrir
    // un écran sans cloisonner la route correspondante exposerait les clients de
    // l'administrateur et ceux des autres revendeurs.
    const layout = source('../artifacts/sxb-dashboard/src/components/Layout.tsx');
    // Aucune entrée d'infrastructure ni d'administration pour lui.
    assert.ok(layout.includes("id: 'vpn-profiles'"));
    assert.match(layout, /id: 'vpn-profiles'[\s\S]{0,120}roles: STAFF/);
    assert.match(layout, /id: 'monitoring'[\s\S]{0,200}roles: STAFF/);
    assert.match(layout, /id: 'admin'[\s\S]{0,400}roles: STAFF/);
    // À la place : les services qui lui sont attribués.
    assert.ok(layout.includes("id: 'reseller-services'"));
    assert.match(layout, /id: 'reseller-services'[\s\S]{0,120}roles: \['RESELLER'\]/);

    // Les routes correspondantes doivent filtrer sur SES clients.
    assert.ok(devicesRoutes.includes('where: isReseller ? (porteeClientsRevendeur(fiche) as any) : undefined'));
    const portees = dashboardRoutes.match(/porteeClientsRevendeur\(/g) || [];
    assert.ok(portees.length >= 3, `portée revendeur absente des indicateurs (${portees.length})`);
    // Le compte de serveurs ne doit jamais lui être communiqué.
    assert.ok(dashboardRoutes.includes('isReseller ? Promise.resolve(0) : prisma.vPSServer.count'));
  });

  it('n’expose que le nom commercial des services au revendeur', () => {
    const view = source('../artifacts/sxb-dashboard/src/components/ResellerServicesView.tsx');
    assert.ok(view.includes("apiRequest<{ profiles: AssignedService[] }>('/vpn-profiles/assigned')"));
    // Aucun champ technique ne doit apparaître dans cet écran.
    for (const champ of ['host', 'port', 'uuid', 'sni', 'password', 'canonicalConfig']) {
      assert.doesNotMatch(view, new RegExp(`s\\.${champ}\\b`), `champ technique exposé : ${champ}`);
    }
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
    assert.ok(nativeService.includes('session.connect(timeoutMs)'));
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

  it('permet d’amorcer le compte OWNER hors API sans écrire le mot de passe dans le dépôt', () => {
    // `POST /api/users` refuse de créer un OWNER si le demandeur n'en est pas
    // un : sans ce script, aucun propriétaire ne peut jamais exister.
    const seedOwner = source('../prisma/seed-owner.ts');
    assert.match(seedOwner, /process\.env\.OWNER_EMAIL/);
    assert.match(seedOwner, /process\.env\.OWNER_PASSWORD/);
    assert.match(seedOwner, /prisma\.role\.upsert/);
    assert.match(seedOwner, /prisma\.user\.upsert/);
    assert.match(seedOwner, /bcrypt\.hash\(password, 12\)/);

    // Un mot de passe en dur dans le dépôt annulerait l'intérêt du secret.
    assert.doesNotMatch(seedOwner, /password\s*=\s*['"][^'"]{6,}['"]/);
    // Le mot de passe ne doit jamais être journalisé.
    assert.doesNotMatch(seedOwner, /console\.log\([^)]*password/i);

    // Le script est déployé depuis backend/prisma (cf. deploy-vps.yml), pas
    // depuis la racine : les deux copies doivent rester identiques.
    assert.equal(seedOwner, source('../backend/prisma/seed-owner.ts'));
  });

  it('n’exige aucune permission en base pour OWNER (point de contournement unique)', () => {
    const auth = source('../server/middleware/auth.ts');
    assert.match(auth, /if \(req\.user\.role === "OWNER"\)[\s\S]{0,40}return next\(\)/);
  });

  it('masque d’office les actions et connexions de l’OWNER dans les journaux', () => {
    // L'utilisateur exige que ses traces ne soient visibles que de lui-même.
    const db = source('../server/database.ts');
    assert.match(db, /visibleOwnerOnly = true/);
    const auditLogs = source('../server/routes/audit-logs.ts');
    assert.match(auditLogs, /requesterIsOwner \? \{\} : \{ visibleOwnerOnly: false \}/);
    const auth = source('../server/routes/auth.ts');
    assert.match(auth, /visibleOwnerOnly: isOwnerLogin|isOwnerLogin/);
  });

  it('amorce le compte OWNER au déploiement sans faire échouer les déploiements sans secret', () => {
    const deploy = source('../.github/workflows/deploy-vps.yml');
    assert.match(deploy, /OWNER_EMAIL: \$\{\{ secrets\.OWNER_EMAIL \}\}/);
    assert.match(deploy, /OWNER_PASSWORD: \$\{\{ secrets\.OWNER_PASSWORD \}\}/);
    assert.match(deploy, /envs: OWNER_EMAIL,OWNER_PASSWORD/);
    // `script_stop: true` ferait échouer tout le déploiement si l'amorçage
    // s'exécutait sans secrets : il doit rester conditionnel.
    assert.match(deploy, /if \[ -n "\$OWNER_EMAIL" \] && \[ -n "\$OWNER_PASSWORD" \]; then/);
    assert.match(deploy, /Amorçage OWNER ignoré/);
    assert.match(deploy, /seed-owner\.cjs/);
  });

  it('découpe le paquet du dashboard pour qu’aucun morceau ne soit tronqué en route', () => {
    // Un fichier unique de près d'un mégaoctet arrivait coupé sur une liaison
    // lente : le module échouait et la page restait vide sur le fond bleu.
    const vite = source('../artifacts/sxb-dashboard/vite.config.ts');
    assert.match(vite, /manualChunks\(id\)/);
    assert.match(vite, /return 'charts'/);
    assert.match(vite, /return 'react-dom'/);
    // Les greffons Replit du gabarit d'origine ne doivent pas revenir.
    assert.doesNotMatch(vite, /@replit\//);

    const pkg = source('../artifacts/sxb-dashboard/package.json');
    for (const mort of ['@replit/vite-plugin-runtime-error-modal', 'wouter', 'framer-motion', '@tanstack/react-query']) {
      assert.ok(!pkg.includes(`"${mort}"`), `dépendance morte réintroduite : ${mort}`);
    }
  });

  it('affiche un message plutôt qu’une page vide quand un fichier n’arrive pas', () => {
    const html = source('../artifacts/sxb-dashboard/index.html');
    assert.match(html, /sxb_boot_retry/);
    assert.match(html, /Chargement interrompu/);
    // Un rechargement non gardé bouclerait à l'infini sur une panne durable.
    assert.match(html, /sessionStorage\.setItem\(RETRY_KEY/);
    assert.doesNotMatch(html, /built on Replit/);
  });

  it('n’exclut plus le rôle OWNER des commandes d’administration du dashboard', () => {
    // Huit vues recalculaient `ADMIN || SUPER_ADMIN` sans OWNER : le
    // propriétaire racine voyait moins de boutons qu'un simple admin, alors
    // que le serveur l'autorise. Une source unique évite la neuvième copie.
    const roles = source('../artifacts/sxb-dashboard/src/lib/roles.ts');
    assert.match(roles, /export function isOwner/);
    assert.match(roles, /export function isAdmin/);
    assert.match(roles, /role === UserRole\.ADMIN \|\| isSuperAdmin\(role\)/);

    const vues = [
      'PayloadManagerView', 'ServersView', 'SingboxManagerView', 'XrayManagerView',
      'VpnProfilesView', 'SSHManagerView', 'SubscriptionsView',
    ];
    for (const v of vues) {
      const s = source(`../artifacts/sxb-dashboard/src/components/${v}.tsx`);
      assert.match(s, /isAdminRole\(currentUserRole\)/, `${v} n'utilise pas l'assistant partagé`);
      assert.doesNotMatch(
        s,
        /const isAdmin = currentUserRole === UserRole\.(ADMIN|SUPER_ADMIN)/,
        `${v} recalcule le rôle localement et oublierait OWNER`,
      );
    }
  });

  it('affiche le nom des revendeurs, jamais leur identifiant technique', () => {
    // `/api/resellers` aplatit nom et e-mail à la racine : lire `r.user.name`
    // renvoyait undefined et l'interface retombait sur l'UUID.
    const vue = source('../artifacts/sxb-dashboard/src/components/VpnProfilesView.tsx');
    assert.match(vue, /\{r\.name \|\| r\.email \|\| r\.user\?\.name/);
  });

  it('n’affiche plus l’adresse de sortie dans l’application mobile', () => {
    const accueil = source('app/(tabs)/index.tsx');
    assert.doesNotMatch(accueil, /connectedIp/);
    assert.doesNotMatch(accueil, /info_ip_address/);
    // L'adresse n'est même plus demandée au serveur.
    assert.doesNotMatch(accueil, /["'`]\/mobile\/ip["'`]/);
    // La latence, elle, reste affichée.
    assert.match(accueil, /info_ping/);
    assert.match(accueil, /Abakodollar\$/);
  });

  it('numérote les publications à partir de 1 sans toucher au versionCode Android', () => {
    const build = source('../.github/workflows/build-android.yml');
    // Le numéro de publication repart de 1…
    assert.match(build, /n=\$\(\( \$\{\{ github\.run_number \}\} - 314 \)\)/);
    assert.match(build, /tag_name: apk-\$\{\{ steps\.relno\.outputs\.n \}\}/);
    assert.doesNotMatch(build, /tag_name: apk-\$\{\{ github\.run_number \}\}/);

    // Les deux canaux utilisent désormais la même horloge UTC, jamais deux
    // compteurs de workflow indépendants susceptibles de rétrograder l'app.
    assert.match(build, /node scripts\/android-version\.cjs/);
    assert.match(build, /SXB_ANDROID_VERSION_CODE=\$VERSION_CODE/);
    const allocator = source('scripts/android-version.cjs');
    assert.match(allocator, /code <= floor/);
    assert.match(allocator, /code > clock/);
  });

  it('ne montre au revendeur que sa propre activité, jamais celle de la plateforme', () => {
    // La route n'exigeait qu'une authentification : un revendeur lisait le
    // journal complet — connexions des administrateurs, jetons émis, noms des
    // clients des autres revendeurs.
    const logs = source('../server/routes/audit-logs.ts');
    assert.match(logs, /const isReseller = req\.user\?\.role === "RESELLER"/);
    assert.match(logs, /ownScope = isReseller \? \{ userId: req\.user\?\.userId \} : \{\}/);
    assert.match(logs, /\.\.\.ownScope/);

    // La carte disparaît aussi du tableau de bord, et les journaux ne sont
    // même plus demandés.
    const vue = source('../artifacts/sxb-dashboard/src/components/DashboardView.tsx');
    assert.match(vue, /isReseller \? Promise\.resolve\(\[\]\) : fetchActivityLogs\(\)/);
  });

  it('cloisonne les graphiques et les compteurs du tableau de bord par revendeur', () => {
    const dash = source('../server/routes/dashboard.ts');
    // /traffic et /users portaient sur TOUS les clients de la plateforme : un
    // revendeur sans aucun client y voyait malgré tout une courbe à 82.
    const portees = dash.match(/porteeClientsRevendeur\(/g) || [];
    assert.ok(portees.length >= 2, `cloisonnement absent de /traffic ou /users (${portees.length})`);
    // Les bons de recharge étaient comptés à l'échelle de la plateforme.
    assert.match(dash, /isReseller \? Promise\.resolve\(0\) : prisma\.voucher\.count\(\)/);
  });

  it('limite le revendeur aux configurations qui lui sont attribuées', () => {
    const subs = source('../server/routes/subscriptions.ts');
    assert.match(subs, /async function assertResellerCanUseProfile/);
    // Appliqué à la création ET à la modification d'un forfait.
    const appels = subs.match(/assertResellerCanUseProfile\(req, profileId\)/g) || [];
    assert.ok(appels.length >= 2, `garde-fou non appliqué partout (${appels.length})`);
    // Un profil sans attribution n'est plus ouvert à tous : seule une
    // attribution explicite de l'administrateur donne accès.
    assert.match(subs, /assignedResellers.*|vpnProfileReseller\.findFirst/);
    assert.doesNotMatch(subs, /if \(liens\.length === 0\) return null/);
    // Le forfait peut changer de configuration sans recréer le jeton data.
    assert.match(subs, /\.\.\.\(profileId\s+!== undefined && \{ profileId \}\)/);
  });

  it('propose au revendeur ses configurations attribuées dans le formulaire de forfait', () => {
    const api = source('../artifacts/sxb-dashboard/src/api/vpn-profiles.ts');
    assert.match(api, /fetchAssignedVpnProfiles/);
    assert.match(api, /'\/vpn-profiles\/assigned'/);

    const vue = source('../artifacts/sxb-dashboard/src/components/SubscriptionsView.tsx');
    assert.match(vue, /isReseller \? fetchAssignedVpnProfiles\(\) : fetchVpnProfiles\(\)/);

    // La liste doit être strictement celle des attributions : la règle
    // précédente ouvrait tout profil sans attribution, si bien que le revendeur
    // voyait 45 configurations sur 47 et l'écran d'attribution ne servait à rien.
    const route = source('../server/routes/vpn-profiles.ts');
    assert.match(route, /assignedResellers: \{ some: \{ resellerId: reseller\.id \} \}/);
    assert.doesNotMatch(route, /\{ assignedResellers: \{ none: \{\} \} \}/);
  });

  it('garde un catalogue pnpm complet pour toutes les références du workspace', () => {
    // Retirer une entrée encore référencée par « catalog: » fait échouer
    // `pnpm install` avec ERR_PNPM_CATALOG_ENTRY_NOT_FOUND_FOR_SPEC et bloque
    // tout le déploiement — panne constatée après un nettoyage de dépendances.
    const ws = source('../pnpm-workspace.yaml');
    const bloc = ws.split(/^catalog:\s*$/m)[1] || '';
    const entrees = new Set<string>();
    for (const l of bloc.split('\n')) {
      if (/^\S/.test(l)) break;
      const m = l.match(/^\s+'?([^':]+)'?\s*:/);
      if (m) entrees.add(m[1].trim());
    }

    const paquets = [
      '../lib/db/package.json',
      '../lib/api-zod/package.json',
      '../lib/api-client-react/package.json',
      '../artifacts/api-server/package.json',
      '../artifacts/mockup-sandbox/package.json',
      '../artifacts/sxb-dashboard/package.json',
    ];
    for (const rel of paquets) {
      const j = JSON.parse(source(rel));
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
        for (const [nom, spec] of Object.entries(j[section] || {})) {
          if (typeof spec === 'string' && spec.startsWith('catalog:')) {
            assert.ok(entrees.has(nom), `entrée de catalogue manquante : ${nom} (requise par ${rel})`);
          }
        }
      }
    }
  });

  it('prend en charge SSH encapsulé dans TLS (SSL Tunnel)', () => {
    // Le moteur ouvrait une socket TCP brute en SSH direct et ignorait tls=true :
    // contre un serveur qui n'accepte que du TLS sur 443, le handshake SSH
    // partait en clair et expirait sans message exploitable. La combinaison était
    // donc rejetée à l'import — ce qui fermait le mode « SSL » proposé par
    // beaucoup de fournisseurs, sans en-tête HTTP à injecter.
    assert.match(nativeService, /class SxbTlsSocketFactory/);
    assert.match(nativeService, /SSH_OVER_TLS_MODE/);
    // Le socket doit être protégé AVANT connect(), sinon il repasse par le TUN
    // qu'il est censé alimenter.
    assert.match(
      nativeService,
      /SxbTlsSocketFactory[\s\S]{0,1800}protectSocket\(rawSocket\)[\s\S]{0,400}rawSocket\.connect/,
    );
    // Une IP littérale n'est pas un nom d'hôte : l'envoyer en SNI fait rejeter
    // le handshake par les serveurs stricts.
    assert.match(nativeService, /isIpLiteral\(serverName\)/);
    // L'ancien contournement ne doit pas revenir.
    assert.doesNotMatch(nativeService, /TLS_IGNORED_SSH_DIRECT/);

    // L'import ne rejette plus la combinaison…
    const canonical = source('../server/services/canonical-config.ts');
    assert.doesNotMatch(canonical, /Combinaison impossible/);
    // …et la sonde la vérifie réellement : TLS puis bannière SSH dans le tunnel.
    const probe = source('../server/services/transport-probe.ts');
    assert.doesNotMatch(probe, /le moteur ignore TLS/);
    assert.match(probe, /dans le tunnel TLS/);
  });

  it('protège la production : sauvegarde avant migration et tests avant déploiement', () => {
    const deploy = source('../.github/workflows/deploy-vps.yml');

    // `db push --accept-data-loss` autorise Prisma à supprimer colonnes et
    // tables : sans dump préalable, un champ renommé par mégarde emporte ses
    // données sans retour possible.
    assert.match(deploy, /pg_dump/);
    assert.match(deploy, /avant-migration-/);
    // La sauvegarde doit précéder la migration, pas la suivre. On vise la
    // commande réelle : le drapeau apparaît aussi dans le commentaire qui
    // l'explique, plus haut dans le fichier.
    assert.ok(
      deploy.indexOf('pg_dump') < deploy.indexOf('--skip-generate 2>&1'),
      'la sauvegarde doit précéder la migration',
    );
    assert.doesNotMatch(deploy, /--accept-data-loss 2>&1/);
    // Un dump vide passerait inaperçu : gzip renvoie 0 même sans données.
    assert.match(deploy, /Sauvegarde suspecte/);
    // …et sans pipefail, l'échec de pg_dump lui-même serait masqué par le
    // succès du gzip placé derrière le tube.
    assert.match(deploy, /set -o pipefail/);
    // libpq refuse le `?schema=public` que Prisma exige : passer l'URL brute
    // à pg_dump le fait échouer avant même de se connecter.
    assert.match(deploy, /PG_URL="\$\{DB_URL%%\\\?\*\}"/);

    // Les garde-fous ne protégeaient que la construction Android : le serveur
    // partait en production sans qu'aucun test ne s'exécute.
    assert.match(deploy, /tests\/regression-critical-flows\.test\.ts/);
    assert.ok(
      deploy.indexOf('regression-critical-flows') < deploy.indexOf('- name: Deploy to VPS'),
      'les tests doivent tourner avant le déploiement',
    );
  });

  it('épingle les actions tierces qui reçoivent les secrets de production', () => {
    // appleboy/ssh-action et scp-action reçoivent la clé SSH privée du VPS et
    // sa phrase de passe. Référencées par tag, elles restent modifiables :
    // `v1.0.3` peut être repointé vers un autre code, qui s'exécuterait avec
    // ces identifiants. Seul un SHA de commit désigne un contenu figé.
    const workflows = ['deploy-vps', 'vps-audit', 'build-android', 'verification-pr'].map((n) =>
      source(`../.github/workflows/${n}.yml`),
    );
    const tiers = /uses:\s+(?!actions\/)([\w.-]+\/[\w./-]+)@(\S+)/g;
    for (const contenu of workflows) {
      for (const [, action, ref] of contenu.matchAll(tiers)) {
        assert.match(
          ref,
          /^[0-9a-f]{40}$/,
          `${action} doit être épinglée à un SHA de commit, pas à « ${ref} »`,
        );
      }
    }
  });

  it('vérifie les propositions avant fusion, sans leur donner les secrets', () => {
    // Les trois autres workflows ne se déclenchent que sur un push vers main :
    // sans celui-ci, une proposition n'est vérifiée qu'une fois fusionnée,
    // c'est-à-dire directement en production.
    const pr = source('../.github/workflows/verification-pr.yml');

    assert.match(pr, /^on:\s*[\r\n]+\s+pull_request:/m, 'doit se déclencher sur pull_request');
    assert.match(pr, /regression-critical-flows\.test\.ts/, 'doit lancer les garde-fous');
    assert.match(pr, /pnpm run build/, 'doit construire le tableau de bord');
    assert.match(pr, /--outfile=dist\/server\.cjs/, 'doit construire le serveur');

    // Une pull request peut venir de n'importe où. Lui ouvrir les secrets du
    // VPS reviendrait à confier la clé de production à du code non relu.
    assert.ok(
      !/secrets\./.test(pr),
      'la vérification des propositions ne doit référencer aucun secret',
    );
    assert.ok(
      !/environment:/.test(pr),
      "aucun environnement GitHub, sinon les secrets de production redeviennent accessibles",
    );
    assert.match(pr, /permissions:\s*[\r\n]+\s+contents:\s+read/, 'jeton en lecture seule');
  });

  it('ne laisse pas les publications APK périmées s\'accumuler', () => {
    // Chaque build publie une release. Sans purge, la page des releases
    // accumule des APK qu'aucun appareil ne peut installer : Android refuse un
    // versionCode inférieur à celui déjà présent, donc revenir en arrière est
    // impossible. Le VPS ne conserve lui aussi que la version courante.
    const build = source('../.github/workflows/build-android.yml');

    assert.match(build, /gh release delete .*--cleanup-tag/, 'doit supprimer les publications périmées et leur tag');
    assert.match(build, /\[ "\$tag" = "\$COURANTE" \] && continue/, 'doit préserver la publication du build courant');

    // La purge doit suivre le déploiement, jamais le précéder : tant que la
    // nouvelle APK n'est pas servie par le VPS, l'ancienne reste la seule
    // copie téléchargeable.
    const purge = build.indexOf('Ne conserver que la dernière publication');
    const deploiement = build.indexOf('Déployer APK sur VPS');
    assert.ok(purge > 0 && deploiement > 0, 'les deux étapes doivent exister');
    assert.ok(purge > deploiement, 'la purge doit venir après le déploiement de l\'APK');
    assert.match(
      build.slice(purge, purge + 400),
      /if:\s*success\(\)/,
      'la purge ne doit pas s\'exécuter si une étape précédente a échoué',
    );
  });

  it('ne laisse pas de script de mot de passe traîner à la racine du dépôt', () => {
    // Le dépôt est public. `set_password.mjs` y portait le mot de passe du
    // compte superadmin en clair, lisible par n'importe qui. Ces scripts
    // jetables n'étaient importés nulle part : ils ne servaient qu'à une
    // manipulation ponctuelle, mais restaient publiés indéfiniment.
    // Les chemins sont relatifs au dossier de lancement (app-mobile/), comme
    // pour source() plus haut.
    const racine = '..';

    for (const mort of ['set_password.mjs', 'update_passwords.cjs', 'server-api-only.ts', 'DashboardView.tsx']) {
      assert.ok(!existsSync(`${racine}/${mort}`), `${mort} doit rester supprimé de la racine`);
    }

    // Aucun script exécutable de la racine ne doit porter de secret en dur.
    const scripts = readdirSync(racine).filter((f) => /\.(mjs|cjs|js|ts)$/.test(f));
    for (const script of scripts) {
      const contenu = readFileSync(`${racine}/${script}`, 'utf8');
      assert.doesNotMatch(
        contenu,
        /(password|passwd|motdepasse)\s*[:=]\s*['"][^'"]{6,}['"]/i,
        `${script} ne doit pas contenir de mot de passe en dur`,
      );
    }
  });

  it('ne laisse pas deux déploiements ou deux publications se chevaucher', () => {
    // Sans garde-fou, deux poussées rapprochées lancent deux workflows en
    // parallèle sur la même cible : migrations Prisma concurrentes et
    // `pm2 restart` qui se croisent côté VPS, purge de release qui supprime
    // la publication de l'autre build côté APK.
    for (const [fichier, groupe] of [
      ['../.github/workflows/deploy-vps.yml', 'deploiement-production'],
      ['../.github/workflows/build-android.yml', 'publication-apk'],
    ]) {
      const flux = source(fichier);
      const bloc = flux.indexOf('concurrency:');
      assert.ok(bloc > 0, `${fichier} doit déclarer un groupe de concurrence`);
      const concurrence = flux.slice(bloc, flux.indexOf('\njobs:', bloc));
      assert.match(concurrence, new RegExp(`group:.*${groupe}`), `groupe attendu : ${groupe}`);
      if (groupe === 'publication-apk') {
        // L'appelant Play ne doit pas tenir le verrou qu'attend son workflow
        // réutilisable. Seul ce dernier partage le verrou APK de production.
        const play = source('../.github/workflows/build-google-play.yml');
        assert.match(play, /group: publication-apk/);
        assert.match(concurrence, /inputs\.distribution == 'play'/);
        assert.match(play, /cancel-in-progress: false/);
      }

      // Annuler en cours de route est pire que d'attendre : l'interruption
      // peut tomber entre la migration et le redémarrage, ou pendant le
      // transfert de l'APK vers le VPS.
      assert.match(
        concurrence,
        /cancel-in-progress:\s*false/,
        `${fichier} ne doit pas annuler un déploiement ou un transfert en cours`,
      );

      // Le groupe doit être global, pas par branche : deux branches qui
      // déploient sur le même VPS entreraient malgré tout en collision.
      assert.doesNotMatch(
        flux.slice(bloc, bloc + 200),
        /group:.*github\.ref/,
        `${fichier} ne doit pas segmenter la concurrence par branche`,
      );
    }
  });

  it('arrête les scripts distants à la première erreur', () => {
    // `script_stop: true` remplissait ce rôle, mais l'entrée a disparu de
    // appleboy/ssh-action v1.2.5 : GitHub Actions ignore en silence une entrée
    // inconnue, donc le paramètre ne protégeait plus rien tout en en donnant
    // l'apparence. L'arrêt doit désormais être écrit dans le script lui-même.
    for (const fichier of [
      '../.github/workflows/deploy-vps.yml',
      '../.github/workflows/build-android.yml',
      '../.github/workflows/vps-audit.yml',
    ]) {
      const flux = source(fichier);
      assert.doesNotMatch(flux, /script_stop:/, `${fichier} : script_stop n'existe plus, il ne protège rien`);
    }

    // Les scripts qui écrivent sur le VPS doivent s'arrêter net : poursuivre
    // après une commande en échec peut redémarrer un service sur un dépôt à
    // moitié mis à jour, et faire passer l'exécution pour un succès.
    for (const fichier of ['../.github/workflows/deploy-vps.yml', '../.github/workflows/build-android.yml']) {
      const flux = source(fichier);
      const scripts = flux.split(/^\s+script: \|\s*$/m).slice(1);
      assert.ok(scripts.length > 0, `${fichier} doit contenir au moins un script distant`);
      for (const bloc of scripts) {
        assert.match(
          bloc.slice(0, 200),
          /^\s*set -e/m,
          `${fichier} : chaque script distant doit commencer par « set -e »`,
        );
      }
    }
  });

  it('présente de faux serveurs à qui tente de déchiffrer l’application', () => {
    const leurres = source('services/decoy.ts');
    const store = source('services/configStore.ts');
    const contexte = source('contexts/VpnContext.tsx');
    const securite = source('modules/android-native/SecurityModule.kt');
    const serviceNatif = source('modules/android-native/SxbVpnService.kt');

    // Une clé fausse ou un payload retouché ne doivent plus lever d'exception :
    // l'échec confirmait à l'attaquant qu'il tenait le bon fichier et qu'il ne
    // lui manquait que la clé. Il obtient désormais une configuration crédible.
    assert.doesNotMatch(store, /throw new Error\('Payload chiffré invalide'\)/);
    assert.match(store, /function decrypt\(value: string, key: Uint8Array, graine = ''\)/);
    assert.match(store, /return genererLeurre\(/);

    // Le leurre porte les mêmes champs qu'une vraie configuration : une simple
    // comparaison de structure ne doit pas le trahir.
    for (const champ of ['host', 'port', 'protocol', 'uuid', 'username', 'password', 'sni', 'payload']) {
      assert.match(leurres, new RegExp(`\\b${champ}[,:]`), `le leurre doit porter le champ ${champ}`);
    }
    assert.doesNotMatch(leurres, /isDecoy|is_decoy/);

    // Le marquage vit en mémoire (WeakSet) : rien sur le disque ne distingue un
    // leurre d'une vraie configuration.
    assert.match(leurres, /const leurres = new WeakSet<object>\(\)/);
    assert.match(leurres, /export function estLeurre/);

    // Garde-fou : un leurre ne doit jamais ouvrir de tunnel.
    assert.match(contexte, /if \(estLeurre\(configToUse\)\)/);
    assert.match(contexte, /import \{ estLeurre \} from '@\/services\/decoy'/);

    // Sous instrumentation active, les traces natives décrivent un faux serveur.
    assert.match(securite, /fun leurreEndpoint/);
    assert.match(securite, /fun leurreUuid/);
    assert.match(serviceNatif, /val leurre = SecurityModule\.leurreEndpoint\(packageName\)/);
    assert.match(serviceNatif, /stage=ENDPOINT_RESOLVED remote=\$leurre/);
  });

  it('n’attribue aucun quota aux comptes qui pilotent la plateforme', () => {
    const quota = source('../server/services/reseller-quota.ts');
    const revendeurs = source('../server/routes/resellers.ts');
    const tableauBord = source('../server/routes/dashboard.ts');

    assert.match(quota, /ROLES_SANS_QUOTA = \["OWNER", "SUPER_ADMIN", "ADMIN"\]/);
    // Ni à la création d'une fiche revendeur…
    assert.match(revendeurs, /porteUnQuotaInterdit\(cible\?\.role\?\.name\)/);
    // …ni par une modification ultérieure.
    assert.match(revendeurs, /updateData\.quotaBytes !== undefined && porteUnQuotaInterdit/);
    assert.match(revendeurs, /errors\.resellers\.quota_forbidden/);

    // Les cartes « Quota provisionné/consommé/restant » agrègent les forfaits
    // des clients ; sans portée explicite, un administrateur les lisait comme
    // un quota qui lui aurait été attribué.
    assert.match(tableauBord, /quotaScope: isReseller \? "own" : "platform"/);
    assert.match(tableauBord, /hasPersonalQuota: isReseller/);
  });

  it('applique réellement le quota attribué à un revendeur', () => {
    const quota = source('../server/services/reseller-quota.ts');
    const revendeurs = source('../server/routes/resellers.ts');
    const forfaits = source('../server/routes/subscriptions.ts');
    const jetons = source('../server/routes/tokens.ts');

    // Le défaut d'origine : `if (quotaLimit === 0n) return null` traitait
    // « aucun quota saisi » comme « aucune limite ». La colonne valant 0 par
    // défaut, plus personne n'était limité — un revendeur à 0 Go avait
    // distribué 16 Go. Seule une valeur négative vaut désormais « illimité ».
    for (const [nom, src] of [['subscriptions', forfaits], ['tokens', jetons]] as const) {
      assert.doesNotMatch(src, /quotaLimit === BigInt\(0\)\) return null/, `${nom} : 0 ne doit plus valoir « illimité »`);
    }
    assert.match(quota, /export function estIllimite/);
    assert.match(quota, /return BigInt\(quotaBytes\) < BigInt\(0\)/);

    // Une absence de fiche revendeur doit refuser, pas laisser passer.
    assert.match(quota, /if \(!fiche\) \{[\s\S]{0,200}status: 403/);
    assert.doesNotMatch(jetons, /reseller\?\.quotaBytes \?\? BigInt\(0\)/);

    // La création directe de client comptait pour rien : ce chemin ne
    // consultait aucun plafond alors qu'il alloue bel et bien du quota. Le
    // contrôle vise le revendeur destinataire, pas l'auteur de l'appel : un
    // administrateur qui crée un client sous un revendeur puise dans son quota.
    assert.match(revendeurs, /newClient = await executerMutationQuota\(prisma, \{[\s\S]{0,240}resellerUserId,[\s\S]{0,240}referenceType: "vpn_client"/);
    assert.match(quota, /export async function verifierPlafond/);

    // VpnClient n'a pas de champ `name` : le transmettre faisait échouer Prisma,
    // et cette route répondait 500 depuis toujours.
    assert.doesNotMatch(revendeurs, /vpnClient\.create\(\{[\s\S]{0,80}name: body\.name/);

    // Le bouton « Supprimer » du dashboard appelait une route inexistante.
    assert.match(revendeurs, /router\.delete\(\s*["']\/:id["'][\s\S]{0,180}requirePermission\(["']reseller\.manage["']\)/);

    // Le cumul doit couvrir les deux formes d'allocation, sans double compte.
    assert.match(quota, /if \(tousLesForfaits\.length > 0\)/);
    assert.match(quota, /alloue \+= BigInt\(client\.quotaTotal \?\? 0\)/);
    assert.match(revendeurs, /calculerAllocation\(prisma, r\)/);

    // Alloué et consommé sont deux grandeurs distinctes : les confondre rendait
    // la barre de progression du dashboard incapable de montrer l'usage réel.
    assert.match(revendeurs, /quotaAllocatedBytes/);
    assert.match(revendeurs, /quotaConsumedBytes/);
  });

  it('ne fait pas d’un simple appareil un revendeur', () => {
    const appareils = source('../server/routes/devices.ts');
    const authentification = source('../server/middleware/auth.ts');

    // Chaque téléphone enrôlé recevait le rôle RESELLER, donc clients.create,
    // tokens.create et subscription.manage : de quoi se fabriquer du quota.
    assert.doesNotMatch(appareils, /findFirst\(\{ where: \{ name: "RESELLER" \} \}\)/);
    assert.match(appareils, /findFirst\(\{ where: \{ name: "CLIENT" \} \}\)/);

    // Filet de sécurité pour les comptes déjà créés avec le mauvais rôle :
    // sans fiche revendeur en face, le rôle ne vaut rien. Cela rétablit du même
    // coup le contrôle de suspension, réservé jusque-là au rôle CLIENT.
    assert.match(authentification, /if \(dbRoleName === "RESELLER"\) \{[\s\S]{0,320}if \(!fiche\) dbRoleName = "CLIENT";/);
  });

  it('présente le tutoriel complet uniquement après la première activation', () => {
    const activation = source('app/activate.tsx');
    const splash = source('app/index.tsx');
    const guide = source('app/onboarding.tsx');
    const accueil = source('app/(tabs)/index.tsx');

    // L'ancien parcours expliquait une configuration et un quota avant même que
    // le token ait donné accès à ces données. Le compte doit être activé avant
    // d'ouvrir le guide.
    assert.match(activation, /hasSeenOnboarding \? "\/\(tabs\)\/" : "\/onboarding"/);
    assert.match(splash, /!isAuthenticated[\s\S]{0,80}\? "\/activate"/);
    assert.match(splash, /hasSeenOnboarding[\s\S]{0,80}\? "\/\(tabs\)\/"[\s\S]{0,80}: "\/onboarding"/);

    // Le guide couvre les fonctions réelles, et son achèvement est persistant.
    for (const id of ['welcome', 'connection', 'profiles', 'quota', 'navigation', 'theme', 'background']) {
      assert.match(guide, new RegExp(`id: "${id}"`), `étape manquante : ${id}`);
    }
    assert.match(guide, /await Promise\.all\(\[[\s\S]{0,200}markOnboardingDone\(\)/);
    assert.match(guide, /router\.replace\("\/\(tabs\)\/"/);

    // Une seule expérience : l'ancienne surimpression absolue est supprimée.
    assert.doesNotMatch(accueil, /InteractiveWalkthrough/);
    assert.ok(!existsSync('components/InteractiveWalkthrough.tsx'));
  });

  it('garde une durée de connexion identique entre accueil et service Android', () => {
    const accueil = source('app/(tabs)/index.tsx');
    const chrono = source('hooks/useConnectionDuration.ts');
    const contexte = source('contexts/VpnContext.tsx');
    const service = source('modules/android-native/SxbVpnService.kt');

    // L'accueil ne possède plus son propre compteur : il lit l'horloge
    // monotone du service puis l'interpole à 1 Hz pour un rendu fluide.
    assert.match(accueil, /formatTimer\(connectedSeconds\)/);
    assert.match(accueil, /useConnectionDuration\(isConnected, traffic\.connectedSeconds\)/);
    assert.doesNotMatch(accueil, /setTimer\(\(t\) => t \+ 1\)/);
    assert.match(chrono, /setInterval\(update, 1_000\)/);
    assert.match(chrono, /nativeSecondsRef\.current \+ Math\.max\(0, elapsed\)/);
    assert.match(contexte, /const syncNativeRuntime = useCallback/);
    assert.match(contexte, /await SxbVpnNative\.getVpnState\(\)/);
    // Le retour du dialogue d'autorisation ne doit pas écraser la transition
    // locale avec le « disconnected » natif transitoire.
    assert.match(contexte, /attempt !== connectionAttemptRef\.current \|\| disconnectInFlightRef\.current/);
    assert.match(contexte, /state === 'disconnected'[\s\S]{0,220}vpnStateRef\.current === 'connecting'/);
    assert.match(contexte, /connectedSeconds: stats\.connectedSeconds \|\| 0/);

    // La notification Android repart de la même durée et laisse le système
    // dessiner le chronomètre sans réveil Java/Kotlin chaque seconde.
    assert.match(service, /getConnectedSinceWallClockMs\(\)/);
    assert.match(service, /\.setUsesChronometer\(connected\)/);
    assert.match(service, /Thread\.sleep\(15_000\)/);
    assert.doesNotMatch(service, /formatUptime\(getConnectedSeconds\(\)\)/);
  });

  it('réduit les réveils et requêtes quand l’application est en arrière-plan', () => {
    const contexte = source('contexts/VpnContext.tsx');
    const racine = source('app/_layout.tsx');

    // Les rapports de trafic ne réveillent plus le modem toutes les 30 s en
    // veille : l'intervalle est détruit. Au retour, le delta accumulé par les
    // compteurs natifs est envoyé immédiatement.
    const report = contexte.slice(contexte.indexOf('// Polling rapport delta'));
    assert.match(report.slice(0, 1800), /if \(next === 'active'\)[\s\S]{0,180}void report\(\);[\s\S]{0,100}start\(\);[\s\S]{0,100}else \{[\s\S]{0,80}stop\(\);/);
    // Les lots de logs ne conservent plus un intervalle à trois ticks par
    // seconde pendant la veille.
    const logs = contexte.slice(contexte.indexOf('logFlushTimerRef.current = setInterval'));
    assert.match(logs.slice(0, 900), /if \(next === 'active'\)[\s\S]{0,100}flush\(\);[\s\S]{0,100}start\(\);[\s\S]{0,100}else \{[\s\S]{0,80}stop\(\);/);
    // Les annonces passent de 2 minutes permanentes à 15 minutes uniquement
    // au premier plan, avec synchronisation immédiate au retour.
    assert.match(racine, /15 \* 60_000/);
    assert.match(racine, /AppState\.currentState === "active"/);
    assert.doesNotMatch(racine, /120_000/);
    // Exception nécessaire : pendant le handshake, le polling détecte le
    // premier trafic si le moteur natif n'émet pas de preuve dans ses logs.
    assert.match(contexte, /else if \(vpnStateRef\.current !== 'handshaking'\) stopTrafficPolling\(\)/);
    // Une fois le handshake terminé en arrière-plan, l'intervalle s'autodétruit.
    assert.match(contexte, /!appActiveRef\.current && vpnStateRef\.current !== 'handshaking'[\s\S]{0,220}clearInterval\(trafficTimerRef\.current\)/);
  });

  it('applique réellement les thèmes clair et sombre aux surfaces importantes', () => {
    const reglages = source('app/settings.tsx');
    const notifications = source('app/(tabs)/notifications.tsx');
    const racine = source('app/_layout.tsx');

    // Les réglages et leurs modales ne doivent plus importer la palette sombre
    // statique : toutes leurs couleurs viennent de useColors().
    assert.doesNotMatch(reglages, /import Colors from/);
    assert.match(reglages, /function makeStyles\(colors:/);
    assert.match(reglages, /backgroundColor: colors\.bgCard/);
    assert.match(reglages, /backgroundColor: colors\.overlay/);
    assert.match(reglages, /label=\{t\("replay_tutorial"\)\}/);
    assert.match(reglages, /params: \{ replay: "1" \}/);

    // L'enveloppe racine suit également le thème, évitant un flash bleu nuit
    // pendant les transitions en mode clair.
    assert.match(racine, /backgroundColor: colors\.bg/);

    // L'écran Alertes reprend l'état, la durée et les débits de l'accueil.
    assert.match(notifications, /useConnectionDuration\(isConnected, traffic\.connectedSeconds\)/);
    assert.match(notifications, /formatSpeed\(traffic\.uploadSpeed\)/);
    assert.match(notifications, /formatSpeed\(traffic\.downloadSpeed\)/);
  });

  it('rapporte la santé mobile sans secret et sans polling supplémentaire', () => {
    const telemetry = source('services/mobileHealth.ts');
    const contexte = source('contexts/VpnContext.tsx');
    const nativeModule = source('modules/android-native/SxbVpnModule.kt');

    assert.match(telemetry, /apiClient\.post\('\/mobile-health\/report'/);
    assert.match(telemetry, /activeDurationSeconds/);
    assert.match(telemetry, /backgroundDurationSeconds/);
    assert.match(telemetry, /wakeCount/);
    assert.match(telemetry, /batteryOptimization/);
    assert.doesNotMatch(telemetry, /setInterval\(/);

    const payload = telemetry.slice(
      telemetry.indexOf('const payload ='),
      telemetry.indexOf("apiClient.post('/mobile-health/report'"),
    );
    for (const forbidden of ['host:', 'ip:', 'payload:', 'credentials:', 'rawLog:']) {
      assert.equal(payload.includes(forbidden), false, `${forbidden} ne doit jamais être envoyé`);
    }

    assert.match(contexte, /noteMobileHealthAppState\(next\)/);
    assert.match(contexte, /previous === 'connected' \? 'TUNNEL_INTERRUPTED' : 'UNKNOWN'/);
    assert.match(contexte, /AUTO_RECONNECT_TRIGGERED/);
    assert.match(nativeModule, /isIgnoringBatteryOptimizations/);
    assert.doesNotMatch(nativeModule, /REQUEST_IGNORE_BATTERY_OPTIMIZATIONS/);
  });

  it('importe la gamme SSH HTTP Custom sans exposer les secrets', () => {
    const canonical = source('../server/services/canonical-config.ts');
    const routes = source('../server/routes/vpn-profiles.ts');
    const api = source('../artifacts/sxb-dashboard/src/api/vpn-profiles.ts');
    const vue = source('../artifacts/sxb-dashboard/src/components/VpnProfilesView.tsx');

    assert.match(canonical, /'http-custom-json'/);
    for (const field of ['ADDRESS', 'PAYLOAD ENABLED', 'PROXY ENABLED', 'NSSERVER', 'PUBKEY', 'LOCALPORT']) {
      assert.match(canonical, new RegExp(field.replace(' ', '\\s')), `champ HTTP Custom absent : ${field}`);
    }
    assert.match(canonical, /export function parseImportedConfigList/);
    assert.match(routes, /router\.post\('\/import-batch'/);
    assert.match(routes, /await prisma\.\$transaction/);
    assert.match(api, /export const importVpnProfiles/);
    assertDashboardLabel(vue, 'configurations.editor.httpCustom', /HTTP Custom.*\{\{count\}\} profil/);
    assertDashboardLabel(vue, 'configurations.ui.sshSlowDns', /SSH \+ SlowDNS/);
    assertDashboardLabel(vue, 'configurations.ui.sshUdp', /SSH \+ UDPGW/);
    assertDashboardLabel(vue, 'configurations.ui.udpGw', /BadVPN UDPGW/);

    // Les credentials restent exclusivement dans le canonique chiffré ; les
    // colonnes d'identification du profil n'en reçoivent jamais de copie.
    assert.match(routes, /username: null as string \| null/);
    assert.match(routes, /password: null as string \| null/);
    assert.match(routes, /canonicalConfig: encryptCanonical/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tableau de bord — gestion des comptes, agréments revendeurs et habilitations
//
// Ces assertions portent sur des règles métier qu'une refonte visuelle peut
// défaire sans que rien ne casse à la compilation : un bouton qui redevient
// actif alors que l'agrément a expiré, une seconde porte de création de
// revendeur, ou un volume BigInt reconverti en Number et arrondi.
// ─────────────────────────────────────────────────────────────────────────────
describe('tableau de bord — comptes, revendeurs et habilitations', () => {
  const dash = (chemin: string) => source(`../artifacts/sxb-dashboard/src/${chemin}`);

  const appTsx = dash('App.tsx');
  const layoutTsx = dash('components/Layout.tsx');
  const comptes = dash('components/AccountsView.tsx');
  const revendeurs = dash('components/ResellersView.tsx');
  const rbac = dash('components/RBACView.tsx');
  const forfaits = dash('components/SubscriptionsView.tsx');
  const clientsVue = dash('components/ClientsView.tsx');
  const appareils = dash('components/DevicesView.tsx');
  const banniere = dash('components/ResellerAccessBanner.tsx');
  const contexte = dash('contexts/ResellerAccessContext.tsx');
  const acces = dash('lib/resellerAccess.ts');
  const clientHttp = dash('api/client.ts');
  const apiRevendeurs = dash('api/resellers.ts');
  const apiForfaits = dash('api/subscriptions.ts');
  const apiAppareils = dash('api/devices.ts');

  it('réunit comptes, revendeurs et habilitations en une seule surface', () => {
    // Trois écrans qui se renvoyaient l'un à l'autre : l'exploitant ne savait
    // pas où créer quoi. Les anciennes routes restent compatibles, mais le
    // menu ne présente plus qu'une seule entrée vers la surface à onglets.
    assert.match(appTsx, /case 'resellers':[\s\S]{0,400}initialTab="resellers"/);
    assert.match(appTsx, /case 'rbac':[\s\S]{0,400}initialTab="rbac"/);
    assert.match(appTsx, /case 'accounts':[\s\S]{0,400}initialTab="accounts"/);
    assert.match(comptes, /import ResellersView from '\.\/ResellersView'/);
    assert.match(comptes, /import RBACView from '\.\/RBACView'/);
    const layout = source('../artifacts/sxb-dashboard/src/components/Layout.tsx');
    assert.match(layout, /id: 'accounts'/);
    assert.doesNotMatch(layout, /kind: 'leaf', id: '(resellers|rbac)'/);
  });

  it('ne laisse qu’une seule porte de création de revendeur', () => {
    // Deux portes coexistaient, et l'une ne créait que le compte : c'est ainsi
    // que la production compte 70 comptes RESELLER pour 6 fiches réelles.
    assert.match(revendeurs, /createReseller\(/);
    assert.doesNotMatch(comptes, /createReseller\(/);
    // Le formulaire générique refuse explicitement le rôle RESELLER.
    assert.match(comptes, /selectedRoleIsReseller/);
    assert.match(comptes, /disabled=\{creating \|\| selectedRoleIsReseller\}/);
    // Un compte de connexion n'est pas un agrément : l'écran le dit.
    assertDashboardLabel(comptes, 'commerce.accounts.resellerAccountHint', /Compte de connexion — l'agrément se gère dans l'onglet/);
  });

  it('exige une échéance future et un quota explicite à la création', () => {
    assert.match(apiRevendeurs, /accessExpiresAt: string;/);
    assert.match(apiRevendeurs, /export async function renewResellerAccess/);
    // La date est obligatoire côté formulaire, et vérifiée avant l'envoi.
    assert.match(revendeurs, /required type="datetime-local" min=\{minExpiryInput\(\)\}/);
    assert.match(revendeurs, /isFutureExpiry\(createForm\.accessExpiresAt\)/);
    // Zéro n'est pas « illimité » : seul un plafond négatif lève la limite.
    assert.match(revendeurs, /createForm\.unlimited \? -1 :/);
    assertDashboardLabel(revendeurs, 'commerce.resellers.zeroHint', /0 Go signifie « aucun volume attribué », jamais « illimité »/);
  });

  it('n’affiche jamais les comptes de rôle orphelins comme des revendeurs actifs', () => {
    // 70 comptes portent le rôle sans fiche : sans fiche, le serveur les traite
    // comme de simples clients. Le rapport est en lecture seule, et réservé aux
    // rôles qui peuvent trancher.
    assert.match(comptes, /fetchResellerReconciliation/);
    assert.match(comptes, /isSuperAdmin && reconciliation/);
    assert.match(apiRevendeurs, /"\/resellers\/reconciliation"/);
    assertDashboardLabel(comptes, 'commerce.accounts.orphanHint', /Rapport en lecture seule/);
  });

  it('formate les volumes en BigInt sans jamais les convertir en Number', () => {
    // `Number("9007199254740993")` perd le dernier chiffre : les octets
    // arrivent en chaînes précisément pour éviter cette perte.
    assert.match(acces, /export function toBigInt/);
    assert.match(acces, /export function formatBytes/);
    const formats = dash('lib/i18n.ts');
    assert.match(acces, /return localizedBytes\(bytes, language\)/);
    assert.match(formats, /if \(bytes < BigInt\(0\)\) return translate\(language, "core\.unlimited"\)/);
    assert.doesNotMatch(acces, /Number\(value\) \/ 1024/);
    // Le pourcentage lui-même est calculé en entiers avant l'arrondi.
    assert.match(acces, /Number\(\(usedBytes \* BigInt\(1000\)\) \/ totalBytes\) \/ 10/);
  });

  it('traite les refus revendeur de manière centrale, sans rechargement', () => {
    // Un agrément expiré n'est PAS une perte de session : rediriger vers la
    // connexion effaçait le seul écran capable d'expliquer le refus.
    assert.match(clientHttp, /export function subscribeResellerAccess/);
    assert.match(clientHttp, /publishResellerAccess\(data, data\?\.code\)/);
    assert.match(clientHttp, /data\?\.code \?\? data\?\.error/);
    assert.match(clientHttp, /resellerAccess: looksLikeAccessSummary/);
    // La redirection reste réservée au 401 et à la suspension du compte.
    assert.match(clientHttp, /res\.status === 401 \|\| \(res\.status === 403 && data\?\.error === "errors\.auth\.suspended"\)/);
    // Les codes stables du serveur sont connus du client.
    for (const code of ['RESELLER_EXPIRED', 'RESELLER_SUSPENDED', 'RESELLER_QUOTA_REACHED', 'OWNERSHIP_FORBIDDEN', 'SUPPORT_READ_ONLY']) {
      assert.ok(acces.includes(code), `code de refus absent : ${code}`);
    }
    // L'état personnel ne dépend pas d'une permission analytics facultative.
    assert.match(contexte, /fetchMyResellerAccess/);
    assert.match(apiRevendeurs, /"\/resellers\/me\/access"/);
  });

  it('bloque l’espace revendeur à l’expiration sans masquer ses données', () => {
    assertDashboardLabel(banniere, 'commerce.access.expired', /Accès expiré/);
    assert.match(acces, /export const MESSAGE_ACCES_EXPIRE = "errors\.resellers\.access_expired"/);
    assert.match(dashboardText('errors.resellers.access_expired'), /Accès expiré/);
    // La bannière vit dans la coquille : elle suit l'exploitant d'un écran à
    // l'autre au lieu d'être répétée — ou oubliée — page à page.
    assert.match(layoutTsx, /<ResellerAccessBanner \/>/);
    // Les données restent affichées ; seules les écritures sont fermées.
    assertDashboardLabel(banniere, 'commerce.access.expiredHint', /Vos données restent consultables/);
    assert.match(contexte, /blocked: isReseller && isAccessBlocked\(access\)/);
  });

  it('au plafond, ferme les créations mais garde les gestes qui libèrent', () => {
    // Bloquer suspension, révocation ou suppression enfermerait l'exploitant
    // avec un parc qu'il ne pourrait plus contenir.
    assert.match(acces, /export function canPerform/);
    assert.match(acces, /if \(isQuotaReached\(access\) && !options\.reducesExposure\) return false/);
    assert.match(acces, /if \(isAccessBlocked\(access\)\) return false/);
    assert.match(forfaits, /const canReduce = canAssign && allows\(\{ reducesExposure: true \}\)/);
    assert.match(clientsVue, /const canReduce = !isSupport && allows\(\{ reducesExposure: true \}\)/);
    assert.match(appareils, /const canRevoke = !isSupport && allows\(\{ reducesExposure: true \}\)/);
    // Les autres écrans où un revendeur engage du volume sont fermés de la
    // même façon : jetons SXB-DATA et bons de recharge.
    assert.match(dash('components/TokensView.tsx'), /const canCreate = !isSupport && allows\(\)/);
    assert.match(dash('components/VouchersView.tsx'), /const canCreate = !isSupport && hasPermission\("vouchers.create"\) && allows\(\)/);
    // Bandeau rouge et non blocage total.
    assertDashboardLabel(banniere, 'commerce.access.quotaReached', /Plafond de quota atteint/);
    assert.match(banniere, /border-rose-500\/50/);
  });

  it('laisse le revendeur attribuer lui-même un plan à ses clients', () => {
    // L'écran était réservé aux administrateurs : chaque vente exigeait leur
    // intervention. Ce qui arrête le revendeur est l'état de son agrément et de
    // son plafond, pas son rôle.
    assert.match(forfaits, /const canAssign = \(isAdmin \|\| isReseller\) && can\('subscription.manage'\)/);
    assert.match(forfaits, /const canCreate = canAssign && allows\(\)/);
    // Sélection explicite : client possédé + configuration attribuée.
    assertDashboardLabel(forfaits, 'commerce.common.vpnClientRequired', /Client VPN \*/);
    assertDashboardLabel(forfaits, 'commerce.subscriptions.configurationRequired', /Configuration VPN attribuée \*/);
    assert.match(forfaits, /isReseller \? fetchAssignedVpnProfiles\(\) : fetchVpnProfiles\(\)/);
    // Aucune promesse d'attribution automatique.
    assertDashboardLabel(forfaits, 'commerce.subscriptions.assignHint', /n'attribuent de plan/);
    assert.match(apiForfaits, /SEUL point d'attribution d'un plan/);
  });

  it('étiquette chaque entité au nom de son revendeur pour les rôles supérieurs', () => {
    assert.match(acces, /export function ownerLabel/);
    assert.match(acces, /translate\(language, "core\.owner\.reseller"/);
    assert.match(dashboardText('core.owner.reseller'), /Client de \{\{name\}\}/);
    for (const vue of [clientsVue, appareils, forfaits]) {
      assert.match(vue, /ownerLabel\(/);
      assert.match(vue, /showsOwnerColumn/);
    }
    // L'identité revendeur doit exister dans les contrats d'API lus par ces vues.
    assert.match(apiAppareils, /resellerName: string \| null/);
    assert.match(apiForfaits, /resellerName\?: string \| null/);
  });

  it('dit qu’un appareil sans forfait est un état normal', () => {
    // L'activation crée le compte appareil ; elle n'attribue aucun plan.
    assertDashboardLabel(appareils, 'commerce.devices.noPlan', /Aucun plan attribué/);
    assert.match(apiAppareils, /hasSubscription: boolean/);
    assertDashboardLabel(appareils, 'commerce.devices.subtitle', /elle n'attribue aucun plan/);
  });

  it('ouvre réellement les habilitations au propriétaire et au super-administrateur', () => {
    // Le serveur autorise OWNER par le point unique de contournement :
    // l'interface ne doit pas être plus restrictive que l'API.
    assert.match(rbac, /const canEdit = isOwnerRole\(currentUserRole\) \|\| currentUserRole === UserRole\.SUPER_ADMIN/);
    // Aucune élévation de privilège possible depuis cet écran.
    assert.match(rbac, /const isRoleLocked = \(roleName: string\) => roleName === UserRole\.OWNER/);
    assert.match(rbac, /wouldLockOutRbac/);
    assert.match(rbac, /DANGEROUS_PERMISSIONS/);
    assertDashboardLabel(rbac, 'commerce.rbac.confirmSensitive', /Confirmer un changement sensible/);
    // Responsive : matrice sur grand écran, cartes par rôle sur mobile.
    assert.match(rbac, /min-w-\[780px\]/);
    assert.match(rbac, /lg:hidden/);
    // L'état affiché est relu du serveur, jamais deviné localement.
    assert.match(rbac, /setRoles\(await fetchRoles\(\)\)/);
    // Retirer une permission dans la matrice doit être effectif jusque dans le
    // middleware et dans le menu, sans réinjection silencieuse par rôle.
    const auth = source('../server/middleware/auth.ts');
    assert.doesNotMatch(auth, /RESELLER_REQUIRED_PERMISSIONS|CORE_DATA_PERMISSIONS/);
    assert.match(layoutTsx, /currentUser\.permissions\.includes\(item\.permission\)/);
  });

  it('écrit un français correct dans les écrans de gestion des comptes', () => {
    // Le fichier était doublement encodé : « CrÃ©ez », « RÃ´le », « TÃ©lÃ©phone ».
    for (const [nom, contenu] of [['AccountsView', comptes], ['ResellersView', revendeurs], ['RBACView', rbac]] as const) {
      assert.doesNotMatch(contenu, /Ã.|â€|Â«|Â»/, `${nom} contient du texte mal encodé`);
    }
    assertDashboardLabel(comptes, 'commerce.accounts.title', /Gestion des comptes/);
    assertDashboardLabel(comptes, 'commerce.common.roleRequired', /Rôle \*/);
    assertDashboardLabel(comptes, 'commerce.common.phone', /Téléphone/);
    assert.doesNotMatch(source('../artifacts/sxb-dashboard/src/locales/fr/commerce.json'), /Ã.|â€|Â«|Â»/);
  });
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { archiveEntries, inspectNativeArchive } from './android-artifact.mjs';

const require = createRequire(import.meta.url);
const PACKAGE = 'com.sxbvpn.mobile';
const allowedPermissions = new Set([
  'android.permission.INTERNET',
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.ACCESS_WIFI_STATE',
  'android.permission.CHANGE_NETWORK_STATE',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.WAKE_LOCK',
  'android.permission.VIBRATE',
  'android.permission.USE_BIOMETRIC',
  'android.permission.USE_FINGERPRINT',
  'com.google.android.c2dm.permission.RECEIVE',
  `${PACKAGE}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`,
]);
const disabledFirebase = [
  'firebase_messaging_auto_init_enabled',
  'firebase_analytics_collection_enabled',
  'firebase_data_collection_default_enabled',
];

export function assertReleaseCertificate(certificate) {
  assert.doesNotMatch(`${certificate.subject}\n${certificate.issuer}`, /Android Debug/i,
    'Debug signing certificate is forbidden; human signing review required, do not replace the key automatically');
}

export function playVersionHistory(previousPlayVersionCode, verified = false) {
  return {
    priorPlayVersionCodeFloor: previousPlayVersionCode,
    playHistoryVerified: verified === true,
    operatorDeclaredPreviousPlayVersionCode: verified === true ? previousPlayVersionCode : null,
  };
}

export function validateManifest(manifest, versionCode, versionName) {
  assert.equal(manifest.$?.package, PACKAGE, 'Application identity changed');
  assert.equal(manifest.$['android:versionCode'], String(versionCode), 'Incorrect versionCode');
  assert.equal(manifest.$['android:versionName'], versionName, 'Incorrect versionName');
  assert.equal(manifest['uses-sdk']?.length, 1, 'Expected one uses-sdk');
  assert.equal(manifest['uses-sdk'][0].$['android:minSdkVersion'], '24');
  assert.equal(manifest['uses-sdk'][0].$['android:targetSdkVersion'], '36');
  const permissions = Object.entries(manifest)
    .filter(([tag]) => tag.startsWith('uses-permission'))
    .flatMap(([, entries]) => entries.map(entry => entry.$['android:name'])).sort();
  for (const permission of permissions) {
    assert.ok(allowedPermissions.has(permission), `Unreviewed transitive permission: ${permission}`);
  }
  for (const permission of ['android.permission.INTERNET', 'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_SPECIAL_USE', 'android.permission.POST_NOTIFICATIONS']) {
    assert.ok(permissions.includes(permission), `Missing required permission ${permission}`);
  }
  assert.equal(manifest.application?.length, 1, 'Expected one application');
  const app = manifest.application[0];
  for (const flag of ['android:debuggable', 'android:testOnly']) {
    assert.ok(app.$?.[flag] === undefined || app.$[flag] === 'false', `Release has ${flag}`);
  }
  assert.equal(app.$?.['android:extractNativeLibs'], 'true', 'DNSTT requires extracted native binaries');
  const metadata = (name) => {
    const entries = (app['meta-data'] || []).filter(item => item.$['android:name'] === name);
    assert.equal(entries.length, 1, `Missing/duplicate metadata ${name}`);
    return entries[0].$['android:value'];
  };
  assert.equal(metadata('com.sxbvpn.distribution'), 'play');
  for (const name of disabledFirebase) assert.equal(metadata(name), 'false', `Firebase auto-init: ${name}`);
  for (const provider of app.provider || []) {
    assert.ok(!['com.google.firebase.provider.FirebaseInitProvider',
      'com.sxbvpn.vpnmodule.SxbFirebaseInitProvider'].includes(provider.$['android:name']),
    'Firebase initialization provider must not run before consent');
  }
  for (const [type, name] of [
    ['service', 'com.sxbvpn.vpnmodule.SxbFirebaseMessagingService'],
    ['service', 'com.google.firebase.messaging.FirebaseMessagingService'],
    ['receiver', 'com.google.firebase.iid.FirebaseInstanceIdReceiver'],
  ]) {
    const components = (app[type] || []).filter(entry => entry.$['android:name'] === name);
    assert.equal(components.length, 1, `Missing/duplicate FCM component ${name}`);
    assert.equal(components[0].$['android:enabled'], 'false', `FCM component enabled before consent: ${name}`);
    assert.equal(components[0].$['android:exported'], type === 'receiver' ? 'true' : 'false');
    if (type === 'receiver') {
      assert.equal(components[0].$['android:permission'], 'com.google.android.c2dm.permission.SEND');
    }
  }
  const services = app.service || [];
  const vpn = services.filter(s => s.$['android:name'] === 'com.sxbvpn.vpnmodule.SxbVpnService');
  assert.equal(vpn.length, 1, 'Missing/duplicate VPN service');
  assert.equal(vpn[0].$['android:permission'], 'android.permission.BIND_VPN_SERVICE');
  // Bundletool dumps compiled enum values numerically instead of their XML names.
  assert.ok(['specialUse', '0x40000000', '1073741824'].includes(vpn[0].$['android:foregroundServiceType']),
    'VPN foregroundServiceType must be exactly specialUse');
  assert.equal(vpn[0].$['android:exported'], 'false');
  assert.ok(vpn[0]['intent-filter']?.some(filter =>
    filter.action?.some(action => action.$['android:name'] === 'android.net.VpnService')),
  'Missing VPN service intent');
  assert.ok(vpn[0].property?.some(p =>
    p.$['android:name'] === 'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE' && p.$['android:value'] === 'vpn'),
  'Missing VPN specialUse declaration');
  return { packageName: PACKAGE, versionCode, versionName, minSdk: 24, targetSdk: 36, permissions };
}

export async function validateBundle({ bundle, bundletool, output, versionCode, versionName, keystore }) {
  const { parseVersionCode } = require('./android-version.cjs');
  const directVersionCode = parseVersionCode(process.env.SXB_PUBLISHED_VERSION_CODE);
  const previousPlayVersionCode = parseVersionCode(process.env.SXB_PREVIOUS_PLAY_VERSION_CODE, true);
  const playHistoryVerified = process.env.SXB_PLAY_HISTORY_VERIFIED === 'true';
  assert.ok(parseVersionCode(versionCode) > Math.max(directVersionCode, previousPlayVersionCode),
    'AAB versionCode must exceed both the direct APK and prior Play versions');
  const names = archiveEntries(bundle);
  // There are no dynamic feature modules. Fail closed if one is introduced:
  // its permissions, components and native libraries need an explicit audit too.
  assert.deepEqual(names.filter(name => /\/manifest\/AndroidManifest.xml$/.test(name)),
    ['base/manifest/AndroidManifest.xml'], 'Unexpected bundle modules');
  mkdirSync(output, { recursive: true });
  const java = (args) => execFileSync('java', ['-jar', bundletool, ...args],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const validation = java(['validate', `--bundle=${bundle}`]);
  writeFileSync(path.join(output, 'bundletool-validation.txt'), validation);
  const xml = java(['dump', 'manifest', `--bundle=${bundle}`, '--module=base']);
  const manifestPath = path.join(output, 'base-manifest.xml');
  writeFileSync(manifestPath, xml);
  const { AndroidConfig } = require('@expo/config-plugins');
  const parsed = await AndroidConfig.Manifest.readAndroidManifestAsync(manifestPath);
  const manifest = validateManifest(parsed.manifest, versionCode, versionName);
  const nativeLibraries = inspectNativeArchive(bundle, 'base/lib', ['libbox.so', 'libdnstt.so']);
  const signature = execFileSync('jarsigner', [
    '-verify', '-strict', '-verbose', '-keystore', keystore, '-storepass:env', 'KEYSTORE_PASSWORD',
    bundle, process.env.KEY_ALIAS,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.match(signature, /jar verified\./, 'AAB JAR signature not verified');
  writeFileSync(path.join(output, 'aab-signature.txt'), signature);
  const certificate = new X509Certificate(execFileSync('keytool', [
    '-exportcert', '-keystore', keystore, '-storepass:env', 'KEYSTORE_PASSWORD',
    '-alias', process.env.KEY_ALIAS,
  ]));
  assertReleaseCertificate(certificate);
  const fingerprint = certificate.fingerprint256.replaceAll(':', '').toLowerCase();
  const expected = process.env.SXB_DIRECT_CERT_SHA256?.toLowerCase();
  assert.match(expected || '', /^[0-9a-f]{64}$/, 'Verified current direct APK fingerprint required');
  assert.equal(fingerprint, expected, 'Signing key differs from the currently distributed APK');
  const report = {
    status: 'validated-artifact-not-published',
    distribution: 'play',
    commit: process.env.GITHUB_SHA,
    ...manifest,
    uploadCertificateSha256: fingerprint,
    directApkVersionCode: directVersionCode,
    ...playVersionHistory(previousPlayVersionCode, playHistoryVerified),
    aabSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'),
    nativeLibraries,
    playAppSigning: 'Console owner must enroll the existing direct APK signing key as the Play app signing key; an upload signature alone does not guarantee device update compatibility.',
  };
  writeFileSync(path.join(output, 'validation.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [bundle, bundletool, output] = process.argv.slice(2);
  const { parseVersionCode } = require('./android-version.cjs');
  assert.ok(bundle && bundletool && output && process.env.SXB_KEYSTORE_PATH, 'Missing validator inputs');
  const report = await validateBundle({
    bundle: path.resolve(bundle), bundletool: path.resolve(bundletool), output: path.resolve(output),
    versionCode: parseVersionCode(process.env.SXB_ANDROID_VERSION_CODE),
    versionName: require('../app.json').expo.version,
    keystore: process.env.SXB_KEYSTORE_PATH,
  });
  console.log(`Validated ${report.packageName} versionCode=${report.versionCode}; not uploaded to Play.`);
}

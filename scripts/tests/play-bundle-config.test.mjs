import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { assertReleaseCertificate, playVersionHistory } from '../../app-mobile/scripts/validate-play-bundle.mjs';

const require = createRequire(import.meta.url);
const appRoot = new URL('../../app-mobile/', import.meta.url);
const read = name => readFileSync(new URL(name, appRoot), 'utf8');
const base = JSON.parse(read('app.json')).expo;
const configure = require('../../app-mobile/app.config.js');
const { parseVersionCode, selectVersionCode } = require('../../app-mobile/scripts/android-version.cjs');
const { configureGradle } = require('../../app-mobile/scripts/prepare-play-android.cjs');
const { parseBaseline } = require('../../app-mobile/scripts/read-direct-baseline.cjs');
const { verifyConfig } = require('../../app-mobile/scripts/verify-play-config.cjs');

function withEnv(values, action) {
  const previous = { ...process.env };
  try {
    for (const key of ['EXPO_PUBLIC_DISTRIBUTION', 'SXB_ANDROID_VERSION_CODE', 'EAS_PROJECT_ID']) {
      delete process.env[key];
    }
    Object.assign(process.env, values);
    return action();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

function manifestPlugin(distribution, manifest) {
  const actions = { manifest: [], properties: [] };
  const stub = {
    withAndroidManifest: (config, action) => { actions.manifest.push(action); return config; },
    withDangerousMod: config => config,
    withAppBuildGradle: config => config,
    withGradleProperties: (config, action) => { actions.properties.push(action); return config; },
  };
  const module = { exports: {} };
  vm.runInNewContext(read('plugins/withSxbVpn.js'), {
    module, require: name => name === '@expo/config-plugins' ? stub : require(name), console, process,
  });
  module.exports({ extra: { distribution }, android: base.android });
  let mod = { modResults: { manifest } };
  for (const action of actions.manifest) mod = action(mod);
  let properties = { modResults: [{ type: 'property', key: 'android.targetSdkVersion', value: '35' }] };
  for (const action of actions.properties) properties = action(properties);
  return { manifest: mod.modResults.manifest, properties: properties.modResults };
}

describe('Play channel and shared version configuration', () => {
  it('keeps unverified version history separate from an operator declaration', () => {
    assert.deepEqual(playVersionHistory(0), {
      priorPlayVersionCodeFloor: 0,
      playHistoryVerified: false,
      operatorDeclaredPreviousPlayVersionCode: null,
    });
    assert.equal(playVersionHistory(420, true).operatorDeclaredPreviousPlayVersionCode, 420);
    assert.equal(playVersionHistory(420, 'true').playHistoryVerified, false);
  });
  it('keeps the same identity and direct defaults without a fictitious EAS project', () => {
    withEnv({}, () => {
      const config = configure({ config: structuredClone(base) });
      assert.equal(config.extra.distribution, 'direct');
      assert.equal(config.android.package, 'com.sxbvpn.mobile');
      assert.equal(config.extra.eas, undefined);
    });
  });
  it('exposes Play and its allocated version to Expo before native generation', () => {
    withEnv({ EXPO_PUBLIC_DISTRIBUTION: 'play', SXB_ANDROID_VERSION_CODE: '211000001' }, () => {
      verifyConfig(configure({ config: structuredClone(base) }), 211000001);
    });
    withEnv({ EXPO_PUBLIC_DISTRIBUTION: 'typo' }, () =>
      assert.throws(() => configure({ config: base }), /DISTRIBUTION/));
    withEnv({ EAS_PROJECT_ID: 'sxb-vpn-mobile' }, () =>
      assert.throws(() => configure({ config: base }), /UUID/));
    withEnv({ EAS_PROJECT_ID: '11111111-2222-3333-4444-555555555555' }, () =>
      assert.equal(configure({ config: base }).extra.eas.projectId, process.env.EAS_PROJECT_ID));
  });
  it('uses a supported EAS bundle type and explicit channels', () => {
    const eas = JSON.parse(read('eas.json'));
    assert.equal(eas.build.production.android.buildType, 'app-bundle');
    assert.equal(eas.build.production.env.EXPO_PUBLIC_DISTRIBUTION, 'play');
    assert.equal(eas.build.preview.env.EXPO_PUBLIC_DISTRIBUTION, 'direct');
    assert.equal(eas.build.preview.android.buildType, 'apk');
  });
  it('allocates the same clock across workflows without future overrides or downgrade', () => {
    const now = Date.UTC(2026, 8, 9);
    const code = selectVersionCode({ base: 8, published: 340, previousPlay: 0, now });
    assert.equal(code, (now - Date.UTC(2020, 0, 1)) / 1000);
    assert.equal(selectVersionCode({ base: 8, published: 340, previousPlay: code,
      now: now + 1000 }), code + 1);
    for (const input of [
      { published: code }, { previousPlay: code },
      { requested: String(code + 1) }, { requested: '339', published: 340 },
    ]) assert.throws(() => selectVersionCode({ base: 8, now, ...input }));
    for (const invalid of ['', '1e3', '1.2', '-1', '0', ' 100', '001', '2100000001', 'NaN']) {
      assert.throws(() => parseVersionCode(invalid));
    }
    assert.equal(parseVersionCode('2100000000'), 2100000000);
    assert.equal(parseVersionCode('0', true), 0);
  });
  it('preserves direct self-update and Firebase providers but removes both in Play', () => {
    const manifest = { $: {}, application: [{ $: {}, provider: [{
      $: { 'android:name': 'com.google.firebase.provider.FirebaseInitProvider' },
    }] }] };
    const direct = manifestPlugin('direct', structuredClone(manifest)).manifest;
    const play = manifestPlugin('play', structuredClone(manifest)).manifest;
    const permission = (m, name) => m['uses-permission'].find(p => p.$['android:name'] === name)?.$;
    assert.equal(permission(direct, 'android.permission.REQUEST_INSTALL_PACKAGES')['tools:node'], undefined);
    for (const name of ['REQUEST_INSTALL_PACKAGES', 'BIND_VPN_SERVICE', 'RECORD_AUDIO', 'READ_EXTERNAL_STORAGE']) {
      assert.equal(permission(play, `android.permission.${name}`)['tools:node'], 'remove');
    }
    for (const name of ['com.sxbvpn.vpnmodule.SxbFirebaseInitProvider',
      'com.google.firebase.provider.FirebaseInitProvider']) {
      assert.equal(play.application[0].provider.find(p => p.$['android:name'] === name).$['tools:node'], 'remove');
      assert.equal(direct.application[0].provider.find(p => p.$['android:name'] === name).$['tools:node'], undefined);
    }
    const metadata = (m, name) => m.application[0]['meta-data'].find(p => p.$['android:name'] === name)?.$['android:value'];
    assert.equal(metadata(play, 'com.sxbvpn.distribution'), 'play');
    assert.equal(metadata(direct, 'com.sxbvpn.distribution'), 'direct');
    for (const name of ['firebase_messaging_auto_init_enabled', 'firebase_analytics_collection_enabled',
      'firebase_data_collection_default_enabled']) {
      assert.equal(metadata(play, name), 'false');
      assert.equal(metadata(direct, name), undefined);
    }
    for (const [type, name] of [
      ['service', 'com.sxbvpn.vpnmodule.SxbFirebaseMessagingService'],
      ['service', 'com.google.firebase.messaging.FirebaseMessagingService'],
      ['receiver', 'com.google.firebase.iid.FirebaseInstanceIdReceiver'],
    ]) {
      assert.equal(play.application[0][type].find(entry =>
        entry.$['android:name'] === name).$['android:enabled'], 'false');
    }
    const again = manifestPlugin('play', play);
    assert.equal(again.manifest.application[0].service.filter(s =>
      s.$['android:name'] === 'com.sxbvpn.vpnmodule.SxbVpnService').length, 1);
    assert.equal(again.properties.find(p => p.key === 'android.targetSdkVersion').value, '36');
    assert.equal(again.properties.find(p => p.key === 'expo.useLegacyPackaging').value, 'true');
    const restored = manifestPlugin('direct', play).manifest;
    assert.equal(permission(restored, 'android.permission.REQUEST_INSTALL_PACKAGES')['tools:node'], undefined);
    assert.equal(metadata(restored, 'firebase_messaging_auto_init_enabled'), undefined);
    assert.equal(restored.application[0].provider.find(p =>
      p.$['android:name'] === 'com.sxbvpn.vpnmodule.SxbFirebaseInitProvider').$['tools:node'], undefined);
    assert.equal(restored.application[0].service.find(p =>
      p.$['android:name'] === 'com.sxbvpn.vpnmodule.SxbFirebaseMessagingService').$['android:enabled'], undefined);
    assert.equal(restored.application[0].receiver.length, 0);
  });
  it('overrides debug signing last and never embeds passwords in Gradle', () => {
    const source = 'android {\n defaultConfig { versionCode 211000001 }\n buildTypes { release { signingConfig signingConfigs.debug } }\n}';
    const configured = configureGradle(source, 211000001);
    assert.ok(configured.indexOf('buildTypes.release.signingConfig = signingConfigs.sxbPlayRelease') >
      configured.indexOf('signingConfig signingConfigs.debug'));
    assert.match(configured, /System\.getenv\(name\)/);
    assert.match(configured, /AGP >= 8\.5\.1/);
    assert.match(configured, /ndkVersion "27\.1\.12297006"/);
    assert.throws(() => configureGradle(source, 211000002), /match Expo/);
  });
  it('requires a real verified baseline with exactly one production signer', () => {
    const badging = "package: name='com.sxbvpn.mobile' versionCode='339' versionName='1.2.1'";
    const signature = `Verified using v2 scheme (APK Signature Scheme v2): true\nSigner #1 certificate SHA-256 digest: ${'a'.repeat(64)}\n`;
    assert.equal(parseBaseline(badging, signature).versionCode, 339);
    for (const [a, b] of [[badging.replace('com.sxbvpn.mobile', 'wrong.app'), signature],
      [badging, signature.replace('true', 'false')], [badging, `${signature}Android Debug`],
      [badging, signature + signature]]) assert.throws(() => parseBaseline(a, b));
  });
  it('blocks debug subject or issuer without replacing the persistent signing key', () => {
    assertReleaseCertificate({ subject: 'CN=SXB VPN', issuer: 'CN=SXB VPN' });
    for (const certificate of [
      { subject: 'CN=Android Debug', issuer: 'CN=Android Debug' },
      { subject: 'CN=SXB VPN', issuer: 'CN=Android Debug' },
    ]) assert.throws(() => assertReleaseCertificate(certificate), /human signing review/);
  });
  it('keeps workflow publication and signing boundaries explicit', () => {
    const play = readFileSync(new URL('../../.github/workflows/build-google-play.yml', import.meta.url), 'utf8');
    const direct = readFileSync(new URL('../../.github/workflows/build-android.yml', import.meta.url), 'utf8');
    assert.match(play, /^  workflow_dispatch:/m);
    assert.match(play, /^  workflow_call:/m);
    assert.doesNotMatch(play, /^\s+(push|pull_request|schedule):/m);
    assert.match(play, /contents: read/);
    assert.doesNotMatch(play, /contents: write|play-publisher|supply|upload-google-play|scp-action|ssh-action|gh release (create|delete)|apksigner sign/);
    for (const workflow of [play, direct]) {
      assert.match(workflow, /group:.*publication-apk/);
      assert.ok(workflow.indexOf('node scripts/android-version.cjs') < workflow.indexOf('npx'));
    }
    assert.match(play, /sha256sum --check --strict/);
    assert.match(play, /a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29/);
    assert.match(play, /trap 'rm -f "\$SXB_KEYSTORE_PATH"' EXIT/);
    assert.match(play, /node tests\/run-play-encryption\.cjs/);
    assert.ok(play.indexOf('node tests/run-play-encryption.cjs') < play.indexOf('KEYSTORE_FILE:'));
    assert.match(play, /a118197b0de55ffab2bc8d5cd03a5e39033cfb53383d6931bc761dec0784891a/);
    assert.match(play, /3cf6cd6892e32e2b4c1c39e0f52f5248a2f5b37646fdfbb79a66b46b618414ed/);
    assert.doesNotMatch(play, /KEYSTORE_PASSWORD=.*GITHUB_ENV|KEY_PASSWORD=.*GITHUB_ENV/);
    assert.match(direct, /EXPO_PUBLIC_DISTRIBUTION: direct/);
    assert.match(direct, /Vérifier le versionCode commun Expo et Android/);
    assert.match(direct, /build-play-candidate:[\s\S]*uses: \.\/\.github\/workflows\/build-google-play\.yml/);
    assert.match(direct, /build-android:\s+if: github\.event_name != 'workflow_dispatch' \|\| inputs\.distribution != 'play'/);
    assert.match(direct, /format\('play-dispatch-\{0\}', github\.run_id\)/);
    assert.match(play, /SXB_PLAY_HISTORY_VERIFIED: \$\{\{ inputs\.play_history_verified \}\}/);
  });
});

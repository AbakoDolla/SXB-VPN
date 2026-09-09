import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { describe, it } from 'node:test';
import { archiveEntries, inspectElf, inspectNativeArchive } from '../../app-mobile/scripts/android-artifact.mjs';
import { validateManifest } from '../../app-mobile/scripts/validate-play-bundle.mjs';

const require = createRequire(new URL('../../app-mobile/package.json', import.meta.url));
const { AndroidConfig } = require('@expo/config-plugins');
const YAML = require('yaml');

function elf(abi = 'arm64-v8a', alignment = 16384) {
  const is64 = abi !== 'armeabi-v7a';
  const b = Buffer.alloc(512);
  b.set([127, 69, 76, 70, is64 ? 2 : 1, 1, 1]);
  b.writeUInt16LE(3, 16);
  b.writeUInt16LE(abi === 'arm64-v8a' ? 183 : abi === 'x86_64' ? 62 : 40, 18);
  if (is64) {
    b.writeBigUInt64LE(64n, 32);
    b.writeUInt16LE(56, 54);
    b.writeUInt16LE(1, 56);
    b.writeUInt32LE(1, 64);
    b.writeBigUInt64LE(512n, 64 + 32);
    b.writeBigUInt64LE(512n, 64 + 40);
    b.writeBigUInt64LE(BigInt(alignment), 64 + 48);
  } else {
    b.writeUInt32LE(64, 28);
    b.writeUInt16LE(32, 42);
    b.writeUInt16LE(1, 44);
    b.writeUInt32LE(1, 64);
    b.writeUInt32LE(512, 64 + 16);
    b.writeUInt32LE(512, 64 + 20);
    b.writeUInt32LE(alignment, 64 + 28);
  }
  return b;
}

function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, body] of entries) {
    const filename = Buffer.from(name);
    const data = deflateRawSync(body);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(body), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(filename.length, 26);
    locals.push(header, filename, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    header.copy(directory, 6, 4, 30);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.reduce((total, item) => total + item.length, 0), 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

function temp(action) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sxb-play-test-'));
  return Promise.resolve().then(() => action(directory)).finally(() => rmSync(directory, { recursive: true, force: true }));
}

function manifest() {
  const permission = name => ({ $: { 'android:name': `android.permission.${name}` } });
  return {
    $: { package: 'com.sxbvpn.mobile', 'xmlns:android': 'http://schemas.android.com/apk/res/android',
      'android:versionCode': '211000001', 'android:versionName': '1.2.1' },
    'uses-sdk': [{ $: { 'android:minSdkVersion': '24', 'android:targetSdkVersion': '36' } }],
    'uses-permission': ['INTERNET', 'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_SPECIAL_USE',
      'POST_NOTIFICATIONS'].map(permission),
    application: [{
      $: { 'android:name': '.MainApplication', 'android:extractNativeLibs': 'true' },
      'meta-data': [
        ['com.sxbvpn.distribution', 'play'],
        ['firebase_messaging_auto_init_enabled', 'false'],
        ['firebase_analytics_collection_enabled', 'false'],
        ['firebase_data_collection_default_enabled', 'false'],
      ].map(([name, value]) => ({ $: { 'android:name': name, 'android:value': value } })),
      service: [{
        $: {
          'android:name': 'com.sxbvpn.vpnmodule.SxbVpnService',
          'android:permission': 'android.permission.BIND_VPN_SERVICE',
          'android:foregroundServiceType': 'specialUse',
          'android:exported': 'false',
        },
        'intent-filter': [{ action: [{ $: { 'android:name': 'android.net.VpnService' } }] }],
        property: [{ $: { 'android:name': 'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE', 'android:value': 'vpn' } }],
      }, ...['com.sxbvpn.vpnmodule.SxbFirebaseMessagingService',
        'com.google.firebase.messaging.FirebaseMessagingService'].map(name => ({
        $: { 'android:name': name, 'android:enabled': 'false', 'android:exported': 'false' },
      }))],
      receiver: [{ $: {
        'android:name': 'com.google.firebase.iid.FirebaseInstanceIdReceiver',
        'android:enabled': 'false', 'android:exported': 'true',
        'android:permission': 'com.google.android.c2dm.permission.SEND',
      } }],
    }],
  };
}

describe('Real archive and ELF validation', () => {
  it('checks arm64 and x86_64 LOAD headers, not just ZIP alignment', () => {
    for (const abi of ['arm64-v8a', 'x86_64']) {
      assert.equal(inspectElf(elf(abi), abi).segments[0].alignment, 16384);
      assert.throws(() => inspectElf(elf(abi, 4096), abi), /below 16 KiB/);
      assert.equal(inspectElf(elf(abi, 65536), abi).segments[0].alignment, 65536);
    }
    assert.equal(inspectElf(elf('armeabi-v7a', 4096), 'armeabi-v7a').segments[0].alignment, 4096);
  });
  it('rejects truncated binaries, wrong machines, missing and malformed LOAD segments', () => {
    assert.throws(() => inspectElf(Buffer.from('not ELF'), 'arm64-v8a'));
    assert.throws(() => inspectElf(elf(), 'x86_64'), /machine/);
    for (const mutate of [
      b => b.writeUInt32LE(0, 64),
      b => b.writeBigUInt64LE(16383n, 112),
      b => b.writeBigUInt64LE(1n, 80),
      b => b.writeBigUInt64LE(9999n, 96),
      b => b.writeUInt16LE(65535, 56),
    ]) {
      const buffer = elf();
      mutate(buffer);
      assert.throws(() => inspectElf(buffer, 'arm64-v8a'));
    }
  });
  it('inspects every packaged native dependency and requires both VPN engines per ABI', () => temp(directory => {
    const archive = path.join(directory, 'candidate.aab');
    const entries = ['arm64-v8a', 'armeabi-v7a'].flatMap(abi =>
      ['libbox.so', 'libdnstt.so', 'libreactnative.so'].map(name => [`base/lib/${abi}/${name}`, elf(abi)]));
    writeFileSync(archive, zip(entries));
    assert.equal(inspectNativeArchive(archive, 'base/lib', ['libbox.so', 'libdnstt.so']).length, 6);
    writeFileSync(archive, zip([...entries, ['base/lib/arm64-v8a/libbadtransitive.so', elf('arm64-v8a', 4096)]]));
    assert.throws(() => inspectNativeArchive(archive, 'base/lib', ['libbox.so', 'libdnstt.so']), /below 16 KiB/);
    writeFileSync(archive, zip(entries.filter(([name]) => !name.endsWith('libdnstt.so'))));
    assert.throws(() => inspectNativeArchive(archive, 'base/lib', ['libbox.so', 'libdnstt.so']), /Missing/);
  }));
  it('rejects duplicate and traversing archive paths', () => temp(directory => {
    const archive = path.join(directory, 'bad.aab');
    for (const entries of [
      [['same', Buffer.from('one')], ['same', Buffer.from('two')]],
      [['../outside', Buffer.from('no')]],
    ]) {
      writeFileSync(archive, zip(entries));
      assert.throws(() => archiveEntries(archive));
    }
  }));
});

describe('Final merged Play manifest validation', () => {
  it('parses actual XML with the same Expo parser used by the AAB validator', () => temp(async directory => {
    const file = path.join(directory, 'AndroidManifest.xml');
    for (const type of ['specialUse', '0x40000000', '1073741824']) {
      const m = manifest();
      m.application[0].service[0].$['android:foregroundServiceType'] = type;
      await AndroidConfig.Manifest.writeAndroidManifestAsync(file, { manifest: m });
      const parsed = await AndroidConfig.Manifest.readAndroidManifestAsync(file);
      const report = validateManifest(parsed.manifest, 211000001, '1.2.1');
      assert.equal(report.permissions.length, 4);
      assert.equal(report.targetSdk, 36);
    }
  }));
  it('rejects missing, unknown and combined foreground service types', () => {
    for (const type of [undefined, '', 'dataSync', 'specialUse|dataSync', '0x40000001', '1073741825']) {
      const m = manifest();
      m.application[0].service[0].$['android:foregroundServiceType'] = type;
      assert.throws(() => validateManifest(m, 211000001, '1.2.1'), /must be exactly specialUse/);
    }
  });
  it('fails closed for all unreviewed transitive permissions, including sdk-23 entries', () => {
    for (const name of ['android.permission.REQUEST_INSTALL_PACKAGES', 'android.permission.CAMERA',
      'android.permission.RECORD_AUDIO', 'com.example.UNKNOWN_PERMISSION']) {
      const m = manifest();
      m['uses-permission-sdk-23'] = [{ $: { 'android:name': name } }];
      assert.throws(() => validateManifest(m, 211000001, '1.2.1'), /Unreviewed transitive/);
    }
  });
  it('rejects wrong SDK/identity/version, debug releases, missing extraction and VPN declarations', () => {
    const mutations = [
      m => { m.$.package = 'com.other.app'; },
      m => { m.$['android:versionCode'] = '8'; },
      m => { m['uses-sdk'][0].$['android:targetSdkVersion'] = '35'; },
      m => { m.application[0].$['android:debuggable'] = 'true'; },
      m => { m.application[0].$['android:testOnly'] = 'true'; },
      m => { m.application[0].$['android:extractNativeLibs'] = 'false'; },
      m => { m.application[0].service[0].$['android:exported'] = 'true'; },
      m => { m.application[0].service[0].$['android:permission'] = 'none'; },
      m => { m.application[0].service[0].property = []; },
      m => { m.application[0].service[0]['intent-filter'] = []; },
    ];
    for (const mutate of mutations) {
      const m = manifest();
      mutate(m);
      assert.throws(() => validateManifest(m, 211000001, '1.2.1'));
    }
  });
  it('rejects pre-consent Firebase init and a direct distribution marker', () => {
    for (const name of ['com.google.firebase.provider.FirebaseInitProvider', 'com.sxbvpn.vpnmodule.SxbFirebaseInitProvider']) {
      const m = manifest();
      m.application[0].provider = [{ $: { 'android:name': name } }];
      assert.throws(() => validateManifest(m, 211000001, '1.2.1'), /before consent/);
    }
    for (let index = 0; index < 4; index++) {
      const m = manifest();
      m.application[0]['meta-data'][index].$['android:value'] = index === 0 ? 'direct' : 'true';
      assert.throws(() => validateManifest(m, 211000001, '1.2.1'));
    }
    for (const [type, index] of [['service', 1], ['service', 2], ['receiver', 0]]) {
      const m = manifest();
      m.application[0][type][index].$['android:enabled'] = 'true';
      assert.throws(() => validateManifest(m, 211000001, '1.2.1'), /enabled before consent/);
    }
  });
});

describe('Workflow syntax and release gates', () => {
  it('parses both workflows and syntax-checks their bash steps', () => {
    for (const name of ['build-google-play.yml', 'build-android.yml']) {
      const document = YAML.parseDocument(readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8'));
      assert.deepEqual(document.errors, []);
      const workflow = document.toJS();
      assert.ok(workflow.on.workflow_dispatch !== undefined || 'workflow_dispatch' in workflow.on);
      for (const job of Object.values(workflow.jobs)) {
        if (job.uses) {
          assert.equal(job.uses, './.github/workflows/build-google-play.yml');
          assert.equal(job.permissions.contents, 'read');
          assert.match(job.if, /inputs\.distribution == 'play'/);
          assert.equal(job.steps, undefined);
          continue;
        }
        for (const step of job.steps) {
          if (!step.run) continue;
          execFileSync('bash', ['-n'], {
            input: step.run.replace(/\$\{\{[\s\S]*?\}\}/g, 'placeholder'),
            encoding: 'utf8',
          });
        }
      }
    }
  });
});

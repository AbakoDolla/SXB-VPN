import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { VERSION, SHA256, URL } = require('../../app-mobile/scripts/prepare-geosite.cjs');
const read = name => readFileSync(new globalThis.URL(`../../${name}`, import.meta.url), 'utf8');

test('the native domain database is pinned rather than downloaded during VPN startup', () => {
  assert.equal(VERSION, '20260908094002');
  assert.equal(SHA256, '03cbdc0ceab1aa8f0620af77d32e990a3850acb653ffdced8efac137277930b2');
  assert.equal(URL, `https://github.com/SagerNet/sing-geosite/releases/download/${VERSION}/geosite.db`);
  const plugin = read('app-mobile/plugins/withSxbVpn.js');
  assert.match(plugin, /config = withEngineData\(config\)/);
  assert.match(plugin, /await prepareGeosite\(\)/);
  assert.match(plugin, /'geosite.db', 'geosite.sha256'/);
  const service = read('app-mobile/modules/android-native/SxbVpnService.kt');
  assert.ok(service.indexOf('SxbEngineData.prepare(this, workDir)') < service.indexOf('Libbox.setup(options)'));
  const native = read('app-mobile/modules/android-native/SxbEngineData.kt');
  assert.match(native, /context\.assets\.open\("sxb-engine\/geosite\.db"\)/);
  assert.match(native, /sha256\(temporary\) == expected/);
  assert.doesNotMatch(native, /https?:|URL\(|HttpURLConnection/);
});

test('both build channels validate a synthetic graph using the real native builder and pinned engine', () => {
  const gate = read('scripts/run-android-policy-gates.sh');
  assert.match(gate, /xray-runtime-fixture\.mjs/);
  assert.match(gate, /XrayRuntimeHarnessKt/);
  assert.match(gate, /singbox-engine-check run/);
  const check = read('scripts/tests/singbox-engine-check/main.go');
  assert.match(check, /libbox\.CheckConfig/);
  assert.match(check, /dependency\.Version == "v1\.11\.15"/);
  assert.match(check, /strings\.HasSuffix\(outbound\.Server, "\.example\.test"\)/);
  assert.doesNotMatch(check, /service\.Start\(/);
});

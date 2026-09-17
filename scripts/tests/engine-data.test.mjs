import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const { VERSION, SHA256, URL } = require('../../app-mobile/scripts/prepare-geosite.cjs');
const read = name => readFileSync(new globalThis.URL(`../../${name}`, import.meta.url), 'utf8');

test('the native domain database is pinned rather than downloaded during VPN startup', () => {
  assert.equal(VERSION, '20260908094002');
  assert.equal(SHA256, '03cbdc0ceab1aa8f0620af77d32e990a3850acb653ffdced8efac137277930b2');
  assert.equal(URL, `https://github.com/SagerNet/sing-geosite/releases/download/${VERSION}/geosite.db`);
  const database = readFileSync(new globalThis.URL('../../app-mobile/assets/engine/geosite.db', import.meta.url));
  assert.equal(createHash('sha256').update(database).digest('hex'), SHA256);
  assert.match(read('app-mobile/assets/engine/NOTICE.txt'), /Copyright \(c\) 2018-2019 V2Ray/);
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
  // La version n'est pas recopiée ici : elle est LUE du script de compilation,
  // qui est la source de vérité. Deux épinglages indépendants finissent
  // toujours par diverger, et la divergence ne se voit qu'à l'exécution.
  const build = read('app-mobile/scripts/build-libbox.sh');
  const version = (build.match(/SING_BOX_VERSION:-v(\d+\.\d+\.\d+)/) || [])[1];
  assert.ok(version, 'la version du moteur doit être lisible dans build-libbox.sh');
  assert.ok(
    check.includes(`dependency.Version == "v${version}"`),
    `le vérificateur doit exiger sing-box v${version}`,
  );
  assert.match(check, /strings\.HasSuffix\(outbound\.Server, "\.example\.test"\)/);
  assert.doesNotMatch(check, /service\.Start\(/);
});

// Same pinned kotlinc 2.1.20 + org.json JVM jar as run-access-policy.cjs.
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const jsonJar = process.env.SXB_JSON_JAR;
assert.ok(jsonJar && existsSync(jsonJar), 'Set SXB_JSON_JAR to the real org.json JVM jar');
const temp = mkdtempSync(path.join(__dirname, '.stability-policy-'));
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed`);
}
try {
  const jar = path.join(temp, 'stability-policy.jar');
  // Exercise the real production masks without loading Android/Keystore.
  const securitySource = readFileSync(path.resolve(__dirname, '..', 'modules', 'android-native', 'SecurityModule.kt'), 'utf8');
  const masks = ['maskSensitive', 'maskCredentialsOnly'].map(name => {
    const start = securitySource.indexOf(`    fun ${name}(`);
    const end = securitySource.indexOf('\n    }', start);
    assert.ok(start >= 0 && end > start, `Production masking method missing: ${name}`);
    return securitySource.slice(start, end + '\n    }'.length);
  });
  const maskHarness = path.join(temp, 'SecurityMaskHarness.kt');
  writeFileSync(maskHarness, `package com.sxbvpn.vpnmodule\nobject SecurityMaskHarness {\n${masks.join('\n')}\n}\n`);
  run(process.env.KOTLINC || 'kotlinc', [
    path.resolve(__dirname, '..', 'modules', 'android-native', 'SxbTunnelPolicy.kt'),
    path.resolve(__dirname, '..', 'modules', 'android-native', 'SxbEngineDiagnostics.kt'),
    path.resolve(__dirname, 'StabilityPolicyTest.kt'),
    maskHarness,
    '-classpath', jsonJar, '-include-runtime', '-d', jar,
  ]);
  run(process.env.JAVA || 'java', ['-cp', `${jar}${path.delimiter}${jsonJar}`, 'com.sxbvpn.vpnmodule.StabilityPolicyTestKt']);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

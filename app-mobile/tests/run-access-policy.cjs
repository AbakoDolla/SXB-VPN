// Uses the same pinned kotlinc + org.json JVM jar as run-play-encryption.cjs.
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const jsonJar = process.env.SXB_JSON_JAR;
assert.ok(jsonJar && existsSync(jsonJar), 'Set SXB_JSON_JAR to the real org.json JVM jar');
const temp = mkdtempSync(path.join(tmpdir(), 'sxb-access-policy-'));
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed`);
}
try {
  const jar = path.join(temp, 'access-policy.jar');
  run(process.env.KOTLINC || 'kotlinc', [
    path.resolve(__dirname, '..', 'modules', 'android-native', 'SxbAccessPolicy.kt'),
    path.resolve(__dirname, 'AccessPolicyTest.kt'),
    '-classpath', jsonJar, '-include-runtime', '-d', jar,
  ]);
  run(process.env.JAVA || 'java', ['-cp', `${jar}${path.delimiter}${jsonJar}`, 'com.sxbvpn.vpnmodule.AccessPolicyTestKt']);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

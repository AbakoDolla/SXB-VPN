// Vérifie la décision « quand a-t-on le droit d'annoncer CONNECTÉ ».
//
// Même convention que run-access-policy.cjs, sans org.json : la politique de
// preuve ne dépend ni d'Android ni de JSON, uniquement de compteurs d'octets.
//
//   KOTLINC=/chemin/vers/kotlinc node tests/run-handshake-proof.cjs
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const temp = mkdtempSync(path.join(tmpdir(), 'sxb-handshake-proof-'));
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed`);
}
try {
  const jar = path.join(temp, 'handshake-proof.jar');
  run(process.env.KOTLINC || 'kotlinc', [
    path.resolve(__dirname, '..', 'modules', 'android-native', 'SxbHandshakeProofPolicy.kt'),
    path.resolve(__dirname, 'HandshakeProofPolicyTest.kt'),
    '-include-runtime', '-d', jar,
  ]);
  run(process.env.JAVA || 'java', ['-cp', jar, 'com.sxbvpn.vpnmodule.HandshakeProofPolicyTestKt']);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

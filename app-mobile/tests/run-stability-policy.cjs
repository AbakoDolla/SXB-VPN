// Same pinned kotlinc 2.1.20 + org.json JVM jar as run-access-policy.cjs.
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const jsonJar = process.env.SXB_JSON_JAR;
assert.ok(jsonJar && existsSync(jsonJar), 'Set SXB_JSON_JAR to the real org.json JVM jar');
const temp = mkdtempSync(path.join(__dirname, '.stability-policy-'));
function run(command, args) {
  if (process.platform === 'win32' && command === process.env.KOTLINC && command.endsWith('.bat')) {
    const home = path.resolve(path.dirname(command), '..');
    return run(process.env.JAVA || 'java', [`-Dkotlin.home=${home}`, '-cp', path.join(home, 'lib', '*'),
      'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', ...args]);
  }
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
  // Les motifs vivent hors des deux fonctions : ils sont compilés une seule
  // fois au chargement de la classe plutôt qu'à chaque ligne de journal. Le
  // harnais doit donc les transporter avec les corps qu'il extrait, sinon il
  // compile des références orphelines. Ils sont repris TELS QUELS, pour que ce
  // test continue d'exercer les expressions réellement en production.
  const motifsDebut = securitySource.indexOf('    private val MOTIF_IPV4');
  const motifsFin = securitySource.indexOf('    fun maskSensitive(');
  assert.ok(
    motifsDebut >= 0 && motifsFin > motifsDebut,
    'Production masking patterns missing: expected the hoisted MOTIF_* declarations before maskSensitive',
  );
  const motifs = securitySource.slice(motifsDebut, motifsFin);
  assert.ok(motifs.includes('MOTIFS_IDENTIFIANTS'), 'Production credential patterns missing: MOTIFS_IDENTIFIANTS');
  const maskHarness = path.join(temp, 'SecurityMaskHarness.kt');
  writeFileSync(maskHarness, `package com.sxbvpn.vpnmodule\nobject SecurityMaskHarness {\n${motifs}${masks.join('\n')}\n}\n`);
  const service = readFileSync(path.resolve(__dirname, '..', 'modules', 'android-native', 'SxbVpnService.kt'), 'utf8');
  const sshMethods = ['extractPayloadHost', 'normalizePayload', 'websocketPayload', 'sshTransportStrategies', 'isTlsIdentityFailure'].map(name => {
    const match = service.match(new RegExp(`^    private fun ${name}\\([\\s\\S]*?^    }`, 'm'));
    assert.ok(match, `Production SSH method missing: ${name}`);
    return match[0];
  });
  const sshTokens = service.slice(service.indexOf('private val sshSplitDirective'), service.indexOf('private fun sendSshPayload'));
  const sshStrategy = service.match(/^    private data class SshTransportStrategy\([\s\S]*?^    \)/m)?.[0];
  const stringHelper = service.match(/^private fun JSONObject\.optStringOrNull\([\s\S]*?^}/m)?.[0];
  assert.ok(sshTokens.includes('expandSshPayloadTokens') && sshStrategy && stringHelper);
  const sshHarness = path.join(temp, 'SshTransportHarness.kt');
  writeFileSync(sshHarness, `package com.sxbvpn.vpnmodule
import org.json.JSONObject
import java.security.SecureRandom
import java.util.Locale
${sshTokens}
${stringHelper}
object SshTransportHarness {
${sshStrategy}
${sshMethods.join('\n')}
    fun strategies(payload: String, tls: Boolean): List<Pair<String, Boolean>> =
        sshTransportStrategies(JSONObject(), payload, "ssh.example.test", 443, tls, "ssh.example.test")
            .map { it.mode to it.tls }
    fun rejectsIdentityFailure(error: Throwable): Boolean = isTlsIdentityFailure(error)
}
`);
  const base64Harness = path.join(temp, 'AndroidBase64Harness.kt');
  writeFileSync(base64Harness, `package android.util
object Base64 {
    const val NO_WRAP = 2
    fun encodeToString(bytes: ByteArray, flags: Int): String = java.util.Base64.getEncoder().encodeToString(bytes)
}
`);
  run(process.env.KOTLINC || 'kotlinc', [
    path.resolve(__dirname, '..', 'modules', 'android-native', 'SxbTunnelPolicy.kt'),
    path.resolve(__dirname, '..', 'modules', 'android-native', 'SxbEngineDiagnostics.kt'),
    path.resolve(__dirname, '..', 'modules', 'android-native', 'SxbReconnectPolicy.kt'),
    // Arithmétique du comptage de consommation : aucune dépendance Android,
    // donc vérifiable ici plutôt que sur un appareil.
    path.resolve(__dirname, '..', 'modules', 'android-native', 'SxbUsageOdometer.kt'),
    // Vitalite du tunnel SSH : le transport SSH ne passe pas par sing-box, donc
    // rien d'autre ne constate sa mort. La decision est pure, donc prouvable ici.
    path.resolve(__dirname, '..', 'modules', 'android-native', 'SxbSshKeepAlive.kt'),
    // Traduction de schéma du moteur : sing-box 1.13 et 1.14 ont SUPPRIMÉ des
    // options que chaque configuration SXB porte. Pure, donc prouvable ici.
    path.resolve(__dirname, '..', 'modules', 'android-native', 'SxbEngineSchema.kt'),
    path.resolve(__dirname, '..', 'modules', 'android-native', 'SxbProtocolCompatibility.kt'),
    path.resolve(__dirname, 'ProtocolCompatibilityTest.kt'),
    path.resolve(__dirname, 'StabilityPolicyTest.kt'),
    maskHarness,
    sshHarness,
    base64Harness,
    '-classpath', jsonJar, '-include-runtime', '-d', jar,
  ]);
  run(process.env.JAVA || 'java', ['-cp', `${jar}${path.delimiter}${jsonJar}`, 'com.sxbvpn.vpnmodule.StabilityPolicyTestKt']);
  run(process.env.JAVA || 'java', ['-cp', `${jar}${path.delimiter}${jsonJar}`, 'com.sxbvpn.vpnmodule.ProtocolCompatibilityTestKt']);
  run(process.execPath, [path.resolve(__dirname, 'run-reconnect-recovery.cjs')]);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

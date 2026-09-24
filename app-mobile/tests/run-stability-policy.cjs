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
    path.resolve(__dirname, 'StabilityPolicyTest.kt'),
    maskHarness,
    '-classpath', jsonJar, '-include-runtime', '-d', jar,
  ]);
  run(process.env.JAVA || 'java', ['-cp', `${jar}${path.delimiter}${jsonJar}`, 'com.sxbvpn.vpnmodule.StabilityPolicyTestKt']);
  run(process.execPath, [path.resolve(__dirname, 'run-reconnect-recovery.cjs')]);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

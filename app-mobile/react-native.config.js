/**
 * react-native.config.js — configuration RN CLI + SONDE DE DIAGNOSTIC CI.
 *
 * Pourquoi ce fichier existe :
 *   L'étape « Build APK (release) » de build-android.yml échoue en CI sans log
 *   accessible hors du runner. Ce fichier est ÉVALUÉ à la phase « settings »
 *   de chaque invocation Gradle (settings.gradle exécute
 *   `expo-modules-autolinking react-native-config` via providers.exec).
 *   On en profite comme point d'instrumentation : des annotations ::notice
 *   sont émises sur STDERR (STDOUT reste le JSON pur consommé par Gradle),
 *   lisibles ensuite via l'API check-runs de GitHub.
 *
 * Gardes de sécurité (zéro impact hors CI / hors Gradle / hors premier appel) :
 *   1. GITHUB_ACTIONS === 'true' ;
 *   2. processus parent = java/gradle (évite les émissions pendant prebuild) ;
 *   3. fichier-verrou /tmp → émission unique par runner (les 6 invocations
 *      Gradle du step : 5× `tasks --all` + assembleRelease n'émettent qu'une fois).
 */

// eslint-disable-next-line no-undef
if (typeof process !== 'undefined' && process.env.GITHUB_ACTIONS === 'true') {
  try {
    const fs = require('fs');
    const { execSync } = require('child_process');
    const parent = execSync(`ps -o cmd= -p ${process.ppid} 2>/dev/null`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    if (/java|gradle/i.test(parent) && !fs.existsSync('/tmp/.sxb-probe-settings')) {
      fs.writeFileSync('/tmp/.sxb-probe-settings', '1');

      const notice = (msg) =>
        console.error(`::notice title=SXB-PROBE settings::${msg.replace(/[\r\n]/g, ' ')}`);
      const listDir = (p) => {
        try {
          return fs.readdirSync(p).join(',') || '(vide)';
        } catch {
          return '(absent)';
        }
      };
      const depVersion = (name) => {
        try {
          return require(`${name}/package.json`).version;
        } catch {
          return 'ABSENT';
        }
      };

      const ah = process.env.ANDROID_HOME || '(unset)';
      notice(`node=${process.version}`);
      notice(`ANDROID_HOME=${ah} | ndk=[${listDir(`${ah}/ndk`)}] | cmake=[${listDir(`${ah}/cmake`)}]`);
      notice(
        `reanimated@${depVersion('react-native-reanimated')} ` +
          `worklets@${depVersion('react-native-worklets')} ` +
          `rn@${depVersion('react-native')} expo@${depVersion('expo')}`,
      );
    }
  } catch {
    // Sonde : jamais bloquante.
  }
}

module.exports = {};

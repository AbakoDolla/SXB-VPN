/**
 * withCiGradleAnnotations.js — config plugin Expo de diagnostic CI.
 *
 * PROBLÈME QU'IL RÉSOUT
 *   L'étape « Build APK (release) » de build-android.yml échoue après ~2 min
 *   et les logs du runner sont inaccessibles hors session GitHub Actions
 *   (seuls les check-runs/annotations REST API restent lisibles).
 *
 * CE QU'IL FAIT
 *   Injecte à la fin du `android/settings.gradle` généré (via prebuild, exécuté
 *   juste avant l'étape Gradle dans le même job) un hook Gradle qui publie :
 *     - `::notice settingsEvaluated OK` à chaque évaluation des settings
 *       (prouve que la phase settings passe — 6 invocations/step → 6 notices,
 *       sous la limite de 10 annotations/step) ;
 *     - `::error` avec la CHAÎNE DE CAUSES exacte de l'échec Gradle
 *       (failure.message + jusqu'à 8 causes) en fin de build.
 *
 *   Les hooks `settingsEvaluated`/`buildFinished` utilisent `println`
 *   (sortie console Gradle = flux du step → parsé en annotations par le runner).
 *   Inoffensif hors CI et en cas de succès (une notice discrète par invocation).
 */

const { withSettingsGradle } = require('@expo/config-plugins');

const GROOVY_HOOK = `
// ── SXB CI probe (injecté par plugins/withCiGradleAnnotations.js) ──────────
gradle.settingsEvaluated { s ->
    println("::notice title=SXB-PROBE settings::evaluated OK")
}
gradle.buildFinished { r ->
    if (r.failure != null) {
        def chain = []
        def t = r.failure
        while (t != null && chain.size() < 8) {
            chain.add(String.valueOf(t.message))
            t = t.cause
        }
        def msg = chain.join(' <- ')
            .replace('%', '%25').replace('\\r', '%0D').replace('\\n', '%0A')
        println("::error title=SXB-GRADLE-FAILURE::" + msg)
    }
}
// ── fin SXB CI probe ────────────────────────────────────────────────────────
`;

module.exports = function withCiGradleAnnotations(config) {
  return withSettingsGradle(config, (mod) => {
    if (!mod.modResults.contents.includes('SXB CI probe')) {
      mod.modResults.contents += GROOVY_HOOK;
    }
    return mod;
  });
};

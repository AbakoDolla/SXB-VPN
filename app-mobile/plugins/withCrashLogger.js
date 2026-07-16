/**
 * withCrashLogger.js
 *
 * Config plugin Expo : injecte un gestionnaire d'exceptions natif
 * Android (Thread.setDefaultUncaughtExceptionHandler) directement dans
 * MainApplication.kt à chaque `expo prebuild`. Contrairement à un
 * handler JS (ErrorUtils), celui-ci capte AUSSI les crashs natifs qui
 * surviennent avant même que le moteur JS ne démarre.
 *
 * Le crash est écrit dans un fichier texte lisible sans PC ni root :
 *   /Android/data/com.sxbvpn.app/files/crash_TIMESTAMP.txt
 * (visible avec n'importe quel gestionnaire de fichiers)
 */
const { withMainApplication } = require('@expo/config-plugins');

const IMPORTS_TO_ADD = [
  'import java.io.File',
  'import java.io.FileWriter',
  'import java.io.PrintWriter',
  'import java.io.StringWriter',
  'import java.text.SimpleDateFormat',
  'import java.util.Date',
  'import java.util.Locale',
];

const HANDLER_CODE = `
    // ── Crash logger natif (injecté par withCrashLogger config plugin) ──
    val defaultHandler = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
      try {
        val sw = StringWriter()
        throwable.printStackTrace(PrintWriter(sw))
        val timestamp = SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US).format(Date())
        val dir = getExternalFilesDir(null)
        if (dir != null) {
          if (!dir.exists()) dir.mkdirs()
          val file = File(dir, "crash_" + timestamp + ".txt")
          FileWriter(file).use { writer ->
            writer.write("=== SXB VPN CRASH LOG ===\n")
            writer.write("Time: " + timestamp + "\n")
            writer.write("Thread: " + thread.name + "\n\n")
            writer.write(sw.toString())
          }
        }
      } catch (e: Exception) {
        // Ne jamais laisser le logger lui-même planter
      }
      defaultHandler?.uncaughtException(thread, throwable)
    }
`;

module.exports = function withCrashLogger(config) {
  return withMainApplication(config, (config) => {
    let contents = config.modResults.contents;

    // 1) Ajoute les imports nécessaires (après le "package ..." de la première ligne)
    const packageLineMatch = contents.match(/^package .+$/m);
    if (packageLineMatch) {
      const missingImports = IMPORTS_TO_ADD.filter((imp) => !contents.includes(imp));
      if (missingImports.length > 0) {
        const insertion = packageLineMatch[0] + '\n\n' + missingImports.join('\n');
        contents = contents.replace(packageLineMatch[0], insertion);
      }
    }

    // 2) Injecte le handler tout en haut de onCreate(), avant super.onCreate()
    const onCreateRegex = /override fun onCreate\(\) \{/;
    if (onCreateRegex.test(contents) && !contents.includes('Crash logger natif')) {
      contents = contents.replace(
        onCreateRegex,
        'override fun onCreate() {' + HANDLER_CODE
      );
    } else if (!onCreateRegex.test(contents)) {
      console.warn(
        '[withCrashLogger] onCreate() pattern not found in MainApplication.kt — crash logger not injected. Native Application structure may have changed.'
      );
    }

    config.modResults.contents = contents;
    return config;
  });
};

const fs = require('fs');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// FIX CI « Build APK (release) » — ENOENT sur <racine-repo>/node_modules
//
// Dans ce monorepo, expo/metro-config ajoute <racine>/node_modules à
// watchFolders (voir getWatchFolders() de @expo/metro-config). Or Metro
// EXIGE que chaque watchFolder existe (verifyRootExists dans
// metro/src/DeltaBundler/Transformer.js, appelé par le constructeur) :
// si <racine>/node_modules est absent — cas en CI GitHub Actions où seul
// `npm install` dans app-mobile/ est exécuté — la transformation jette :
//   Error: ENOENT: no such file or directory, stat '<racine>/node_modules'
// → createBundleReleaseJsAndAssets échoue → ./gradlew :app:assembleRelease
// quitte avec exit code 1 après ~2 min (avant toute compilation Kotlin).
//
// Reproduit localement avec la même commande que Gradle :
//   NODE_ENV=production npx expo export --platform android
//
// On ne conserve donc que les watchFolders réellement présents. Comportement
// inchangé en développement monorepo (la racine/node_modules y existe et est
// conservé) ; la résolution devient purement projet-locale quand il est
// absent (app-mobile est auto-suffisant après `npm install`).
config.watchFolders = (config.watchFolders || []).filter((dir) => fs.existsSync(dir));

// SONDE CI — phase « bundle » (task :app:createBundleReleaseJsAndAssets).
// metro.config.js est chargé UNE FOIS par le process node de `expo export:embed` ;
// stderr est relayé dans le log Gradle → annotations lisibles via l'API check-runs.
// Émission unique par runner (verrou /tmp) : start au chargement, exit code en fin.
if (process.env.GITHUB_ACTIONS === 'true') {
  try {
    if (!fs.existsSync('/tmp/.sxb-probe-bundle')) {
      fs.writeFileSync('/tmp/.sxb-probe-bundle', '1');
      console.error(`::notice title=SXB-PROBE bundle::start node=${process.version}`);
    }
    process.once('exit', (code) => {
      try {
        if (!fs.existsSync('/tmp/.sxb-probe-bundle-exit')) {
          fs.writeFileSync('/tmp/.sxb-probe-bundle-exit', '1');
          console.error(`::notice title=SXB-PROBE bundle::exit code=${code}`);
        }
      } catch { /* silencieux */ }
    });
  } catch { /* silencieux */ }
}

module.exports = config;

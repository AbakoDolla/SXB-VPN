/**
 * Expo Config Plugin — VPN natif Android SXB v6 (moteur libbox in-process)
 *
 * 1. Injecte les permissions VPN + déclaration du service dans AndroidManifest.xml
 *    (type de service en premier plan `specialUse` — requis Android 14+)
 * 2. Copie tous les fichiers Kotlin (modules/android-native/) dans android/
 * 3. Enregistre SxbVpnPackage dans MainApplication.kt
 * 4. Ajoute les dépendances JSch + Coroutines + FCM + libbox.aar dans app/build.gradle
 * 5. Injecte la configuration Firebase publique lorsqu'elle est disponible
 * 6. Copie libs/libbox.aar dans android/app/libs/
 * 7. Injecte les règles ProGuard R8
 */
const { withAndroidManifest, withDangerousMod, withAppBuildGradle, withGradleProperties } = require('@expo/config-plugins');
const path = require('path');
const fs   = require('fs');
const { execFileSync } = require('child_process');

// ── 1. Permissions + déclaration service dans AndroidManifest.xml ─────────────
function withVpnManifest(config) {
  const isPlay = config.extra?.distribution === 'play';
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    const wasPlay = manifest.application?.[0]?.['meta-data']?.some(entry =>
      entry.$?.['android:name'] === 'com.sxbvpn.distribution' && entry.$?.['android:value'] === 'play');
    manifest.$ = manifest.$ || {};
    manifest.$['xmlns:tools'] = manifest.$['xmlns:tools'] || 'http://schemas.android.com/tools';

    // Permissions
    if (!manifest['uses-permission']) manifest['uses-permission'] = [];
    const perms = manifest['uses-permission'];
    if (wasPlay && !isPlay) {
      for (const permission of perms) {
        if (['android.permission.REQUEST_INSTALL_PACKAGES', 'android.permission.BIND_VPN_SERVICE']
          .includes(permission.$?.['android:name'])) delete permission.$['tools:node'];
      }
    }
    const vpnPerms = [
      'android.permission.INTERNET',
      // E3 — Mise à jour in-app : Android >= 8 exige REQUEST_INSTALL_PACKAGES
      // pour lancer un installer d'APK via IntentLauncher. La demande
      // « Installer » reste affichée à l'utilisateur (nous ne l'installons pas
      // silencieusement, la signature stable évite juste la désinstallation).
      ...(!isPlay ? ['android.permission.REQUEST_INSTALL_PACKAGES'] : []),
      'android.permission.FOREGROUND_SERVICE',
      // FIX — WAKE_LOCK : empêche Android de tuer le service VPN quand l'écran est éteint.
      // Sans ce verrou, le foreground service peut être suspendu par Doze mode, causant
      // des déconnexions aléatoires sur batterie avec écran verrouillé.
      'android.permission.WAKE_LOCK',
      // FIX CRITIQUE Android 14 (API 34) — type de service en premier plan.
      // FOREGROUND_SERVICE_CONNECTED_DEVICE exigeait en plus une permission
      // runtime (BLUETOOTH_*/CHANGE_NETWORK_STATE/NFC) absente de l'app :
      // startForeground() levait une SecurityException et le service VPN
      // mourait avant d'établir le tunnel (aucune clé VPN dans la barre d'état).
      // `specialUse` est le type correct pour une app VPN tierce.
      'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.ACCESS_WIFI_STATE',
      'android.permission.CHANGE_NETWORK_STATE',
    ];
    vpnPerms.forEach(perm => {
      if (!perms.find(p => p.$?.['android:name'] === perm)) {
        perms.push({ $: { 'android:name': perm } });
      }
    });

    // Ces permissions proviennent de manifests de debug/Expo et ne sont pas
    // utilisées par SXB VPN. Les retirer explicitement réduit la surface
    // déclarée et évite qu’elles reviennent lors d’un prebuild propre.
    for (const name of [
      'android.permission.CAMERA',
      'android.permission.RECEIVE_BOOT_COMPLETED',
      'android.permission.SYSTEM_ALERT_WINDOW',
      ...(isPlay ? [
        'android.permission.REQUEST_INSTALL_PACKAGES',
        'android.permission.BIND_VPN_SERVICE',
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
        'android.permission.READ_MEDIA_IMAGES',
        'android.permission.READ_MEDIA_VIDEO',
        'android.permission.READ_MEDIA_AUDIO',
        'android.permission.RECORD_AUDIO',
        'android.permission.ACCESS_COARSE_LOCATION',
        'android.permission.ACCESS_FINE_LOCATION',
        'android.permission.ACCESS_BACKGROUND_LOCATION',
        'android.permission.READ_PHONE_STATE',
        'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
        'com.google.android.gms.permission.AD_ID',
        'android.permission.ACCESS_ADSERVICES_AD_ID',
        'android.permission.ACCESS_ADSERVICES_ATTRIBUTION',
        'android.permission.ACCESS_ADSERVICES_TOPICS',
      ] : []),
    ]) {
      const existing = perms.find(p => p.$?.['android:name'] === name);
      if (existing) existing.$['tools:node'] = 'remove';
      else perms.push({ $: { 'android:name': name, 'tools:node': 'remove' } });
    }

    // BIND_VPN_SERVICE avec android:required=false (non-bloquant si absent)
    const bindVpnPerm = 'android.permission.BIND_VPN_SERVICE';
    if (!perms.find(p => p.$?.['android:name'] === bindVpnPerm)) {
      perms.push({ $: { 'android:name': bindVpnPerm } });
    }

    const app = manifest.application?.[0];
    if (!app) return mod;
    app['meta-data'] = app['meta-data'] || [];
    const setMetadata = (name, value) => {
      app['meta-data'] = app['meta-data'].filter(entry => entry.$?.['android:name'] !== name);
      app['meta-data'].push({ $: {
        'android:name': name, 'android:value': value, 'tools:replace': 'android:value',
      } });
    };
    setMetadata('com.sxbvpn.distribution', isPlay ? 'play' : 'direct');
    const apiBase = (process.env.EXPO_PUBLIC_API_URL || 'https://vpnsxb.afrihall.com/api').trim().replace(/\/+$/, '');
    const api = new URL(apiBase);
    if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash) {
      throw new Error('SXB access control requires a fixed HTTPS API origin');
    }
    setMetadata('com.sxbvpn.api_base_url', apiBase);
    const firebaseMetadata = [
      'firebase_messaging_auto_init_enabled',
      'firebase_analytics_collection_enabled',
      'firebase_data_collection_default_enabled',
    ];
    if (isPlay) {
      for (const name of firebaseMetadata) setMetadata(name, 'false');
    } else if (wasPlay) {
      app['meta-data'] = app['meta-data'].filter(entry => !firebaseMetadata.includes(entry.$?.['android:name']));
    }

    // Déclarer le VpnService
    if (!app.service) app.service = [];
    const vpnSvcName = 'com.sxbvpn.vpnmodule.SxbVpnService';
    if (!app.service.find(s => s.$?.['android:name'] === vpnSvcName)) {
      app.service.push({
        $: {
          'android:name': vpnSvcName,
          'android:permission': 'android.permission.BIND_VPN_SERVICE',
          // Voir la note sur FOREGROUND_SERVICE_SPECIAL_USE ci-dessus.
          'android:foregroundServiceType': 'specialUse',
          'android:stopWithTask': 'false',
          'android:exported': 'false',
        },
        'intent-filter': [{ action: [{ $: { 'android:name': 'android.net.VpnService' } }] }],
        // Requis par Google Play pour le type `specialUse` : justifie l'usage.
        property: [{
          $: {
            'android:name': 'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE',
            'android:value': 'vpn',
          },
        }],
      });
    } else {
      // Service déjà déclaré (prebuild incrémental) : corriger le type hérité.
      const svc = app.service.find(s => s.$?.['android:name'] === vpnSvcName);
      svc.$['android:foregroundServiceType'] = 'specialUse';
      svc.$['android:stopWithTask'] = 'false';
    }

    const messagingServiceName = 'com.sxbvpn.vpnmodule.SxbFirebaseMessagingService';
    if (!app.service.find(s => s.$?.['android:name'] === messagingServiceName)) {
      app.service.push({
        $: {
          'android:name': messagingServiceName,
          'android:exported': 'false',
        },
        'intent-filter': [{
          action: [{ $: { 'android:name': 'com.google.firebase.MESSAGING_EVENT' } }],
        }],
      });
    }

    // An existing direct-install FCM token may still receive messages after an
    // upgrade. Native consent code explicitly enables these components only
    // after notifications consent; auto-init metadata alone cannot block them.
    for (const [type, name] of [
      ['service', messagingServiceName],
      ['service', 'com.google.firebase.messaging.FirebaseMessagingService'],
      ['receiver', 'com.google.firebase.iid.FirebaseInstanceIdReceiver'],
    ]) {
      app[type] = app[type] || [];
      if (isPlay) {
        let component = app[type].find(entry => entry.$?.['android:name'] === name);
        if (!component) {
          component = { $: { 'android:name': name } };
          app[type].push(component);
        }
        component.$['android:enabled'] = 'false';
        component.$['tools:replace'] = 'android:enabled';
      } else if (wasPlay) {
        if (name === messagingServiceName) {
          const component = app[type].find(entry => entry.$?.['android:name'] === name);
          delete component.$['android:enabled'];
          delete component.$['tools:replace'];
        } else {
          app[type] = app[type].filter(entry => entry.$?.['android:name'] !== name);
        }
      }
    }

    if (!app.provider) app.provider = [];
    const firebaseProviderName = 'com.sxbvpn.vpnmodule.SxbFirebaseInitProvider';
    if (wasPlay && !isPlay) {
      app.provider = app.provider.filter(p => !(p.$?.['tools:node'] === 'remove' &&
        [firebaseProviderName, 'com.google.firebase.provider.FirebaseInitProvider'].includes(p.$?.['android:name'])));
    }
    if (isPlay) {
      for (const name of [firebaseProviderName, 'com.google.firebase.provider.FirebaseInitProvider']) {
        app.provider = app.provider.filter(p => p.$?.['android:name'] !== name);
        app.provider.push({ $: { 'android:name': name, 'tools:node': 'remove' } });
      }
    } else if (!app.provider.find(p => p.$?.['android:name'] === firebaseProviderName)) {
      app.provider.push({
        $: {
          'android:name': firebaseProviderName,
          'android:authorities': '${applicationId}.sxb-firebase-init',
          'android:exported': 'false',
          'android:initOrder': '100',
        },
      });
    }

    return mod;
  });
}

// ── 2. Copie des fichiers Kotlin ──────────────────────────────────────────────
function withKotlinSources(config) {
  return withDangerousMod(config, ['android', (cfg) => {
    const projectRoot  = cfg.modRequest.projectRoot;
    const platformRoot = cfg.modRequest.platformProjectRoot;
    const destDir = path.join(platformRoot, 'app', 'src', 'main', 'java', 'com', 'sxbvpn', 'vpnmodule');
    fs.mkdirSync(destDir, { recursive: true });

    const srcDir = path.join(projectRoot, 'modules', 'android-native');
    if (fs.existsSync(srcDir)) {
      fs.readdirSync(srcDir).filter(f => f.endsWith('.kt')).forEach(file => {
        fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
        console.log('[SXB VPN plugin] Copié ' + file);
      });
    } else {
      console.warn('[SXB VPN plugin] android-native/ non trouvé : ' + srcDir);
    }

    // ProGuard
    const proguardFile = path.join(platformRoot, 'app', 'proguard-rules.pro');
    // libbox/gomobile appellent nos classes par réflexion depuis Go : sans ces
    // règles, R8 supprime PlatformInterface et le moteur plante au démarrage.
    const rules = [
      '',
      '# SXB VPN',
      '-keep class com.sxbvpn.vpnmodule.** { *; }',
      '-keep class com.jcraft.jsch.** { *; }',
      '-dontwarn com.jcraft.jsch.**',
      // BouncyCastle (compagnon JSch pour ed25519/curve25519) — R8 ne doit ni
      // obfusquer ni élaguer ces classes, JSch y accède par réflexion.
      '-keep class org.bouncycastle.** { *; }',
      '-dontwarn org.bouncycastle.**',
      '# Moteur sing-box (libbox / gomobile)',
      '-keep class io.nekohasekai.libbox.** { *; }',
      '-keep interface io.nekohasekai.libbox.** { *; }',
      '-keep class go.** { *; }',
      '-dontwarn io.nekohasekai.libbox.**',
      '-dontwarn go.**',
      '',
    ].join('\n');
    if (fs.existsSync(proguardFile)) {
      const existing = fs.readFileSync(proguardFile, 'utf8');
      if (!existing.includes('com.sxbvpn.vpnmodule')) fs.appendFileSync(proguardFile, rules);
    } else {
      fs.writeFileSync(proguardFile, rules);
    }
    return cfg;
  }]);
}

// ── 3. Enregistrer SxbVpnPackage dans MainApplication.kt ─────────────────────
function withMainAppPackage(config) {
  return withDangerousMod(config, ['android', (cfg) => {
    const platformRoot = cfg.modRequest.platformProjectRoot;
    const packageName  = cfg.android?.package || 'com.sxbvpn.mobile';
    const mainAppPath  = path.join(
      platformRoot, 'app', 'src', 'main', 'java',
      ...packageName.split('.'), 'MainApplication.kt'
    );
    if (!fs.existsSync(mainAppPath)) return cfg;

    let src = fs.readFileSync(mainAppPath, 'utf8');
    const importLine  = 'import com.sxbvpn.vpnmodule.SxbVpnPackage';
    // Dans un bloc .apply { }, le receiver EST la liste → add(...) sans préfixe
    const addCall     = 'add(SxbVpnPackage())';
    // Hors apply {}, la variable s'appelle packages
    const packageCall = 'packages.add(SxbVpnPackage())';

    if (!src.includes('SxbVpnPackage')) {
      // Import
      src = src.replace(
        /^(package .+\n)/m,
        `$1${importLine}\n`
      );

      // Priorité 1 — Expo SDK 50+ / RN 0.73+ :
      //   override fun getPackages() = PackageList(this).packages.apply {
      //       // commentaire
      //   }
      if (src.includes('PackageList(this).packages.apply')) {
        src = src.replace(
          /(PackageList\(this\)\.packages\.apply\s*\{[^\n]*\n)/,
          `$1        ${addCall}\n`
        );
        console.log('[SXB VPN plugin] SxbVpnPackage injecté dans .packages.apply {} (Expo SDK 50+ / RN 0.73+)');

      // Priorité 2 — RN 0.71-0.72 : val packages = PackageList(this).packages
      } else if (src.includes('PackageList(this).packages')) {
        src = src.replace(
          /(val packages = PackageList\(this\)\.packages\s*\n)/,
          `$1      ${packageCall}\n`
        );
        console.log('[SXB VPN plugin] SxbVpnPackage injecté après PackageList (RN 0.71-0.72)');

      // Priorité 3 — RN legacy : packages.add(MainReactPackage())
      } else if (src.includes('MainReactPackage()')) {
        src = src.replace(
          /(packages\.add\(MainReactPackage\(\)\))/m,
          `$1\n      ${packageCall}`
        );
        console.log('[SXB VPN plugin] SxbVpnPackage injecté après MainReactPackage (RN legacy)');

      // Priorité 4 — Fallback universel : avant "return packages"
      } else if (src.includes('return packages')) {
        src = src.replace(
          /(\breturn packages\b)/m,
          `${packageCall}\n      $1`
        );
        console.log('[SXB VPN plugin] SxbVpnPackage injecté via fallback return-packages');

      // Priorité 5 — Dernier recours : injecter dans getPackages()
      } else {
        src = src.replace(
          /(override fun getPackages\(\)[^{]*\{)/,
          `$1\n      ${packageCall}`
        );
        console.log('[SXB VPN plugin] SxbVpnPackage injecté via fallback getPackages() body');
      }

      fs.writeFileSync(mainAppPath, src);
      console.log('[SXB VPN plugin] SxbVpnPackage enregistré dans MainApplication.kt');

      // Vérification post-écriture — une injection ratée produit un APK qui se
      // lance normalement mais dont le module VPN est introuvable côté JS. Le
      // build doit échouer ici plutôt que de livrer une application sans VPN.
      const written = fs.readFileSync(mainAppPath, 'utf8');
      if (!written.includes('SxbVpnPackage')) {
        const idx = written.indexOf('getPackages');
        const excerpt = idx !== -1 ? written.slice(Math.max(0, idx - 100), idx + 500) : '(getPackages introuvable)';
        throw new Error(
          '[SXB VPN plugin] INJECTION ÉCHOUÉE — SxbVpnPackage absent de MainApplication.kt.\n' +
          'Contenu autour de getPackages :\n' + excerpt
        );
      }
      console.log('[SXB VPN plugin] ✅ Vérification OK — SxbVpnPackage présent');
    } else {
      console.log('[SXB VPN plugin] SxbVpnPackage déjà présent dans MainApplication.kt — skip');
    }
    return cfg;
  }]);
}

// ── 4. Dépendances Gradle ─────────────────────────────────────────────────────
function withJschDependency(config) {
  return withAppBuildGradle(config, (mod) => {
    let gradle = mod.modResults.contents;

    const deps = [
      "implementation(\"com.github.mwiede:jsch:0.2.21\")",
      "implementation(\"org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3\")",
      "implementation(\"org.bouncycastle:bcprov-jdk18on:1.78.1\")",
      "implementation(\"org.bouncycastle:bcutil-jdk18on:1.78.1\")",
      // Aucun plugin google-services et aucun google-services.json : les
      // identifiants publics sont injectés seulement quand les 4 variables
      // EXPO_PUBLIC_FIREBASE_* sont présentes au prebuild.
      "implementation(\"com.google.firebase:firebase-messaging:24.1.2\")",
      // Moteur sing-box embarqué (libbox.aar déposé dans android/app/libs/).
      // Remplace l'ancien binaire exécuté par ProcessBuilder — interdit depuis
      // Android 10 (W^X) et incapable de recevoir le descripteur du TUN.
      //
      // ATTENTION : app/build.gradle est en Groovy, PAS en Kotlin DSL.
      // La syntaxe `fileTree(mapOf("dir" to ...))` est du Kotlin et provoque
      // « No signature of method: java.lang.String.to() » à l'évaluation.
      "implementation fileTree(dir: 'libs', include: ['*.aar'])",
    ];
    deps.forEach(dep => {
      if (!gradle.includes(dep)) {
        gradle = gradle.replace(
          /dependencies\s*\{/,
          `dependencies {\n    ${dep}`
        );
      }
    });

    // JitPack repository pour JSch
    if (!gradle.includes('jitpack.io')) {
      gradle = gradle.replace(
        /repositories\s*\{/,
        `repositories {\n        maven { url = uri("https://jitpack.io") }`
      );
    }

    // Packaging exclusions — liste complète (évite les conflits META-INF en AGP 8+)
    if (!gradle.includes('packaging {')) {
      gradle = gradle.replace(
        /android\s*\{/,
        `android {\n    packaging {\n        resources {\n            excludes += "/META-INF/{AL2.0,LGPL2.1}"\n            excludes += "META-INF/LICENSE.md"\n            excludes += "META-INF/LICENSE-notice.md"\n            excludes += "META-INF/versions/**"\n            excludes += "META-INF/*.kotlin_module"\n            excludes += "META-INF/AL2.0"\n            excludes += "META-INF/LGPL2.1"\n        }\n    }`
      );
    }

    mod.modResults.contents = gradle;
    return mod;
  });
}

function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── 5. Configuration publique Firebase optionnelle ──────────────────────────
function withOptionalFirebaseResources(config) {
  return withDangerousMod(config, ['android', (cfg) => {
    const platformRoot = cfg.modRequest.platformProjectRoot;
    const valuesDir = path.join(platformRoot, 'app', 'src', 'main', 'res', 'values');
    const output = path.join(valuesDir, 'sxb_firebase.xml');
    const values = {
      sxb_firebase_api_key: process.env.EXPO_PUBLIC_FIREBASE_API_KEY?.trim() || '',
      sxb_firebase_project_id: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID?.trim() || '',
      sxb_firebase_app_id: process.env.EXPO_PUBLIC_FIREBASE_APP_ID?.trim() || '',
      sxb_firebase_sender_id: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID?.trim() || '',
    };
    const configured = Object.values(values).every(Boolean);
    if (!configured) {
      if (fs.existsSync(output)) fs.unlinkSync(output);
      console.log('[SXB VPN plugin] Firebase non configuré — FCM désactivé sans bloquer le build');
      return cfg;
    }

    fs.mkdirSync(valuesDir, { recursive: true });
    const resources = Object.entries(values)
      .map(([name, value]) => `    <string name="${name}" translatable="false">${escapeXml(value)}</string>`)
      .join('\n');
    fs.writeFileSync(output, `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n${resources}\n</resources>\n`);
    console.log('[SXB VPN plugin] Configuration publique Firebase injectée');
    return cfg;
  }]);
}

// ── 6. Moteur libbox (AAR) dans android/app/libs ──────────────────────────────
//
// Remplace l'ancienne copie des binaires sing-box dans les assets. Ces binaires
// ne pouvaient de toute façon pas être exécutés (Android 10+ interdit l'exécution
// depuis le répertoire privé) ni recevoir le descripteur du TUN.
//
// libbox.aar est produit par le workflow CI (gomobile bind) et déposé dans
// app-mobile/libs/libbox.aar.
function withLibboxAar(config) {
  return withDangerousMod(config, ['android', (cfg) => {
    const projectRoot  = cfg.modRequest.projectRoot;
    const platformRoot = cfg.modRequest.platformProjectRoot;
    const libsDir      = path.join(platformRoot, 'app', 'libs');
    fs.mkdirSync(libsDir, { recursive: true });

    const src = path.join(projectRoot, 'libs', 'libbox.aar');
    const dst = path.join(libsDir, 'libbox.aar');

    // Construction automatique si l'AAR est absent.
    //
    // Le moteur est indispensable : sans lui, SxbVpnService.kt ne compile pas
    // (imports io.nekohasekai.libbox.*). On le construit donc ici, pendant le
    // prebuild, plutôt que d'exiger une étape dédiée dans le workflow — ce qui
    // rend le build autonome quel que soit l'environnement (CI ou local).
    //
    // Go et le NDK Android sont préinstallés sur les runners ubuntu-latest.
    // Compter ~10 min la première fois ; définir SXB_SKIP_LIBBOX_BUILD=1 pour
    // sauter cette étape (build hors-ligne avec un AAR déjà présent).
    if (!fs.existsSync(src) && process.env.SXB_SKIP_LIBBOX_BUILD !== '1') {
      const script = path.join(projectRoot, 'scripts', 'build-libbox.sh');
      if (fs.existsSync(script)) {
        console.log('[SXB VPN plugin] libbox.aar absent — construction du moteur sing-box...');
        console.log('[SXB VPN plugin] (~10 min ; SXB_SKIP_LIBBOX_BUILD=1 pour sauter)');
        try {
          execFileSync('bash', [script], { cwd: projectRoot, stdio: 'inherit' });
        } catch (e) {
          console.error('[SXB VPN plugin] ❌ Échec de la construction de libbox.aar');
          throw new Error(
            'Impossible de construire libbox.aar (moteur VPN). ' +
            'Vérifiez Go >= 1.23 et le NDK Android, ou fournissez app-mobile/libs/libbox.aar. ' +
            'Détail : ' + (e && e.message ? e.message : e)
          );
        }
      }
    }

    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      const mb = (fs.statSync(dst).size / 1048576).toFixed(1);
      console.log(`[SXB VPN plugin] Copié libbox.aar → android/app/libs (${mb} MB)`);
    } else {
      // Échouer franchement plutôt que de laisser Gradle produire une erreur
      // Kotlin obscure (« unresolved reference: nekohasekai ») 10 min plus tard.
      throw new Error(
        'app-mobile/libs/libbox.aar introuvable — le moteur VPN ne peut pas être compilé. ' +
        'Lancez ./scripts/build-libbox.sh.'
      );
    }
    return cfg;
  }]);
}

// ── 7. FileProvider (mise à jour in-app) ─────────────────────────────────────
// Déclare androidx.core.content.FileProvider avec l'autorité
// `<package>.provider` et un file_paths.xml minimal exposant le cache privé
// (où est téléchargé l'APK). Nécessaire pour ouvrir l'installateur via un URI
// content:// (les file:// sont interdits depuis Android 7 / N).
//
// Cible utilisée par UpdatePrompt : FileSystem.getContentUriAsync(uri) génère
// un content://<package>.provider/... qui pointe dans cache-path/document-path.
function withFileProvider(config) {
  return withAndroidManifest(config, (mod) => {
    const app = mod.modResults.manifest.application?.[0];
    if (!app) return mod;
    const packageName = mod.modResults.manifest.$['package'] || config.android?.package || 'com.sxbvpn.mobile';
    const authority = `${packageName}.provider`;

    if (!app.provider) app.provider = [];
    if (!app.provider.find((p) => p.$?.['android:authorities'] === authority)) {
      app.provider.push({
        $: {
          'android:name': 'androidx.core.content.FileProvider',
          'android:authorities': authority,
          'android:exported': 'false',
          'android:grantUriPermissions': 'true',
        },
        'meta-data': [{
          $: {
            'android:name': 'android.support.FILE_PROVIDER_PATHS',
            'android:resource': '@xml/sxb_file_paths',
          },
        }],
      });
    }
    return mod;
  });
}

function withFileProviderXml(config) {
  return withDangerousMod(config, ['android', (cfg) => {
    const platformRoot = cfg.modRequest.platformProjectRoot;
    const xmlDir = path.join(platformRoot, 'app', 'src', 'main', 'res', 'xml');
    fs.mkdirSync(xmlDir, { recursive: true });
    const xmlPath = path.join(xmlDir, 'sxb_file_paths.xml');
    // Autoriser cache-path (téléchargement d'APK) + files-path pour compat.
    // Pas de external-path — l'APK reste dans le sandbox privé de l'app.
    const content = `<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
    <cache-path name="sxb_cache" path="." />
    <files-path name="sxb_files" path="." />
    <external-cache-path name="sxb_ext_cache" path="." />
</paths>
`;
    fs.writeFileSync(xmlPath, content);
    console.log('[SXB VPN plugin] file_paths.xml écrit → ' + xmlPath);
    return cfg;
  }]);
}

function withEngineData(config) {
  return withDangerousMod(config, ['android', async cfg => {
    const { prepareGeosite, DEFAULT_DIRECTORY } = require('../scripts/prepare-geosite.cjs');
    await prepareGeosite();
    const destination = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'assets', 'sxb-engine');
    fs.mkdirSync(destination, { recursive: true });
    for (const name of ['geosite.db', 'geosite.sha256', 'NOTICE.txt']) {
      fs.copyFileSync(path.join(DEFAULT_DIRECTORY, name), path.join(destination, name));
    }
    return cfg;
  }]);
}

// ── Export composite ──────────────────────────────────────────────────────────
module.exports = function withSxbVpn(config) {
  config = withVpnManifest(config);
  config = withKotlinSources(config);
  config = withMainAppPackage(config);
  config = withJschDependency(config);
  config = withOptionalFirebaseResources(config);
  config = withLibboxAar(config);
  config = withFileProvider(config);
  config = withFileProviderXml(config);
  config = withEngineData(config);
  if (config.extra?.distribution === 'play') {
    config = withGradleProperties(config, mod => {
      const properties = {
        'android.compileSdkVersion': '36',
        'android.targetSdkVersion': '36',
        'android.minSdkVersion': '24',
        // DNSTT is executed from nativeLibraryDir, so libraries must be extracted.
        'expo.useLegacyPackaging': 'true',
        'reactNativeArchitectures': 'arm64-v8a,armeabi-v7a',
      };
      mod.modResults = mod.modResults.filter(item => !(item.key in properties));
      for (const [key, value] of Object.entries(properties)) {
        mod.modResults.push({ type: 'property', key, value });
      }
      return mod;
    });
  }
  return config;
};

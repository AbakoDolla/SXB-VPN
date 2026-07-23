/**
 * Expo Config Plugin — VPN natif Android SXB v5
 *
 * 1. Injecte les permissions VPN + déclaration du service dans AndroidManifest.xml
 * 2. Copie tous les fichiers Kotlin (modules/android-native/) dans android/
 * 3. Enregistre SxbVpnPackage dans MainApplication.kt
 * 4. Ajoute les dépendances JSch + Coroutines dans app/build.gradle
 * 5. Copie les binaires sing-box dans android/app/src/main/assets/
 * 6. Injecte les règles ProGuard R8
 */
const { withAndroidManifest, withDangerousMod, withAppBuildGradle } = require('@expo/config-plugins');
const path = require('path');
const fs   = require('fs');

// ── 1. Permissions + déclaration service dans AndroidManifest.xml ─────────────
function withVpnManifest(config) {
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;

    // Permissions
    if (!manifest['uses-permission']) manifest['uses-permission'] = [];
    const perms = manifest['uses-permission'];
    const vpnPerms = [
      'android.permission.INTERNET',
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE',
      'android.permission.RECEIVE_BOOT_COMPLETED',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.CHANGE_NETWORK_STATE',
      'android.permission.ACCESS_NETWORK_STATE',
    ];
    vpnPerms.forEach(perm => {
      if (!perms.find(p => p.$?.['android:name'] === perm)) {
        perms.push({ $: { 'android:name': perm } });
      }
    });

    // BIND_VPN_SERVICE avec android:required=false (non-bloquant si absent)
    const bindVpnPerm = 'android.permission.BIND_VPN_SERVICE';
    if (!perms.find(p => p.$?.['android:name'] === bindVpnPerm)) {
      perms.push({ $: { 'android:name': bindVpnPerm } });
    }

    const app = manifest.application?.[0];
    if (!app) return mod;

    // Déclarer le VpnService
    if (!app.service) app.service = [];
    const vpnSvcName = 'com.sxbvpn.vpnmodule.SxbVpnService';
    if (!app.service.find(s => s.$?.['android:name'] === vpnSvcName)) {
      app.service.push({
        $: {
          'android:name': vpnSvcName,
          'android:permission': 'android.permission.BIND_VPN_SERVICE',
          'android:foregroundServiceType': 'connectedDevice',
          'android:exported': 'false',
        },
        'intent-filter': [{ action: [{ $: { 'android:name': 'android.net.VpnService' } }] }],
      });
    }

    // Déclarer BootReceiver
    if (!app.receiver) app.receiver = [];
    const bootReceiverName = 'com.sxbvpn.vpnmodule.BootReceiver';
    if (!app.receiver.find(r => r.$?.['android:name'] === bootReceiverName)) {
      app.receiver.push({
        $: { 'android:name': bootReceiverName, 'android:enabled': 'true', 'android:exported': 'false' },
        'intent-filter': [{ action: [{ $: { 'android:name': 'android.intent.action.BOOT_COMPLETED' } }] }],
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
    const rules = '\n# SXB VPN\n-keep class com.sxbvpn.vpnmodule.** { *; }\n-keep class com.jcraft.jsch.** { *; }\n-dontwarn com.jcraft.jsch.**\n';
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
          `$1        ${packageCall}\n`
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

      // Vérification post-écriture
      const written = fs.readFileSync(mainAppPath, 'utf8');
      if (!written.includes('SxbVpnPackage')) {
        console.error('[SXB VPN plugin] ⚠️  INJECTION ÉCHOUÉE — SxbVpnPackage absent de MainApplication.kt');
        console.error('[SXB VPN plugin] Contenu autour de getPackages :');
        const idx = written.indexOf('getPackages');
        if (idx !== -1) console.error(written.slice(Math.max(0, idx - 100), idx + 500));
      } else {
        console.log('[SXB VPN plugin] ✅ Vérification OK — SxbVpnPackage présent');
      }
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
        `android {\n    packaging {\n        resources {\n            excludes += "/META-INF/{AL2.0,LGPL2.1}"\n            excludes += "META-INF/LICENSE.md"\n            excludes += "META-INF/LICENSE-notice.md"\n            excludes += "META-INF/versions/9/OSGI-INF/MANIFEST.MF"\n            excludes += "META-INF/*.kotlin_module"\n            excludes += "META-INF/AL2.0"\n            excludes += "META-INF/LGPL2.1"\n        }\n    }`
      );
    }

    mod.modResults.contents = gradle;
    return mod;
  });
}

// ── 5. Binaires sing-box dans Android assets ──────────────────────────────────
function withSingBoxAssets(config) {
  return withDangerousMod(config, ['android', (cfg) => {
    const projectRoot  = cfg.modRequest.projectRoot;
    const platformRoot = cfg.modRequest.platformProjectRoot;
    const assetsDir    = path.join(platformRoot, 'app', 'src', 'main', 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    ['sing-box-arm64', 'sing-box-arm'].forEach(name => {
      const src = path.join(projectRoot, 'assets', name);
      const dst = path.join(assetsDir, name);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
        console.log('[SXB VPN plugin] Copié ' + name + ' → android assets');
      }
    });
    return cfg;
  }]);
}

// ── Export composite ──────────────────────────────────────────────────────────
module.exports = function withSxbVpn(config) {
  config = withVpnManifest(config);
  config = withKotlinSources(config);
  config = withMainAppPackage(config);
  config = withJschDependency(config);
  config = withSingBoxAssets(config);
  return config;
};

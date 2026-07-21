/**
 * Expo Config Plugin — VPN natif Android SXB v4
 *
 * 1. Copie tous les fichiers Kotlin (android-native/) dans android/
 * 2. Injecte permissions VPN + déclaration du service dans AndroidManifest.xml
 * 3. Enregistre SxbVpnPackage dans MainApplication.kt
 * 4. Ajoute les dépendances JSch + Coroutines dans app/build.gradle
 * 5. Copie les binaires sing-box dans android/app/src/main/assets/
 */
const { withAndroidManifest, withDangerousMod, withAppBuildGradle } = require('@expo/config-plugins');
const path = require('path');
const fs   = require('fs');

// ── 1. Copie des fichiers Kotlin ──────────────────────────────────────────────
function withKotlinSources(config) {
  return withDangerousMod(config, ['android', (cfg) => {
    const projectRoot  = cfg.modRequest.projectRoot;
    const platformRoot = cfg.modRequest.platformProjectRoot;

    const destDir = path.join(platformRoot, 'app', 'src', 'main', 'java', 'com', 'sxbvpn', 'vpnmodule');
    fs.mkdirSync(destDir, { recursive: true });

    const srcDir = path.join(projectRoot, 'modules', 'android-native');
    if (fs.existsSync(srcDir)) {
      fs.readdirSync(srcDir).forEach((file) => {
        if (file.endsWith('.kt')) {
          const src = path.join(srcDir, file);
          const dst = path.join(destDir, file);
          fs.copyFileSync(src, dst);
          console.log('[VPN plugin] Copié ' + file + ' → ' + destDir);
        }
      });
    } else {
      console.warn('[VPN plugin] Source dir non trouvé: ' + srcDir);
    }

    return cfg;
  }]);
}

// ── 2. Permissions + service dans AndroidManifest ─────────────────────────────
function withVpnManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    const app      = manifest.manifest.application[0];

    const toAdd = [
      'android.permission.INTERNET',
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
      'android.permission.RECEIVE_BOOT_COMPLETED',
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.CHANGE_NETWORK_STATE',
    ];

    const existing = (manifest.manifest['uses-permission'] || []).map(
      (p) => p.$['android:name']
    );
    toAdd.forEach((perm) => {
      if (!existing.includes(perm)) {
        manifest.manifest['uses-permission'] = manifest.manifest['uses-permission'] || [];
        manifest.manifest['uses-permission'].push({ $: { 'android:name': perm } });
      }
    });

    // VpnService dans le manifest
    if (!app.service) app.service = [];
    const hasSxbService = app.service.some(
      (s) => s.$?.['android:name'] === 'com.sxbvpn.vpnmodule.SxbVpnService'
    );
    if (!hasSxbService) {
      app.service.push({
        $: {
          'android:name': 'com.sxbvpn.vpnmodule.SxbVpnService',
          'android:permission': 'android.permission.BIND_VPN_SERVICE',
          'android:exported': 'false',
          'android:foregroundServiceType': 'specialUse',
        },
        'intent-filter': [{ action: [{ $: { 'android:name': 'android.net.VpnService' } }] }],
        'property': [{
          $: {
            'android:name': 'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE',
            'android:value': 'VPN tunnel service for SXB VPN',
          }
        }],
      });
    }

    return cfg;
  });
}

// ── 3. SxbVpnPackage dans MainApplication.kt ──────────────────────────────────
function withMainAppPackage(config) {
  return withDangerousMod(config, ['android', (cfg) => {
    const platformRoot = cfg.modRequest.platformProjectRoot;
    const pkgId        = cfg.modRequest.packageName || 'com.sxbvpn.app';
    const pkgPath      = pkgId.replace(/\./g, '/');
    const mainAppPath  = path.join(
      platformRoot, 'app', 'src', 'main', 'java', pkgPath, 'MainApplication.kt'
    );

    if (!fs.existsSync(mainAppPath)) {
      console.warn('[VPN plugin] MainApplication.kt non trouvé : ' + mainAppPath);
      return cfg;
    }

    let content = fs.readFileSync(mainAppPath, 'utf8');

    const importLine  = 'import com.sxbvpn.vpnmodule.SxbVpnPackage';
    const packageCall = 'packages.add(SxbVpnPackage())';

    if (!content.includes(importLine)) {
      content = content.replace(
        /^(package .+)$/m,
        `$1\n${importLine}`
      );
    }

    if (!content.includes(packageCall)) {
      content = content.replace(
        /return packages/,
        `${packageCall}\n        return packages`
      );
    }

    fs.writeFileSync(mainAppPath, content, 'utf8');
    console.log('[VPN plugin] SxbVpnPackage enregistré dans MainApplication.kt');
    return cfg;
  }]);
}

// ── 4. Dépendances Gradle ─────────────────────────────────────────────────────
function withJschDependency(config) {
  return withAppBuildGradle(config, (cfg) => {
    let gradle = cfg.modResults.contents;

    // JSch pour SSH
    if (!gradle.includes('com.jcraft:jsch')) {
      gradle = gradle.replace(
        /dependencies\s*\{/,
        `dependencies {\n    implementation("com.jcraft:jsch:0.1.55")`
      );
    }

    // Kotlin Coroutines pour AutoReconnectManager
    if (!gradle.includes('kotlinx-coroutines-android')) {
      gradle = gradle.replace(
        /dependencies\s*\{/,
        `dependencies {\n    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")`
      );
    }

    // Packaging exclusions pour éviter les conflits META-INF
    const packagingBlock = `\n    packaging {\n        resources {\n            excludes += "/META-INF/{AL2.0,LGPL2.1}"\n            excludes += "META-INF/LICENSE.md"\n            excludes += "META-INF/LICENSE-notice.md"\n        }\n    }`;
    if (!gradle.includes('META-INF/{AL2.0,LGPL2.1}')) {
      gradle = gradle.replace(
        /android\s*\{/,
        'android {' + packagingBlock
      );
    }

    cfg.modResults.contents = gradle;
    return cfg;
  });
}

// ── 5. Binaires sing-box dans Android assets ──────────────────────────────────
function withSingBoxAssets(config) {
  return withDangerousMod(config, ['android', (cfg) => {
    const projectRoot  = cfg.modRequest.projectRoot;
    const platformRoot = cfg.modRequest.platformProjectRoot;
    const assetsDir    = path.join(platformRoot, 'app', 'src', 'main', 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });

    const binaries = ['sing-box-arm64', 'sing-box-arm'];
    for (const name of binaries) {
      const src = path.join(projectRoot, 'assets', name);
      const dst = path.join(assetsDir, name);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
        const sizeMB = Math.round(fs.statSync(dst).size / 1024 / 1024);
        console.log('[VPN plugin] Copié ' + name + ' → android assets (' + sizeMB + ' MB)');
      } else {
        console.warn('[VPN plugin] ' + name + ' absent dans assets/ — sing-box désactivé pour cette architecture');
      }
    }
    return cfg;
  }]);
}

// ── Export composite ──────────────────────────────────────────────────────────
function withVpnPermissions(config) {
  config = withKotlinSources(config);
  config = withVpnManifest(config);
  config = withMainAppPackage(config);
  config = withJschDependency(config);
  config = withSingBoxAssets(config);
  return config;
}

module.exports = withVpnPermissions;

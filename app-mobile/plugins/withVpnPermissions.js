/**
 * Expo Config Plugin — VPN natif Android (SSH tunnel via JSch)
 *
 * 1. Copie les fichiers Kotlin depuis modules/android-native/ dans android/
 * 2. Injecte permissions VPN + déclaration du service dans AndroidManifest.xml
 * 3. Enregistre SxbVpnPackage dans MainApplication.kt
 * 4. Ajoute la dépendance JSch dans app/build.gradle
 */
const { withAndroidManifest, withDangerousMod, withAppBuildGradle } = require('@expo/config-plugins');
const path = require('path');
const fs   = require('fs');

// ── 1. Copie des fichiers Kotlin ──────────────────────────────────────────────
function withKotlinSources(config) {
  return withDangerousMod(config, ['android', (cfg) => {
    const projectRoot   = cfg.modRequest.projectRoot;
    const platformRoot  = cfg.modRequest.platformProjectRoot;

    const destDir = path.join(platformRoot, 'app', 'src', 'main', 'java', 'com', 'sxbvpn', 'vpnmodule');
    fs.mkdirSync(destDir, { recursive: true });

    const srcDir = path.join(projectRoot, 'modules', 'android-native');
    if (fs.existsSync(srcDir)) {
      fs.readdirSync(srcDir).forEach((file) => {
        if (file.endsWith('.kt')) {
          const src = path.join(srcDir, file);
          const dst = path.join(destDir, file);
          fs.copyFileSync(src, dst);
          console.log('[VPN plugin] Copied ' + file + ' -> ' + dst);
        }
      });
    } else {
      console.warn('[VPN plugin] Source dir not found: ' + srcDir);
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
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
      'android.permission.RECEIVE_BOOT_COMPLETED',
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

    const serviceName = 'com.sxbvpn.vpnmodule.SxbVpnService';
    const services    = app.service || [];
    const already     = services.some((s) => s.$['android:name'] === serviceName);

    if (!already) {
      const entry = {
        $: {
          'android:name':                  serviceName,
          'android:exported':              'false',
          'android:permission':            'android.permission.BIND_VPN_SERVICE',
          'android:foregroundServiceType': 'specialUse',
        },
        'intent-filter': [
          { action: [{ $: { 'android:name': 'android.net.VpnService' } }] },
        ],
        property: [{
          $: {
            'android:name':  'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE',
            'android:value': 'VPN tunnel',
          },
        }],
      };
      app.service = [...services, entry];
    }

    return cfg;
  });
}

// ── 3. Enregistrement dans MainApplication.kt ─────────────────────────────────
function withMainAppPackage(config) {
  return withDangerousMod(config, ['android', (cfg) => {
    const platformRoot = cfg.modRequest.platformProjectRoot;

    const mainAppPath = path.join(
      platformRoot, 'app', 'src', 'main', 'java',
      'com', 'sxbvpn', 'app', 'MainApplication.kt'
    );

    if (!fs.existsSync(mainAppPath)) {
      console.warn('[VPN plugin] MainApplication.kt not found at: ' + mainAppPath);
      return cfg;
    }

    let src = fs.readFileSync(mainAppPath, 'utf-8');

    if (src.includes('SxbVpnPackage')) {
      return cfg;
    }

    src = src.replace(
      /^(package .+)$/m,
      '$1\n\nimport com.sxbvpn.vpnmodule.SxbVpnPackage'
    );

    if (src.includes('PackageList(this).packages')) {
      src = src.replace(
        'PackageList(this).packages',
        'PackageList(this).packages.also { it.add(SxbVpnPackage()) }'
      );
    }

    fs.writeFileSync(mainAppPath, src, 'utf-8');
    console.log('[VPN plugin] Patched MainApplication.kt — SxbVpnPackage registered');

    return cfg;
  }]);
}

// ── 4. Dépendance JSch + packagingOptions dans app/build.gradle ───────────────
function withJschDependency(config) {
  return withAppBuildGradle(config, (cfg) => {
    let gradle = cfg.modResults.contents;

    // Ajouter JSch
    const dep = "    implementation 'com.github.mwiede:jsch:0.2.21'";
    if (!gradle.includes('mwiede:jsch')) {
      gradle = gradle.replace(
        /dependencies\s*\{/,
        'dependencies {\n' + dep
      );
      console.log('[VPN plugin] JSch added to app/build.gradle');
    }

    // Exclure le MANIFEST.MF dupliqué entre JSch et jspecify
    const packagingBlock = `
    packaging {
        resources {
            excludes += ['META-INF/versions/9/OSGI-INF/MANIFEST.MF']
        }
    }`;
    if (!gradle.includes('OSGI-INF/MANIFEST.MF')) {
      // Insérer dans le bloc android { ... }
      gradle = gradle.replace(
        /android\s*\{/,
        'android {' + packagingBlock
      );
      console.log('[VPN plugin] packagingOptions exclusion added to app/build.gradle');
    }

    cfg.modResults.contents = gradle;
    return cfg;
  });
}

// ── 5. Copier les binaires sing-box dans Android assets ───────────────────────
// assets.open() dans Kotlin lit depuis android/app/src/main/assets/
// Les fichiers Expo assets/ ne sont PAS copiés auto — plugin obligatoire.
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
        console.warn('[VPN plugin] ' + name + ' absent dans assets/ — protocoles avancés désactivés');
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

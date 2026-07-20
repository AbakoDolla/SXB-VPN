/**
 * Expo Config Plugin — VPN natif Android (SSH tunnel)
 *
 * Ce plugin fait trois choses lors de `expo prebuild` :
 *  1. Copie les fichiers Kotlin depuis modules/android-native/ dans android/
 *  2. Injecte permissions VPN + déclaration du service dans AndroidManifest.xml
 *  3. Enregistre SxbVpnPackage dans MainApplication.kt
 */
const { withAndroidManifest, withDangerousMod, withAppBuildGradle } = require('@expo/config-plugins');
const path = require('path');
const fs   = require('fs');

// ── 1. Copie des fichiers Kotlin ──────────────────────────────────────────────
function withKotlinSources(config) {
  return withDangerousMod(config, ['android', (cfg) => {
    const projectRoot   = cfg.modRequest.projectRoot;
    const platformRoot  = cfg.modRequest.platformProjectRoot; // android/

    // Destination : android/app/src/main/java/com/sxbvpn/vpnmodule/
    const destDir = path.join(platformRoot, 'app', 'src', 'main', 'java', 'com', 'sxbvpn', 'vpnmodule');
    fs.mkdirSync(destDir, { recursive: true });

    // Source : app-mobile/modules/android-native/*.kt
    const srcDir = path.join(projectRoot, 'modules', 'android-native');
    if (fs.existsSync(srcDir)) {
      fs.readdirSync(srcDir).forEach((file) => {
        if (file.endsWith('.kt')) {
          const src = path.join(srcDir, file);
          const dst = path.join(destDir, file);
          fs.copyFileSync(src, dst);
          console.log(`[VPN plugin] Copied ${file} → ${dst}`);
        }
      });
    } else {
      console.warn(`[VPN plugin] Source dir not found: ${srcDir}`);
    }

    return cfg;
  }]);
}

// ── 2. Permissions + service dans AndroidManifest ─────────────────────────────
function withVpnManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    const app      = manifest.manifest.application[0];

    // Permissions à ajouter
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

    // Déclaration du service VPN
    const serviceName = 'com.sxbvpn.vpnmodule.SxbVpnService';
    const services    = app.service || [];
    const already     = services.some((s) => s.$['android:name'] === serviceName);

    if (!already) {
      const entry = {
        $: {
          'android:name':                serviceName,
          'android:exported':            'false',
          'android:permission':          'android.permission.BIND_VPN_SERVICE',
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

    // Chemin de MainApplication.kt (package = com.sxbvpn.app)
    const mainAppPath = path.join(
      platformRoot, 'app', 'src', 'main', 'java',
      'com', 'sxbvpn', 'app', 'MainApplication.kt'
    );

    if (!fs.existsSync(mainAppPath)) {
      // Essai d'un chemin alternatif généré par Expo
      console.warn('[VPN plugin] MainApplication.kt not found at expected path:', mainAppPath);
      return cfg;
    }

    let src = fs.readFileSync(mainAppPath, 'utf-8');

    if (src.includes('SxbVpnPackage')) {
      // Déjà présent
      return cfg;
    }

    // Ajout de l'import (après la déclaration de package)
    src = src.replace(
      /^(package .+)$/m,
      '$1\n\nimport com.sxbvpn.vpnmodule.SxbVpnPackage'
    );

    // Ajout du package dans getPackages()
    // Expo SDK 54 génère: override fun getPackages(): List<ReactPackage> = PackageList(this).packages
    // ou la version multi-lignes. On gère les deux.
    if (src.includes('PackageList(this).packages')) {
      // Version 1 : expression directe
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


// ── 4. Injection de la dépendance JSch (SSH client Java) ─────────────────────
function withJschDependency(config) {
  return withAppBuildGradle(config, (cfg) => {
    const gradle = cfg.modResults.contents;
    const dep = "    implementation 'com.github.mwiede:jsch:0.2.21'";
    if (!gradle.includes('mwiede:jsch')) {
      cfg.modResults.contents = gradle.replace(
        /dependencies\s*\{/,
        'dependencies {
' + dep
      );
      console.log('[VPN plugin] JSch dependency added to app/build.gradle');
    }
    return cfg;
  });
}

// ── Export du plugin composite ────────────────────────────────────────────────
function withVpnPermissions(config) {
  config = withKotlinSources(config);
  config = withVpnManifest(config);
  config = withMainAppPackage(config);
  config = withJschDependency(config);
  return config;
}

module.exports = withVpnPermissions;

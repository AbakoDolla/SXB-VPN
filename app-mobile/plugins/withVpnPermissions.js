// Expo Config Plugin — injecte permissions VPN + déclaration du service Android
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const path = require('path');
const fs = require('fs');

/**
 * Ajoute BIND_VPN_SERVICE, FOREGROUND_SERVICE et FOREGROUND_SERVICE_SPECIAL_USE
 * dans AndroidManifest.xml, et copie les binaires sing-box/tun2socks dans assets/.
 */
function withVpnPermissions(config) {
  // 1. Permissions + service dans le manifest
  config = withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    const app = manifest.manifest.application[0];

    // Permissions
    const permsNeeded = [
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
      'android.permission.RECEIVE_BOOT_COMPLETED',
    ];
    const existingPerms = (manifest.manifest['uses-permission'] || []).map(
      (p) => p.$['android:name']
    );
    permsNeeded.forEach((perm) => {
      if (!existingPerms.includes(perm)) {
        manifest.manifest['uses-permission'] = manifest.manifest['uses-permission'] || [];
        manifest.manifest['uses-permission'].push({ $: { 'android:name': perm } });
      }
    });

    // Service declaration
    const services = app.service || [];
    const vpnServiceName = 'com.sxbvpn.vpnmodule.SxbVpnService';
    const alreadyDeclared = services.some((s) => s.$['android:name'] === vpnServiceName);
    if (!alreadyDeclared) {
      const serviceEntry = {
        $: {
          'android:name': vpnServiceName,
          'android:exported': 'false',
          'android:permission': 'android.permission.BIND_VPN_SERVICE',
          'android:foregroundServiceType': 'specialUse',
        },
        'intent-filter': [
          { action: [{ $: { 'android:name': 'android.net.VpnService' } }] },
        ],
        property: [
          {
            $: {
              'android:name': 'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE',
              'android:value': 'VPN tunnel',
            },
          },
        ],
      };
      app.service = [...services, serviceEntry];
    }

    return cfg;
  });

  return config;
}

module.exports = withVpnPermissions;

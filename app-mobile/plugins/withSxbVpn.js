const { withAndroidManifest, withInfoPlist, withEntitlementsPlist } = require("@expo/config-plugins");

function withSxbVpnAndroid(config) {
  return withAndroidManifest(config, (mod) => {
    const app = mod.modResults.manifest.application[0];

    // Add VPN permission
    if (!mod.modResults.manifest["uses-permission"]) {
      mod.modResults.manifest["uses-permission"] = [];
    }
    const perms = mod.modResults.manifest["uses-permission"];
    const vpnPerm = "android.permission.BIND_VPN_SERVICE";
    if (!perms.find((p) => p.0.["android:name"] === vpnPerm)) {
      perms.push({ $: { "android:name": vpnPerm } });
    }

    // The VpnService is declared in the module manifest — no need to add here
    // Just ensure the uses-feature is present
    if (!mod.modResults.manifest["uses-feature"]) {
      mod.modResults.manifest["uses-feature"] = [];
    }

    return mod;
  });
}

function withSxbVpniOS(config) {
  config = withInfoPlist(config, (mod) => {
    mod.modResults["NSLocalNetworkUsageDescription"] =
      "SXB VPN a besoin de l acces reseau local pour etablir le tunnel VPN.";
    return mod;
  });
  config = withEntitlementsPlist(config, (mod) => {
    // Network Extension entitlement (requires Apple Developer Program)
    mod.modResults["com.apple.developer.networking.networkextension"] = [
      "packet-tunnel-provider",
    ];
    return mod;
  });
  return config;
}

module.exports = function withSxbVpn(config) {
  config = withSxbVpnAndroid(config);
  config = withSxbVpniOS(config);
  return config;
};

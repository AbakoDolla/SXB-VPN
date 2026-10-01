import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { waitForBootstrapBackend } = require('../../app-mobile/scripts/verify-bootstrap-backend.cjs');
const read = file => readFileSync(new URL('../../' + file, import.meta.url), 'utf8');

test('incremental and clean manifest generation remove the extra pinning metadata', () => {
  const plugin = read('app-mobile/plugins/withSxbVpn.js');
  const start = plugin.indexOf('function withVpnManifest(');
  const end = plugin.indexOf('function withKotlinSources(', start);
  const context = { URL, process: { env: {} }, withAndroidManifest: (_config, action) => action,
    console, result: null };
  vm.runInNewContext(`${plugin.slice(start, end)}; result = withVpnManifest({});`, context);
  const app = { 'meta-data': [
    { $: { 'android:name': 'com.sxbvpn.BACKEND_SPKI_PINS', 'android:value': '["obsolete"]' } },
    { $: { 'android:name': 'com.sxbvpn.BACKEND_SPKI_REQUIRED', 'android:value': 'true' } },
  ] };
  context.result({ modResults: { manifest: { application: [app] } } });
  assert.equal(app['meta-data'].some(entry => /BACKEND_SPKI/.test(entry.$['android:name'])), false);
  assert.equal(app['meta-data'].find(entry => entry.$['android:name'] === 'com.sxbvpn.api_base_url').$['android:value'],
    'https://vpnsxb.afrihall.com/api');
  assert.doesNotMatch(plugin, /pinsForOrigin|EXPO_PUBLIC_BACKEND_SPKI_PINS/);
});

test('API and observer keep normal TLS while the central SSH socket factory is removed', () => {
  const tls = read('app-mobile/modules/android-native/SxbBackendTls.kt');
  assert.doesNotMatch(tls, /CertificatePinner|X509TrustManager|SxbTlsPinPolicy|SSLContext\.getInstance|HostnameVerifier/);
  assert.doesNotMatch(read('app-mobile/modules/android-native/SxbVpnPackage.kt'), /SxbBackendTls\.install/);
  assert.match(read('app-mobile/modules/android-native/SxbAccessObserver.kt'), /SxbBackendTls\.protect\(context, http\)/);
  assert.equal(existsSync(new URL('../../app-mobile/modules/android-native/SxbGatewaySocketFactory.kt', import.meta.url)), false);
  assert.doesNotMatch(read('app-mobile/modules/android-native/SxbVpnService.kt'), /SxbGatewaySocketFactory|SSH_GATEWAY_TLS/);
});

test('takeover cancels starts and closes TUN and pending SSH before the main UI queue', () => {
  const service = read('app-mobile/modules/android-native/SxbVpnService.kt');
  const revoke = service.match(/^    override fun onRevoke\(\)[\s\S]*?^    }/m)?.[0];
  assert.ok(revoke);
  const synchronous = revoke.slice(0, revoke.indexOf('Handler('));
  for (const required of ['SxbAccessControl.cancelStarts(this)', 'autoReconnect.markStopped("system_vpn_revoke")',
    'interruptForAccess()', 'sshTransportSocket?.close()', 'sshSession?.disconnect()', 'setCurrentState("disconnected")']) {
    assert.ok(synchronous.includes(required), required);
  }
  assert.ok(synchronous.indexOf('interruptForAccess()') < synchronous.indexOf('SxbAccessControl.cancelStarts(this)'));
  const interrupt = service.match(/^    fun interruptForAccess\(\)[\s\S]*?^    }/m)?.[0];
  assert.match(interrupt, /tunPfd\?\.close\(\)/);
  const access = read('app-mobile/modules/android-native/SxbAccessControl.kt');
  assert.match(access, /check\(VpnService\.prepare\(context\) == null\)/);
  assert.doesNotMatch(access, /SxbVpnPermission|vpnPermissionGeneration|sxb_vpn_permission_v1/);
  const module = read('app-mobile/modules/android-native/SxbVpnModule.kt');
  assert.doesNotMatch(module, /acknowledgeVpnPermission|VPN_PERMISSION_STORAGE_FAILED/);
  const start = module.slice(module.indexOf('private fun startGuardedVpn('), module.indexOf('// ── stopVpn'));
  assert.ok(start.indexOf('previous?.hasTunnelResources()') < start.indexOf('SxbAccessControl.prepareStart'));
  assert.match(start, /previous\?\.stopForAccess\(\)/);
  const js = read('app-mobile/contexts/VpnContext.tsx');
  assert.match(js, /hasPerm \|\| await SxbVpnNative\.requestVpnPermission\(\)/);
  assert.match(js, /if \(e\?\.errorCode === 'VPN_PERMISSION_REQUIRED'\)[\s\S]*?pendingAutoConnectRef\.current = null/);
});

test('the release still waits for compatible offline bootstrap, not a compiled certificate key', async () => {
  const compatible = { status: 'ok', service: 'sxb-vpn-backend',
    capabilities: { mobileTunnelBootstrap: 1, mobileDirectSsh: 1 } };
  await waitForBootstrapBackend(async () => compatible, { attempts: 1 });
  await assert.rejects(waitForBootstrapBackend(async () => ({ ...compatible, capabilities: {} }),
    { attempts: 1, report: () => {} }), /BOOTSTRAP_BACKEND_NOT_DEPLOYED/);
  const source = read('app-mobile/scripts/verify-bootstrap-backend.cjs');
  assert.doesNotMatch(source, /readPinPolicy|verifyPublicPin|verifyServedPin/);
  assert.match(source, /fetch\(HEALTH_URL/);
});

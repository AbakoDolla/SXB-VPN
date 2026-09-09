import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(root, 'backend', 'package.json'));
const { build } = require('esbuild');
const compiled = await build({
  entryPoints: [path.join(root, 'server', 'services', 'canonical-config.ts')],
  bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const module = { exports: {} };
new Function('module', 'exports', 'require', compiled.outputFiles[0].text)(module, module.exports, require);
const { parseImportedConfig, decryptCanonical } = module.exports;
// Register tests immediately after this import: its server cleanup is a node:test after hook.
const { api, ok, row } = await import('./reseller-http.test.mjs');
const lockPassword = 'fixture-profile-lock-password';
const uuid = '00000000-0000-4000-8000-000000000001';
const xray = {
  dns: { servers: ['1.1.1.1', '8.8.8.8'] },
  inbounds: [{ protocol: 'socks', listen: '127.0.0.1', port: 10808 }],
  outbounds: [
    {
      tag: 'proxy', protocol: 'vless',
      settings: { vnext: [{ address: 'vpn.example.test', port: 443, users: [{ id: uuid, encryption: 'none' }] }] },
      streamSettings: { network: 'tcp', security: 'tls', tlsSettings: { serverName: 'vpn.example.test' } },
      proxySettings: { tag: 'upstream', transportLayer: true },
    },
    { tag: 'upstream', protocol: 'http', settings: { servers: [{ address: 'proxy.example.test', port: 8080 }] } },
    { tag: 'direct', protocol: 'freedom' },
  ],
  routing: { rules: [{ type: 'field', port: '0-65535', outboundTag: 'proxy' }] },
};
const singbox = {
  dns: { servers: [{ tag: 'resolver', address: '1.1.1.1', detour: 'proxy' }], final: 'resolver' },
  outbounds: [{ type: 'vless', tag: 'proxy', server: 'vpn.example.test', server_port: 443, uuid,
    tls: { enabled: true, server_name: 'vpn.example.test' } }],
  route: { final: 'proxy' },
};

function assertStoredDns(id, raw) {
  const stored = row('VpnProfile', id);
  assert.ok(stored);
  assert.equal(stored.dns, null, 'The legacy String column cannot store the structured DNS object');
  assert.equal(stored.jsonConfig, null);
  assert.ok(stored.canonicalConfig.startsWith('gcm:'));
  assert.ok(stored.lockPasswordHash);
  const expected = parseImportedConfig(raw);
  assert.equal(expected.ok, true, JSON.stringify(expected.errors));
  const decrypted = JSON.parse(decryptCanonical(stored.canonicalConfig));
  assert.deepEqual(decrypted.dns, expected.canonical.dns, 'Full DNS rules must survive encrypted storage unchanged');
  assert.deepEqual(decrypted.outbounds, expected.canonical.outbounds);
}

for (const [format, configuration] of [['Xray', xray], ['sing-box', singbox]]) {
  test(`${format} import stores structured DNS in the encrypted canonical rather than the legacy String column`, async () => {
    const raw = JSON.stringify(configuration);
    const parsed = parseImportedConfig(raw);
    assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
    assert.equal(typeof parsed.canonical.dns, 'object');
    const response = await api('admin', 'POST', '/vpn-profiles', {
      name: `${format} fixture`, importConfig: raw, lockPassword,
    });
    ok(response, 201);
    assertStoredDns(response.body.profile.id, raw);
    assert.equal(response.body.profile.isLocked, true);
    assert.equal(response.body.profile.canonicalConfig, undefined);
  });
}

test('the batch endpoint uses the same structured DNS storage contract', async () => {
  const raw = JSON.stringify(xray);
  const response = await api('admin', 'POST', '/vpn-profiles/import-batch', {
    namePrefix: 'DNS fixture', importConfig: raw, lockPassword,
  });
  ok(response, 201);
  assert.equal(response.body.imported, 1);
  assertStoredDns(response.body.profiles[0].id, raw);
});

test('explicit reimport keeps DNS intact without changing the profile lock', async () => {
  const created = await api('admin', 'POST', '/vpn-profiles', {
    name: 'Reimport fixture', importConfig: `vless://${uuid}@vpn.example.test:443?security=tls`, lockPassword,
  });
  ok(created, 201);
  const id = created.body.profile.id;
  const hash = row('VpnProfile', id).lockPasswordHash;
  const unlocked = await api('admin', 'POST', `/vpn-profiles/${id}/unlock`, { password: lockPassword });
  ok(unlocked);
  const raw = JSON.stringify(xray);
  const updated = await api('admin', 'PUT', `/vpn-profiles/${id}`, { importConfig: raw },
    { 'X-VPN-Profile-Unlock': unlocked.body.unlockToken });
  ok(updated);
  assertStoredDns(id, raw);
  assert.equal(row('VpnProfile', id).lockPasswordHash, hash);
  assert.equal(row('VpnProfile', id).configVersion, 2);
});

test('legacy scalar DNS is still stored as a String', async () => {
  const response = await api('admin', 'POST', '/vpn-profiles', {
    name: 'Scalar DNS fixture', lockPassword,
    importConfig: JSON.stringify({ protocol: 'ssh', host: 'ssh.example.test', port: 22,
      username: 'fixture', password: 'fixture-transport-password', dns: '1.1.1.1' }),
  });
  ok(response, 201);
  assert.equal(row('VpnProfile', response.body.profile.id).dns, '1.1.1.1');
});

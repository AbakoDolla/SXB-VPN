import './register-hooks.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { vlessParityFixtures, parityRealityKey } from './fixtures/vless-parity.mjs';
const { parseImportedConfig, engineConfigFromCanonical, encryptCanonical, decryptCanonical, canonicalJson } =
  await import('../../server/services/canonical-config.ts');
const { validateVpnConfig, sanitizeEngineConfig, mergeConnectionMetadata } =
  await import('../../app-mobile/services/configValidator.ts');
const { parseVlessUri } = await import('../../app-mobile/services/vlessUri.ts');

process.env.ENCRYPTION_KEY = 'synthetic-vless-parity-encryption-key';

for (const { name, uri, xray, options } of vlessParityFixtures) {
  test(`URI/JSON effective transport: ${name}`, () => {
    const link = parseImportedConfig(uri);
    assert.equal(link.ok, true, link.errors.join(' | '));
    const local = parseVlessUri(uri).config;
    for (const field of ['host', 'port', 'uuid', 'sni', 'wsHost', 'path', 'fingerprint', 'publicKey', 'shortId', 'grpcServiceName', 'flow']) {
      assert.equal(link.canonical[field], local[field], `URI must be decoded once: ${field}`);
    }
    const json = parseImportedConfig(JSON.stringify(xray));
    assert.equal(json.ok, true, json.errors.join(' | '));
    const restored = JSON.parse(decryptCanonical(encryptCanonical(canonicalJson(json.canonical))));
    const supplied = sanitizeEngineConfig(mergeConnectionMetadata(engineConfigFromCanonical(restored), {
      host: 'metadata-must-not-override.test', sni: 'metadata-must-not-override.test',
      displayProtocol: 'Synthetic VLESS', configId: 'synthetic-parity',
    }));
    const checked = validateVpnConfig(supplied);
    assert.equal(checked.valid, true, checked.errors.join(' | '));
    const outbound = checked.config.outbounds.find(item => item.type === 'vless');
    assert.equal(outbound.server, local.host);
    assert.equal(outbound.server_port, local.port);
    assert.equal(outbound.uuid, local.uuid);
    assert.equal(outbound.flow ?? '', local.flow ?? '');
    if (local.tls) {
      assert.equal(outbound.tls.enabled, true);
      assert.equal(outbound.tls.server_name, local.sni);
      if (local.fingerprint === 'none') assert.equal(outbound.tls.utls?.enabled ?? false, false);
      else assert.equal(outbound.tls.utls?.fingerprint, local.fingerprint);
      assert.deepEqual(outbound.tls.alpn ?? [], local.alpn ? local.alpn.split(',') : []);
      assert.equal(outbound.tls.insecure ?? false, local.insecure ?? false);
    } else assert.equal(outbound.tls?.enabled ?? false, false);
    if (options.security === 'reality') {
      assert.equal(outbound.tls.reality.enabled, true);
      assert.equal(outbound.tls.reality.public_key, local.publicKey);
      assert.equal(outbound.tls.reality.short_id ?? '', local.shortId ?? '');
    }
    if (options.network === 'grpc') assert.equal(outbound.transport.service_name, local.grpcServiceName ?? 'GunService');
    if (options.network === 'ws' || options.network === undefined) {
      assert.equal(outbound.transport.path, local.path);
      assert.equal(outbound.transport.headers.Host, local.wsHost);
    }
    if (options.network === 'httpupgrade') {
      assert.equal(outbound.transport.path, local.path);
      assert.equal(outbound.transport.host, local.wsHost);
    }
  });

}

test('unsupported JSON flow cannot be dropped or falsely imported as Vision', () => {
  const source = structuredClone(vlessParityFixtures.find(item => item.options.flow).xray);
  source.outbounds[0].settings.vnext[0].users[0].flow = 'xtls-rprx-obsolete';
  const parsed = parseImportedConfig(JSON.stringify(source));
  assert.equal(parsed.ok, false);
  assert.ok(parsed.errors.some(error => error.includes('flow')));
  assert.equal(parsed.canonical, undefined);
});

test('VLESS share JSON retains Reality aliases and gRPC identity like the URI', () => {
  const input = {
    protocol: 'vless', add: 'tcp.example.test', port: '443', id: 'a61cdad6-48c0-4a33-a72a-682c64ec0d79',
    net: 'grpc', tls: 'reality', sni: 'tls.example.test', fp: 'firefox', pbk: parityRealityKey,
    sid: '0a0b', spx: '/probe', serviceName: 'Service', flow: 'xtls-rprx-vision', alpn: ['h2'],
  };
  const server = parseImportedConfig(JSON.stringify(input));
  const mobile = validateVpnConfig(input);
  assert.equal(server.ok, true, server.errors.join(' | '));
  assert.equal(mobile.valid, true, mobile.errors.join(' | '));
  for (const field of ['host', 'port', 'uuid', 'network', 'tls', 'sni', 'fingerprint', 'publicKey', 'shortId', 'spiderX', 'grpcServiceName', 'flow', 'alpn']) {
    assert.deepEqual(server.canonical[field], mobile.config[field], field);
  }
  assert.equal(server.canonical.tls, true);
  assert.equal(server.canonical.publicKey, parityRealityKey);
  assert.equal(server.canonical.shortId, '0a0b');
  assert.equal(server.canonical.grpcServiceName, 'Service');
  assert.equal(server.canonical.spiderX, '/probe');
});

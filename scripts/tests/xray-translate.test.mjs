import './register-hooks.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { xrayHttpChainFixture } from './fixtures/xray-http-chain.mjs';
import { nativeCompatibilityHarnessSource, syntheticCanonicalForRuntime, SING_BOX_VERSION } from './xray-runtime-fixture.mjs';
const { translateXrayToSingbox } = await import('../../server/services/xray-translate.ts');
const {
  parseImportedConfig, canonicalJson, encryptCanonical, decryptCanonical,
  engineConfigFromCanonical, computeCanonicalHash,
} = await import('../../server/services/canonical-config.ts');

process.env.ENCRYPTION_KEY = 'synthetic-xray-test-encryption-key';

function translate(input) {
  const result = translateXrayToSingbox(input);
  assert.equal(result.ok, true, result.errors.join(' | '));
  return result;
}

test('the two VLESS chains preserve all eleven HTTP definitions without inventing failover', () => {
  const input = xrayHttpChainFixture();
  const { singboxJson: config, warnings } = translate(input);
  assert.equal(config.outbounds.length, input.outbounds.length);
  assert.equal(new Set(config.outbounds.map(outbound => outbound.tag)).size, input.outbounds.length);
  assert.deepEqual(config.outbounds.map(outbound => outbound.tag), input.outbounds.map(outbound => outbound.tag));
  for (const source of input.outbounds) {
    const outbound = config.outbounds.find(item => item.tag === source.tag);
    if (source.protocol === 'vless') {
      const server = source.settings.vnext[0];
      assert.equal(outbound.server, server.address);
      assert.equal(outbound.server_port, server.port);
      assert.equal(outbound.uuid, server.users[0].id);
      assert.equal(outbound.detour, source.proxySettings.tag);
      assert.deepEqual(outbound.transport, { type: 'ws', ...source.streamSettings.wsSettings });
      assert.deepEqual(outbound.tls, {
        enabled: true, server_name: 'tls.example.test', insecure: true,
        utls: { enabled: true, fingerprint: 'chrome' },
      });
    } else if (source.protocol === 'http') {
      assert.equal(outbound.server, source.settings.servers[0].address);
      assert.equal(outbound.server_port, source.settings.servers[0].port);
      assert.deepEqual(outbound.headers, source.settings.headers);
    }
    assert.equal(outbound.domain_strategy, undefined, 'AsIs is absence of a sing-box domain strategy');
  }
  assert.deepEqual(config.outbounds.filter(outbound => outbound.detour).map(outbound => outbound.detour),
    ['moodyibr1', 'moodyibr2']);
  assert.equal(config.outbounds.some(outbound => ['selector', 'urltest'].includes(outbound.type)), false);
  assert.equal(warnings.some(warning => /outbound inconnu/.test(warning)), false);
});

test('Xray private matchers, UDP blocking, full port range and structured DNS use the 1.11 dialect', () => {
  const { singboxJson: config, warnings } = translate(xrayHttpChainFixture());
  assert.deepEqual(config.route, {
    rules: [
      { outbound: 'block', port: [443], network: 'udp' },
      { outbound: 'direct', ip_is_private: true },
      { outbound: 'direct', geosite: ['private'] },
      { outbound: 'proxy1', port_range: ['0:65535'] },
    ],
    final: 'proxy1',
  });
  assert.deepEqual(config.dns, {
    servers: [{ tag: 'dns-remote', address: '192.0.2.53', detour: 'proxy1' }],
    final: 'dns-remote',
  });
  assert.equal(config.inbounds, undefined);
  assert.ok(warnings.some(warning => /geosite.*base/i.test(warning)));
  assert.ok(warnings.some(warning => /inboundTag/.test(warning)));
});

test('canonical encryption and engine delivery retain the complete translated graph', () => {
  const source = xrayHttpChainFixture();
  const parsed = parseImportedConfig(JSON.stringify(source));
  assert.equal(parsed.ok, true, parsed.errors.join(' | '));
  assert.equal(parsed.sourceFormat, 'xray-json');
  assert.equal(parsed.warnings.some(warning => /TUN peut échouer/.test(warning)), false);
  const encrypted = encryptCanonical(canonicalJson(parsed.canonical));
  assert.equal(encrypted.includes('synthetic-header-canary'), false);
  const restored = JSON.parse(decryptCanonical(encrypted));
  assert.equal(computeCanonicalHash(restored), computeCanonicalHash(parsed.canonical));
  assert.deepEqual(engineConfigFromCanonical(restored), parsed.canonical);
  assert.deepEqual(engineConfigFromCanonical(source), parsed.canonical);
});

test('all primary transport tags are valid routing targets, including a non-first final', () => {
  const input = xrayHttpChainFixture();
  input.routing.rules = [
    { domain: ['full:select.example.test'], outboundTag: 'proxy2' },
    { outboundTag: 'proxy2' },
  ];
  const { singboxJson: config, warnings } = translate(input);
  assert.deepEqual(config.route, {
    rules: [{ domain: ['select.example.test'], outbound: 'proxy2' }], final: 'proxy2',
  });
  assert.equal(warnings.some(warning => /inconnu/.test(warning)), false);
});

test('the same routing tag registry covers VMess and Trojan as well as VLESS', () => {
  const input = xrayHttpChainFixture();
  input.outbounds[1].protocol = 'vmess';
  input.outbounds.push({
    protocol: 'trojan', tag: 'trojan-fixture',
    settings: { servers: [{ address: 'trojan.example.test', port: 443, password: 'synthetic-trojan-canary' }] },
    streamSettings: { network: 'tcp', security: 'tls', tlsSettings: { serverName: 'trojan.example.test' } },
  });
  input.routing.rules = [
    { port: 443, outboundTag: 'proxy2' },
    { outboundTag: 'trojan-fixture' },
  ];
  assert.deepEqual(translate(input).singboxJson.route, {
    rules: [{ port: [443], outbound: 'proxy2' }], final: 'trojan-fixture',
  });
});

test('domain prefixes, regex, port lists and ranges keep their matching semantics', () => {
  const input = xrayHttpChainFixture();
  input.routing.rules = [{
    domain: ['full:exact.example.test', 'domain:suffix.example.test', 'keyword:canary', 'bare-keyword', 'regexp:^test[0-9]+\\.example\\.test$'],
    port: '443,8000-8100', sourcePort: [1024, '2000-3000'], network: 'tcp,udp', outboundTag: 'proxy2',
  }];
  assert.deepEqual(translate(input).singboxJson.route.rules, [{
    outbound: 'proxy2', domain: ['exact.example.test'], domain_suffix: ['suffix.example.test'],
    domain_keyword: ['canary', 'bare-keyword'], domain_regex: ['^test[0-9]+\\.example\\.test$'],
    port: [443], port_range: ['8000:8100'], source_port: [1024], source_port_range: ['2000:3000'],
    network: ['tcp', 'udp'],
  }]);
});

test('an early unconditional route retains its effect rather than disappearing', () => {
  const input = xrayHttpChainFixture();
  input.routing.rules = [
    { outboundTag: 'proxy2' },
    { domain: ['full:unreachable.example.test'], outboundTag: 'proxy1' },
  ];
  assert.deepEqual(translate(input).singboxJson.route, { rules: [], final: 'proxy2' });
});

test('duplicate and implicitly colliding outbound tags are rejected before materializing detours', () => {
  for (const duplicate of ['vless', 'http', 'freedom']) {
    const input = xrayHttpChainFixture();
    const original = input.outbounds.find(outbound => outbound.protocol === duplicate);
    input.outbounds.push(structuredClone(original));
    const result = translateXrayToSingbox(input);
    assert.equal(result.ok, false, duplicate);
    assert.ok(result.errors.some(error => /tag.*dupliqu/i.test(error)));
  }
  const input = xrayHttpChainFixture();
  delete input.outbounds[0].tag;
  delete input.outbounds[1].tag;
  assert.equal(translateXrayToSingbox(input).ok, false);
});

test('unknown routes, final targets and unsupported matchers fail explicitly instead of broadening traffic', () => {
  for (const rule of [
    { port: '443', outboundTag: 'missing' },
    { outboundTag: 'missing' },
    { inboundTag: ['dns-module'], outboundTag: 'missing' },
    { user: ['not-translatable'], outboundTag: 'proxy1' },
    { domain: ['ext:external.dat:private'], outboundTag: 'proxy1' },
    { domain: ['constructor:example.test'], outboundTag: 'proxy1' },
    { ip: ['geoip:not-a-country!'], outboundTag: 'proxy1' },
    { port: '8000-100', outboundTag: 'proxy1' },
    { port: '65536', outboundTag: 'proxy1' },
    { network: 'unsupported', outboundTag: 'proxy1' },
  ]) {
    const input = xrayHttpChainFixture();
    input.routing.rules = [rule];
    const result = translateXrayToSingbox(input);
    assert.equal(result.ok, false, JSON.stringify(rule));
    assert.ok(result.errors.length > 0);
    assert.equal(result.singboxJson, undefined);
  }
});

test('HTTP detours use one translation regardless of source order and keep authentication and TLS', () => {
  const input = xrayHttpChainFixture();
  const upstream = input.outbounds.find(outbound => outbound.tag === 'moodyibr1');
  upstream.settings.servers[0].users = [{ user: 'fixture-user', pass: 'fixture-password-canary' }];
  upstream.streamSettings = {
    network: 'tcp', security: 'tls', tlsSettings: { serverName: 'proxy-tls.example.test', allowInsecure: false },
  };
  const first = translate(input).singboxJson.outbounds.find(outbound => outbound.tag === upstream.tag);
  input.outbounds = [upstream, ...input.outbounds.filter(outbound => outbound !== upstream)];
  const second = translate(input).singboxJson.outbounds.find(outbound => outbound.tag === upstream.tag);
  assert.deepEqual(first, second);
  assert.equal(first.username, 'fixture-user');
  assert.equal(first.password, 'fixture-password-canary');
  assert.equal(first.tls.insecure, false);
});

test('missing, non-HTTP, cyclic and malformed upstreams cannot become invented endpoints', () => {
  const mutations = [
    input => { input.outbounds[0].proxySettings.tag = 'missing'; },
    input => { input.outbounds[0].proxySettings.tag = 'proxy2'; },
    input => { delete input.outbounds[4].settings.servers[0].address; },
    input => { input.outbounds[4].settings.servers[0].port = 65536; },
    input => { input.outbounds[4].proxySettings = { tag: 'moodyibr1', transportLayer: true }; },
    input => { input.outbounds[4].settings.servers.push({ address: 'second.example.test', port: 8080 }); },
    input => { input.outbounds[4].domainStrategy = 'toString'; },
  ];
  for (const mutate of mutations) {
    const input = xrayHttpChainFixture();
    mutate(input);
    const result = translateXrayToSingbox(input);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  }
});

test('DNS query strategy is not silently changed and malformed structured DNS is rejected', () => {
  for (const [strategy, expected] of [['UseIPv4', 'ipv4_only'], ['UseIPv6', 'ipv6_only'], ['UseIP', undefined]]) {
    const input = xrayHttpChainFixture();
    input.dns.queryStrategy = strategy;
    assert.equal(translate(input).singboxJson.dns.strategy, expected);
  }
  for (const dns of [
    '192.0.2.53', { servers: [null] }, { servers: ['192.0.2.53'], queryStrategy: 'unknown' },
    { servers: [{ address: '192.0.2.53', domains: ['full:conditional.example.test'] }] },
  ]) {
    const input = xrayHttpChainFixture();
    input.dns = dns;
    assert.equal(translateXrayToSingbox(input).ok, false);
  }
});

test('TLS is never disabled to accept an unknown security mode', () => {
  const input = xrayHttpChainFixture();
  input.outbounds[0].streamSettings.security = 'unsupported-security';
  assert.equal(translateXrayToSingbox(input).ok, false);
  input.outbounds[0].streamSettings.security = 'tls';
  delete input.outbounds[0].streamSettings.tlsSettings.allowInsecure;
  assert.equal(translate(input).singboxJson.outbounds[0].tls.insecure, false);
  input.outbounds[0].streamSettings.tlsSettings.allowInsecure = 'true';
  assert.equal(translateXrayToSingbox(input).ok, false);
});

test('the CI fixture exercises the actual Kotlin raw-config builder with only physical network stubs', () => {
  const harness = nativeCompatibilityHarnessSource();
  assert.equal(SING_BOX_VERSION, '1.11.15');
  assert.match(harness, /normalizeRawSingBoxCompatibility\(convertXrayToSingBoxIfNeeded\(rawCfg\)\)/);
  assert.match(harness, /put\("inbounds", JSONArray\(\)\.put\(tunInbound\(\)\)\)/);
  assert.match(harness, /val dnsObj = applyDnsLoopGuard\(/);
  assert.match(harness, /put\("outbounds", outbounds\)/);
  assert.match(harness, /routeRules\.put\(r\)/);
  const canonical = syntheticCanonicalForRuntime();
  assert.equal(canonical.outbounds.length, 15);
  assert.equal(canonical.outbounds.filter(outbound => outbound.type === 'http').length, 11);
});

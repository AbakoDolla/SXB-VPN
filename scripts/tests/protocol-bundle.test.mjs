import './register-hooks.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isIP } from 'node:net';
import { bundleXray, bundleUuid, protocolKey } from './fixtures/protocol-bundle.mjs';
process.env.ENCRYPTION_KEY = 'synthetic-protocol-bundle-test-key';
const { readProtocolBundle, ipPrefix, ipVersion, parseEndpoint, canonicalWireguardEndpoint } = await import('../../server/services/protocol-bundle.ts');
const { parseImportedConfig, canonicalJson, encryptCanonical, decryptCanonical, engineConfigFromCanonical } = await import('../../server/services/canonical-config.ts');
const { validateVpnConfig, isCompleteOfflineConfig } = await import('../../app-mobile/services/configValidator.ts');
const { ProtocolDetector } = await import('../../app-mobile/services/protocolDetector.ts');

const ssh = {
  sshServer: 'ssh.example.test', sshPort: '22', sslPort: '443',
  sshUser: 'test', sshPass: 'synthetic-password',
  wsPayload: 'tls.example.test', proxyPayload: 'CONNECT [host_port] [protocol][crlf][crlf]',
  proxyRemoto: 'proxy.example.test', proxyRemotoPorta: '8080',
  dnsKey: '127.0.0.1:5353', serverNameKey: 't.example.test', chaveKey: 'a'.repeat(64),
};

for (const tunnelType of [1, 2, 3, 4, 5]) {
  test(`legacy Settings mode ${tunnelType} shares mobile/server interpretation`, () => {
    const source = { ...ssh, tunnelType };
    const parsed = parseImportedConfig(JSON.stringify(source));
    const mobile = validateVpnConfig(source);
    assert.ok(parsed.ok, parsed.errors.join('; '));
    assert.ok(mobile.valid, mobile.errors.join('; '));
    assert.deepEqual(parsed.canonical, mobile.config);
    assert.equal(ProtocolDetector.detect(source).protocol, parsed.canonical.protocol);
    assert.equal(parsed.canonical.tls, tunnelType === 3 || tunnelType === 4);
    assert.equal(parsed.canonical.port, tunnelType === 3 || tunnelType === 4 ? 443 : 22);
  });
}

test('Hysteria1 is explicit while the historical hysteria alias stays Hysteria2', () => {
  const source = { tunnelType: '6', udpserver: 'hy.example.test', udpport: '443', udpauth: 'synthetic', udpup: '100', udpdown: '80', udpobfs: 'none' };
  const parsed = parseImportedConfig(JSON.stringify(source));
  assert.ok(parsed.ok, parsed.errors.join('; '));
  assert.equal(parsed.canonical.protocol, 'hysteria1');
  assert.equal(parsed.canonical.upMbps, 100);
  assert.equal(ProtocolDetector.detect({ protocol: 'hysteria', host: 'old.example.test', password: 'old' }).protocol, 'hysteria2');
});

test('legacy defaults cannot disable TLS or import filesystem/authorization settings', () => {
  const result = readProtocolBundle({ server: '127.0.0.1:443', auth_str: 'synthetic', up_mbps: 100, down_mbps: 100, insecure: true, ca: 'C:\\private.pem', time_left_ms: 999999, bypassKey: true });
  assert.equal(result.config.insecure, false);
  for (const key of ['ca', 'time_left_ms', 'bypassKey']) assert.ok(!(key in result.config));
  assert.equal(result.warnings.length, 4);
});

test('keyPath-only, ambiguous, malformed and encrypted settings fail explicitly', () => {
  for (const source of [
    { ...ssh, tunnelType: 0 }, { ...ssh, tunnelType: 1, sshPass: '', keyPath: 'C:\\secret' },
    { ...ssh, tunnelType: 1, protocol: 'trojan' }, { ...ssh, tunnelType: 2, proxyRemotoPorta: '1.5' },
    { tunnelType: 7, v2rayjson: 'encrypted:unknown' },
  ]) {
    assert.throws(() => readProtocolBundle(source));
    assert.equal(parseImportedConfig(JSON.stringify(source)).ok, false);
    assert.equal(validateVpnConfig(source).valid, false);
  }
});

for (const protocol of ['vmess', 'vless', 'trojan', 'shadowsocks', 'socks', 'wireguard']) {
  test(`${protocol} cookbook: full replacement, shared translation, encrypted engine fidelity`, () => {
    const original = bundleXray(protocol);
    const wrapped = { tunnelType: 7, v2rayjson: JSON.stringify(original) };
    const server = parseImportedConfig(JSON.stringify(wrapped));
    const mobile = validateVpnConfig(wrapped);
    assert.ok(server.ok, server.errors.join('; '));
    assert.ok(mobile.valid, mobile.errors.join('; '));
    assert.deepEqual(mobile.config, server.canonical);
    assert.deepEqual(ProtocolDetector.detect(wrapped).config, server.canonical);
    const encrypted = encryptCanonical(canonicalJson(server.canonical));
    assert.ok(!encrypted.includes('synthetic'));
    assert.deepEqual(engineConfigFromCanonical(JSON.parse(decryptCanonical(encrypted))), engineConfigFromCanonical(server.canonical));
    const nodes = [...server.canonical.outbounds, ...(server.canonical.endpoints ?? [])];
    const proxy = nodes.find(node => node.tag === 'proxy');
    assert.equal(proxy.type, protocol);
    assert.ok(!('vnext' in proxy) && !('settings' in proxy));
    if (protocol === 'wireguard') {
      assert.equal(proxy.system, false);
      assert.equal(proxy.peers[0].persistent_keepalive_interval, 25);
      assert.equal(proxy.peers[0].pre_shared_key, protocolKey(3));
      assert.deepEqual(proxy.peers[0].reserved, [0, 127, 255]);
    }
    assert.deepEqual(server.canonical.dns.servers.find(server => server.type === 'hosts').predefined,
      { 'only.example.test': ['192.0.2.1', '2001:db8::1'] });
  });
}

test('WireGuard flat aliases, IPv6 endpoint, reserved and keepalive are not dropped', () => {
  const source = { protocol: 'wireguard', privateKey: protocolKey(1), publicKey: protocolKey(2),
    endpoint: '[::1]:23456', address: '10.99.0.2/32,fd99::2/128', allowedIps: '0.0.0.0/0,::/0',
    persistentKeepalive: 25, presharedKey: protocolKey(3), reserved: [1, 2, 3] };
  assert.ok(validateVpnConfig(source).valid);
  const endpoint = canonicalWireguardEndpoint(source);
  assert.deepEqual(endpoint.address, ['10.99.0.2/32', 'fd99::2/128']);
  const full = { endpoints: [endpoint], outbounds: [], route: { final: 'proxy' } };
  assert.ok(parseImportedConfig(JSON.stringify(full)).ok);
  assert.ok(validateVpnConfig(full).valid);
  assert.equal(ProtocolDetector.detect(full).protocol, 'singbox');
  assert.ok(isCompleteOfflineConfig({ ...full, protocol: 'singbox' }).complete);
  for (const invalid of [
    { ...source, privateKey: 'not-a-key' }, { ...source, persistentKeepalive: 0.5 },
    { ...source, reserved: [1, 2, 256] }, { ...source, address: ':::1/64' },
  ]) assert.equal(validateVpnConfig(invalid).valid, false);
});

test('IPv6 separator, embedded IPv4 and CIDR validation is consistent without DNS', () => {
  for (const address of ['::', '::1', '2001:db8::1', '::ffff:192.0.2.1', '1:2:3:4:5:6:7:8',
    ':::1', ':1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8:', '1::2::3', '2001:db8::g', '::ffff:999.0.0.1',
    '192.0.2.1', '001.2.3.4']) {
    assert.equal(ipVersion(address), isIP(address), address);
    if (isIP(address)) {
      assert.doesNotThrow(() => ipPrefix(address, 'address'));
      if (address.includes(':')) assert.deepEqual(parseEndpoint(`[${address}]:443`), { host: address, port: 443 });
    } else {
      assert.throws(() => ipPrefix(address, 'address'), address);
      if (address.includes(':')) assert.throws(() => parseEndpoint(`[${address}]:443`), address);
    }
  }
  for (const invalid of ['::1/129', '192.0.2.1/33', '::1/-1']) assert.throws(() => ipPrefix(invalid, 'address'));
});

test('standard VMess, Trojan, SIP002 Shadowsocks and Hysteria2 URIs import on mobile', () => {
  const vmess = `vmess://${Buffer.from(JSON.stringify({ add: '127.0.0.1', port: '443', id: bundleUuid,
    aid: '0', net: 'ws', path: '/synthetic', host: 'ws.example.test', tls: 'tls', sni: 'tls.example.test' })).toString('base64')}`;
  for (const uri of [vmess, 'trojan://synthetic-password@[::1]:443?sni=tls.example.test&type=ws&host=ws.example.test&path=%2Fsynthetic',
    `ss://${Buffer.from('aes-256-gcm:synthetic-password').toString('base64url')}@[::1]:23456`,
    'hy2://synthetic-password@127.0.0.1:443?sni=tls.example.test&obfs=salamander&obfs-password=synthetic-secret']) {
    const mobile = validateVpnConfig(uri);
    const server = parseImportedConfig(uri);
    assert.ok(mobile.valid, mobile.errors.join('; '));
    assert.ok(server.ok, server.errors.join('; '));
    for (const field of ['host', 'port', 'uuid', 'password', 'sni', 'path', 'obfs', 'obfsPassword']) {
      assert.equal(mobile.config[field], server.canonical[field], `${uri.split(':')[0]} ${field}`);
    }
  }
});

test('unsupported catalog, DNS aliases, invalid SS2022 and Hysteria options fail explicitly', () => {
  const dnsAlias = bundleXray('vless');
  dnsAlias.dns.hosts = { 'domain:example.test': 'alias.example.test' };
  for (const source of [
    [{ hosts: ['127.0.0.1'], protocols: ['DIRECT', 'SSL'] }],
    { tunnelType: 7, v2rayjson: dnsAlias },
    { protocol: 'shadowsocks', host: '127.0.0.1', port: 443, method: '2022-blake3-aes-256-gcm', password: 'invalid-key' },
    { protocol: 'hysteria2', host: '127.0.0.1', port: 443, password: 'synthetic', obfs: 'not-salamander' },
    { protocol: 'hysteria1', host: '127.0.0.1', port: 443, password: 'synthetic', upMbps: 0, downMbps: 1 },
  ]) {
    assert.equal(parseImportedConfig(JSON.stringify(source)).ok, false);
    assert.equal(validateVpnConfig(source).valid, false);
  }
  assert.throws(() => readProtocolBundle([{ hosts: ['127.0.0.1'], protocols: ['DIRECT'] }]), /catalogue incomplet/);
  const legacy = parseImportedConfig(JSON.stringify(dnsAlias));
  assert.ok(legacy.ok, legacy.errors.join('; '));
  assert.ok(legacy.warnings.some(message => message.includes('dns.hosts non traduit')));
});

test('mode agreement, nonempty SNI aliases and pinned cipher validation', () => {
  const source = { ...ssh, tunnelType: 3, wsPayload: '', sni: 'front.example.test' };
  assert.equal(readProtocolBundle(source).config.sni, 'front.example.test');
  for (const protocol of ['singbox', 'hysteria1', 'trojan']) {
    assert.throws(() => readProtocolBundle({ ...ssh, tunnelType: 1, protocol }), /ambigus/);
  }
  const ss = bundleXray('shadowsocks');
  ss.outbounds[0].settings.servers[0].method = 'invented-method';
  const vmess = bundleXray('vmess');
  vmess.outbounds[0].settings.vnext[0].users[0].security = 'invented-security';
  for (const config of [ss, vmess]) {
    assert.equal(parseImportedConfig(JSON.stringify(config)).ok, false);
    assert.equal(validateVpnConfig(config).valid, false);
  }
  for (const servers of [[], undefined]) {
    const raw = bundleXray('vless');
    raw.dns.servers = servers;
    const result = parseImportedConfig(JSON.stringify({ tunnelType: 7, v2rayjson: raw }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(message => message.includes('dns.servers')));
  }
});

test('new share URIs retain every transport/security field equally on mobile and server', () => {
  const vmess = shared => `vmess://${Buffer.from(JSON.stringify(shared)).toString('base64')}`;
  const cases = [
    [vmess({ add: 'vpn.example.test', port: '443', id: bundleUuid, aid: 0, net: 'ws', tls: 'tls',
      requestPath: '/test', requestHost: 'front.example.test', security: 'aes-128-gcm',
      headerType: 'http', fingerprint: 'chrome', alpn: ['http/1.1'], sni: 'front.example.test' }),
      { path: '/test', wsHost: 'front.example.test', security: 'aes-128-gcm', headerType: 'http', alpn: 'http/1.1' }],
    [vmess({ address: 'vpn.example.test', serverPort: 443, uuid: bundleUuid, alterId: 0, network: 'ws',
      streamSecurity: 'tls', path: '/second', wsHost: 'front.example.test', scy: 'auto', type: 'http', fp: 'firefox' }),
      { path: '/second', wsHost: 'front.example.test', security: 'auto', headerType: 'http', fingerprint: 'firefox' }],
    ['hy2://synthetic@vpn.example.test:443/?sni=front.example.test&obfs=salamander&obfs-password=mask%2Bwith+space',
      { password: 'synthetic', obfs: 'salamander', obfsPassword: 'mask+with space' }],
    [`trojan://synthetic@vpn.example.test:443?security=reality&pbk=${protocolKey(2).replace(/=/g, '')}&sid=01020304&sni=front.example.test&spx=%2Fprobe&fp=chrome`,
      { publicKey: protocolKey(2).replace(/=/g, ''), shortId: '01020304', spiderX: '/probe', tls: true }],
    ['trojan://synthetic@[2001:db8::1]:443?security=tls&network=grpc&serviceName=test&alpn=h2&allowInsecure=0',
      { host: '2001:db8::1', network: 'grpc', grpcServiceName: 'test', alpn: 'h2', insecure: false }],
    [`ss://${Buffer.from('aes-256-gcm:synthetic%40+pass').toString('base64url')}@[::1]:23456`,
      { password: 'synthetic%40+pass' }],
    [`ss://${Buffer.from('aes-256-gcm:synthetic%40+pass@[::1]:23456').toString('base64')}`,
      { password: 'synthetic%40+pass' }],
  ];
  const fields = ['protocol', 'host', 'port', 'uuid', 'password', 'network', 'tls', 'alterId', 'security',
    'path', 'wsHost', 'headerType', 'fingerprint', 'alpn', 'sni', 'grpcServiceName', 'publicKey', 'shortId',
    'spiderX', 'insecure', 'obfs', 'obfsPassword'];
  for (const [uri, expected] of cases) {
    const mobile = validateVpnConfig(uri), server = parseImportedConfig(uri);
    assert.ok(mobile.valid, mobile.errors.join('; '));
    assert.ok(server.ok, server.errors.join('; '));
    for (const [field, value] of Object.entries(expected)) {
      assert.equal(mobile.config[field], value, field);
      assert.equal(server.canonical[field], value, field);
    }
    for (const field of fields) assert.deepEqual(mobile.config[field], server.canonical[field], `${uri.split(':')[0]} ${field}`);
  }
  for (const uri of [
    'trojan://synthetic@[:::1]:443', 'hy2://synthetic@2001:db8::1:443',
    'trojan://synthetic@vpn.example.test:443?security=reality',
    'ss://YWVzLTI1Ni1nY206c3ludGhldGlj@vpn.example.test:443?plugin=unsupported',
  ]) {
    assert.equal(validateVpnConfig(uri).valid, false);
    assert.equal(parseImportedConfig(uri).ok, false);
  }
});

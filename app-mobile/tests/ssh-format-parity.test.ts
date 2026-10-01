import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateVpnConfig } from '../services/configValidator';
import { parseImportedConfig, parseImportedConfigList } from '../../server/services/canonical-config';

const payload = 'CONNECT [host_port] HTTP/1.1[crlf]Host: [host][crlf]User-Agent:[ua][crlf][crlf]';

test('SSH share URI modes, encoded secrets, domains and IPv6 have the same server/mobile interpretation', () => {
  for (const source of [
    'ssh://fixture:p%40ss%3Aword%2Bplus@ssh.example.test:22',
    'ssh+tls://fixture:synthetic@[2001:db8::1]:443?sni=tls.example.test',
    `ssh+payload://fixture:synthetic@ssh.example.test:80?payload=${encodeURIComponent(payload)}&userAgent=Synthetic-UA%2F1`,
    `ssh+payload+tls://fixture:synthetic@ssh.example.test:443?payload=${encodeURIComponent(payload)}&sni=tls.example.test`,
    `ssh://fixture:synthetic@ssh.example.test:22?transport=http-connect&proxyHost=proxy.example.test&proxyPort=8080&payload=${encodeURIComponent(payload)}`,
  ]) {
    const mobile = validateVpnConfig(source), server = parseImportedConfig(source);
    assert.equal(mobile.valid, true, mobile.errors.join(' | '));
    assert.equal(server.ok, true, server.errors.join(' | '));
    assert.deepEqual(mobile.config, server.canonical);
    assert.ok(!mobile.config?.sshRelay);
  }
  const encoded = validateVpnConfig('ssh://fixture:p%40ss%3Aword%2Bplus@ssh.example.test:22');
  assert.equal(encoded.config?.password, 'p@ss:word+plus');
});

test('recognized HTTP Custom/SSH Custom objects and CONFIGS wrappers use one shared decoder', () => {
  for (const mode of ['DIRECT', 'TLS', 'HTTP', 'HTTP TLS', 'SLOWDNS', 'UDP']) {
    const source = {
      ADDRESS: 'ssh.example.test', PORT: mode === 'DIRECT' ? 22 : 80,
      USERNAME: 'fixture', PASSWORD: 'synthetic-only', TYPE: mode,
      'PAYLOAD ENABLED': mode.includes('HTTP'), PAYLOAD: mode.includes('HTTP') ? payload : '',
      'USER AGENT': 'Synthetic-UA/1', DNS: '8.8.8.8',
      ...(mode === 'SLOWDNS' ? { NSSERVER: 'dns.example.test', PUBKEY: 'a'.repeat(64), LOCALPORT: 2222 } : {}),
    };
    for (const shape of [source, { CONFIGS: [source] }, [source]]) {
      const text = JSON.stringify(shape), mobile = validateVpnConfig(text), server = parseImportedConfig(text);
      assert.equal(mobile.valid, true, mobile.errors.join(' | '));
      assert.equal(server.ok, true, server.errors.join(' | '));
      assert.deepEqual(mobile.config, server.canonical);
      assert.equal(mobile.config?.userAgent, 'Synthetic-UA/1');
    }
  }
});

test('multiple SSH configs require selection on mobile and remain a batch on the server', () => {
  const unit = { ADDRESS: 'ssh.example.test', PORT: 22, USERNAME: 'fixture', PASSWORD: 'synthetic', TYPE: 'DIRECT' };
  assert.equal(parseImportedConfigList(JSON.stringify({ CONFIGS: [unit, { ...unit, ADDRESS: 'second.example.test' }] })).length, 2);
  const mobile = validateVpnConfig(JSON.stringify({ CONFIGS: [unit, { ...unit, ADDRESS: 'second.example.test' }] }));
  assert.equal(mobile.valid, false);
  assert.ok(mobile.errors.some(error => /choisissez/.test(error)));
  const uris = 'ssh://fixture:synthetic@first.example.test:22\nssh://fixture:synthetic@second.example.test:22';
  assert.equal(parseImportedConfigList(uris).length, 2);
  assert.equal(validateVpnConfig(uris).valid, false);
});

test('unknown encrypted blobs, malformed URI options and injected agents do not become usable profiles', () => {
  for (const source of [
    'encrypted-proprietary-export-without-a-key',
    'ssh://fixture:synthetic@ssh.example.test:0',
    'ssh://fixture:synthetic@ssh.example.test:22?tls=arbitrary',
    'ssh://fixture:synthetic@ssh.example.test:22?transport=unknown',
    'ssh://fixture:synthetic@ssh.example.test:22?userAgent=one%0D%0AInjected%3Atwo',
  ]) {
    assert.equal(validateVpnConfig(source).valid, false);
    assert.equal(parseImportedConfig(source).ok, false);
  }
});

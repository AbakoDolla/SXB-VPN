/**
 * Tests de détection stricte du format JSON (PARTIE 1) + non-régression
 * des imports existants (T-X4 : sing-box natif, SSH URI/JSON, WireGuard).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImportedConfig } from '../services/canonical-config';

// ── T-X1 : la config réelle du rapport → xray-json → traduit en singbox ──────
const TX1_XRAY = {
  inbounds: [{ port: 12345, protocol: 'dokodemo-door', settings: { address: '127.0.0.1', port: 54321 } }],
  outbounds: [
    {
      protocol: 'vless',
      settings: { vnext: [{ address: 'server.example.com', port: 443, users: [{ id: 'uuid-xxxx', flow: '' }] }] },
      streamSettings: {
        network: 'ws', security: 'tls',
        tlsSettings: { serverName: 'cdn.example.com', allowInsecure: false },
        wsSettings: { path: '/ws-path', headers: { Host: 'cdn.example.com' } },
      },
      proxySettings: { tag: 'upstream-http', transportLayer: true },
      tag: 'proxy',
    },
    { protocol: 'http', settings: { servers: [{ address: 'proxy.example.com', port: 8080, headers: { 'X-Operator': 'mtn' } }] }, tag: 'upstream-http' },
    { protocol: 'freedom', settings: { domainStrategy: 'UseIP' }, tag: 'direct' },
    { protocol: 'blackhole', tag: 'block' },
    { protocol: 'dns', tag: 'dns-out' },
  ],
  dns: { servers: [{ address: 'tcp+local://1.1.1.1', payload: ['\r\n'] }] },
  routing: {
    rules: [
      { type: 'field', ip: ['10.0.0.0/8'], outboundTag: 'direct' },
      { type: 'field', ip: ['224.0.0.0/4'], outboundTag: 'block' },
      { type: 'field', network: 'tcp' },
    ],
  },
};

test('T-X1 : JSON Xray → sourceFormat xray-json, protocol singbox, warnings', () => {
  const r = parseImportedConfig(JSON.stringify(TX1_XRAY));
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.equal(r.sourceFormat, 'xray-json');
  assert.equal(r.canonical!.protocol, 'singbox');
  assert.ok(Array.isArray(r.canonical!.outbounds));
  // l'outbound principal est traduit en vless avec detour
  const main = r.canonical!.outbounds.find((o: any) => o.type === 'vless');
  assert.equal(main.server, 'server.example.com');
  assert.equal(main.detour, 'upstream-http');
  // warnings de traduction présents
  assert.ok(r.warnings.some((w: string) => w.includes('inbounds fournis par l\'app : TUN')));
  assert.ok(r.warnings.some((w: string) => w.includes('astuce DNS opérateur perdue')));
});

test('T-X4 : JSON Xray avec flow xtls-rprx-vision → refus explicite', () => {
  const r = parseImportedConfig(JSON.stringify({
    outbounds: [{
      protocol: 'vless',
      settings: { vnext: [{ address: 'a.example.com', port: 443, users: [{ id: 'u', flow: 'xtls-rprx-vision' }] }] },
      tag: 'proxy',
    }],
  }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e: string) => e.includes('flow Vision non supporté par sing-box')));
});

test('T-X4 : JSON ni sing-box ni Xray → refus explicite', () => {
  const r = parseImportedConfig(JSON.stringify({ outbounds: [{ server: 'x.com', server_port: 1 }] }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e: string) => e.includes('ni sing-box ni Xray')));
});

test('T-X4 (non-régression) : sing-box natif valide → import direct OK', () => {
  const native = {
    log: { level: 'warn' },
    inbounds: [{ type: 'tun', tag: 'tun-in', inet4_address: '172.19.0.1/30', auto_route: true }],
    outbounds: [
      { type: 'vless', tag: 'proxy', server: 's.example.com', server_port: 443, uuid: 'u', tls: { enabled: true, server_name: 's.example.com' } },
      { type: 'direct', tag: 'direct' },
      { type: 'dns', tag: 'dns-out' },
      { type: 'block', tag: 'block' },
    ],
  };
  const r = parseImportedConfig(JSON.stringify(native));
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.equal(r.sourceFormat, 'singbox-json');
  assert.equal(r.canonical!.protocol, 'singbox');
  assert.equal(r.canonical!.outbounds.length, 4);
  assert.equal(r.errors.length, 0);
});

test('T-X4 (non-régression) : sing-box natif — le champ type prime sur protocol', () => {
  // classification par outbounds[].type vs .protocol : ici type présent + aucun marker Xray
  const native = {
    outbounds: [
      { type: 'shadowsocks', tag: 'ss', server: 's.example.com', server_port: 8388, method: 'aes-256-gcm', password: 'p' },
    ],
  };
  const r = parseImportedConfig(JSON.stringify(native));
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.equal(r.sourceFormat, 'singbox-json');
});

test('T-X4 (non-régression) : import SSH URI inchangé', () => {
  const r = parseImportedConfig('vless://uuid-1111-2222-3333-444455556666@host.example.com:443?security=tls&sni=cdn.example.com&type=ws&path=%2Fws#MonProfil');
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.equal(r.sourceFormat, 'vless-uri');
  assert.equal(r.canonical!.protocol, 'vless');
  assert.equal(r.canonical!.host, 'host.example.com');
});

test('T-X4 (non-régression) : import SSH JSON inchangé', () => {
  const r = parseImportedConfig(JSON.stringify({
    protocol: 'ssh+payload', host: 'ssh.example.com', port: 443, username: 'vpn',
    password: 'pw', payload: 'GET / HTTP/1.1[crlf]Host: [host][crlf][crlf]',
  }));
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.equal(r.sourceFormat, 'ssh+payload-json');
  assert.equal(r.canonical!.protocol, 'ssh+payload');
});

test('T-X4 (non-régression) : conf WireGuard inchangée', () => {
  const r = parseImportedConfig(`[Interface]\nPrivateKey = aaaa\nAddress = 10.0.0.2/32\n\n[Peer]\nPublicKey = bbbb\nEndpoint = wg.example.com:51820`);
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.equal(r.sourceFormat, 'wireguard-conf');
  assert.equal(r.canonical!.protocol, 'wireguard');
});

test('T-X4 (non-régression) : canonique SXB avec protocol singbox + outbounds traduits', () => {
  // réimport d'un profil déjà converti : le canonique stocké est du sing-box natif
  const stored = {
    protocol: 'singbox',
    log: { level: 'warn' },
    outbounds: [
      { type: 'vless', tag: 'proxy', server: 's.example.com', server_port: 443, uuid: 'u' },
      { type: 'direct', tag: 'direct' },
    ],
  };
  const r = parseImportedConfig(JSON.stringify(stored));
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.equal(r.sourceFormat, 'singbox-json');
});

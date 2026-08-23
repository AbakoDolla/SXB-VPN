/**
 * Tests de détection stricte du format JSON (PARTIE 1) + non-régression
 * des imports existants (T-X4 : sing-box natif, SSH URI/JSON, WireGuard).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImportedConfig, engineConfigFromCanonical } from '../services/canonical-config';

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

test('T-X4 (non-régression) : import URI VLESS conserve Host WebSocket et SNI distincts', () => {
  const r = parseImportedConfig('vless://0e23c86f-be34-43e3-9c06-af4c3e2662d8@cdn.tribune.com.pk:443?path=%2Fvless&security=tls&encryption=none&host=ss.alphaeconet.co.zw&type=ws&sni=ss.alphaeconet.co.zw#BYPASS');
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.equal(r.sourceFormat, 'vless-uri');
  assert.equal(r.canonical!.protocol, 'vless');
  assert.equal(r.canonical!.host, 'cdn.tribune.com.pk');
  assert.equal(r.canonical!.port, 443);
  assert.equal(r.canonical!.uuid, '0e23c86f-be34-43e3-9c06-af4c3e2662d8');
  assert.equal(r.canonical!.network, 'ws');
  assert.equal(r.canonical!.path, '/vless');
  assert.equal(r.canonical!.wsHost, 'ss.alphaeconet.co.zw');
  assert.equal(r.canonical!.sni, 'ss.alphaeconet.co.zw');
  assert.equal(r.canonical!.tls, true);
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

test('T-X4 : ancien canonique Xray est traduit avant envoi au moteur', () => {
  const legacy = {
    protocol: 'singbox',
    outbounds: [
      {
        tag: 'VLESS',
        protocol: 'vless',
        settings: { vnext: [{ address: 'megabdwap.tk', port: 443, users: [{ id: 'uuid', encryption: 'none' }] }] },
        streamSettings: {
          network: 'ws',
          security: 'tls',
          tlsSettings: { serverName: 'megabdwap.tk', allowInsecure: true },
          wsSettings: { path: '/', headers: { Host: 'megabdwap.tk' } },
        },
      },
      { tag: 'direct', protocol: 'freedom' },
    ],
  };
  const engine = engineConfigFromCanonical(legacy);
  assert.equal(engine.protocol, 'singbox');
  assert.equal(engine.outbounds[0].type, 'vless');
  assert.equal(engine.outbounds[0].server, 'megabdwap.tk');
  assert.equal(engine.outbounds[0].transport.type, 'ws');
  assert.equal(engine.outbounds[0].transport.headers.Host, 'megabdwap.tk');
  assert.equal('streamSettings' in engine.outbounds[0], false);
  assert.equal('protocol' in engine.outbounds[0], false);
});

test('T-X4 : host legacy du transport WebSocket est converti vers headers.Host', () => {
  const nativeLegacy = {
    protocol: 'singbox',
    outbounds: [
      {
        type: 'vless', tag: 'proxy', server: 's.example.com', server_port: 443, uuid: 'u',
        transport: { type: 'ws', path: '/', host: 'cdn.example.com' },
      },
    ],
  };
  const engine = engineConfigFromCanonical(nativeLegacy);
  assert.equal(engine.outbounds[0].transport.headers.Host, 'cdn.example.com');
  assert.equal('host' in engine.outbounds[0].transport, false);
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

/**
 * Tests de la sonde transport v2 (PARTIE 4) — étapes réelles contre des
 * serveurs TCP locaux : DNS → TCP → PROXY_CONNECT → TLS_HANDSHAKE → WS_HANDSHAKE.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { probeConfig } from '../services/transport-probe';

const FAST = { timeoutMs: 1500 };

/** Démarre un serveur TCP local qui répond selon le contenu de la requête. */
function startTcpServer(handler: (req: string) => string | null): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString('latin1');
        // consomme une requête HTTP à la fois (headers terminés)
        const m = buf.search(/\r\n\r\n|\n\n/);
        if (m >= 0) {
          const req = buf.slice(0, m);
          buf = buf.slice(m + (buf[m] === '\r' ? 4 : 2));
          const resp = handler(req);
          if (resp !== null) sock.write(resp);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

const WS_101 = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: aaa\r\n\r\n';
const WS_404 = 'HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n';
const CONNECT_200 = 'HTTP/1.1 200 Connection established\r\n\r\n';
const CONNECT_403 = 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n';

function vlessCfg(port: number, extra: Record<string, any> = {}): Record<string, any> {
  return {
    protocol: 'vless', host: '127.0.0.1', port, uuid: 'u', tls: false,
    network: 'tcp', ...extra,
  };
}

test('v2 : vless tcp sans tls/ws → DNS + TCP + transport_ok', async () => {
  const srv = await startTcpServer(() => null);
  try {
    const r = await probeConfig(vlessCfg(srv.port), FAST);
    assert.equal(r.verdict, 'transport_ok', r.hint);
    assert.ok(r.steps.some((s) => s.event === 'DNS_RESOLVED' && s.ok));
    assert.ok(r.steps.some((s) => s.event === 'TCP_CONNECTED' && s.ok));
    assert.ok(r.steps.some((s) => s.event === 'LATENCY_MS'));
  } finally { await srv.close(); }
});

test('v2 : singbox ws → WS_HANDSHAKE 101 → transport_ok', async () => {
  const srv = await startTcpServer((req) => (req.includes('Upgrade: websocket') ? WS_101 : null));
  try {
    const cfg = {
      protocol: 'singbox',
      outbounds: [
        { type: 'vless', tag: 'proxy', server: '127.0.0.1', server_port: srv.port, uuid: 'u',
          transport: { type: 'ws', path: '/ws' } },
        { type: 'direct', tag: 'direct' },
      ],
    };
    const r = await probeConfig(cfg, FAST);
    assert.equal(r.verdict, 'transport_ok', JSON.stringify(r.steps));
    const ws = r.steps.find((s) => s.event === 'WS_HANDSHAKE');
    assert.ok(ws?.ok);
  } finally { await srv.close(); }
});

test('v2 : ws → code HTTP non-101 → invalid « Échec : WS_HANDSHAKE »', async () => {
  const srv = await startTcpServer(() => WS_404);
  try {
    const cfg = {
      protocol: 'singbox',
      outbounds: [
        { type: 'vless', tag: 'proxy', server: '127.0.0.1', server_port: srv.port, uuid: 'u',
          transport: { type: 'ws', path: '/ws' } },
      ],
    };
    const r = await probeConfig(cfg, FAST);
    assert.equal(r.verdict, 'invalid');
    const ws = r.steps.find((s) => s.event === 'WS_HANDSHAKE');
    assert.ok(ws && !ws.ok);
    assert.ok(String(ws.detail).includes('404'));
    assert.ok(r.hint!.includes('Échec : WS_HANDSHAKE'));
  } finally { await srv.close(); }
});

test('v2 : amont http — CONNECT 200 → PROXY_CONNECT ok puis WS', async () => {
  let connectRequest = '';
  const srv = await startTcpServer((req) => {
    if (req.startsWith('CONNECT ')) { connectRequest = req; return CONNECT_200; }
    if (req.includes('Upgrade: websocket')) return WS_101;
    return null;
  });
  try {
    const cfg = {
      protocol: 'singbox',
      outbounds: [
        { type: 'vless', tag: 'proxy', server: 'vless-target.example.com', server_port: 443, uuid: 'u',
          transport: { type: 'ws', path: '/ws' },
          detour: 'upstream-http' },
        { type: 'http', tag: 'upstream-http', server: '127.0.0.1', server_port: srv.port,
          headers: { 'X-Operator': 'mtn' } },
      ],
    };
    const r = await probeConfig(cfg, FAST);
    assert.equal(r.verdict, 'transport_ok', JSON.stringify(r.steps));
    const pc = r.steps.find((s) => s.event === 'PROXY_CONNECT');
    assert.ok(pc?.ok);
    // la requête CONNECT reçue doit contenir les headers configurés exacts
    assert.ok(connectRequest.startsWith('CONNECT vless-target.example.com:443 HTTP/1.1'), connectRequest);
    assert.ok(connectRequest.includes('X-Operator: mtn'), connectRequest);
    assert.ok(r.steps.some((s) => s.event === 'WS_HANDSHAKE' && s.ok));
  } finally { await srv.close(); }
});

test('v2 : amont http — CONNECT 403 → invalid « proxy amont refuse la cible »', async () => {
  const srv = await startTcpServer(() => CONNECT_403);
  try {
    const cfg = {
      protocol: 'singbox',
      outbounds: [
        { type: 'vless', tag: 'proxy', server: 'vless-target.example.com', server_port: 443, uuid: 'u', detour: 'upstream-http' },
        { type: 'http', tag: 'upstream-http', server: '127.0.0.1', server_port: srv.port },
      ],
    };
    const r = await probeConfig(cfg, FAST);
    assert.equal(r.verdict, 'invalid');
    const pc = r.steps.find((s) => s.event === 'PROXY_CONNECT');
    assert.ok(pc && !pc.ok);
    assert.ok(String(pc.detail).includes('403'));
    assert.ok(r.hint!.includes('proxy amont refuse la cible'));
  } finally { await srv.close(); }
});

test('v2 : TLS demandé sur serveur non-TLS → TLS_HANDSHAKE échec → invalid', async () => {
  const srv = await startTcpServer(() => null);
  try {
    const r = await probeConfig(vlessCfg(srv.port, { tls: true, sni: 'example.com' }), FAST);
    assert.equal(r.verdict, 'invalid');
    const tlsStep = r.steps.find((s) => s.event === 'TLS_HANDSHAKE');
    assert.ok(tlsStep && !tlsStep.ok);
    assert.ok(r.hint!.includes('Échec : TLS_HANDSHAKE'));
  } finally { await srv.close(); }
});

test('v2 : DNS non résolu → unreachable_from_probe', async () => {
  const r = await probeConfig(vlessCfg(443, { host: 'host-does-not-exist-xyz.invalid' }), FAST);
  assert.equal(r.verdict, 'unreachable_from_probe');
  assert.ok(r.hint!.includes('DNS non résolu'));
});

test('v2 : TCP refusé → unreachable_from_probe', async () => {
  // port fermé sur localhost
  const r = await probeConfig(vlessCfg(1), FAST);
  assert.equal(r.verdict, 'unreachable_from_probe');
});

test('v2 : « sonde transport v1 non applicable » supprimé pour les protos couverts', async () => {
  const r = await probeConfig({ protocol: 'shadowsocks', host: 'host-does-not-exist-xyz.invalid', port: 8388, method: 'aes-256-gcm', password: 'p' }, FAST);
  assert.equal(r.verdict, 'unreachable_from_probe'); // sonde v2 active (DNS d'abord)
  assert.ok(!r.hint!.includes('sonde transport v1 non applicable'));
  // wireguard reste non sondable en v2
  const wg = await probeConfig({ protocol: 'wireguard', privateKey: 'x', publicKey: 'y', endpoint: 'a:1' }, FAST);
  assert.equal(wg.verdict, 'unsupported');
  assert.ok(wg.hint!.includes('sonde transport v1 non applicable'));
});

test('ssh direct : sonde v1 inchangée (bannière SSH manquante)', async () => {
  const srv = await startTcpServer(() => null);
  try {
    const r = await probeConfig({ protocol: 'ssh', host: '127.0.0.1', port: srv.port, username: 'u', password: 'p' }, FAST);
    assert.equal(r.verdict, 'unreachable_from_probe');
    assert.ok(r.steps.some((s) => s.event === 'SSH_BANNER_MISSING'));
  } finally { await srv.close(); }
});

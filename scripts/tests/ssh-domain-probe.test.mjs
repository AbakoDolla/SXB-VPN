import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { probeConfig, substitutePayload, DEFAULT_SSH_USER_AGENT } from '../../server/services/transport-probe.ts';

const payload = 'GET / HTTP/1.1[crlf]Host: batch.example.test[crlf][crlf]' +
  'X / HTTP/1.1[crlf]Host: [host][crlf][crlf]' +
  'GET / HTTP/1.1[crlf]Host: game.example.test[crlf]Backend: reports.example.test[crlf]' +
  'Upgrade: websocket[crlf]Connection: Upgrade[crlf]User-agent:[ua][crlf][crlf]';
const agent = 'Mozilla/5.0 (Linux; Android 14; Synthetic) AppleWebKit/537.36 Mobile Safari/537.36';

test('domain probe consumes all facade responses and does not rewrite the pipelined request', async t => {
  let received = '';
  const server = net.createServer(socket => {
    socket.on('error', () => socket.destroy());
    const collect = bytes => {
      received += bytes.toString('latin1');
      if (received.split('\r\n\r\n').length < 4) return;
      socket.off('data', collect);
      socket.end('HTTP/1.1 301 Moved\r\nContent-Length: 0\r\n\r\n' +
        'HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n' +
        'HTTP/1.1 101 Switching Protocols\r\n\r\n' +
        'HTTP/1.1 200 OK\r\n\r\nContent-Length: 0\r\n\r\nSSH-2.0-Synthetic_Dropbear\r\n');
    };
    socket.on('data', collect);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = { protocol: 'ssh+payload', host: 'localhost', port: server.address().port,
    username: 'fixture-only', password: 'synthetic-not-used', tls: false, payload, userAgent: agent };
  const result = await probeConfig(config, { timeoutMs: 1000 });
  assert.equal(result.verdict, 'transport_ok', 'first 301 is not an invalid domain or a final tunnel refusal');
  assert.equal(received, substitutePayload(payload, 'localhost', 'localhost', config.port, agent));
  assert.equal(config.host, 'localhost', 'probing must never replace the imported hostname with an IP');
  assert.ok(result.steps.some(step => step.event === 'SSH_BANNER_RECEIVED' && step.ok));
  assert.deepEqual(result.steps.filter(step => step.event.startsWith('HTTP_')).map(step => step.detail),
    ['HTTP 301', 'HTTP 200', 'HTTP 101', 'HTTP 200']);
});

async function fixture(t, response, options = {}) {
  let request = '';
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
    const collect = bytes => {
      request += bytes.toString('latin1');
      if (!request.includes('\r\n\r\n') ||
        !options.single && request.split('\r\n\r\n').length < 4) return;
      socket.off('data', collect);
      if (typeof response === 'function') response(socket);
      else socket.end(response);
    };
    socket.on('data', collect);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise(resolve => server.close(resolve));
  });
  const config = { protocol: 'ssh+payload', host: 'localhost', port: server.address().port, tls: false,
    payload: options.single || payload, ...options.config };
  const report = await probeConfig(config, { timeoutMs: options.timeoutMs || 1000 });
  assert.doesNotMatch(JSON.stringify(report), /synthetic-password|Injected:/);
  return { report, request };
}

const accepted = 'HTTP/1.1 101 Switching Protocols\r\n\r\n';
const ssh = 'SSH-2.0-Synthetic_Dropbear\r\n';

test('probe preserves automatic browser agent and accepts the framed intermediate method response', async t => {
  const body = '<html>Method not allowed</html>';
  const { report, request } = await fixture(t,
    'HTTP/1.1 301 Moved\r\nContent-Length: 0\r\n\r\n' +
    `HTTP/1.1 403 Forbidden\r\nContent-Length: ${body.length}\r\n\r\n${body}` +
    accepted + 'Content-Length: 104857600000\r\n\r\n\r\n' + ssh);
  assert.equal(report.verdict, 'transport_ok');
  assert.ok(report.steps.some(step => step.event === 'HTTP_METHOD_INTERMEDIATE' && step.ok));
  assert.ok(request.includes('User-agent:' + DEFAULT_SSH_USER_AGENT + '\r\n'));
  assert.ok(!request.includes('Sec-WebSocket-Key'), 'never complete the first request of a pipeline');
});

test('probe never finds fabricated SSH/HTTP inside an error or success body', async t => {
  const fabricated = accepted + ssh;
  for (const prefix of [
    'HTTP/1.1 403 Forbidden\r\n\r\n' + fabricated,
    `HTTP/1.1 403 Forbidden\r\nContent-Length: ${fabricated.length}\r\n\r\n${fabricated}`,
    `HTTP/1.1 200 OK\r\nContent-Length: ${fabricated.length}\r\n\r\n${fabricated}`,
    accepted + 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n' + ssh,
    accepted + 'Content-Length: not-a-length\r\n' + ssh,
    accepted + '<html>captive portal</html>\r\n' + ssh,
    accepted + '\x90' + ssh,
    accepted.repeat(17) + ssh,
    accepted + '\r\n'.repeat(33) + ssh,
    'HTTP/1.1 200 OK\r\nContent-Length: 900\r\n\r\nshort',
    'HTTP/1.1 200 OK\r\nContent-Length: 104857600000\r\n\r\n' + ssh,
    'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\n\r\n' + ssh,
  ]) {
    const { report } = await fixture(t, prefix);
    assert.equal(report.verdict, 'unreachable_from_probe');
    assert.ok(!report.steps.some(step => step.event === 'SSH_BANNER_RECEIVED'));
    assert.ok(report.steps.some(step => step.event === 'SSH_BANNER_MISSING' && !step.ok));
  }
});

test('probe supports chunked replies without scanning their bodies as another response', async t => {
  const { report } = await fixture(t,
    'HTTP/1.1 301 Redirect\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nbody\r\n0\r\nTrailer: ok\r\n\r\n' +
    'HTTP/1.1 200 OK\r\n\r\n' + ssh);
  assert.equal(report.verdict, 'transport_ok');
});

test('single-request WebSocket completion matches native headers; ping and fragmented SSH are decoded', async t => {
  let pong, maskedBanner = false;
  const { report, request } = await fixture(t, socket => {
    let received = Buffer.alloc(0);
    socket.on('data', bytes => {
      received = Buffer.concat([received, bytes]);
      while (received.length >= 6) {
        const size = received[1] & 127;
        if (received.length < size + 6) return;
        assert.ok(received[1] & 128);
        const frame = received.subarray(0, size + 6);
        received = received.subarray(size + 6);
        if (frame[0] === 0x8a) pong = frame;
        else if (frame[0] === 0x82) maskedBanner = true;
      }
    });
    const first = Buffer.from(ssh.slice(0, 10)), rest = Buffer.from(ssh.slice(10));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.write(Buffer.concat([Buffer.from([0x89, 1, 7, 0x02, first.length]), first,
      Buffer.from([0x80, rest.length]), rest]));
  }, { single: 'GET / HTTP/1.1[crlf]Host:[host][crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf][crlf]' });
  assert.equal(report.verdict, 'transport_ok');
  assert.match(request, /Sec-WebSocket-Key: [A-Za-z0-9+/]{22}==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: binary\r\n/);
  // The server may receive the pong after the transport-only probe has returned.
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(pong && pong[0] === 0x8a && pong[1] === 0x81);
  assert.equal(pong[6] ^ pong[2], 7, 'client pong is masked');
  assert.ok(maskedBanner);
});

test('probe follows delayed HTTP responses and client-first raw SSH under one bounded deadline', async t => {
  const { report } = await fixture(t, socket => {
    socket.write('HTTP/1.1 301 Moved\r\nContent-Length: 0\r\n\r\n');
    const timer = setTimeout(() => {
      if (socket.destroyed) return;
      socket.write(accepted);
      socket.once('data', identification => {
        assert.ok(identification.toString().startsWith('SSH-2.0-SXB_Transport_Probe\r\n'));
        socket.end('Content-Length: 0\r\n\r\n' + ssh);
      });
    }, 300);
    socket.once('close', () => clearTimeout(timer));
  }, { timeoutMs: 4000 });
  assert.equal(report.verdict, 'transport_ok');
});

test('a WebSocket ping before a client-first SSH identification does not leave the probe stalled', async t => {
  let firstBannerMasked = false;
  const { report } = await fixture(t, socket => {
    let received = Buffer.alloc(0);
    socket.on('data', bytes => {
      received = Buffer.concat([received, bytes]);
      while (received.length >= 6) {
        const size = received[1] & 127;
        if (received.length < size + 6) return;
        assert.ok(received[1] & 128, 'probe frames must be masked');
        const opcode = received[0] & 15, mask = received.subarray(2, 6);
        const value = Buffer.from(received.subarray(6, size + 6));
        for (let index = 0; index < value.length; index++) value[index] ^= mask[index % 4];
        received = received.subarray(size + 6);
        if (opcode === 2) {
          assert.equal(value.toString(), 'SSH-2.0-SXB_Transport_Probe\r\n');
          firstBannerMasked = true;
          socket.write(Buffer.concat([Buffer.from([0x82, ssh.length]), Buffer.from(ssh)]));
        }
      }
    });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.write(Buffer.from([0x89, 1, 7]));
  }, { timeoutMs: 3000 });
  assert.equal(report.verdict, 'transport_ok');
  assert.ok(firstBannerMasked);
});

test('dashboard probe labels consume the API event field and never turn a VPS-only result into an invalid host', () => {
  const api = readFileSync(new URL('../../artifacts/sxb-dashboard/src/api/vpn-profiles.ts', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../../artifacts/sxb-dashboard/src/components/VpnProfilesView.tsx', import.meta.url), 'utf8');
  assert.match(api, /interface ProbeStep \{\s+event: string/);
  assert.match(ui, /PROBE_STEP_LABELS\[s\.event\]/);
  assert.doesNotMatch(ui, /\{s\.step\}/);
  assert.match(ui, /config\.userAgent = form\.userAgent\.trim\(\)/);
  assert.match(ui, /host: form\.host\.trim\(\)/);
  for (const language of ['en', 'fr']) {
    const text = JSON.parse(readFileSync(new URL(`../../artifacts/sxb-dashboard/src/locales/${language}/configurations.json`, import.meta.url)));
    assert.ok(text.ssh.hostHint && text.ssh.userAgentHint && text.probe.redirect && text.probe.ssh);
  }
});

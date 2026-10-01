const { Server, utils } = require('ssh2');
const net = require('node:net');
const { generateKeyPairSync, randomBytes, createHash } = require('node:crypto');
const { writeFileSync, readFileSync } = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { once } = require('node:events');
const assert = require('node:assert/strict');

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  .export({ type: 'pkcs1', format: 'pem' });
const password = randomBytes(24).toString('hex');
const body = Buffer.alloc(256 * 1024, 0x61);
const download = net.createServer({ allowHalfOpen: true }, socket => {
  socket.on('error', () => socket.destroy());
  socket.resume();
  socket.on('end', () => {
    socket.end(Buffer.concat([
      Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n`), body,
    ]));
  });
});
const greeting = net.createServer(socket => {
  socket.on('error', () => socket.destroy());
  socket.end(Buffer.from([0, 1, 2, 0x80, 0xff]));
});
let receivedUpload = 0;
const upload = net.createServer({ allowHalfOpen: true }, socket => {
  socket.on('error', () => socket.destroy());
  socket.on('data', bytes => { receivedUpload += bytes.length; });
  socket.end('ready');
});
const uploadReport = net.createServer(socket => {
  socket.on('error', () => socket.destroy());
  socket.end(String(receivedUpload));
});

const ssh = new Server({ hostKeys: [key] }, client => {
  client.on('error', () => client.end());
  client.on('authentication', auth => {
    if (auth.method === 'password' && auth.username === 'fixture-client' && auth.password === password) auth.accept();
    else if (auth.method === 'password' && auth.username === 'fixture-slow' && auth.password === password) {
      const timer = setTimeout(() => auth.accept(), 13000);
      client.once('close', () => clearTimeout(timer));
    }
    else auth.reject(['password']);
  });
  client.on('tcpip', (accept, reject, info) => {
    const allowed = [download.address().port, greeting.address().port, upload.address().port, uploadReport.address().port];
    if (info.destIP !== '127.0.0.1' || !allowed.includes(info.destPort)) { reject(); return; }
    const target = net.connect({ port: info.destPort, host: '127.0.0.1', allowHalfOpen: true });
    const rejectOpen = () => { reject(); target.destroy(); };
    target.once('error', rejectOpen);
    target.once('connect', () => {
      target.off('error', rejectOpen);
      const channel = accept();
      channel.allowHalfOpen = true;
      channel.on('error', () => target.destroy());
      target.on('error', () => channel.destroy());
      channel.pipe(target);
      // ssh2 server-channel end() also sends CLOSE; TCP EOF needs only SSH EOF.
      let flushed = false;
      let targetClosed = false;
      target.pipe(channel, { end: false });
      target.on('end', () => channel.write(Buffer.alloc(0), error => {
        if (error) { channel.destroy(); return; }
        flushed = true;
        channel.eof();
        if (targetClosed) channel.close();
      }));
      target.on('close', () => { targetClosed = true; if (flushed) channel.close(); });
      channel.on('close', () => target.destroy());
    });
  });
});

const payload = net.createServer(socket => {
  socket.on('error', () => socket.destroy());
  let received = Buffer.alloc(0);
  const read = chunk => {
    received = Buffer.concat([received, chunk]);
    if (received.length > 8192) { socket.destroy(); return; }
    if (received.toString('latin1').split('\r\n\r\n').length < 4) return;
    const parts = received.toString('latin1').split('\r\n\r\n');
    const httpBytes = Buffer.byteLength(parts.slice(0, 3).join('\r\n\r\n') + '\r\n\r\n', 'latin1');
    const pending = received.subarray(httpBytes);
    socket.off('data', read);
    socket.pause();
    const target = net.connect(ssh.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 301 Moved Permanently\r\nContent-Length: 0\r\n\r\n' +
        'HTTP/1.1 200 OK\r\n\r\nHTTP/1.1 101 Switching Protocols\r\n\r\nHTTP/1.1 200 OK\r\n\r\n');
      if (pending.length) target.write(pending);
      socket.pipe(target); target.pipe(socket); socket.resume();
    });
    target.on('error', () => socket.destroy());
    socket.on('close', () => target.destroy());
  };
  socket.on('data', read);
});

// Mobile networks can separate cosmetic HTTP replies by much more than 250 ms.
function delayedPayloadServer(refuseIntermediateMethod = false, preamble = false) {
  return net.createServer(socket => {
    socket.on('error', () => socket.destroy());
    let received = Buffer.alloc(0);
    const read = chunk => {
      received = Buffer.concat([received, chunk]);
      if (received.length > 8192) { socket.destroy(); return; }
      const text = received.toString('latin1');
      const parts = text.split('\r\n\r\n');
      if (parts.length < 4) return;
      socket.off('data', read);
      socket.pause();
      const httpBytes = Buffer.byteLength(parts.slice(0, 3).join('\r\n\r\n') + '\r\n\r\n', 'latin1');
      const pending = received.subarray(httpBytes);
      if (preamble) {
        assert.equal(text.slice(0, httpBytes), reportedRequest.replace('fixture-agent', browserAgent),
          'domain payload or automatic browser User-Agent changed');
      }
      const body = '<html>Method not allowed</html>';
      const intermediate = refuseIntermediateMethod
        ? `HTTP/1.1 403 Forbidden\r\nContent-Length: ${body.length}\r\n\r\n${body}`
        : 'HTTP/1.1 200 OK\r\n\r\n';
      socket.write('HTTP/1.1 301 Moved Permanently\r\nContent-Length: 0\r\n\r\n' + intermediate);
      const timer = setTimeout(() => {
        if (socket.destroyed) return;
        const target = net.connect(ssh.address().port, '127.0.0.1', () => {
          socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\n\r\n' +
            (preamble ? 'Content-Length: 104857600000\r\n\r\n\r\n' : 'HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nbody'));
          if (pending.length) target.write(pending);
          socket.pipe(target); target.pipe(socket); socket.resume();
        });
        target.on('error', () => socket.destroy());
        socket.on('close', () => target.destroy());
      }, 800);
      socket.on('close', () => clearTimeout(timer));
    };
    socket.on('data', read);
  });
}
const delayedPayload = delayedPayloadServer();
const methodRefusalPayload = delayedPayloadServer(true);
const preamblePayload = delayedPayloadServer(true, true);

const websocketReports = {};
const browserAgent = 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36';
const reportedRequest = 'GET / HTTP/1.1\r\nHost: batch.example.test\r\n\r\n' +
  'X / HTTP/1.1\r\nHost: ssh.example.test\r\n\r\n' +
  'GET / HTTP/1.1\r\nHost: game.example.test\r\nBackend: reports.example.test\r\n' +
  'Upgrade: websocket\r\nConnection: Upgrade\r\nUser-agent:fixture-agent\r\n\r\n';

function websocketFrame(opcode, bytes) {
  const prefix = Buffer.alloc(bytes.length < 126 ? 2 : bytes.length < 65536 ? 4 : 10);
  prefix[0] = 0x80 | opcode;
  if (bytes.length < 126) prefix[1] = bytes.length;
  else if (bytes.length < 65536) { prefix[1] = 126; prefix.writeUInt16BE(bytes.length, 2); }
  else { prefix[1] = 127; prefix.writeBigUInt64BE(BigInt(bytes.length), 2); }
  return Buffer.concat([prefix, bytes]);
}

function legacyWebsocketPayloadServer(name, { clientFirst = false, ping = false } = {}) {
  const report = websocketReports[name] = { requests: 0, exactPayload: false, firstBannerFramed: false,
    dataFrames: 0, maskedFrames: 0, pongs: 0 };
  return net.createServer(socket => {
    let received = Buffer.alloc(0);
    let frames = Buffer.alloc(0);
    let target;
    let timer;
    socket.on('error', () => socket.destroy());
    socket.on('close', () => { clearTimeout(timer); target?.destroy(); });
    const openTarget = () => {
      target = net.connect(ssh.address().port, '127.0.0.1');
      target.on('error', () => socket.destroy());
      target.on('data', bytes => socket.write(websocketFrame(2, bytes)));
      target.on('end', () => socket.end());
    };
    const fail = error => {
      console.error('SSH_WS_FIXTURE_FAILED', error.message);
      socket.destroy();
    };
    const readFrames = chunk => {
      try {
        frames = Buffer.concat([frames, chunk]);
        while (frames.length >= 2) {
          assert.equal(frames[0] & 0xf0, 0x80, 'non-final/RSV client frame');
          assert.ok(frames[1] & 0x80, 'SSH banner/data was sent unmasked or raw');
          const opcode = frames[0] & 0x0f;
          assert.ok(opcode === 2 || opcode === 10, 'unexpected client opcode');
          let length = frames[1] & 0x7f;
          let offset = 2;
          if (length === 126) {
            if (frames.length < 4) return;
            length = frames.readUInt16BE(2); offset = 4;
          } else if (length === 127) {
            if (frames.length < 10) return;
            const size = frames.readBigUInt64BE(2);
            assert.ok(size <= 1048576n, 'oversize client frame');
            length = Number(size); offset = 10;
          }
          assert.ok(length <= 1048576 && (opcode !== 10 || length <= 125), 'invalid client frame length');
          if (frames.length < offset + 4 + length) return;
          const mask = frames.subarray(offset, offset + 4);
          const bytes = Buffer.from(frames.subarray(offset + 4, offset + 4 + length));
          for (let i = 0; i < length; i++) bytes[i] ^= mask[i % 4];
          frames = frames.subarray(offset + 4 + length);
          report.maskedFrames++;
          if (opcode === 10) {
            assert.ok(ping && bytes.equals(Buffer.from('fixture-ping')), 'invalid pong');
            report.pongs++;
            continue;
          }
          if (report.dataFrames++ === 0) {
            assert.ok(bytes.toString('latin1').startsWith('SSH-2.0-'), 'first data frame is not the client SSH banner');
            report.firstBannerFramed = true;
          }
          if (!target) openTarget();
          target.write(bytes);
        }
      } catch (error) { fail(error); }
    };
    const readPayload = chunk => {
      try {
        received = Buffer.concat([received, chunk]);
        assert.ok(received.length <= 8192, 'oversize payload');
        const text = received.toString('latin1');
        const parts = text.split('\r\n\r\n');
        if (parts.length < 4) return;
        const size = Buffer.byteLength(parts.slice(0, 3).join('\r\n\r\n') + '\r\n\r\n', 'latin1');
        assert.equal(text.slice(0, size), reportedRequest, 'pipelined headers/tokens were changed');
        assert.equal(received.length, size, 'SSH bytes escaped before HTTP upgrade');
        report.requests += 3;
        report.exactPayload = true;
        socket.off('data', readPayload);
        socket.on('data', readFrames);
        const body = '<html>Method not allowed</html>';
        socket.write('HTTP/1.1 301 Moved Permanently\r\nContent-Length: 0\r\n\r\n' +
          `HTTP/1.1 403 Forbidden\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
        timer = setTimeout(() => {
          if (socket.destroyed) return;
          socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
          if (ping) socket.write(websocketFrame(9, Buffer.from('fixture-ping')));
          if (!clientFirst) openTarget();
        }, 800);
      } catch (error) { fail(error); }
    };
    socket.on('data', readPayload);
    socket.on('end', () => target?.end());
  });
}
const legacyWebsocketPayload = legacyWebsocketPayloadServer('legacyWebsocketPayloadPort');
const clientFirstWebsocketPayload = legacyWebsocketPayloadServer('clientFirstWebsocketPayloadPort', { clientFirst: true });
const pingWebsocketPayload = legacyWebsocketPayloadServer('pingWebsocketPayloadPort', { ping: true });
const websocketReport = net.createServer(socket => socket.end(JSON.stringify(websocketReports)));

function tls13Blackhole(target) {
  return net.createServer(socket => {
    let buffered = Buffer.alloc(0);
    let upstream;
    socket.on('error', () => socket.destroy());
    socket.on('close', () => upstream?.destroy());
    const inspect = chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 5) return;
      const length = buffered.readUInt16BE(3) + 5;
      if (buffered.length < length) return;
      if (buffered[0] !== 22 || buffered[5] !== 1) return socket.destroy();
      let offset = 43;
      offset += 1 + buffered[offset];
      offset += 2 + buffered.readUInt16BE(offset);
      offset += 1 + buffered[offset];
      const end = offset + 2 + buffered.readUInt16BE(offset);
      offset += 2;
      let modern = false;
      while (offset + 4 <= end) {
        const type = buffered.readUInt16BE(offset);
        const size = buffered.readUInt16BE(offset + 2);
        if (type === 43) {
          for (let item = offset + 5; item + 1 < offset + 4 + size; item += 2) {
            if (buffered.readUInt16BE(item) === 0x0304) modern = true;
          }
        }
        offset += 4 + size;
      }
      socket.off('data', inspect);
      if (modern) {
        socket.resume(); // Accept TCP but provide no TLS answer to this ClientHello.
        return;
      }
      socket.pause();
      upstream = net.connect(target.address().port, '127.0.0.1');
      upstream.on('error', () => socket.destroy());
      upstream.once('connect', () => {
        upstream.write(buffered);
        socket.pipe(upstream);
        upstream.pipe(socket);
        socket.resume();
      });
    };
    socket.on('data', inspect);
  });
}

(async () => {
  await listen(download); await listen(greeting); await listen(upload); await listen(uploadReport);
  await listen(ssh); await listen(payload); await listen(delayedPayload); await listen(methodRefusalPayload);
  await listen(preamblePayload);
  await listen(legacyWebsocketPayload); await listen(clientFirstWebsocketPayload);
  await listen(pingWebsocketPayload); await listen(websocketReport);
  const parsedKey = utils.parseKey(key);
  if (parsedKey instanceof Error) throw parsedKey;
  const output = require('esbuild').buildSync({
    entryPoints: [path.resolve(__dirname, '..', '..', 'server', 'services', 'ssh-relay.ts')],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  });
  const gatewayModule = { exports: {} };
  new Function('require', 'module', 'exports', output.outputFiles[0].text)(require, gatewayModule, gatewayModule.exports);
  const gateway = https.createServer({ pfx: readFileSync(process.argv[3]), passphrase: 'synthetic-test-only' });
  let gatewayHeaders = '';
  gatewayModule.exports.installSshRelay(gateway, {
    authorize: async request => {
      gatewayHeaders = JSON.stringify(request.headers);
      if (request.headers.authorization !== 'Bearer synthetic.gateway.ticket' ||
          request.headers['x-sxb-device-id'] !== 'synthetic-device' ||
          request.headers['x-sxb-nonce'] !== 'synthetic-proof' ||
          request.url !== '/api/mobile/ssh-relay?connectionId=11111111-1111-4111-a111-111111111111&configId=synthetic-profile') throw Error('invalid');
      return {
        clientId: 'synthetic-client', expiresAt: Date.now() + 60000,
        upstream: { host: 'upstream.invalid', port: ssh.address().port, username: 'fixture-client', password,
          fingerprint: 'SHA256:' + createHash('sha256').update(parsedKey.getPublicSSH()).digest('base64'),
          tls: false, sni: '', payload: '' },
        revalidate: async () => true, account: async () => {},
      };
    },
    open: async () => { const socket = net.connect(ssh.address().port, '127.0.0.1'); await once(socket, 'connect'); return socket; },
  });
  await listen(gateway);
  const legacyTlsGateway = tls13Blackhole(gateway);
  await listen(legacyTlsGateway);
  const silentTlsGateway = net.createServer(socket => {
    socket.on('error', () => socket.destroy());
    socket.resume();
  });
  await listen(silentTlsGateway);
  const refusedGateway = https.createServer({ pfx: readFileSync(process.argv[3]), passphrase: 'synthetic-test-only' });
  refusedGateway.on('tlsClientError', () => {});
  refusedGateway.on('upgrade', (_request, socket) => {
    socket.on('error', () => socket.destroy());
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  await listen(refusedGateway);
  const gatewayReport = net.createServer(socket => socket.end(gatewayHeaders));
  await listen(gatewayReport);
  writeFileSync(process.argv[2], JSON.stringify({
    sshPort: ssh.address().port, payloadPort: payload.address().port, delayedPayloadPort: delayedPayload.address().port,
    methodRefusalPayloadPort: methodRefusalPayload.address().port,
    preamblePayloadPort: preamblePayload.address().port,
    legacyWebsocketPayloadPort: legacyWebsocketPayload.address().port,
    clientFirstWebsocketPayloadPort: clientFirstWebsocketPayload.address().port,
    pingWebsocketPayloadPort: pingWebsocketPayload.address().port,
    websocketReportPort: websocketReport.address().port,
    downloadPort: download.address().port, greetingPort: greeting.address().port,
    uploadPort: upload.address().port, uploadReportPort: uploadReport.address().port,
    gatewayPort: gateway.address().port, gatewayReportPort: gatewayReport.address().port,
    legacyTlsGatewayPort: legacyTlsGateway.address().port,
    silentTlsGatewayPort: silentTlsGateway.address().port, refusedGatewayPort: refusedGateway.address().port,
    username: 'fixture-client', password, hostKey: parsedKey.getPublicSSH().toString('base64'),
  }), { mode: 0o600 });
})().catch(error => { console.error('SSH_DATA_FIXTURE_START_FAILED', error.message); process.exitCode = 1; });

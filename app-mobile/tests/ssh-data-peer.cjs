const { Server, utils } = require('ssh2');
const net = require('node:net');
const { generateKeyPairSync, randomBytes, createHash } = require('node:crypto');
const { writeFileSync, readFileSync } = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { once } = require('node:events');

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
function delayedPayloadServer(refuseIntermediateMethod = false) {
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
      const body = '<html>Method not allowed</html>';
      const intermediate = refuseIntermediateMethod
        ? `HTTP/1.1 403 Forbidden\r\nContent-Length: ${body.length}\r\n\r\n${body}`
        : 'HTTP/1.1 200 OK\r\n\r\n';
      socket.write('HTTP/1.1 301 Moved Permanently\r\nContent-Length: 0\r\n\r\n' + intermediate);
      const timer = setTimeout(() => {
        if (socket.destroyed) return;
        const target = net.connect(ssh.address().port, '127.0.0.1', () => {
          socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\n\r\n' +
            'HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nbody');
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
    downloadPort: download.address().port, greetingPort: greeting.address().port,
    uploadPort: upload.address().port, uploadReportPort: uploadReport.address().port,
    gatewayPort: gateway.address().port, gatewayReportPort: gatewayReport.address().port,
    legacyTlsGatewayPort: legacyTlsGateway.address().port,
    silentTlsGatewayPort: silentTlsGateway.address().port, refusedGatewayPort: refusedGateway.address().port,
    username: 'fixture-client', password, hostKey: parsedKey.getPublicSSH().toString('base64'),
  }), { mode: 0o600 });
})().catch(error => { console.error('SSH_DATA_FIXTURE_START_FAILED', error.message); process.exitCode = 1; });

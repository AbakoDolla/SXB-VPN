import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(root, 'backend', 'package.json'));
const { Server, Client, utils } = require('ssh2');
const output = await require('esbuild').build({
  stdin: { contents: `
    export * from './server/services/ssh-relay';
    export * from './server/services/ssh-relay-transport';
    export * from './server/services/ssh-relay-ticket';
  `, resolveDir: root, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', output.outputFiles[0].text)(require, mod, mod.exports);
const { installSshRelay, stripRelayHttp, relayUpstream, publicRelayAddress, issueRelayTicket, verifyRelayTicket, relayClientConfig } = mod.exports;
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
const fingerprint = 'SHA256:' + createHash('sha256').update(utils.parseKey(key).getPublicSSH()).digest('base64');
const body = Buffer.alloc(1024 * 1024, 0xa5);
const listen = async server => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
};

async function fixture(t, changes = {}) {
  let passwordSent = 0, upload = 0, accountedUp = 0, accountedDown = 0, valid = true;
  let uploaded;
  const uploadFinished = new Promise(resolve => { uploaded = resolve; });
  const peers = new Set();
  const provider = new Server({ hostKeys: [key] }, client => {
    peers.add(client);
    client.on('close', () => peers.delete(client));
    client.on('error', () => client.end());
    client.on('authentication', auth => {
      if (auth.method === 'password') passwordSent++;
      if (auth.method === 'password' && auth.username === 'synthetic' && auth.password === 'synthetic-only') auth.accept();
      else auth.reject(['password']);
    });
    client.on('tcpip', (accept, reject, destination) => {
      if (destination.destIP === 'refused.test') { reject(); return; }
      const channel = accept();
      channel.allowHalfOpen = true;
      channel.on('error', () => channel.destroy());
      if (destination.destIP === 'upload.test') {
        channel.write('ready', () => channel.eof());
        channel.on('data', bytes => { upload += bytes.length; });
        channel.on('end', () => { uploaded(); channel.close(); });
      } else {
        channel.on('data', () => {});
        channel.on('end', () => {
          channel.write(body, () => { channel.eof(); channel.close(); });
        });
      }
    });
  });
  const port = await listen(provider);
  const httpServer = http.createServer();
  const upstream = {
    host: 'provider.invalid', port, username: 'synthetic', password: 'synthetic-only', fingerprint,
    tls: false, sni: '', payload: '',
  };
  const gateway = installSshRelay(httpServer, {
    authorize: async request => {
      if (request.headers.authorization !== 'Bearer synthetic') throw Error('denied');
      return {
        clientId: changes.multipleClients ? new URL(request.url, 'http://localhost').searchParams.get('fixtureClient') : 'fixture-client',
        upstream: { ...upstream, ...changes.upstream },
        expiresAt: Date.now() + 60000, revalidate: async () => valid,
        account: async (up, down) => {
          await new Promise(resolve => setTimeout(resolve, 1));
          if (changes.quota && accountedUp + accountedDown + up + down > changes.quota) throw Error('quota');
          accountedUp += up; accountedDown += down;
        },
      };
    },
    open: async (_config, signal) => {
      const socket = net.connect(port, '127.0.0.1');
      signal.addEventListener('abort', () => socket.destroy(), { once: true });
      await once(socket, 'connect');
      return socket;
    },
    leaseMs: 30,
  });
  const gatewayPort = await listen(httpServer);
  const connected = new Set();
  t.after(async () => {
    gateway.close();
    for (const client of connected) client.destroy();
    for (const peer of peers) peer.end();
    await Promise.all([new Promise(resolve => httpServer.close(resolve)), new Promise(resolve => provider.close(resolve))]);
  });
  async function connect(clientId = 'fixture-client') {
    const socket = await new Promise((resolve, reject) => {
      const request = http.get({
        hostname: '127.0.0.1', port: gatewayPort,
        path: '/api/mobile/ssh-relay?connectionId=' + randomUUID() + '&fixtureClient=' + encodeURIComponent(clientId),
        headers: { Connection: 'Upgrade', Upgrade: 'sxb-ssh-relay', Authorization: 'Bearer synthetic' },
      });
      request.on('upgrade', (_response, socket, head) => { if (head.length) socket.unshift(head); resolve(socket); });
      request.on('response', response => { response.resume(); reject(Error('refused ' + response.statusCode)); });
      request.on('error', reject);
    });
    const client = new Client();
    connected.add(client);
    client.on('error', () => {});
    client.connect({ sock: socket, username: 'sxb', readyTimeout: 3000 });
    await once(client, 'ready');
    return client;
  }
  return {
    connect, gateway,
    counters: () => ({ passwordSent, upload, accountedUp, accountedDown }),
    uploadFinished,
    revoke: () => { valid = false; },
  };
}

const forward = (client, host) => new Promise((resolve, reject) =>
  client.forwardOut('127.0.0.1', 0, host, 80, (error, channel) => error ? reject(error) : resolve(channel)));

test('different activated clients share one provider without sharing the per-client connection limit', { timeout: 30000 }, async t => {
  const f = await fixture(t, { multipleClients: true });
  const first = await f.connect('client-a');
  await f.connect('client-a');
  await assert.rejects(f.connect('client-a'), /refused 403/);
  const second = await f.connect('client-b');
  const third = await f.connect('client-c');
  for (const client of [first, second, third]) {
    const channel = await forward(client, 'download.test');
    const data = [];
    channel.on('data', bytes => data.push(bytes));
    const ended = once(channel, 'end');
    channel.end('request');
    await ended;
    assert.deepEqual(Buffer.concat(data), body);
  }
  assert.equal(f.counters().passwordSent, 4);
  assert.equal(f.counters().accountedDown, 3 * body.length);
});

test('gateway delivers a full download after upload EOF and meters exactly once', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const client = await f.connect();
  const channel = await forward(client, 'download.test');
  const data = [];
  channel.on('data', bytes => data.push(bytes));
  const ended = once(channel, 'end');
  channel.end('request');
  await ended;
  assert.deepEqual(Buffer.concat(data), body);
  assert.equal(f.counters().accountedUp, 7);
  assert.equal(f.counters().accountedDown, body.length);
  await assert.rejects(forward(client, 'refused.test'));
});

test('remote half-close preserves a full upload', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const channel = await forward(await f.connect(), 'upload.test');
  channel.allowHalfOpen = true;
  const data = [];
  channel.on('data', bytes => data.push(bytes));
  await once(channel, 'end');
  assert.equal(Buffer.concat(data).toString(), 'ready');
  const closed = once(channel, 'close');
  channel.end(body);
  await closed;
  await f.uploadFinished;
  assert.equal(f.counters().upload, body.length);
  assert.equal(f.counters().accountedUp, body.length);
});

test('incorrect provider fingerprint prevents sending its password', { timeout: 10000 }, async t => {
  const f = await fixture(t, { upstream: { fingerprint: 'SHA256:' + Buffer.alloc(32).toString('base64') } });
  await assert.rejects(f.connect());
  assert.equal(f.counters().passwordSent, 0);
});

test('revocation disconnects an idle established gateway', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const client = await f.connect();
  const closed = once(client, 'close');
  f.revoke();
  await closed;
  assert.equal(f.gateway.activeCount(), 0);
});

test('quota denial prevents forwarding unaccounted bytes', { timeout: 10000 }, async t => {
  const f = await fixture(t, { quota: 16 });
  const client = await f.connect();
  const channel = await forward(client, 'upload.test');
  channel.on('error', () => {});
  channel.resume();
  const closed = new Promise(resolve => client.once('close', resolve));
  channel.write(body);
  await closed;
  assert.equal(f.counters().upload, 0);
});

test('dedicated ticket, allowlisted mobile configuration and upstream validation', () => {
  const identity = { userId: 'user', clientId: 'client', deviceId: 'device', sid: 'session', sg: 1,
    kid: 'key', subscriptionId: 'sub', configHash: 'hash' };
  const credential = issueRelayTicket(identity, 'synthetic-secret', Date.now() + 60000);
  assert.equal(verifyRelayTicket(credential.ticket, 'synthetic-secret').clientId, 'client');
  assert.throws(() => verifyRelayTicket(credential.ticket, 'wrong-secret'));
  assert.throws(() => require('jsonwebtoken').verify(credential.ticket, 'synthetic-secret'));
  const mobile = relayClientConfig({ host: 'private.invalid', password: 'secret', payload: 'private', proxyHost: 'hidden' }, 'profile', credential);
  assert.equal(mobile.host, 'sxb-gateway');
  for (const field of ['password', 'payload', 'proxyHost', 'privateKeyBase64']) assert.equal(mobile[field], undefined);
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '100.64.0.1']) assert.equal(publicRelayAddress(address), false);
  assert.equal(publicRelayAddress('8.8.8.8'), true);
  assert.throws(() => relayUpstream({ protocol: 'ssh-arbitrary' }));
  assert.throws(() => relayUpstream({ protocol: 'ssh', host: 'example.test', username: 'synthetic', password: 'synthetic' }));
});

async function parseFacade(t, write, requestCount = 1) {
  const peer = net.createServer(socket => { socket.on('error', () => {}); write(socket); });
  const port = await listen(peer);
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {});
  await once(socket, 'connect');
  t.after(async () => { socket.destroy(); await new Promise(resolve => peer.close(resolve)); });
  await stripRelayHttp(socket, new AbortController().signal, requestCount);
  return socket;
}

test('HTTP chain leaves every SSH banner byte untouched', { timeout: 5000 }, async t => {
  const socket = await parseFacade(t, peer => peer.end(
    'HTTP/1.1 301 Moved\r\nContent-Length: 3\r\n\r\nabc' +
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n' +
    'SSH-2.0-fixture\r\n'));
  assert.equal(socket.read(3).toString(), 'SSH');
});

test('a framed intermediate 403 waits for the later accepted response', { timeout: 5000 }, async t => {
  const socket = await parseFacade(t, peer => {
    peer.write('HTTP/1.1 301 Moved\r\nContent-Length: 0\r\n\r\n' +
      'HTTP/1.1 403 Forbidden\r\nContent-Length: 4\r\n\r\nbody');
    const timer = setTimeout(() => peer.end('HTTP/1.1 101 Switching Protocols\r\n\r\nSSH-2.0-fixture\r\n'), 800);
    peer.on('close', () => clearTimeout(timer));
  }, 3);
  assert.equal(socket.read(3).toString(), 'SSH');
});

test('an error body, a final 403 or a closing connection cannot manufacture a tunnel', { timeout: 5000 }, async t => {
  const ok = 'HTTP/1.1 200 OK\r\n\r\n';
  const banner = 'SSH-2.0-fixture\r\n';
  const fake = ok + banner;
  for (const prefix of [
    ok + ok + 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n' + ok,
    'HTTP/1.1 403 Forbidden\r\n\r\n' + ok,
    'HTTP/1.0 403 Forbidden\r\nContent-Length: 0\r\n\r\n' + ok,
    'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n' + ok,
    `HTTP/1.1 403 Forbidden\r\nContent-Length: ${fake.length}\r\n\r\n${fake}`,
    'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n',
  ]) await assert.rejects(parseFacade(t, peer => peer.end(prefix + banner), 3), /RELAY_HTTP_REJECTED/);
  await assert.rejects(parseFacade(t, peer => peer.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'), 3),
    /RELAY_HTTP_REJECTED/);
  await assert.rejects(parseFacade(t, peer => peer.end(
    'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\n\r\n'), 3), /RELAY_FRAMING_INVALID/);
});

test('client-first SSH is allowed after a successful HTTP facade', { timeout: 5000 }, async t => {
  const socket = await parseFacade(t, peer => {
    peer.write('HTTP/1.1 200 OK\r\n\r\n');
    peer.once('data', () => peer.end('SSH-2.0-client-first\r\n'));
  });
  socket.write('SSH-2.0-test\r\n');
  const chunks = [];
  for await (const chunk of socket) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'SSH-2.0-client-first\r\n');
});

test('truncated or ambiguous HTTP facade is rejected without waiting for timeout', { timeout: 5000 }, async t => {
  await assert.rejects(parseFacade(t, peer => peer.end('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nx')), /TRUNCATED/);
  await assert.rejects(parseFacade(t, peer => peer.end(
    'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\n\r\n')), /FRAMING/);
});

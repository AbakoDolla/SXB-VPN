// Explicit native CI entrypoint. Only loopback sockets and synthetic credentials are used.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import http from 'node:http';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

const binary = process.env.SXB_SINGBOX_TEST_BIN;
const runtimeFile = process.env.SXB_ENGINE_RUNTIME;
const dataDirectory = process.env.SXB_ENGINE_DATA;
assert.ok(binary && runtimeFile && dataDirectory, 'Use the explicit native CI harness; no production endpoint is allowed');
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function listen(server, port = 0) {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}
function dnsQuery(name, id, type = 1) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const encoded = name.split('.').flatMap(label => [Buffer.from([label.length]), Buffer.from(label)]);
  const question = Buffer.alloc(5);
  question.writeUInt16BE(type, 1);
  question.writeUInt16BE(1, 3);
  return Buffer.concat([header, ...encoded, question]);
}
function dnsAnswer(query) {
  assert.equal(query.readUInt16BE(4), 1);
  let questionEnd = 12;
  while (query[questionEnd] !== 0) {
    assert.ok(query[questionEnd] <= 63 && questionEnd < query.length);
    questionEnd += 1 + query[questionEnd];
  }
  questionEnd += 5;
  const type = query.readUInt16BE(questionEnd - 4);
  assert.ok(type === 1 || type === 28);
  const header = Buffer.from(query.subarray(0, 12));
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const address = type === 1 ? Buffer.from([203, 0, 113, 9]) : Buffer.from('20010db8000000000000000000000009', 'hex');
  const answer = Buffer.from([0xc0, 0x0c, 0, type, 0, 1, 0, 0, 0, 60, 0, address.length]);
  return Buffer.concat([header, query.subarray(12, questionEnd), answer, address]);
}
async function receiveDns(port, name, id, type = 1) {
  const socket = dgram.createSocket('udp4');
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error('Loopback DNS query timed out')); }, 4000);
    socket.once('error', error => { clearTimeout(timeout); socket.close(); reject(error); });
    socket.once('message', data => {
      clearTimeout(timeout);
      socket.close();
      resolve(data);
    });
    socket.send(dnsQuery(name, id, type), port, '127.0.0.1');
  });
}

test('the real VLESS/WebSocket/HTTP chain resolves DNS over TCP and carries repeated data streams', { timeout: 45000 }, async t => {
  const runtime = JSON.parse(await readFile(runtimeFile, 'utf8'));
  for (const outbound of runtime.outbounds) {
    assert.ok(!outbound.server || outbound.server.endsWith('.example.test'), 'Never provide a private or real endpoint to this fixture');
  }
  const byTag = new Map(runtime.outbounds.map(outbound => [outbound.tag, outbound]));
  const groupTypes = new Set(['selector', 'urltest']);
  function branches(tag, seen = new Set()) {
    const outbound = byTag.get(tag);
    assert.ok(outbound, `The runtime graph must declare ${tag}`);
    assert.ok(!seen.has(tag), 'The runtime graph must not contain a cycle');
    seen.add(tag);
    if (groupTypes.has(outbound.type)) {
      return outbound.outbounds.flatMap(member => branches(member, new Set(seen)));
    }
    return [outbound];
  }
  const heads = branches(runtime.route.final);
  const upstreams = [];
  for (const head of heads) {
    assert.equal(head.type, 'vless');
    assert.equal(head.transport.type, 'ws');
    assert.equal(head.domain_strategy, undefined, 'A chained head must not pre-resolve its own server domain');
    assert.match(head.server, /\.example\.test$/, 'The chained head must keep its domain, never an address resolved beforehand');
    const upstream = byTag.get(head.detour);
    assert.equal(upstream.type, 'http');
    upstreams.push(upstream);
  }
  const main = heads[0];
  const remote = runtime.dns.servers.find(server => server.tag === runtime.dns.final);
  assert.match(remote.address, /^tcp:\/\//, 'The source-derived native builder must select reliable DNS TCP for the HTTP chain');
  assert.ok([runtime.route.final, ...heads.map(head => head.tag)].includes(remote.detour),
    'DNS must enter the encrypted VLESS head, never the raw HTTP proxy');
  assert.equal(runtime.dns.strategy, undefined, 'Changing DNS transport must not suppress imported AAAA queries');
  assert.equal(runtime.inbounds[0].mtu, 1400, 'The chained mobile TUN must not use a jumbo MTU');
  const blockTags = new Set(runtime.outbounds.filter(outbound => outbound.type === 'block').map(outbound => outbound.tag));
  assert.ok(runtime.route.rules.some(rule =>
    blockTags.has(rule.outbound) &&
    (rule.network === 'udp' || (Array.isArray(rule.network) && rule.network.includes('udp'))) &&
    (rule.port === 443 || (Array.isArray(rule.port) && rule.port.includes(443)))),
  'The provider-requested UDP/443 block must remain in the actual native graph');

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sxb-loopback-chain-'));
  const sockets = new Set();
  const children = [];
  const servers = [];
  const keep = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
  t.after(async () => {
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 2000);
      await closed;
      clearTimeout(force);
    }
    for (const socket of sockets) socket.destroy();
    for (const server of servers) await new Promise(resolve => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });
  let tcpDnsQueries = 0, udpDnsQueries = 0, connectRequests = 0, forbiddenConnects = 0, refusedConnects = 0;
  const acceptedVia = new Set();
  const dns = net.createServer(socket => {
    keep(socket);
    let received = Buffer.alloc(0);
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      while (received.length >= 2 && received.length >= 2 + received.readUInt16BE(0)) {
        const length = received.readUInt16BE(0);
        const query = received.subarray(2, length + 2);
        received = received.subarray(length + 2);
        tcpDnsQueries++;
        const answer = dnsAnswer(query);
        const prefix = Buffer.alloc(2); prefix.writeUInt16BE(answer.length);
        socket.write(Buffer.concat([prefix, answer]));
      }
    });
    socket.on('error', () => {});
  });
  servers.push(dns);
  const dnsPort = await listen(dns);
  const droppedUdp = dgram.createSocket('udp4');
  droppedUdp.on('message', () => { udpDnsQueries++; }); // Deliberately unavailable UDP resolver.
  droppedUdp.bind(dnsPort, '127.0.0.1');
  await once(droppedUdp, 'listening');
  t.after(() => new Promise(resolve => droppedUdp.close(resolve)));
  const vlessPort = await freePort();
  const ingressPort = await freePort();
  const dataIngressPort = await freePort();
  const payload = Buffer.alloc(256 * 1024, 0x53);
  const payloadHash = createHash('sha256').update(payload).digest('hex');
  const dataServer = net.createServer(socket => {
    keep(socket);
    socket.once('data', () => socket.end(payload));
    socket.on('error', () => {});
  });
  servers.push(dataServer);
  const dataPort = await listen(dataServer);
  const upstreamPorts = new Map();
  for (const [index, upstream] of upstreams.entries()) {
    // The first declared upstream is deliberately unavailable, exactly like an operator proxy answering 404.
    const unavailable = index === 0 && upstreams.length > 1;
    const head = heads[index];
    const expectedAuthority = `${head.server}:${head.server_port}`;
    const expectedCanary = upstream.headers?.['X-iorg'];
    const proxy = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
    proxy.on('connect', (request, client, head_) => {
      keep(client);
      connectRequests++;
      if (request.url !== expectedAuthority || request.headers['x-iorg'] !== expectedCanary) {
        forbiddenConnects++;
        client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      if (unavailable) {
        refusedConnects++;
        client.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      acceptedVia.add(upstream.tag);
      const destination = keep(net.connect(vlessPort, '127.0.0.1'));
      destination.on('error', () => client.destroy());
      client.on('error', () => destination.destroy());
      destination.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head_.length) destination.write(head_);
        client.pipe(destination);
        destination.pipe(client);
      });
    });
    servers.push(proxy);
    upstreamPorts.set(upstream.tag, await listen(proxy));
  }
  const keyPath = path.join(temporary, 'fixture.key');
  const certPath = path.join(temporary, 'fixture.crt');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=synthetic.example.test',
  ], { stdio: 'ignore', timeout: 10000 });

  const serverConfig = {
    log: { level: 'error', disabled: false },
    inbounds: [{
      type: 'vless', tag: 'fixture-vless', listen: '127.0.0.1', listen_port: vlessPort,
      users: [...new Set(heads.map(head => head.uuid))].map(uuid => ({ uuid })),
      tls: { enabled: true, certificate_path: certPath, key_path: keyPath },
      transport: { type: 'ws', path: '/stability-fixture' },
    }],
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: { final: 'direct' },
  };
  const clientConfig = structuredClone(runtime);
  clientConfig.log = { level: 'error', disabled: false };
  clientConfig.inbounds = [{
    type: 'direct', tag: 'fixture-dns', listen: '127.0.0.1', listen_port: ingressPort,
    override_address: '192.0.2.53', override_port: 53,
  }, {
    type: 'direct', tag: 'fixture-data', listen: '127.0.0.1', listen_port: dataIngressPort, network: 'tcp',
    override_address: '127.0.0.1', override_port: dataPort,
  }];
  delete clientConfig.route.auto_detect_interface; // No Android platform or TUN in this loopback-only test.
  clientConfig.route.rules.unshift({ inbound: ['fixture-dns'], outbound: 'dns-out' });
  clientConfig.route.rules.unshift({ inbound: ['fixture-data'], outbound: runtime.route.final });
  for (const outbound of clientConfig.outbounds) {
    if (outbound.type === 'http' && upstreamPorts.has(outbound.tag)) {
      outbound.server = '127.0.0.1';
      outbound.server_port = upstreamPorts.get(outbound.tag);
    } else if (outbound.type === 'vless') {
      // The head keeps its domain: the detour must receive it verbatim in CONNECT.
      outbound.transport.path = '/stability-fixture';
      outbound.tls.insecure = true; // Synthetic self-signed certificate; never alters the provider configuration.
    }
  }
  for (const server of clientConfig.dns.servers) {
    if (server.tag === remote.tag) server.address = `tcp://127.0.0.1:${dnsPort}`;
    else if (server.detour === 'direct' && !['fakeip', 'rcode://success'].includes(server.address)) {
      server.address = `tcp://127.0.0.1:${dnsPort}`;
    }
  }
  async function start(config, name, port) {
    const file = path.join(temporary, `${name}.json`);
    await writeFile(file, JSON.stringify(config), { mode: 0o600 });
    const child = spawn(binary, ['run', '-D', dataDirectory, '-c', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-6000); });
    const closed = once(child, 'close').catch(() => {});
    children.push({ child, closed });
    child.on('error', error => { errors += error.message; });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`${name} engine exited: ${errors}`);
      const ready = await new Promise(resolve => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => { socket.destroy(); resolve(false); });
      });
      if (ready) return;
      await wait(50);
    }
    throw new Error(`${name} engine failed to listen: ${errors}`);
  }
  await start(serverConfig, 'vless-server', vlessPort);
  await start(clientConfig, 'client', ingressPort);
  const started = Date.now();
  for (let index = 1; index <= 5; index++) {
    const response = await receiveDns(ingressPort, `query${index}.example.test`, index);
    assert.equal(response.readUInt16BE(0), index);
    assert.equal(response.readUInt16BE(2) & 0x000f, 0);
    assert.equal(response.readUInt16BE(6), 1);
    assert.deepEqual([...response.subarray(-4)], [203, 0, 113, 9]);
  }
  const ipv6 = await receiveDns(ingressPort, 'ipv6.example.test', 6, 28);
  assert.equal(ipv6.readUInt16BE(0), 6);
  assert.equal(ipv6.readUInt16BE(2) & 0x000f, 0);
  assert.equal(ipv6.readUInt16BE(6), 1);
  assert.equal(ipv6.subarray(-16).toString('hex'), '20010db8000000000000000000000009');
  for (let index = 0; index < 3; index++) {
    const data = await new Promise((resolve, reject) => {
      const socket = keep(net.connect(dataIngressPort, '127.0.0.1'));
      const chunks = [];
      socket.once('connect', () => socket.write('fixture-data'));
      socket.setTimeout(4000, () => socket.destroy(new Error('Loopback data stream timeout')));
      socket.on('data', chunk => chunks.push(chunk));
      socket.once('error', reject);
      socket.once('end', () => resolve(Buffer.concat(chunks)));
    });
    assert.equal(data.length, payload.length);
    assert.equal(createHash('sha256').update(data).digest('hex'), payloadHash);
  }
  assert.ok(tcpDnsQueries >= 6);
  assert.equal(udpDnsQueries, 0, 'The unreliable upstream UDP DNS path must not be attempted');
  assert.ok(connectRequests >= 1);
  assert.equal(forbiddenConnects, 0, 'The proxy sees only the VLESS endpoint domain and the declared headers');
  if (upstreams.length > 1) {
    assert.ok(refusedConnects >= 1, 'The unavailable first declared upstream must actually be attempted');
    assert.ok(acceptedVia.size >= 1 && !acceptedVia.has(upstreams[0].tag),
      'DNS and data must keep working through another upstream declared by the same configuration');
  }
  console.log(`Loopback-only proof: six A/AAAA DNS responses and three intact 256KiB streams in ${Date.now() - started}ms over VLESS/WS/TLS/HTTP; not a carrier-speed measurement.`);
});

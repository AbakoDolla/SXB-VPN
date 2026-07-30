/**
 * transport-probe.test.mjs — Préflight honnête testé contre des PASSERELLES
 * SIMULÉES (mission §8.2) : faux SSH (bannière), serveur silencieux, WS→SSH,
 * HTTP inattendu, TLS, TCP refusé. Aucun serveur externe n'est sollicité.
 *
 * Exécution : node --experimental-strip-types scripts/tests/transport-probe.test.mjs
 */
import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, '../../backend');
const probe = await import(path.join(BACKEND, 'server/services/transport-probe.ts'));
const { probeConfig, substitutePayload } = probe;

let passed = 0;
const ok = (m) => { passed++; console.log(`  ✅ ${m}`); };
const servers = [];
process.on('exit', () => servers.forEach(s => { try { s.close(); } catch {} }));

async function listen(server) {
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  servers.push(server);
  return server.address().port;
}

console.log('\n══ transport-probe — préflight contre passerelles simulées ══\n');

// 0. Substitutions payload
{
  const out = substitutePayload('GET / HTTP/1.1[crlf]Host: [host][crlf]X: [ua][crlf][crlf]',
    'h.example.com', 'sni.example.net');
  assert.ok(out.includes('Host: sni.example.net'), 'SNI prioritaire sur host');
  assert.ok(out.includes('\r\n') && !out.includes('[crlf]'), 'CRLF substitué');
  assert.ok(!out.includes('[ua]'), 'ua substitué');
  ok('substitutions [crlf]/[host] (SNI prioritaire)/[ua]');
}

// 1. Faux serveur SSH (bannière immédiate)
{
  const srv = net.createServer((s) => { s.write('SSH-2.0-OpenSSH_9.6p1 Test\r\n'); s.end(); });
  const port = await listen(srv);
  const r = await probeConfig({ protocol: 'ssh', host: '127.0.0.1', port, tls: false, username: 'u', password: 'p' });
  assert.equal(r.verdict, 'transport_ok', JSON.stringify(r.steps));
  assert.ok(r.steps.some(s => s.event === 'DNS_RESOLVED' && s.ok));
  assert.ok(r.steps.some(s => s.event === 'TCP_CONNECTED' && s.ok));
  assert.ok(r.steps.some(s => s.event === 'LATENCY_MS'));
  assert.ok(r.steps.some(s => s.event === 'SSH_BANNER_RECEIVED' && /OpenSSH_9\.6p1/.test(s.detail)));
  ok('SSH direct + bannière → DNS_RESOLVED/TCP_CONNECTED/LATENCY_MS/SSH_BANNER_RECEIVED → transport_ok');
}

// 2. Serveur SILENCIEUX (double attente — reproduction du timeout APK #165)
{
  const srv = net.createServer((s) => { s.on('data', () => {}); }); // accepte, ne dit rien
  const port = await listen(srv);
  const r = await probeConfig({ protocol: 'ssh', host: '127.0.0.1', port, tls: false, username: 'u', password: 'p' }, { timeoutMs: 1200 });
  assert.equal(r.verdict, 'unreachable_from_probe');
  assert.ok(r.steps.some(s => s.event === 'SSH_BANNER_MISSING' && !s.ok));
  assert.ok(/WebSocket|TLS/.test(r.hint), `hint doit proposer WS/TLS : ${r.hint}`);
  ok('serveur silencieux → SSH_BANNER_MISSING + hint WS/TLS (le défaut du profil mikosi détecté à l\'import)');
}

// 3. WS → 101 → trame WS contenant la bannière SSH (le vrai mécanisme mikosi)
{
  const banner = Buffer.from('SSH-2.0-BugSleuth_0.1.9\r\n');
  const frame = Buffer.concat([
    Buffer.from([0x82, banner.length]), // FIN + opcode binaire, pas de masque (serveur→client)
    banner,
  ]);
  const srv = net.createServer((s) => {
    let buf = Buffer.alloc(0);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.includes('\r\n\r\n')) {
        s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: czX0test==\r\n\r\n');
        s.write(frame);
        s.end();
      }
    });
  });
  const port = await listen(srv);
  const payload = 'GET / HTTP/1.1[crlf]Host: [host][crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf][crlf]';
  const r = await probeConfig({ protocol: 'ssh+payload', host: '127.0.0.1', port, tls: false, username: 'u', password: 'p', payload });
  assert.equal(r.verdict, 'transport_ok', JSON.stringify(r.steps));
  assert.ok(r.steps.some(s => s.event === 'HTTP_STATUS_101' && s.ok));
  assert.ok(r.steps.some(s => s.event === 'SSH_BANNER_RECEIVED' && /BugSleuth/.test(s.detail)));
  ok('WS→101→SSH : HTTP_STATUS_101 + SSH_BANNER_RECEIVED derrière tunnel → transport_ok');
}

// 4. Réponse HTTP inattendue (200 au lieu de 101)
{
  const srv = net.createServer((s) => {
    s.on('data', () => { s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'); /* reste ouvert */
      s.on('data', () => {}); });
  });
  const port = await listen(srv);
  const payload = 'GET / HTTP/1.1[crlf]Host: [host][crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf][crlf]';
  const r = await probeConfig({ protocol: 'ssh+payload', host: '127.0.0.1', port, tls: false, username: 'u', password: 'p', payload }, { timeoutMs: 1200 });
  assert.ok(r.steps.some(s => s.event === 'HTTP_STATUS_200' && s.ok), JSON.stringify(r.steps));
  assert.ok(r.steps.some(s => s.event === 'SSH_BANNER_MISSING' && !s.ok));
  assert.notEqual(r.verdict, 'transport_ok');
  ok('HTTP 200 sans flux SSH → HTTP_STATUS_200 + SSH_BANNER_MISSING, pas transport_ok');
}

// 5. TLS — certificat auto-signé → handshake OK + CN rapporté
{
  const dir = '/tmp/sxb-tls-test';
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(`${dir}/key.pem`)) {
    execSync(`openssl req -x509 -newkey rsa:2048 -keyout ${dir}/key.pem -out ${dir}/crt.pem -days 2 -nodes -subj "/CN=test.sxb.local"`, { stdio: 'pipe' });
  }
  const srv = tls.createServer(
    { key: fs.readFileSync(`${dir}/key.pem`), cert: fs.readFileSync(`${dir}/crt.pem`) },
    (s) => { s.write('SSH-2.0-OpenSSH_TLS_Test\r\n'); s.end(); },
  );
  const port = await listen(srv);
  const payload = 'GET / HTTP/1.1[crlf]Host: [host][crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf][crlf]';
  // ssh+payload + tls:true → TLS handshake puis payload (ici le serveur répond SSH brut après TLS)
  const r = await probeConfig({ protocol: 'ssh+payload', host: '127.0.0.1', port, tls: true, sni: 'test.sxb.local', username: 'u', password: 'p', payload }, { timeoutMs: 4000 });
  assert.ok(r.steps.some(s => s.event === 'TLS_HANDSHAKE_OK' && s.ok), JSON.stringify(r.steps));
  assert.ok(/test\.sxb\.local/.test(r.steps.find(s => s.event === 'TLS_HANDSHAKE_OK').detail));
  ok('ssh+payload + tls → TLS_HANDSHAKE_OK (CN rapporté, chaîne auto-signée tolérée en sonde)');
}

// 6. TCP refusé → unreachable_from_probe (≠ invalid)
{
  const srv = net.createServer(); const port = await listen(srv); srv.close();
  await new Promise(r => setTimeout(r, 100));
  const r = await probeConfig({ protocol: 'ssh', host: '127.0.0.1', port, tls: false, username: 'u', password: 'p' }, { timeoutMs: 1200 });
  assert.equal(r.verdict, 'unreachable_from_probe');
  assert.ok(r.steps.some(s => s.event === 'TCP_CONNECTED' && !s.ok));
  ok('TCP refusé → unreachable_from_probe distinct de invalid (géo-restreinte possible)');
}

// 7. DNS introuvable → unreachable_from_probe
{
  const r = await probeConfig({ protocol: 'ssh', host: 'inexistant.invalid', port: 22, tls: false, username: 'u', password: 'p' }, { timeoutMs: 2500 });
  assert.equal(r.verdict, 'unreachable_from_probe');
  assert.ok(r.steps.some(s => s.event === 'DNS_RESOLVED' && !s.ok));
  ok('DNS échec → unreachable_from_probe');
}

// 8. Rejets métier sans aucun paquet : ssh+tls direct ; protocol unsupported ≠ erreur
{
  const r1 = await probeConfig({ protocol: 'ssh', host: '127.0.0.1', port: 1, tls: true, username: 'u', password: 'p' });
  assert.equal(r1.verdict, 'invalid');
  const r2 = await probeConfig({ protocol: 'vless', host: 'h', port: 443, uuid: 'x' });
  assert.equal(r2.verdict, 'unsupported');
  ok('ssh+tls direct = invalid immédiat ; vless = unsupported (validation syntaxique seule, honnête)');
}

console.log(`\n🏁 RÉSULTAT : ${passed} groupes de tests réussis — préflight transport validé\n`);
// Fermeture explicite des passerelles simulées (elles resteraient en écoute et
// empêcheraient le process de quitter) puis sortie propre.
servers.forEach(s => { try { s.close(); } catch {} });
process.exit(0);

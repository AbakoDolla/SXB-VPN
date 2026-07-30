/**
 * canonical-config.test.mjs — Tests unitaires du service canonique SXB
 * Exécution : node --experimental-strip-types scripts/tests/canonical-config.test.mjs
 */
import { strict as assert } from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, '../../backend');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'e2e-encryption-key-32-bytes-pad!';

const svc = await import(path.join(BACKEND, 'server/services/canonical-config.ts'));
const {
  parseImportedConfig, normalizeCanonical, computeCanonicalHash,
  encryptCanonical, decryptCanonical, validateTransportCoherence, canonicalJson,
} = svc;

let passed = 0;
const ok = (m) => { passed++; console.log(`  ✅ ${m}`); };

console.log('\n══ canonical-config — parse, normalisation, hash, chiffrement ══\n');

// 1. URI vless complète
{
  const r = parseImportedConfig('vless://3d6f34b0-9d2e-4e4b-8f2e-0a1b2c3d4e5f@cdn.example.net:8443?security=tls&sni=cdn.example.net&type=ws&path=%2Fcdn&host=cdn.example.net&fp=chrome#Ma%20Config');
  assert.equal(r.ok, true, r.errors.join('|'));
  assert.equal(r.sourceFormat, 'vless-uri');
  assert.equal(r.canonical.protocol, 'vless');
  assert.equal(r.canonical.host, 'cdn.example.net');
  assert.equal(r.canonical.port, 8443);
  assert.equal(r.canonical.tls, true);
  assert.equal(r.canonical.network, 'ws');
  assert.equal(r.canonical.path, '/cdn');
  assert.equal(r.displayName, 'Ma Config');
  ok('vless-uri → canonique complet (uuid/host/port/tls/sni/ws/path/nom)');
}

// 2. JSON ssh+payload explicite (reproduction du cas réel mikosi)
{
  const r = parseImportedConfig(JSON.stringify({
    protocol: 'ssh+payload', host: 'node05.mikosi.fr.eu.org', port: 443,
    username: 'user1', password: 'pass1', tls: false,
    payload: 'GET / HTTP/1.1[crlf]Host: yamo.mtn.cm[crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf][crlf]',
  }));
  assert.equal(r.ok, true, r.errors.join('|'));
  assert.equal(r.sourceFormat, 'ssh+payload-json');
  assert.equal(r.canonical.tls, false);
  ok('ssh+payload-json (ws clair :443, tls=false) accepté — le bon profil mikosi');
}

// 3. REJET ssh direct + tls:true (règle de l'incident)
{
  const r = parseImportedConfig(JSON.stringify({
    protocol: 'ssh', host: 'node05.mikosi.fr.eu.org', port: 443,
    username: 'user1', password: 'pass1', tls: true, sni: 'yamo.mtn.cm',
  }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /tls=true.*SSH direct|SSH direct.*tls=true/is.test(e) || /Combinaison impossible/.test(e)),
    `message de rejet clair attendu, reçu: ${r.errors.join('|')}`);
  ok('ssh + tls:true REJETÉ à l\'import avec message explicite (mission: rejet, pas d\'implémentation)');
}

// 4. Hash déterministe — ordre des clés sans effet
{
  const a = computeCanonicalHash({ b: 2, a: { d: 4, c: 3 }, arr: [1, 2] });
  const b = computeCanonicalHash({ arr: [1, 2], a: { c: 3, d: 4 }, b: 2 });
  const c = computeCanonicalHash({ b: 2, a: { d: 4, c: 3 }, arr: [2, 1] });
  assert.equal(a, b, 'hash stable quel que soit l\'ordre des clés');
  assert.notEqual(a, c, 'ordre des tableaux = sémantique → hash différent');
  assert.match(a, /^[0-9a-f]{64}$/);
  ok('hash sha256 déterministe (clés triées, ordre des tableaux significatif)');
}

// 5. Chiffrement GCM roundtrip (aucune valeur en clair)
{
  const secret = JSON.stringify({ password: 'MotDePasse$ecret!', uuid: 'x' });
  const blob = encryptCanonical(secret);
  assert.ok(blob.startsWith('gcm:'), 'préfixe gcm:');
  assert.ok(!blob.includes('MotDePasse'), 'aucun clair dans le blob');
  assert.equal(decryptCanonical(blob), secret);
  assert.equal(decryptCanonical('gcm:zz:zz:zz'), null);
  ok('AES-256-GCM roundtrip exact, blob sans clair, blob invalide → null');
}

// 6. vmess base64 + ss moderne + wireguard conf
{
  const vmessJson = JSON.stringify({ v: '2', ps: 'Test VMess', add: 'h.example.com', port: '443', id: '3d6f34b0-9d2e-4e4b-8f2e-0a1b2c3d4e5f', aid: '0', scy: 'auto', net: 'ws', type: 'none', host: 'cdn.example.com', path: '/vm', tls: 'tls', sni: 'cdn.example.com' });
  const r1 = parseImportedConfig('vmess://' + Buffer.from(vmessJson).toString('base64'));
  assert.equal(r1.ok, true, r1.errors.join('|'));
  assert.equal(r1.canonical.tls, true);
  assert.equal(r1.canonical.path, '/vm');

  const r2 = parseImportedConfig('ss://YWVzLTI1Ni1nY206cGFzcw@1.2.3.4:8388#SS%20Test');
  assert.equal(r2.ok, true, r2.errors.join('|'));
  assert.equal(r2.canonical.method, 'aes-256-gcm');
  assert.equal(r2.canonical.host, '1.2.3.4');

  const wg = `[Interface]\nPrivateKey = AAAAprivate\nAddress = 10.0.0.2/32\nDNS = 1.1.1.1\n\n[Peer]\nPublicKey = BBBBpublic\nEndpoint = wg.example.com:51820\nAllowedIPs = 0.0.0.0/0\nPersistentKeepalive = 25`;
  const r3 = parseImportedConfig(wg);
  assert.equal(r3.ok, true, r3.errors.join('|'));
  assert.equal(r3.sourceFormat, 'wireguard-conf');
  assert.equal(r3.canonical.endpoint, 'wg.example.com:51820');
  assert.equal(r3.canonical.persistentKeepalive, 25);
  ok('vmess-uri, ss-uri, wireguard-conf → canoniques valides');
}

// 7. sing-box JSON natif (passthrough outbounds) + trojan par défaut TLS
{
  const r1 = parseImportedConfig(JSON.stringify({ outbounds: [{ type: 'vless', server: 'h', server_port: 443 }] }));
  assert.equal(r1.ok, true, r1.errors.join('|'));
  assert.equal(r1.canonical.protocol, 'singbox');
  assert.ok(Array.isArray(r1.canonical.outbounds));

  const r2 = parseImportedConfig('trojan://p4ss@t.example.com:443?sni=t.example.com');
  assert.equal(r2.ok, true, r2.errors.join('|'));
  assert.equal(r2.canonical.tls, true, 'trojan = TLS par nature');
  ok('singbox-json passthrough + trojan tls par défaut');
}

// 8. false explicite vs undefined dans le canonique (fidelity case 8.1)
{
  const norm = normalizeCanonical({ tls: false, port: 0, sni: '', keep: null });
  assert.equal(norm.tls, false, 'false conservé');
  assert.equal(norm.port, 0, 'zéro conservé');
  assert.equal(norm.sni, '', 'chaîne vide conservée');
  assert.equal(norm.keep, null, 'null conservé');
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}', 'undefined = absent');
  ok('false/0/\'\'/null conservés au canonique ; undefined = absent');
}

// 9. Chaînes légitimes : Unicode, CRLF dans payload, URL encodées
{
  const payload = 'GET /héhé☕ HTTP/1.1[crlf]Host: 例え.jp[crlf][crlf]';
  const r = parseImportedConfig(JSON.stringify({ protocol: 'ssh+payload', host: 'h', port: 443, username: 'u', password: 'p', tls: false, payload }));
  assert.equal(r.ok, true, r.errors.join('|'));
  const blob = encryptCanonical(canonicalJson(r.canonical));
  const restored = JSON.parse(decryptCanonical(blob));
  assert.equal(restored.payload, payload, 'payload Unicode/CRLF intact à l\'octet');
  assert.equal(computeCanonicalHash(restored), computeCanonicalHash(r.canonical));
  ok('Unicode/CRLF/encodages : fidélité octet-pour-octet + hash stable');
}

// 10. Erreurs claires : URI malformée, JSON non-objet, protocole inconnu
{
  assert.equal(parseImportedConfig('vless://pas-assise').ok, false);
  assert.equal(parseImportedConfig('[1,2]').ok, false);
  assert.equal(parseImportedConfig('{"protocol":"carrier-pigeon"}').ok, false);
  assert.equal(parseImportedConfig('').ok, false);
  const r = parseImportedConfig('{"protocol":"ssh","host":"h","port":22,"username":"u"}');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /password|privateKeyBase64/.test(e)));
  ok('rejets propres : URI invalide, JSON non-objet, protocole inconnu, credentials manquants');
}

console.log(`\n🏁 RÉSULTAT : ${passed} groupes de tests réussis — service canonique validé\n`);

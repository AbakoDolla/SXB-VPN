/**
 * mirror-parity.test.mjs — Anti-divergence + fidélité §8.1
 * ═══════════════════════════════════════════════════════════════════════════
 * A. SOURCE DE PRODUCTION : le build doit partir de server.ts + server/.
 *    Seuls le schéma Prisma et le fichier SQL manuel ont un miroir backend/,
 *    car le client Prisma déployé est généré depuis backend/prisma.
 *
 * B. FIDÉLITÉ §8.1 MULTI-PROTOCOLES : pour chaque format d'import, la config
 *    moteur restituée (canonical → chiffré → déchiffré → engine) doit être
 *    TECHNIQUEMENT IDENTIQUE à l'import (deepEqual), hors allowlist
 *    métadonnées. Le hash déterministe doit être stable.
 *
 * Exécution : node --experimental-strip-types scripts/tests/mirror-parity.test.mjs
 */
import './register-hooks.mjs';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

process.env.NODE_ENV = 'test';
process.env.ENCRYPTION_KEY = 'e2e-encryption-key-32-bytes-pad!';

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✅ ${msg}`); };

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n══ A. SOURCE DE PRODUCTION + MIROIRS PRISMA ══\n');
{
  const entry = fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf8');
  const deployWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy-vps.yml'), 'utf8');
  assert.match(entry, /from ["']\.\/server\//, 'server.ts doit charger le serveur racine');
  assert.match(deployWorkflow, /\$ESBUILD server\.ts/, 'le déploiement doit compiler server.ts');
  ok('server.ts + server/ sont l’unique source du backend de production');

  for (const top of ['prisma/schema.prisma', 'prisma/migrations_manual.sql']) {
    const a = path.join(ROOT, top);
    const b = path.join(ROOT, 'backend', top);
    assert.ok(fs.existsSync(a) && fs.existsSync(b), `${top} et son miroir backend/ sont requis`);
    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(a)).digest('hex'),
      crypto.createHash('sha256').update(fs.readFileSync(b)).digest('hex'),
      `${top} diverge de son miroir backend/`,
    );
  }
  ok('schéma Prisma + migrations_manual.sql ≡ miroirs backend/');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n══ B. FIDÉLITÉ §8.1 — import → canonique chiffré → moteur (multi-protocoles) ══\n');

const {
  parseImportedConfig, canonicalJson, computeCanonicalHash,
  encryptCanonical, decryptCanonical, engineConfigFromCanonical,
  validateTransportCoherence,
} = await import(pathToFileURL(path.join(ROOT, 'server/services/canonical-config.ts')).href);

const ALLOWLIST_META = new Set(['displayProtocol', 'profileId', 'profileName', 'configId',
  'subscriptionId', 'dataToken', 'configVersion', 'configHash', 'signature']);

function fidelityRoundtrip(label, raw) {
  const parsed = parseImportedConfig(raw);
  assert.ok(parsed.ok, `${label} — parse KO : ${(parsed.errors || []).join(' | ')}`);
  const canonical = parsed.canonical;

  // Hash déterministe stable (deux calculs = même hash)
  const h1 = computeCanonicalHash(canonical);
  const h2 = computeCanonicalHash(canonical);
  assert.equal(h1, h2, `${label} — hash non déterministe`);
  assert.match(h1, /^[0-9a-f]{64}$/, `${label} — hash non sha256`);

  // Stockage chiffré : JAMAIS de clair
  const blob = encryptCanonical(canonicalJson(canonical));
  assert.ok(blob.startsWith('gcm:'), `${label} — blob non GCM`);
  assert.ok(!blob.includes(canonical.host), `${label} — host EN CLAIR dans le blob !`);

  // Chaîne provisionnement : déchiffrement → parse → moteur
  const plain = decryptCanonical(blob);
  assert.ok(plain, `${label} — déchiffrement KO`);
  const back = JSON.parse(plain);
  assert.equal(computeCanonicalHash(back), h1, `${label} — hash altéré après stockage (non-altération)`);

  const engine = engineConfigFromCanonical(back);
  // Fidélité §8.1 : chaque champ technique de l'import est restitué à l'identique
  for (const [k, v] of Object.entries(canonical)) {
    assert.deepEqual(engine[k], v, `${label} — champ "${k}" altéré (${JSON.stringify(engine[k])} ≠ ${JSON.stringify(v)})`);
  }
  // Aucun champ étranger (hors allowlist)
  const intrus = Object.keys(engine).filter(k => !(k in canonical) && !ALLOWLIST_META.has(k));
  assert.deepEqual(intrus, [], `${label} — champs étrangers injectés : ${intrus.join(', ')}`);
  // Cohérence transport : pas d'erreur sur les formats valides (warnings ok)
  const coh = validateTransportCoherence(canonical);
  assert.deepEqual(coh.errors, [], `${label} — incohérence transport : ${coh.errors.join(' | ')}`);
  return { canonical, hash: h1 };
}

{
  fidelityRoundtrip('SSH+Payload JSON (cas incident, transport correct)',
    JSON.stringify({
      protocol: 'ssh+payload', host: 'node05.mikosi.fr.eu.org', port: 443,
      username: 'evans', password: 's3cret!', tls: false,
      sni: 'yamo.mtn.cm',
      payload: 'GET / HTTP/1.1[crlf]Host: [host][crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf][crlf]',
    }));
  ok('SSH+Payload JSON — restitué à l\'identique (payload, sni, tls=false exacts)');
}

{
  fidelityRoundtrip('vless:// URI (TLS + WS + flow)',
    'vless://3d6f34b0-9d2e-4e4b-8f2e-0a1b2c3d4e5f@cdn.example.net:8443' +
    '?security=tls&sni=cdn.example.net&type=ws&path=%2Fcdn&flow=xtls-rprx-vision#Profil%20VLESS');
  ok('vless:// — restitué à l\'identique (uuid, network, path, tls, sni, flow)');
}

{
  const vmess = Buffer.from(JSON.stringify({
    v: '2', ps: 'Profil VMess', add: 'vm.example.com', port: '443',
    id: 'b831381d-6324-4d53-ad4f-8cda48b30811', aid: '0', scy: 'auto',
    net: 'ws', type: 'none', host: 'vm.example.com', path: '/ray', tls: 'tls', sni: 'vm.example.com',
  })).toString('base64');
  fidelityRoundtrip('vmess:// base64', `vmess://${vmess}`);
  ok('vmess:// — restitué à l\'identique (uuid, host, path, tls)');
}

{
  fidelityRoundtrip('trojan:// URI',
    'trojan://MotDePasseFort42@tr.example.com:443?security=tls&sni=tr.example.com&type=tcp#ProfilTrojan');
  ok('trojan:// — restitué à l\'identique (password, sni)');
}

{
  const ss = 'ss://' + Buffer.from('aes-256-gcm:pass123@ss.example.com:8388').toString('base64') + '#ProfilSS';
  fidelityRoundtrip('ss:// (SIP002)', ss);
  ok('ss:// — restitué à l\'identique (method, password, port)');
}

{
  fidelityRoundtrip('sing-box JSON natif',
    JSON.stringify({
      outbounds: [{
        type: 'vless', tag: 'proxy', server: 'sb.example.com', server_port: 443,
        uuid: '3d6f34b0-9d2e-4e4b-8f2e-0a1b2c3d4e5f',
        tls: { enabled: true, server_name: 'sb.example.com' },
        transport: { type: 'ws', path: '/ws' },
      }],
      inbounds: [{ type: 'tun' }],
    }));
  ok('sing-box JSON — restitué à l\'identique (outbounds complets)');
}

// SSH direct encapsulé dans TLS (« SSL Tunnel ») — pris en charge par le moteur
{
  const parsed = parseImportedConfig(JSON.stringify({
    protocol: 'ssh', host: 'node05.mikosi.fr.eu.org', port: 443,
    username: 'evans', password: 'x', tls: true, sni: 'yamo.mtn.cm',
  }));
  const coh = validateTransportCoherence(parsed.canonical || {});
  assert.ok(parsed.ok, (parsed.errors || []).join('|'));
  assert.equal(coh.errors.length, 0, coh.errors.join('|'));
  assert.equal(parsed.canonical.tls, true);
  assert.equal(parsed.canonical.sni, 'yamo.mtn.cm');
  ok('SSH direct + TLS conservé comme SSL Tunnel (cas exact du profil « Evans new »)');
}

// ssh + tls:false (SSH direct légitime) reste PARFAITEMENT valide
{
  const parsed = parseImportedConfig(JSON.stringify({
    protocol: 'ssh', host: 'vps.example.com', port: 22,
    username: 'ubuntu', password: 'x', tls: false,
  }));
  assert.ok(parsed.ok, 'ssh direct tls:false KO : ' + (parsed.errors || []).join('|'));
  const coh = validateTransportCoherence(parsed.canonical);
  assert.deepEqual(coh.errors, []);
  ok('CONTRÔLE — ssh direct tls:false reste valide');
}

console.log(`\n🏁 RÉSULTAT : ${passed} groupes de tests réussis — source de production et fidélité §8.1 verrouillées`);

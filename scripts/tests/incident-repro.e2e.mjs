/**
 * incident-repro.e2e.mjs — TESTS ROUGES de reproduction de l'incident APK #165
 * ══════════════════════════════════════════════════════════════════════════════
 * Mission SXB — étape 8 : prouver par des tests AVANT la refonte les 5 défauts :
 *   1. mergeConfigs écrase `false`/null/'' explicites (fusion destructive)
 *   2. Les sources non provisionnées peuvent modifier les champs techniques
 *   3. `payload:null` sérialisé → chaîne "null" côté natif Android (AOSP
 *      JSONObject.optString(name, fallback) : NULL.toString() == "null")
 *   4. Transport incohérent « SSH direct + TLS » non rejeté (tls ignoré par
 *      le moteur natif en SSH direct — voir SxbVpnService.kt l.447-457)
 *   5. jsonConfig ignoré par /provision/activate + aucun configVersion/configHash
 *
 * Exécution (depuis la racine du dépôt, après :
 *   cd backend && npm install --legacy-peer-deps --no-audit
 *   cd ../app-mobile && npm ci --legacy-peer-deps --no-audit) :
 *     node --experimental-strip-types scripts/tests/incident-repro.e2e.mjs
 *
 * ATTENDU AUJOURD'HUI : la suite ÉCHOUE (rouge). Elle deviendra verte après la
 * refonte « dashboard intermédiaire uniquement » (modèle canonique chiffré,
 * allowlist de fusion, configVersion/configHash, validation transport).
 */
import { strict as assert } from 'node:assert';
import { randomBytes, createCipheriv, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT    = path.resolve(__dirname, '../..');
const BACKEND = path.join(ROOT, 'backend');
const MOBILE  = path.join(ROOT, 'app-mobile');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'e2e-jwt-secret';
process.env.REFRESH_SECRET = 'e2e-refresh-secret';
process.env.PROVISION_SECRET = 'e2e-provision-secret';
process.env.ENCRYPTION_KEY = 'e2e-encryption-key-32-bytes-pad!';

// ── Collecteur rouge/vert (la suite doit pouvoir TOUT montrer) ──────────────
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✅ VERT  — ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message });
    console.log(`  🔴 ROUGE — ${name}\n             ↳ ${e.message}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ SECTION 1 — Fusion sûre (modèle « intermédiaire », configValidator.ts) ══\n');
//
// Historique : mergeConfigs (correctif PR #8) restaurait false/null/'' depuis
// l\'ancien cache et laissait des sources non provisionnées toucher la technique.
// Ces appels fusion-partielle ont DISPARU du produit : le provisionné est la
// SEULE source technique (mergeProvisionedConfig) et les sources de métadonnées
// passent par une allowlist stricte (mergeConnectionMetadata). Ces fonctions
// N\'EXISTENT PAS dans le code d\'avant la refonte → imports undefined → ROUGE.

const { mergeProvisionedConfig, mergeConnectionMetadata, validateVpnConfig } =
  await import(path.join(MOBILE, 'services/configValidator.ts'));

await check('S1.1 — tls:false EXPLICITE du provisionné prévaut (jamais restauré tls:true du cache)', () => {
  if (typeof mergeProvisionedConfig !== 'function') {
    throw new Error('mergeProvisionedConfig inexistante — ancienne mergeConfigs destructive toujours en place');
  }
  const old = { protocol: 'ssh', host: 'h', port: 443, username: 'u', password: 'p', tls: true };
  const fresh = { protocol: 'ssh', host: 'h', port: 443, username: 'u', password: 'p', tls: false };
  const merged = mergeProvisionedConfig(old, fresh);
  assert.equal(merged.tls, false,
    `tls:false explicite du provisionné a été écrasé par l'ancien tls:true (merged.tls=${merged.tls})`);
});

await check("S1.2 — payload ABSENT du provisionné (suppression) n'est jamais restauré depuis l'ancien cache", () => {
  if (typeof mergeProvisionedConfig !== 'function') {
    throw new Error('mergeProvisionedConfig inexistante');
  }
  const old = { protocol: 'ssh+payload', host: 'h', port: 443, username: 'u', password: 'p', payload: 'GET / [crlf]' };
  const fresh = { protocol: 'ssh', host: 'h', port: 22, username: 'u', password: 'p' };
  const merged = mergeProvisionedConfig(old, fresh);
  assert.equal(merged.payload ?? null, null,
    `l'ancien payload a été restauré dans la config fusionnée (${JSON.stringify(merged.payload)})`);
  assert.equal(merged.protocol, 'ssh');
});

await check("S1.3 — sni ABSENT du provisionné n'est pas restauré (suppression SNI effective)", () => {
  if (typeof mergeProvisionedConfig !== 'function') {
    throw new Error('mergeProvisionedConfig inexistante');
  }
  const old = { protocol: 'ssh', host: 'h', port: 443, username: 'u', password: 'p', sni: 'www.whatsapp.com' };
  const fresh = { protocol: 'ssh', host: 'h', port: 443, username: 'u', password: 'p' };
  const merged = mergeProvisionedConfig(old, fresh);
  assert.equal(merged.sni ?? null, null,
    `l'ancien sni a été restauré (merged.sni=${JSON.stringify(merged.sni)})`);
});

await check('S1.4 — les champs techniques d\'une source NON provisionnée (type /mobile/connections) ne modifient JAMAIS la config provisionnée', () => {
  if (typeof mergeConnectionMetadata !== 'function') {
    throw new Error('mergeConnectionMetadata inexistante — aucune allowlist métadonnées (§6.4)');
  }
  const provisioned = {
    protocol: 'ssh', host: 'serveur-externe.example.com', port: 22,
    username: 'u', password: 'p', tls: false, payload: 'GET / [crlf]',
  };
  // Même si l\'objet porte des champs techniques, l\'allowlist les ignore TOUS.
  const connectionLike = {
    technicalProtocol: 'vless',           // §6.4 : protocol interdit
    protocol: 'vless',                    // §6.4 : interdit même sous ce nom
    server: 'autre-hote.example.com',     // §6.4 : host interdit
    host: 'hote-pirate.example.com',      // §6.4 : host interdit
    port: 443,                            // §6.4 : port interdit
    tls: true, sni: 'x.evil.example', payload: 'Evil /', // §6.4 : interdits
    displayProtocol: 'Orange Protocol',   // allowlist métadonnées
    id: 'sub-xyz',                        // → configId/subscriptionId
    dataToken: 'SXB-DATA-XXXX-XXXX-XXXX', // allowlist métadonnées
    configHash: 'a'.repeat(64),           // allowlist métadonnées
  };
  const merged = mergeConnectionMetadata(provisioned, connectionLike);
  assert.equal(merged.protocol, 'ssh',
    `protocol écrasé par une source non provisionnée (${merged.protocol})`);
  assert.equal(merged.host, 'serveur-externe.example.com',
    `host écrasé par une source non provisionnée (${merged.host})`);
  assert.equal(merged.port, 22, `port écrasé (${merged.port})`);
  assert.equal(merged.tls, false, `tls écrasé (${merged.tls})`);
  assert.equal(merged.payload, 'GET / [crlf]', 'payload écrasé');
  assert.equal(merged.sni ?? null, null, 'sni injecté');
});

await check('S1.5 — CONTRÔLE : les métadonnées autorisées DOIVENT se mettre à jour (allowlist §6.4)', () => {
  const merged = mergeConnectionMetadata(
    { protocol: 'ssh', host: 'h', port: 22, username: 'u', password: 'p', displayProtocol: 'Ancien', configId: 'x' },
    { displayProtocol: 'Nouveau', configId: 'y', dataToken: 'SXB-DATA-0000-0000-0000', configVersion: 3, configHash: 'b'.repeat(64) },
  );
  assert.equal(merged.displayProtocol, 'Nouveau');
  assert.equal(merged.configId, 'y');
  assert.equal(merged.dataToken, 'SXB-DATA-0000-0000-0000');
  assert.equal(merged.configVersion, 3);
  assert.equal(merged.configHash, 'b'.repeat(64));
  // … et la technique est INTACTE
  assert.equal(merged.host, 'h');
  assert.equal(merged.port, 22);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ SECTION 2 — payload:null → chaîne "null" côté natif Android (AOSP) ══\n');

/**
 * Simulation FIDÈLE de android org.json JSONObject.optString(name, fallback) :
 *   AOSP : Object object = nameValueMap.get(name);
 *          String result = JSON.toString(object);  // NULL.toString() == "null"
 *          return result != null ? result : fallback;
 * (diffère de org.json desktop qui retourne fallback pour NULL)
 */
function aospOptString(jsonObj, key, fallback = '') {
  const v = jsonObj[key];
  if (v === undefined) return fallback;
  if (v === null) return 'null';                // JSONObject.NULL.toString() == "null"
  return typeof v === 'string' ? v : String(v); // JSON.toString
}

/** Rejoue la composition de VpnContext.tsx (frontière native, après refonte) :
 *  JSON.stringify(sanitizeEngineConfig({ ...configToUse, protocol, killSwitch, autoReconnect }))
 *  sanitizeEngineConfig N\'EXISTE PAS dans le code d\'avant la refonte → ROUGE. */
function composeEngineJson(configToUse, engineProtocol) {
  if (typeof sanitizeEngineConfig !== 'function') {
    throw new Error('sanitizeEngineConfig inexistante — les null partent au natif (payload="null")');
  }
  return JSON.stringify(sanitizeEngineConfig({
    ...configToUse,
    protocol: engineProtocol,
    killSwitch: false,
    autoReconnect: true,
  }));
}

const { sanitizeEngineConfig } =
  await import(path.join(MOBILE, 'services/configValidator.ts'));

await check('S2.1 — Aucun payload="null" n\'atteint le natif (mission §6.4)', () => {
  // Reproduction exacte : provision.ts émet { payload: null } pour ssh direct
  const configToUse = {
    protocol: 'ssh', host: 'serveur-externe.example.com', port: 443,
    username: 'u', password: 'p', tls: true, sni: null, payload: null,
  };
  const engineJson = JSON.parse(composeEngineJson(configToUse, 'ssh'));
  const rawPayload = aospOptString(engineJson, 'payload', ''); // simulation SxbVpnService.kt l.746
  assert.notEqual(rawPayload, 'null',
    `payload_len=4 reproduit : optString a retourné la chaîne "null" ` +
    `(le JSON moteur contient "payload": null — à nettoyer avant envoi au natif)`);
});

await check('S2.2 — Aucun champ technique null ne doit atteindre le natif (sni, username…)', () => {
  const configToUse = {
    protocol: 'ssh', host: 'h', port: 443, username: 'u', password: 'p',
    tls: true, sni: null, payload: null, path: null, network: null,
  };
  const engineJson = JSON.parse(composeEngineJson(configToUse, 'ssh'));
  const nullFields = Object.entries(engineJson)
    .filter(([, v]) => v === null)
    .map(([k]) => k);
  assert.deepEqual(nullFields, [],
    `champs null transmis au natif : ${nullFields.join(', ')} — après JSONObject, ` +
    `optString les lit comme la chaîne "null" (AOSP)`);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ SECTION 3 — Transport cohérent : « SSH direct + TLS » (validateVpnConfig) ══\n');

await check('S3.1 — ssh direct + tls:true doit être REJETÉ ou produire un avertissement explicite', () => {
  const r = validateVpnConfig({
    protocol: 'ssh', host: 'h.example.com', port: 443, username: 'u', password: 'p', tls: true,
  });
  const rejected = !r.valid ||
    r.warnings.some(w => /tls/i.test(w)) ||
    r.errors.some(e => /tls/i.test(e));
  assert.ok(rejected,
    `combinaison acceptée silencieusement (valid=${r.valid}, warnings=${JSON.stringify(r.warnings)}) — ` +
    `or le moteur ignore TLS en SSH direct (SxbLoggingSocketFactory = TCP brut)`);
});

await check('S3.2 — CONTRÔLE : ssh direct + tls:false reste valide', () => {
  const r = validateVpnConfig({
    protocol: 'ssh', host: 'h.example.com', port: 22, username: 'u', password: 'p', tls: false,
  });
  assert.ok(r.valid, `devrait être valide : ${r.errors.join(' | ')}`);
});

await check('S3.3 — CONTRÔLE : ssh+payload + tls:true reste valide (TLS appliqué dans SxbPayloadProxy)', () => {
  const r = validateVpnConfig({
    protocol: 'ssh+payload', host: 'h.example.com', port: 443, username: 'u', password: 'p',
    tls: true, payload: 'GET / HTTP/1.1[crlf]Host: [host][crlf][crlf]',
  });
  assert.ok(r.valid, `devrait être valide : ${r.errors.join(' | ')}`);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ SECTION 4 — Routes RÉELLES : jsonConfig ignoré + configVersion/configHash absents ══\n');

const esbuild = await import(path.join(BACKEND, 'node_modules/esbuild/lib/main.js'));
const DB_STUB    = path.join(__dirname, 'stubs/database-stub.mjs');
const ENTRY_PATH = path.join(__dirname, '.entry-incident.ts');
const BUNDLE_DIR  = path.join(BACKEND, 'node_modules/.sxb-test');
const BUNDLE_PATH = path.join(BUNDLE_DIR, 'incident-bundle.mjs');
const fs = await import('node:fs/promises');
await fs.mkdir(BUNDLE_DIR, { recursive: true });

await fs.writeFile(ENTRY_PATH, `
export { default as provisionRouter } from ${JSON.stringify(path.join(BACKEND, 'server/routes/provision.ts'))};
export { default as mobileRouter }    from ${JSON.stringify(path.join(BACKEND, 'server/routes/mobile.ts'))};
export * as fixtures from ${JSON.stringify(DB_STUB)};
export { decryptSxbBlob } from ${JSON.stringify(path.join(MOBILE, 'services/aesGcm.ts'))};
export { encryptCanonical, computeCanonicalHash, canonicalJson } from ${JSON.stringify(path.join(BACKEND, 'server/services/canonical-config.ts'))};
`);

await esbuild.build({
  entryPoints: [ENTRY_PATH],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: BUNDLE_PATH,
  logLevel: 'silent',
  nodePaths: [path.join(MOBILE, 'node_modules'), path.join(BACKEND, 'node_modules')],
  banner: { js: 'import { createRequire as __sxbcr } from "module"; const require = __sxbcr(import.meta.url);' },
  plugins: [{
    name: 'db-stub',
    setup(build) {
      build.onResolve({ filter: /(^|\/|\.)database$/ }, (a) =>
        (a.path === '../database' || a.path.endsWith('/database')) ? { path: DB_STUB } : undefined);
      build.onResolve({ filter: /^expo-secure-store$/ }, () =>
        ({ path: path.join(__dirname, 'stubs/expo-secure-store.mjs') }));
      build.onResolve({ filter: /^@react-native-async-storage\/async-storage$/ }, () =>
        ({ path: path.join(__dirname, 'stubs/async-storage.mjs') }));
      build.onResolve({ filter: /^react-native$/ }, () =>
        ({ path: path.join(__dirname, 'stubs/react-native.mjs') }));
    },
  }],
});

const B  = await import(BUNDLE_PATH + '?t=' + Date.now());
const FX = B.fixtures.__fixtures;

const express = (await import(path.join(BACKEND, 'node_modules/express/index.js'))).default;
const jwt     = (await import(path.join(BACKEND, 'node_modules/jsonwebtoken/index.js'))).default;

function dbEncryptGcm(text) {
  const key = createHash('sha256').update(process.env.ENCRYPTION_KEY).digest();
  const iv  = randomBytes(12);
  const c   = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `gcm:${iv.toString('hex')}:${enc.toString('hex')}:${c.getAuthTag().toString('hex')}`;
}

// Profil VLESS « importé » via le NOUVEAU modèle : le canonique fournisseur est
// stocké CHIFFRÉ (canonicalConfig) + hash déterministe. Les colonnes
// d\'identification peuvent DIFFÉRER — elles ne servent plus au provisionnement.
// (Avant la refonte : seules les colonnes étaient lues → jsonConfig ignoré.)
const IMPORTED_CANONICAL = {
  protocol: 'vless',
  host:     'serveur-du-fournisseur.example.net',
  port:     8443,
  uuid:     '3d6f34b0-9d2e-4e4b-8f2e-0a1b2c3d4e5f',
  network:  'ws',
  path:     '/cdn',
  tls:      true,
  sni:      'cdn.example.net',
  flow:     'xtls-rprx-vision',
};

let canonBlob = null;
let canonHash = null;
{
  if (typeof B.encryptCanonical !== 'function' || typeof B.computeCanonicalHash !== 'function') {
    canonBlob = null; // la section S4.1 rapportera le ROUGE explicite
  } else {
    canonBlob = B.encryptCanonical(B.canonicalJson(IMPORTED_CANONICAL));
    canonHash = B.computeCanonicalHash(IMPORTED_CANONICAL);
  }
}

FX.subscription = {
  id: 'sub-incident',
  name: 'Forfait Import VLESS',
  clientId: 'client-001',
  profileId: 'prof-import',
  dataToken: 'SXB-DATA-Z9Y8-X7W6-V5U4',
  quotaBytes: BigInt(10 * 1024 ** 3),
  quotaUsed:  BigInt(0),
  status: 'active',
  expireAt: new Date(Date.now() + 30 * 86400000),
  deviceId: null,
  profile: {
    id: 'prof-import',
    name: 'Import VLESS fournisseur',
    protocol: 'vless',
    displayProtocol: 'MTN Protocol',
    host: 'ancien-serveur-colonnes.example.com', // ← colonne d\'identification ≠ canonique
    port: 443,
    username: null,
    password: null,
    uuid: null,
    tls: false,                                  // ← colonne ≠ canonique (true)
    sni: null,
    network: 'tcp',
    path: '/',
    payloadId: null,
    offlineValidDays: 7,
    status: 'active',
    // Nouveau modèle : canonique chiffré + hash + version
    canonicalConfig:      canonBlob,
    canonicalConfigHash:  canonHash,
    configVersion:        2,
    sourceFormat:         'vless-uri',
  },
  client: { id: 'client-001', user: { id: 'user-001', email: 'client@sxb.cm' } },
};
FX.sshPayload = null;
FX.user = { id: 'user-001', email: 'client@sxb.cm', status: 'active', role: { permissions: [] } };
FX.vpnClient = { id: 'client-001', userId: 'user-001', status: 'active' };

const app = express();
app.use(express.json());
app.use('/api/provision', B.provisionRouter);
app.use('/api/mobile', B.mobileRouter);
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const BASE = `http://127.0.0.1:${server.address().port}/api`;
const auth = () => ({
  Authorization: 'Bearer ' + jwt.sign(
    { userId: 'user-001', email: 'client@sxb.cm', role: 'CLIENT' },
    process.env.JWT_SECRET, { expiresIn: '15m' }),
  'Content-Type': 'application/json',
});

let provisionBody = null;
const DEV = 'SXBTESTDEVICE-INCIDENT';
{
  const res = await fetch(`${BASE}/provision/activate`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ dataToken: 'SXB-DATA-Z9Y8-X7W6-V5U4', deviceId: DEV }),
  });
  assert.equal(res.status, 200, `provision HTTP ${res.status}`);
  provisionBody = await res.json();
}

await check('S4.1 — FIDÉLITÉ §8.1 : la config canonique importée est restituée TECHNIQUEMENT IDENTIQUE (hors allowlist métadonnées)', async () => {
  if (!canonBlob) {
    throw new Error('encryptCanonical/computeCanonicalHash introuvables — modèle canonique non implémenté (jsonConfig ignoré au provisionnement)');
  }
  const cfg = provisionBody.config;
  const clear = JSON.parse(await B.decryptSxbBlob(cfg.encryptedBlob, cfg.configKey));
  // Chaque champ TECHNIQUE du canonique doit être reproduit à l\'identique
  for (const f of Object.keys(IMPORTED_CANONICAL)) {
    assert.deepEqual(clear[f], IMPORTED_CANONICAL[f],
      `champ "${f}" vaut ${JSON.stringify(clear[f])} (colonnes legacy) au lieu de ` +
      `${JSON.stringify(IMPORTED_CANONICAL[f])} (canonique importé) — la configuration ` +
      `fournisseur est ALTÉRÉE au provisionnement`);
  }
  // Réciproque : aucun champ technique ÉTRANGER (colonnes legacy) ne s\'est glissé
  const ALLOWLIST_META = new Set(['displayProtocol', 'profileId', 'profileName']);
  const intrus = Object.keys(clear).filter(k => !(k in IMPORTED_CANONICAL) && !ALLOWLIST_META.has(k));
  assert.deepEqual(intrus, [],
    `champs étrangers injectés dans la config moteur : ${intrus.join(', ')} — ` +
    `la config provisionnée n\'est PAS techniquement identique à l\'import (§8.1)`);
  // Le host colonne (ancien-serveur…) ne doit JAMAIS fuiter
  assert.notEqual(clear.host, 'ancien-serveur-colonnes.example.com',
    'le host des colonnes legacy a fuité dans la config provisionnée');
  // Métadonnées allowlist présentes
  assert.equal(clear.profileId, 'prof-import');
  assert.equal(clear.profileName, 'Import VLESS fournisseur');
  assert.equal(clear.displayProtocol, 'MTN Protocol');
});

await check('S4.2 — la réponse de provisionnement expose configVersion ET configHash (mission 6.3/6.4)', () => {
  const cfg = provisionBody.config;
  assert.ok(typeof cfg.configVersion === 'string' || typeof cfg.configVersion === 'number',
    'configVersion absent de la réponse /provision/activate');
  assert.match(String(cfg.configHash || ''), /^[0-9a-f]{64}$/,
    'configHash (sha256 hex 64) absent de la réponse /provision/activate');
});

await check('S4.3 — /mobile/connections expose configVersion ET configHash (mission 6.4)', async () => {
  const res = await fetch(`${BASE}/mobile/connections`, { headers: auth() });
  assert.equal(res.status, 200, `connections HTTP ${res.status}`);
  const body = await res.json();
  assert.ok(Array.isArray(body.connections) && body.connections.length > 0,
    'aucune connexion retournée');
  const c = body.connections[0];
  assert.ok('configVersion' in c, 'configVersion absent de /mobile/connections');
  assert.match(String(c.configHash || ''), /^[0-9a-f]{64}$/,
    'configHash (sha256 hex 64) absent de /mobile/connections');
});

server.close();

// ═════════════════════════════════════════════════════════════════════════════
const rouges = results.filter(r => !r.ok);
const verts  = results.filter(r => r.ok);
console.log('\n════════════════════════════ RÉCAPITULATIF ═══════════════════════════════');
for (const r of results) console.log(` ${r.ok ? '✅' : '🔴'} ${r.name}`);
console.log('───────────────────────────────────────────────────────────────────────────');
console.log(` VERTS : ${verts.length}   ROUGES : ${rouges.length}   TOTAL : ${results.length}`);
if (rouges.length > 0) {
  console.log('\n⛔ Des défauts de l\'incident APK #165 NE SONT PAS corrigés.');
  console.log('   Chaque 🔴 ci-dessus est un contrat non respecté du modèle « intermédiaire »');
  console.log('   (allowlist métadonnées, sanitize natif, rejet SSH+TLS, canonique chiffré,');
  console.log('   configVersion/configHash). Les 52 assertions historiques doivent rester vertes.');
  process.exit(1);
}
console.log('\n🟢 REFONTE VALIDÉE — les 5 défauts de l\'incident APK #165 sont corrigés.');
console.log('   Modèle « intermédiaire » conforme : canonique chiffré restitué à l\'identique,');
console.log('   fusion allowlist §6.4, frontière native sans null, transport SSH+TLS rejeté.');

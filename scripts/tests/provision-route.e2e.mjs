/**
 * provision-route.e2e.mjs — Test d'intégration HTTP RÉEL de /api/provision/activate
 *
 * Exécution :
 *   cd backend && npm install --legacy-peer-deps --no-audit   (dépendances)
 *   node --experimental-strip-types --import ../scripts/tests/register-hooks.mjs \
 *        ../scripts/tests/provision-route.e2e.mjs        (depuis backend/)
 *
 * Couvre l'ÉTAPE 4 de la mission :
 *   status HTTP, structure JSON, encryptedBlob, configKey, signature,
 *   encVersion, configExpiresAt/expiresAt, quotaGB — puis DÉCHIFFREMENT du
 *   blob avec le moteur mobile (app-mobile/services/aesGcm.ts) et comparaison
 *   champ-à-champ avec le profil source (host, port, username, password,
 *   payload, sni, tls…), ainsi que les cas d'erreur (401/403/404/503).
 */
import { strict as assert } from 'node:assert';
import { createHmac, randomBytes, createCipheriv, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, '../../backend');
const MOBILE  = path.resolve(__dirname, '../../app-mobile');

// ── Environnement (avant tout import de config.ts) ──────────────────────────
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'e2e-jwt-secret';
process.env.REFRESH_SECRET = 'e2e-refresh-secret';
process.env.PROVISION_SECRET = 'e2e-provision-secret';
process.env.ENCRYPTION_KEY = 'e2e-encryption-key-32-bytes-pad!'; // 32 chars exacts
assert.equal(process.env.ENCRYPTION_KEY.length, 32, 'ENCRYPTION_KEY doit faire 32 chars');

/*
 * Bundle de test : esbuild compile la VRAIE route provision.ts (+ middleware
 * auth réel) en éliminant les imports TypeScript type-only, et substitue
 * server/database.ts par le stub Prisma en mémoire (plugin onResolve).
 */
const esbuild = await import(path.join(BACKEND, 'node_modules/esbuild/lib/main.js'));
const STUB_PATH = fileURLToPath(new URL('./stubs/database-stub.mjs', import.meta.url));
let __fixtures; // initialisé depuis le bundle (même instance inline que la route)
const ENTRY_PATH = path.join(__dirname, '.entry-provision.ts');
// Bundle placé sous backend/node_modules (gitignored) : les paquets externes
// (express, jsonwebtoken, zod, dotenv) se résolvent depuis backend/node_modules.
const BUNDLE_DIR  = path.join(BACKEND, 'node_modules/.sxb-test');
const BUNDLE_PATH = path.join(BUNDLE_DIR, 'provision-bundle.mjs');
const fs = await import('node:fs/promises');
await fs.mkdir(BUNDLE_DIR, { recursive: true });

await fs.writeFile(
  ENTRY_PATH,
  `export { default } from ${JSON.stringify(path.join(BACKEND, 'server/routes/provision.ts'))};\n` +
  `export * as fixtures from ${JSON.stringify(STUB_PATH)};\n`,
);

await esbuild.build({
  entryPoints: [ENTRY_PATH],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: BUNDLE_PATH,
  logLevel: 'silent',
  // Paquets runtime résolus normalement (installés par npm dans backend/)
  external: ['express', 'jsonwebtoken', 'zod', 'dotenv', 'crypto', 'path', 'fs', 'url', 'util', 'http', 'https', 'net', 'stream', 'events', 'buffer', 'querystring', 'os'],
  plugins: [{
    name: 'db-stub',
    setup(build) {
      // Le filtre s'applique au spécificateur BRUT ('../database'), pas au chemin résolu
      build.onResolve({ filter: /(^|\/|\.)database$/ }, (args) => {
        if (args.path === '../database' || args.path.endsWith('/database')) {
          return { path: STUB_PATH };
        }
        return undefined;
      });
    },
  }],
});

const bundle = await import(BUNDLE_PATH + '?t=' + Date.now());
const provisionRouter = bundle.default;
// IMPORTANT : esbuild inline le stub dans le bundle — les fixtures doivent
// provenir de l'instance INLINE (route et tests partagent ainsi le même état).
__fixtures = bundle.fixtures.__fixtures;

const express      = (await import(path.join(BACKEND, 'node_modules/express/index.js'))).default;
const jwt          = (await import(path.join(BACKEND, 'node_modules/jsonwebtoken/index.js'))).default;
const { decryptSxbBlob } = await import(path.join(MOBILE, 'services/aesGcm.ts'));
const { isCompleteOfflineConfig, validateVpnConfig } =
  await import(path.join(MOBILE, 'services/configValidator.ts'));

let passed = 0;
const ok = (m) => { passed++; console.log(`  ✅ ${m}`); };

// Chiffrement DB (vpn-profiles.ts) pour le password du profil fixture
function dbEncryptGcm(text) {
  const key = createHash('sha256').update(process.env.ENCRYPTION_KEY).digest();
  const iv  = randomBytes(12);
  const c   = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `gcm:${iv.toString('hex')}:${enc.toString('hex')}:${c.getAuthTag().toString('hex')}`;
}

// ── Fixtures : profil SSH+Payload réaliste (comme en production) ────────────
const DEVICE_ID  = 'SXBTESTDEVICE123';
const DATA_TOKEN = 'SXB-DATA-A1B2-C3D4-E5F6';

const PAYLOAD_CONTENT = 'POST http://154.72.31.88/ HTTP/1.1[crlf]Host: 154.72.31.88[crlf]Connection: Upgrade[crlf]User-Agent: [ua][crlf]Upgrade: websocket[crlf][crlf]';

function makeActiveSubscription(overrides = {}) {
  return {
    id: 'sub-001',
    name: 'Forfait MTN 10GB',
    clientId: 'client-001',
    profileId: 'prof-001',
    dataToken: DATA_TOKEN,
    quotaBytes: BigInt(10 * 1024 ** 3),
    quotaUsed:  BigInt(2 * 1024 ** 3),
    status: 'active',
    expireAt: new Date(Date.now() + 30 * 86400000),
    deviceId: null,
    durationDays: 30,
    createdAt: new Date(),
    profile: {
      id: 'prof-001',
      name: 'Camtel SSH+WS TLS',
      protocol: 'ssh+payload',
      displayProtocol: 'MTN Protocol',
      host: '154.72.31.88',
      port: 443,
      username: 'sxb_client_42',
      password: dbEncryptGcm('SshP@ssw0rd!2026'),
      uuid: null,
      tls: true,
      sni: 'www.whatsapp.com',
      network: 'tcp',
      dns: '8.8.8.8',
      payloadId: 'pl-001',
      offlineValidDays: 7,
      status: 'active',
    },
    client: {
      id: 'client-001',
      user: { id: 'user-001', email: 'client@sxb.cm', name: 'Client Test' },
    },
    ...overrides,
  };
}

function resetFixtures(subOverrides = {}) {
  __fixtures.subscription = makeActiveSubscription(subOverrides);
  __fixtures.subscriptionUpdateCalls = [];
  __fixtures.sshPayload = { id: 'pl-001', name: 'WS Camtel', content: PAYLOAD_CONTENT, status: 'active' };
  __fixtures.user = {
    id: 'user-001', email: 'client@sxb.cm', status: 'active',
    role: { permissions: [] },
  };
}

// ── Application Express minimale montant la VRAIE route ─────────────────────
const app = express();
app.use(express.json());
app.use('/api/provision', provisionRouter);
app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));

const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const BASE = `http://127.0.0.1:${server.address().port}/api/provision`;

function authHeader() {
  const token = jwt.sign(
    { userId: 'user-001', email: 'client@sxb.cm', role: 'CLIENT' },
    process.env.JWT_SECRET,
    { expiresIn: '15m' },
  );
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

console.log('\n══ ÉTAPE 4 — POST /api/provision/activate (serveur réel, DB mockée) ══');

// ── 1. Cas nominal : abonnement actif, premier appareil ─────────────────────
resetFixtures();
{
  const res = await fetch(`${BASE}/activate`, {
    method: 'POST', headers: authHeader(),
    body: JSON.stringify({ dataToken: DATA_TOKEN, deviceId: DEVICE_ID }),
  });

  // Status + headers
  assert.equal(res.status, 200, `attendu 200, reçu ${res.status}`);
  assert.match(res.headers.get('content-type'), /application\/json/);
  ok('HTTP 200 + Content-Type JSON');

  const body = await res.json();
  const cfg = body.config;

  // Structure de la réponse (ÉTAPE 4)
  assert.equal(body.success, true);
  assert.ok(cfg, 'champ config imbriqué présent');
  for (const f of ['encryptedBlob', 'configKey', 'encVersion', 'signature',
                   'configExpiresAt', 'provisionedAt', 'quotaGB', 'quotaUsedGB',
                   'subscriptionId', 'protocol', 'displayProtocol', 'deviceId']) {
    assert.ok(f in cfg, `champ manquant dans la réponse: ${f}`);
  }
  assert.ok(cfg.encryptedBlob.startsWith('gcm:'));
  assert.equal(cfg.encryptedBlob.split(':').length, 4);
  assert.match(cfg.configKey, /^[0-9a-f]{64}$/);
  assert.match(cfg.signature, /^[0-9a-f]{64}$/);
  assert.equal(cfg.encVersion, 'gcm-v2');
  assert.ok(!Number.isNaN(Date.parse(cfg.configExpiresAt)));
  assert.equal(cfg.protocol, 'ssh+payload');
  assert.equal(cfg.displayProtocol, 'MTN Protocol');
  assert.equal(cfg.deviceId, DEVICE_ID);
  assert.ok(cfg.quotaGB > 0);
  ok('Structure JSON complète : blob gcm:, configKey, signature, encVersion=gcm-v2, dates ISO, quota');

  // Signature serveur vérifiable
  const expectedSig = createHmac('sha256', process.env.PROVISION_SECRET)
    .update(`${cfg.subscriptionId}:${DEVICE_ID}:${cfg.configExpiresAt}`)
    .digest('hex');
  assert.equal(cfg.signature, expectedSig);
  ok('Signature HMAC-SHA256(subscriptionId:deviceId:expiresAt) vérifiable');

  // Chaque appel produit un IV différent (aléatoire GCM)
  const res2 = await fetch(`${BASE}/activate`, {
    method: 'POST', headers: authHeader(),
    body: JSON.stringify({ dataToken: DATA_TOKEN, deviceId: DEVICE_ID }),
  });
  const cfg2 = (await res2.json()).config;
  assert.notEqual(cfg.encryptedBlob, cfg2.encryptedBlob);
  assert.equal(cfg.configKey, cfg2.configKey, 'même appareil + même token = même clé dérivée');
  ok('IV aléatoire par appel ; clé de config déterministe par (deviceId, dataToken)');

  // ── DÉCHIFFREMENT CÔTÉ MOBILE (moteur aesGcm.ts de production) ──────────
  const plain = decryptSxbBlob(cfg.encryptedBlob, cfg.configKey);
  const vpnConfig = JSON.parse(plain);

  // Comparaison champ-à-champ avec le profil source
  assert.equal(vpnConfig.protocol, 'ssh+payload');
  assert.equal(vpnConfig.host, '154.72.31.88');
  assert.equal(vpnConfig.port, 443);
  assert.equal(vpnConfig.username, 'sxb_client_42');
  assert.equal(vpnConfig.password, 'SshP@ssw0rd!2026', 'password DB déchiffré correctement');
  assert.equal(vpnConfig.payload, PAYLOAD_CONTENT, 'payload SSH joint au profil');
  assert.equal(vpnConfig.sni, 'www.whatsapp.com');
  assert.equal(vpnConfig.tls, true);
  assert.equal(vpnConfig.dns, '8.8.8.8');
  assert.equal(vpnConfig.network, 'tcp');
  assert.equal(vpnConfig.displayProtocol, 'MTN Protocol');
  ok('Blob déchiffré = profil complet : host, port, username, password, payload, sni, tls, dns — AUCUN champ perdu');

  // Gardien de complétude mobile
  const comp = isCompleteOfflineConfig(vpnConfig);
  assert.deepEqual(comp.missing, []);
  assert.equal(comp.complete, true);
  assert.equal(comp.hasHost, true);
  assert.equal(comp.hasCreds, true);
  assert.equal(comp.hasPayload, true);
  ok('isCompleteOfflineConfig → complete / hasHost / hasCreds / hasPayload = true');

  const valid = validateVpnConfig(vpnConfig);
  assert.equal(valid.valid, true, valid.errors.join('; '));
  ok('validateVpnConfig → valid=true');

  // Effets de bord attendus : deviceId enregistré + lastProvisionAt marqué
  const updateData = __fixtures.subscriptionUpdateCalls.map(c => JSON.stringify(c.data)).join('|');
  assert.match(updateData, /deviceId/);
  assert.match(updateData, /lastProvisionAt/);
  ok('Effets de bord : deviceId lié à l\'abonnement + lastProvisionAt horodaté');
}

// ── 2. Re-provisionnement du MÊME appareil (restauration après perte) ───────
resetFixtures({ deviceId: DEVICE_ID });
{
  const res = await fetch(`${BASE}/activate`, {
    method: 'POST', headers: authHeader(),
    body: JSON.stringify({ dataToken: DATA_TOKEN, deviceId: DEVICE_ID }),
  });
  assert.equal(res.status, 200);
  ok('Re-provisionnement sur le même appareil → 200 (renouvellement offline)');
}

// ── 3. Appareil différent déjà lié → 403 ─────────────────────────────────────
resetFixtures({ deviceId: 'SXBAUTREAPPAREIL1' });
{
  const res = await fetch(`${BASE}/activate`, {
    method: 'POST', headers: authHeader(),
    body: JSON.stringify({ dataToken: DATA_TOKEN, deviceId: DEVICE_ID }),
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(body.error, /autre appareil/);
  ok('Autre appareil déjà lié → HTTP 403 explicite');
}

// ── 4. Abonnement expiré → 403 + statut mis à jour ───────────────────────────
resetFixtures({ expireAt: new Date(Date.now() - 86400000) });
{
  const res = await fetch(`${BASE}/activate`, {
    method: 'POST', headers: authHeader(),
    body: JSON.stringify({ dataToken: DATA_TOKEN, deviceId: DEVICE_ID }),
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(body.error, /expir/i);
  assert.equal(__fixtures.subscription.status, 'expired', 'statut passé à expired en DB');
  ok('Abonnement expiré → HTTP 403 + transition de statut en DB');
}

// ── 5. Abonnement suspendu / révoqué → 403 ───────────────────────────────────
for (const status of ['suspended', 'revoked']) {
  resetFixtures({ status });
  const res = await fetch(`${BASE}/activate`, {
    method: 'POST', headers: authHeader(),
    body: JSON.stringify({ dataToken: DATA_TOKEN, deviceId: DEVICE_ID }),
  });
  assert.equal(res.status, 403);
  ok(`Abonnement ${status} → HTTP 403`);
}

// ── 6. Token inconnu → 404 ───────────────────────────────────────────────────
resetFixtures();
{
  const res = await fetch(`${BASE}/activate`, {
    method: 'POST', headers: authHeader(),
    body: JSON.stringify({ dataToken: 'SXB-DATA-FFFF-FFFF-FFFF', deviceId: DEVICE_ID }),
  });
  assert.equal(res.status, 404);
  ok('dataToken inconnu → HTTP 404');
}

// ── 7. Sans JWT → 401 (middleware requireAuth réel) ──────────────────────────
resetFixtures();
{
  const res = await fetch(`${BASE}/activate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataToken: DATA_TOKEN, deviceId: DEVICE_ID }),
  });
  assert.equal(res.status, 401);
  ok('Sans Authorization Bearer → HTTP 401');
}

// ── 8. PROVISION_SECRET absente → 503 (fail-closed) ─────────────────────────
{
  resetFixtures(); // fixtures construites AVANT la suppression des clés
  const saved = process.env.PROVISION_SECRET;
  delete process.env.PROVISION_SECRET;
  const savedEnc = process.env.ENCRYPTION_KEY;
  delete process.env.ENCRYPTION_KEY; // getMasterSecret tombe alors en absolu
  const res = await fetch(`${BASE}/activate`, {
    method: 'POST', headers: authHeader(),
    body: JSON.stringify({ dataToken: DATA_TOKEN, deviceId: DEVICE_ID }),
  });
  assert.equal(res.status, 503);
  process.env.PROVISION_SECRET = saved;
  process.env.ENCRYPTION_KEY = savedEnc;
  ok('PROVISION_SECRET manquante → HTTP 503 (aucun fallback silencieux — fail-closed)');
}

// ── 9. dataToken/deviceId manquants → 400 ────────────────────────────────────
resetFixtures();
{
  const res = await fetch(`${BASE}/activate`, {
    method: 'POST', headers: authHeader(),
    body: JSON.stringify({ dataToken: DATA_TOKEN }),
  });
  assert.equal(res.status, 400);
  ok('deviceId manquant → HTTP 400');
}

await fs.unlink(ENTRY_PATH).catch(() => {});
server.close();
console.log(`\n🏁 RÉSULTAT : ${passed} assertions réussies — route /provision/activate validée E2E\n`);
process.exit(0);

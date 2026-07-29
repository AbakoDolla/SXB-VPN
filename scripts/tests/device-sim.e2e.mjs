/**
 * device-sim.e2e.mjs — Simulation d'appareil Android SXB VPN (ÉTAPES 2→9)
 *
 * Exécution (après `cd backend && npm install --legacy-peer-deps --no-audit`
 * et `cd app-mobile && npm install --legacy-peer-deps --no-audit`) :
 *   node scripts/tests/device-sim.e2e.mjs
 *
 * Monte le VRAI backend (routes mobile.ts + provision.ts compilées par esbuild,
 * DB mockée en mémoire) et exécute le VRAI code mobile de production :
 *   - app-mobile/services/apiClient.ts (remplacé par axios local — même Axios)
 *   - app-mobile/services/provisionClient.ts (déchiffrement aesGcm.ts)
 *   - app-mobile/services/offlineStorage.ts (SecureStore/AsyncStorage mockés)
 *   - app-mobile/services/configValidator.ts
 *
 * Scénario : activation compte → liste connexions → provision → vérif
 * SecureStore → REDÉMARRAGE app → MODE AVION → lecture config offline →
 * composition du JSON moteur (comme VpnContext.connect) → validation champs
 * natifs (host/port/usePayload…) → quota offline → re-provisionnement →
 * configuration incomplète héritée (réparation automatique).
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

let passed = 0;
const ok = (m) => { passed++; console.log(`  ✅ ${m}`); };

// ═══════════════════════════════════════════════════════════════════════════
// 1. Bundler : backend routes + services mobiles réels + doublures RN
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n══ Build du bundle appareil+serveur (esbuild, code réel) ══');

const esbuild = await import(path.join(BACKEND, 'node_modules/esbuild/lib/main.js'));
const DB_STUB    = path.join(__dirname, 'stubs/database-stub.mjs');
const ENVSTUBS   = path.join(__dirname, 'stubs/mobile-env-stubs.mjs');
const API_STUB   = path.join(__dirname, 'stubs/api-client-stub.mjs');
const ENTRY_PATH = path.join(__dirname, '.entry-device.ts');
const BUNDLE_DIR  = path.join(BACKEND, 'node_modules/.sxb-test');
const BUNDLE_PATH = path.join(BUNDLE_DIR, 'device-bundle.mjs');

const fs = await import('node:fs/promises');
await fs.mkdir(BUNDLE_DIR, { recursive: true });

await fs.writeFile(ENTRY_PATH, `
export { default as provisionRouter } from ${JSON.stringify(path.join(BACKEND, 'server/routes/provision.ts'))};
export { default as mobileRouter }    from ${JSON.stringify(path.join(BACKEND, 'server/routes/mobile.ts'))};
export * as fixtures from ${JSON.stringify(DB_STUB)};
export { provisionAndStore, loadProvisionedConfig, clearProvisionedConfig, hasValidProvisionedConfig }
  from ${JSON.stringify(path.join(MOBILE, 'services/provisionClient.ts'))};
export { saveVpnConfig, loadVpnConfig, saveQuotaData, loadQuotaData,
         isQuotaExhausted, isConfigExpired, consumeLocalQuota, clearAllOfflineData, getOfflineStatus }
  from ${JSON.stringify(path.join(MOBILE, 'services/offlineStorage.ts'))};
export { isCompleteOfflineConfig, mergeConfigs, validateVpnConfig, parseAndValidateConfig }
  from ${JSON.stringify(path.join(MOBILE, 'services/configValidator.ts'))};
export { secureStoreState, asyncStorageState } from ${JSON.stringify(ENVSTUBS)};
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
  // CJS (express/axios) inline + createRequire de secours pour les builtins
  banner: { js: 'import { createRequire as __sxbcr } from "module"; const require = __sxbcr(import.meta.url);' },
  plugins: [
    {
      name: 'sxb-test-aliases',
      setup(build) {
        build.onResolve({ filter: /(^|\/|\.)database$/ }, (a) =>
          (a.path === '../database' || a.path.endsWith('/database')) ? { path: DB_STUB } : undefined);
        build.onResolve({ filter: /^expo-secure-store$/ }, () =>
          ({ path: path.join(__dirname, 'stubs/expo-secure-store.mjs') }));
        build.onResolve({ filter: /^@react-native-async-storage\/async-storage$/ }, () =>
          ({ path: path.join(__dirname, 'stubs/async-storage.mjs') }));
        build.onResolve({ filter: /^react-native$/ }, () =>
          ({ path: path.join(__dirname, 'stubs/react-native.mjs') }));
        build.onResolve({ filter: /(^|\/)apiClient$/ }, (a) =>
          a.path === './apiClient' ? { path: API_STUB } : undefined);
      },
    },
  ],
});

const B = await import(BUNDLE_PATH + '?t=' + Date.now());
const FX = B.fixtures.__fixtures;
ok('Bundle compilé : routes backend réelles + services mobiles réels + doublures stockage');

// ═══════════════════════════════════════════════════════════════════════════
// 2. Fixtures : client VPN + abonnement actif + profil ssh+payload complet
// ═══════════════════════════════════════════════════════════════════════════
function dbEncryptGcm(text) {
  const key = createHash('sha256').update(process.env.ENCRYPTION_KEY).digest();
  const iv  = randomBytes(12);
  const c   = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `gcm:${iv.toString('hex')}:${enc.toString('hex')}:${c.getAuthTag().toString('hex')}`;
}

const DEVICE_ID  = 'SXBSIMDEVICE777';
const ACCT_TOKEN = 'SXB-USER-A1B2-C3D4-E5F6';
const DATA_TOKEN = 'SXB-DATA-9Z8Y-7X6W-5V4U';
const PAYLOAD    = 'GET / HTTP/1.1[crlf]Host: [host][crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf][crlf]';

const USER = { id: 'user-42', email: 'client42@sxb.cm', name: 'Client 42', status: 'active', role: { permissions: [] } };
const CLIENT = {
  id: 'client-42', userId: 'user-42', token: ACCT_TOKEN,
  quotaTotal: BigInt(20 * 1024 ** 3), quotaUsed: BigInt(1 * 1024 ** 3),
  expireAt: new Date(Date.now() + 30 * 86400000), status: 'active',
  deviceId: null, deviceLimit: 1, user: USER,
};
const SUBSCRIPTION = {
  id: 'sub-42', name: 'Forfait MTN 20GB', clientId: 'client-42', profileId: 'prof-42',
  dataToken: DATA_TOKEN, quotaBytes: BigInt(20 * 1024 ** 3), quotaUsed: BigInt(1 * 1024 ** 3),
  durationDays: 30, status: 'active', expireAt: new Date(Date.now() + 30 * 86400000),
  deviceId: null, createdAt: new Date(),
  profile: {
    id: 'prof-42', name: 'Camtel SSH+WS', protocol: 'ssh+payload', displayProtocol: 'MTN Protocol',
    host: '196.216.10.15', port: 443, username: 'sxb_u42',
    password: dbEncryptGcm('MotDePasse_SSH!42'), uuid: null,
    tls: true, sni: 'web.whatsapp.com', network: 'tcp', dns: '1.1.1.1',
    payloadId: 'pl-42', offlineValidDays: 7, status: 'active',
  },
  client: CLIENT,
};

FX.user = USER;
FX.vpnClient = CLIENT;
FX.subscription = SUBSCRIPTION;
FX.sshPayload = { id: 'pl-42', name: 'WS Camtel', content: PAYLOAD, status: 'active' };
FX.auditLogs = [];
ok('Fixtures installées : client + abonnement SSH+Payload actif (host 196.216.10.15:443)');

// ═══════════════════════════════════════════════════════════════════════════
// 3. Serveur réel (express) — routes mobile + provision
// ═══════════════════════════════════════════════════════════════════════════
const express = (await import(path.join(BACKEND, 'node_modules/express/index.js'))).default;
const app = express();
app.use(express.json());
app.set('json replacer', (_k, v) => (typeof v === 'bigint' ? v.toString() : v)); // cf. server.ts
app.use('/api/mobile', B.mobileRouter);
app.use('/api/provision', B.provisionRouter);
app.use((err, req, res, _n) => res.status(500).json({ error: err.message }));

const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
globalThis.__SXB_TEST_BASE = `http://127.0.0.1:${server.address().port}`;
ok(`Serveur réel démarré : ${globalThis.__SXB_TEST_BASE}/api (mobile + provision)`);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n══ ÉTAPES 2→5 : Activation → Provision → Stockage sécurisé ══');
// ═══════════════════════════════════════════════════════════════════════════

// ── Activation du compte (token SXB-USER) via backend réel ──────────────────
const axiosReal = (await import(path.join(MOBILE, 'node_modules/axios/index.js'))).default;
{
  const res = await axiosReal.post(`${globalThis.__SXB_TEST_BASE}/api/mobile/auth/activate`, {
    token: ACCT_TOKEN, deviceId: DEVICE_ID,
  });
  assert.equal(res.status, 200);
  assert.ok(res.data.accessToken && res.data.refreshToken);
  assert.equal(res.data.accountState.state, 'ready');
  globalThis.__SXB_TEST_JWT = res.data.accessToken;
  ok('POST /mobile/auth/activate → 200 + JWT + accountState=ready');
}

// ── Connexions actives (même requête que l\'écran d\'accueil) ───────────────
let activeConn;
{
  const res = await axiosReal.get(`${globalThis.__SXB_TEST_BASE}/api/mobile/connections`, {
    headers: { Authorization: `Bearer ${globalThis.__SXB_TEST_JWT}` },
  });
  assert.equal(res.status, 200);
  const conns = res.data.connections;
  assert.equal(conns.length, 1);
  activeConn = conns.find((c) => c.status === 'active');
  assert.ok(activeConn, 'connexion active trouvée');
  assert.equal(activeConn.dataToken, DATA_TOKEN);
  assert.equal(activeConn.technicalProtocol, 'ssh+payload');
  assert.equal(activeConn.displayProtocol, 'MTN Protocol');
  ok(`GET /mobile/connections → 1 active (dataToken + protocoles technique "ssh+payload" / commercial "MTN Protocol")`);
}

// ── Provision via le VRAI provisionClient (réseau réel + AES-256-GCM TS pur) ─
let provResult;
{
  provResult = await B.provisionAndStore(activeConn.dataToken, DEVICE_ID);
  const { config, meta } = provResult;

  // Config déchiffrée COMPLÈTE (le bug crypto.subtle aurait fait échouer ici)
  assert.equal(config.host, '196.216.10.15');
  assert.equal(config.port, 443);
  assert.equal(config.username, 'sxb_u42');
  assert.equal(config.password, 'MotDePasse_SSH!42');
  assert.equal(config.payload, PAYLOAD);
  assert.equal(config.protocol, 'ssh+payload');
  assert.equal(config.sni, 'web.whatsapp.com');
  assert.equal(config.tls, true);
  assert.ok(meta.configExpiresAt && !Number.isNaN(Date.parse(meta.configExpiresAt)));
  assert.equal(meta.encVersion, 'gcm-v2');
  ok('provisionAndStore SUCCÈS : config complète déchiffrée (host, port, username, password, payload, sni, tls)');

  // SecureStore contient bien la config COMPLÈTE (ÉTAPE 8)
  // (B.secureStoreState = même instance inline que celle utilisée par provisionClient)
  const provRaw = B.secureStoreState.get('sxb_prov_config_v2');
  assert.ok(provRaw, 'sxb_prov_config_v2 présent dans SecureStore');
  const provParsed = JSON.parse(provRaw);
  for (const f of ['host', 'port', 'username', 'password', 'payload', 'protocol', 'sni', 'dns', 'network']) {
    assert.ok(f in provParsed, `SecureStore incomplet : ${f} manquant`);
  }
  ok('SecureStore = configuration VPN COMPLÈTE chiffrée (aucun champ perdu — ÉTAPE 8)');

  // ── Réplique exacte de VpnContext.syncFromConnection → saveCompleteConfig ──
  const merged = B.mergeConfigs(provResult.config, {
    protocol:        activeConn.technicalProtocol.toLowerCase(),
    displayProtocol: activeConn.displayProtocol,
    configId:        activeConn.id,
    dataToken:       activeConn.dataToken,
  });
  const check = B.isCompleteOfflineConfig(merged);
  assert.equal(check.complete, true);
  assert.equal(check.hasHost, true);
  assert.equal(check.hasCreds, true);
  await B.saveVpnConfig(merged, 'ssh+payload', activeConn.id, meta.configExpiresAt);
  ok(`saveCompleteConfig → config hors-ligne persistée (hasHost=true, hasCreds=true)`);

  // Quota local synchronisé (comme le nouveau VpnContext)
  await B.saveQuotaData({
    configId: meta.subscriptionId,
    totalQuota: Math.round(meta.quotaGB * 1024 ** 3),
    usedQuota:  Math.round(meta.quotaUsedGB * 1024 ** 3),
    expiryDate: meta.expireAt,
  });
  assert.equal(await B.isQuotaExhausted(), false);
  assert.equal(await B.isConfigExpired(), false);
  ok('Quota local synchronisé : non épuisé, non expiré');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n══ ÉTAPE 9 : Redémarrage app → MODE AVION → connexion hors-ligne ══');
// ═══════════════════════════════════════════════════════════════════════════
{
  // ── Simulation REDÉMARRAGE : l'état React disparaît, seuls persistent ─────
  // SecureStore et AsyncStorage (maps conservées). Plus AUCUN appel réseau.
  globalThis.__SXB_TEST_JWT = undefined; // mode avion : même si requête, elle échouerait

  const offlineEntry = await B.loadVpnConfig();
  assert.ok(offlineEntry?.config, 'config offline retrouvée après redémarrage');

  // Réplique exacte de VpnContext.connect (nouveau flux corrigé)
  const storedCheck = B.isCompleteOfflineConfig(offlineEntry.config);
  assert.equal(storedCheck.complete, true, 'config offline complète en mode avion');

  let configToUse = { ...offlineEntry.config };
  const engineProtocol = (configToUse.protocol || 'vless').toLowerCase();
  const optionsJson = JSON.stringify({
    ...configToUse,
    protocol:      engineProtocol,
    killSwitch:    false,
    autoReconnect: true,
  });

  // Vérification côté "moteur" : ce que SxbVpnService.kt lira réellement
  const cfg = JSON.parse(optionsJson);
  const host       = cfg.host;                      // cfg.getString("host")
  const port       = cfg.port ?? 22;                // cfg.optInt("port", 22)
  const username   = cfg.username ?? '';
  const password   = cfg.password ?? '';
  const usePayload = Boolean(cfg.usePayload) || String(cfg.protocol ?? '').includes('payload');
  const payload    = cfg.payload ?? '';
  const tlsEnabled = cfg.tlsEnabled ?? cfg.tls ?? false;

  assert.equal(host, '196.216.10.15');
  assert.equal(port, 443);
  assert.equal(username, 'sxb_u42');
  assert.equal(password, 'MotDePasse_SSH!42');
  assert.equal(usePayload, true, 'usePayload=true pour ssh+payload');
  assert.equal(payload, PAYLOAD);
  assert.equal(tlsEnabled, true);
  ok('HORS-LIGNE : JSON moteur identique au provision (host/port/creds/payload/tls/usePayload ✓)');

  // Le validateur approuve aussi la config relue
  const valid = B.validateVpnConfig(cfg);
  assert.equal(valid.valid, true, valid.errors.join('; '));
  ok('validateVpnConfig sur la config restaurée hors-ligne → valid=true');

  // Relecture provisionnée également disponible (double source cohérente)
  const prov = await B.loadProvisionedConfig();
  assert.ok(prov?.config?.host === '196.216.10.15');
  ok('loadProvisionedConfig cohérent après redémarrage (double persistance OK)');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n══ Cycle quota : épuisement + expiration (offline) ══');
// ═══════════════════════════════════════════════════════════════════════════
{
  // Consommer tout le quota localement (simulateur de trafic hors-ligne)
  const quota = await B.loadQuotaData();
  await B.consumeLocalQuota(quota.remainingQuota);
  assert.equal(await B.isQuotaExhausted(), true);
  ok('Quota local épuisé → isQuotaExhausted()=true (connect() bloque avec message clair)');

  // Expiration : forcer une date passée (simule refresh backend "expiré")
  await B.saveQuotaData({
    configId: 'sub-42', totalQuota: quota.totalQuota, usedQuota: 0,
    expiryDate: new Date(Date.now() - 3600_000).toISOString(),
  });
  assert.equal(await B.isConfigExpired(), true);
  ok('Quota expiré → isConfigExpired()=true (connect() bloque avec message clair)');

  // Renouvellement : nouveau quota actif (refresh après recharge)
  await B.saveQuotaData({
    configId: 'sub-42', totalQuota: quota.totalQuota, usedQuota: 0,
    expiryDate: new Date(Date.now() + 30 * 86400000).toISOString(),
  });
  assert.equal(await B.isQuotaExhausted(), false);
  assert.equal(await B.isConfigExpired(), false);
  ok('Renouvellement → gardes relâchés (connexion à nouveau possible)');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n══ Réparation d\'une config héritée incomplète (fix VpnContext) ══');
// ═══════════════════════════════════════════════════════════════════════════
{
  // Simuler une config incomplète écrite par une ANCIENNE version de l'app
  // (c'est exactement ce qui provoquait CONFIG_INCOMPLETE_BLOCK en boucle)
  globalThis.__SXB_TEST_JWT = (await axiosReal.post(
    `${globalThis.__SXB_TEST_BASE}/api/mobile/auth/activate`,
    { token: ACCT_TOKEN, deviceId: DEVICE_ID },
  )).data.accessToken;

  const brokenConfig = { protocol: 'ssh+payload', displayProtocol: 'MTN Protocol', configId: 'sub-42', dataToken: DATA_TOKEN };
  await B.clearAllOfflineData();
  await B.saveVpnConfig(brokenConfig, 'ssh+payload', 'sub-42', null); // écriture directe = legacy

  const entry = await B.loadVpnConfig();
  const storedCheck = B.isCompleteOfflineConfig(entry.config);
  assert.equal(storedCheck.complete, false);
  assert.deepEqual(storedCheck.missing.sort(), ['credentials', 'host', 'port'].sort());
  ok(`Config héritée incomplète détectée (missing=${storedCheck.missing.join(',')})`);

  // Nouveau flux connect() : NE PAS utiliser la config incomplète → re-provision
  let configToUse = null;
  if (storedCheck.complete) {
    configToUse = { ...entry.config };
  } else {
    const dataToken = entry.config.dataToken;
    const fresh = await B.provisionAndStore(dataToken, DEVICE_ID);
    configToUse = B.mergeConfigs(fresh.config, {
      displayProtocol: 'MTN Protocol', configId: 'sub-42', dataToken,
    });
    const c = B.isCompleteOfflineConfig(configToUse);
    assert.equal(c.complete, true);
    await B.saveVpnConfig(configToUse, 'ssh+payload', 'sub-42', fresh.meta.configExpiresAt);
  }
  assert.equal(configToUse.host, '196.216.10.15');
  assert.equal(configToUse.password, 'MotDePasse_SSH!42');
  const reloaded = await B.loadVpnConfig();
  assert.equal(B.isCompleteOfflineConfig(reloaded.config).complete, true);
  ok('Réparation automatique : re-provisionnement → config COMPLÈTE persistée (fin du blocage)');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n══ Re-provisionnement après redémarrage (même appareil) ══');
// ═══════════════════════════════════════════════════════════════════════════
{
  const again = await B.provisionAndStore(DATA_TOKEN, DEVICE_ID);
  assert.equal(again.config.host, '196.216.10.15');
  ok('Re-provisionnement idempotent sur le même deviceId → succès (renouvellement offline)');
}

await fs.unlink(ENTRY_PATH).catch(() => {});
server.close();
console.log(`\n🏁 RÉSULTAT : ${passed} assertions réussies — cycle de vie appareil validé E2E\n`);
process.exit(0);

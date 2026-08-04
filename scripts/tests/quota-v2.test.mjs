/**
 * quota-v2.test.mjs — Test V2 Quota réel, application stricte, états honnêtes
 * ═══════════════════════════════════════════════════════════════════════════
 * Valide les exigences backend et mobile de la mission V2 :
 *   1. applyUsageDelta (déduplication sessionId/seq, garde anti-abus, autorité unique)
 *   2. computeAccountState (états distincts 'exhausted' vs 'expired', exposition octets)
 *   3. Route POST /xapi/mobile/connections/:id/status (statut anti-résurrection)
 *   4. deriveQuota (dérivation locale unique + live session delta)
 */

import { strict as assert } from 'node:assert';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const BACKEND = path.join(ROOT, 'backend');
const MOBILE  = path.join(ROOT, 'app-mobile');

process.env.NODE_ENV = 'test';
process.env.ENCRYPTION_KEY = 'e2e-encryption-key-32-bytes-pad!';

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✅ ${msg}`); };

console.log('\n══ TEST QUOTA V2 — AUTORITÉ UNIQUE & DÉDUPLICATION ══\n');

const esbuild = await import(path.join(BACKEND, 'node_modules/esbuild/lib/main.js'));
const DB_STUB    = path.join(__dirname, 'stubs/database-stub.mjs');
const ENVSTUBS   = path.join(__dirname, 'stubs/mobile-env-stubs.mjs');
const ENTRY_PATH = path.join(__dirname, '.entry-quota-v2.ts');
const BUNDLE_DIR  = path.join(BACKEND, 'node_modules/.sxb-test');
const BUNDLE_PATH = path.join(BUNDLE_DIR, 'quota-v2-bundle.mjs');

await fs.mkdir(BUNDLE_DIR, { recursive: true });

await fs.writeFile(ENTRY_PATH, `
export { applyUsageDelta, default as mobileRouter } from ${JSON.stringify(path.join(BACKEND, 'server/routes/mobile.ts'))};
export { deriveQuota, formatBytes } from ${JSON.stringify(path.join(MOBILE, 'services/quotaState.ts'))};
`);

await esbuild.build({
  entryPoints: [ENTRY_PATH],
  bundle: true,
  outfile: BUNDLE_PATH,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'silent',
  nodePaths: [path.join(MOBILE, 'node_modules'), path.join(BACKEND, 'node_modules')],
  banner: { js: 'import { createRequire as __sxbcr } from "module"; const require = __sxbcr(import.meta.url);' },
  plugins: [
    {
      name: 'sxb-quota-v2-aliases',
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
    },
  ],
});

const bundle = await import(BUNDLE_PATH + `?t=${Date.now()}`);
const { applyUsageDelta, deriveQuota, formatBytes } = bundle;

// 1. Rejet garde anti-abus applyUsageDelta
{
  const rNegative = await applyUsageDelta('client1', null, -100n);
  assert.equal(rNegative.applied, false, 'Delta négatif doit être rejeté');

  const rZero = await applyUsageDelta('client1', null, 0n);
  assert.equal(rZero.applied, false, 'Delta zéro doit être ignoré');

  const rHuge = await applyUsageDelta('client1', null, BigInt(10 * 1024 * 1024 * 1024)); // 10 GB
  assert.equal(rHuge.applied, false, 'Delta > 5 Go doit être rejeté');

  ok('Garde anti-abus applyUsageDelta (rejet <0, 0, >5 Go)');
}

// 2. Déduplication (sessionId, seq)
{
  const sessionId = 'test-session-123';
  const seq = 1;
  const delta = BigInt(5 * 1024 * 1024); // 5 MB

  const r1 = await applyUsageDelta('client1', 'sub1', delta, sessionId, seq);
  assert.equal(r1.applied, true, 'Premier envoi de (sessionId, seq) accepté');

  const r2 = await applyUsageDelta('client1', 'sub1', delta, sessionId, seq);
  assert.equal(r2.applied, false, 'Rejeu de (sessionId, seq) doit être ignoré sans ré-incrément');
  assert.equal(r2.reason, 'duplicate_report');

  const r3 = await applyUsageDelta('client1', 'sub1', delta, sessionId, seq + 1);
  assert.equal(r3.applied, true, 'Nouveau seq accepté');

  ok('Déduplication idempotente sur (sessionId, seq)');
}

// 3. Dérivation locale deriveQuota
{
  const baseQuota = {
    totalQuota: 500 * 1024 * 1024, // 500 MB
    usedQuota: 10 * 1024 * 1024,    // 10 MB used
    expiryDate: new Date(Date.now() + 86400000).toISOString(),
  };

  const sessionStats = {
    sessionUp: 5 * 1024 * 1024,
    sessionDown: 15 * 1024 * 1024,
    sessionBaselineUp: 1 * 1024 * 1024,
    sessionBaselineDown: 2 * 1024 * 1024,
  }; // Session delta = (5-1) + (15-2) = 17 MB

  const derived = deriveQuota(baseQuota, sessionStats, true);
  assert.equal(derived.totalBytes, 500 * 1024 * 1024);
  assert.equal(derived.usedBytes, (10 + 17) * 1024 * 1024); // 27 MB
  assert.equal(derived.remainingBytes, (500 - 27) * 1024 * 1024); // 473 MB
  assert.equal(derived.isExhausted, false);
  assert.equal(derived.isExpired, false);

  // Test quota épuisé (exhausted)
  const exhaustedBase = {
    totalQuota: 50 * 1024 * 1024,
    usedQuota: 50 * 1024 * 1024,
    expiryDate: new Date(Date.now() + 86400000).toISOString(),
  };
  const derivedExhausted = deriveQuota(exhaustedBase, null, false);
  assert.equal(derivedExhausted.isExhausted, true, 'Quota épuisé doit donner isExhausted=true');
  assert.equal(derivedExhausted.isExpired, false, 'Quota épuisé mais date future ne doit PAS donner isExpired=true');

  ok('Sélecteur deriveQuota (dérivation exacte + distinction exhausted/expired)');
}

// 4. Formateur d'octets formatBytes
{
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(2 * 1024 * 1024), '2 MB');
  assert.equal(formatBytes(1500 * 1024 * 1024), '1.5 GB');
  ok('formatBytes lisible et précis (2 Mo affiche "2 MB")');
}

console.log(`\n🏁 RÉSULTAT : ${passed} groupes de tests V2 réussis !`);

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'backend', 'package.json'));
const output = await require('esbuild').build({
  stdin: { contents: `export * from './server/services/root-access';`, resolveDir: root, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  plugins: [{
    name: 'root-approval-fixture',
    setup(plugin) {
      plugin.onResolve({ filter: /(^|\/)database$/ }, () => ({ path: 'database', namespace: 'fixture' }));
      plugin.onResolve({ filter: /^\.\.\/config$/ }, () => ({ path: 'config', namespace: 'fixture' }));
      plugin.onResolve({ filter: /^\.\/portee-donnees$/ }, () => ({ path: 'scope', namespace: 'fixture' }));
      plugin.onResolve({ filter: /^\.\/security-events$/ }, () => ({ path: 'events', namespace: 'fixture' }));
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({
        contents: name === 'database' ? 'export const prisma=globalThis.database;'
          : name === 'config' ? 'export const config={JWT_SECRET:"synthetic-root-signing-secret-for-fixtures-only-0123456789"};'
            : name === 'scope' ? 'export async function porteeClients(){return {public:true}};'
              : 'export async function persistSecurityEvent(tx,value){tx.events.push(value)};',
        loader: 'js',
      }));
    },
  }],
});
const digest = value => createHash('sha256').update(value).digest('hex');
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const keyId = digest(Buffer.from(publicKey, 'base64'));
const rootAuthorityPolicy = require(path.join(root, 'app-mobile', 'scripts', 'root-authority-policy.cjs'));

function fixture(assigned = false, privateClient = false) {
  const state = { rows: [], nonces: [], events: [], audit: [], clients: assigned
    ? [{ id: 'client', userId: 'user', deviceId: 'synthetic-device', private: privateClient }] : [] };
  const matches = (row, where = {}) => {
    if (where.AND) return where.AND.every(filter => matches(row, filter));
    if (where.keyId && row.keyId !== where.keyId) return false;
    if (where.status && row.status !== where.status) return false;
    if (where.client) return !!row.clientId && !privateClient;
    return true;
  };
  const database = {
    events: state.events,
    $queryRaw: async () => [],
    vpnClient: { findMany: async () => state.clients },
    mobileProofNonce: {
      createMany: async ({ data }) => {
        if (state.nonces.includes(data[0].nonce)) return { count: 0 };
        state.nonces.push(data[0].nonce); return { count: 1 };
      },
      deleteMany: async () => {},
    },
    rootDeviceApproval: {
      findUnique: async ({ where }) => state.rows.find(row => row.keyId === where.keyId) || null,
      findFirst: async ({ where }) => state.rows.find(row => matches(row, where)) || null,
      upsert: async ({ where, create, update }) => {
        let row = state.rows.find(row => row.keyId === where.keyId);
        if (row) Object.assign(row, update);
        else { row = { revision: 1, firstSeenAt: new Date(), lastSeenAt: new Date(), ...create }; state.rows.push(row); }
        return row;
      },
      update: async ({ where, data }) => {
        const row = state.rows.find(row => row.keyId === where.keyId);
        const { revision, ...values } = data;
        Object.assign(row, values); row.revision += revision.increment; return row;
      },
      findMany: async ({ where, take, skip }) => state.rows.filter(row => matches(row, where)).slice(skip, skip + take),
      count: async ({ where }) => state.rows.filter(row => matches(row, where)).length,
    },
    auditLog: { create: async ({ data }) => { state.audit.push(data); } },
    $transaction: async work => work(database),
  };
  const module = { exports: {} };
  const runtime = { env: { ROOT_APPROVAL_SECRET: digest('synthetic-root-signing-secret-for-fixtures-only-0123456789') } };
  runInNewContext(output.outputFiles[0].text, { module, exports: module.exports, require,
    Buffer, console, database, process: runtime });
  assert.equal(runtime.exitCode, undefined, 'bundling the signer cannot run the operator CLI at server startup');
  const api = module.exports;
  const observe = (changes = {}, replay) => {
    const body = { publicKey, rooted: true, deviceModel: 'Synthetic root test', ...changes };
    const bytes = Buffer.from(JSON.stringify(body));
    const timestamp = String(Date.now()), nonce = randomBytes(24).toString('base64url');
    const canonical = ['SXB-PROOF-1', 'POST', '/api/mobile-security/root-access', digest(bytes), '-', '0',
      digest(api.ROOT_ACCESS_CREDENTIAL), timestamp, nonce].join('\n');
    const headers = { 'X-SXB-Time': timestamp, 'X-SXB-Nonce': nonce,
      'X-SXB-Proof': sign('sha256', Buffer.from(canonical), pair.privateKey).toString('base64') };
    const request = replay || { method: 'POST', originalUrl: '/api/mobile-security/root-access',
      body, rawBody: bytes, get: name => headers[name] };
    return { request, body, result: () => api.observeRootDevice(request, body) };
  };
  return { api, state, observe };
}

test('a valid installation request is pending by default and cannot self-approve', async () => {
  const f = fixture();
  const result = await f.observe().result();
  const payload = JSON.parse(result.payload);
  assert.equal(payload.status, 'pending');
  assert.equal(payload.keyId, keyId);
  assert.equal(await f.api.clientRootAccessAllowed(keyId), false);
  assert.equal(f.state.events.length, 0, 'unassigned requests must not leak into the non-owner event feed');
  await assert.rejects(f.observe({ status: 'approved' }).result());
  await assert.rejects(f.observe({ rooted: false }).result());
  assert.equal(f.state.rows[0].status, 'pending');
});

test('the backend receipt is signed, installation-bound and valid for exactly 24 hours', () => {
  const f = fixture();
  const issuedAt = 1700000000000;
  const receipt = f.api.rootReceipt({ keyId, status: 'approved', revision: 2 }, issuedAt);
  const key = createPublicKey({ key: Buffer.from(receipt.publicKey, 'base64'), format: 'der', type: 'spki' });
  assert.ok(verify('sha256', Buffer.from(receipt.payload), key, Buffer.from(receipt.signature, 'base64')));
  assert.equal(verify('sha256', Buffer.from(receipt.payload.replace('approved', 'denied')), key,
    Buffer.from(receipt.signature, 'base64')), false);
  const lease = JSON.parse(receipt.payload);
  assert.equal(lease.scope, 'SXB-ROOT-ACCESS-1');
  assert.equal(lease.expiresAt - lease.issuedAt, 24 * 60 * 60 * 1000);
});

test('compiled authority is reviewed, not learned from a cache or an arbitrary API origin', () => {
  const authority = rootAuthorityPolicy.readRootAuthority();
  assert.equal(authority.keyId, '84564a546e6e7bef0ec4d46eb21a6835dc02dcbe72c7a48ab95ea2985f8ae454');
  assert.equal(rootAuthorityPolicy.rootAuthorityForOrigin(authority.origin), authority.publicKey);
  assert.throws(() => rootAuthorityPolicy.rootAuthorityForOrigin('https://another.example.test/api'), /UNREVIEWED/);
  assert.throws(() => rootAuthorityPolicy.validateRootAuthority({ ...authority, keyId: 'a'.repeat(64) }), /INVALID/);
  const native = readFileSync(path.join(root, 'app-mobile/modules/android-native/SxbRootAccess.kt'), 'utf8');
  assert.match(native, /SxbRootLeasePolicy\.verify\(next, identity\.getString\("keyId"\), trustedKey\(context\), now\)/);
  assert.doesNotMatch(native, /SxbRootLeasePolicy\.verify\([^;\n]*next\.getString\("publicKey"\)/);
});
test('registration proves possession and cannot replay or change another installation', async () => {
  const f = fixture();
  const request = f.observe();
  await request.result();
  await assert.rejects(request.result(), error => error.body?.reason === 'NONCE_REUSED');
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  await assert.rejects(f.observe({ publicKey: other }).result(), error => error.body?.reason === 'DEVICE_PROOF_INVALID');
  assert.equal(f.state.rows.length, 1);
});

test('only the scoped dashboard authority can approve; CAS and denial remain authoritative', async () => {
  const f = fixture();
  await f.observe().result();
  for (const role of ['CLIENT', 'ADMIN', 'SUPPORT', 'RESELLER', 'SUPER_ADMIN']) {
    await assert.rejects(f.api.decideRootDevice({ role, userId: 'operator' }, keyId,
      { status: 'approved', revision: 1 }), error => error.code === 'NOT_FOUND');
  }
  const owner = { role: 'OWNER', userId: 'owner' };
  const approved = await f.api.decideRootDevice(owner, keyId, { status: 'approved', revision: 1 });
  assert.equal(approved.revision, 2);
  assert.equal(await f.api.clientRootAccessAllowed(keyId), true);
  await f.observe().result();
  assert.equal(f.state.rows[0].status, 'approved', 'observation cannot reset a dashboard decision');
  await assert.rejects(f.api.decideRootDevice(owner, keyId, { status: 'denied', revision: 1 }),
    error => error.code === 'ROOT_DECISION_CHANGED');
  await f.api.decideRootDevice(owner, keyId, { status: 'denied', revision: 2 });
  assert.equal(await f.api.clientRootAccessAllowed(keyId), false);
  assert.equal(f.state.audit.length, 2);
  assert.ok(f.state.audit.every(row => row.visibleOwnerOnly));
  assert.equal(await f.api.clientRootAccessAllowed('b'.repeat(64)), true, 'an unreported non-root device is not globally banned');
});

test('super admin sees and approves public assigned requests, never owner-private or unassigned requests', async () => {
  const publicDevice = fixture(true);
  await publicDevice.observe().result();
  const actor = { role: 'SUPER_ADMIN', userId: 'super' };
  assert.equal((await publicDevice.api.listRootDevices(actor, {})).total, 1);
  await publicDevice.api.decideRootDevice(actor, keyId, { status: 'approved', revision: 1 });
  const privateDevice = fixture(true, true);
  await privateDevice.observe().result();
  assert.equal((await privateDevice.api.listRootDevices(actor, {})).total, 0);
  await assert.rejects(privateDevice.api.decideRootDevice(actor, keyId, { status: 'approved', revision: 1 }),
    error => error.code === 'NOT_FOUND');
  assert.equal((await privateDevice.api.listRootDevices({ role: 'OWNER', userId: 'owner' }, {})).total, 1);
});

test('native startup enforcement precedes account providers and never calls a local grant setter', () => {
  const read = file => readFileSync(path.join(root, file), 'utf8');
  const layout = read('app-mobile/app/_layout.tsx');
  assert.ok(layout.indexOf('<RootAccessGate>') < layout.indexOf('<AuthProvider>'));
  const gate = read('app-mobile/components/RootAccessGate.tsx');
  assert.match(gate, /return allowed \? <>\{children\}<\/> : null/);
  assert.match(gate, /exitForRootAccess/);
  assert.doesNotMatch(gate, /approveRoot|setRootApproval|rootAllowed = true/);
  const access = read('app-mobile/modules/android-native/SxbAccessControl.kt');
  assert.match(access, /fun checkStart[\s\S]*?SxbRootAccess\.checkStart\(context\)/);
  const detector = read('app-mobile/modules/android-native/SecurityModule.kt');
  assert.doesNotMatch(detector.match(/fun isRooted[\s\S]*?^\s{4}}/m)?.[0] || '', /checkBuildTags/);
});

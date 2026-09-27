/**
 * Real PostgreSQL + real Express handlers. All records below are synthetic TEST fixtures.
 * Requires SXB_SECURITY_TEST_DATABASE_URL (loopback *_security_* DB) and an isolated generated
 * SXB_SECURITY_PRISMA_CLIENT. Never loads production credentials or starts the full server.
 */
import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import { generateKeyPairSync, createHash, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const url = new URL(process.env.SXB_SECURITY_TEST_DATABASE_URL ?? 'http://invalid');
assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && /security_(impl|upgrade)/.test(url.pathname),
  'An explicitly isolated loopback PostgreSQL test database is required');
assert.ok(process.env.SXB_SECURITY_PRISMA_CLIENT, 'Generate the test Prisma client outside shared node_modules');
url.searchParams.set('connection_limit', '4');
url.searchParams.set('connect_timeout', '20');
url.searchParams.set('pool_timeout', '30');
process.env.DATABASE_URL = url.toString();
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'synthetic-security-test-access-secret-not-production-0123456789';
process.env.REFRESH_SECRET = 'synthetic-security-test-refresh-secret-not-production-0123456789';
process.env.ENCRYPTION_KEY = 'synthetic-test-key'.padEnd(32, 'x');
process.env.NODE_PATH = path.join(root, 'backend', 'node_modules');
Module._initPaths();
const require = createRequire(path.join(root, 'backend', 'package.json'));
const { build } = require('esbuild');
const express = require('express');
const jwt = require('jsonwebtoken');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'sxb-security-test-'));
process.once('exit', () => rmSync(scratch, { recursive: true, force: true }));
const output = path.join(scratch, 'handlers.cjs');
await build({
  stdin: { contents: `
    export { default as mobile } from './server/routes/mobile';
    export { default as events } from './server/routes/mobile-security';
    export { default as provision } from './server/routes/provision';
    export { default as consoleRoutes } from './server/routes/security';
    export { default as scopedSessions } from './server/routes/sessions';
    export { prisma } from './server/database';
    export * as sessions from './server/services/mobile-session-security';
    export * as proof from './server/services/mobile-proof';
    export * as gate from './server/services/security-gate';
  `, resolveDir: root, loader: 'ts' },
  outfile: output, platform: 'node', format: 'cjs', bundle: true, packages: 'external',
  nodePaths: [path.join(root, 'backend', 'node_modules')], logLevel: 'silent',
  plugins: [{
    name: 'isolated-prisma-client',
    setup(b) {
      b.onResolve({ filter: /^@prisma\/client$/ }, () => ({
        path: path.resolve(process.env.SXB_SECURITY_PRISMA_CLIENT), external: true,
      }));
    },
  }],
});
const { mobile, events, provision, consoleRoutes, scopedSessions, prisma, sessions, proof, gate } = require(output);
const app = express();
app.use(express.json({ verify: (req, _res, bytes) => { req.rawBody = Buffer.from(bytes); } }));
app.use('/api/mobile', mobile);
app.use('/api/mobile-security', events);
app.use('/api/provision', provision);
app.use('/api/security', consoleRoutes);
app.use('/api/sessions', scopedSessions);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (resource, options) => {
  const endpoint = new URL(typeof resource === 'string' ? resource : resource.url);
  assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'External network is forbidden in this suite');
  return nativeFetch(resource, options);
};
const suffix = randomUUID();
const ids = {};
const hash = value => createHash('sha256').update(value).digest('hex');
function device() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { ...pair, id: `SXB${randomBytes(10).toString('hex').toUpperCase()}`,
    encoded: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
}
function headers(actor, method, target, body, credential, overrides = {}) {
  const claims = credential.split('.').length === 3 ? jwt.decode(credential) : {};
  const time = String(Date.now()), nonce = randomBytes(24).toString('base64url');
  const canonical = ['SXB-PROOF-1', method, target, hash(body), claims.sid ?? '-', String(claims.sg ?? 0),
    hash(credential), time, nonce].join('\n');
  return {
    'Content-Type': 'application/json', Authorization: `Bearer ${credential}`,
    'X-SXB-Device-ID': actor.id, 'X-SXB-Time': time, 'X-SXB-Nonce': nonce,
    'X-SXB-Proof': sign('sha256', Buffer.from(canonical), actor.privateKey).toString('base64'), ...overrides,
  };
}
async function request(actor, target, value, credential, options = {}) {
  const method = options.method ?? (value === undefined ? 'GET' : 'POST');
  const body = value === undefined ? '' : JSON.stringify(value);
  const response = await fetch(base + target, {
    method, headers: options.headers ?? headers(actor, method, target, body, credential),
    ...(body ? { body } : {}),
  });
  return { status: response.status, data: await response.json() };
}
let checks = 0;
function check(name, actual, expected) { assert.equal(actual, expected, name); checks++; console.log(`PASS ${name}`); }
try {
  const role = await prisma.role.upsert({ where: { name: 'CLIENT' }, create: { name: 'CLIENT' }, update: {} });
  const a = device(), b = device();
  for (const [index, actor] of [[0, a], [1, b]]) {
    const user = await prisma.user.create({ data: {
      name: `SYNTHETIC SECURITY TEST ${index}`, email: `security-${suffix}-${index}@example.invalid`,
      passwordHash: 'not-a-real-login-hash', roleId: role.id,
    } });
    const client = await prisma.vpnClient.create({ data: { userId: user.id, token: `SXB-USER-TEST-${suffix}-${index}` } });
    actor.client = client;
    ids[index] = { userId: user.id, clientId: client.id };
    const body = { token: client.token, deviceId: actor.id, publicKey: actor.encoded, activationRequestId: randomUUID() };
    const activated = await request(actor, '/api/mobile/auth/activate', body, client.token);
    check(`trusted activation ${index}`, activated.status, 200);
    actor.tokens = activated.data;
    const retried = await request(actor, '/api/mobile/auth/activate', body, client.token);
    check(`activation response-loss retry is idempotent ${index}`, retried.data.refreshToken, actor.tokens.refreshToken);
  }
  for (const mixedLegacy of [false, true]) {
    const claimants = [device(), device()];
    claimants[1].id = claimants[0].id;
    const responses = await Promise.all(claimants.map(async (actor, index) => {
      const client = await prisma.vpnClient.create({ data: {
        userId: ids[0].userId, token: `SXB-USER-TEST-${suffix}-claim-${mixedLegacy}-${index}`,
      } });
      const body = { token: client.token, deviceId: actor.id,
        ...(!mixedLegacy || index === 0 ? { publicKey: actor.encoded, activationRequestId: randomUUID() } : {}) };
      return request(actor, '/api/mobile/auth/activate', body, client.token);
    }));
    check(`concurrent ${mixedLegacy ? 'mixed legacy/bound' : 'bound'} claim has one winner`,
      responses.filter(item => item.status === 200).length, 1);
    check(`concurrent ${mixedLegacy ? 'mixed legacy/bound' : 'bound'} claim refuses the loser`,
      responses.filter(item => item.status === 409).length, 1);
    check(`concurrent claim persists one device association (${mixedLegacy})`,
      await prisma.vpnClient.count({ where: { userId: ids[0].userId, deviceId: claimants[0].id } }), 1);
  }
  const me = '/api/mobile/me';
  const token = a.tokens.accessToken;
  check('bound access accepted', (await request(a, me, undefined, token)).status, 200);
  check('expired proof rejected', (await request(a, me, undefined, token, {
    headers: headers(a, 'GET', me, '', token, { 'X-SXB-Time': String(Date.now() - 120000) }),
  })).data.reason, 'PROOF_EXPIRED');
  check('future proof rejected', (await request(a, me, undefined, token, {
    headers: headers(a, 'GET', me, '', token, { 'X-SXB-Time': String(Date.now() + 120000) }),
  })).status, 401);
  check('exact path and query are authenticated', (await request(a, me + '?subscriptionId=changed', undefined, token, {
    headers: headers(a, 'GET', me, '', token),
  })).data.reason, 'DEVICE_PROOF_INVALID');
  check('existing key cannot be replaced with stolen activation token', (await request(b, '/api/mobile/auth/activate', {
    token: a.client.token, deviceId: a.id, publicKey: b.encoded, activationRequestId: randomUUID(),
  }, a.client.token)).status, 409);
  check('enrolled client cannot downgrade to old activation', (await request(a, '/api/mobile/auth/activate', {
    token: a.client.token, deviceId: a.id,
  }, a.client.token)).status, 409);
  const unsigned = await fetch(base + me, { headers: { Authorization: `Bearer ${token}`, 'X-SXB-Device-ID': a.id } });
  check('stolen bearer without proof denied', unsigned.status, 401);
  check('stolen bearer and forged device header denied', (await request(b, me, undefined, token, {
    headers: headers(b, 'GET', me, '', token, { 'X-SXB-Device-ID': a.id }),
  })).status, 401);
  const repeated = headers(a, 'GET', me, '', token);
  const parallel = await Promise.all(Array.from({ length: 8 }, () => request(a, me, undefined, token, { headers: repeated })));
  check('one concurrent nonce accepted', parallel.filter(item => item.status === 200).length, 1);
  check('seven concurrent nonce replays rejected', parallel.filter(item => item.status === 409).length, 7);
  const rollbackNonce = { keyId: hash(a.publicKey.export({ format: 'der', type: 'spki' })),
    nonce: randomBytes(24).toString('base64url'), expiresAt: new Date(Date.now() + 60_000) };
  await assert.rejects(prisma.$transaction(async tx => { await proof.consumeProof(tx, rollbackNonce); throw new Error('TEST_ROLLBACK'); }));
  check('nonce mutation rolls back atomically', await prisma.mobileProofNonce.count({ where: { nonce: rollbackNonce.nonce } }), 0);
  const refreshTarget = '/api/mobile/auth/refresh';
  const rotated = await Promise.all(Array.from({ length: 8 }, () =>
    request(a, refreshTarget, { refreshToken: a.tokens.refreshToken }, a.tokens.refreshToken)));
  check('parallel refresh retries accepted', rotated.filter(item => item.status === 200).length, 8);
  check('parallel refresh gives one deterministic successor', new Set(rotated.map(item => item.data.refreshToken)).size, 1);
  const oldRefresh = a.tokens.refreshToken;
  a.tokens = rotated[0].data;
  await prisma.activationSession.update({ where: { id: a.tokens.security.sessionId }, data: { refreshRetryUntil: new Date(0) } });
  check('late refresh retry is refused precisely', (await request(a, refreshTarget, { refreshToken: oldRefresh }, oldRefresh)).data.reason, 'REFRESH_RETRY_EXPIRED');
  check('late retry never revokes the current family', (await request(a, me, undefined, a.tokens.accessToken)).status, 200);
  const profile = await prisma.vpnProfile.create({ data: {
    name: 'SYNTHETIC TEST PROFILE', protocol: 'ssh', host: 'test.invalid', port: 22, network: 'tcp',
  } });
  ids.profileId = profile.id;
  const sub = await prisma.subscription.create({ data: {
    name: 'SYNTHETIC 1GiB TEST PLAN', clientId: a.client.id, profileId: profile.id,
    dataToken: `SXB-DATA-TEST-${suffix}`.toUpperCase(), durationDays: 30, quotaBytes: 1073741824n,
    deviceId: a.id,
  } });
  ids.subscriptionId = sub.id;
  const connection = { action: 'connect', connectionId: randomUUID(), sessionId: `sess_${randomUUID()}`,
    subscriptionId: sub.id, configId: profile.id };
  check('server authorizes managed attribution', (await request(a, '/api/mobile/vpn/session', connection, a.tokens.accessToken)).status, 200);
  check('connection metadata cannot be rewritten as manual', (await request(a, '/api/mobile/vpn/session',
    { ...connection, subscriptionId: null }, a.tokens.accessToken)).status, 409);
  const invalidConnection = { ...connection, connectionId: randomUUID(), sessionId: `sess_${randomUUID()}`, subscriptionId: randomUUID() };
  const rollbackHeaders = headers(a, 'POST', '/api/mobile/vpn/session', JSON.stringify(invalidConnection), a.tokens.accessToken);
  check('unauthorized association denied', (await request(a, '/api/mobile/vpn/session', invalidConnection, a.tokens.accessToken,
    { headers: rollbackHeaders })).status, 403);
  check('failed connection and nonce roll back together', await prisma.mobileProofNonce.count({
    where: { nonce: rollbackHeaders['X-SXB-Nonce'] },
  }), 0);
  const signedBody = headers(a, 'POST', '/api/mobile/vpn/session', JSON.stringify(connection), a.tokens.accessToken);
  check('exact body bytes are authenticated', (await request(a, '/api/mobile/vpn/session',
    { ...connection, action: 'disconnect' }, a.tokens.accessToken, { headers: signedBody })).data.reason, 'DEVICE_PROOF_INVALID');
  const report = { bytesUp: 0, bytesDown: 2147483648, sessionId: connection.sessionId, seq: 0,
    reportMode: 'unlinked', deviceId: a.id };
  check('managed report cannot become unlinked', (await request(a, '/api/mobile/vpn/traffic', report, a.tokens.accessToken)).status, 409);
  const validReport = { ...report, reportMode: 'delta', subscriptionId: sub.id };
  const reports = await Promise.all(Array.from({ length: 6 }, () =>
    request(a, '/api/mobile/vpn/traffic', validReport, a.tokens.accessToken)));
  check('concurrent accounting retries accepted', reports.filter(item => item.status === 200).length, 6);
  check('managed subscription debited exactly once', (await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).quotaUsed, 2147483648n);
  check('quota exhaustion reflected by actual handler', reports.every(item => item.data.state === 'exhausted'), true);
  const manual = { ...connection, connectionId: randomUUID(), sessionId: `sess_${randomUUID()}`, subscriptionId: null, configId: 'manual-test' };
  check('genuine manual connection retained', (await request(a, '/api/mobile/vpn/session', manual, a.tokens.accessToken)).status, 200);
  check('genuine manual telemetry retained', (await request(a, '/api/mobile/vpn/traffic',
    { ...report, bytesDown: 100, sessionId: manual.sessionId }, a.tokens.accessToken)).status, 200);
  check('manual telemetry does not choose latest subscription', (await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).quotaUsed, 2147483648n);
  check('cross-user private config denied', (await request(b, '/api/provision/activate',
    { dataToken: sub.dataToken, deviceId: b.id }, b.tokens.accessToken)).status, 404);
  const currentClaims = jwt.decode(a.tokens.accessToken);
  const oldGeneration = currentClaims.sg;
  const newActivation = await request(a, '/api/mobile/auth/activate', {
    token: a.client.token, deviceId: a.id, publicKey: a.encoded, activationRequestId: randomUUID(),
  }, a.client.token);
  check('explicit signed reactivation creates new generation', newActivation.status, 200);
  a.tokens = newActivation.data;
  check('old auth generation cannot access after reactivation', (await request(a, me, undefined, token)).status, 401);
  check('new auth generation reconnects normally', (await request(a, '/api/mobile/vpn/session',
    { ...manual, connectionId: randomUUID(), sessionId: `sess_${randomUUID()}` }, a.tokens.accessToken)).status, 200);
  check('delayed frozen report retains original association after login', (await request(a, '/api/mobile/vpn/traffic',
    { ...validReport, bytesDown: 100, seq: 1 }, a.tokens.accessToken)).data.subscriptionId, sub.id);
  const oldEvent = { id: randomUUID(), eventType: 'VPN_REVOKED', timestamp: Date.now(),
    connectionId: connection.connectionId, securitySessionId: currentClaims.sid, securityGeneration: oldGeneration };
  check('delayed VPN permission loss accepted', (await request(a, '/api/mobile-security/events', { events: [oldEvent] }, a.tokens.accessToken)).status, 202);
  check('duplicate offline revoke acknowledged', (await request(a, '/api/mobile-security/events', { events: [oldEvent] }, a.tokens.accessToken)).status, 202);
  check('offline revoke has one persisted event', await prisma.securityEvent.count({ where: { eventKey: `${a.client.id}:${oldEvent.id}` } }), 1);
  check('another identity cannot submit original authority event', (await request(b, '/api/mobile-security/events',
    { events: [{ ...oldEvent, id: randomUUID() }] }, b.tokens.accessToken)).status, 403);
  const live = await prisma.activationSession.findUniqueOrThrow({ where: { id: currentClaims.sid } });
  check('old VPN event does not revoke new auth generation', live.authRevokedAt, null);
  check('ordinary revoke preserves account', (await prisma.vpnClient.findUniqueOrThrow({ where: { id: a.client.id } })).status, 'active');
  check('ordinary revoke preserves login', (await request(a, me, undefined, a.tokens.accessToken)).status, 200);
  check('root-only signal remains permitted', (await request(a, '/api/mobile-security/report',
    { signals: { rooted: true } }, a.tokens.accessToken)).status, 202);
  check('root-only observed level is LOW', (await prisma.securityEvent.findFirst({
    where: { userId: a.client.userId, eventType: 'ROOT_DETECTED' }, orderBy: { createdAt: 'desc' },
  })).riskLevel, 'LOW');
  check('combined client heuristics remain nonblocking', (await request(a, '/api/mobile-security/report',
    { signals: { rooted: true, frida: true, xposed: true, signatureInvalid: true } }, a.tokens.accessToken)).status, 202);
  check('high observations do not suspend account', (await prisma.vpnClient.findUniqueOrThrow({ where: { id: a.client.id } })).status, 'active');
  const operators = [];
  for (const roleName of ['OWNER', 'ADMIN', 'SUPPORT']) {
    const operatorRole = await prisma.role.upsert({ where: { name: roleName }, create: { name: roleName }, update: {} });
    for (const permissionName of ['clients.view', 'clients.manage']) {
      const permission = await prisma.permission.upsert({ where: { name: permissionName }, create: { name: permissionName }, update: {} });
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: operatorRole.id, permissionId: permission.id } },
        create: { roleId: operatorRole.id, permissionId: permission.id }, update: {},
      });
    }
    const user = await prisma.user.create({ data: { name: `SYNTHETIC ${roleName}`, roleId: operatorRole.id,
      email: `${roleName}-${suffix}@example.invalid`, passwordHash: 'not-a-real-login-hash' } });
    operators.push({ user, token: jwt.sign({ userId: user.id, role: roleName }, process.env.JWT_SECRET, { expiresIn: '15m' }) });
  }
  const [owner, admin, support] = operators;
  await prisma.vpnClient.update({ where: { id: a.client.id }, data: { managedById: admin.user.id } });
  await prisma.vpnClient.update({ where: { id: b.client.id }, data: { managedById: owner.user.id } });
  const scopedPath = `/api/sessions/${live.id}/security-events`;
  const ownEvents = await request(a, scopedPath, undefined, admin.token);
  check('scoped ADMIN can read own session events', ownEvents.status, 200);
  check('scoped projection excludes metadata and identities', ownEvents.data.events.every(event =>
    !('metadata' in event) && !('userId' in event) && !('deviceId' in event)), true);
  check('ADMIN cannot read another operator session', (await request(a,
    `/api/sessions/${b.tokens.security.sessionId}/security-events`, undefined, admin.token)).status, 404);
  check('SUPPORT cannot see owner-managed session', (await request(a,
    `/api/sessions/${b.tokens.security.sessionId}/security-events`, undefined, support.token)).status, 404);
  check('SUPPORT cannot revoke even with manage permission', (await request(a,
    `/api/sessions/${live.id}/security-revoke`, { generation: live.authGeneration }, support.token)).status, 403);
  check('ADMIN cannot enter owner security console', (await request(a, '/api/security/policy', undefined, admin.token)).status, 404);
  check('owner console still requires short-lived unlock', (await request(a, '/api/security/policy', undefined, owner.token)).status, 423);
  await gate.writeSecurityGate('synthetic-local-gate-password', owner.user.id);
  const unlock = await request(a, '/api/security/gate/unlock', { password: 'synthetic-local-gate-password' }, owner.token);
  check('actual owner console unlock succeeds', unlock.status, 200);
  const policyHeaders = (method, target, value) => headers(a, method, target, value ? JSON.stringify(value) : '', owner.token,
    { 'X-SXB-Security-Unlock': unlock.data.unlockToken });
  const policy = await request(a, '/api/security/policy', undefined, owner.token, { headers: policyHeaders('GET', '/api/security/policy') });
  check('policy route is mounted independently of event reads', policy.status, 200);
  const changedPolicy = { ...policy.data, version: policy.data.version + 1 };
  const updates = await Promise.all(Array.from({ length: 4 }, () => request(a, '/api/security/policy', changedPolicy, owner.token, {
    method: 'PUT', headers: policyHeaders('PUT', '/api/security/policy', changedPolicy),
  })));
  check('concurrent policy edit has one winner', updates.filter(item => item.status === 200).length, 1);
  check('concurrent stale policy edits are explicit conflicts', updates.filter(item => item.status === 409).length, 3);
  const invalidFilter = '/api/security/events?from=not-a-date';
  check('invalid console date filter rejected', (await request(a, invalidFilter, undefined, owner.token,
    { headers: policyHeaders('GET', invalidFilter) })).status, 400);
  const c = device();
  const legacyUser = await prisma.user.create({ data: { name: 'SYNTHETIC LEGACY DEVICE', roleId: role.id,
    email: `legacy-${suffix}@example.invalid`, passwordHash: 'not-a-real-login-hash' } });
  c.client = await prisma.vpnClient.create({ data: { userId: legacyUser.id, token: `SXB-USER-LEGACY-${suffix}`,
    deviceId: c.id, activatedAt: new Date() } });
  const legacyAuth = await request(c, '/api/mobile/auth/activate', { token: c.client.token, deviceId: c.id }, c.client.token);
  check('legacy client coexists on additive backend', legacyAuth.status, 200);
  const legacyAccess = await fetch(base + me, {
    headers: { Authorization: `Bearer ${legacyAuth.data.accessToken}`, 'X-SXB-Device-ID': c.id },
  });
  check('unenrolled legacy access remains explicit', legacyAccess.status, 200);
  const enrollment = { token: c.client.token, deviceId: c.id, publicKey: c.encoded, activationRequestId: randomUUID() };
  check('activated legacy device requires authorized key enrollment', (await request(c, '/api/mobile/auth/activate', enrollment, c.client.token)).status, 409);
  const grantPath = `/api/security/devices/${c.client.id}/authorize-key`;
  const grant = { keyId: hash(c.publicKey.export({ format: 'der', type: 'spki' })) };
  check('owner authorizes exact public fingerprint', (await request(a, grantPath, grant, owner.token,
    { headers: policyHeaders('POST', grantPath, grant) })).status, 200);
  const enrolled = await request(c, '/api/mobile/auth/activate', enrollment, c.client.token);
  check('authorized legacy enrollment succeeds with possession proof', enrolled.status, 200);
  c.tokens = enrolled.data;
  check('old bearer cannot downgrade after enrollment', (await request(c, me, undefined, legacyAuth.data.accessToken)).status, 401);
  const replacement = { ...device(), id: c.id };
  const replaceGrant = { keyId: hash(replacement.publicKey.export({ format: 'der', type: 'spki' })) };
  check('key replacement is not a default authorization side effect', (await request(a, grantPath, replaceGrant, owner.token,
    { headers: policyHeaders('POST', grantPath, replaceGrant) })).status, 404);
  const authorizedReplacement = { ...replaceGrant, replaceExisting: true };
  check('explicit owner reset authorizes replacement fingerprint', (await request(a, grantPath, authorizedReplacement, owner.token,
    { headers: policyHeaders('POST', grantPath, authorizedReplacement) })).status, 200);
  const replaced = await request(replacement, '/api/mobile/auth/activate',
    { ...enrollment, publicKey: replacement.encoded }, c.client.token);
  check('authorized rebind succeeds', replaced.status, 200);
  check('key replacement increments generation even with reused activation ID', replaced.data.security.generation, c.tokens.security.generation + 1);
  check('previous installation key cannot authorize access', (await request(c, me, undefined, c.tokens.accessToken)).status, 401);
  check('replacement key can authorize new session', (await request(replacement, me, undefined, replaced.data.accessToken)).status, 200);
  let injectedOutage = false;
  prisma.$use(async (params, next) => {
    if (injectedOutage) throw new Error('SYNTHETIC_TEST_DB_OUTAGE');
    return next(params);
  });
  injectedOutage = true;
  const unavailable = await request(a, me, undefined, a.tokens.accessToken);
  injectedOutage = false;
  check('injected storage outage is explicit 503', unavailable.status, 503);
  check('storage outage does not revoke authority', (await request(a, me, undefined, a.tokens.accessToken)).status, 200);
  const failedEvent = { ...oldEvent, id: randomUUID(), eventType: 'VPN_STARTED' };
  const batch = { events: [failedEvent, { ...oldEvent, id: randomUUID(), connectionId: randomUUID() }] };
  const batchHeaders = headers(a, 'POST', '/api/mobile-security/events', JSON.stringify(batch), a.tokens.accessToken);
  check('mixed-authority event batch fails closed', (await request(a, '/api/mobile-security/events', batch, a.tokens.accessToken,
    { headers: batchHeaders })).status, 409);
  check('event batch mutation rolls back', await prisma.securityEvent.count({ where: { eventKey: `${a.client.id}:${failedEvent.id}` } }), 0);
  check('event batch nonce rolls back with mutation', await prisma.mobileProofNonce.count({ where: { nonce: batchHeaders['X-SXB-Nonce'] } }), 0);
  const activeSub = await prisma.subscription.create({ data: { name: 'SYNTHETIC PROVISIONING TEST',
    clientId: a.client.id, profileId: profile.id, dataToken: `SXB-DATA-ACTIVE-${suffix}`.toUpperCase(),
    durationDays: 30, quotaBytes: 1073741824n, deviceId: a.id,
  } });
  const provisioningBody = { dataToken: activeSub.dataToken, deviceId: a.id };
  const provisioningHeaders = headers(a, 'POST', '/api/provision/activate', JSON.stringify(provisioningBody), a.tokens.accessToken);
  const provisioned = await request(a, '/api/provision/activate', provisioningBody, a.tokens.accessToken, { headers: provisioningHeaders });
  check('bound provisioning succeeds with actual handler', provisioned.status, 200);
  check('provisioned content retains authenticated GCM envelope', provisioned.data.config.encryptedBlob.startsWith('gcm:'), true);
  check('provisioning replay cannot reuse its nonce', (await request(a, '/api/provision/activate',
    provisioningBody, a.tokens.accessToken, { headers: provisioningHeaders })).status, 409);
  check('session-only revoke ignores stale generation', (await request(a,
    `/api/sessions/${live.id}/security-revoke`, { generation: live.authGeneration - 1 }, admin.token)).data.revoked, false);
  const ticket = await request(a, '/api/mobile/access-ticket', {}, a.tokens.accessToken);
  check('bound observer ticket issued', ticket.status, 200);
  check('actual scoped admin revoke succeeds', (await request(a,
    `/api/sessions/${live.id}/security-revoke`, { generation: live.authGeneration }, admin.token)).data.revoked, true);
  check('revoked access denied', (await request(a, me, undefined, a.tokens.accessToken)).status, 401);
  check('revoked refresh cannot resurrect family', (await request(a, refreshTarget, { refreshToken: a.tokens.refreshToken }, a.tokens.refreshToken)).status, 401);
  check('revoked observer ticket denied', (await request(a, '/api/mobile/access-state', undefined, ticket.data.ticket)).status, 401);
  check('revoked provisioning denied', (await request(a, '/api/provision/activate', { dataToken: sub.dataToken, deviceId: a.id }, a.tokens.accessToken)).status, 401);
  console.log(`REAL_POSTGRES_SECURITY_CHECKS=${checks}`);
} finally {
  globalThis.fetch = nativeFetch;
  await new Promise(resolve => server.close(resolve));
  await prisma.$disconnect();
  rmSync(scratch, { recursive: true, force: true });
}

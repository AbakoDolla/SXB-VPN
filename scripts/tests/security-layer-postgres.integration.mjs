/**
 * Dedicated integration runner, deliberately outside the database-free *.test.mjs glob.
 * Real PostgreSQL + real Express handlers. All records below are synthetic TEST fixtures.
 * Requires SXB_SECURITY_TEST_DATABASE_URL (loopback *_security_* DB) and an isolated generated
 * SXB_SECURITY_PRISMA_CLIENT. Never loads production credentials or starts the full server.
 */
import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import { generateKeyPairSync, createHash, createDecipheriv, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
assert.ok(process.env.SXB_SECURITY_TEST_DATABASE_URL, 'An explicitly isolated loopback PostgreSQL test database is required');
const url = new URL(process.env.SXB_SECURITY_TEST_DATABASE_URL);
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
process.env.NODE_PATH = [path.join(root, 'backend', 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
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
    export { default as users } from './server/routes/users';
    export { default as auth } from './server/routes/auth';
    export { prisma } from './server/database';
    export { logDbActivity } from './server/database';
    export * as sessions from './server/services/mobile-session-security';
    export * as proof from './server/services/mobile-proof';
    export * as gate from './server/services/security-gate';
    export * as relay from './server/services/ssh-relay-auth';
    export * as canonical from './server/services/canonical-config';
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
const { mobile, events, provision, consoleRoutes, scopedSessions, users, auth, prisma, sessions, proof, gate, relay, canonical, logDbActivity } = require(output);
const app = express();
app.use(express.json({ verify: (req, _res, bytes) => { req.rawBody = Buffer.from(bytes); } }));
app.use('/api/mobile', mobile);
app.use('/api/mobile-security', events);
app.use('/api/provision', provision);
app.use('/api/security', consoleRoutes);
app.use('/api/sessions', scopedSessions);
app.use('/api/users', users);
app.use('/api/auth', auth);
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
  const provider = { protocol: 'ssh', host: 'provider.invalid', port: 22, username: 'synthetic-provider',
    password: 'synthetic-provider-password', fingerprint: 'SHA256:' + Buffer.alloc(32, 1).toString('base64') };
  const providerFields = value => ({
    canonicalConfig: canonical.encryptCanonical(JSON.stringify(value)),
    canonicalConfigHash: canonical.computeCanonicalHash(value),
  });
  await prisma.vpnProfile.update({ where: { id: profile.id }, data: providerFields(provider) });
  process.env.SXB_SSH_RELAY_PROFILE_IDS = profile.id;
  const provisionTarget = '/api/provision/activate';
  const provisionBody = { dataToken: sub.dataToken, deviceId: a.id };
  async function provisionWithCapability() {
    return request(a, provisionTarget, provisionBody, a.tokens.accessToken, {
      headers: headers(a, 'POST', provisionTarget, JSON.stringify(provisionBody), a.tokens.accessToken, { 'X-SXB-SSH-Relay': '1' }),
    });
  }
  function decryptProvision(response) {
    check('real encrypted provisioning succeeded', response.status, 200);
    const { encryptedBlob, configKey } = response.data.config;
    const [iv, ciphertext, tag] = encryptedBlob.slice(4).split(':').map(value => Buffer.from(value, 'hex'));
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(configKey, 'hex'), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString());
  }
  check('old native capability preserves direct provider configuration',
    decryptProvision(await request(a, provisionTarget, provisionBody, a.tokens.accessToken)).host, provider.host);
  const gateway = decryptProvision(await provisionWithCapability());
  check('new native receives only gateway host', gateway.host, 'sxb-gateway');
  check('metadata endpoint does not expose provider URI or SNI',
    (await request(a, `/api/mobile/vpn/config?subscriptionId=${sub.id}`, undefined, a.tokens.accessToken)).data.connectionUri, null);
  check('provider secrets never occur inside decrypted relay provision',
    /provider\.invalid|synthetic-provider/.test(JSON.stringify(gateway)), false);
  delete process.env.SXB_SSH_RELAY_PROFILE_IDS;
  check('capable native outside allowlist remains direct', decryptProvision(await provisionWithCapability()).host, provider.host);
  process.env.SXB_SSH_RELAY_PROFILE_IDS = profile.id;
  const { fingerprint, ...unpinned } = provider;
  await prisma.vpnProfile.update({ where: { id: profile.id }, data: providerFields(unpinned) });
  check('unverified upstream is explicitly refused', (await provisionWithCapability()).data.code, 'RELAY_PROFILE_NOT_READY');
  await prisma.vpnProfile.update({ where: { id: profile.id }, data: providerFields(provider) });
  const relayConnection = { action: 'connect', connectionId: randomUUID(), sessionId: `sess_${randomUUID()}`,
    subscriptionId: sub.id, configId: profile.id, relayTicket: gateway.sshRelay.ticket };
  check('relay connection registered', (await request(a, '/api/mobile/vpn/session', relayConnection, a.tokens.accessToken)).status, 200);
  check('relay registration retry remains valid', (await request(a, '/api/mobile/vpn/session', relayConnection, a.tokens.accessToken)).status, 200);
  const { relayTicket, ...directRetry } = relayConnection;
  check('relay registration cannot silently become direct', (await request(a, '/api/mobile/vpn/session', directRetry, a.tokens.accessToken)).status, 409);
  const upgradeUrl = `/api/mobile/ssh-relay?connectionId=${relayConnection.connectionId}`;
  const upgradeHeaders = headers(a, 'GET', upgradeUrl, '', relayTicket);
  const relayGrant = await relay.authorizeSshRelay({
    method: 'GET', url: upgradeUrl, socket: { remoteAddress: '127.0.0.1' },
    headers: Object.fromEntries(Object.entries(upgradeHeaders).map(([key, value]) => [key.toLowerCase(), value])),
  });
  await prisma.subscription.update({ where: { id: sub.id }, data: { quotaBytes: 1000n } });
  const reservations = await Promise.allSettled([relayGrant.account(600, 0), relayGrant.account(0, 600)]);
  check('real PostgreSQL quota locks allow only one concurrent reservation',
    reservations.filter(value => value.status === 'fulfilled').length, 1);
  check('real gateway debits exactly delivered allowance', (await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).quotaUsed, 600n);
  const relayReport = { bytesUp: 500, bytesDown: 400, sessionId: relayConnection.sessionId, seq: 0,
    reportMode: 'delta', subscriptionId: sub.id, deviceId: a.id };
  const trafficTarget = '/api/mobile/vpn/traffic';
  const relayReportHeaders = headers(a, 'POST', trafficTarget, JSON.stringify(relayReport), a.tokens.accessToken);
  const receipt = await request(a, trafficTarget, relayReport, a.tokens.accessToken, { headers: relayReportHeaders });
  check('mobile receipt returns authoritative gateway usage', receipt.data.quotaUsedBytes, 600);
  check('relay telemetry still consumes its nonce', (await request(a, trafficTarget, relayReport, a.tokens.accessToken,
    { headers: relayReportHeaders })).status, 409);
  check('legacy provision accounting cannot double charge a bound relay', (await request(a, '/api/provision/sync',
    { subscriptionId: sub.id, deviceId: a.id, downloadBytes: 100 }, a.tokens.accessToken)).status, 409);
  check('legacy usage alias cannot double charge a bound relay', (await request(a, '/api/mobile/vpn/usage',
    { subscriptionId: sub.id, download: 100, upload: 0 }, a.tokens.accessToken)).status, 409);
  check('mobile reports never double debit gateway bytes', (await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).quotaUsed, 600n);
  const refreshRelayTarget = '/api/provision/ssh-relay/refresh', refreshRelayBody = { ticket: relayTicket };
  const refreshRelayHeaders = headers(a, 'POST', refreshRelayTarget, JSON.stringify(refreshRelayBody), a.tokens.accessToken);
  const refreshed = await request(a, refreshRelayTarget, refreshRelayBody, a.tokens.accessToken, { headers: refreshRelayHeaders });
  check('credential renewal endpoint succeeds', refreshed.status, 200);
  check('renewal returns no configuration', Object.keys(refreshed.data).sort().join(','), 'expiresAt,ticket');
  check('renewal consumes its proof exactly once', (await request(a, refreshRelayTarget, refreshRelayBody,
    a.tokens.accessToken, { headers: refreshRelayHeaders })).status, 409);
  await request(a, '/api/mobile/vpn/session', { ...directRetry, action: 'disconnect' }, a.tokens.accessToken);
  await assert.rejects(relayGrant.account(1, 0));
  check('closed gateway binding cannot be reopened by retry', (await request(a, '/api/mobile/vpn/session', relayConnection, a.tokens.accessToken)).status, 409);
  await prisma.trafficUsage.deleteMany({ where: { reportKey: `relay:${relayConnection.connectionId}` } });
  await prisma.subscription.update({ where: { id: sub.id }, data: { quotaBytes: 1073741824n, quotaUsed: 0n } });
  await prisma.vpnClient.update({ where: { id: a.client.id }, data: { quotaUsed: { decrement: 600n } } });
  delete process.env.SXB_SSH_RELAY_PROFILE_IDS;
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
  for (const roleName of ['OWNER', 'ADMIN', 'SUPPORT', 'SUPER_ADMIN']) {
    const operatorRole = await prisma.role.upsert({ where: { name: roleName }, create: { name: roleName }, update: {} });
    for (const permissionName of ['clients.view', 'clients.manage', 'users.view', 'users.create']) {
      const permission = await prisma.permission.upsert({ where: { name: permissionName }, create: { name: permissionName }, update: {} });
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: operatorRole.id, permissionId: permission.id } },
        create: { roleId: operatorRole.id, permissionId: permission.id }, update: {},
      });
    }
    const user = await prisma.user.create({ data: { name: `SYNTHETIC ${roleName}`, roleId: operatorRole.id,
      email: `${roleName}-${suffix}@example.invalid`, passwordHash: 'not-a-real-login-hash' } });
    operators.push({ user, roleName, token: jwt.sign({ userId: user.id, role: roleName }, process.env.JWT_SECRET, { expiresIn: '15m' }) });
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
  const superOperator = operators.find(operator => operator.roleName === 'SUPER_ADMIN');
  const superUnlock = await request(a, '/api/security/gate/unlock', { password: 'synthetic-local-gate-password' }, superOperator.token);
  check('SUPER_ADMIN can unlock its own scoped console', superUnlock.status, 200);
  const investigate = (operator, target, body, method = body === undefined ? 'GET' : 'POST') => request(a, target, body, operator.token, {
    method, headers: headers(a, method, target, body ? JSON.stringify(body) : '', operator.token,
      { 'X-SXB-Security-Unlock': operator === owner ? unlock.data.unlockToken : superUnlock.data.unlockToken }),
  });
  const marker = `privacy-${suffix}`;
  const privateTime = new Date(Date.now() + 120_000);
  const privateEvents = [
    { userId: owner.user.id },
    { userId: b.client.userId },
    { deviceId: b.id },
    { sessionId: b.tokens.security.sessionId },
    { userId: a.client.userId, acknowledged: true, acknowledgedById: owner.user.id },
    { userId: a.client.userId, sessionId: live.id, metadata: JSON.stringify({ marker, role: 'OWNER' }) },
  ].map(data => ({ id: randomUUID(), eventType: 'DEVICE_MISMATCH', severity: 'critical', createdAt: privateTime,
    metadata: JSON.stringify({ marker }), ...data }));
  const publicEvent = { id: randomUUID(), eventType: 'DEVICE_MISMATCH', severity: 'warning',
    userId: a.client.userId, sessionId: live.id, riskLevel: 'HIGH', metadata: JSON.stringify({ marker }) };
  await prisma.securityEvent.createMany({ data: [publicEvent, ...privateEvents] });
  const privateSearch = `/api/security/events?search=${marker}`;
  const ownerEvents = await investigate(owner, privateSearch);
  const superEvents = await investigate(superOperator, privateSearch);
  check('OWNER sees every synthetic privacy event in real PostgreSQL', ownerEvents.data.total, 7);
  check('SUPER_ADMIN excludes every private attribution before count', superEvents.data.total, 1);
  check('SUPER_ADMIN sees only the public event ID', superEvents.data.events[0].id, publicEvent.id);
  const ownerOverview = await investigate(owner, '/api/security/overview');
  const superOverview = await investigate(superOperator, '/api/security/overview');
  check('private latest event timestamp is not exposed by overview', superOverview.data.overview.latestAt === privateTime.toISOString(), false);
  check('private critical events are excluded from overview counts', ownerOverview.data.overview.critical - superOverview.data.overview.critical >= 6, true);
  const ackPath = '/api/security/events/acknowledge';
  const privateBefore = await prisma.securityEvent.findMany({ where: { id: { in: privateEvents.map(event => event.id) } }, orderBy: { id: 'asc' } });
  const acknowledged = await investigate(superOperator, ackPath, { ids: [publicEvent.id, ...privateEvents.map(event => event.id)] });
  check('real PG batch acknowledgement modifies only authorized IDs', acknowledged.data.acknowledged, 1);
  assert.deepEqual(await prisma.securityEvent.findMany({ where: { id: { in: privateEvents.map(event => event.id) } }, orderBy: { id: 'asc' } }), privateBefore);
  checks++;
  check('real PG acknowledgement can be reopened', (await investigate(superOperator, ackPath, { ids: [publicEvent.id], acknowledged: false })).data.acknowledged, 1);
  await prisma.auditLog.createMany({ data: [
    { userId: owner.user.id, action: `${marker} legacy owner`, type: 'info', visibleOwnerOnly: false },
    { userId: b.client.userId, action: `${marker} private client`, type: 'info', visibleOwnerOnly: false },
    { userId: superOperator.user.id, action: `${marker} public operator`, type: 'info', visibleOwnerOnly: false },
    { userId: null, action: `${marker} unassignable legacy entry`, type: 'info', visibleOwnerOnly: false },
  ] });
  await logDbActivity(owner.user.id, `${marker} real owner writer`, 'info', undefined, { visibleOwnerOnly: false });
  check('real audit writer prevents caller override of owner privacy',
    (await prisma.auditLog.findFirstOrThrow({ where: { action: `${marker} real owner writer` } })).visibleOwnerOnly, true);
  const auditPage = await investigate(superOperator, `/api/security/audit?search=${marker}&limit=1`);
  check('real PG audit scope hides owner, private clients and unassignable historical entries', auditPage.data.total, 1);
  check('real PG audit search preserves public actions', auditPage.data.entries[0].user.email, superOperator.user.email);
  const inventory = await investigate(superOperator, '/api/security/sessions?limit=1');
  const nextInventory = await investigate(superOperator, '/api/security/sessions?limit=1&offset=1');
  check('real PG session inventory excludes refresh material', JSON.stringify(inventory.data).includes('refreshJti'), false);
  check('real PG session pagination is applied', inventory.data.sessions[0].id !== nextInventory.data.sessions[0].id, true);
  check('real PG inventory search cannot recover a private session',
    (await investigate(superOperator, `/api/security/sessions?search=${b.tokens.security.sessionId}`)).data.total, 0);
  check('real PG direct account query hides owner clients',
    (await request(a, `/api/users/${b.client.userId}`, undefined, superOperator.token)).status, 404);
  check('SUPER_ADMIN cannot edit global security policy',
    (await investigate(superOperator, '/api/security/policy', {}, 'PUT')).status, 403);
  const policyKey = 'mobile.security.policy.v1';
  await prisma.setting.deleteMany({ where: { key: policyKey } });
  check('policy cold-start fixture really has no setting', await prisma.setting.count({ where: { key: policyKey } }), 0);
  for (const state of ['absent', 'existing']) {
    const policy = await request(a, '/api/security/policy', undefined, owner.token, { headers: policyHeaders('GET', '/api/security/policy') });
    check(`policy route reads ${state} policy independently of events`, policy.status, 200);
    const changedPolicy = { ...policy.data, version: policy.data.version + 1 };
    const updates = await Promise.all(Array.from({ length: 4 }, () => request(a, '/api/security/policy', changedPolicy, owner.token, {
      method: 'PUT', headers: policyHeaders('PUT', '/api/security/policy', changedPolicy),
    })));
    check(`concurrent ${state} policy edit has one winner`, updates.filter(item => item.status === 200).length, 1);
    check(`concurrent ${state} policy stale edits are explicit conflicts`, updates.filter(item => item.status === 409).length, 3);
    const persisted = await prisma.setting.findUniqueOrThrow({ where: { key: policyKey } });
    check(`${state} policy advances exactly one version`, JSON.parse(persisted.value).version, changedPolicy.version);
  }
  const incompletePolicy = { ...JSON.parse((await prisma.setting.findUniqueOrThrow({ where: { key: policyKey } })).value), weights: {} };
  check('incomplete policy weights cannot produce NaN risk scores', (await request(a, '/api/security/policy',
    incompletePolicy, owner.token, { method: 'PUT', headers: policyHeaders('PUT', '/api/security/policy', incompletePolicy) })).status, 400);
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
  const expiredAccess = jwt.sign({
    ...jwt.decode(a.tokens.accessToken), exp: Math.floor(Date.now() / 1000) - 1,
  }, process.env.JWT_SECRET, { algorithm: 'HS256' });
  check('expired access JWT with fresh valid device proof is rejected',
    (await request(a, me, undefined, expiredAccess)).status, 401);
  check('current access JWT still works after expired JWT refusal',
    (await request(a, me, undefined, a.tokens.accessToken)).status, 200);
  const stolenProvision = await request(b, '/api/provision/activate', provisioningBody, a.tokens.accessToken, {
    headers: headers(b, 'POST', '/api/provision/activate', JSON.stringify(provisioningBody), a.tokens.accessToken,
      { 'X-SXB-Device-ID': a.id }),
  });
  check('provisioning rejects bearer A with device B key and forged device A header', stolenProvision.status, 401);
  check('stolen bearer provisioning returns no configuration', 'config' in stolenProvision.data, false);
  const bodyDeviceMismatch = await request(a, '/api/provision/activate',
    { ...provisioningBody, deviceId: b.id }, a.tokens.accessToken);
  check('valid key A cannot provision a body claiming device B', bodyDeviceMismatch.status, 401);
  check('body device mismatch returns no configuration', 'config' in bodyDeviceMismatch.data, false);
  check('provisioning attacks leave subscription bound to A',
    (await prisma.subscription.findUniqueOrThrow({ where: { id: activeSub.id } })).deviceId, a.id);
  check('provisioning attacks leave client bound to A',
    (await prisma.vpnClient.findUniqueOrThrow({ where: { id: a.client.id } })).deviceId, a.id);
  check('provisioning attacks register no subscription device B',
    await prisma.subscriptionDevice.count({ where: { subscriptionId: activeSub.id, deviceId: b.id } }), 0);
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
  const targetUser = await prisma.user.findUniqueOrThrow({ where: { id: ids[1].userId } });
  for (const operator of operators.filter(value => value.roleName !== 'SUPPORT')) {
    const privileged = device();
    const client = await prisma.vpnClient.create({ data: { userId: operator.user.id,
      token: `SXB-USER-PRIVILEGED-${operator.roleName}-${suffix}` } });
    const activated = await request(privileged, '/api/mobile/auth/activate', {
      token: client.token, deviceId: privileged.id, publicKey: privileged.encoded, activationRequestId: randomUUID(),
    }, client.token);
    check(`${operator.roleName} holder can activate a CLIENT device`, activated.status, 200);
    const mobileTokens = activated.data;
    for (const revoked of [false, true]) {
      if (revoked) await prisma.$transaction(tx => sessions.revokeSecuritySession(tx,
        mobileTokens.security.sessionId, mobileTokens.security.generation));
      const stolenHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${mobileTokens.accessToken}` };
      const edit = { name: 'SYNTHETIC UNAUTHORIZED CHANGE' };
      check(`${operator.roleName} mobile bearer cannot PATCH users (revoked=${revoked})`,
        (await request(privileged, `/api/users/${targetUser.id}`, edit, mobileTokens.accessToken,
          { method: 'PATCH', headers: stolenHeaders })).status, 401);
      check(`${operator.roleName} device header cannot elevate mobile authority (revoked=${revoked})`,
        (await request(privileged, `/api/users/${targetUser.id}`, edit, mobileTokens.accessToken,
          { method: 'PATCH', headers: { ...stolenHeaders, 'X-SXB-Device-ID': privileged.id } })).status, 401);
      check(`${operator.roleName} mobile proof still cannot enter operator self-service (revoked=${revoked})`,
        (await request(privileged, '/api/users/me', undefined, mobileTokens.accessToken)).status, revoked ? 401 : 403);
      check(`${operator.roleName} rejected mobile requests persist no user mutation (revoked=${revoked})`,
        (await prisma.user.findUniqueOrThrow({ where: { id: targetUser.id } })).name, targetUser.name);
      const refreshed = await request(privileged, '/api/auth/refresh',
        { refreshToken: mobileTokens.refreshToken }, mobileTokens.refreshToken);
      check(`${operator.roleName} alternate refresh enforces mobile session (revoked=${revoked})`, refreshed.status, revoked ? 401 : 200);
      if (!revoked) check(`${operator.roleName} alternate refresh never elevates CLIENT`,
        jwt.decode(refreshed.data.accessToken).role, 'CLIENT');
    }
    check(`genuine ${operator.roleName} operator still accesses users`,
      (await request(privileged, '/api/users/me', undefined, operator.token)).status, 200);
  }
  const ownerEdit = await request(a, `/api/users/${targetUser.id}`, { name: 'SYNTHETIC AUTHORIZED OWNER EDIT' }, owner.token, { method: 'PATCH' });
  check('genuine owner can still PATCH another user', ownerEdit.status, 200);
  check('genuine owner mutation persists', (await prisma.user.findUniqueOrThrow({ where: { id: targetUser.id } })).name, 'SYNTHETIC AUTHORIZED OWNER EDIT');
  console.log(`REAL_POSTGRES_SECURITY_CHECKS=${checks}`);
} finally {
  globalThis.fetch = nativeFetch;
  await new Promise(resolve => server.close(resolve));
  await prisma.$disconnect();
  rmSync(scratch, { recursive: true, force: true });
}

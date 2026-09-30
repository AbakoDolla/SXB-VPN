import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, createHash, sign, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(root, 'backend', 'package.json'));
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const kid = hash(publicKey);
const connectionId = '11111111-1111-4111-a111-111111111111';
const secret = 'synthetic-relay-test-secret';
const output = await require('esbuild').build({
  stdin: { contents: `
    export * from './server/services/ssh-relay-auth';
    export * from './server/services/ssh-relay-ticket';
    export { updateMobileConnection } from './server/services/mobile-connections';
    export { verifyMobileProof } from './server/services/mobile-proof';
    export { encryptCanonical, computeCanonicalHash } from './server/services/canonical-config';
    export { MAINTENANCE_KEY, RESET_EXECUTION_KEY } from './server/services/reset-state';
    export { prisma } from './scripts/tests/stubs/database-stub.mjs';
    export { validateVpnConfig, mergeProvisionedConfig, isCompleteOfflineConfig } from './app-mobile/services/configValidator';
  `, resolveDir: root, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  plugins: [{
    name: 'isolated-relay-authority',
    setup(plugin) {
      plugin.onResolve({ filter: /(^|\/)database$/ }, () => ({
        path: path.join(root, 'scripts', 'tests', 'stubs', 'database-stub.mjs'),
      }));
      plugin.onResolve({ filter: /^(\.\.\/)+config$/ }, () => ({ path: 'config', namespace: 'fixture' }));
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
        contents: `export const config={JWT_SECRET:${JSON.stringify(secret)}};`, loader: 'js',
      }));
    },
  }],
});

function fixture() {
  const module = { exports: {} };
  const env = { ENCRYPTION_KEY: 'synthetic-canonical-key', SXB_SSH_RELAY_PROFILE_IDS: 'profile' };
  runInNewContext(output.outputFiles[0].text, {
    module, exports: module.exports, require, Buffer, URL, console, setTimeout, clearTimeout,
    process: { env },
  });
  const api = module.exports;
  const canonical = { protocol: 'ssh', host: 'provider.invalid', port: 22, username: 'synthetic',
    password: 'synthetic-only', fingerprint: 'SHA256:' + Buffer.alloc(32, 1).toString('base64') };
  const configHash = api.computeCanonicalHash(canonical);
  const claims = { userId: 'user', clientId: 'client', deviceId: 'device', sid: 'session', sg: 1, kid };
  const state = {
    client: { id: 'client', userId: 'user', deviceId: 'device', deviceKeyId: kid,
      devicePublicKey: publicKey.toString('base64'), status: 'active', quotaUsed: 0n },
    session: { id: 'session', clientId: 'client', deviceId: 'device', authGeneration: 1,
      authExpiresAt: new Date(Date.now() + 86400000), authRevokedAt: null },
    subscription: { id: 'subscription', clientId: 'client', deviceId: 'device', status: 'active',
      quotaBytes: 1000n, quotaUsed: 0n, profile: { id: 'profile', status: 'active', protocol: 'ssh',
        createdAt: '2026-01-02T00:00:00.000Z',
        canonicalConfigHash: configHash, canonicalConfig: api.encryptCanonical(JSON.stringify(canonical)) } },
    binding: { id: connectionId, ...claims, authSessionId: 'session', authGeneration: 1,
      subscriptionId: 'subscription', configId: 'local-profile', usageSessionId: `sess_${connectionId}`,
      relayConfigHash: configHash, closedAt: null },
    nonces: [], settings: [], traffic: { upload: 0n, download: 0n }, locks: [],
  };
  const delegates = value => ({
    $queryRaw: async (strings) => { value.locks.push(strings.join('?')); return []; },
    setting: { findMany: async () => value.settings },
    activationSession: { findUnique: async () => value.session },
    vpnClient: {
      findUnique: async () => value.client,
      update: async ({ data }) => { value.client.quotaUsed += data.quotaUsed.increment; return value.client; },
    },
    subscription: {
      findUnique: async () => ({ ...value.subscription, client: { ...value.client, user: { status: 'active' } } }),
      findFirst: async ({ where }) => where.id === value.subscription.id && where.clientId === value.subscription.clientId
        ? value.subscription : null,
      update: async ({ data }) => { value.subscription.quotaUsed += data.quotaUsed.increment; return value.subscription; },
    },
    mobileConnection: {
      findUnique: async () => value.binding,
      create: async ({ data }) => { value.binding = { ...data, closedAt: null }; return value.binding; },
      update: async ({ data }) => { Object.assign(value.binding, data); return value.binding; },
    },
    reseller: { findUnique: async () => null, findFirst: async () => null },
    mobileProofNonce: {
      createMany: async ({ data }) => {
        if (value.nonces.includes(data[0].nonce)) return { count: 0 };
        value.nonces.push(data[0].nonce); return { count: 1 };
      },
      deleteMany: async () => ({ count: 0 }),
    },
    trafficUsage: {
      upsert: async ({ create }) => {
        value.traffic.upload += create.upload; value.traffic.download += create.download;
        return value.traffic;
      },
    },
  });
  let tail = Promise.resolve();
  Object.assign(api.prisma, delegates(state), {
    $transaction(work) {
      const result = tail.then(async () => {
        const staged = structuredClone(state);
        const value = await work(delegates(staged));
        Object.assign(state, staged);
        return value;
      });
      tail = result.catch(() => {});
      return result;
    },
  });
  const credential = api.issueRelayTicket({ ...claims, subscriptionId: 'subscription', configHash },
    secret, Date.now() + 3600000);
  function request(configId) {
    const url = `/api/mobile/ssh-relay?connectionId=${connectionId}` +
      (configId === undefined ? '' : `&configId=${encodeURIComponent(configId)}`);
    const time = String(Date.now()), nonce = randomBytes(24).toString('base64url');
    const canonical = ['SXB-PROOF-1', 'GET', url, hash(''), 'session', '1', hash(credential.ticket), time, nonce].join('\n');
    return { method: 'GET', url, socket: { remoteAddress: '127.0.0.1' }, headers: {
      authorization: `Bearer ${credential.ticket}`, 'x-sxb-device-id': 'device', 'x-sxb-time': time,
      'x-sxb-nonce': nonce, 'x-sxb-proof': sign('sha256', Buffer.from(canonical), keys.privateKey).toString('base64'),
    } };
  }
  function registration(body) {
    const originalUrl = '/api/mobile/vpn/session';
    const rawBody = Buffer.from(JSON.stringify(body));
    const time = String(Date.now()), nonce = randomBytes(24).toString('base64url');
    const canonical = ['SXB-PROOF-1', 'POST', originalUrl, hash(rawBody), 'session', '1',
      hash(credential.ticket), time, nonce].join('\n');
    const headers = {
      'X-SXB-Time': time, 'X-SXB-Nonce': nonce,
      'X-SXB-Proof': sign('sha256', Buffer.from(canonical), keys.privateKey).toString('base64'),
    };
    const req = { method: 'POST', originalUrl, body, rawBody, get: name => headers[name] };
    api.verifyMobileProof(req, state.client.devicePublicKey, credential.ticket, claims);
    return req;
  }
  return { api, state, claims, credential, request, registration, env };
}

test('new SSH profiles inherit the gateway policy without opting in existing SSH or other protocols', () => {
  const f = fixture();
  const profile = { id: 'new-profile', protocol: 'ssh', createdAt: '2026-01-02T00:00:00.000Z' };
  assert.equal(f.api.relayProfileEnabled(profile), false);
  f.env.SXB_SSH_RELAY_REQUIRED_FROM = profile.createdAt;
  assert.equal(f.api.relayProfileEnabled(profile), true);
  assert.equal(f.api.relayProfileEnabled({ ...profile, protocol: 'ssh+payload' }), true);
  assert.equal(f.api.relayProfileEnabled({ ...profile, createdAt: '2026-01-01T23:59:59.999Z' }), false);
  for (const protocol of ['vless', 'vmess', 'trojan', 'wireguard', 'singbox']) {
    assert.equal(f.api.relayProfileEnabled({ ...profile, id: 'profile', protocol }), false);
  }
  assert.throws(() => f.api.relayProfileEnabled({ id: 'missing-date', protocol: 'ssh' }), /DATE_REQUIRED/);
  f.env.SXB_SSH_RELAY_REQUIRED_FROM = 'invalid';
  assert.throws(() => f.api.relayProfileEnabled(profile), /POLICY_INVALID/);
});

test('automatically protected SSH uses the same binding, renewal and accounting authority', async () => {
  const f = fixture();
  delete f.env.SXB_SSH_RELAY_PROFILE_IDS;
  f.env.SXB_SSH_RELAY_REQUIRED_FROM = f.state.subscription.profile.createdAt;
  await f.api.authorizeRelayBinding(f.api.prisma, f.credential.ticket, f.claims, 'subscription');
  const grant = await f.api.authorizeSshRelay(f.request());
  await grant.account(10, 20);
  assert.equal(f.state.subscription.quotaUsed, 30n);
  const renewed = await f.api.renewRelayTicket(f.api.prisma, f.credential.ticket, f.claims);
  assert.deepEqual(Object.keys(renewed).sort(), ['expiresAt', 'ticket']);
});

test('relay requires device proof; a consumed nonce cannot authorize another upgrade', async () => {
  const f = fixture(), request = f.request();
  const grant = await f.api.authorizeSshRelay(request);
  assert.equal(grant.clientId, 'client');
  assert.equal(grant.upstream.host, 'provider.invalid');
  assert.equal(f.state.nonces.length, 1);
  await assert.rejects(f.api.authorizeSshRelay(request), error => error.body?.reason === 'NONCE_REUSED');
  const altered = f.request();
  altered.url = altered.url.replace(connectionId, '22222222-2222-4222-a222-222222222222');
  await assert.rejects(f.api.authorizeSshRelay(altered), error => error.body?.reason === 'DEVICE_PROOF_INVALID');
  const missing = f.request(); delete missing.headers['x-sxb-proof'];
  await assert.rejects(f.api.authorizeSshRelay(missing));
  assert.equal(f.state.nonces.length, 1);
});

test('a signed relay upgrade creates its immutable binding without a control-plane preflight', async () => {
  const f = fixture();
  f.state.binding = null;
  const request = f.request('local-profile');
  const grant = await f.api.authorizeSshRelay(request);
  assert.equal(f.state.binding.id, connectionId);
  assert.equal(f.state.binding.usageSessionId, `sess_${connectionId}`);
  assert.equal(f.state.binding.configId, 'local-profile');
  assert.equal(f.state.binding.subscriptionId, 'subscription');
  assert.equal(f.state.binding.relayConfigHash, f.state.subscription.profile.canonicalConfigHash);
  assert.equal(f.state.binding.authSessionId, f.claims.sid);
  assert.equal(f.state.binding.authGeneration, f.claims.sg);
  await grant.account(10, 20);
  assert.equal(f.state.subscription.quotaUsed, 30n);
  await assert.rejects(f.api.authorizeSshRelay(request), error => error.body?.reason === 'NONCE_REUSED');
});

test('bootstrap refuses altered attribution, revoked access and an unsigned legacy upgrade', async () => {
  const legacy = fixture();
  legacy.state.binding = null;
  await assert.rejects(legacy.api.authorizeSshRelay(legacy.request()), /BINDING/);
  for (const mutate of [
    f => { f.state.subscription.quotaUsed = f.state.subscription.quotaBytes; },
    f => { f.state.subscription.status = 'revoked'; },
    f => { f.state.session.authRevokedAt = new Date(); },
    f => { f.state.client.deviceId = 'foreign-device'; },
    f => { f.state.settings.push({ key: f.api.MAINTENANCE_KEY, value: 'true' }); },
  ]) {
    const f = fixture();
    f.state.binding = null;
    mutate(f);
    await assert.rejects(f.api.authorizeSshRelay(f.request('local-profile')));
    assert.equal(f.state.binding, null);
    assert.equal(f.state.nonces.length, 0);
  }
  const altered = fixture(), request = altered.request('local-profile');
  request.url = request.url.replace('local-profile', 'foreign-profile');
  await assert.rejects(altered.api.authorizeSshRelay(request), error => error.body?.reason === 'DEVICE_PROOF_INVALID');
  const conflict = fixture();
  await assert.rejects(conflict.api.authorizeSshRelay(conflict.request('different-profile')), /BINDING/);
  assert.equal(conflict.state.binding.configId, 'local-profile');
});

const synchronization = {
  action: 'sync', connectionId, sessionId: `sess_${connectionId}`,
  subscriptionId: 'subscription', configId: 'local-profile',
};

test('post-tunnel sync records owned direct accounting and never reopens or rewrites a binding', async () => {
  const f = fixture();
  f.state.subscription.profile.protocol = 'vless';
  f.state.subscription.status = 'expired';
  f.state.binding = null;
  const row = await f.api.updateMobileConnection(f.registration(synchronization), f.claims);
  assert.equal(row.subscriptionId, 'subscription');
  assert.equal(row.relayConfigHash, null);
  assert.equal(row.usageSessionId, `sess_${connectionId}`);
  f.state.binding.closedAt = new Date();
  f.state.binding.authGeneration = 0;
  await f.api.updateMobileConnection(f.registration(synchronization), f.claims);
  assert.notEqual(f.state.binding.closedAt, null);
  assert.equal(f.state.binding.authGeneration, 0, 'a historical accounting sync is not a new admission');
  const nonceCount = f.state.nonces.length;
  for (const changed of [{ subscriptionId: null }, { configId: 'different' }, { sessionId: `sess_22222222-2222-4222-a222-222222222222` }]) {
    await assert.rejects(f.api.updateMobileConnection(f.registration({ ...synchronization, ...changed }), f.claims),
      error => error.body?.reason === 'USAGE_ATTRIBUTION_CONFLICT');
  }
  assert.equal(f.state.nonces.length, nonceCount);
  await assert.rejects(f.api.updateMobileConnection(f.registration({ ...synchronization, action: 'connect' }), f.claims),
    error => error.body?.code === 'CONFIG_EXPIRED');
});

test('sync keeps manual attribution explicit and cannot synthesize a protected SSH binding', async () => {
  const f = fixture();
  f.state.binding = null;
  await assert.rejects(f.api.updateMobileConnection(f.registration(synchronization), f.claims),
    error => error.body?.reason === 'RELAY_REQUIRED');
  assert.equal(f.state.binding, null);
  assert.equal(f.state.nonces.length, 0);
  await f.api.authorizeSshRelay(f.request('local-profile'));
  const authorized = await f.api.updateMobileConnection(f.registration(synchronization), f.claims);
  assert.equal(authorized.relayConfigHash, f.state.subscription.profile.canonicalConfigHash);
  const direct = fixture();
  direct.state.binding = null;
  await direct.api.updateMobileConnection(direct.registration({
    ...synchronization, subscriptionId: null, configId: 'manual-profile',
  }), direct.claims);
  assert.equal(direct.state.binding.subscriptionId, null);
  assert.equal(direct.state.binding.relayConfigHash, null);
  const foreign = fixture();
  foreign.state.binding = null;
  await assert.rejects(foreign.api.updateMobileConnection(foreign.registration({
    ...synchronization, subscriptionId: 'foreign-subscription',
  }), foreign.claims), error => error.body?.reason === 'OWNERSHIP_FORBIDDEN');
  assert.equal(foreign.state.binding, null);
  assert.equal(foreign.state.nonces.length, 0);
});

test('renewal returns only a credential and retains the session, device and profile binding', async () => {
  const f = fixture();
  const renewed = await f.api.renewRelayTicket(f.api.prisma, f.credential.ticket, f.claims);
  assert.deepEqual(Object.keys(renewed).sort(), ['expiresAt', 'ticket']);
  const value = f.api.verifyRelayTicket(renewed.ticket, secret);
  assert.equal(value.configHash, f.state.binding.relayConfigHash);
  assert.ok(value.exp * 1000 <= f.state.session.authExpiresAt.getTime());
  await assert.rejects(f.api.renewRelayTicket(f.api.prisma, f.credential.ticket, { ...f.claims, sg: 2 }));
  f.state.subscription.profile.status = 'revoked';
  await assert.rejects(f.api.renewRelayTicket(f.api.prisma, f.credential.ticket, f.claims));
});

test('provisioned relay replaces every old provider field and validates without provider credentials', () => {
  const f = fixture();
  const previous = { protocol: 'ssh+payload', host: 'provider.invalid', port: 80,
    username: 'provider-user', password: 'provider-secret', payload: 'provider-payload',
    proxyHost: 'proxy.invalid', proxyPort: 8080, sni: 'provider.invalid', tls: true };
  const relay = f.api.relayClientConfig(previous, 'profile', f.credential);
  const merged = f.api.mergeProvisionedConfig(previous, relay);
  assert.equal(f.api.validateVpnConfig(merged).valid, true);
  assert.equal(f.api.isCompleteOfflineConfig(merged).complete, true);
  assert.doesNotMatch(JSON.stringify(merged), /provider-|provider\.invalid|proxy\.invalid/);
  for (const [field, value] of Object.entries({
    password: 'secret', payload: 'GET /', proxyHost: 'proxy.invalid', tls: true,
    privateKeyBase64: 'key', insecure: true, sni: 'provider.invalid',
  })) assert.equal(f.api.validateVpnConfig({ ...merged, [field]: value }).valid, false, field);
});

test('bindings cannot switch accounts, device, profile hash or bypass external TLS ingress', async () => {
  for (const mutate of [
    f => { f.state.binding.closedAt = new Date(); },
    f => { f.state.binding.relayConfigHash = 'changed'; },
    f => { f.state.binding.subscriptionId = 'different'; },
    f => { f.state.session.authRevokedAt = new Date(); },
    f => { f.state.client.deviceId = 'different'; },
    f => { f.state.subscription.profile.id = 'not-allowlisted'; },
    f => { f.state.settings.push({ key: f.api.RESET_EXECUTION_KEY, value: 'running' }); },
    f => { f.state.settings.push({ key: f.api.MAINTENANCE_KEY, value: 'true' }); },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.api.authorizeSshRelay(f.request()));
    assert.equal(f.state.nonces.length, 0);
  }
  const f = fixture(), request = f.request();
  request.socket.remoteAddress = '198.51.100.1';
  await assert.rejects(f.api.authorizeSshRelay(request), /TLS_PROXY/);
  await assert.rejects(f.api.authorizeRelayBinding(f.api.prisma, f.credential.ticket, f.claims, 'other'));
});

test('quota is charged before delivery, concurrent reservations cannot exceed it, and revocation blocks usage', async () => {
  const f = fixture();
  const grant = await f.api.authorizeSshRelay(f.request());
  const results = await Promise.allSettled([grant.account(600, 0), grant.account(0, 600)]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(f.state.client.quotaUsed, 600n);
  assert.equal(f.state.subscription.quotaUsed, 600n);
  assert.equal(f.state.traffic.upload + f.state.traffic.download, 600n);
  await grant.account(100, 200);
  assert.equal(f.state.subscription.quotaUsed, 900n);
  await assert.rejects(grant.account(-1, 1));
  f.state.session.authRevokedAt = new Date();
  await assert.rejects(grant.account(1, 0));
  await assert.rejects(grant.revalidate());
  assert.equal(f.state.subscription.quotaUsed, 900n);
  assert.deepEqual(f.state.locks.slice(2, 5).map(query => query.match(/FROM (\w+)/)[1]),
    ['vpn_clients', 'activation_sessions', 'subscriptions']);
});

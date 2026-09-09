import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, createSub, db, GO, ok, row, tomorrow } from './reseller-http.test.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(root, 'backend', 'package.json'));
const { build } = require('esbuild');
const compiled = await build({
  entryPoints: [path.join(root, 'app-mobile', 'services', 'accessPolicy.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent',
});
const module = { exports: {} };
new Function('module', 'exports', 'require', compiled.outputFiles[0].text)(module, module.exports, require);
const { parseAccessSnapshot, reduceSnapshot, deviceAccess, blocksDevice, profileRestriction } = module.exports;
const deviceId = 'SXB-INTEGRATION-DEVICE';
const headers = { 'X-SXB-Device-ID': deviceId };

function bindDevice() {
  Object.assign(row('VpnClient', 'c1'), {
    deviceId,
    activatedAt: new Date(),
    expireAt: tomorrow(),
  });
  return {
    userId: 'u1',
    deviceId,
    session: 'integration-session',
    sequence: 0,
    snapshot: null,
    deviceIssue: null,
    restrictions: [],
  };
}

async function assignedProfile(quota = 2) {
  const response = await createSub('r1', quota);
  ok(response, 201);
  const id = response.body.subscription.id;
  return { configId: id, subscriptionId: id, source: 'backend' };
}

async function snapshot(sessionHeaders = headers) {
  const response = await api('u1', 'GET', '/mobile/access-state', undefined, sessionHeaders);
  ok(response);
  return parseAccessSnapshot(response.body);
}

test('real API configuration revocation is a profile restriction, never a device deactivation', async () => {
  let authority = bindDevice();
  const first = await assignedProfile();
  const second = await assignedProfile();
  const manual = { configId: 'independent-local-profile', source: 'manual' };
  const profiles = [first, second, manual];
  authority = reduceSnapshot(authority, await snapshot(), profiles);
  const originalClient = structuredClone(row('VpnClient', 'c1'));

  ok(await api('r1', 'POST', `/subscriptions/${first.subscriptionId}/revoke`, { reason: 'Fixture revocation' }));
  const received = await snapshot();
  const next = reduceSnapshot(authority, received, profiles);

  assert.equal(received.device.status, 'active');
  assert.equal(received.device.activationRequired, false);
  assert.equal(blocksDevice(deviceAccess(next)), false);
  assert.ok(profileRestriction(next, first), 'revoked backend profile must be restricted');
  assert.ok(!profileRestriction(next, second), 'unrelated backend profile stays usable');
  assert.ok(!profileRestriction(next, manual), 'independent local profile is not an orphan');
  assert.equal(next.userId, authority.userId);
  assert.equal(next.deviceId, authority.deviceId);
  assert.equal(row('VpnClient', 'c1').token, originalClient.token);
  assert.equal(row('VpnClient', 'c1').status, 'active');
});

test('real API suspension and deletion remain scoped to their configuration', async () => {
  let authority = bindDevice();
  const first = await assignedProfile();
  const second = await assignedProfile();
  const profiles = [first, second];
  authority = reduceSnapshot(authority, await snapshot(), profiles);

  ok(await api('r1', 'PUT', `/subscriptions/${first.subscriptionId}`, { status: 'suspended' }));
  authority = reduceSnapshot(authority, await snapshot(), profiles);
  assert.equal(blocksDevice(deviceAccess(authority)), false);
  assert.ok(profileRestriction(authority, first));
  assert.ok(!profileRestriction(authority, second));

  ok(await api('r1', 'PUT', `/subscriptions/${first.subscriptionId}`, { status: 'active' }));
  authority = reduceSnapshot(authority, await snapshot(), profiles);
  assert.ok(!profileRestriction(authority, first));

  ok(await api('r1', 'DELETE', `/subscriptions/${first.subscriptionId}`));
  authority = reduceSnapshot(authority, await snapshot(), profiles);
  assert.ok(profileRestriction(authority, first), 'confirmed missing managed profile is no longer usable');
  assert.ok(!profileRestriction(authority, second));
  assert.equal(blocksDevice(deviceAccess(authority)), false);
});

test('real device disable, suspension and resumption preserve the same mobile identity and profiles', async () => {
  let authority = bindDevice();
  const profile = await assignedProfile();
  const client = structuredClone(row('VpnClient', 'c1'));
  const profiles = [profile];
  authority = reduceSnapshot(authority, await snapshot(), profiles);
  const subscriptions = structuredClone(db.state.Subscription);

  for (const [action, status] of [['revoke', 'disabled'], ['suspend', 'suspended']]) {
    ok(await api('r1', 'POST', `/devices/c1/${action}`));
    const blocked = await snapshot();
    authority = reduceSnapshot(authority, blocked, profiles);
    assert.equal(blocked.device.status, status);
    assert.equal(blocked.device.activationRequired, false);
    assert.equal(blocksDevice(deviceAccess(authority)), true);
    assert.equal(authority.userId, 'u1');
    assert.equal(authority.deviceId, deviceId);
    assert.deepEqual(db.state.Subscription, subscriptions);

    ok(await api('r1', 'POST', '/devices/c1/resume'));
    authority = reduceSnapshot(authority, await snapshot(), profiles);
    assert.equal(blocksDevice(deviceAccess(authority)), false);
    assert.ok(!profileRestriction(authority, profile));
    assert.equal(row('VpnClient', 'c1').token, client.token);
    assert.equal(row('VpnClient', 'c1').expireAt.getTime(), client.expireAt.getTime());
  }
});

test('real plan quota and duration changes do not rotate an activation code or lose usage', async () => {
  let authority = bindDevice();
  const profile = await assignedProfile();
  const client = structuredClone(row('VpnClient', 'c1'));
  row('Subscription', profile.subscriptionId).quotaUsed = GO;
  row('Subscription', profile.subscriptionId).expireAt = tomorrow();
  const previous = await snapshot();
  authority = reduceSnapshot(authority, previous, [profile]);
  const originalPlan = previous.subscriptions.find(item => item.id === profile.subscriptionId);

  ok(await api('r1', 'POST', '/subscriptions/bulk', {
    action: 'add_data', subscriptionIds: [profile.subscriptionId], quotaGB: 1,
  }));
  ok(await api('r1', 'POST', '/subscriptions/bulk', {
    action: 'extend_duration', subscriptionIds: [profile.subscriptionId], durationDays: 4,
  }));
  const received = await snapshot();
  authority = reduceSnapshot(authority, received, [profile]);
  const updatedPlan = received.subscriptions.find(item => item.id === profile.subscriptionId);
  assert.equal(updatedPlan.quotaTotalBytes, originalPlan.quotaTotalBytes + Number(GO));
  assert.equal(updatedPlan.quotaUsedBytes, Number(GO));
  assert.ok(new Date(updatedPlan.expireAt) > new Date(originalPlan.expireAt));
  assert.equal(blocksDevice(deviceAccess(authority)), false);
  assert.ok(!profileRestriction(authority, profile));
  assert.equal(row('VpnClient', 'c1').token, client.token);
  assert.equal(row('VpnClient', 'c1').expireAt.getTime(), client.expireAt.getTime());
});

test('real device renewal rotates only the activation code while the existing mobile session remains bound', async () => {
  let authority = bindDevice();
  const profile = await assignedProfile();
  const before = structuredClone(row('VpnClient', 'c1'));
  const subscriptions = structuredClone(db.state.Subscription);
  const jwt = require('jsonwebtoken');
  const existingSession = {
    ...headers,
    Authorization: `Bearer ${jwt.sign({
      userId: 'u1', clientId: 'c1', role: 'CLIENT', email: 'u1@example.test',
    }, process.env.JWT_SECRET, { expiresIn: '15m' })}`,
  };
  authority = reduceSnapshot(authority, await snapshot(existingSession), [profile]);
  const renewed = await api('r1', 'POST', '/devices/c1/renew', { durationDays: 7 });
  ok(renewed);
  assert.match(renewed.body.token, /^SXB-USER-/);
  assert.notEqual(renewed.body.token, before.token);
  assert.equal(renewed.body.token, row('VpnClient', 'c1').token);
  assert.equal(row('VpnClient', 'c1').deviceId, deviceId);
  assert.equal(row('VpnClient', 'c1').activatedAt.getTime(), before.activatedAt.getTime());
  assert.ok(row('VpnClient', 'c1').expireAt > before.expireAt);
  assert.deepEqual(db.state.Subscription, subscriptions);
  const received = await snapshot(existingSession);
  authority = reduceSnapshot(authority, received, [profile]);
  assert.equal(received.device.activationRequired, false);
  assert.equal(blocksDevice(deviceAccess(authority)), false);
  assert.ok(!profileRestriction(authority, profile));
  assert.equal(authority.userId, 'u1');
  assert.equal(authority.deviceId, deviceId);
});

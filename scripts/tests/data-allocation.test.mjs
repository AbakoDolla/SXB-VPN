import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db, api, routes, row, ok, GO } from './reseller-http.test.mjs';

const bytes = value => String(BigInt(value) * GO);

async function sales() {
  row('Reseller', 'res-r1').quotaBytes = 100n * GO;
  row('Reseller', 'res-r2').quotaBytes = 100n * GO;
  row('VpnClient', 'c1').deviceId = 'SYNTHETIC-MULTI-OWNER-DEVICE';
  row('VpnClient', 'c1').activatedAt = new Date();
  db.state.VpnProfileReseller.push({ profileId: 'p1', resellerId: 'res-r2' });
  const a = await api('r1', 'POST', '/subscriptions', {
    clientId: 'c1', profileId: 'p1', quotaGB: 10, durationDays: 30,
  });
  ok(a, 201);
  const b = await api('r2', 'POST', '/subscriptions', {
    recipientToken: row('VpnClient', 'c1').token, profileId: 'p1', quotaGB: 20, durationDays: 30,
  });
  ok(b, 201);
  return { a: a.body.subscription, b: b.body.subscription };
}

async function trial() {
  const invitation = await db.freeTrialToken.create({ data: { token: 'STUFF-SYNTHETIC-ISOLATION', createdBy: 'root' } });
  const request = await db.freeTrialRequest.create({ data: {
    tokenId: invitation.id, name: 'Synthetic buyer', deviceId: row('VpnClient', 'c1').deviceId,
    country: 'CM', claimSecretHash: 'synthetic-test-only',
  } });
  const deployed = await api('root', 'POST', '/free-trial/requests/deploy', {
    tokenId: invitation.id, requestIds: [request.id], profileId: 'p1', quotaGB: 15,
    expireAt: new Date(Date.now() + 30 * 86400000).toISOString(),
  });
  ok(deployed);
  assert.equal(deployed.body.deployed, 1, JSON.stringify(deployed.body));
  return db.state.Subscription.find(sub => sub.freeTrialRequestId === request.id);
}

test('one user gets 10 GB from A and 20 GB from B, with independent allocation owners and 30 GB available', async () => {
  const { a, b } = await sales();
  assert.equal(a.allocation.userId, 'u1');
  assert.equal(b.allocation.userId, 'u1');
  assert.equal(a.allocation.resellerId, 'res-r1');
  assert.equal(b.allocation.resellerId, 'res-r2');
  assert.equal(a.allocation.allocatedBytes, bytes(10));
  assert.equal(b.allocation.allocatedBytes, bytes(20));
  assert.equal(b.allocation.type, 'sold');
  assert.ok(a.allocation.createdAt && b.allocation.createdAt);
  assert.equal(a.allocation.profileId, 'p1');
  assert.equal('token' in b.client, false, 'a second seller must not acquire device-control credentials');
  assert.equal(row('VpnClient', 'c1').resellerId, 'res-r1', 'a sale does not reassign the account');
  const views = await Promise.all(['r1', 'r2'].map(actor => api(actor, 'GET', '/subscriptions')));
  for (const response of views) ok(response);
  assert.deepEqual(views.map(response => response.body.subscriptions.map(sub => sub.id)), [[a.id], [b.id]]);
  assert.equal(row('Reseller', 'res-r1').quotaUsedBytes, 10n * GO);
  assert.equal(row('Reseller', 'res-r2').quotaUsedBytes, 20n * GO);
  const available = await api('u1', 'GET', '/mobile/connections', undefined,
    { 'X-SXB-Device-ID': row('VpnClient', 'c1').deviceId });
  ok(available);
  assert.equal(available.body.allocationSummary.soldBytes, bytes(30));
  assert.equal(available.body.allocationSummary.remainingBytes, bytes(30));
});

test('a 15 GB system trial on the same account never changes either reseller balance or sales history', async () => {
  await sales();
  const balances = db.state.Reseller.map(merchant => [merchant.id, merchant.quotaBytes, merchant.quotaUsedBytes]);
  const movements = structuredClone(db.state.ResellerQuotaMovement);
  const free = await trial();
  assert.equal(free.clientId, 'c1');
  assert.equal(free.allocationUserId, 'u1');
  assert.equal(free.allocationType, 'free_trial');
  assert.equal(free.allocationResellerId, null);
  assert.equal(free.allocationOwnerId, 'root');
  assert.deepEqual(db.state.Reseller.map(merchant => [merchant.id, merchant.quotaBytes, merchant.quotaUsedBytes]), balances);
  assert.deepEqual(db.state.ResellerQuotaMovement, movements);
  const available = await api('u1', 'GET', '/mobile/connections', undefined,
    { 'X-SXB-Device-ID': row('VpnClient', 'c1').deviceId });
  ok(available);
  assert.equal(available.body.allocationSummary.soldBytes, bytes(30));
  assert.equal(available.body.allocationSummary.freeTrialBytes, bytes(15));
  assert.equal(available.body.allocationSummary.remainingBytes, bytes(45));
  for (const [actor, amount] of [['r1', 10], ['r2', 20]]) {
    const ledger = await api(actor, 'GET', '/data-additions');
    ok(ledger);
    assert.equal(ledger.body.totals.addedBytes, bytes(amount));
    assert.ok(ledger.body.additions.every(entry => entry.allocationType === 'sold'));
  }
});

test('usage remains on its exact sold/trial allocation and a replay cannot debit another owner', async () => {
  const { a, b } = await sales();
  const free = await trial();
  for (const [allocation, used] of [[a, 2], [b, 3], [free, 4]]) {
    const report = { bytesUp: 0, bytesDown: Number(BigInt(used) * GO), sessionId: `synthetic-${allocation.id}`,
      seq: 1, subscriptionId: allocation.id, deviceId: row('VpnClient', 'c1').deviceId };
    const applied = await api('u1', 'POST', '/mobile/vpn/traffic', report);
    ok(applied);
    assert.equal(applied.body.subscriptionId, allocation.id);
    const replay = await api('u1', 'POST', '/mobile/vpn/traffic', report);
    ok(replay);
    assert.equal(replay.body.duplicate, true);
    assert.equal(row('Subscription', allocation.id).quotaUsed, BigInt(used) * GO);
  }
  assert.equal(row('Reseller', 'res-r1').quotaUsedBytes, 10n * GO);
  assert.equal(row('Reseller', 'res-r2').quotaUsedBytes, 20n * GO);
  const access = await api('u1', 'GET', '/mobile/connections', undefined,
    { 'X-SXB-Device-ID': row('VpnClient', 'c1').deviceId });
  ok(access);
  assert.equal(access.body.allocationSummary.remainingBytes, bytes(36));
  assert.deepEqual(access.body.connections.map(connection => [connection.allocation.resellerId, connection.allocation.remainingBytes])
    .sort(), [[null, bytes(11)], ['res-r1', bytes(8)], ['res-r2', bytes(17)]].sort());
});

test('a seller cannot edit/delete another sale or system trial; reassigning the account does not reassign sales', async () => {
  const { a, b } = await sales();
  const free = await trial();
  ok(await api('r1', 'PUT', `/subscriptions/${b.id}`, { quotaGB: 60 }), 404);
  ok(await api('r2', 'DELETE', `/subscriptions/${a.id}`), 404);
  ok(await api('r1', 'POST', `/subscriptions/${free.id}/revoke`, {}), 404);
  row('VpnClient', 'c1').resellerId = 'res-r2';
  const aView = await api('r1', 'GET', '/subscriptions');
  ok(aView);
  assert.deepEqual(aView.body.subscriptions.map(sub => sub.id), [a.id]);
  ok(await api('r1', 'PUT', `/subscriptions/${a.id}`, { quotaGB: 12 }));
  assert.equal(row('Reseller', 'res-r1').quotaUsedBytes, 12n * GO);
  assert.equal(row('Reseller', 'res-r2').quotaUsedBytes, 20n * GO);
  assert.equal(row('Subscription', a.id).allocationResellerId, 'res-r1');
  assert.equal(row('Subscription', free.id).quotaBytes, 15n * GO);
});

test('another seller cannot select arbitrary customer IDs or seize a hidden customer without its supplied account code', async () => {
  await sales();
  ok(await api('r2', 'POST', '/subscriptions', { clientId: 'c1', profileId: 'p1', quotaGB: 1, durationDays: 30 }), 403);
  ok(await api('r2', 'POST', '/subscriptions', {
    recipientToken: 'SXB-USER-NOT-A-CUSTOMER', profileId: 'p1', quotaGB: 1, durationDays: 30,
  }), 404);
  const denied = await api('r2', 'POST', '/subscriptions', {
    clientId: 'c1', recipientToken: row('VpnClient', 'c1').token, profileId: 'p1', quotaGB: 1, durationDays: 30,
  });
  ok(denied, 400);
  assert.equal(row('Reseller', 'res-r1').quotaUsedBytes, 10n * GO);
  assert.equal(row('Reseller', 'res-r2').quotaUsedBytes, 20n * GO);
});

  test('shared-account deletion, suspension and code rotation cannot remove another seller or system allocation', async () => {
    await sales();
    await trial();
    const identity = structuredClone(row('VpnClient', 'c1'));
    for (const [method, endpoint, body] of [
      ['DELETE', '/clients/c1', undefined],
      ['POST', '/clients/c1/suspend', {}],
      ['POST', '/clients/c1/reset-access', {}],
      ['POST', '/devices/c1/revoke', {}],
      ['PATCH', '/clients/c1', { status: 'disabled' }],
    ]) {
      const response = await api('r1', method, endpoint, body);
      ok(response, 409);
      assert.equal(response.body.code, 'SHARED_ALLOCATION_ACCOUNT');
    }
    assert.deepEqual(row('VpnClient', 'c1'), identity);
    assert.equal(db.state.Subscription.length, 3);
    assert.equal(row('Reseller', 'res-r1').quotaUsedBytes, 10n * GO);
    assert.equal(row('Reseller', 'res-r2').quotaUsedBytes, 20n * GO);
  });

  test('only the expired seller is blocked; the buyer retains B and the independent system trial', async () => {
    const { a, b } = await sales();
    const free = await trial();
    row('Reseller', 'res-r1').accessExpiresAt = new Date(Date.now() - 1000);
    const metadata = { 'X-SXB-Device-ID': row('VpnClient', 'c1').deviceId };
    const access = await api('u1', 'GET', '/mobile/connections', undefined, metadata);
    ok(access);
    assert.equal(access.body.connections.find(connection => connection.id === a.id).status, 'expired');
    assert.equal(access.body.connections.find(connection => connection.id === b.id).status, 'active');
    assert.equal(access.body.connections.find(connection => connection.id === free.id).status, 'active');
    assert.equal(access.body.allocationSummary.remainingBytes, bytes(35));
    ok(await api('u1', 'GET', '/mobile/me', undefined, metadata));
    const blocked = await api('u1', 'GET', `/mobile/vpn/config?subscriptionId=${a.id}`, undefined, metadata);
    ok(blocked, 403);
    assert.equal(blocked.body.code, 'CONFIG_EXPIRED');
    ok(await api('u1', 'GET', `/mobile/vpn/config?subscriptionId=${b.id}`, undefined, metadata));
  });

  test('dashboard, graph, server history and client/device counters contain only the requesting seller allocation', async () => {
    const { a, b } = await sales();
    const free = await trial();
    for (const [allocation, amount] of [[a, 2], [b, 3], [free, 4]]) {
      ok(await api('u1', 'POST', '/mobile/vpn/traffic', {
        bytesUp: 0, bytesDown: Number(BigInt(amount) * GO), seq: 1, sessionId: `owned-counter-${allocation.id}`,
        subscriptionId: allocation.id, deviceId: row('VpnClient', 'c1').deviceId,
      }));
    }
    for (const [actor, total, used] of [['r1', 10, 2], ['r2', 20, 3]]) {
      const dashboard = await api(actor, 'GET', '/dashboard/stats');
      ok(dashboard);
      assert.equal(dashboard.body.resellerQuota.committedBytes, bytes(total));
      assert.equal(dashboard.body.resellerQuota.consumedBytes, bytes(used));
      assert.equal(dashboard.body.provisionedTraffic, total);
      assert.equal(dashboard.body.consumedTraffic, used);
      const chart = await api(actor, 'GET', '/dashboard/traffic');
      ok(chart);
      assert.equal(chart.body.reduce((sum, point) => sum + point.download, 0), used);
      const analytics = await api(actor, 'GET', '/analytics/traffic');
      ok(analytics);
      assert.equal(analytics.body.bandwidthProvisionedGb, total);
      assert.equal(analytics.body.bandwidthConsumedGb, used);
      const history = await api(actor, 'GET', '/data-additions/servers/p1');
      ok(history);
      assert.equal(history.body.server.usedBytes, bytes(used));
      assert.equal(history.body.server.remainingBytes, bytes(total - used));
    }
    const clients = await api('r1', 'GET', '/clients');
    ok(clients);
    assert.equal(clients.body.find(client => client.id === 'c1').quotaUsed, bytes(2));
    const devices = await api('r1', 'GET', '/devices');
    ok(devices);
    assert.equal(devices.body.devices.find(device => device.id === 'c1').quotaUsed, bytes(2));
  });

  test('ownership migration reconciles an old wrong reservation with a receipt, without changing limits or B balance', async () => {
    await sales();
    await trial();
    row('Reseller', 'res-r1').quotaUsedBytes = 45n * GO;
    const first = await routes.reconcilierAllocationsRevendeurs(db);
    assert.equal(first.corrected, 1);
    assert.equal(row('Reseller', 'res-r1').quotaBytes, 100n * GO);
    assert.equal(row('Reseller', 'res-r1').quotaUsedBytes, 10n * GO);
    assert.equal(row('Reseller', 'res-r2').quotaUsedBytes, 20n * GO);
    const movement = db.state.ResellerQuotaMovement.find(value => value.referenceType === 'allocation_ownership_migration');
    assert.equal(movement.resellerId, 'res-r1');
    assert.equal(movement.deltaBytes, -35n * GO);
    assert.equal(movement.allocatedBeforeBytes, 45n * GO);
    assert.equal(movement.allocatedAfterBytes, 10n * GO);
    const count = db.state.ResellerQuotaMovement.length;
    assert.equal((await routes.reconcilierAllocationsRevendeurs(db)).corrected, 0);
    assert.equal(db.state.ResellerQuotaMovement.length, count);
  });

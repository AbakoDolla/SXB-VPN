import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { api, db, routes, row, ok, tomorrow } from './reseller-http.test.mjs';

function fixture() {
  const gate = { passwordHash: 'synthetic-gate-hash', version: 1, updatedAt: new Date().toISOString(), updatedById: 'root' };
  db.state.Setting.push({ key: 'sxb.security-gate.v1', value: JSON.stringify(gate) });
  const headers = actor => ({ 'X-SXB-Security-Unlock': routes.issueSecurityUnlock(gate, actor, false).unlockToken });
  row('VpnClient', 'direct').managedById = 'root';
  row('Reseller', 'res-r2').createdBy = 'root';
  const sessions = [['public-session', 'c1', 'public-device'], ['private-session', 'direct', 'private-device'],
    ['private-reseller-session', 'c2', 'private-reseller-device']];
  for (const [id, clientId, deviceId] of sessions) {
    row('VpnClient', clientId).deviceId = deviceId;
    row('VpnClient', clientId).deviceKeyId = 'a'.repeat(64);
    db.state.ActivationSession.push({
      id, clientId, deviceId, status: 'active', activationDate: new Date(), lastSync: new Date(),
      authGeneration: 7, authExpiresAt: tomorrow(), authRevokedAt: null,
      refreshJti: 'synthetic-refresh-secret-must-not-leak', previousRefreshJti: 'synthetic-old-refresh',
    });
  }
  const event = data => ({ id: randomUUID(), eventType: 'DEVICE_MISMATCH', severity: 'warning',
    userId: null, deviceId: null, sessionId: null, metadata: null, acknowledged: false,
    acknowledgedAt: null, acknowledgedById: null, createdAt: new Date(), ...data });
  const publicEvent = event({ userId: 'u1', sessionId: 'public-session', deviceId: 'public-device' });
  const privateEvents = [
    event({ userId: 'root' }),
    event({ userId: 'direct-user' }),
    event({ userId: 'u2', sessionId: 'private-reseller-session' }),
    event({ sessionId: 'private-session' }),
    event({ deviceId: 'private-device' }),
    event({ userId: 'u1', sessionId: 'public-session', metadata: JSON.stringify({ role: 'OWNER', reason: 'manual' }) }),
    event({ userId: 'u1', sessionId: 'public-session', acknowledged: true, acknowledgedById: 'root' }),
  ];
  db.state.SecurityEvent.push(publicEvent, ...privateEvents);
  const audit = (userId, action, visibleOwnerOnly = false) => ({
    id: randomUUID(), userId, action, visibleOwnerOnly, timestamp: new Date(), type: 'info', ipAddress: '192.0.2.1',
  });
  db.state.AuditLog.push(audit('root', 'PRIVATE_OWNER_ACTION'), audit('direct-user', 'PRIVATE_CLIENT_ACTION'),
    audit('r2', 'PRIVATE_RESELLER_ACTION'), audit('super', 'PUBLIC_OPERATOR_ACTION'),
    audit('admin', 'PUBLIC_ADMIN_ACTION'), audit('u1', 'PUBLIC_CLIENT_ACTION'), audit('super', 'PRIVATE_MARKED_ACTION', true),
    audit(null, 'PRIVATE_UNATTRIBUTABLE_ACTION'));
  return { headers, publicEvent, privateEvents };
}

test('owner privacy: events, counts, search and batch mutations share one server boundary', async () => {
  const { headers, publicEvent, privateEvents } = fixture();
  const ownerPage = await api('root', 'GET', '/security/events', undefined, headers('root'));
  ok(ownerPage);
  assert.equal(ownerPage.body.total, 8);
  const publicPage = await api('super', 'GET', '/security/events', undefined, headers('super'));
  ok(publicPage);
  assert.equal(publicPage.body.total, 1);
  assert.deepEqual(publicPage.body.events.map(event => event.id), [publicEvent.id]);
  const overview = await api('super', 'GET', '/security/overview', undefined, headers('super'));
  ok(overview);
  assert.equal(overview.body.overview.total, 1);
  assert.equal(overview.body.overview.warning, 1);
  for (const filter of ['userId=root', 'sessionId=private-session', 'deviceId=private-device', 'search=OWNER']) {
    const filtered = await api('super', 'GET', `/security/events?${filter}`, undefined, headers('super'));
    ok(filtered); assert.equal(filtered.body.total, 0); assert.deepEqual(filtered.body.events, []);
  }
  const before = structuredClone(privateEvents);
  const acknowledged = await api('super', 'POST', '/security/events/acknowledge', {
    ids: [publicEvent.id, ...privateEvents.map(event => event.id)],
  }, headers('super'));
  ok(acknowledged); assert.equal(acknowledged.body.acknowledged, 1);
  assert.deepEqual(db.state.SecurityEvent.filter(event => event.id !== publicEvent.id), before);
  const reopened = await api('super', 'POST', '/security/events/acknowledge', { ids: [publicEvent.id], acknowledged: false }, headers('super'));
  ok(reopened); assert.equal(reopened.body.acknowledged, 1);
  assert.equal(row('SecurityEvent', publicEvent.id).acknowledged, false);
});

test('owner privacy: legacy unflagged owner logs and private account projections are inaccessible', async () => {
  const { headers } = fixture();
  for (const actor of ['super', 'admin', 'support', 'r1', 'u1']) {
    const key = row('VpnClient', 'c1').deviceKeyId;
    if (actor === 'u1') row('VpnClient', 'c1').deviceKeyId = null;
    const result = await api(actor, 'GET', '/audit-logs');
    row('VpnClient', 'c1').deviceKeyId = key;
    ok(result);
    assert.ok(result.body.logs.every(log => !log.action.startsWith('PRIVATE_')));
    if (actor !== 'super') assert.ok(result.body.logs.every(log => log.user === actor));
  }
  const audit = await api('super', 'GET', '/security/audit', undefined, headers('super'));
  ok(audit);
  assert.equal(audit.body.total, 3);
  assert.ok(audit.body.entries.every(log => !log.action.startsWith('PRIVATE_')));
  const owner = await api('root', 'GET', '/security/audit?ownerOnly=true', undefined, headers('root'));
  ok(owner); assert.ok(owner.body.entries.some(log => log.action === 'PRIVATE_OWNER_ACTION'));
  for (const actor of ['super', 'admin', 'support']) {
    const users = await api(actor, 'GET', '/users');
    ok(users);
    for (const id of ['root', 'direct-user', 'r2', 'u2']) {
      assert.ok(!users.body.some(user => user.id === id), `${actor} leaked ${id}`);
      ok(await api(actor, 'GET', `/users/${id}`), 404);
      if (actor !== 'support') {
        ok(await api(actor, 'PATCH', `/users/${id}`, { name: 'forbidden' }), 404);
        ok(await api(actor, 'DELETE', `/users/${id}`), 404);
      }
    }
  }
  ok(await api('root', 'GET', '/users/direct-user'));
});

test('owner privacy: scoped session projections and quota histories exclude owner interventions', async () => {
  const { publicEvent } = fixture();
  const projected = await api('admin', 'GET', '/sessions/public-session/security-events');
  ok(projected);
  assert.deepEqual(projected.body.events.map(event => event.id), [publicEvent.id]);
  ok(await api('super', 'GET', '/sessions/private-session/security-events'), 404);
  ok(await api('super', 'GET', '/sessions/private-reseller-session/security-events'), 404);
  const movement = actor => ({
    id: randomUUID(), resellerId: 'res-r1', resellerUserId: 'r1', resellerName: 'public reseller',
    actorUserId: actor, actorName: `${actor}@example.test`, kind: 'ALLOCATION', reason: 'synthetic',
    deltaBytes: 1n, quotaBeforeBytes: 0n, quotaAfterBytes: 1n, allocatedBeforeBytes: 0n,
    allocatedAfterBytes: 1n, createdAt: new Date(),
  });
  db.state.ResellerQuotaMovement.push(movement('root'), movement('super'), movement(null));
  for (const actor of ['r1', 'super']) {
    const history = await api(actor, 'GET', '/resellers/quota-history');
    ok(history); assert.equal(history.body.movements.length, 1);
    assert.equal(history.body.movements[0].author, 'super@example.test');
  }
  const owner = await api('root', 'GET', '/resellers/quota-history');
  ok(owner); assert.equal(owner.body.movements.length, 3);
});

test('owner privacy: a root-created reseller keeps its own business access without disclosing the owner', async () => {
  const { headers } = fixture();
  const own = await api('r2', 'GET', '/clients');
  ok(own); assert.ok(own.body.some(client => client.id === 'c2'));
  for (const actor of ['admin', 'super']) {
    ok(await api(actor, 'GET', '/sessions/private-reseller-session/security-events'), 404);
  }
  const reconciliation = await api('super', 'GET', '/resellers/reconciliation');
  ok(reconciliation); assert.equal(reconciliation.body.totals.resellerRecords, 1);
  const first = await api('super', 'GET', '/security/audit?limit=1', undefined, headers('super'));
  const second = await api('super', 'GET', '/security/audit?limit=1&offset=1', undefined, headers('super'));
  ok(first); ok(second); assert.equal(first.body.total, 3);
  assert.notEqual(first.body.entries[0].id, second.body.entries[0].id);
  const search = await api('super', 'GET', '/security/audit?search=public_operator', undefined, headers('super'));
  ok(search); assert.equal(search.body.total, 1);
});

test('owner privacy: atomic generation revoke refuses a session transferred to the owner during the request', async () => {
  const { headers } = fixture();
  const find = db.activationSession.findFirst;
  db.activationSession.findFirst = async args => {
    const session = await find(args);
    if (session?.id === 'public-session') row('VpnClient', 'c1').managedById = 'root';
    return session;
  };
  try {
    const response = await api('super', 'POST', '/security/sessions/public-session/revoke', { generation: 7 }, headers('super'));
    ok(response); assert.equal(response.body.revoked, false);
    assert.equal(row('ActivationSession', 'public-session').authRevokedAt, null);
  } finally { db.activationSession.findFirst = find; }
});

test('security inventory: role, unlock, states, pagination, filters and secret-free projection', async () => {
  const { headers } = fixture();
  for (const actor of ['admin', 'support', 'r1', 'u1']) {
    const key = row('VpnClient', 'c1').deviceKeyId;
    if (actor === 'u1') row('VpnClient', 'c1').deviceKeyId = null;
    const response = await api(actor, 'GET', '/security/sessions');
    row('VpnClient', 'c1').deviceKeyId = key;
    ok(response, 404);
  }
  ok(await api('root', 'GET', '/security/sessions'), 423);
  const superPage = await api('super', 'GET', '/security/sessions', undefined, headers('super'));
  ok(superPage); assert.equal(superPage.body.total, 1);
  assert.equal(superPage.body.sessions[0].id, 'public-session');
  assert.equal(superPage.body.sessions[0].state, 'active');
  assert.ok(!JSON.stringify(superPage.body).includes('synthetic-refresh'));
  assert.ok(!JSON.stringify(superPage.body).includes('passwordHash'));
  const first = await api('root', 'GET', '/security/sessions?limit=1', undefined, headers('root'));
  const second = await api('root', 'GET', '/security/sessions?limit=1&offset=1', undefined, headers('root'));
  ok(first); ok(second);
  assert.equal(first.body.total, 3); assert.notEqual(first.body.sessions[0].id, second.body.sessions[0].id);
  const search = await api('super', 'GET', '/security/sessions?search=private', undefined, headers('super'));
  ok(search); assert.equal(search.body.total, 0);
  ok(await api('super', 'POST', '/security/sessions/private-session/revoke', { generation: 7 }, headers('super')), 404);
  ok(await api('super', 'POST', '/security/devices/direct/authorize-key', { keyId: 'b'.repeat(64) }, headers('super')), 404);
  ok(await api('super', 'PUT', '/security/policy', {}, headers('super')), 403);
  assert.equal(row('ActivationSession', 'private-session').authRevokedAt, null);
  const stale = await api('root', 'POST', '/security/sessions/public-session/revoke', { generation: 6 }, headers('root'));
  ok(stale); assert.equal(stale.body.revoked, false);
  const revoked = await api('root', 'POST', '/security/sessions/public-session/revoke', { generation: 7 }, headers('root'));
  ok(revoked); assert.equal(revoked.body.revoked, true);
  assert.equal(row('VpnClient', 'c1').status, 'active');
  const filtered = await api('root', 'GET', '/security/sessions?state=revoked', undefined, headers('root'));
  ok(filtered); assert.equal(filtered.body.total, 1);
});

test('security pagination: invalid filters are explicit and owner lookup failures never open scope', async () => {
  const { headers } = fixture();
  for (const route of ['/security/events?from=2026-10-01T00%3A00%3A00Z&to=2026-09-01T00%3A00%3A00Z',
    '/security/events?severity=arbitrary', '/security/events?offset=-1', '/security/sessions?state=other',
    '/security/audit?limit=1000']) {
    ok(await api('root', 'GET', route, undefined, headers('root')), 400);
  }
  const original = db.user.findMany;
  db.user.findMany = async () => { throw new Error('Synthetic ownership lookup failure'); };
  try {
    for (const route of ['/security/events', '/security/overview', '/security/audit', '/security/sessions']) {
      const response = await api('super', 'GET', route, undefined, headers('super'));
      ok(response, 503);
    }
  } finally { db.user.findMany = original; }
});

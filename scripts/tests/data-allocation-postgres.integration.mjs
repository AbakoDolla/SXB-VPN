import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Called only by the explicitly isolated security PostgreSQL runner.
export async function verifyDataAllocationIsolation({ prisma, request, device, jwt, check, owner, role, reconcilierAllocationsRevendeurs }) {
  const url = new URL(process.env.SXB_SECURITY_TEST_DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && /security_(impl|upgrade)/.test(url.pathname));
  const suffix = randomUUID(), GB = 1024n ** 3n;
  const sellerRole = await prisma.role.upsert({ where: { name: 'RESELLER' }, create: { name: 'RESELLER' }, update: {} });
  for (const name of ['subscription.view', 'subscription.manage', 'clients.view', 'analytics.read']) {
    const permission = await prisma.permission.upsert({ where: { name }, create: { name }, update: {} });
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: sellerRole.id, permissionId: permission.id } },
      create: { roleId: sellerRole.id, permissionId: permission.id }, update: {},
    });
  }
  const merchants = [];
  for (const tag of ['A', 'B']) {
    const user = await prisma.user.create({ data: { roleId: sellerRole.id, name: `SYNTHETIC SELLER ${tag}`,
      email: `allocation-${tag}-${suffix}@example.invalid`, passwordHash: 'not-a-real-password-hash' } });
    const reseller = await prisma.reseller.create({ data: {
      userId: user.id, quotaBytes: 100n * GB, accessExpiresAt: new Date(Date.now() + 86400000),
    } });
    merchants.push({ user, reseller,
      token: jwt.sign({ userId: user.id, role: 'RESELLER' }, process.env.JWT_SECRET, { expiresIn: '15m' }) });
  }
  const [a, b] = merchants;
  const actor = device();
  const user = await prisma.user.create({ data: { roleId: role.id, name: 'SYNTHETIC MULTI-OWNER BUYER',
    email: `allocation-buyer-${suffix}@example.invalid`, passwordHash: 'not-a-real-password-hash' } });
  const client = await prisma.vpnClient.create({ data: {
    userId: user.id, resellerId: a.reseller.id, deviceId: actor.id,
    token: `SXB-USER-ALLOCATION-${suffix}`.toUpperCase(), expireAt: new Date(Date.now() + 365 * 86400000),
  } });
  const activation = await request(actor, '/api/mobile/auth/activate', {
    token: client.token, deviceId: actor.id, publicKey: actor.encoded, activationRequestId: randomUUID(),
  }, client.token);
  check('allocation buyer uses the genuine signed mobile identity', activation.status, 200);
  const mobileToken = activation.data.accessToken;
  const profile = await prisma.vpnProfile.create({ data: {
    name: 'SYNTHETIC ALLOCATION CONFIGURATION', protocol: 'ssh',
    host: 'synthetic-allocation.example.invalid', port: 22, createdBy: owner.user.id,
  } });
  await prisma.vpnProfileReseller.createMany({ data: merchants.map(seller => ({
    profileId: profile.id, resellerId: seller.reseller.id,
  })) });
  const saleA = await request(actor, '/api/subscriptions', {
    clientId: client.id, profileId: profile.id, quotaGB: 10, durationDays: 30,
  }, a.token);
  check('seller A creates a distinct 10 GB allocation', saleA.status, 201);
  const saleB = await request(actor, '/api/subscriptions', {
    recipientToken: client.token, profileId: profile.id, quotaGB: 20, durationDays: 30,
  }, b.token);
  check('seller B can sell to the same supplied account without reassignment', saleB.status, 201);
  check('second sale leaves the original account owner intact',
    (await prisma.vpnClient.findUniqueOrThrow({ where: { id: client.id } })).resellerId, a.reseller.id);
  check('second seller receives no account activation code', 'token' in saleB.data.subscription.client, false);
  const balances = async () => {
    const values = await prisma.reseller.findMany({ where: { id: { in: merchants.map(seller => seller.reseller.id) } }, orderBy: { id: 'asc' } });
    return values.map(seller => [seller.id, seller.quotaBytes.toString(), seller.quotaUsedBytes.toString()]);
  };
  const beforeTrial = await balances();
  check('A commitment is only its own 10 GB',
    (await prisma.reseller.findUniqueOrThrow({ where: { id: a.reseller.id } })).quotaUsedBytes, 10n * GB);
  check('B commitment is only its own 20 GB',
    (await prisma.reseller.findUniqueOrThrow({ where: { id: b.reseller.id } })).quotaUsedBytes, 20n * GB);
  const sold = await request(actor, '/api/mobile/connections', undefined, mobileToken);
  check('buyer has 30 GB sold across its applicable allocations', sold.data.allocationSummary.remainingBytes, String(30n * GB));
  const invitation = await prisma.freeTrialToken.create({ data: {
    token: `STUFF-ALLOCATION-${suffix}`, createdBy: owner.user.id,
  } });
  const trialRequest = await prisma.freeTrialRequest.create({ data: {
    tokenId: invitation.id, deviceId: actor.id, name: 'SYNTHETIC MULTI-OWNER BUYER', country: 'CM',
    claimSecretHash: 'synthetic-claim-not-a-real-credential',
  } });
  const trial = await request(actor, '/api/free-trial/requests/deploy', {
    requestIds: [trialRequest.id], tokenId: invitation.id, profileId: profile.id, quotaGB: 15,
    expireAt: new Date(Date.now() + 30 * 86400000).toISOString(),
  }, owner.token);
  check('system deploys a third 15 GB free-trial allocation', trial.status, 200);
  check('trial deployment succeeds once', trial.data.deployed, 1);
  assert.deepEqual(await balances(), beforeTrial, 'a system grant must not change any seller balance');
  const allocations = await prisma.subscription.findMany({ where: { clientId: client.id }, orderBy: { createdAt: 'asc' } });
  const free = allocations.find(row => row.allocationType === 'free_trial');
  check('trial has no reseller funding ID', free.allocationResellerId, null);
  check('all three allocations retain the same user ID', allocations.every(row => row.allocationUserId === user.id), true);
  check('all three allocations retain configuration and creation time', allocations.every(row => row.profileId === profile.id && row.createdAt instanceof Date), true);
  check('system grant cannot append a reseller commitment or release',
    await prisma.resellerQuotaMovement.count({ where: { referenceId: trialRequest.id } }), 0);
  const full = await request(actor, '/api/mobile/connections', undefined, mobileToken);
  check('buyer total is 45 GB while trial funding remains separate', full.data.allocationSummary.remainingBytes, String(45n * GB));
  check('sold total remains 30 GB', full.data.allocationSummary.soldBytes, String(30n * GB));
  check('trial total is 15 GB', full.data.allocationSummary.freeTrialBytes, String(15n * GB));
  for (const [seller, allocation] of [[a, saleA.data.subscription], [b, saleB.data.subscription]]) {
    const list = await request(actor, '/api/subscriptions', undefined, seller.token);
    check('seller sees exactly one owned allocation', list.data.subscriptions.length, 1);
    check('seller sees its own allocation, not the account owner allocation', list.data.subscriptions[0].id, allocation.id);
  }
  check('A cannot modify B funding', (await request(actor, `/api/subscriptions/${saleB.data.subscription.id}`,
    { quotaGB: 50 }, a.token, { method: 'PUT' })).status, 404);
  check('B cannot revoke system funding', (await request(actor, `/api/subscriptions/${free.id}/revoke`, {}, b.token)).status, 404);
  await assert.rejects(prisma.subscription.update({ where: { id: saleA.data.subscription.id },
    data: { allocationResellerId: b.reseller.id } }));
  check('PostgreSQL prevents historical owner rewrites',
    (await prisma.subscription.findUniqueOrThrow({ where: { id: saleA.data.subscription.id } })).allocationResellerId, a.reseller.id);
  await assert.rejects(prisma.subscription.update({ where: { id: free.id }, data: { allocationType: 'sold' } }));
  check('PostgreSQL prevents free-trial funding from silently becoming a sale',
    (await prisma.subscription.findUniqueOrThrow({ where: { id: free.id } })).allocationType, 'free_trial');

  for (const [allocation, used] of [[saleA.data.subscription, 2], [saleB.data.subscription, 3], [free, 4]]) {
    const connectionId = randomUUID(), sessionId = `sess_${connectionId}`;
    const bound = await request(actor, '/api/mobile/vpn/session', { action: 'sync', connectionId, sessionId,
      subscriptionId: allocation.id, configId: allocation.id }, mobileToken);
    check('usage binding identifies exactly one allocation', bound.status, 200);
    const report = { bytesUp: 0, bytesDown: Number(BigInt(used) * GB), sessionId, seq: 1,
      subscriptionId: allocation.id, deviceId: actor.id };
    check('signed usage debits its own allocation', (await request(actor, '/api/mobile/vpn/traffic', report, mobileToken)).status, 200);
    check('duplicate signed receipt never debits another allocation', (await request(actor, '/api/mobile/vpn/traffic', report, mobileToken)).data.duplicate, true);
    check('exact used bytes remain attached to the original funding identity',
      (await prisma.subscription.findUniqueOrThrow({ where: { id: allocation.id } })).quotaUsed, BigInt(used) * GB);
  }
  assert.deepEqual(await balances(), beforeTrial, 'usage never transfers reserved capacity between sellers');
  const remaining = await request(actor, '/api/mobile/connections', undefined, mobileToken);
  check('buyer remaining is 8 + 17 + 11 GB', remaining.data.allocationSummary.remainingBytes, String(36n * GB));
  await prisma.reseller.update({ where: { id: a.reseller.id }, data: { accessExpiresAt: new Date(Date.now() - 1000) } });
  const independent = await request(actor, '/api/mobile/connections', undefined, mobileToken);
  check('expired seller A does not log the shared buyer out', independent.status, 200);
  check('only expired A allocation is blocked', independent.data.connections.find(row => row.id === saleA.data.subscription.id).status, 'expired');
  check('B allocation remains active', independent.data.connections.find(row => row.id === saleB.data.subscription.id).status, 'active');
  check('system trial remains active', independent.data.connections.find(row => row.id === free.id).status, 'active');
  check('applicable remaining excludes only expired A', independent.data.allocationSummary.remainingBytes, String(28n * GB));
  await prisma.reseller.update({ where: { id: a.reseller.id }, data: { accessExpiresAt: new Date(Date.now() + 86400000) } });

  const concurrent = await Promise.all(merchants.map(seller => request(actor, '/api/subscriptions', {
    recipientToken: client.token, profileId: profile.id, quotaGB: 1, durationDays: 30,
  }, seller.token)));
  check('concurrent independent sellers both succeed without an owner transfer', concurrent.every(result => result.status === 201), true);
  check('A concurrent sale commits only A capacity',
    (await prisma.reseller.findUniqueOrThrow({ where: { id: a.reseller.id } })).quotaUsedBytes, 11n * GB);
  check('B concurrent sale commits only B capacity',
    (await prisma.reseller.findUniqueOrThrow({ where: { id: b.reseller.id } })).quotaUsedBytes, 21n * GB);
  check('parallel sales leave all funding identities separate', await prisma.subscription.count({ where: { clientId: client.id } }), 5);

  const legacyUser = await prisma.user.create({ data: {
    roleId: role.id, name: 'SYNTHETIC HISTORICAL BUYER',
    email: `allocation-legacy-${suffix}@example.invalid`, passwordHash: 'not-a-real-password-hash',
  } });
  const historical = await prisma.vpnClient.create({ data: { userId: legacyUser.id, resellerId: a.reseller.id,
    token: `SXB-USER-LEGACY-${suffix}` } });
  const legacy = [];
  for (const [name, creator, volume, used] of [
    ['A', a.user.id, 4, 1], ['B', b.user.id, 7, 2],
    ['converted-trial', owner.user.id, 3, 0], ['snapshot-only', owner.user.id, 5, 0],
  ]) legacy.push(await prisma.subscription.create({ data: {
    clientId: historical.id, profileId: profile.id, name: `SYNTHETIC LEGACY ${name}`,
    dataToken: `SXB-DATA-LEGACY-${randomUUID()}`, createdBy: creator,
    quotaBytes: BigInt(volume) * GB, quotaUsed: BigInt(used) * GB, durationDays: 30,
    expireAt: new Date(Date.now() + 30 * 86400000),
  } }));
  await prisma.dataAddition.create({ data: {
    subscriptionId: legacy[2].id, clientId: historical.id, profileId: profile.id,
    subscriptionName: legacy[2].name, clientName: legacyUser.name, profileName: profile.name,
    actorUserId: owner.user.id, actorName: 'SYNTHETIC SYSTEM', kind: 'creation', freeTrial: true,
    addedBytes: 3n * GB, quotaBeforeBytes: 0n, quotaAfterBytes: 3n * GB,
  } });
  const core = rows => rows.map(row => [row.id, row.clientId, row.profileId,
    row.quotaBytes.toString(), row.quotaUsed.toString(), row.createdAt.toISOString(), row.expireAt.toISOString()]);
  const coreBefore = core(legacy);
  const orphanId = `deleted-allocation-${suffix}`;
  await prisma.dataAddition.create({ data: {
    subscriptionId: orphanId, clientId: historical.id, profileId: profile.id,
    subscriptionName: 'SYNTHETIC DELETED SALE B', clientName: legacyUser.name, profileName: profile.name,
    actorUserId: b.user.id, actorName: b.user.name, kind: 'creation', freeTrial: false,
    addedBytes: GB, quotaBeforeBytes: 0n, quotaAfterBytes: GB,
  } });
  const orphanTrial = `deleted-trial-${suffix}`;
  for (const [kind, freeTrial, before] of [['creation', true, 0n], ['ajout', false, GB]]) {
    await prisma.dataAddition.create({ data: {
      subscriptionId: orphanTrial, clientId: historical.id, profileId: profile.id,
      subscriptionName: 'SYNTHETIC DELETED CONVERTED TRIAL', clientName: legacyUser.name, profileName: profile.name,
      actorUserId: owner.user.id, actorName: 'SYNTHETIC SYSTEM', kind, freeTrial,
      addedBytes: GB, quotaBeforeBytes: before, quotaAfterBytes: before + GB,
    } });
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const backend = createRequire(path.join(root, 'backend', 'package.json'));
  const migrate = () => {
    const result = spawnSync(process.execPath, [backend.resolve('prisma/build/index.js'), 'db', 'execute',
      '--schema', path.join(root, 'prisma', 'schema.prisma'), '--file',
      path.join(root, 'prisma', 'migrations', '20261002043000_data_allocation_ownership', 'migration.sql')],
    { env: { ...process.env, DATABASE_URL: process.env.SXB_SECURITY_TEST_DATABASE_URL }, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, 'The exact additive ownership SQL must backfill successfully');
  };
  migrate();
  const frozen = await Promise.all(legacy.map(row => prisma.subscription.findUniqueOrThrow({ where: { id: row.id } })));
  assert.deepEqual(core(frozen), coreBefore, 'backfill must preserve amounts, usage, customer, configuration and dates');
  check('historical creator A is frozen independently of the account owner', frozen[0].allocationResellerId, a.reseller.id);
  check('historical creator B is frozen even on an A-owned account', frozen[1].allocationResellerId, b.reseller.id);
  check('converted trial keeps its original independent funding', frozen[2].allocationType, 'free_trial');
  check('converted trial never acquires a reseller debit', frozen[2].allocationResellerId, null);
  check('historical fallback is identified as a snapshot, not an invented original seller', frozen[3].allocationOrigin, 'legacy_account_snapshot');
  check('historical trial addition also keeps its original independent funding',
    (await prisma.dataAddition.findFirstOrThrow({ where: { subscriptionId: frozen[2].id } })).allocationResellerId, null);
  check('a deleted historical sale retains its seller in the additions ledger',
    (await prisma.dataAddition.findFirstOrThrow({ where: { subscriptionId: orphanId } })).allocationResellerId, b.reseller.id);
  const deletedTrialHistory = await prisma.dataAddition.findMany({ where: { subscriptionId: orphanTrial } });
  check('deleted converted-trial additions do not become reseller sales',
    deletedTrialHistory.every(row => row.allocationType === 'free_trial' && row.allocationResellerId === null), true);
  await prisma.reseller.update({ where: { id: a.reseller.id }, data: { quotaUsedBytes: 30n * GB } });
  await prisma.vpnClient.update({ where: { id: historical.id }, data: { resellerId: b.reseller.id } });
  migrate();
  check('repeating the backfill never follows a new account owner',
    (await prisma.subscription.findUniqueOrThrow({ where: { id: frozen[0].id } })).allocationResellerId, a.reseller.id);
  await reconcilierAllocationsRevendeurs(prisma);
  check('reservation reconciliation removes trial/foreign-sale overbilling from A',
    (await prisma.reseller.findUniqueOrThrow({ where: { id: a.reseller.id } })).quotaUsedBytes, 20n * GB);
  check('reservation reconciliation retains B ownership of its historical sale',
    (await prisma.reseller.findUniqueOrThrow({ where: { id: b.reseller.id } })).quotaUsedBytes, 28n * GB);
  const receipts = await prisma.resellerQuotaMovement.findMany({ where: {
    resellerId: { in: [a.reseller.id, b.reseller.id] }, referenceType: 'allocation_ownership_migration',
  } });
  check('both corrected balances have an immutable migration receipt', receipts.length, 2);
  const again = await reconcilierAllocationsRevendeurs(prisma);
  check('second reconciliation is idempotent', again.corrected, 0);
  check('second reconciliation adds no duplicate adjustments', await prisma.resellerQuotaMovement.count({ where: {
    resellerId: { in: [a.reseller.id, b.reseller.id] }, referenceType: 'allocation_ownership_migration',
  } }), receipts.length);
}

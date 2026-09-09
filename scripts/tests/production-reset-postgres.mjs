// Explicit CI entrypoint; intentionally not part of the ordinary *.test.mjs glob.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(root, 'backend', 'package.json'));
const run = promisify(execFile);
assert.equal(process.env.SXB_RESET_PG_TEST, '1', 'Explicit isolated PostgreSQL test flag is required');
const databaseUrl = new URL(process.env.DATABASE_URL);
assert.ok(['127.0.0.1', '[::1]'].includes(databaseUrl.hostname), 'Fixture database must be loopback');
assert.equal(databaseUrl.pathname, '/sxb_reset_fixture', 'Never run this suite on a production database');
assert.equal(databaseUrl.username, 'reset_fixture', 'Dedicated fixture database identity required');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { build } = require('esbuild');
const password = 'isolated-reset-owner-fixture-password';
const signingKey = 'isolated-reset-signing-key-never-used-in-production';
const protectedRoles = ['OWNER', 'ADMIN', 'SUPER_ADMIN'];
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function seed(db) {
  const roles = [...protectedRoles, 'RESELLER', 'SUPPORT', 'CLIENT', 'CUSTOM'];
  await db.role.createMany({ data: roles.map(name => ({ id: name, name })) });
  await db.permission.create({ data: { id: 'fixture-permission', name: 'clients.view' } });
  await db.rolePermission.create({ data: { roleId: 'ADMIN', permissionId: 'fixture-permission' } });
  const passwordHash = await bcrypt.hash(password, 10);
  for (const role of roles) {
    await db.user.create({ data: {
      id: role.toLowerCase(), name: `Fixture ${role}`, email: `${role.toLowerCase()}@example.test`,
      roleId: role, passwordHash, status: 'active',
    } });
  }
  await db.reseller.create({ data: { id: 'reseller-row', userId: 'reseller', quotaBytes: 1000n, quotaUsedBytes: 100n } });
  await db.vpnClient.create({ data: {
    id: 'client-row', userId: 'client', resellerId: 'reseller-row',
    token: 'SXB-USER-FIXTURE-CLIENT', deviceId: 'FIXTURE-DEVICE',
    activatedAt: new Date(), quotaTotal: 1000n, quotaUsed: 100n,
  } });
  await db.vpnClient.create({ data: {
    id: 'admin-license', userId: 'admin', token: 'SXB-USER-FIXTURE-ADMIN', quotaUsed: 50n,
  } });
  await db.sshPayload.create({ data: { id: 'payload', name: 'Fixture payload', content: 'fixture only' } });
  await db.sshAccount.create({ data: {
    id: 'ssh', name: 'Fixture SSH', host: 'vpn.example.test', username: 'fixture', password: 'fixture-only',
    payloadId: 'payload', quotaUsed: 100n,
  } });
  await db.vpnProfile.create({ data: {
    id: 'profile', name: 'Protected fixture profile', protocol: 'ssh', host: 'vpn.example.test', port: 22,
    payloadId: 'payload', lockPasswordHash: passwordHash, lockVersion: 1,
    engineType: 'ssh', engineAccountId: 'ssh',
  } });
  await db.vpnProfileReseller.create({ data: { profileId: 'profile', resellerId: 'reseller-row' } });
  await db.subscription.create({ data: {
    id: 'subscription', name: 'Fixture subscription', clientId: 'client-row', profileId: 'profile',
    dataToken: 'SXB-DATA-FIXTURE', quotaBytes: 1000n, quotaUsed: 100n, durationDays: 30,
  } });
  await db.subscriptionDevice.create({ data: { subscriptionId: 'subscription', deviceId: 'FIXTURE-DEVICE' } });
  await db.activationSession.create({ data: { clientId: 'client-row', deviceId: 'FIXTURE-DEVICE' } });
  await db.appRegistration.create({ data: { deviceId: 'FIXTURE-DEVICE', clientId: 'client-row', status: 'matched' } });
  await db.pushToken.create({ data: { token: 'fixture-fcm-token-not-production', userId: 'client', deviceId: 'FIXTURE-DEVICE' } });
  await db.tokenSXB.create({ data: {
    clientId: 'client-row', token: 'SXB-DATA-FIXTURE-UNUSED', quota: 100n,
    expiration: new Date(Date.now() + 86400000),
  } });
  await db.voucher.create({ data: {
    code: 'VCH-FIXTURE', quota: 100n, durationDays: 30, resellerId: 'reseller-row', redeemedClientId: 'client-row',
  } });
  await db.xrayAccount.create({ data: {
    id: 'xray', name: 'Fixture Xray', protocol: 'vless', host: 'vpn.example.test', port: 443,
    clientId: 'client-row', quotaUsed: 100n,
  } });
  await db.singboxAccount.create({ data: {
    id: 'singbox', name: 'Fixture Singbox', protocol: 'vless', host: 'vpn.example.test', port: 443,
    clientId: 'client-row', quotaUsed: 100n,
  } });
  await db.trafficUsage.create({ data: { clientId: 'client-row', download: 100n, upload: 10n } });
  await db.vpnLog.create({ data: { clientId: 'client-row', action: 'connect', details: 'Fixture only' } });
  await db.supportTicket.create({ data: { title: 'Fixture ticket', clientName: 'Fixture', userId: 'support' } });
  await db.supportTicket.create({ data: { title: 'Fixture public ticket', clientName: 'Fixture public' } });
  await db.mobileHealthDevice.create({ data: {
    id: 'health', pseudonym: 'fixture-health', appVersion: '1', versionCode: 1, tunnelState: 'connected', protocol: 'ssh',
  } });
  await db.mobileHealthReport.create({ data: {
    reportId: 'fixture-health-report', deviceId: 'health', tunnelState: 'connected', protocol: 'ssh',
  } });
  for (const role of ['owner', 'admin', 'super_admin', 'support']) {
    await db.adminToken.create({ data: {
      token: `SXB-ADMIN-FIXTURE-${role}`, userId: role, expiresAt: new Date(Date.now() + 86400000),
    } });
  }
  await db.vPSServer.create({ data: { id: 'server', name: 'Kept infrastructure', ip: '192.0.2.1', location: 'Fixture' } });
  await db.serverConfig.create({ data: { serverId: 'server', type: 'fixture', configurationEncrypted: 'fixture-encrypted' } });
  await db.setting.createMany({ data: [
    { key: 'maintenance_mode', value: 'false' }, { key: 'fixture.infrastructure', value: 'preserve' },
    { key: 'sxb.app-update.v1', value: '{"fixture":"preserve"}' },
  ] });
  await db.auditLog.createMany({ data: [
    { id: 'owner-audit', userId: 'owner', action: 'Owner fixture audit', type: 'info', visibleOwnerOnly: true },
    { id: 'client-audit', userId: 'client', action: 'Client fixture audit', type: 'info' },
  ] });
  await db.resellerQuotaMovement.create({ data: {
    id: 'ledger', resellerId: 'reseller-row', resellerUserId: 'reseller', resellerName: 'Fixture reseller',
    actorUserId: 'owner', actorName: 'Fixture owner', kind: 'ADMIN_ALLOCATION', reason: 'Fixture ledger',
    deltaBytes: 1000n, quotaBeforeBytes: 0n, quotaAfterBytes: 1000n, allocatedBeforeBytes: 0n, allocatedAfterBytes: 0n,
  } });
}

const businessModels = [
  'vpnClient', 'reseller', 'subscription', 'subscriptionDevice', 'tokenSXB', 'voucher',
  'vpnProfile', 'vpnProfileReseller', 'sshAccount', 'sshPayload', 'xrayAccount', 'singboxAccount',
  'trafficUsage', 'vpnLog', 'appRegistration', 'activationSession', 'pushToken',
  'mobileHealthDevice', 'mobileHealthReport', 'supportTicket',
];
async function businessCounts(db) {
  return Object.fromEntries(await Promise.all(businessModels.map(async name => [name, await db[name].count()])));
}
async function retained(db) {
  return {
    users: await db.user.findMany({ where: { roleId: { in: protectedRoles } }, orderBy: { id: 'asc' } }),
    tokens: await db.adminToken.findMany({ where: { userId: { in: ['owner', 'admin', 'super_admin'] } }, orderBy: { id: 'asc' } }),
    roles: await db.role.findMany({ orderBy: { id: 'asc' } }),
    permissions: await db.permission.findMany({ orderBy: { id: 'asc' } }),
    rolePermissions: await db.rolePermission.findMany(),
    servers: await db.vPSServer.findMany({ orderBy: { id: 'asc' } }),
    serverConfigs: await db.serverConfig.findMany({ orderBy: { id: 'asc' } }),
    ledger: await db.resellerQuotaMovement.findMany({ orderBy: { id: 'asc' } }),
  };
}
const requestBody = preview => ({
  mode: 'production', challenge: preview.challenge, confirmation: 'RESET SXB VPN', password,
});
const code = error => error.code || error.body?.code || '';

test('real PostgreSQL reset preserves administrators, rolls back failures and produces a restorable private backup', { timeout: 180000 }, async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sxb-reset-pg-'));
  const compiled = await mkdtemp(path.join(root, 'backend', '.sxb-reset-pg-'));
  const db = new PrismaClient();
  const peer = new PrismaClient();
  const restoreUrl = new URL(databaseUrl);
  restoreUrl.pathname = '/sxb_reset_restore';
  const restored = new PrismaClient({ datasources: { db: { url: restoreUrl.toString() } } });
  t.after(async () => {
    await Promise.all([db.$disconnect(), peer.$disconnect(), restored.$disconnect()]);
    delete globalThis.__sxbResetPgDb;
    await rm(compiled, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  });
  const identity = await db.$queryRaw`SELECT current_database() AS name`;
  assert.equal(identity[0].name, 'sxb_reset_fixture');
  assert.equal(await db.user.count(), 0, 'Disposable schema must start empty');
  await seed(db);
  const preservedBefore = await retained(db);
  const countsBefore = await businessCounts(db);
  const auditBefore = await db.auditLog.findMany({ orderBy: { id: 'asc' } });
  const marker = path.join(temporary, 'project-code-and-key-marker');
  await writeFile(marker, 'must survive the application reset', { mode: 0o600 });
  const projectFile = path.join(root, 'server.ts');
  const projectHash = createHash('sha256').update(await readFile(projectFile)).digest('hex');

  globalThis.__sxbResetPgDb = db;
  const bundle = path.join(compiled, 'reset.cjs');
  await build({
    entryPoints: [path.join(root, 'server', 'services', 'application-reset.ts')],
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: bundle, logLevel: 'silent',
    plugins: [{
      name: 'isolated-reset-database',
      setup(builder) {
        builder.onResolve({ filter: /(?:^|\/)database$/ }, () => ({ path: 'database', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents: 'export const prisma=globalThis.__sxbResetPgDb; export const inMemoryDb={settings:{}}; export async function logDbActivity(){}',
          loader: 'js',
        }));
      },
    }],
  });
  const { createResetService, createPostgresResetBackup } = require(bundle);
  let now = Date.now(), invalidations = 0;
  const create = (backup, database = db) => createResetService({
    db: database, jwtSecret: signingKey, backup, invalidateAccess: () => { invalidations++; }, now: () => now,
  });
  const failed = create(async () => { throw new Error('Fixture backup failure'); });
  const preview = await failed.preview('owner');
  assert.equal(preview.counts.users, 4);
  assert.equal(preview.counts.adminTokens, 1);
  assert.deepEqual(preview.preserved.usersByRole, { OWNER: 1, ADMIN: 1, SUPER_ADMIN: 1 });
  await assert.rejects(failed.preview('admin'), error => code(error) === 'OWNER_ONLY');
  await assert.rejects(failed.execute('owner', { ...requestBody(preview), password: 'wrong' }));
  await assert.rejects(failed.execute('owner', requestBody(preview)), error => code(error) === 'RESET_BACKUP_FAILED');
  assert.deepEqual(await businessCounts(db), countsBefore);
  assert.deepEqual(await retained(db), preservedBefore);
  assert.equal((await db.setting.findUnique({ where: { key: 'maintenance_mode' } })).value, 'false');

  let releaseBackup, enteredBackup;
  const entered = new Promise(resolve => { enteredBackup = resolve; });
  const gate = new Promise(resolve => { releaseBackup = resolve; });
  const holding = create(async () => {
    enteredBackup();
    await gate;
    throw new Error('Fixture backup failure after concurrent attempt');
  });
  const firstPreview = await holding.preview('owner');
  const secondPreview = await holding.preview('owner');
  const pendingReset = holding.execute('owner', requestBody(firstPreview));
  const pendingOutcome = pendingReset.then(() => null, error => error);
  await Promise.race([
    entered,
    pendingReset.then(() => { throw new Error('Reset skipped the required backup'); }),
  ]);
  const competing = create(async () => { throw new Error('Concurrent reset must not back up'); }, peer);
  let writerFinished = false;
  let rowLockAcquired = false;
  let writer;
  let rowLocker;
  try {
    await assert.rejects(competing.execute('owner', requestBody(secondPreview)), error => code(error) === 'RESET_IN_PROGRESS');
    writer = peer.user.create({ data: {
      id: 'after-lock', name: 'Concurrent fixture', email: 'after-lock@example.test',
      roleId: 'CLIENT', passwordHash: 'fixture-only',
    } }).then(row => { writerFinished = true; return row; });
    rowLocker = peer.$transaction(async transaction => {
      await transaction.$queryRaw`SELECT id FROM ssh_accounts WHERE id = 'ssh' FOR UPDATE`;
      rowLockAcquired = true;
    });
    await delay(80);
    assert.equal(writerFinished, false, 'Concurrent writes must wait until the reset transaction releases its locks');
    assert.equal(rowLockAcquired, false, 'SELECT FOR UPDATE must not take row locks during the reset backup');
  } finally {
    releaseBackup();
  }
  assert.equal(code(await pendingOutcome), 'RESET_BACKUP_FAILED');
  await Promise.all([writer, rowLocker]);
  await db.user.delete({ where: { id: 'after-lock' } });
  assert.deepEqual(await businessCounts(db), countsBefore);
  assert.deepEqual(await retained(db), preservedBefore);
  assert.equal(invalidations, 0);

  let realDeletesReached = false;
  const brokenDb = new Proxy(db, {
    get(target, key) {
      if (key === '$transaction') return (callback, options) => {
        if (typeof callback !== 'function') return target.$transaction(callback, options);
        return target.$transaction(tx => callback(new Proxy(tx, {
        get(transaction, property) {
          if (property === 'vpnClient') return new Proxy(transaction.vpnClient, {
            get(model, method) {
              if (method === 'deleteMany') return async args => {
                await model.deleteMany(args);
                realDeletesReached = true;
                throw new Error('Fixture failure after real DELETE statements');
              };
              const value = Reflect.get(model, method);
              return typeof value === 'function' ? value.bind(model) : value;
            },
          });
          const value = Reflect.get(transaction, property);
          return typeof value === 'function' ? value.bind(transaction) : value;
        },
        })), options);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const rollback = create(async ({ resetId }) => ({ id: resetId, bytes: 4096, sha256: 'a'.repeat(64) }), brokenDb);
  await assert.rejects(rollback.execute('owner', requestBody(await rollback.preview('owner'))));
  assert.equal(realDeletesReached, true, 'Rollback scenario must reach real destructive statements');
  assert.deepEqual(await businessCounts(db), countsBefore, 'Actual PostgreSQL DELETE statements must roll back atomically');
  assert.deepEqual(await retained(db), preservedBefore);
  for (const audit of auditBefore) assert.deepEqual(await db.auditLog.findUnique({ where: { id: audit.id } }), audit);
  assert.equal((await db.setting.findUnique({ where: { key: 'maintenance_mode' } })).value, 'false');

  const backupDirectory = path.join(temporary, 'private-backups');
  const realBackup = createPostgresResetBackup({
    databaseUrl: databaseUrl.toString(), backupDirectory, timeoutMs: 60000,
    dumpCommand: process.env.PG_DUMP_BIN, restoreCommand: process.env.PG_RESTORE_BIN,
  });
  let backups = 0;
  const service = create(async options => {
    assert.equal((await db.setting.findUnique({ where: { key: 'maintenance_mode' } })).value, 'true');
    backups++;
    return realBackup(options);
  });
  const ready = await service.preview('owner');
  const result = await service.execute('owner', requestBody(ready));
  assert.equal(result.status, 'completed');
  assert.equal(result.maintenanceRestored, true);
  assert.ok(Object.values(result.countsAfter).every(value => value === 0));
  assert.deepEqual(await businessCounts(db), Object.fromEntries(businessModels.map(name => [name, 0])));
  assert.deepEqual(await retained(db), preservedBefore);
  assert.equal(await db.user.count(), 3);
  assert.equal(await readFile(marker, 'utf8'), 'must survive the application reset');
  assert.equal(createHash('sha256').update(await readFile(projectFile)).digest('hex'), projectHash);
  assert.equal((await db.setting.findUnique({ where: { key: 'fixture.infrastructure' } })).value, 'preserve');
  assert.equal((await db.setting.findUnique({ where: { key: 'sxb.app-update.v1' } })).value, '{"fixture":"preserve"}');
  for (const audit of auditBefore) {
    assert.deepEqual(await db.auditLog.findUnique({ where: { id: audit.id } }),
      { ...audit, userId: audit.userId === 'client' ? null : audit.userId });
  }
  await assert.rejects(db.resellerQuotaMovement.deleteMany(), 'Append-only protection must remain installed');
  assert.equal(await db.resellerQuotaMovement.count(), 1);
  assert.equal(invalidations, 1);

  const archive = path.join(backupDirectory, `reset-${result.backup.id}.dump`);
  const bytes = await readFile(archive);
  assert.equal(bytes.subarray(0, 5).toString(), 'PGDMP');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), result.backup.sha256);
  assert.equal((await stat(archive)).mode & 0o077, 0, 'Backup must not be group/world readable');
  await run(process.env.PG_RESTORE_BIN || 'pg_restore', ['--exit-on-error', '--no-owner', '--no-acl', '-d', 'sxb_reset_restore', archive], {
    env: { ...process.env, PGDATABASE: 'sxb_reset_restore' }, timeout: 60000,
  });
  assert.deepEqual(await businessCounts(restored), countsBefore, 'Actual private dump must restore deleted records');
  assert.deepEqual(await retained(restored), preservedBefore);
  assert.equal(await restored.user.count(), 7);
  assert.deepEqual(await restored.auditLog.findMany({ where: { id: { in: auditBefore.map(item => item.id) } }, orderBy: { id: 'asc' } }), auditBefore);

  await db.user.create({ data: {
    id: 'new-production-client', name: 'New fixture client', email: 'new@example.test',
    roleId: 'CLIENT', passwordHash: 'fixture-only',
  } });
  now += 10 * 60_000;
  const repeated = await service.execute('owner', requestBody(ready));
  assert.equal(repeated.resetId, result.resetId);
  assert.ok(await db.user.findUnique({ where: { id: 'new-production-client' } }));
  assert.equal(backups, 1, 'A retry must not produce another backup or delete newly created accounts');
  assert.equal(invalidations, 1);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import net from 'node:net';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'backend', 'package.json'));
const rollout = require(path.join(root, 'scripts', 'ssh-relay-rollout.cjs'));
const { parseConfig } = require(path.join(root, 'scripts', 'ssh-relay-preflight.cjs'));
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
const fingerprint = 'SHA256:' + Buffer.alloc(32, 1).toString('base64').replace(/=+$/, '');
const request = { host: 'provider.invalid', port: 80, username: 'synthetic',
  payload: 'GET / HTTP/1.1[crlf][crlf]', expectedFingerprint: fingerprint };
const hash = 'a'.repeat(64);
const canonical = { protocol: 'ssh+payload', ...request, password: 'synthetic-only' };
const profile = { id: 'profile-one', status: 'active', protocol: 'ssh+payload', configVersion: 2,
  canonicalConfig: 'synthetic-encrypted', canonicalConfigHash: hash, updatedAt: new Date() };
const api = {
  decryptCanonical: () => JSON.stringify(canonical), verifyCanonicalHash: () => true,
  engineConfigFromCanonical: value => value, relayUpstream: value => value,
  computeCanonicalHash: () => 'b'.repeat(64), canonicalJson: JSON.stringify, encryptCanonical: () => 'new-encrypted',
};
const transfer = { publicPageVerified: true, destinationTlsVerified: true, uploadBytes: 56, downloadBytes: 1024 };
const deps = {
  api, profiles: async () => [profile],
  verifyHost: async () => ({ status: 'host_key_matched', verifiedFingerprint: fingerprint }),
  verifyTransfer: async upstream => { assert.equal(upstream.fingerprint, fingerprint); return transfer; },
};
const enable = { mode: 'enable', profileId: profile.id, expectedHash: hash, confirmed: true };

test('rollout projection uses real Prisma fields; the supplier pin exists only inside the encrypted canonical', () => {
  const fields = new Set(require('@prisma/client').Prisma.dmmf.datamodel.models
    .find(model => model.name === 'VpnProfile').fields.map(field => field.name));
  for (const field of Object.keys(rollout.PROFILE_SELECT)) assert.ok(fields.has(field), `unknown field ${field}`);
  assert.equal(fields.has('fingerprint'), false);
});

test('rollout input contains no password and cannot broaden the transport selector', () => {
  assert.deepEqual(rollout.parseRequest(encode(request), parseConfig), request);
  for (const change of [{ password: 'private' }, { username: '' }, { command: 'anything' }, { port: 0 }]) {
    assert.throws(() => rollout.parseRequest(encode({ ...request, ...change }), parseConfig));
  }
  assert.throws(() => rollout.parseRequest('!!' + encode(request), parseConfig));
});

test('an explicit profile and separately trusted pin need no transport or credential secret', () => {
  assert.deepEqual(rollout.requestFromProfile(profile, fingerprint, api, parseConfig), request);
  assert.throws(() => rollout.requestFromProfile(profile, 'untrusted', api, parseConfig), /CONFIG_INVALID/);
  assert.throws(() => rollout.requestFromProfile(profile, fingerprint,
    { ...api, verifyCanonicalHash: () => false }, parseConfig), /CANONICAL_INVALID/);
  assert.throws(() => rollout.requestFromProfile({ ...profile, protocol: 'vless' }, fingerprint, api, parseConfig), /CANONICAL_INVALID/);
  const directApi = { ...api, decryptCanonical: () => JSON.stringify({ ...canonical, payload: undefined }) };
  const directRequest = rollout.requestFromProfile(profile, fingerprint, directApi, parseConfig);
  assert.equal(directRequest.payload, '');
  assert.equal(rollout.selectProfile([profile], directRequest, directApi).profile.id, profile.id);
});

test('selection is unique, exact and SSH-only; corrupt canonical material fails closed', () => {
  assert.equal(rollout.selectProfile([profile], request, api).profile.id, profile.id);
  assert.throws(() => rollout.selectProfile([profile, { ...profile, id: 'another' }], request, api), error => {
    assert.equal(error.message, 'ROLLOUT_PROFILE_AMBIGUOUS');
    assert.deepEqual(error.candidates, [
      { profileId: profile.id, status: 'active' }, { profileId: 'another', status: 'active' },
    ]);
    assert.equal(JSON.stringify(error.candidates).includes(request.username), false);
    return true;
  });
  assert.throws(() => rollout.selectProfile([{ ...profile, protocol: 'vless' }], request, api), /NOT_FOUND/);
  assert.throws(() => rollout.selectProfile([profile], { ...request, username: 'someone-else' }, api), /NOT_FOUND/);
  assert.throws(() => rollout.selectProfile([profile], request, { ...api, verifyCanonicalHash: () => false }), /CANONICAL_INVALID/);
});

test('inspect proves the pinned key and real transfer without mutation; changes need ID, hash and confirmation', async () => {
  const result = await rollout.prepareRollout({ mode: 'inspect' }, request, deps);
  assert.equal(result.verifiedFingerprint, fingerprint);
  assert.deepEqual(result.transfer, transfer);
  const direct = await rollout.prepareRollout({ mode: 'inspect-direct', profileId: profile.id }, request, deps);
  assert.equal(direct.mode, 'inspect-direct');
  assert.equal(direct.verifiedFingerprint, fingerprint);
  for (const input of [{ ...enable, confirmed: false }, { ...enable, expectedHash: '' }, { ...enable, profileId: '' }]) {
    await assert.rejects(rollout.prepareRollout(input, request, deps), /CONFIRMATION_REQUIRED/);
  }
  await assert.rejects(rollout.prepareRollout({ ...enable, expectedHash: 'c'.repeat(64) }, request, deps), /PROFILE_CHANGED/);
  await assert.rejects(rollout.prepareRollout(enable, request, {
    ...deps, verifyHost: async () => ({ status: 'host_key_unverified' }),
    verifyTransfer: async () => { assert.fail('credentials must not be sent after a bad pin'); },
  }), /KEY_UNVERIFIED/);
  await assert.rejects(rollout.prepareRollout(enable, request, {
    ...deps, verifyTransfer: async () => ({ ...transfer, publicPageVerified: false }),
  }), /TRANSFER_FAILED/);
  await assert.rejects(rollout.prepareRollout(enable, request, {
    ...deps, verifyTransfer: async () => ({ ...transfer, destinationTlsVerified: false }),
  }), /TRANSFER_FAILED/);
  await rollout.prepareRollout({ ...enable, mode: 'disable' }, request, {
    ...deps, verifyHost: async () => assert.fail('rollback must not depend on supplier reachability'),
  });
});

test('ambiguous selection reads only scoped counts and handles unlimited subscriptions', async () => {
  const calls = [];
  const candidates = [{ profileId: 'profile-one', status: 'active' }];
  const result = await rollout.selectionMetadata(candidates, {
    count: async query => { calls.push(query); return calls.length === 1 ? 3 : 1; },
  });
  assert.deepEqual(result, [{ ...candidates[0], subscriptions: 3, activeSubscriptions: 1 }]);
  assert.deepEqual(calls[0], { where: { profileId: 'profile-one' } });
  assert.equal(calls[1].where.profileId, 'profile-one');
  assert.equal(calls[1].where.status, 'active');
  assert.deepEqual(calls[1].where.OR[0], { expireAt: null });
  assert.ok(calls[1].where.OR[1].expireAt.gt instanceof Date);
  const fields = require('@prisma/client').Prisma.dmmf.datamodel.models
    .find(model => model.name === 'Subscription').fields.map(field => field.name);
  for (const field of ['profileId', 'status', 'expireAt']) assert.ok(fields.includes(field));
});

test('allowlist edits retain every unrelated key and profile and support an empty list', () => {
  const source = 'DATABASE_URL="synthetic"\r\nSXB_SSH_RELAY_PROFILE_IDS=other\r\nPORT=3000\r\n';
  const parsed = require('dotenv').parse(source);
  const edit = rollout.editAllowlist(source, parsed, profile.id, true);
  assert.equal(edit.value, 'other,profile-one');
  assert.equal(edit.source, source.replace('IDS=other', 'IDS=other,profile-one'));
  const restored = rollout.editAllowlist(edit.source, require('dotenv').parse(edit.source), profile.id, false);
  assert.equal(restored.source, source);
  assert.equal(rollout.editAllowlist('PORT=3000', {}, profile.id, true).source, 'PORT=3000\nSXB_SSH_RELAY_PROFILE_IDS=profile-one\n');
  assert.throws(() => rollout.editAllowlist(source + 'SXB_SSH_RELAY_PROFILE_IDS=duplicate\n', parsed, profile.id, true), /AMBIGUOUS/);
  const quoted = 'NOTE="SXB_SSH_RELAY_PROFILE_IDS=other"\n' + source;
  assert.equal(rollout.editAllowlist(quoted, require('dotenv').parse(quoted), profile.id, true).source,
    'NOTE="SXB_SSH_RELAY_PROFILE_IDS=other"\n' + edit.source);
  const embedded = 'NOTE="first\nSXB_SSH_RELAY_PROFILE_IDS=other\nlast"\n';
  assert.throws(() => rollout.editAllowlist(embedded, require('dotenv').parse(embedded), profile.id, true), /AMBIGUOUS/);
});

test('future SSH policy is persistent, scoped, monotonic and retained when removing an explicit profile', () => {
  const source = 'PORT=4000\r\nSXB_SSH_RELAY_PROFILE_IDS=other\r\n';
  const parse = require('dotenv').parse;
  const cutoff = '2026-01-01T00:00:00.000Z';
  const changed = rollout.rolloutEnvironment(source, parse(source), profile.id, true, cutoff);
  assert.equal(changed.before, source);
  assert.deepEqual(changed.value, { SXB_SSH_RELAY_PROFILE_IDS: 'other,profile-one', SXB_SSH_RELAY_REQUIRED_FROM: cutoff });
  assert.deepEqual(changed.previousValue, { SXB_SSH_RELAY_PROFILE_IDS: 'other', SXB_SSH_RELAY_REQUIRED_FROM: '' });
  assert.equal(parse(changed.after).PORT, '4000');
  assert.equal(parse(changed.after).SXB_SSH_RELAY_REQUIRED_FROM, cutoff);
  const removed = rollout.rolloutEnvironment(changed.after, parse(changed.after), profile.id, false);
  assert.equal(removed.value.SXB_SSH_RELAY_PROFILE_IDS, 'other');
  assert.equal(removed.value.SXB_SSH_RELAY_REQUIRED_FROM, cutoff);
  for (const invalid of ['invalid', '2026-01-01', '2999-01-01T00:00:00.000Z']) {
    assert.throws(() => rollout.rolloutEnvironment(source, parse(source), profile.id, true, invalid), /POLICY_INVALID/);
  }
  assert.throws(() => rollout.rolloutEnvironment(changed.after, parse(changed.after), profile.id, true,
    '2026-01-02T00:00:00.000Z'), /POLICY_DOWNGRADE/);
  assert.throws(() => rollout.rolloutEnvironment(source, parse(source), profile.id, false, cutoff), /ENABLE_ONLY/);
  const ambiguous = changed.after + 'SXB_SSH_RELAY_REQUIRED_FROM=' + cutoff + '\n';
  assert.throws(() => rollout.rolloutEnvironment(ambiguous, parse(ambiguous), profile.id, true, cutoff), /AMBIGUOUS/);
});

test('operator isolation cannot clear the backend module path or persist operator-only inputs', () => {
  const app = require(path.join(root, 'ecosystem.config.cjs')).apps.find(item => item.name === 'sxb-backend');
  const next = rollout.restartEnvironment({ NODE_PATH: '', PATH: 'synthetic-path',
    SXB_RELAY_ROLLOUT_CODE: 'synthetic-code', SXB_RELAY_CONFIRMED: 'true' }, app.env,
  { SXB_SSH_RELAY_PROFILE_IDS: 'profile-one', SXB_SSH_RELAY_REQUIRED_FROM: '2026-01-01T00:00:00.000Z' });
  assert.equal(next.NODE_PATH, app.env.NODE_PATH);
  assert.equal(next.NODE_ENV, 'production');
  assert.equal(next.PATH, 'synthetic-path');
  assert.equal(next.SXB_SSH_RELAY_PROFILE_IDS, 'profile-one');
  assert.equal(next.SXB_SSH_RELAY_REQUIRED_FROM, '2026-01-01T00:00:00.000Z');
  assert.equal(Object.keys(next).some(key => key.startsWith('SXB_RELAY_')), false);
});

test('removing an allowlist entry cannot claim to disable an automatically protected future profile', async () => {
  await assert.rejects(rollout.prepareRollout({ ...enable, mode: 'disable' }, request, {
    ...deps, requiredFrom: '2026-01-01T00:00:00.000Z',
    profiles: async () => [{ ...profile, createdAt: new Date('2026-01-02T00:00:00.000Z') }],
  }), /AUTOMATIC_POLICY_REQUIRED/);
});

test('environment compare-and-swap refuses a concurrent edit without losing any content', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sxb-rollout-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env');
  writeFileSync(file, 'original', { mode: 0o600 });
  rollout.replaceFile(file, 'original', 'changed');
  assert.equal(readFileSync(file, 'utf8'), 'changed');
  assert.throws(() => rollout.replaceFile(file, 'original', 'overwritten'), /ENV_CHANGED/);
  assert.equal(readFileSync(file, 'utf8'), 'changed');
});

test('an unsuccessful restart restores only our own profile/environment writes and reports failure', async () => {
  const plan = await rollout.prepareRollout(enable, request, deps);
  const calls = [];
  const effects = {
    api, environment: () => ({ before: 'old', after: 'new', value: 'profile-one', previousValue: '' }),
    backup: async () => calls.push('backup'),
    updateProfile: async () => calls.push('profile'),
    assertProfile: async () => calls.push('assert'),
    restoreProfile: async () => calls.push('restore'),
    replaceEnvironment: async (before, after) => calls.push(`${before}->${after}`),
    restart: async value => { calls.push(`restart:${value}`); if (value) throw new Error('failed'); },
    healthy: async () => calls.push('healthy'),
  };
  await assert.rejects(rollout.applyRollout(plan, effects), /FAILED_ROLLED_BACK/);
  assert.deepEqual(calls, ['backup', 'profile', 'old->new', 'restart:profile-one', 'new->old', 'restore', 'restart:', 'healthy']);
  await assert.rejects(rollout.applyRollout(plan, {
    ...effects, restoreProfile: async () => { throw new Error('concurrent owner edit'); },
  }), /ROLLBACK_REQUIRES_REVIEW/);
  calls.length = 0;
  await assert.rejects(rollout.applyRollout(plan, {
    ...effects, updateProfile: async () => { throw new Error('concurrent owner edit'); },
  }), /FAILED_ROLLED_BACK/);
  assert.deepEqual(calls, ['backup']);
});

test('successful enable and disable scope every write to the selected profile and retain the verified pin', async () => {
  for (const mode of ['enable', 'disable']) {
    const plan = await rollout.prepareRollout({ ...enable, mode }, request, deps);
    const calls = [];
    const enabled = mode === 'enable';
    const result = await rollout.applyRollout(plan, {
      api,
      environment: (id, active) => {
        assert.equal(id, profile.id); assert.equal(active, enabled);
        return { before: 'old', after: 'new', value: enabled ? 'other,profile-one' : 'other' };
      },
      backup: async value => { assert.equal(value, profile); calls.push('backup'); },
      updateProfile: async (value, update) => {
        assert.equal(value, profile);
        assert.deepEqual(update, { canonicalConfig: 'new-encrypted', canonicalConfigHash: 'b'.repeat(64),
          configVersion: 3 });
        const fields = require('@prisma/client').Prisma.dmmf.datamodel.models
          .find(model => model.name === 'VpnProfile').fields.map(field => field.name);
        for (const field of Object.keys(update)) assert.ok(fields.includes(field), `unknown write field ${field}`);
        calls.push('update');
      },
      assertProfile: async value => { assert.equal(value, profile); calls.push('assert'); },
      replaceEnvironment: async (before, after) => { assert.equal(before, 'old'); assert.equal(after, 'new'); calls.push('env'); },
      restart: async value => { assert.equal(value, enabled ? 'other,profile-one' : 'other'); calls.push('restart'); },
      healthy: async value => { assert.equal(value, enabled ? 'other,profile-one' : 'other'); calls.push('healthy'); },
    });
    assert.deepEqual(result, { profileId: profile.id, enabled, configHash: enabled ? 'b'.repeat(64) : hash });
    assert.deepEqual(calls, ['backup', enabled ? 'update' : 'assert', 'env', 'restart', 'healthy']);
  }
});

test('an unchanged canonical still checks freshness and an environment conflict restores only our profile write', async () => {
  const plan = await rollout.prepareRollout(enable, request, deps);
  const calls = [];
  const effects = {
    api: { ...api, computeCanonicalHash: () => hash },
    environment: () => ({ before: 'old', after: 'new', value: 'profile-one', previousValue: '' }),
    backup: async () => calls.push('backup'),
    updateProfile: async () => calls.push('update'),
    assertProfile: async () => { calls.push('assert'); throw new Error('concurrent edit'); },
    restoreProfile: async () => calls.push('restore'),
    replaceEnvironment: async () => { calls.push('env'); throw new Error('concurrent environment edit'); },
    restart: async () => assert.fail('do not restart after an environment conflict'),
  };
  await assert.rejects(rollout.applyRollout(plan, effects), /FAILED_ROLLED_BACK/);
  assert.deepEqual(calls, ['backup', 'assert']);
  calls.length = 0;
  await assert.rejects(rollout.applyRollout(plan, { ...effects, api }), /FAILED_ROLLED_BACK/);
  assert.deepEqual(calls, ['backup', 'update', 'env', 'restore']);
});

test('failed runtime activation restores both the explicit allowlist and future policy together', async () => {
  const plan = await rollout.prepareRollout(enable, request, deps);
  const change = rollout.rolloutEnvironment('PORT=4000\n', { PORT: '4000' }, profile.id, true,
    '2026-01-01T00:00:00.000Z');
  let source = change.before, restored = false;
  const restarts = [];
  await assert.rejects(rollout.applyRollout(plan, {
    api, environment: () => change, backup: async () => {},
    updateProfile: async () => {}, restoreProfile: async () => { restored = true; },
    replaceEnvironment: async (before, after) => { assert.equal(source, before); source = after; },
    restart: async value => { restarts.push(value); },
    healthy: async value => { if (value.SXB_SSH_RELAY_REQUIRED_FROM) throw new Error('runtime mismatch'); },
  }), /FAILED_ROLLED_BACK/);
  assert.equal(source, change.before);
  assert.equal(restored, true);
  assert.deepEqual(restarts, [change.value, change.previousValue]);
});

test('operator probe verifies real gateway forwarding, provider pin, HTTPS identity and fresh service data', { timeout: 30000 }, async t => {
  const { Client, Server, utils } = require('ssh2');
  const directory = mkdtempSync(path.join(tmpdir(), 'sxb-relay-health-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const keyFile = path.join(directory, 'key.pem'), certFile = path.join(directory, 'cert.pem');
  execFileSync(process.env.OPENSSL_BIN || 'openssl', ['req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', keyFile, '-out', certFile, '-days', '2', '-nodes', '-subj', '/CN=vpnsxb.afrihall.com',
    '-addext', 'subjectAltName=DNS:vpnsxb.afrihall.com'], { stdio: 'pipe', timeout: 10000 });
  const certificate = readFileSync(certFile);
  let requests = 0, healthy = true;
  const health = https.createServer({ key: readFileSync(keyFile), cert: certificate }, (req, res) => {
    requests++;
    assert.equal(req.socket.servername, 'vpnsxb.afrihall.com');
    assert.match(req.url, /^\/api\/health\?relayCheck=[0-9a-f-]+$/);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: healthy ? 'ok' : 'unhealthy', service: 'sxb-vpn-backend', timestamp: new Date().toISOString() }));
  });
  health.listen(0, '127.0.0.1'); await once(health, 'listening');
  t.after(async () => { health.closeAllConnections(); await new Promise(resolve => health.close(resolve)); });
  const output = require('esbuild').buildSync({
    entryPoints: [path.join(root, 'server', 'services', 'ssh-relay.ts')],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', output.outputFiles[0].text)(require, mod, mod.exports);
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const pin = 'SHA256:' + createHash('sha256').update(utils.parseKey(key).getPublicSSH()).digest('base64');
  let passwords = 0;
  const peers = new Set();
  const provider = new Server({ hostKeys: [key] }, client => {
    peers.add(client); client.on('close', () => peers.delete(client)); client.on('error', () => client.end());
    client.on('authentication', auth => {
      if (auth.method === 'password') passwords++;
      if (auth.method === 'password' && auth.password === 'synthetic-only') auth.accept();
      else auth.reject(['password']);
    });
    client.on('tcpip', (accept, reject, target) => {
      if (target.destIP !== 'vpnsxb.afrihall.com' || target.destPort !== 443) { reject(); return; }
      const stream = accept(), socket = net.connect(health.address().port, '127.0.0.1');
      stream.on('error', () => socket.destroy()); socket.on('error', () => stream.destroy());
      stream.on('close', () => socket.destroy()); socket.on('close', () => stream.destroy());
      stream.pipe(socket).pipe(stream);
    });
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(async () => { for (const peer of peers) peer.end(); await new Promise(resolve => provider.close(resolve)); });
  const real = {
    openRelayUpstream: async (_source, signal) => {
      const socket = net.connect(provider.address().port, '127.0.0.1');
      signal.addEventListener('abort', () => socket.destroy(), { once: true });
      await once(socket, 'connect');
      return socket;
    },
    installSshRelay: (server, options) => mod.exports.installSshRelay(server, {
      ...options, open: async () => { const socket = net.connect(provider.address().port, '127.0.0.1'); await once(socket, 'connect'); return socket; },
    }),
  };
  const upstream = { ...canonical, host: 'provider.invalid', fingerprint: pin };
  const result = await rollout.verifyTransfer(upstream, real, Client, certificate);
  assert.equal(result.publicPageVerified, true);
  assert.equal(result.destinationTlsVerified, true);
  assert.ok(result.uploadBytes > 0);
  assert.ok(result.downloadBytes > 0);
  assert.equal(passwords, 1);
  assert.equal(requests, 1);
  await assert.rejects(rollout.verifyTransfer({ ...upstream, fingerprint }, real, Client, certificate));
  assert.equal(passwords, 1);
  await assert.rejects(rollout.verifyTransfer(upstream, real, Client), /certificate/i);
  assert.equal(requests, 1);
  healthy = false;
  await assert.rejects(rollout.verifyTransfer(upstream, real, Client, certificate), /HEALTH_RESPONSE_INVALID/);
  healthy = true;
  const direct = await rollout.verifyDirectTransfer(upstream, real, Client, certificate);
  assert.equal(direct.usesCentralGateway, false);
  assert.equal(direct.providerTlsEnabled, false);
  assert.equal(direct.publicPageVerified, true);
  assert.ok(direct.uploadBytes > 0 && direct.downloadBytes > 0);
  const verifiedPasswords = passwords;
  await assert.rejects(rollout.verifyDirectTransfer({ ...upstream, fingerprint }, real, Client, certificate), /HOST_KEY_MISMATCH/);
  assert.equal(passwords, verifiedPasswords, 'direct inspection must verify the provider before password authentication');
  await assert.rejects(rollout.verifyDirectTransfer({ ...upstream, password: 'synthetic-refused' }, real, Client, certificate), /AUTH_REFUSED/);
  await assert.rejects(rollout.verifyDirectTransfer(upstream, real, Client), /DESTINATION_TLS_FAILED/);
  healthy = false;
  await assert.rejects(rollout.verifyDirectTransfer(upstream, real, Client, certificate), /HEALTH_INVALID/);
});

test('the mutating workflow is explicit, manual, pinned and serialized with production deployments', () => {
  const mobileRequire = createRequire(path.join(root, 'app-mobile', 'package.json'));
  const workflow = mobileRequire('yaml').parse(readFileSync(path.join(root, '.github', 'workflows', 'ssh-relay-rollout.yml'), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.concurrency.group, 'deploiement-production');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.jobs.rollout.if, "github.ref == 'refs/heads/main'");
  assert.equal(workflow.jobs.rollout.environment.name, 'production');
  assert.equal(workflow.jobs.rollout.steps.at(-1).with.fingerprint, '${{ secrets.VPS_SSH_HOST_FINGERPRINT }}');
  assert.ok(workflow.on.workflow_dispatch.inputs.mode.options.includes('inspect-direct'));
});

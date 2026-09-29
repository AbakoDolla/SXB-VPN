import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import net from 'node:net';
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
const transfer = { publicPageVerified: true, uploadBytes: 56, downloadBytes: 1024 };
const deps = {
  api, profiles: async () => [profile],
  verifyHost: async () => ({ status: 'host_key_matched', verifiedFingerprint: fingerprint }),
  verifyTransfer: async upstream => { assert.equal(upstream.fingerprint, fingerprint); return transfer; },
};
const enable = { mode: 'enable', profileId: profile.id, expectedHash: hash, confirmed: true };

test('rollout input contains no password and cannot broaden the transport selector', () => {
  assert.deepEqual(rollout.parseRequest(encode(request), parseConfig), request);
  for (const change of [{ password: 'private' }, { username: '' }, { command: 'anything' }, { port: 0 }]) {
    assert.throws(() => rollout.parseRequest(encode({ ...request, ...change }), parseConfig));
  }
  assert.throws(() => rollout.parseRequest('!!' + encode(request), parseConfig));
});

test('selection is unique, exact and SSH-only; corrupt canonical material fails closed', () => {
  assert.equal(rollout.selectProfile([profile], request, api).profile.id, profile.id);
  assert.throws(() => rollout.selectProfile([profile, { ...profile, id: 'another' }], request, api), /AMBIGUOUS/);
  assert.throws(() => rollout.selectProfile([{ ...profile, protocol: 'vless' }], request, api), /NOT_FOUND/);
  assert.throws(() => rollout.selectProfile([profile], { ...request, username: 'someone-else' }, api), /NOT_FOUND/);
  assert.throws(() => rollout.selectProfile([profile], request, { ...api, verifyCanonicalHash: () => false }), /CANONICAL_INVALID/);
});

test('inspect proves the pinned key and real transfer without mutation; changes need ID, hash and confirmation', async () => {
  const result = await rollout.prepareRollout({ mode: 'inspect' }, request, deps);
  assert.equal(result.verifiedFingerprint, fingerprint);
  assert.deepEqual(result.transfer, transfer);
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
  await rollout.prepareRollout({ ...enable, mode: 'disable' }, request, {
    ...deps, verifyHost: async () => assert.fail('rollback must not depend on supplier reachability'),
  });
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
          fingerprint, configVersion: 3 });
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

test('operator probe uses the real gateway, pin, SSH authentication, forwarding and byte meters', { timeout: 15000 }, async t => {
  const { Client, Server, utils } = require('ssh2');
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
      if (target.destIP !== 'example.com' || target.destPort !== 80) { reject(); return; }
      const stream = accept(); stream.on('error', () => stream.destroy()); stream.on('data', () => {});
      stream.once('end', () => stream.end('HTTP/1.1 200 OK\r\nContent-Length: 14\r\n\r\nExample Domain'));
    });
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(async () => { for (const peer of peers) peer.end(); await new Promise(resolve => provider.close(resolve)); });
  const real = {
    installSshRelay: (server, options) => mod.exports.installSshRelay(server, {
      ...options, open: async () => { const socket = net.connect(provider.address().port, '127.0.0.1'); await once(socket, 'connect'); return socket; },
    }),
  };
  const upstream = { ...canonical, host: 'provider.invalid', fingerprint: pin };
  const result = await rollout.verifyTransfer(upstream, real, Client);
  assert.equal(result.publicPageVerified, true);
  assert.equal(result.uploadBytes, 56);
  assert.equal(result.downloadBytes, 53);
  assert.equal(passwords, 1);
  await assert.rejects(rollout.verifyTransfer({ ...upstream, fingerprint }, real, Client));
  assert.equal(passwords, 1);
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
});

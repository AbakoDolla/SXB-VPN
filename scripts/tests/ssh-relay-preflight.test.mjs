import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'app-mobile', 'package.json'));
const { Server, Client, utils } = require('ssh2');
const { parseConfig, matchesFingerprint, probeRelayHost } = require(path.join(root, 'scripts', 'ssh-relay-preflight.cjs'));
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
const publicKey = utils.parseKey(key).getPublicSSH();
const md5 = 'MD5:' + createHash('md5').update(publicKey).digest('hex').match(/../g).join(':');
const sha256 = 'SHA256:' + createHash('sha256').update(publicKey).digest('base64').replace(/=+$/, '');
const config = { host: 'fixture.invalid', port: 80, payload: 'GET / HTTP/1.1[crlf][crlf]', expectedFingerprint: md5 };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');

test('only transport and a pinned fingerprint are accepted; credentials and oversized inputs fail', () => {
  assert.deepEqual(parseConfig(encode(config)), config);
  for (const change of [
    { password: 'synthetic-secret' }, { username: 'synthetic-user' }, { privateKey: 'synthetic-key' },
    { host: 'https://fixture.invalid/path' }, { port: 0 }, { port: '80' },
    { payload: 'x'.repeat(32769) }, { expectedFingerprint: '*' },
  ]) {
    assert.throws(() => parseConfig(encode({ ...config, ...change })), /PREFLIGHT_CONFIG_INVALID/);
  }
  assert.throws(() => parseConfig('not base64'), /PREFLIGHT_CONFIG_INVALID/);
  assert.equal(matchesFingerprint(publicKey, md5), true);
  assert.equal(matchesFingerprint(publicKey, sha256), true);
  assert.equal(matchesFingerprint(publicKey, 'MD5:' + '00:'.repeat(15) + '00'), false);
});

async function fixture(t) {
  let authentications = 0;
  const peers = new Set();
  const server = new Server({ hostKeys: [key] }, client => {
    peers.add(client);
    client.on('error', () => client.end());
    client.on('close', () => peers.delete(client));
    client.on('authentication', auth => { authentications++; auth.reject(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const peer of peers) peer.end();
    await new Promise(resolve => server.close(resolve));
  });
  return {
    Client,
    authentications: () => authentications,
    open: async upstream => {
      assert.equal(upstream.username, '');
      assert.equal(upstream.password, undefined);
      const socket = net.connect(server.address().port, '127.0.0.1');
      await once(socket, 'connect');
      return socket;
    },
  };
}

test('a matching RSA key is found without sending even an SSH authentication request', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const result = await probeRelayHost(config, f);
  assert.equal(result.status, 'host_key_matched');
  assert.equal(result.attempts.at(-1).result, 'matched');
  assert.equal(result.credentialsSent, false);
  assert.equal(result.verifiedFingerprint, sha256);
  assert.equal(f.authentications(), 0);
});

test('a mismatched pinned key never authenticates or claims success', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const result = await probeRelayHost({ ...config, expectedFingerprint: 'MD5:' + '00:'.repeat(15) + '00' }, f);
  assert.equal(result.status, 'host_key_unverified');
  assert.equal(result.attempts.some(attempt => attempt.result === 'mismatch'), true);
  assert.equal(result.verifiedFingerprint, undefined);
  assert.equal(f.authentications(), 0);
});

test('transport failures report only safe categories, not destinations, payloads or error text', async () => {
  for (const error of [new Error('RELAY_RESPONSE_TRUNCATED'), new Error('sensitive fixture destination')]) {
    const result = await probeRelayHost(config, { Client, open: async () => { throw error; } });
    assert.equal(result.status, 'transport_unavailable');
    assert.equal(result.credentialsSent, false);
    assert.equal(JSON.stringify(result).includes('fixture'), false);
    assert.equal(result.reason, error.message.startsWith('RELAY_') ? error.message : 'TRANSPORT_FAILED');
  }
});

test('the exact stdin entrypoint runs and fails closed without exposing configuration', async () => {
  const source = await readFile(path.join(root, 'scripts', 'ssh-relay-preflight.cjs'), 'utf8');
  for (const [input, expected] of [
    ['synthetic private invalid configuration', 'PREFLIGHT_CONFIG_INVALID'],
    [encode({ ...config, host: '127.0.0.1' }), 'RELAY_ADDRESS_DENIED'],
  ]) {
    const result = spawnSync(process.execPath, [], {
      input: source, cwd: root, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, SXB_SSH_RELAY_PREFLIGHT_CONFIG: input },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal((result.stdout + result.stderr).includes(expected), true);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic|127\.0\.0\.1|fixture\.invalid|GET \//);
  }
});

test('the production diagnostic is manual, pinned and performs no remote write or installation', async () => {
  const workflow = require('yaml').parse(await readFile(path.join(root, '.github', 'workflows', 'vps-audit.yml'), 'utf8'));
  const job = workflow.jobs['ssh-relay-preflight'];
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(job.if, "inputs.mode == 'ssh-relay-preflight'");
  assert.equal(job.environment.name, 'production');
  assert.equal(job.steps[0].with.ref, '${{ github.sha }}');
  assert.equal(job.steps[0].with['persist-credentials'], false);
  const ssh = job.steps.at(-1);
  assert.equal(ssh.with.fingerprint, '${{ secrets.VPS_SSH_HOST_FINGERPRINT }}');
  assert.match(ssh.with.script, /timeout 70s node/);
  assert.doesNotMatch(ssh.with.script, /\b(?:git|pm2|npm|npx|pnpm|psql|curl|mkdir|touch|tee|sudo)\b|\.env|>>/);
  assert.match(ssh.env.SXB_SSH_RELAY_PREFLIGHT_CONFIG, /secrets\.SXB_SSH_RELAY_PREFLIGHT_CONFIG/);
});

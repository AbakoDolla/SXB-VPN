import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const { blocks } = require('../configure-ssh-relay-nginx.cjs');
const { pin, tlsLayout, renewalReusesKey, withStableRenewalKey, prepareRoot } = require('../backend-tls-pins.cjs');

const site = `server { listen 80; server_name vpnsxb.afrihall.com; }
server { listen 443 ssl; server_name vpnsxb.afrihall.com;
ssl_certificate "/etc/letsencrypt/live/vpnsxb.afrihall.com/fullchain.pem";
ssl_certificate_key /etc/letsencrypt/live/vpnsxb.afrihall.com/privkey.pem;
location / { proxy_pass http://127.0.0.1:3000; } }`;

test('TLS pin inspection selects one exact TLS site and its public certificate only', () => {
  assert.deepEqual(tlsLayout(site, blocks), {
    certificate: '/etc/letsencrypt/live/vpnsxb.afrihall.com/fullchain.pem',
    renewal: '/etc/letsencrypt/renewal/vpnsxb.afrihall.com.conf',
  });
  assert.throws(() => tlsLayout(site + site, blocks), /AMBIGUOUS/);
  assert.throws(() => tlsLayout(site.replace('/fullchain.pem', '/../../secret'), blocks), /LAYOUT_UNSUPPORTED/);
  assert.throws(() => tlsLayout(site.replace('listen 443 ssl', 'listen 443'), blocks), /SITE_AMBIGUOUS/);
  for (const name of ['vpnsxb.afrihall.com.evil.test', 'prefix-vpnsxb.afrihall.com', 'not-vpnsxb.afrihall.com']) {
    assert.throws(() => tlsLayout(site.replaceAll('server_name vpnsxb.afrihall.com', `server_name ${name}`), blocks),
      /SITE_AMBIGUOUS/);
  }
});

test('SPKI pins are deterministic public-key identities, not certificate serials', () => {
  const first = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
  const second = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
  assert.match(pin(first), /^sha256\/[A-Za-z0-9+/]{43}=$/);
  assert.equal(pin(first), pin(first));
  assert.notEqual(pin(first), pin(second));
});

test('renewal inspection never assumes key reuse from a missing or unrelated setting', () => {
  assert.equal(renewalReusesKey('[renewalparams]\nreuse_key = True\n'), true);
  assert.equal(renewalReusesKey('[renewalparams]\nreuse_key = false\n'), false);
  assert.equal(renewalReusesKey('reuse_key = True\n[renewalparams]\n'), false);
  assert.equal(renewalReusesKey('[renewalparams]\n'), false);
  assert.throws(() => renewalReusesKey('[renewalparams]\nreuse_key = true\nreuse_key = false\n'), /AMBIGUOUS/);
});

test('stable renewal edits are surgical and idempotent without certificate replacement', () => {
  const source = 'version = 2.11\n[renewalparams]\nauthenticator = nginx\nreuse_key = False\n[other]\nreuse_key = False\n';
  const next = withStableRenewalKey(source);
  assert.equal(next, source.replace('reuse_key = False', 'reuse_key = True'));
  assert.equal(withStableRenewalKey(next), next);
  assert.equal(renewalReusesKey(next), true);
  assert.equal(renewalReusesKey(withStableRenewalKey('[renewalparams]\nauthenticator = nginx\n')), true);
  assert.throws(() => withStableRenewalKey('[renewalparams]\nnew_key = True\n'), /CONFLICT/);
  assert.throws(() => withStableRenewalKey('[renewalparams]\n[renewalparams]\n'), /AMBIGUOUS/);
});

test('root preparation rejects unreviewed paths and revisions before filesystem access', () => {
  const denied = () => { throw new Error('Filesystem must not be accessed'); };
  const context = { require: name => name === 'node:fs' ? new Proxy({}, { get: denied }) : require(name),
    process: { platform: 'linux', getuid: () => 0 } };
  const run = runInNewContext('(' + prepareRoot.toString() + ')', context);
  for (const input of [
    {}, { renewal: '/etc/passwd' }, { renewal: '/etc/letsencrypt/renewal/site.conf', certificate: '/etc/shadow' },
    { renewal: '/etc/letsencrypt/renewal/site.conf',
      certificate: '/etc/letsencrypt/live/site/fullchain.pem', expectedPin: 'bad', expectedRevision: '0'.repeat(64) },
  ]) assert.throws(() => run(input), /PREPARATION_INVALID/);
});

test('root preparation preserves the active certificate and creates only a protected backup and renewal edit', () => {
  const current = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const backup = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const renewal = '/etc/letsencrypt/renewal/site.conf';
  const certificate = '/etc/letsencrypt/live/site/fullchain.pem';
  const source = '[renewalparams]\nauthenticator = nginx\nreuse_key = False\n';
  const files = new Map([[renewal, source], [certificate, 'synthetic-public-certificate']]);
  const writes = [];
  const fakeFs = {
    existsSync: path => files.has(path),
    readFileSync: path => { if (!files.has(path)) throw new Error('Missing fixture'); return files.get(path); },
    lstatSync: path => ({ isFile: () => typeof files.get(path) !== 'object',
      isDirectory: () => typeof files.get(path) === 'object', isSymbolicLink: () => false, uid: 0, mode: 0o600 }),
    mkdirSync: path => { files.set(path, {}); writes.push(path); },
    openSync: (path, flag) => { assert.equal(flag, 'wx'); assert.equal(files.has(path), false); files.set(path, 'lock'); writes.push(path); return 42; },
    writeFileSync: (path, value, options) => { assert.equal(options.flag, 'wx'); files.set(path, value); writes.push(path); },
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); writes.push(to); },
    closeSync: fd => assert.equal(fd, 42),
    unlinkSync: path => { files.delete(path); writes.push(path); },
  };
  const crypto = { ...require('node:crypto'), X509Certificate: class { publicKey = current.publicKey; } };
  const operator = runInNewContext('(' + prepareRoot.toString() + ')', {
    require: name => name === 'node:fs' ? fakeFs : name === 'node:crypto' ? crypto
      : name === 'node:path' ? require(name).posix
      : name === 'node:child_process' ? { execFileSync: (command, args) => {
        assert.equal(command, 'openssl');
        assert.deepEqual([...args].slice(0, 3), ['genpkey', '-algorithm', 'EC']);
        files.set(args.at(-1), backup.privateKey.export({ type: 'pkcs8', format: 'pem' }));
      } } : require(name),
    process: { platform: 'linux', getuid: () => 0, umask: value => assert.equal(value, 0o077) },
    withStableRenewalKey,
  });
  const input = { renewal, certificate, expectedPin: pin(current.publicKey),
    expectedRevision: createHash('sha256').update(source).digest('hex') };
  const receipt = operator(input);
  assert.equal(receipt.backupCreated, true);
  assert.equal(receipt.renewalChanged, true);
  assert.equal(receipt.backupPin, pin(backup.publicKey));
  assert.equal(files.get(certificate), 'synthetic-public-certificate');
  assert.equal(files.get(renewal), withStableRenewalKey(source));
  assert.ok(writes.every(path => path === renewal || path.startsWith('/var/lib/sxb-vpn-tls') ||
    path.startsWith('/etc/letsencrypt/renewal/.sxb-renewal-')));
  const again = operator({ ...input, expectedRevision: createHash('sha256').update(files.get(renewal)).digest('hex') });
  assert.equal(again.backupCreated, false);
  assert.equal(again.renewalChanged, false);
  assert.equal(again.backupPin, receipt.backupPin);
  assert.throws(() => operator(input), /RENEWAL_CHANGED/);
});

test('the exact production inspector envelope remains bounded and read-only', () => {
  const source = blocks.toString() + '\n' + readFileSync(new URL('../backend-tls-pins.cjs', import.meta.url), 'utf8');
  const result = spawnSync(process.execPath, ['-'], { input: source, encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', SXB_TLS_PIN_MODE: 'inspect' }, timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TLS_PIN_PRODUCTION_ROOT_REQUIRED/);
  assert.doesNotMatch(result.stdout + result.stderr, /privkey|\.conf|BEGIN PRIVATE KEY/);
  const yaml = createRequire(new URL('../../app-mobile/package.json', import.meta.url))('yaml');
  const workflow = yaml.parse(readFileSync(new URL('../../.github/workflows/vps-audit.yml', import.meta.url), 'utf8'));
  const job = workflow.jobs['tls-pinning-inspect'];
  assert.equal(job.if, "inputs.mode == 'tls-pinning-inspect'");
  assert.equal(job.environment.name, 'production');
  assert.equal(job.steps[0].with['persist-credentials'], false);
  const ssh = job.steps.at(-1).with;
  assert.equal(ssh.fingerprint, '${{ secrets.VPS_SSH_HOST_FINGERPRINT }}');
  assert.match(ssh.script, /SXB_TLS_PIN_MODE=inspect/);
  assert.doesNotMatch(ssh.script, /pm2|npm|install|chmod|chown|tee|rm\b/);
  const preparation = yaml.parse(readFileSync(new URL('../../.github/workflows/backend-tls-pinning.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(preparation.on), ['workflow_dispatch']);
  assert.equal(preparation.concurrency.group, 'deploiement-production');
  assert.equal(preparation.concurrency['cancel-in-progress'], false);
  assert.equal(preparation.jobs.prepare.steps[0].if, "github.ref != 'refs/heads/main'");
  assert.equal(preparation.on.workflow_dispatch.inputs.confirmed.default, false);
  assert.equal(preparation.jobs.prepare.steps.at(-1).with.fingerprint, '${{ secrets.VPS_SSH_HOST_FINGERPRINT }}');
});

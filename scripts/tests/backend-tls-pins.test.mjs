import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { blocks } = require('../configure-ssh-relay-nginx.cjs');
const { pin, tlsLayout, renewalReusesKey } = require('../backend-tls-pins.cjs');

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
});

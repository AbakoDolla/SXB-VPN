import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { runOperation, trustedBase, CONFIRMATION, COUNT_KEYS } = require('../production-reset-ops.cjs');
const requireMobile = createRequire(new URL('../../app-mobile/package.json', import.meta.url));
const YAML = requireMobile('yaml');
const zero = () => Object.fromEntries(COUNT_KEYS.map(key => [key, 0]));
const preserved = { OWNER: 1, ADMIN: 2, SUPER_ADMIN: 1 };
const challenge = 'private-challenge-not-for-logs-or-reuse';
const password = 'fixture-password-never-production';

function fixture({ role = 'OWNER', executeStatus = 200, remaining = false } = {}) {
  const requests = [];
  const preview = {
    mode: 'production', confirmationText: CONFIRMATION, challenge,
    expiresAt: new Date(Date.now() + 300_000).toISOString(), backupRequired: true,
    counts: { ...zero(), users: 5, profiles: 3 },
    preserved: { usersByRole: preserved, projectFiles: true },
  };
  const result = {
    status: 'completed', resetId: 'reset-fixture', completedAt: new Date().toISOString(),
    deletedCounts: preview.counts, countsAfter: { ...zero(), users: remaining ? 1 : 0 },
    retainedUsersByRole: preserved, maintenanceRestored: true,
    backup: { id: 'private-reset.dump', bytes: 4096, sha256: 'a'.repeat(64) },
  };
  const request = async (url, options) => {
    const route = new URL(url).pathname;
    requests.push({ route, ...options });
    const data = route.endsWith('/auth/login')
      ? { user: { role }, accessToken: 'private-authentication-token-not-for-logs' }
      : route.endsWith('/preview') ? preview : executeStatus === 200 ? result : { code: 'RESET_BACKUP_FAILED' };
    return new Response(JSON.stringify(data), {
      status: route.endsWith('/execute') ? executeStatus : 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { request, requests, preview, result };
}

test('the operator inventory authenticates OWNER and never executes or prints credentials/challenges', async () => {
  const f = fixture();
  const output = await runOperation({ email: 'owner@example.test', password, request: f.request });
  assert.equal(output.action, 'inventory');
  assert.deepEqual(output.preservedUsers, preserved);
  assert.deepEqual(f.requests.map(row => row.route), ['/api/auth/login', '/api/ops/reset/preview']);
  assert.doesNotMatch(JSON.stringify(output), /private-challenge|private-authentication|fixture-password/);
});

test('reset requires the exact explicit confirmation before even logging in', async () => {
  const f = fixture();
  await assert.rejects(runOperation({
    action: 'reset', confirmation: 'yes', email: 'owner@example.test', password, request: f.request,
  }));
  assert.equal(f.requests.length, 0);
});

test('SUPER_ADMIN cannot operate the OWNER reset workflow', async () => {
  const f = fixture({ role: 'SUPER_ADMIN' });
  await assert.rejects(runOperation({
    action: 'reset', confirmation: CONFIRMATION, email: 'admin@example.test', password, request: f.request,
  }));
  assert.equal(f.requests.length, 1);
});

test('a confirmed reset uses the signed preview and verifies zero remaining data with preserved administrators', async () => {
  const f = fixture();
  const output = await runOperation({
    action: 'reset', confirmation: CONFIRMATION, email: 'owner@example.test', password, request: f.request,
  });
  assert.equal(output.status, 'completed');
  assert.deepEqual(output.retainedUsersByRole, preserved);
  assert.equal(f.requests.length, 3);
  assert.deepEqual(JSON.parse(f.requests[2].body), {
    mode: 'production', challenge, confirmation: CONFIRMATION, password,
  });
  assert.doesNotMatch(JSON.stringify(output), /private-challenge|private-authentication|fixture-password/);
});

test('backup failures and incomplete deletion never yield a success-shaped receipt', async () => {
  for (const options of [{ executeStatus: 503 }, { remaining: true }]) {
    const f = fixture(options);
    await assert.rejects(runOperation({
      action: 'reset', confirmation: CONFIRMATION, email: 'owner@example.test', password, request: f.request,
    }));
    assert.equal(f.requests.length, 3);
  }
});

test('credentials cannot be redirected to an arbitrary origin or path', () => {
  assert.equal(trustedBase('https://vpnsxb.afrihall.com/api'), 'https://vpnsxb.afrihall.com/api');
  assert.equal(trustedBase('http://127.0.0.1:4199/api'), 'http://127.0.0.1:4199/api');
  for (const base of [
    'https://other.example/api', 'http://vpnsxb.afrihall.com/api',
    'https://vpnsxb.afrihall.com/other', 'https://vpnsxb.afrihall.com/api?redirect=bad',
  ]) assert.throws(() => trustedBase(base));
});

test('the production operator workflow is manual, version-bound and calls only the protected API', () => {
  const source = readFileSync(new URL('../../.github/workflows/production-reset.yml', import.meta.url), 'utf8');
  const workflow = YAML.parse(source);
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.on.workflow_dispatch.inputs.action.default, 'inventory');
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  const step = workflow.jobs.reset.steps.find(item => item.with?.script);
  assert.match(step.with.script, /git rev-parse HEAD/);
  assert.match(step.with.script, /node scripts\/production-reset-ops\.cjs/);
  assert.doesNotMatch(source, /TRUNCATE|DELETE FROM|DROP TABLE|rm -|git reset|seed-owner|upload-artifact/);
  for (const item of workflow.jobs.reset.steps) {
    if (item.run) execFileSync('bash', ['-n'], {
      input: item.run.replace(/\$\{\{[\s\S]*?\}\}/g, 'placeholder'), encoding: 'utf8',
    });
  }
  execFileSync('bash', ['-n'], { input: step.with.script, encoding: 'utf8' });
});

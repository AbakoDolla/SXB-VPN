import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createPublicKey, createHash, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { rootSigningIdentity, publicRootAuthority, prepareRootAuthority } = require('../root-approval-key.cjs');
const secret = createHash('sha256').update('synthetic-root-key-test-only-material-0123456789').digest('hex');

test('root approvals use a stable separate authority without exposing private material', () => {
  const authority = publicRootAuthority(secret);
  assert.deepEqual(authority, publicRootAuthority(secret));
  const alternative = createHash('sha256').update('another synthetic authority').digest('hex');
  assert.notEqual(authority.keyId, publicRootAuthority(alternative).keyId);
  assert.deepEqual(Object.keys(authority).sort(), ['keyId', 'origin', 'publicKey', 'scope', 'version']);
  assert.ok(!JSON.stringify(authority).includes(secret));
  const key = createPublicKey({ key: Buffer.from(authority.publicKey, 'base64'), format: 'der', type: 'spki' });
  const message = Buffer.from('synthetic root decision');
  assert.ok(verify('sha256', message, key, sign('sha256', message, rootSigningIdentity(secret).key)));
  for (const invalid of [undefined, '', 'short', 'CHANGE_ME' + secret, 'sxb-vpn-32-byte-encryption-key-!',
    'sxb-vpn-32-byte-encryption-key-!'.padEnd(64, '0'), '0'.repeat(64), 'ab'.repeat(32)]) {
    assert.throws(() => publicRootAuthority(invalid), /UNAVAILABLE/);
  }
});

test('public authority inspection and explicit preparation are manual and main-only', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/root-approval-key.yml', import.meta.url), 'utf8');
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /timeout 20s node/);
  const source = readFileSync(new URL('../root-approval-key.cjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /env\.ENCRYPTION_KEY|JWT_SECRET|pm2|restart|setPrivateKey.*console/);
  assert.match(source, /ROOT_PREPARATION_NOT_CONFIRMED/);
  assert.match(source, /ROOT_ENV_CHANGED/);
  assert.match(source, /mode: 0o600/);
});

test('dedicated authority preparation never reuses encryption defaults or replaces an existing secret', () => {
  const source = 'ENCRYPTION_KEY=sxb-vpn-32-byte-encryption-key-!\nJWT_SECRET=synthetic-ignored\n';
  assert.throws(() => prepareRootAuthority(source, { ENCRYPTION_KEY: 'sxb-vpn-32-byte-encryption-key-!' }, false), /NOT_CONFIRMED/);
  const plan = prepareRootAuthority(source, { ENCRYPTION_KEY: 'sxb-vpn-32-byte-encryption-key-!' }, true, () => secret);
  assert.equal(plan.changed, true);
  assert.equal(plan.after, source + `ROOT_APPROVAL_SECRET=${secret}\n`);
  assert.equal(plan.authority.keyId, publicRootAuthority(secret).keyId);
  const retained = prepareRootAuthority(plan.after, { ROOT_APPROVAL_SECRET: secret }, true, () => assert.fail('secret changed'));
  assert.equal(retained.changed, false);
  assert.equal(retained.after, plan.after);
  assert.throws(() => prepareRootAuthority('ROOT_APPROVAL_SECRET=short\n', { ROOT_APPROVAL_SECRET: 'short' }, true), /UNAVAILABLE/);
  assert.throws(() => prepareRootAuthority(plan.after + `ROOT_APPROVAL_SECRET=${secret}\n`,
    { ROOT_APPROVAL_SECRET: secret }, true), /AMBIGUOUS/);
});

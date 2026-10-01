import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { rootSigningIdentity, publicRootAuthority } = require('../root-approval-key.cjs');
const secret = 'synthetic-root-key-test-only-material-0123456789';

test('root approvals use a stable separate authority without exposing private material', () => {
  const authority = publicRootAuthority(secret);
  assert.deepEqual(authority, publicRootAuthority(secret));
  assert.notEqual(authority.keyId, publicRootAuthority(secret + 'changed').keyId);
  assert.deepEqual(Object.keys(authority).sort(), ['keyId', 'origin', 'publicKey', 'scope', 'version']);
  assert.ok(!JSON.stringify(authority).includes(secret));
  const key = createPublicKey({ key: Buffer.from(authority.publicKey, 'base64'), format: 'der', type: 'spki' });
  const message = Buffer.from('synthetic root decision');
  assert.ok(verify('sha256', message, key, sign('sha256', message, rootSigningIdentity(secret).key)));
  for (const invalid of ['', 'short', 'CHANGE_ME' + secret]) assert.throws(() => publicRootAuthority(invalid), /UNAVAILABLE/);
});

test('public authority inspection is manual, main-only and read-only', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/root-approval-key.yml', import.meta.url), 'utf8');
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /timeout 20s node/);
  const source = readFileSync(new URL('../root-approval-key.cjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /writeFile|rename|pm2|restart|setPrivateKey.*console/);
});

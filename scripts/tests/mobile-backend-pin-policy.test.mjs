import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash, generateKeyPairSync } from 'node:crypto';
const require = createRequire(import.meta.url);
const { validatePinPolicy, pinsForOrigin, readPinPolicy } = require('../../app-mobile/scripts/backend-pin-policy.cjs');
const { verifyServedPin } = require('../../app-mobile/scripts/verify-bootstrap-backend.cjs');
const primary = 'sha256/' + Buffer.alloc(32, 1).toString('base64');
const backup = 'sha256/' + Buffer.alloc(32, 2).toString('base64');
const policy = { version: 1, origin: 'https://vpnsxb.afrihall.com/api', pins: [primary, backup] };

test('offline backend trust always includes independent current and backup public keys', () => {
  assert.deepEqual(validatePinPolicy(policy), policy);
  assert.deepEqual(pinsForOrigin(policy.origin, undefined, policy), policy.pins);
  for (const pins of [[], [primary], [primary, primary], [primary, 'sha256/invalid']]) {
    assert.throws(() => validatePinPolicy({ ...policy, pins }), /POLICY_INVALID/);
  }
  assert.throws(() => validatePinPolicy({ ...policy, origin: 'http://vpnsxb.afrihall.com/api' }), /ORIGIN_INVALID/);
  assert.throws(() => validatePinPolicy({ ...policy, origin: 'https://vpnsxb.afrihall.com/api#part' }), /ORIGIN_INVALID/);
});

test('the reviewed release policy is complete and cannot silently publish an incompatible live key', () => {
  const reviewed = readPinPolicy();
  assert.equal(reviewed.origin, policy.origin);
  assert.equal(reviewed.pins.length, 2);
  assert.notEqual(reviewed.pins[0], reviewed.pins[1]);
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
  const live = 'sha256/' + createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('base64');
  verifyServedPin({ ...policy, pins: [live, backup] }, key);
  assert.throws(() => verifyServedPin(policy, key), /PIN_MISMATCH/);
  assert.throws(() => verifyServedPin({ ...policy, pins: [] }, key), /POLICY_INVALID/);
});

test('a different compiled backend cannot silently inherit unrelated pins or disable pinning', () => {
  assert.throws(() => pinsForOrigin('https://alternate.example.test/api', undefined, policy), /REQUIRES_REVIEW/);
  assert.throws(() => pinsForOrigin(policy.origin, '[]', policy), /POLICY_INVALID/);
  assert.deepEqual(pinsForOrigin('https://alternate.example.test/api', JSON.stringify([primary, backup]), policy),
    [primary, backup]);
});

test('the same reviewed policy covers React API, native observer and the private gateway', () => {
  const read = file => readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
  const plugin = read('app-mobile/plugins/withSxbVpn.js');
  assert.match(plugin, /pinsForOrigin\(apiBase, process\.env\.EXPO_PUBLIC_BACKEND_SPKI_PINS\)/);
  assert.match(plugin, /setMetadata\('com\.sxbvpn\.BACKEND_SPKI_REQUIRED', 'true'\)/);
  const tls = read('app-mobile/modules/android-native/SxbBackendTls.kt');
  assert.match(tls, /SxbTlsPinPolicy\.parse/);
  assert.match(tls, /CertificatePinner\.Builder\(\)/);
  assert.match(tls, /checkServerTrusted\(chain, authType, connection\.url\.host\)/);
  assert.match(tls, /SxbTlsPinPolicy\.check\(configured, verifiedChain\.map \{ it\.publicKey \}\)/);
  assert.match(read('app-mobile/modules/android-native/SxbAccessObserver.kt'), /SxbBackendTls\.protect\(context, http\)/);
  assert.match(read('app-mobile/modules/android-native/SxbGatewaySocketFactory.kt'), /SxbBackendTls\.socketFactory\(context\)/);
  assert.match(read('app-mobile/modules/android-native/SxbVpnPackage.kt'), /SxbBackendTls\.install\(ctx\)/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import rolloutModule from '../mobile-release-rollout.cjs';
const { rollout, validateBuild, digest } = rolloutModule;
const build = { versionCode: 123, versionName: '1.2.1', apkUrl: 'https://vpnsxb.afrihall.com/download/sxbvpn-latest.apk',
  apkSha256: 'a'.repeat(64), sizeBytes: 64 };
function fixture() {
  let value = JSON.stringify({ versionCode: 122, active: true, targetDeviceIds: ['private-device'] });
  let writes = 0;
  const db = {
    setting: {
      findUnique: async () => ({ value }),
      updateMany: async ({ where, data }) => {
        if (where.value !== value) return { count: 0 };
        writes++; value = data.value; return { count: 1 };
      },
    },
    vpnClient: { count: async ({ where }) => where.deviceKeyId === null ? 2 : 5 },
    subscription: { count: async () => 1 },
    $queryRaw: async () => [],
    $transaction: async work => work(db),
  };
  return { db, get: () => JSON.parse(value), writes: () => writes, revision: () => digest(value) };
}
test('readiness inspection is aggregate only and read-only', async () => {
  const f = fixture();
  const result = await rollout(f.db, { mode: 'inspect' });
  assert.equal(result.activated, 5); assert.equal(result.legacy, 2); assert.equal(result.sshLegacy, 1);
  assert.equal(result.publication.targetedDevices, 1);
  assert.equal(f.writes(), 0);
  assert.doesNotMatch(JSON.stringify(result), /private-device/);
});
test('publication requires exact build, confirmation and unchanged publication; retry is idempotent', async () => {
  const f = fixture();
  const options = { mode: 'publish-all', build, versionCode: 123, apkSha256: build.apkSha256,
    expectedPublication: f.revision(), confirmed: true };
  await assert.rejects(rollout(f.db, { ...options, confirmed: false }), /NOT_CONFIRMED/);
  await assert.rejects(rollout(f.db, { ...options, expectedPublication: 'stale' }), /PUBLICATION_CHANGED/);
  await assert.rejects(rollout(f.db, { ...options, versionCode: 124 }), /BUILD_CHANGED/);
  assert.equal(f.writes(), 0);
  assert.equal((await rollout(f.db, options)).status, 'published');
  assert.deepEqual(f.get().targetDeviceIds, []);
  assert.equal(f.get().forceUpdate, false);
  assert.equal((await rollout(f.db, options)).status, 'already-published');
  assert.equal(f.writes(), 1);
  assert.throws(() => validateBuild({ ...build, apkUrl: 'http://evil.invalid' }, 123, build.apkSha256), /BUILD_INVALID/);
});

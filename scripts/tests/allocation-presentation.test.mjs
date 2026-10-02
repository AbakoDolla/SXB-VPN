import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(path.resolve('backend', 'package.json'));
const bundled = await require('esbuild').build({
  entryPoints: [path.resolve('artifacts', 'sxb-dashboard', 'src', 'lib', 'allocationSummary.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
});
const module = { exports: {} };
new Function('module', 'exports', bundled.outputFiles[0].text)(module, module.exports);
const { summarizeVisibleAllocations } = module.exports;

const GB = 1024n ** 3n;
const row = (allocated, used) => ({ quotaBytes: String(BigInt(allocated) * GB), quotaUsed: String(BigInt(used) * GB) });

test('allocation totals belong to the dashboard and count only its supplied visible scope', () => {
  assert.deepEqual(summarizeVisibleAllocations([row(10, 2)]),
    { allocated: 10n * GB, used: 2n * GB, remaining: 8n * GB, unlimited: false });
  assert.deepEqual(summarizeVisibleAllocations([row(20, 3)]),
    { allocated: 20n * GB, used: 3n * GB, remaining: 17n * GB, unlimited: false });
  assert.deepEqual(summarizeVisibleAllocations([row(10, 2), row(20, 3), row(15, 4)]),
    { allocated: 45n * GB, used: 9n * GB, remaining: 36n * GB, unlimited: false });
  assert.equal(summarizeVisibleAllocations([row(10, 12), row(20, 3)]).remaining, 17n * GB);
});

test('unknown counters cannot appear as an invented zero balance, and unlimited is explicit', () => {
  assert.throws(() => summarizeVisibleAllocations([{ quotaBytes: 'invalid', quotaUsed: '0' }]), /ALLOCATION_COUNTER_INVALID/);
  assert.throws(() => summarizeVisibleAllocations([{ quotaBytes: '10', quotaUsed: '-1' }]), /ALLOCATION_COUNTER_INVALID/);
  assert.equal(summarizeVisibleAllocations([{ quotaBytes: '-1', quotaUsed: '123' }]).remaining, null);
});

test('mobile restores the per-plan quota UI without aggregate financial blocks or reseller identities', () => {
  const home = readFileSync('app-mobile/app/(tabs)/index.tsx', 'utf8');
  const card = readFileSync('app-mobile/components/ui/ConnectionCard.tsx', 'utf8');
  assert.doesNotMatch(home, /allocationSnapshot|readAllocationSummary|allocation_summary_title|formatAllocationBytes/);
  assert.doesNotMatch(card, /conn\.allocation|allocation_sold_origin|allocation_trial_origin/);
  assert.match(home, /derivedQuota\.formattedRemaining/);
  assert.match(card, /quota_remaining/);
  const dashboard = readFileSync('artifacts/sxb-dashboard/src/components/SubscriptionsView.tsx', 'utf8');
  assert.match(dashboard, /summarizeVisibleAllocations\(rows\)/);
  assert.match(dashboard, /visibleAllocationTotals/);
  assert.match(dashboard, /ownsSubscription/);
  const ownership = readFileSync('server/services/data-allocation.ts', 'utf8');
  assert.match(ownership, /allocationResellerId/);
  assert.match(ownership, /withDataAllocationIdentity/);
});

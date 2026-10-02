import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatAllocationBytes, readAllocationSummary } from '../services/allocationSummary';

const GB = 1024n ** 3n;
const snapshot = {
  soldBytes: String(30n * GB), freeTrialBytes: String(15n * GB),
  allocatedBytes: String(45n * GB), usedBytes: String(9n * GB),
  remainingBytes: String(36n * GB), unlimited: false,
};

test('the mobile summary displays 30 GB sold plus 15 GB trial, without being a per-plan quota', () => {
  const result = readAllocationSummary(snapshot);
  assert.deepEqual(result, snapshot);
  assert.ok(result.remainingBytes !== null);
  assert.equal(formatAllocationBytes(result.remainingBytes), '36 GB');
  assert.equal(formatAllocationBytes(result.soldBytes), '30 GB');
  assert.equal(formatAllocationBytes(result.freeTrialBytes), '15 GB');
});

test('invalid or incomplete aggregates are errors, never an invented balance', () => {
  for (const input of [null, {}, { ...snapshot, allocatedBytes: '0' },
    { ...snapshot, remainingBytes: String(46n * GB) }, { ...snapshot, soldBytes: -1 },
    { ...snapshot, soldBytes: '-1' }, { ...snapshot, unlimited: true },
    { ...snapshot, remainingBytes: null }, { ...snapshot, soldBytes: '1e9' }]) {
    assert.throws(() => readAllocationSummary(input), /ALLOCATION_SUMMARY_INVALID/);
  }
});

test('unlimited is explicit and exact large byte strings never become undefined units', () => {
  assert.equal(readAllocationSummary({ ...snapshot, unlimited: true, remainingBytes: null }).remainingBytes, null);
  assert.equal(formatAllocationBytes(String(1024n ** 5n)), '1024 TB');
  assert.equal(formatAllocationBytes('0'), '0 B');
});

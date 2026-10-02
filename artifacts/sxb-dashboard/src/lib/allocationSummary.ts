import { toBigInt } from './resellerAccess';

interface VisibleAllocation {
  quotaBytes: string | number;
  quotaUsed: string | number;
}

export function summarizeVisibleAllocations(rows: readonly VisibleAllocation[]) {
  let allocated = 0n, used = 0n, remaining = 0n, unlimited = false;
  for (const row of rows) {
    const total = toBigInt(row.quotaBytes);
    const consumed = toBigInt(row.quotaUsed);
    if (total === null || consumed === null || consumed < 0n) throw new Error('ALLOCATION_COUNTER_INVALID');
    used += consumed;
    if (total < 0n) { unlimited = true; continue; }
    allocated += total;
    remaining += total > consumed ? total - consumed : 0n;
  }
  return { allocated, used, remaining: unlimited ? null : remaining, unlimited };
}

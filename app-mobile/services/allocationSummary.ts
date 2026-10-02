import type { DataAllocationSummary } from '@/types/api';

export function readAllocationSummary(value: unknown): DataAllocationSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ALLOCATION_SUMMARY_INVALID');
  const entry = value as Record<string, unknown>;
  const bytes = (key: string): string => {
    const raw = entry[key];
    if (typeof raw !== 'string' || !/^(0|[1-9]\d{0,49})$/.test(raw)) throw new Error('ALLOCATION_SUMMARY_INVALID');
    return raw;
  };
  const soldBytes = bytes('soldBytes'), freeTrialBytes = bytes('freeTrialBytes');
  const allocatedBytes = bytes('allocatedBytes'), usedBytes = bytes('usedBytes');
  if (BigInt(soldBytes) + BigInt(freeTrialBytes) !== BigInt(allocatedBytes) || typeof entry.unlimited !== 'boolean') {
    throw new Error('ALLOCATION_SUMMARY_INVALID');
  }
  if (entry.unlimited && entry.remainingBytes !== null) throw new Error('ALLOCATION_SUMMARY_INVALID');
  const remainingBytes = entry.unlimited && entry.remainingBytes === null ? null : bytes('remainingBytes');
  if (remainingBytes !== null && BigInt(remainingBytes) > BigInt(allocatedBytes)) throw new Error('ALLOCATION_SUMMARY_INVALID');
  return { soldBytes, freeTrialBytes, allocatedBytes, usedBytes, remainingBytes, unlimited: entry.unlimited };
}

export function formatAllocationBytes(bytes: string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const amount = BigInt(bytes);
  let scale = 0, divisor = 1n;
  while (scale < units.length - 1 && amount >= divisor * 1024n) { scale++; divisor *= 1024n; }
  const tenths = (amount * 10n) / divisor;
  return `${tenths / 10n}${tenths % 10n ? `.${tenths % 10n}` : ''} ${units[scale]}`;
}

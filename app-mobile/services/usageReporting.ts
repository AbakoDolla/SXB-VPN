import { AppRegistry } from 'react-native';

export const USAGE_REPORT_INTERVAL_MS = 20_000;
let reporter: (() => Promise<void>) | null = null;

// HeadlessJS keeps React Native timers (including HTTP timeouts) alive while
// the Activity is paused. The native service, not a JS interval, starts ticks.
AppRegistry.registerHeadlessTask?.('SxbUsageReport', () => async () => {
  if (reporter) await reporter();
});

export function registerUsageReporter(callback: () => Promise<void>): () => void {
  reporter = callback;
  return () => { if (reporter === callback) reporter = null; };
}

export function usageDeadline<T>(operation: Promise<T>, delay: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('VPN_USAGE_TIMEOUT')), delay);
    operation.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

export function usageRetryDelay(error: unknown, failures: number, now = Date.now()): number {
  const response = (error as { response?: { status?: number; headers?: Record<string, unknown>; data?: { retryAfterSeconds?: unknown } } })?.response;
  const header = response?.headers?.['retry-after'];
  const seconds = Number(response?.data?.retryAfterSeconds ?? header);
  const retryAfter = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000
    : typeof header === 'string' ? Math.max(0, Date.parse(header) - now) : 0;
  const backoff = response?.status === 403 || response?.status === 409
    ? 300_000 : Math.min(300_000, USAGE_REPORT_INTERVAL_MS * 2 ** Math.min(failures - 1, 4));
  return Math.max(backoff, Number.isFinite(retryAfter) ? retryAfter : 0);
}

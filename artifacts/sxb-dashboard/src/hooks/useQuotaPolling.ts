import { useEffect, useRef } from "react";

export const QUOTA_POLL_INTERVAL_MS = 15_000;

export function startQuotaPolling(
  read: () => Promise<() => void>,
  flight: { current: boolean },
  visibility: Pick<Document, "hidden" | "addEventListener" | "removeEventListener"> = document,
) {
  let disposed = false;
  let forbidden = false;
  let failures = 0;
  let notBefore = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    if (!disposed && !forbidden && !visibility.hidden) {
      timer = setTimeout(poll, Math.max(QUOTA_POLL_INTERVAL_MS, notBefore - Date.now()));
    }
  };
  const poll = async () => {
    if (disposed || forbidden || visibility.hidden) return;
    if (flight.current || Date.now() < notBefore) { schedule(); return; }
    flight.current = true;
    try {
      const apply = await read();
      if (!disposed) apply();
      failures = 0;
      notBefore = 0;
    } catch (error) {
      const status = (error as { status?: number })?.status;
      const retryAfter = (error as { retryAfterSeconds?: number })?.retryAfterSeconds;
      forbidden = status === 401 || status === 403;
      failures++;
      notBefore = Date.now() + Math.max(
        Math.min(300_000, QUOTA_POLL_INTERVAL_MS * 2 ** Math.min(failures, 5)),
        typeof retryAfter === "number" && Number.isFinite(retryAfter) ? retryAfter * 1000 : 0,
      );
      console.error("Quota refresh deferred", error);
    } finally {
      flight.current = false;
      schedule();
    }
  };
  const onVisibility = () => {
    clearTimeout(timer);
    if (!visibility.hidden) void poll();
  };
  visibility.addEventListener("visibilitychange", onVisibility);
  schedule();
  return () => {
    disposed = true;
    clearTimeout(timer);
    visibility.removeEventListener("visibilitychange", onVisibility);
  };
}

export function useQuotaPolling(read: () => Promise<() => void>, enabled: boolean) {
  const latest = useRef(read);
  const flight = useRef(false);
  latest.current = read;
  useEffect(() => {
    if (enabled) return startQuotaPolling(() => latest.current(), flight);
    return undefined;
  }, [enabled]);
}

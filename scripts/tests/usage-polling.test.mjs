import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const require = createRequire(new URL("../../backend/package.json", import.meta.url));
const { transformSync } = require("esbuild");

function harness(file, imports = {}) {
  let now = 1_000_000;
  let next = 0;
  const timers = new Map();
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL(file, import.meta.url), "utf8"), { loader: "ts", format: "cjs" }).code;
  runInNewContext(code, {
    module, exports: module.exports,
    require: name => imports[name] ?? {},
    Date: class extends Date { static now() { return now; } },
    console: { error() {}, warn() {} },
    setTimeout: (callback, delay) => { const id = ++next; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  return {
    api: module.exports, timers,
    async tick() {
      const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      timers.delete(id);
      now = timer.at;
      await timer.callback();
    },
    now: () => now,
  };
}

test("usage polling: hidden tabs stop; visibility refresh cannot overlap or publish after disposal", async () => {
  const h = harness("../../artifacts/sxb-dashboard/src/hooks/useQuotaPolling.ts");
  let visibilityChanged;
  const visibility = {
    hidden: false, addEventListener: (_name, fn) => { visibilityChanged = fn; },
    removeEventListener: () => {},
  };
  let reads = 0, writes = 0, release;
  const stop = h.api.startQuotaPolling(async () => {
    reads++;
    await new Promise(resolve => { release = resolve; });
    return () => { writes++; };
  }, { current: false }, visibility);
  const poll = h.tick();
  visibilityChanged();
  assert.equal(reads, 1);
  visibility.hidden = true;
  visibilityChanged();
  assert.equal(h.timers.size, 0);
  stop();
  release();
  await poll;
  assert.equal(writes, 0);
  assert.equal(h.timers.size, 0);
});

test("usage polling: Retry-After survives visibility changes; access refusal stops requests", async () => {
  const h = harness("../../artifacts/sxb-dashboard/src/hooks/useQuotaPolling.ts");
  let visibilityChanged, reads = 0;
  const visibility = { hidden: false, addEventListener: (_name, fn) => { visibilityChanged = fn; }, removeEventListener() {} };
  h.api.startQuotaPolling(async () => {
    reads++;
    throw reads === 1 ? { status: 429, retryAfterSeconds: 900 } : { status: 403 };
  }, { current: false }, visibility);
  await h.tick();
  assert.equal([...h.timers.values()][0].at - h.now(), 900_000);
  visibilityChanged();
  assert.equal(reads, 1);
  await h.tick();
  assert.equal(reads, 2);
  assert.equal(h.timers.size, 0);
  visibilityChanged();
  assert.equal(reads, 2);
});

test("usage reporting: native headless ticks run the same reporter while JS intervals are paused", async () => {
  let task;
  const h = harness("../../app-mobile/services/usageReporting.ts", {
    "react-native": { AppRegistry: { registerHeadlessTask: (name, factory) => {
      assert.equal(name, "SxbUsageReport"); task = factory();
    } } },
  });
  let reports = 0;
  const unregister = h.api.registerUsageReporter(async () => { reports++; });
  await task();
  assert.equal(reports, 1);
  assert.equal(h.timers.size, 0);
  unregister();
  await task();
  assert.equal(reports, 1);
  assert.equal(h.api.usageRetryDelay({ response: { status: 429, headers: { "retry-after": "900" } } }, 1), 900_000);
});

test("usage reporting: deadline rejects instead of allowing an unanchored tunnel", async () => {
  const h = harness("../../app-mobile/services/usageReporting.ts", {
    "react-native": { AppRegistry: { registerHeadlessTask() {} } },
  });
  const refused = h.api.usageDeadline(Promise.reject(new Error("DISK_FAILED")), 8000);
  await assert.rejects(refused, /DISK_FAILED/);
  assert.equal(h.timers.size, 0);
  const stalled = h.api.usageDeadline(new Promise(() => {}), 8000);
  const rejection = assert.rejects(stalled, /VPN_USAGE_TIMEOUT/);
  await h.tick();
  await rejection;
});

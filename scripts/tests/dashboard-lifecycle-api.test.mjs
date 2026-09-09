import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runInNewContext } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(path.join(root, "backend", "package.json"));
const { build } = require("esbuild");
const bundle = await build({
  stdin: {
    contents: `
      export * from "./artifacts/sxb-dashboard/src/api/devices";
      export * from "./artifacts/sxb-dashboard/src/api/clients";
      export * from "./artifacts/sxb-dashboard/src/api/subscriptions";
      export * from "./artifacts/sxb-dashboard/src/lib/lifecycle";
      export * from "./artifacts/sxb-dashboard/src/lib/i18n";
    `,
    resolveDir: root, loader: "ts",
  },
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
});
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const calls = [], writes = [], redirects = [];
  let status = 200, response = { id: "fixture", token: "SXB-USER-DEMO-0000-0001" };
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    localStorage: {
      getItem: key => key === "sxb_access_token" ? "fixture-dashboard-access" : null,
      setItem: (...args) => writes.push(args), removeItem: key => writes.push(key),
    },
    window: { location: { assign: value => redirects.push(value) } },
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(response) };
    },
  });
  return { api: module.exports, calls, writes, redirects, respond: (nextStatus, nextResponse) => { status = nextStatus; response = nextResponse; } };
}

test("device lifecycle uses the exact legacy and additive POST paths and explicit renewal duration", async () => {
  const f = fixture();
  await f.api.revokeDevice("device-1");
  await f.api.suspendDevice("device-1");
  await f.api.resumeDevice("device-1");
  const renewed = await f.api.renewDevice("device-1", 90);
  assert.deepEqual(f.calls.map(call => [call.method, call.url, call.body && JSON.parse(call.body)]), [
    ["POST", "/xapi/devices/device-1/revoke", undefined],
    ["POST", "/xapi/devices/device-1/suspend", undefined],
    ["POST", "/xapi/devices/device-1/resume", undefined],
    ["POST", "/xapi/devices/device-1/renew", { durationDays: 90 }],
  ]);
  assert.equal(renewed.token, "SXB-USER-DEMO-0000-0001");
  assert.deepEqual(f.writes, []);
});

test("client renewal keeps the 30-day legacy API and never sends plan or quota fields", async () => {
  const f = fixture();
  await f.api.suspendClient("client-1");
  await f.api.activateClient("client-1");
  await f.api.renewClient("client-1");
  await f.api.resetClientAccess("client-1");
  assert.deepEqual(f.calls.map(call => [call.method, call.url, call.body]), [
    ["POST", "/xapi/clients/client-1/suspend", undefined],
    ["POST", "/xapi/clients/client-1/activate", undefined],
    ["POST", "/xapi/clients/client-1/renew", undefined],
    ["POST", "/xapi/clients/client-1/reset-access", undefined],
  ]);
});

test("adding data and extending duration target existing subscriptions, never device activation", async () => {
  const f = fixture();
  await f.api.bulkSubscriptions({ action: "add_data", subscriptionIds: ["plan-1"], quotaGB: 5 });
  await f.api.bulkSubscriptions({ action: "extend_duration", subscriptionIds: ["plan-1"], durationDays: 30 });
  await f.api.suspendSubscription("plan-1");
  await f.api.reactivateSubscription("plan-1");
  await f.api.revokeSubscription("plan-1");
  await f.api.deleteSubscription("plan-1");
  assert.deepEqual(f.calls.map(call => [call.method, call.url, call.body && JSON.parse(call.body)]), [
    ["POST", "/xapi/subscriptions/bulk", { action: "add_data", subscriptionIds: ["plan-1"], quotaGB: 5 }],
    ["POST", "/xapi/subscriptions/bulk", { action: "extend_duration", subscriptionIds: ["plan-1"], durationDays: 30 }],
    ["PUT", "/xapi/subscriptions/plan-1", { status: "suspended" }],
    ["PUT", "/xapi/subscriptions/plan-1", { status: "active" }],
    ["POST", "/xapi/subscriptions/plan-1/revoke", {}],
    ["DELETE", "/xapi/subscriptions/plan-1", undefined],
  ]);
  assert.deepEqual(f.writes, []);
});

test("all typed lifecycle failures retain codes, preserve dashboard credentials and render in FR/EN", async () => {
  const f = fixture();
  for (const code of [
    "DEVICE_SUSPENDED", "DEVICE_DISABLED", "DEVICE_EXPIRED", "DEVICE_REVOKED", "DEVICE_DELETED",
    "CONFIG_SUSPENDED", "CONFIG_EXPIRED", "CONFIG_EXHAUSTED", "CONFIG_REVOKED", "CONFIG_DELETED",
  ]) {
    f.respond(403, { code, scope: code.startsWith("DEVICE") ? "device" : "subscription", temporary: true, error: "errors.auth.forbidden" });
    await assert.rejects(f.api.renewDevice("device-1", 30), error => {
      assert.equal(error.code, code);
      assert.equal(error.responseData.scope, code.startsWith("DEVICE") ? "device" : "subscription");
      assert.ok(!error.message.includes("errors."));
      assert.notEqual(error.message, f.api.translate("fr", "errors.auth.forbidden"));
      return true;
    });
  }
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.redirects, []);
  f.respond(503, { error: "errors.server" });
  await assert.rejects(f.api.fetchDevices(), error => error.status === 503);
});

test("device status and expiry never derive from a plan's exhausted data or earlier deadline", () => {
  const { api } = fixture();
  const now = Date.parse("2026-09-09T06:00:00Z");
  const record = { status: "active", expireAt: "2028-01-01T00:00:00Z", subscriptionExpireAt: "2020-01-01T00:00:00Z", quotaBytes: "1", quotaUsed: "1" };
  assert.equal(api.deviceStatus(record, now), "active");
  assert.equal(api.subscriptionStatus(record, now), "exhausted");
  for (const status of ["suspended", "disabled", "revoked"]) assert.equal(api.deviceStatus({ ...record, status }, now), status);
  for (const language of ["fr", "en"]) {
    const badges = api.lifecycleBadges(key => api.translate(language, key));
    assert.notEqual(badges.suspended.label, badges.revoked.label);
    assert.notEqual(badges.disabled.label, badges.expired.label);
    assert.notEqual(badges.unknown.label, badges.active.label);
  }
  assert.equal(api.deviceStatus({ ...record, expireAt: new Date(now).toISOString() }, now), "expired");
  assert.equal(api.canResumeDevice({ ...record, status: "disabled" }, now), true);
  assert.equal(api.canResumeDevice({ ...record, status: "disabled", expireAt: "2020-01-01T00:00:00Z" }, now), false);
  assert.equal(api.canResumeDevice({ ...record, status: "revoked" }, now), false);
});

test("plan exhaustion uses exact positive BigInt limits and preserves zero-rated plans and suspension", () => {
  const { api } = fixture();
  const now = Date.parse("2026-09-09T06:00:00Z");
  const plan = { status: "active", expireAt: "2028-01-01T00:00:00Z", quotaBytes: "9007199254740993", quotaUsed: "9007199254740992" };
  assert.equal(api.isPlanExhausted(plan), false);
  assert.equal(api.isPlanExhausted({ ...plan, quotaUsed: plan.quotaBytes }), true);
  assert.equal(api.isPlanExhausted({ ...plan, quotaBytes: "-1" }), false);
  assert.equal(api.isPlanExhausted({ ...plan, quotaBytes: "0", quotaUsed: "0" }), false);
  assert.equal(api.isPlanExhausted({ ...plan, quotaBytes: "0" }), false);
  assert.equal(api.subscriptionStatus({ ...plan, status: "suspended", quotaBytes: "0" }, now), "suspended");
  assert.equal(api.subscriptionStatus({ ...plan, status: "revoked", quotaBytes: "0" }, now), "revoked");
  assert.equal(api.canResumeSubscription({ ...plan, status: "suspended" }, now), true);
  assert.equal(api.canResumeSubscription({ ...plan, status: "suspended", quotaBytes: "0" }, now), true);
  assert.equal(api.canResumeSubscription({ ...plan, status: "suspended", quotaBytes: "1" }, now), false);
  assert.equal(api.canResumeSubscription({ ...plan, status: "suspended", expireAt: "2020-01-01T00:00:00Z" }, now), false);
  assert.deepEqual(plain(plan), plan);
});

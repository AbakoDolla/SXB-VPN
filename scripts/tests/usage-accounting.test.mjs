import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(path.join(root, "backend", "package.json"));
const { build } = require("esbuild");
const GiB = 1024n ** 3n;
const MiB = 1024n ** 2n;
const deviceId = "usage-fixture-device";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function loadRoutes(db) {
  const output = await build({
    stdin: {
      contents: `
        export { applyUsageDelta, computeAccountState, default as mobile } from './server/routes/mobile';
        export { default as provision } from './server/routes/provision';
        export { default as devices } from './server/routes/devices';
        export { sanitizeDevice } from './server/services/device-quota';
        export { vueAccesEssai } from './server/services/free-trial';
        export { readMobileAccessSnapshot } from './server/services/mobile-access-state';
        export * as usage from './app-mobile/services/usageLedger';
        export { deriveQuota } from './app-mobile/services/quotaState';
        export { default as storage } from './scripts/tests/stubs/async-storage.mjs';
        export { prisma } from './scripts/tests/stubs/database-stub.mjs';`,
      resolveDir: root, loader: "ts",
    },
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external", logLevel: "silent",
    define: { "process.env.ENCRYPTION_KEY": '"fixture-only-encryption-key"' },
    plugins: [{
      name: "existing-in-memory-database",
      setup(plugin) {
        plugin.onResolve({ filter: /(^|\/)database$/ }, () => ({
          path: path.join(root, "scripts", "tests", "stubs", "database-stub.mjs"),
        }));
        plugin.onResolve({ filter: /^(\.\.\/)+config$/ }, () => ({ path: "config", namespace: "fixture" }));
        plugin.onResolve({ filter: /^@react-native-async-storage\/async-storage$/ }, () => ({
          path: path.join(root, "scripts", "tests", "stubs", "async-storage.mjs"),
        }));
        plugin.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: `export const config={jwtSecret:'fixture',refreshSecret:'fixture',accessTokenExpiry:'15m'};`,
          loader: "js",
        }));
      },
    }],
  });
  const module = { exports: {} };
  runInNewContext(output.outputFiles[0].text, {
    module, exports: module.exports, require, Buffer, URL, AbortController,
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval,
    process: { env: { NODE_ENV: "test" } },
  });
  Object.assign(module.exports.prisma, db.prisma);
  return module.exports;
}

function database() {
  const state = {
    client: {
      id: "client", userId: "user", deviceId, status: "active",
      activatedAt: new Date("2026-01-01"), quotaUsed: 0n, quotaTotal: 10n * GiB,
    },
    subscriptions: ["normal", "trial"].map((id, index) => ({
      id, clientId: "client", name: id, status: "active", quotaUsed: 0n,
      quotaBytes: (index ? 1n : 10n) * GiB,
      createdAt: new Date(`2026-01-0${index + 1}`),
      deviceId, devices: [{ deviceId }], profile: { status: "active" },
    })),
    traffic: [],
  };
  const db = { state, gate: null, failNextCommit: false };
  const client = (value) => ({ ...value.client, subscriptions: value.subscriptions });
  function delegates(value) {
    return {
      _runtimeDataModel: { models: { TrafficUsage: { fields: [{ name: "reportKey" }] } } },
      vpnClient: {
        findMany: async () => [client(value)],
        findUnique: async () => client(value),
        update: async ({ data }) => { value.client.quotaUsed += data.quotaUsed.increment; return value.client; },
      },
      subscription: {
        findFirst: async ({ where }) => value.subscriptions
          .filter(sub => sub.clientId === where.clientId && (!where.status || sub.status === where.status))
          .sort((a, b) => +b.createdAt - +a.createdAt)[0] ?? null,
        findMany: async () => value.subscriptions,
        findUnique: async ({ where }) => {
          const sub = value.subscriptions.find(item => item.id === where.id);
          return sub ? { ...sub, client: { ...value.client } } : null;
        },
        updateMany: async ({ where, data }) => {
          const sub = value.subscriptions.find(item => item.id === where.id && item.clientId === where.clientId);
          if (!sub) return { count: 0 };
          sub.quotaUsed += data.quotaUsed.increment;
          return { count: 1 };
        },
      },
      subscriptionDevice: { updateMany: async () => ({ count: 1 }) },
      trafficUsage: {
        findUnique: async ({ where }) => value.traffic.find(row => row.reportKey === where.reportKey) ?? null,
        findMany: async () => value.traffic,
        create: async ({ data }) => {
          if (data.reportKey && value.traffic.some(row => row.reportKey === data.reportKey)) {
            throw Object.assign(new Error("Unique reportKey"), { code: "P2002", meta: { target: ["reportKey"] } });
          }
          const row = { ...data, timestamp: new Date() };
          value.traffic.push(row);
          return row;
        },
      },
      freeTrialRequest: { findMany: async () => [] },
      reseller: { findMany: async () => [], findUnique: async () => null, findFirst: async () => null },
    };
  }
  let tail = Promise.resolve();
  db.prisma = {
    ...delegates(state),
    $transaction(work) {
      const operation = tail.then(async () => {
        if (db.gate) await db.gate.promise;
        const staged = structuredClone(state);
        const result = await work(delegates(staged));
        if (db.failNextCommit) {
          db.failNextCommit = false;
          throw new Error("COMMIT_FAILED");
        }
        Object.assign(state, staged);
        return result;
      });
      tail = operation.catch(() => {});
      return operation;
    },
  };
  return db;
}

async function route(router, method, path, body = {}, query = {}) {
  const handler = router.stack.find(layer => layer.route?.path === path && layer.route.methods[method])
    ?.route.stack.at(-1).handle;
  assert.ok(handler, `${method} ${path} must be the real route`);
  const req = {
    body, query, params: { subscriptionId: body.subscriptionId ?? query.subscriptionId },
    user: { userId: "user", clientId: "client", deviceId, role: "CLIENT" },
    get: () => deviceId, headers: { "x-sxb-device-id": deviceId },
  };
  const response = { status: 200, body: null };
  const res = {
    status(code) { response.status = code; return res; },
    json(data) { response.body = data; return res; },
  };
  await handler(req, res);
  return response;
}

test("usage: concurrent retry cannot acknowledge a transaction that has not committed", async () => {
  const db = database();
  const api = await loadRoutes(db);
  db.gate = deferred();
  const one = api.applyUsageDelta("client", "normal", 37n, "inflight", 0, 11n, deviceId);
  const two = api.applyUsageDelta("client", "normal", 37n, "inflight", 0, 11n, deviceId);
  let secondResolved = false;
  void two.then(() => { secondResolved = true; });
  await new Promise(resolve => setImmediate(resolve));
  const resolvedBeforeCommit = secondResolved;
  db.gate.resolve();
  await Promise.all([one, two]);
  assert.equal(resolvedBeforeCommit, false, "an early duplicate acknowledgement can permanently lose traffic if commit fails");
  assert.equal(db.state.client.quotaUsed, 37n);
  assert.equal(db.state.traffic.length, 1);
});

test("usage: a retry after a failed transaction applies once with both byte directions", async () => {
  const db = database();
  const api = await loadRoutes(db);
  db.failNextCommit = true;
  await assert.rejects(api.applyUsageDelta("client", "trial", 37n, "failure", 0, 11n, deviceId), /COMMIT_FAILED/);
  assert.equal(db.state.client.quotaUsed, 0n);
  assert.equal(db.state.traffic.length, 0);
  assert.equal((await api.applyUsageDelta("client", "trial", 37n, "failure", 0, 11n, deviceId)).applied, true);
  assert.equal(db.state.client.quotaUsed, 37n);
  assert.equal(db.state.traffic[0].upload, 11n);
  assert.equal(db.state.traffic[0].download, 26n);
});

test("usage: durable replay names the original credited subscription after a server restart", async () => {
  const db = database();
  const first = await loadRoutes(db);
  const body = { bytesUp: 11, bytesDown: 26, sessionId: "restart", seq: 0, reportMode: "delta", deviceId };
  const receipt = await route(first.mobile, "post", "/vpn/traffic", body);
  assert.equal(receipt.body.subscriptionId, "trial");
  db.state.subscriptions.find(sub => sub.id === "trial").status = "expired";
  const restarted = await loadRoutes(db);
  const replay = await route(restarted.mobile, "post", "/vpn/traffic", body);
  assert.equal(replay.body.duplicate, true);
  assert.equal(replay.body.subscriptionId, "trial", "do not return the next active normal plan's quota");
  assert.equal(replay.body.quotaUsedBytes, 37);
  assert.equal(db.state.client.quotaUsed, 37n);
  assert.equal(db.state.traffic.length, 1);
});

test("usage: a cross-process unique-key race rolls back and returns the committed plan", async () => {
  const db = database();
  const first = await loadRoutes(db);
  await first.applyUsageDelta("client", null, 37n, "replicas", 0, 11n, deviceId);
  db.state.subscriptions.find(sub => sub.id === "trial").status = "expired";
  const transaction = db.prisma.$transaction;
  db.prisma.$transaction = work => transaction(tx => work({
    ...tx, trafficUsage: { ...tx.trafficUsage, findUnique: async () => null },
  }));
  const otherProcess = await loadRoutes(db);
  const receipt = await otherProcess.applyUsageDelta("client", null, 37n, "replicas", 0, 11n, deviceId);
  assert.equal(receipt.reason, "duplicate_report");
  assert.equal(receipt.subscriptionId, "trial");
  assert.equal(db.state.subscriptions[0].quotaUsed, 0n);
  assert.equal(db.state.subscriptions[1].quotaUsed, 37n);
  assert.equal(db.state.client.quotaUsed, 37n);
  assert.equal(db.state.traffic.length, 1);
});

test("usage: an unrelated unique constraint is never mistaken for an accepted report", async () => {
  const db = database();
  db.prisma.$transaction = async () => {
    throw Object.assign(new Error("Unrelated unique constraint"), { code: "P2002" });
  };
  const api = await loadRoutes(db);
  await assert.rejects(api.applyUsageDelta("client", "normal", 37n, "unrelated", 0, 11n, deviceId), /Unrelated unique constraint/);
  assert.equal(db.state.client.quotaUsed, 0n);
  assert.equal(db.state.traffic.length, 0);
});

test("usage: reject oversized or absolute-mode reports instead of falsely acknowledging deltas", async () => {
  const db = database();
  const api = await loadRoutes(db);
  for (const body of [
    { bytesUp: 0, bytesDown: Number(6n * GiB), sessionId: "too-large", seq: 0 },
    { bytesUp: 11, bytesDown: 26, reportMode: "absolute", sessionId: "absolute", seq: 0 },
  ]) {
    const result = await route(api.mobile, "post", "/vpn/traffic", { ...body, subscriptionId: "normal", deviceId });
    assert.equal(result.status, 400);
  }
  assert.equal(db.state.client.quotaUsed, 0n);
  assert.equal(db.state.traffic.length, 0);
});

test("usage: normal and trial quota snapshots use the same exact bytes as dashboard rollups", async () => {
  const db = database();
  const api = await loadRoutes(db);
  const reports = [
    ["normal", 3n * MiB, 7n * MiB, "normal-one", 0],
    ["normal", 2n * MiB, 5n * MiB, "normal-two", 1],
    ["trial", MiB, 4n * MiB, "trial-one", 2],
  ];
  for (const [subscriptionId, up, down, sessionId, seq] of reports) {
    const body = { subscriptionId, bytesUp: Number(up), bytesDown: Number(down), sessionId, seq, reportMode: "delta", deviceId };
    assert.equal((await route(api.mobile, "post", "/vpn/traffic", body)).status, 200);
    assert.equal((await route(api.mobile, "post", "/vpn/traffic", body)).body.duplicate, true);
  }
  const client = { ...db.state.client, subscriptions: db.state.subscriptions };
  for (const sub of db.state.subscriptions) {
    const traffic = db.state.traffic.filter(row => row.accountId === sub.id);
    const upload = traffic.reduce((total, row) => total + row.upload, 0n);
    const download = traffic.reduce((total, row) => total + row.download, 0n);
    assert.equal(upload + download, sub.quotaUsed);
    assert.equal(api.computeAccountState(client, sub).quotaUsedBytes, Number(sub.quotaUsed));
    assert.equal(api.sanitizeDevice(client, { upload, download }, sub).quotaUsed, String(sub.quotaUsed));
  }
  assert.equal(db.state.subscriptions[0].quotaUsed, 17n * MiB);
  assert.equal(db.state.subscriptions[1].quotaUsed, 5n * MiB);
  assert.equal(db.state.client.quotaUsed, 22n * MiB);
  assert.equal(api.vueAccesEssai([db.state.subscriptions[1]]).quotaUsed, String(5n * MiB));
});

test("usage: a normal dashboard plan with no traffic must not inherit an earlier trial's bytes", async () => {
  const db = database();
  const api = await loadRoutes(db);
  await api.applyUsageDelta("client", "trial", 37n, "trial-only", 0, 11n, deviceId);
  db.state.subscriptions.find(sub => sub.id === "normal").createdAt = new Date("2026-02-01");
  const response = await route(api.devices, "get", "/", {}, { includeFreeTrial: "true" });
  assert.equal(response.status, 200);
  assert.equal(response.body.devices[0].subscriptionId, "normal");
  assert.equal(response.body.devices[0].quotaUsed, "0");
  assert.equal(response.body.devices[0].trafficTotal, "0");
});

test("usage: dashboard rollups retain same-plan legacy reports without a device tag", async () => {
  const db = database();
  const api = await loadRoutes(db);
  db.state.traffic.push({ clientId: "client", accountId: "normal", deviceId: null, upload: 11n, download: 26n, timestamp: new Date("2026-01-01") });
  db.state.client.quotaUsed = 37n;
  db.state.subscriptions[0].quotaUsed = 37n;
  db.state.subscriptions[0].createdAt = new Date("2026-02-01");
  await api.applyUsageDelta("client", "normal", 5n, "tagged", 0, 2n, deviceId);
  const response = await route(api.devices, "get", "/", {}, { includeFreeTrial: "true" });
  assert.equal(response.status, 200);
  assert.equal(response.body.devices[0].quotaUsed, "42");
  assert.equal(response.body.devices[0].trafficUpload, "13");
  assert.equal(response.body.devices[0].trafficDownload, "29");
  assert.equal(response.body.devices[0].trafficTotal, "42");
});

test("usage: lifetime samples survive offline replay, app/server restart and a switch to trial end to end", async () => {
  const db = database();
  let api = await loadRoutes(db);
  const normal = { subscriptionId: "normal", configId: "normal", sessionId: "normal-one" };
  let ledger = api.usage.anchorLedger(api.usage.emptyLedger(), { up: 0, down: 0 });
  ledger = api.usage.recordQuota(ledger, normal, { usedBytes: 0, totalBytes: Number(10n * GiB) });
  ledger = api.usage.accumulate(ledger, { up: Number(3n * MiB), down: Number(7n * MiB) }, normal);
  const first = api.usage.nextReport(ledger);
  await api.usage.saveLedger(first.ledger);
  const receipt = await route(api.mobile, "post", "/vpn/traffic", { ...first.report, deviceId, reportMode: "delta" });
  assert.equal(receipt.body.quotaUsedBytes, Number(10n * MiB));
  // The server committed, but its response was lost. A new native tunnel resets
  // session counters, not these lifetime counters or the frozen report.
  ledger = api.usage.accumulate(first.ledger, { up: Number(5n * MiB), down: Number(12n * MiB) }, {
    ...normal, sessionId: "normal-two",
  });
  await api.usage.saveLedger(ledger);
  const persisted = await api.storage.getItem("@sxb_usage_ledger");
  api = await loadRoutes(db);
  await api.storage.setItem("@sxb_usage_ledger", persisted);
  ledger = await api.usage.loadLedger();
  const control = await route(api.mobile, "get", "/connections");
  const normalQuota = control.body.connections.find(entry => entry.id === "normal").quota;
  const pending = api.usage.quotaProjection(ledger, normal);
  assert.equal(api.deriveQuota(normalQuota, {
    sessionUp: 0, sessionDown: 0, sessionBaselineUp: 0, sessionBaselineDown: 0, ...pending,
  }, false).usedBytes, Number(17n * MiB));
  const duplicate = api.usage.nextReport(ledger);
  const replay = await route(api.mobile, "post", "/vpn/traffic", { ...duplicate.report, deviceId, reportMode: "delta" });
  assert.equal(replay.body.duplicate, true);
  assert.equal(db.state.client.quotaUsed, 10n * MiB);
  ledger = api.usage.recordQuota(api.usage.settle(duplicate.ledger, duplicate.report), normal, {
    usedBytes: replay.body.quotaUsedBytes, totalBytes: replay.body.quotaTotalBytes,
  });
  const next = api.usage.nextReport(ledger);
  const accepted = await route(api.mobile, "post", "/vpn/traffic", { ...next.report, deviceId, reportMode: "delta" });
  ledger = api.usage.recordQuota(api.usage.settle(next.ledger, next.report), normal, {
    usedBytes: accepted.body.quotaUsedBytes, totalBytes: accepted.body.quotaTotalBytes,
  });
  const trial = { configId: "trial", subscriptionId: "trial", sessionId: "trial-one" };
  ledger = api.usage.accumulate(ledger, { up: Number(6n * MiB), down: Number(16n * MiB) }, trial);
  const trialReport = api.usage.nextReport(ledger);
  const trialReceipt = await route(api.mobile, "post", "/vpn/traffic", { ...trialReport.report, deviceId, reportMode: "delta" });
  ledger = api.usage.recordQuota(api.usage.settle(trialReport.ledger, trialReport.report), trial, {
    usedBytes: trialReceipt.body.quotaUsedBytes, totalBytes: trialReceipt.body.quotaTotalBytes,
  });
  await api.usage.saveLedger(ledger);
  assert.equal(api.usage.pendingBytes(await api.usage.loadLedger()), 0);
  const final = await route(api.mobile, "get", "/connections");
  const normalUsed = final.body.connections.find(entry => entry.id === "normal").quota.usedBytes;
  const trialUsed = final.body.connections.find(entry => entry.id === "trial").quota.usedBytes;
  assert.equal(normalUsed, Number(17n * MiB));
  assert.equal(trialUsed, Number(5n * MiB));
  assert.equal(db.state.client.quotaUsed, 22n * MiB);
  assert.equal(db.state.traffic.reduce((sum, row) => sum + row.upload, 0n), 6n * MiB);
  assert.equal(db.state.traffic.reduce((sum, row) => sum + row.download, 0n), 16n * MiB);
  assert.equal(api.vueAccesEssai([db.state.subscriptions[1]]).quotaUsed, String(trialUsed));
  assert.equal(api.deriveQuota({
    quotaUsedBytes: trialUsed, quotaTotalBytes: trialReceipt.body.quotaTotalBytes,
  }, {
    sessionUp: 0, sessionDown: 0, sessionBaselineUp: 0, sessionBaselineDown: 0,
    ...api.usage.quotaProjection(ledger, trial),
  }, false).usedBytes, trialUsed);
});

test("usage: legacy byte reports and session audits do not charge seconds or return another plan", async () => {
  const db = database();
  const api = await loadRoutes(db);
  for (const action of ["connect", "disconnect"]) {
    assert.equal((await route(api.mobile, "post", "/vpn/session", { action, duration: 90000 })).status, 200);
  }
  assert.equal(db.state.client.quotaUsed, 0n);
  const response = await route(api.mobile, "post", "/vpn/usage", {
    upload: 11, download: 26, duration: 90000, subscriptionId: "normal", sessionId: "legacy", seq: 0, deviceId,
  });
  assert.equal(response.status, 200);
  assert.equal(db.state.client.quotaUsed, 37n);
  assert.equal(response.body.quotaRemainingBytes, Number(10n * GiB - 37n));
});

test("usage: provisioning quota metadata preserves individual bytes instead of rounding GiB", async () => {
  const db = database();
  const api = await loadRoutes(db);
  const sub = db.state.subscriptions[0];
  sub.quotaBytes = GiB + 17n;
  sub.quotaUsed = 37n;
  const response = await route(api.provision, "get", "/status/:subscriptionId", {}, { subscriptionId: "normal" });
  assert.equal(response.status, 200);
  assert.equal(Math.round(response.body.quotaGB * Number(GiB)), Number(sub.quotaBytes));
  assert.equal(Math.round(response.body.quotaUsedGB * Number(GiB)), 37);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { resetPreview, resetResult, resetCountKeys } from "./fixtures/reset-dashboard-data.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(path.join(root, "backend", "package.json"));
const { build } = require("esbuild");
const bundle = await build({
  stdin: {
    contents: `
      export * from "./artifacts/sxb-dashboard/src/api/reset";
      export { fetchAccounts } from "./artifacts/sxb-dashboard/src/api/accounts";
      export { errorMessage } from "./artifacts/sxb-dashboard/src/lib/errors";
      export { translate } from "./artifacts/sxb-dashboard/src/lib/i18n";
    `,
    resolveDir: root, loader: "ts",
  },
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
});
const body = { mode: "production", challenge: resetPreview.challenge, confirmation: "RESET SXB VPN", password: "fixture-owner-password" };

function fixture() {
  const calls = [], writes = [], logs = [], redirects = [];
  let status = 200, response = resetPreview, transport;
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    localStorage: {
      getItem: key => key === "sxb_access_token" ? "fixture-session-token" : null,
      setItem: (...args) => writes.push(args), removeItem: key => writes.push([key]),
    },
    window: { location: { assign: value => redirects.push(value) } },
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      if (transport) return transport(url, options);
      return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => JSON.stringify(response) };
    },
  });
  return {
    api: module.exports, calls, writes, logs, redirects,
    respond: (nextStatus, nextResponse) => { status = nextStatus; response = nextResponse; },
    transport: handler => { transport = handler; },
  };
}

test("reset helpers reject every non-OWNER role before any network request", async () => {
  const f = fixture();
  for (const role of ["SUPER_ADMIN", "ADMIN", "SUPPORT", "RESELLER", "owner", "", undefined]) {
    await assert.rejects(f.api.fetchResetPreview(role), /errors.reset.ownerOnly/);
    await assert.rejects(f.api.fetchResetStatus(role), /errors.reset.ownerOnly/);
    await assert.rejects(f.api.executeReset(role, body), /errors.reset.ownerOnly/);
  }
  assert.deepEqual(f.calls, []);
});

test("preview and execution use the exact API paths and strict body without credentials in URL, logs or storage", async () => {
  const f = fixture();
  const preview = await f.api.fetchResetPreview("OWNER");
  assert.deepEqual([...f.api.RESET_COUNT_KEYS], resetCountKeys);
  assert.equal(preview.preserved.projectFiles, true);
  assert.equal(preview.counts.users, 2);
  assert.equal(preview.preserved.usersByRole.ADMIN, 3);
  f.respond(200, resetResult);
  const result = await f.api.executeReset("OWNER", body);
  assert.equal(result.backup.id, resetResult.backup.id);
  assert.deepEqual(f.calls.map(call => [call.url, call.method]), [
    ["/xapi/ops/reset/preview", "GET"], ["/xapi/ops/reset/execute", "POST"],
  ]);
  assert.deepEqual(JSON.parse(f.calls[1].body), body);
  assert.ok(!JSON.stringify(f.calls.map(({ url, headers }) => ({ url, headers }))).includes(body.password));
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.logs, []);
  assert.deepEqual(f.redirects, []);
});

test("wrong phrase, mode or missing password never sends a reset POST", async () => {
  const f = fixture();
  for (const change of [{ confirmation: "" }, { confirmation: "RESET SXB VPN " }, { password: " " }, { mode: "preview" }, { challenge: "" }]) {
    await assert.rejects(f.api.executeReset("OWNER", { ...body, ...change }), /errors.reset.confirmationRequired/);
  }
  assert.deepEqual(f.calls, []);
});

test("invalid preview metadata fails closed rather than inventing counts or permitting unbacked deletion", async () => {
  const f = fixture();
  for (const change of [
    { backupRequired: false }, { mode: "demo" }, { challenge: null }, { counts: { users: 2 } },
    { counts: { ...resetPreview.counts, clients: -1 } }, { counts: { ...resetPreview.counts, users: "2" } },
    { preserved: { ...resetPreview.preserved, projectFiles: false } },
    { preserved: { ...resetPreview.preserved, usersByRole: { OWNER: 1 } } }, { expiresAt: "not-a-date" },
  ]) {
    f.respond(200, { ...resetPreview, ...change });
    await assert.rejects(f.api.fetchResetPreview("OWNER"), /errors.reset.invalidResponse/);
  }
});

test("HTTP errors containing status completed never become success, including a maintenance failure", async () => {
  const f = fixture();
  for (const [status, code] of [[500, "RESET_FAILED"], [503, "RESET_MAINTENANCE_RESTORE_FAILED"], [403, "RESET_REAUTH_FAILED"]]) {
    f.respond(status, { ...resetResult, code, maintenanceRestored: false, error: "errors.server", message: body.password });
    await assert.rejects(f.api.executeReset("OWNER", body), error => {
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.ok(!f.api.resetErrorKey(error).includes(body.password));
      assert.ok(!f.api.errorMessage(error, "en").includes(body.password));
      return true;
    });
  }
  assert.deepEqual(f.redirects, []);
  assert.deepEqual(f.writes, []);
});

test("a malformed 2xx completion is uncertain and cannot provide a success receipt", async () => {
  const f = fixture();
  for (const response of [null, {}, { ...resetResult, status: "failed" }, { ...resetResult, backup: {} }, { ...resetResult, countsAfter: {} }]) {
    f.respond(200, response);
    await assert.rejects(f.api.executeReset("OWNER", body), /errors.reset.invalidResponse/);
  }
});

test("lost-response replay retains the same nonce and body with no automatic preview or extra execution", async () => {
  const f = fixture();
  let commits = 0;
  f.transport(async (_url, options) => {
    assert.equal(options.method, "POST");
    assert.equal(JSON.parse(options.body).challenge, resetPreview.challenge);
    if (!commits) { commits++; throw new TypeError("fixture lost response"); }
    return { ok: true, status: 200, text: async () => JSON.stringify(resetResult) };
  });
  await assert.rejects(f.api.executeReset("OWNER", body), /fixture lost response/);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.api.executeReset("OWNER", body)).resetId, resetResult.resetId);
  assert.equal(commits, 1);
  assert.equal(f.calls[0].body, f.calls[1].body);
  assert.equal(f.calls.some(call => call.method === "GET"), false);
});

test("reset failures resolve in both languages without echoing arbitrary reauthentication diagnostics", async () => {
  const f = fixture();
  const codes = [
    "OWNER_ONLY", "RESET_CONFIRMATION_REQUIRED", "RESET_INVALID_REQUEST", "RESET_CHALLENGE_INVALID",
    "RESET_CHALLENGE_EXPIRED", "RESET_PREVIEW_CHANGED", "RESET_IN_PROGRESS", "RESET_REAUTH_FAILED",
    "RESET_RATE_LIMITED", "RESET_BACKUP_FAILED", "RESET_FAILED", "RESET_MAINTENANCE_RESTORE_FAILED",
    "RESET_RECOVERED_NOT_EXECUTED",
  ];
  for (const code of codes) for (const language of ["fr", "en"]) {
    const key = f.api.resetErrorKey({ code, status: 403, message: body.password, responseData: { password: body.password } });
    const message = f.api.translate(language, key);
    assert.notEqual(message, key);
    assert.ok(!message.includes(body.password));
  }
  assert.equal(f.api.resetErrorKey({ message: body.password }), "errors.reset.requestFailed");
});

test("account reload failures propagate instead of erasing remaining failed bulk-delete rows with an empty success", async () => {
  const f = fixture();
  f.respond(503, { error: "errors.server" });
  await assert.rejects(f.api.fetchAccounts(), error => error.status === 503);
  f.respond(200, { users: [
    { id: "owner", name: "Owner", email: "owner@example.test", role: { name: "OWNER" } },
    { id: "admin", name: "Admin", email: "admin@example.test", role: "ADMIN" },
    { id: "client", name: "Client", email: "client@example.test", role: null },
  ] });
  const accounts = await f.api.fetchAccounts();
  assert.deepEqual([...accounts.map(account => account.role)], ["OWNER", "ADMIN", ""]);
  assert.deepEqual(f.logs, []);
});

test("status metadata is strictly typed and recovery reads the original nonce without any POST", async () => {
  const f = fixture();
  const common = { mode: "production", resetId: resetResult.resetId, challenge: "fixture-recovered-nonce", expiresAt: "2026-01-01T00:00:00Z" };
  for (const status of [
    { mode: "production", status: "idle", recoveryAvailable: false },
    { mode: "production", status: "in_progress", recoveryAvailable: false },
    { ...common, status: "recovery_required", recoveryAvailable: true },
    { ...common, status: "recovery_required", recoveryAvailable: true, receipt: { ...resetResult, maintenanceRestored: false } },
    { ...common, status: "completed", recoveryAvailable: false, receipt: resetResult },
  ]) {
    f.respond(200, status);
    const result = await f.api.fetchResetStatus("OWNER");
    assert.equal(result.status, status.status);
    assert.equal(result.challenge, status.challenge);
  }
  for (const status of [
    { ...common, status: "idle", recoveryAvailable: false },
    { ...common, status: "recovery_required", recoveryAvailable: false },
    { ...common, status: "recovery_required", recoveryAvailable: true, challenge: null },
    { ...common, status: "completed", recoveryAvailable: false },
    { ...common, status: "completed", recoveryAvailable: false, receipt: { ...resetResult, resetId: "other-reset" } },
    { ...common, status: "completed", recoveryAvailable: false, receipt: { ...resetResult, maintenanceRestored: false } },
  ]) {
    f.respond(200, status);
    await assert.rejects(f.api.fetchResetStatus("OWNER"), /errors.reset.invalidResponse/);
  }
  assert.ok(f.calls.every(call => call.method === "GET" && call.url === "/xapi/ops/reset/status"));
  assert.deepEqual(f.writes, []);
});

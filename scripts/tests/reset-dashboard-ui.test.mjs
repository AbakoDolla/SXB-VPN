import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, deferred, nodes, text, plain } from "./fixtures/dashboard-lifecycle-ui.mjs";
import { resetPreview, resetResult } from "./fixtures/reset-dashboard-data.mjs";

const password = "fixture-owner-reauth-password";
const dialog = f => nodes(f.render()).find(node => node.props["aria-labelledby"] === "owner-reset-title");
const input = (f, name) => nodes(dialog(f)).find(node => node.type === "input" && node.props.name === name);
const form = f => nodes(dialog(f)).find(node => node.type === "form");
const posts = f => f.calls.filter(([name, route, options]) => name === "apiRequest" && route === "/ops/reset/execute" && options?.method === "POST");
const previews = f => f.calls.filter(([name, route]) => name === "apiRequest" && route === "/ops/reset/preview");
const statuses = f => f.calls.filter(([name, route]) => name === "apiRequest" && route === "/ops/reset/status");
const stateText = f => JSON.stringify([...f.states.values()], (_key, value) => value instanceof Map || value instanceof Set ? [...value] : value);
const change = (f, name, value) => input(f, name).props.onChange({ target: name === "resetAcknowledgment" ? { checked: value } : { value } });
const fill = f => {
  change(f, "resetConfirmation", "RESET SXB VPN");
  change(f, "resetOwnerPassword", password);
  change(f, "resetAcknowledgment", true);
};
async function open(f) {
  await f.flush();
  f.button("operations.reset.tab").props.onClick();
  await f.flush();
  (f.button("operations.reset.open") ?? f.button("operations.reset.reopen")).props.onClick();
  await f.flush();
}
const submit = f => form(f).props.onSubmit({ preventDefault() {} });

test("settings never renders the reset tab or calls its preview for non-OWNER roles", async () => {
  for (const role of ["SUPER_ADMIN", "ADMIN", "SUPPORT", "RESELLER"]) {
    const f = fixture("SettingsView", { role });
    await f.flush();
    assert.equal(f.button("operations.reset.tab"), undefined);
    assert.equal(f.button("operations.reset.open"), undefined);
    assert.equal(previews(f).length, 0);
    assert.equal(statuses(f).length, 0);
    assert.equal(posts(f).length, 0);
    const direct = fixture("OwnerResetSection", { role });
    await direct.flush();
    assert.equal(text(direct.render()), "");
    assert.equal(direct.calls.length, 0);
  }
});

test("owner reset is opt-in, fully previewed, and gated by exact phrase, password and destructive acknowledgment", async () => {
  const f = fixture("SettingsView", { role: "OWNER" });
  await f.flush();
  assert.ok(f.button("operations.reset.tab"));
  assert.equal(previews(f).length, 0);
  await open(f);
  const confirm = () => f.button("operations.reset.confirm", dialog(f));
  assert.equal(previews(f).length, 1);
  assert.equal(confirm().props.disabled, true);
  assert.ok(text(dialog(f)).includes(f.t("operations.reset.usersScope")));
  assert.ok(text(dialog(f)).includes(f.t("operations.reset.lockException")));
  assert.ok(text(dialog(f)).includes(f.t("operations.reset.backupRequired")));
  assert.ok(text(dialog(f)).includes(f.t("operations.reset.projectFilesPreserved")));
  await submit(f);
  change(f, "resetConfirmation", "RESET SXB VPN ");
  change(f, "resetOwnerPassword", password);
  change(f, "resetAcknowledgment", true);
  assert.equal(confirm().props.disabled, true);
  await submit(f);
  change(f, "resetConfirmation", "RESET SXB VPN");
  change(f, "resetOwnerPassword", "");
  assert.equal(confirm().props.disabled, true);
  await submit(f);
  change(f, "resetOwnerPassword", password);
  change(f, "resetAcknowledgment", false);
  assert.equal(confirm().props.disabled, true);
  await submit(f);
  assert.equal(posts(f).length, 0);
  change(f, "resetAcknowledgment", true);
  assert.equal(confirm().props.disabled, false);
  assert.deepEqual(f.logs, []);
  assert.ok(!JSON.stringify(f.storage).includes(password));
});

test("an unresolved or invalid preview cannot enable submission or claim an empty inventory", async () => {
  const f = fixture("SettingsView", { role: "OWNER" });
  const request = deferred();
  f.overrides.apiRequest = route => route === "/ops/reset/status" ? plain(f.data.resetStatus) : request.promise;
  await open(f);
  assert.equal(form(f), undefined);
  assert.equal(f.button("operations.common.close", dialog(f)).props.disabled, true);
  assert.equal(posts(f).length, 0);
  request.resolve({ ...resetPreview, backupRequired: false });
  await f.flush();
  assert.ok(text(dialog(f)).includes(f.t("errors.reset.invalidResponse")));
  assert.equal(form(f), undefined);
  assert.ok(!text(dialog(f)).includes(f.t("operations.reset.completed")));
});

test("reset excludes overlapping POSTs and closing while pending, clears secrets on success, and rereads inventory", async () => {
  const f = fixture("SettingsView", { role: "OWNER" });
  await open(f); fill(f);
  const request = deferred();
  f.overrides.apiRequest = (route) => route === "/ops/reset/execute" ? request.promise : plain(f.data.resetPreview);
  const original = form(f);
  const oldClose = f.button("operations.common.close", dialog(f));
  const running = original.props.onSubmit({ preventDefault() {} });
  await original.props.onSubmit({ preventDefault() {} });
  oldClose.props.onClick();
  await f.flush();
  assert.ok(dialog(f));
  assert.equal(posts(f).length, 1);
  assert.equal(input(f, "resetOwnerPassword").props.disabled, true);
  assert.equal(f.button("operations.common.close", dialog(f)).props.disabled, true);
  assert.equal(f.button("operations.reset.tab").props.disabled, true);
  f.data.resetPreview.counts = plain(resetResult.countsAfter);
  request.resolve(plain(resetResult));
  await running; await f.flush();
  assert.equal(posts(f).length, 1);
  assert.equal(previews(f).length, 2);
  assert.equal(form(f), undefined);
  assert.ok(text(dialog(f)).includes(f.t("operations.reset.completed")));
  assert.ok(text(dialog(f)).includes(resetResult.backup.id));
  assert.ok(text(dialog(f)).includes(f.t("operations.reset.deletedCounts")));
  assert.ok(text(dialog(f)).includes(f.t("operations.reset.readback")));
  assert.ok(!stateText(f).includes(password));
  assert.ok(!JSON.stringify(f.storage).includes(password));
  assert.deepEqual(f.logs, []);
  await original.props.onSubmit({ preventDefault() {} });
  assert.equal(posts(f).length, 1);
  f.button("operations.common.close", dialog(f)).props.onClick();
  assert.equal(dialog(f), undefined);
  f.button("operations.reset.reopen").props.onClick();
  assert.ok(text(dialog(f)).includes(resetResult.resetId));
  assert.equal(posts(f).length, 1);
});

test("lost mutation response retries the identical nonce after closing, navigation and TTL expiry without new preview", async () => {
  const f = fixture("SettingsView", { role: "OWNER" });
  let committed = false;
  f.overrides.apiRequest = route => {
    if (route === "/ops/reset/status") return plain(f.data.resetStatus);
    if (route === "/ops/reset/preview") return plain(f.data.resetPreview);
    if (!committed) { committed = true; throw new TypeError("fixture response lost"); }
    return plain(resetResult);
  };
  await open(f); fill(f);
  await submit(f); await f.flush();
  assert.equal(posts(f).length, 1);
  assert.equal(previews(f).length, 1);
  assert.ok(!text(dialog(f)).includes(f.t("operations.reset.completed")));
  assert.ok(text(dialog(f)).includes(f.t("operations.reset.sameChallenge")));
  assert.equal(f.button("operations.reset.refreshPreview", dialog(f)), undefined);
  f.button("operations.common.close", dialog(f)).props.onClick();
  assert.ok(!stateText(f).includes(password));
  f.setRole("ADMIN"); await f.flush();
  assert.equal(f.button("operations.reset.tab"), undefined);
  assert.equal(previews(f).length, 1);
  f.advance(10 * 60_000);
  f.setRole("OWNER"); await f.flush();
  f.button("operations.reset.reopen").props.onClick();
  await f.flush();
  assert.equal(previews(f).length, 1);
  fill(f);
  assert.equal(f.button("operations.reset.retrySame", dialog(f)).props.disabled, false);
  await submit(f); await f.flush();
  assert.equal(posts(f).length, 2);
  assert.equal(posts(f)[0][2].body.challenge, posts(f)[1][2].body.challenge);
  assert.deepEqual(posts(f)[0][2].body, posts(f)[1][2].body);
  assert.ok(text(dialog(f)).includes(resetResult.resetId));
  assert.equal(previews(f).length, 2);
});

test("expired unexecuted previews never POST; explicitly refreshing clears all confirmation inputs", async () => {
  const f = fixture("SettingsView", { role: "OWNER" });
  await open(f); fill(f);
  f.advance(8 * 60_000 + 1); await f.flush();
  assert.equal(f.button("operations.reset.confirm", dialog(f)).props.disabled, true);
  await submit(f);
  assert.equal(posts(f).length, 0);
  f.data.resetPreview.expiresAt = "2026-09-09T06:30:00.000Z";
  f.data.resetPreview.challenge = "fixture-new-preview";
  await f.button("operations.reset.refreshPreview", dialog(f)).props.onClick(); await f.flush();
  assert.equal(input(f, "resetOwnerPassword").props.value, "");
  assert.equal(input(f, "resetConfirmation").props.value, "");
  assert.equal(input(f, "resetAcknowledgment").props.checked, false);
});

test("HTTP500, maintenance failure, reauthentication errors and malformed completion never show success or replace the nonce", async () => {
  for (const failure of [
    { status: 500, code: "RESET_FAILED", responseData: { ...resetResult, message: password } },
    { status: 503, code: "RESET_MAINTENANCE_RESTORE_FAILED", responseData: { ...resetResult, maintenanceRestored: false } },
    { status: 403, code: "RESET_REAUTH_FAILED", message: password },
    null,
  ]) {
    const f = fixture("SettingsView", { role: "OWNER" }); await open(f); fill(f);
    f.overrides.apiRequest = () => { if (failure) throw failure; return { status: "completed" }; };
    await submit(f); await f.flush();
    assert.equal(posts(f).length, 1);
    assert.equal(previews(f).length, 1);
    assert.ok(!text(dialog(f)).includes(f.t("operations.reset.completed")));
    assert.ok(nodes(dialog(f)).some(node => node.props.role === "alert"));
    assert.equal(input(f, "resetOwnerPassword").props.value, "");
    assert.ok(!stateText(f).includes(password));
    assert.ok(!text(dialog(f)).includes(password));
    assert.deepEqual(f.logs, []);
  }
});

test("failed readback keeps the completed receipt, exposes the failure, and offers only a GET reread", async () => {
  const f = fixture("SettingsView", { role: "OWNER" }); await open(f); fill(f);
  f.overrides.apiRequest = route => {
    if (route === "/ops/reset/execute") return plain(resetResult);
    throw { status: 503, code: "SERVER_ERROR" };
  };
  await submit(f); await f.flush();
  assert.ok(text(dialog(f)).includes(f.t("operations.reset.readbackFailed")));
  assert.ok(text(dialog(f)).includes(resetResult.resetId));
  assert.equal(form(f), undefined);
  await f.button("operations.reset.reread", dialog(f)).props.onClick(); await f.flush();
  assert.equal(posts(f).length, 1);
  assert.equal(previews(f).length, 3);
});

test("language changes keep entered confirmation without mutation; closing clears all fields", async () => {
  const f = fixture("SettingsView", { role: "OWNER" }); await open(f); fill(f);
  f.setLanguage("en"); await f.flush();
  assert.ok(text(dialog(f)).includes(f.t("operations.reset.passwordLabel")));
  assert.equal(input(f, "resetOwnerPassword").props.value, password);
  assert.equal(input(f, "resetConfirmation").props.value, "RESET SXB VPN");
  assert.equal(posts(f).length, 0);
  assert.equal(previews(f).length, 1);
  f.button("operations.common.close", dialog(f)).props.onClick();
  assert.ok(!stateText(f).includes(password));
  f.button("operations.reset.open").props.onClick(); await f.flush();
  assert.equal(input(f, "resetOwnerPassword").props.value, "");
  assert.equal(input(f, "resetAcknowledgment").props.checked, false);
  assert.equal(previews(f).length, 1);
});

const recoveryStatus = (receipt) => ({
  mode: "production", status: "recovery_required", recoveryAvailable: true,
  resetId: resetResult.resetId, challenge: "fixture-recovered-original-nonce",
  expiresAt: "2026-09-09T05:00:00.000Z", ...(receipt ? { receipt } : {}),
});

test("fresh page recovers the original expired nonce without preview or automatic POST and still requires explicit credentials", async () => {
  const f = fixture("SettingsView", { role: "OWNER", data: { resetStatus: recoveryStatus({ ...resetResult, maintenanceRestored: false }) } });
  await open(f);
  assert.equal(statuses(f).length, 1);
  assert.equal(previews(f).length, 0);
  assert.equal(posts(f).length, 0);
  assert.ok(text(dialog(f)).includes(f.t("operations.reset.recoveryTitle")));
  assert.equal(f.button("operations.reset.retrySame", dialog(f)).props.disabled, true);
  assert.equal(f.button("operations.reset.refreshPreview", dialog(f)), undefined);
  await submit(f);
  assert.equal(posts(f).length, 0);
  fill(f);
  assert.equal(f.button("operations.reset.retrySame", dialog(f)).props.disabled, false);
  await submit(f); await f.flush();
  assert.equal(posts(f).length, 1);
  assert.equal(posts(f)[0][2].body.challenge, "fixture-recovered-original-nonce");
  assert.equal(previews(f).length, 1);
  assert.ok(text(dialog(f)).includes(f.t("operations.reset.completed")));
  assert.ok(!stateText(f).includes(password));
});

test("recovery without a committed purge discards its consumed nonce, never claims reset success and requires an explicit fresh preview", async () => {
  const f = fixture("SettingsView", { role: "OWNER", data: { resetStatus: recoveryStatus() } });
  await open(f); fill(f);
  const oldForm = form(f);
  f.overrides.apiRequest = () => { throw {
    status: 409, code: "RESET_RECOVERED_NOT_EXECUTED",
    responseData: { status: "not_completed", resetId: resetResult.resetId, maintenanceRestored: true, requiresFreshPreview: true },
  }; };
  await submit(f); await f.flush();
  assert.ok(text(dialog(f)).includes(f.t("errors.reset.recoveredNotExecuted")));
  assert.ok(!text(dialog(f)).includes(f.t("operations.reset.completed")));
  assert.equal(form(f), undefined);
  assert.equal(previews(f).length, 0);
  assert.equal(posts(f).length, 1);
  assert.ok(!stateText(f).includes("fixture-recovered-original-nonce"));
  assert.ok(!stateText(f).includes(password));
  f.button("operations.common.close", dialog(f)).props.onClick();
  f.button("operations.reset.open").props.onClick(); await f.flush();
  assert.equal(statuses(f).length, 1);
  assert.equal(previews(f).length, 0);
  await oldForm.props.onSubmit({ preventDefault() {} });
  assert.equal(posts(f).length, 1);
  delete f.overrides.apiRequest;
  f.data.resetStatus = { mode: "production", status: "idle", recoveryAvailable: false };
  f.data.resetPreview.challenge = "fixture-fresh-nonce";
  await f.button("operations.reset.refreshPreview", dialog(f)).props.onClick(); await f.flush();
  assert.equal(previews(f).length, 1);
  assert.equal(input(f, "resetOwnerPassword").props.value, "");
  assert.equal(input(f, "resetConfirmation").props.value, "");
  assert.equal(input(f, "resetAcknowledgment").props.checked, false);
  assert.equal(posts(f).length, 1);
});

test("a committed purge awaiting maintenance recovery is not displayed as a completed operation before a successful replay", async () => {
  const receipt = { ...plain(resetResult), maintenanceRestored: false };
  const f = fixture("SettingsView", { role: "OWNER", data: { resetStatus: recoveryStatus(receipt) } });
  await open(f);
  assert.ok(text(dialog(f)).includes(f.t("operations.reset.recoveryReceipt")));
  assert.ok(!text(dialog(f)).includes(f.t("operations.reset.completed")));
  assert.equal(previews(f).length, 0);
  fill(f);
  f.overrides.apiRequest = () => { throw { status: 503, code: "RESET_MAINTENANCE_RESTORE_FAILED", responseData: receipt }; };
  await submit(f); await f.flush();
  assert.ok(!text(dialog(f)).includes(f.t("operations.reset.completed")));
  assert.equal(previews(f).length, 0);
  delete f.overrides.apiRequest; fill(f);
  await submit(f); await f.flush();
  assert.equal(posts(f).length, 2);
  assert.equal(posts(f)[0][2].body.challenge, posts(f)[1][2].body.challenge);
  assert.ok(text(dialog(f)).includes(f.t("operations.reset.completed")));
});

test("status completed shows history, not a new reset or current inventory; only an explicit new-operation click loads a fresh preview", async () => {
  const status = { ...recoveryStatus(), status: "completed", recoveryAvailable: false, receipt: plain(resetResult) };
  const f = fixture("SettingsView", { role: "OWNER", data: { resetStatus: status } }); await open(f);
  assert.equal(previews(f).length, 0);
  assert.equal(posts(f).length, 0);
  assert.equal(form(f), undefined);
  assert.ok(text(dialog(f)).includes(f.t("operations.reset.historicalReceipt")));
  assert.ok(text(dialog(f)).includes(f.t("operations.reset.historicalHint")));
  assert.ok(!text(dialog(f)).includes(f.t("operations.reset.completed")));
  await f.button("operations.reset.newOperation", dialog(f)).props.onClick(); await f.flush();
  assert.equal(statuses(f).length, 2);
  assert.equal(previews(f).length, 1);
  assert.equal(posts(f).length, 0);
  assert.ok(form(f));
  assert.equal(input(f, "resetOwnerPassword").props.value, "");
});

test("status in progress or unavailable cannot silently turn into a preview or deletion", async () => {
  const f = fixture("SettingsView", { role: "OWNER", data: { resetStatus: { mode: "production", status: "in_progress", recoveryAvailable: false } } });
  await open(f);
  assert.equal(form(f), undefined);
  assert.equal(previews(f).length, 0);
  assert.ok(text(dialog(f)).includes(f.t("errors.reset.inProgress")));
  await f.button("operations.reset.recheckStatus", dialog(f)).props.onClick(); await f.flush();
  assert.equal(statuses(f).length, 2);
  assert.equal(previews(f).length, 0);
  f.data.resetStatus = { mode: "production", status: "idle", recoveryAvailable: false };
  await f.button("operations.reset.recheckStatus", dialog(f)).props.onClick(); await f.flush();
  assert.equal(previews(f).length, 1);
  assert.equal(posts(f).length, 0);
});

test("a saved owner submit handler cannot make requests after that owner view is unmounted", async () => {
  const f = fixture("SettingsView", { role: "OWNER" }); await open(f); fill(f);
  const saved = form(f);
  f.setRole("SUPER_ADMIN"); await f.flush();
  const calls = f.calls.length;
  await saved.props.onSubmit({ preventDefault() {} });
  assert.equal(f.calls.length, calls);
  assert.equal(posts(f).length, 0);
});

test("an explicitly rejected preview cannot be replayed, and a failed fresh status read leaves no usable old preview", async () => {
  const f = fixture("SettingsView", { role: "OWNER" }); await open(f); fill(f);
  f.overrides.apiRequest = () => { throw { status: 409, code: "RESET_PREVIEW_CHANGED" }; };
  await submit(f); await f.flush();
  fill(f);
  assert.equal(f.button("operations.reset.retrySame", dialog(f)).props.disabled, true);
  await submit(f);
  assert.equal(posts(f).length, 1);
  f.overrides.apiRequest = () => { throw { status: 503, code: "SERVER_ERROR" }; };
  await f.button("operations.reset.refreshPreview", dialog(f)).props.onClick(); await f.flush();
  assert.equal(form(f), undefined);
  assert.equal(previews(f).length, 1);
  assert.equal(posts(f).length, 1);
});

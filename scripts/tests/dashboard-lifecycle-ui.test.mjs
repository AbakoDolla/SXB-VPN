import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fixture, client, device, subscription, OLD_CODE, NEW_CODE, deferred, nodes, text, plain,
} from "./fixtures/dashboard-lifecycle-ui.mjs";

const dialog = f => nodes(f.render()).find(node => node.props.role === "dialog");
const form = (f, tree = dialog(f) ?? f.render()) => nodes(tree).find(node => node.type === "form");
const submit = (f, tree) => form(f, tree).props.onSubmit({ preventDefault() {} });
const mutations = f => f.calls.filter(([name]) => !name.startsWith("fetch"));

test("device renewal chooses days, excludes overlapping requests and shows/copies only the returned code", async () => {
  const f = fixture();
  await f.flush();
  const oldSuspend = f.button("commerce.devices.suspendDevice");
  f.button("commerce.devices.renewDevice").props.onClick();
  assert.ok(!text(dialog(f)).includes(OLD_CODE));
  nodes(dialog(f)).find(node => node.type === "input").props.onChange({ target: { value: "90" } });
  const request = deferred();
  f.overrides.renewDevice = () => request.promise;
  const savedForm = form(f);
  const running = savedForm.props.onSubmit({ preventDefault() {} });
  await savedForm.props.onSubmit({ preventDefault() {} });
  await oldSuspend.props.onClick();
  assert.deepEqual(mutations(f), [["renewDevice", "device-1", 90]]);
  assert.equal(f.button("commerce.devices.disableDevice").props.disabled, true);
  assert.equal(f.button("commerce.common.close", dialog(f)).props.disabled, true);
  assert.equal(nodes(dialog(f)).find(node => node.type === "input").props.disabled, true);
  assert.ok(!text(dialog(f)).includes(NEW_CODE));
  const renewed = { ...device, token: NEW_CODE, expireAt: "2028-04-14T12:00:00.000Z" };
  f.data.devices = [renewed];
  request.resolve(renewed);
  await running; await f.flush();
  assert.ok(text(dialog(f)).includes(NEW_CODE));
  assert.ok(!text(dialog(f)).includes(OLD_CODE));
  assert.ok(!form(f));
  const copy = deferred();
  f.setClipboard(value => { assert.equal(value, NEW_CODE); return copy.promise; });
  const copying = f.button("commerce.devices.copyToken", dialog(f)).props.onClick();
  assert.equal(f.button("commerce.common.copied", dialog(f)), undefined);
  copy.resolve(); await copying;
  assert.ok(f.button("commerce.common.copied", dialog(f)));
  f.setLanguage("en");
  assert.ok(text(dialog(f)).includes(f.t("commerce.devices.renewalComplete")));
  assert.ok(text(dialog(f)).includes(NEW_CODE));
  f.button("commerce.common.close", dialog(f)).props.onClick();
  f.render();
  f.button("commerce.devices.renewDevice").props.onClick();
  assert.ok(form(f));
  assert.ok(!text(dialog(f)).includes(NEW_CODE));
  assert.equal(f.button("commerce.common.copied", dialog(f)), undefined);
  assert.deepEqual(f.logs, []);
});

test("a failed renewal keeps duration and translated error, clears pending, and never exposes a success code", async () => {
  const f = fixture();
  await f.flush();
  f.button("commerce.devices.renewDevice").props.onClick();
  nodes(dialog(f)).find(node => node.type === "input").props.onChange({ target: { value: "180" } });
  f.overrides.renewDevice = async () => { throw { status: 403, code: "DEVICE_EXPIRED", responseData: { code: "DEVICE_EXPIRED", error: "errors.auth.forbidden" } }; };
  await submit(f);
  assert.ok(text(dialog(f)).includes(f.t("errors.device.expired")));
  assert.equal(nodes(dialog(f)).find(node => node.type === "input").props.value, 180);
  assert.equal(f.button("commerce.devices.confirmRenewal", dialog(f)).props.disabled, false);
  assert.ok(!text(dialog(f)).includes(NEW_CODE));
  assert.equal(f.button("commerce.devices.copyToken", dialog(f)), undefined);
  f.setLanguage("en");
  assert.ok(text(dialog(f)).includes(f.t("errors.device.expired")));
  delete f.overrides.renewDevice;
  await submit(f);
  assert.ok(text(dialog(f)).includes(NEW_CODE));
  assert.equal(mutations(f).length, 2);
});

test("an accepted renewal with a missing or unchanged code is not displayed as success or offered twice", async () => {
  for (const response of [{ ...device }, { id: device.id, expireAt: device.expireAt }]) {
    const f = fixture(); await f.flush();
    f.overrides.renewDevice = async () => response;
    f.button("commerce.devices.renewDevice").props.onClick();
    const saved = form(f);
    await submit(f);
    assert.ok(text(dialog(f)).includes(f.t("commerce.devices.renewalResponseInvalid")));
    assert.equal(form(f), undefined);
    assert.equal(f.button("commerce.devices.copyToken", dialog(f)), undefined);
    await saved.props.onSubmit({ preventDefault() {} });
    assert.equal(mutations(f).length, 1);
  }
});

test("renewal duration is a positive bounded integer and invalid values never reach the API", async () => {
  const f = fixture(); await f.flush();
  f.button("commerce.devices.renewDevice").props.onClick();
  for (const value of ["0", "-1", "2.5", "3651", "Infinity"]) {
    nodes(dialog(f)).find(node => node.type === "input").props.onChange({ target: { value } });
    await submit(f);
    assert.ok(text(dialog(f)).includes(f.t("commerce.devices.invalidDuration")));
  }
  assert.deepEqual(mutations(f), []);
});

test("clipboard rejection does not claim success and copy state resets after closing the result", async () => {
  const f = fixture(); await f.flush();
  f.button("commerce.devices.renewDevice").props.onClick();
  await submit(f);
  f.setClipboard(async () => { throw new Error("fixture clipboard unavailable"); });
  await f.button("commerce.devices.copyToken", dialog(f)).props.onClick();
  assert.equal(f.button("commerce.common.copied", dialog(f)), undefined);
  assert.equal(text(f.expand(f.toasts.at(-1).value)), f.t("commerce.common.copyFailed"));
  f.button("commerce.common.close", dialog(f)).props.onClick();
  assert.equal(dialog(f), undefined);
});

test("temporary device actions use distinct endpoints and confirmations without rotating or extending access", async () => {
  const f = fixture(); await f.flush();
  const original = plain(f.data.devices[0]);
  await f.button("commerce.devices.suspendDevice").props.onClick();
  assert.equal(f.data.devices[0].status, "suspended");
  assert.ok(text(f.render()).includes(f.t("commerce.common.suspended")));
  assert.ok(f.confirmations.at(-1).includes(f.t("commerce.devices.confirmSuspend", { name: device.label })));
  await f.button("commerce.devices.resumeDevice").props.onClick();
  assert.equal(f.data.devices[0].status, "active");
  await f.button("commerce.devices.disableDevice").props.onClick();
  assert.equal(f.data.devices[0].status, "disabled");
  assert.ok(text(f.render()).includes(f.t("commerce.common.disabled")));
  assert.equal(f.data.devices[0].token, original.token);
  assert.equal(f.data.devices[0].expireAt, original.expireAt);
  assert.equal(f.data.devices[0].activatedAt, original.activatedAt);
  assert.deepEqual(mutations(f).map(([name]) => name), ["suspendDevice", "resumeDevice", "revokeDevice"]);
  assert.ok(!text(f.expand(f.toasts.at(-1).value)).includes(f.t("commerce.common.revoked")));
  f.setConfirm(() => false);
  await f.button("commerce.devices.resumeDevice").props.onClick();
  assert.equal(mutations(f).length, 3);
});

test("device badges keep plan expiry/exhaustion separate; expired access cannot resume", async () => {
  const f = fixture("DevicesView", { data: { devices: [{
    ...device, subscriptionStatus: "exhausted", quotaUsed: device.quotaTotal,
    subscriptionExpireAt: "2025-01-01T00:00:00.000Z",
  }] } });
  await f.flush();
  assert.equal(f.button("commerce.devices.suspendDevice").props.disabled, false);
  assert.ok(text(f.render()).includes(f.t("commerce.devices.planState", { status: f.t("commerce.common.expired") })));
  const d = fixture("DevicesView", { data: { devices: [{ ...device, status: "disabled", expireAt: "2020-01-01T00:00:00.000Z" }] } });
  await d.flush();
  assert.equal(d.button("commerce.devices.resumeDevice").props.disabled, true);
  assert.equal(d.button("commerce.devices.renewDevice").props.disabled, false);
});

test("client renewal uses only the existing 30-day API and reset displays its distinct returned code", async () => {
  const f = fixture("ClientsView"); await f.flush();
  f.button("commerce.clients.renewDevice").props.onClick();
  assert.equal(nodes(dialog(f)).filter(node => node.type === "input").length, 0);
  assert.ok(text(dialog(f)).includes(f.t("commerce.common.days", { count: "30" })));
  await submit(f);
  assert.deepEqual(mutations(f), [["renewClient", "client-1"]]);
  assert.ok(text(dialog(f)).includes(NEW_CODE));
  f.button("commerce.common.close", dialog(f)).props.onClick();
  const previousExpiry = f.data.clients[0].expireAt;
  const replacement = "SXB-USER-DEMO-RESET-003";
  f.overrides.resetClientAccess = async () => {
    Object.assign(f.data.clients[0], { token: replacement });
    return plain(f.data.clients[0]);
  };
  await f.button("commerce.clients.resetAccess").props.onClick();
  assert.ok(text(dialog(f)).includes(replacement));
  assert.ok(text(dialog(f)).includes(f.t("commerce.clients.resetNoRenewal")));
  assert.equal(f.data.clients[0].expireAt, previousExpiry);
  assert.equal(f.data.clients[0].activatedAt, client.activatedAt);
  assert.deepEqual(mutations(f).map(([name]) => name), ["renewClient", "resetClientAccess"]);
});

test("client status filters include disabled and revoked without mislabelling them expired", async () => {
  const f = fixture("ClientsView", { data: { clients: [
    { ...client, status: "disabled" }, { ...client, id: "client-2", status: "revoked" },
  ] } });
  await f.flush();
  f.button("commerce.common.disabled").props.onClick();
  await f.flush();
  assert.equal(nodes(f.render()).filter(node => node.type === "tbody")[0].children.length, 1);
  assert.equal(f.button("commerce.devices.resumeDevice").props.disabled, false);
  f.button("commerce.common.revoked").props.onClick(); await f.flush();
  assert.equal(f.button("commerce.devices.resumeUnavailable").props.disabled, true);
});

test("SUPPORT stays read-only even with generous permission data in all three views", async () => {
  for (const view of ["DevicesView", "ClientsView", "SubscriptionsView"]) {
    const f = fixture(view, { role: "SUPPORT" }); await f.flush();
    const buttons = nodes(f.render()).filter(node => node.type === "button" && !node.props.disabled);
    for (const key of ["commerce.devices.renewDevice", "commerce.devices.disableDevice", "commerce.clients.renewDevice", "commerce.subscriptions.extendPlan"]) {
      assert.ok(!buttons.some(button => button.props.title === f.t(key)));
    }
    assert.ok(!text(f.render()).includes(OLD_CODE));
    assert.deepEqual(mutations(f), []);
  }
});

test("upper roles do not bypass missing permissions and client action gates match server permissions", async () => {
  for (const role of ["ADMIN", "SUPER_ADMIN"]) {
    const f = fixture("DevicesView", { role, permissions: ["clients.view"] }); await f.flush();
    assert.equal(f.button("commerce.devices.renewDevice").props.disabled, true);
    assert.equal(f.button("commerce.devices.disableDevice").props.disabled, true);
    await f.button("commerce.devices.disableDevice").props.onClick();
    assert.deepEqual(mutations(f), []);
    assert.equal(f.calls.some(([name]) => name === "fetchResellers"), false);
  }
  const f = fixture("ClientsView", { permissions: ["clients.view", "clients.manage"] }); await f.flush();
  assert.equal(f.button("commerce.devices.suspendDevice").props.disabled, false);
  assert.equal(f.button("commerce.clients.renewDevice").props.disabled, true);
  assert.equal(f.button("commerce.clients.resetAccess").props.disabled, true);
  assert.equal(f.button("commerce.clients.deleteClient").props.disabled, true);
  const owner = fixture("DevicesView", { role: "OWNER", permissions: [] }); await owner.flush();
  assert.equal(owner.button("commerce.devices.renewDevice").props.disabled, false);
});

test("reseller ceiling permits reductions but not resume, renewal or data growth; expired authorization blocks writes", async () => {
  const access = { accessState: "active", quotaState: "reached", quotaBytes: "0", quotaAllocatedBytes: "0" };
  const f = fixture("DevicesView", { role: "RESELLER", access }); await f.flush();
  assert.equal(f.button("commerce.devices.suspendDevice").props.disabled, false);
  assert.equal(f.button("commerce.devices.disableDevice").props.disabled, false);
  assert.equal(f.button("commerce.devices.renewDevice").props.disabled, true);
  await f.button("commerce.devices.suspendDevice").props.onClick();
  assert.equal(f.button("commerce.devices.resumeDevice").props.disabled, true);
  assert.equal(f.calls.some(([name]) => name === "fetchResellers"), false);
  const s = fixture("SubscriptionsView", { role: "RESELLER", access }); await s.flush();
  assert.equal(s.button("commerce.subscriptions.suspendPlan").props.disabled, false);
  assert.equal(s.button("commerce.subscriptions.revokePlan").props.disabled, false);
  assert.equal(s.button("commerce.subscriptions.extendPlan").props.disabled, true);
  assert.equal(s.button("commerce.subscriptions.addData").props.disabled, true);
  assert.ok(s.calls.some(([name]) => name === "fetchAssignedVpnProfiles"));
  assert.ok(!s.calls.some(([name]) => name === "fetchVpnProfiles"));
  f.setAccess({ ...access, accessState: "expired" });
  assert.equal(f.button("commerce.devices.disableDevice").props.disabled, true);
});

test("tenant creation omits reseller overrides and never assigns a plan or individual quota automatically", async () => {
  for (const [view, buttonKey, apiName] of [
    ["ClientsView", "commerce.clients.add", "createClient"],
    ["DevicesView", "commerce.devices.generate", "generateDeviceToken"],
  ]) {
    const f = fixture(view, { role: "RESELLER" }); await f.flush();
    f.button(buttonKey).props.onClick();
    const input = nodes(form(f)).find(node => node.type === "input" && node.props.required);
    input.props.onChange({ target: { value: "Fixture new account" } });
    await submit(f);
    const write = mutations(f);
    assert.equal(write.length, 1);
    assert.equal(write[0][0], apiName);
    assert.equal(write[0][1].resellerId, undefined);
    assert.equal(write[0][1].quotaGB, undefined);
    assert.equal(write[0][1].profileId, undefined);
  }
});

test("single-plan add-data and extend send disjoint bulk payloads without creating activation codes", async () => {
  for (const [key, action, field, value] of [
    ["commerce.subscriptions.addData", "add_data", "quotaGB", 2.5],
    ["commerce.subscriptions.extendPlan", "extend_duration", "durationDays", 90],
  ]) {
    const f = fixture("SubscriptionsView"); await f.flush();
    f.button(key).props.onClick();
    assert.ok(text(dialog(f)).includes(f.t("commerce.subscriptions.keepActivation")));
    nodes(dialog(f)).find(node => node.type === "input").props.onChange({ target: { value: String(value) } });
    await submit(f);
    assert.deepEqual(mutations(f), [["bulkSubscriptions", { action, subscriptionIds: ["plan-1"], [field]: value }]]);
    assert.equal(dialog(f), undefined);
    assert.equal(f.data.clients[0].token, OLD_CODE);
    assert.equal(f.data.clients[0].expireAt, client.expireAt);
  }
});

test("single-plan failure and partial failure reset pending without claiming success or clearing the form", async () => {
  const f = fixture("SubscriptionsView"); await f.flush();
  f.button("commerce.subscriptions.addData").props.onClick();
  const waiting = deferred();
  f.overrides.bulkSubscriptions = () => waiting.promise;
  const saved = form(f);
  const running = submit(f);
  await saved.props.onSubmit({ preventDefault() {} });
  assert.equal(mutations(f).length, 1);
  assert.equal(f.button("commerce.common.cancel", dialog(f)).props.disabled, true);
  assert.equal(f.button("commerce.subscriptions.extendPlan").props.disabled, true);
  waiting.resolve({ selected: 1, succeeded: 0, failed: 1, skipped: 0, details: [{ id: "plan-1", status: "failed", reason: "OWNERSHIP_FORBIDDEN" }] });
  await running;
  assert.ok(dialog(f));
  assert.ok(text(dialog(f)).includes(f.t("errors.resellers.ownership_forbidden")));
  assert.equal(f.button("commerce.common.confirm", dialog(f)).props.disabled, false);
  assert.equal(f.toasts.some(toast => toast.kind === "success"), false);
  delete f.overrides.bulkSubscriptions;
  await submit(f);
  assert.equal(dialog(f), undefined);
});

test("plan editing sends only changed fields instead of silently resetting expiry or data", async () => {
  const f = fixture("SubscriptionsView"); await f.flush();
  f.button("commerce.subscriptions.edit").props.onClick();
  nodes(form(f)).find(node => node.type === "input" && node.props.value === subscription.name)
    .props.onChange({ target: { value: "Renamed fixture plan" } });
  await submit(f);
  assert.deepEqual(mutations(f), [["updateSubscription", "plan-1", { name: "Renamed fixture plan" }]]);
  assert.equal(f.data.subscriptions[0].expireAt, subscription.expireAt);
  assert.equal(f.data.subscriptions[0].quotaBytes, subscription.quotaBytes);
});

test("plan revoke/delete confirmations affect only the profile and never call global device actions", async () => {
  for (const [key, method, confirmation] of [
    ["commerce.subscriptions.revokePlan", "revokeSubscription", "commerce.subscriptions.confirmRevoke"],
    ["commerce.subscriptions.deletePlan", "deleteSubscription", "commerce.subscriptions.confirmDelete"],
  ]) {
    const f = fixture("SubscriptionsView"); await f.flush();
    await f.button(key).props.onClick();
    assert.deepEqual(mutations(f), [[method, "plan-1"]]);
    assert.equal(f.confirmations.at(-1), f.t(confirmation, { name: subscription.name }));
    assert.equal(f.data.clients[0].token, OLD_CODE);
    assert.equal(f.data.clients[0].status, "active");
  }
});

test("an exhausted or expired plan is labelled as a plan issue and cannot resume without correcting its allowance", async () => {
  const f = fixture("SubscriptionsView", { data: { subscriptions: [{ ...subscription, quotaUsed: subscription.quotaBytes }] } });
  await f.flush();
  assert.ok(text(nodes(f.render()).find(node => node.type === "tbody")).includes(f.t("commerce.subscriptions.exhausted")));
  const s = fixture("SubscriptionsView", { data: { subscriptions: [{ ...subscription, status: "suspended", expireAt: "2020-01-01T00:00:00Z", quotaUsed: subscription.quotaBytes }] } });
  await s.flush();
  assert.equal(s.button("commerce.subscriptions.resumeUnavailable").props.disabled, true);
  assert.ok(text(s.render()).includes(s.t("commerce.subscriptions.needsExtension")));
  assert.ok(text(s.render()).includes(s.t("commerce.subscriptions.needsData")));
});

test("a zero-rated plan is not exhausted and can resume, unlike a reseller with a zero capacity ceiling", async () => {
  const f = fixture("SubscriptionsView", { data: { subscriptions: [{ ...subscription, status: "suspended", quotaBytes: "0", quotaUsed: "0" }] } });
  await f.flush();
  const table = nodes(f.render()).find(node => node.type === "tbody");
  assert.ok(!text(table).includes(f.t("commerce.subscriptions.exhausted")));
  assert.ok(!text(table).includes(f.t("commerce.subscriptions.needsData")));
  assert.equal(f.button("commerce.subscriptions.resumePlan").props.disabled, false);
  await f.button("commerce.subscriptions.resumePlan").props.onClick();
  assert.deepEqual(mutations(f), [["updateSubscription", "plan-1", { status: "active" }]]);
  f.setRole("RESELLER");
  f.setAccess({ accessState: "active", quotaState: "reached", quotaBytes: "0", quotaAllocatedBytes: "0" });
  assert.equal(f.button("commerce.subscriptions.extendPlan").props.disabled, true);
});

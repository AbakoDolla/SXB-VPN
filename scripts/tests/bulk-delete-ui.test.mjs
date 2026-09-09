import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, client, subscription, deferred, nodes, text, plain } from "./fixtures/dashboard-lifecycle-ui.mjs";

const profile = {
  id: "profile-1", name: "Fixture profile", status: "active", protocol: "vless",
  offlineValidDays: 7, createdAt: "2026-09-09T06:00:00Z", _count: { subscriptions: 0 },
};
const account = { id: "account-1", name: "Fixture support", email: "support@example.test", role: "SUPPORT", status: "active", permissions: [] };
const variants = [
  ["ClientsView", "clients", client, "deleteClient", "commerce.common.search", 45],
  ["VpnProfilesView", "profiles", profile, "deleteVpnProfile", "configurations.ui.search", 65],
  ["AccountsView", "accounts", account, "deleteAccount", "commerce.accounts.search", 45],
  ["SubscriptionsView", "subscriptions", subscription, "deleteSubscription", "commerce.subscriptions.search", 45],
];
const rows = (sample, count) => Array.from({ length: count }, (_, index) => ({
  ...plain(sample), id: `${sample.id}-${index}`, name: `Target ${index}`,
  ...(sample.user ? { user: { ...sample.user, name: `Target ${index}` } } : {}),
}));
const dialog = f => nodes(f.render()).find(node => node.props["aria-labelledby"] === "bulk-delete-title");
const deletes = f => f.calls.filter(([name]) => String(name).startsWith("delete"));
const rowCheckboxes = f => nodes(f.render()).filter(node => node.type === "input" && node.props.type === "checkbox"
  && node.props["aria-label"] !== f.t("commerce.subscriptions.selectPage"));
const selectAll = (f, count) => f.button("operations.bulkDelete.selectAll", f.render(), { count }).props.onClick();
const confirmSelection = (f, count) => f.button("operations.bulkDelete.deleteSelected", f.render(), { count }).props.onClick();
const execute = (f, count) => f.button("operations.bulkDelete.confirmDelete", dialog(f), { count }).props.onClick();
function replaceCache(f, id, updater) {
  const slot = [...f.states.values()].flat().find(slot => Array.isArray(slot?.value) && slot.value.some(row => row?.id === id));
  assert.ok(slot, `Missing cached row ${id}`);
  slot.value = updater(slot.value);
}
function removeFixtureRow(f, kind, id) {
  f.data[kind] = f.data[kind].filter(row => row.id !== id);
}
function setSearch(f, key, value) {
  nodes(f.render()).find(node => node.type === "input" && node.props.placeholder === f.t(key)).props.onChange({ target: { value } });
}
async function unlock(f, name) {
  const card = nodes(f.render()).find(node => node.type === "div" && node.key && node.children.some?.(child => text(child).includes(name))
    && nodes(node).some(child => child.type === "button" && text(child) === f.t("configurations.lock.open")));
  assert.ok(card, `Missing locked card ${name}`);
  f.button("configurations.lock.open", [card]).props.onClick();
  const lockDialog = () => nodes(f.render()).find(node => node.props["aria-labelledby"] === "profile-lock-title");
  nodes(lockDialog()).find(node => node.type === "input").props.onChange({ target: { value: "fixture-profile-password" } });
  await lockDialog().props.onSubmit({ preventDefault() {} });
  await f.flush();
}

for (const [view, kind, sample, apiMethod, searchKey, count] of variants) {
  test(`${view}: select all means the entire loaded filter across pages; only true successes disappear`, async () => {
    const targetRows = rows(sample, count);
    const ignored = { ...plain(sample), id: "ignored", name: "Ignore", ...(sample.user ? { user: { ...sample.user, name: "Ignore" } } : {}) };
    const f = fixture(view, { role: "OWNER", data: { [kind]: [...targetRows, ignored] } });
    await f.flush();
    setSearch(f, searchKey, "Target"); await f.flush();
    selectAll(f, count);
    assert.ok(rowCheckboxes(f).every(node => node.props.checked));
    f.button("core.pagination.next").props.onClick();
    assert.ok(rowCheckboxes(f).length > 0 && rowCheckboxes(f).every(node => node.props.checked));
    assert.equal(deletes(f).length, 0);
    confirmSelection(f, count);
    assert.ok(text(dialog(f)).includes(f.t("operations.bulkDelete.confirmScope", { count, total: count })));
    assert.ok(text(dialog(f)).includes(targetRows.at(-1).name));
    const failedId = targetRows[2].id;
    f.overrides[apiMethod] = async id => {
      if (id === failedId) throw { status: 409, responseData: { error: "errors.conflict" } };
      removeFixtureRow(f, kind, id);
    };
    await execute(f, count); await f.flush();
    assert.equal(deletes(f).length, count);
    assert.equal(new Set(deletes(f).map(call => call[1])).size, count);
    assert.equal(deletes(f).some(call => call[1] === "ignored"), false);
    assert.equal(dialog(f), undefined);
    assert.ok(text(f.render()).includes(f.t("operations.bulkDelete.result", { succeeded: count - 1, failed: 1 })));
    assert.ok(text(f.render()).includes(f.t("errors.conflict")));
    assert.equal(rowCheckboxes(f).length, 1);
    assert.equal(rowCheckboxes(f)[0].props.checked, true);
    assert.deepEqual(f.data[kind].map(row => row.id), [failedId, "ignored"]);
    f.setLanguage("en"); await f.flush();
    assert.ok(text(f.render()).includes(f.t("operations.bulkDelete.failedRetained")));
    assert.ok(text(f.render()).includes(f.t("errors.conflict")));
    assert.equal(deletes(f).length, count);
  });
}

test("pending deletion prevents duplicate submits, modal closure, selection edits and overlapping individual actions", async () => {
  const original = rows(client, 3);
  const confirmedIds = original.map(row => row.id);
  const f = fixture("ClientsView", { data: { clients: original } }); await f.flush();
  const singleDelete = f.button("commerce.clients.deleteClient");
  const oldRow = rowCheckboxes(f)[0];
  selectAll(f, 3); confirmSelection(f, 3);
  const button = f.button("operations.bulkDelete.confirmDelete", dialog(f), { count: 3 });
  const cancel = f.button("operations.common.cancel", dialog(f));
  const request = deferred();
  f.overrides.deleteClient = async id => {
    if (id === original[0].id) await request.promise;
    removeFixtureRow(f, "clients", id);
  };
  const running = button.props.onClick();
  await button.props.onClick();
  cancel.props.onClick();
  oldRow.props.onChange();
  await singleDelete.props.onClick();
  assert.equal(deletes(f).length, 1);
  assert.ok(dialog(f));
  assert.equal(f.button("operations.common.cancel", dialog(f)).props.disabled, true);
  assert.ok(rowCheckboxes(f).every(node => node.props.disabled));
  const late = { ...plain(client), id: "late-row", user: { name: "New arrival" } };
  f.data.clients.push(late);
  replaceCache(f, original[0].id, values => [...values, late]);
  assert.equal(rowCheckboxes(f).at(-1).props.checked, false);
  request.resolve();
  await running; await f.flush();
  assert.deepEqual(deletes(f).map(call => call[1]), confirmedIds);
  assert.equal(rowCheckboxes(f).length, 1);
  assert.equal(rowCheckboxes(f)[0].props.checked, false);
  assert.ok(text(f.render()).includes(f.t("operations.bulkDelete.result", { succeeded: 3, failed: 0 })));
});

test("selection is explicit, stable after closing confirmation, and cleared when the filter changes", async () => {
  const f = fixture("ClientsView", { data: { clients: rows(client, 25) } }); await f.flush();
  selectAll(f, 25); confirmSelection(f, 25);
  f.button("operations.common.cancel", dialog(f)).props.onClick();
  assert.equal(dialog(f), undefined);
  assert.ok(rowCheckboxes(f).every(node => node.props.checked));
  setSearch(f, "commerce.common.search", "Target 2"); await f.flush();
  assert.ok(rowCheckboxes(f).every(node => !node.props.checked));
  assert.equal(deletes(f).length, 0);
});

test("more than 100 filtered records stay fully selected, with an explicit blocking limit and no silent truncation", async () => {
  const f = fixture("AccountsView", { role: "OWNER", data: { accounts: rows(account, 112) } }); await f.flush();
  selectAll(f, 112);
  assert.ok(text(f.render()).includes(f.t("operations.bulkDelete.selection", { selected: 112, total: 112 })));
  const button = f.button("operations.bulkDelete.deleteSelected", f.render(), { count: 112 });
  assert.equal(button.props.disabled, true);
  assert.ok(text(f.render()).includes(f.t("operations.bulkDelete.limit", { count: 112, limit: 100 })));
  button.props.onClick();
  assert.equal(dialog(f), undefined);
  assert.equal(deletes(f).length, 0);
});

test("VPN configuration rendering is capped at 50 per page without NaN or a page-only select-all", async () => {
  const f = fixture("VpnProfilesView", { data: { profiles: rows(profile, 80) } }); await f.flush();
  assert.equal(rowCheckboxes(f).length, 50);
  assert.ok(text(f.render()).includes(f.t("operations.bulkDelete.profilePage", { count: 80, limit: 50 })));
  const pageSize = nodes(f.render()).find(node => node.type === "select" && node.props["aria-label"] === f.t("core.pagination.pageSize"));
  assert.deepEqual(nodes(pageSize).filter(node => node.type === "option").map(node => node.props.value), [10, 20, 50]);
  for (const value of ["NaN", "0", "100", "Infinity", "-10"]) pageSize.props.onChange({ target: { value } });
  assert.equal(rowCheckboxes(f).length, 50);
  assert.ok(!text(f.render()).includes("NaN"));
  selectAll(f, 80);
  f.button("core.pagination.next").props.onClick();
  assert.equal(rowCheckboxes(f).length, 30);
  assert.ok(rowCheckboxes(f).every(node => node.props.checked));
});

test("bulk account deletion excludes OWNER, ADMIN, SUPER_ADMIN and self even for the owner", async () => {
  const accounts = ["OWNER", "ADMIN", "SUPER_ADMIN", "RESELLER", "SUPPORT"].map(role => ({
    ...account, id: role, name: role, role,
  }));
  accounts.push({ ...account, id: "operator-1", role: "SUPPORT", name: "Self" });
  for (const role of ["OWNER", "SUPER_ADMIN", "ADMIN"]) {
    const f = fixture("AccountsView", { role, data: { accounts: plain(accounts) } }); await f.flush();
    for (const checkbox of rowCheckboxes(f).filter(node => node.props.disabled)) checkbox.props.onChange();
    selectAll(f, 2);
    assert.deepEqual(rowCheckboxes(f).filter(node => node.props.checked).map(node => node.props["aria-label"]), [
      f.t("operations.bulkDelete.selectOne", { name: "RESELLER" }), f.t("operations.bulkDelete.selectOne", { name: "SUPPORT" }),
    ]);
    confirmSelection(f, 2); await execute(f, 2); await f.flush();
    assert.deepEqual(deletes(f).map(call => call[1]), ["RESELLER", "SUPPORT"]);
    assert.ok(text(f.render()).includes(f.t("commerce.accounts.you")));
    assert.deepEqual(f.data.accounts.map(row => row.id), ["OWNER", "ADMIN", "SUPER_ADMIN", "operator-1"]);
  }
});

test("support and reseller accounts cannot bulk-delete logins or global configurations regardless of permission data", async () => {
  for (const role of ["SUPPORT", "RESELLER"]) for (const view of ["AccountsView", "VpnProfilesView"]) {
    const f = fixture(view, { role }); await f.flush();
    assert.equal(nodes(f.render()).some(node => node.type === "button" && text(node).includes(f.t("operations.bulkDelete.selectAll", { count: 1 }))), false);
    assert.equal(deletes(f).length, 0);
  }
  for (const view of ["ClientsView", "SubscriptionsView"]) {
    const f = fixture(view, { role: "SUPPORT" }); await f.flush();
    assert.equal(f.button("operations.bulkDelete.deleteSelected", f.render(), { count: 0 }), undefined);
    assert.equal(deletes(f).length, 0);
  }
});

test("missing permissions are not bypassed by ADMIN or SUPER_ADMIN, and permission changes stop a running batch", async () => {
  for (const role of ["ADMIN", "SUPER_ADMIN"]) for (const view of ["AccountsView", "VpnProfilesView", "ClientsView"]) {
    const f = fixture(view, { role, permissions: [] }); await f.flush();
    assert.ok(rowCheckboxes(f).every(node => node.props.disabled));
    assert.equal(deletes(f).length, 0);
  }
  const f = fixture("AccountsView", { role: "ADMIN", data: { accounts: rows(account, 2) } }); await f.flush();
  const request = deferred();
  f.overrides.deleteAccount = async id => { await request.promise; removeFixtureRow(f, "accounts", id); };
  selectAll(f, 2); confirmSelection(f, 2);
  const running = execute(f, 2);
  f.setPermissions([]); await f.flush();
  request.resolve(); await running; await f.flush();
  assert.equal(deletes(f).length, 1);
  assert.ok(text(f.render()).includes(f.t("operations.bulkDelete.result", { succeeded: 1, failed: 1 })));
});

test("reseller selection is restricted to its current tenant; quota ceiling still allows deletions and expired access does not", async () => {
  const access = { resellerId: "reseller-1", accessState: "active", quotaState: "reached", quotaBytes: "0", quotaAllocatedBytes: "0" };
  for (const [view, kind, sample, method] of [variants[0], variants[3]]) {
    const owned = { ...plain(sample), id: "owned", resellerId: "reseller-1" };
    const foreign = { ...plain(sample), id: "foreign", resellerId: "reseller-2" };
    const missing = { ...plain(sample), id: "missing", resellerId: null, client: undefined, user: undefined };
    const f = fixture(view, { role: "RESELLER", access, data: { [kind]: [owned, foreign, missing], clients: view === "ClientsView" ? [owned, foreign, missing] : [] } });
    await f.flush();
    selectAll(f, 1);
    assert.equal(rowCheckboxes(f).filter(node => node.props.checked).length, 1);
    confirmSelection(f, 1); await execute(f, 1); await f.flush();
    assert.deepEqual(deletes(f).map(call => [call[0], call[1]]), [[method, "owned"]]);
    f.setAccess({ ...access, accessState: "expired" }); await f.flush();
    assert.equal(f.button("operations.bulkDelete.deleteSelected", f.render(), { count: 0 }).props.disabled, true);
  }
});

test("ownership changes during a batch are rechecked before the next DELETE", async () => {
  const records = rows(client, 2);
  const f = fixture("ClientsView", { role: "RESELLER", data: { clients: records } }); await f.flush();
  const request = deferred();
  f.overrides.deleteClient = async id => { await request.promise; removeFixtureRow(f, "clients", id); };
  selectAll(f, 2); confirmSelection(f, 2);
  const running = execute(f, 2);
  replaceCache(f, records[0].id, values => values.map(row => row.id === records[1].id ? { ...row, resellerId: "other-tenant" } : row));
  await f.flush();
  request.resolve(); await running; await f.flush();
  assert.deepEqual(deletes(f).map(call => call[1]), [records[0].id]);
  assert.ok(text(f.render()).includes(f.t("operations.bulkDelete.result", { succeeded: 1, failed: 1 })));
});

test("locked profiles can be selected but never deleted without their own current grant, including OWNER", async () => {
  const locked = { ...profile, id: "locked", name: "Locked profile", hasLock: true, isLocked: true, host: "private-host.invalid" };
  const linked = { ...profile, id: "linked", name: "Linked plan", _count: { subscriptions: 1 } };
  const f = fixture("VpnProfilesView", { role: "OWNER", data: { profiles: [profile, locked, linked] } }); await f.flush();
  selectAll(f, 3); confirmSelection(f, 3);
  await execute(f, 3); await f.flush();
  assert.deepEqual(deletes(f).map(call => call[1]), [profile.id]);
  assert.ok(text(f.render()).includes(f.t("configurations.lock.errors.PROFILE_LOCKED")));
  assert.ok(text(f.render()).includes(f.t("errors.bulkDelete.profileInUse")));
  assert.ok(!text(f.render()).includes("private-host.invalid"));
  assert.equal(f.calls.some(([name]) => /suspendDevice|revokeDevice|revokeSubscription/.test(name)), false);
  await unlock(f, locked.name);
  const linkedCheckbox = rowCheckboxes(f).find(node => node.props["aria-label"] === f.t("operations.bulkDelete.selectOne", { name: linked.name }));
  linkedCheckbox.props.onChange();
  confirmSelection(f, 1); await execute(f, 1); await f.flush();
  assert.deepEqual(deletes(f).at(-1), ["deleteVpnProfile", "locked", "fixture-unlock-locked"]);
});

test("each profile uses its own proof and an engine-linked HTTP409 remains an explicit failure without cascade", async () => {
  const records = ["a", "b"].map(id => ({ ...profile, id, name: `Locked ${id}`, hasLock: true, isLocked: true }));
  const f = fixture("VpnProfilesView", { role: "OWNER", data: { profiles: records } }); await f.flush();
  for (const row of records) await unlock(f, row.name);
  f.overrides.deleteVpnProfile = async id => {
    if (id === "b") throw { status: 409, code: "PROFILE_ENGINE_LINKED", responseData: { code: "PROFILE_ENGINE_LINKED" } };
    removeFixtureRow(f, "profiles", id);
  };
  selectAll(f, 2); confirmSelection(f, 2); await execute(f, 2); await f.flush();
  assert.deepEqual(deletes(f), [["deleteVpnProfile", "a", "fixture-unlock-a"], ["deleteVpnProfile", "b", "fixture-unlock-b"]]);
  assert.ok(text(f.render()).includes(f.t("configurations.lock.errors.PROFILE_ENGINE_LINKED")));
  assert.equal(rowCheckboxes(f).length, 1);
  assert.equal(rowCheckboxes(f)[0].props.checked, true);
});

test("unlock expiry while a batch is pending prevents subsequent protected profile DELETEs", async () => {
  const records = ["a", "b"].map(id => ({ ...profile, id, name: `Locked ${id}`, hasLock: true, isLocked: true }));
  const f = fixture("VpnProfilesView", { role: "OWNER", data: { profiles: records } }); await f.flush();
  for (const row of records) await unlock(f, row.name);
  const request = deferred();
  f.overrides.deleteVpnProfile = async id => { await request.promise; removeFixtureRow(f, "profiles", id); };
  selectAll(f, 2); confirmSelection(f, 2);
  const running = execute(f, 2);
  f.advance(600_001); await f.flush();
  request.resolve(); await running; await f.flush();
  assert.deepEqual(deletes(f), [["deleteVpnProfile", "a", "fixture-unlock-a"]]);
  assert.ok(text(f.render()).includes(f.t("configurations.lock.errors.PROFILE_LOCKED")));
  assert.equal(rowCheckboxes(f)[0].props.checked, true);
});

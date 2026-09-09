import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { db, api, base, routes, createSub, row, ok, GO, tomorrow, yesterday, require } from "./reseller-http.test.mjs";

const jwt = require("jsonwebtoken");
const express = require("express");
const deviceId = "LIFECYCLE-ANDROID-ONE";
const headers = { "X-SXB-Device-ID": deviceId };
const empty = () => assert.equal(routes.accessStateHub.size, 0);
function bind(id = "c1", hardware = deviceId) {
  Object.assign(row("VpnClient", id), { deviceId: hardware, activatedAt: new Date("2025-01-01T00:00:00Z") });
}
function accessToken(extra = {}, secret = process.env.JWT_SECRET) {
  return jwt.sign({
    userId: "u1", clientId: "c1", deviceId, role: "CLIENT", email: "u1@example.test", ...extra,
  }, secret, { expiresIn: "15m" });
}
async function request(path, token = accessToken(), options = {}) {
  const { body, headers: customHeaders, ...init } = options;
  const response = await fetch(`${base}${path}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, ...headers, "Content-Type": "application/json", ...customHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
const state = (token, suffix = "") => request(`/mobile/access-state${suffix}`, token);
async function ticket() {
  const response = await request("/mobile/access-ticket", accessToken(), { method: "POST", body: {} });
  ok(response);
  return response.body;
}
async function waitForWaiters(count = 1) {
  const until = Date.now() + 1500;
  while (routes.accessStateHub.size !== count && Date.now() < until) await delay(5);
  assert.equal(routes.accessStateHub.size, count);
}

test("lifecycle: config revocation/deletion removes only that subscription and never the activated device", async () => {
  bind();
  const one = await createSub("r1", 2);
  const two = await createSub("r1", 2);
  ok(one, 201); ok(two, 201);
  const before = structuredClone(row("VpnClient", "c1"));
  const id = one.body.subscription.id;
  ok(await api("r1", "POST", `/subscriptions/${id}/revoke`, {}));
  const snapshot = await state();
  ok(snapshot);
  assert.equal(snapshot.body.device.status, "active");
  assert.equal(snapshot.body.device.activationRequired, false);
  assert.deepEqual(snapshot.body.subscriptions.map(s => [s.id, s.status]).sort(), [
    [id, "revoked"], [two.body.subscription.id, "active"],
  ].sort());
  const me = await request(`/mobile/me?subscriptionId=${id}`);
  ok(me);
  assert.equal(me.body.accountState.state, "no_package");
  assert.equal(me.body.accountState.device.status, "active");
  assert.equal(me.body.accountState.subscription.status, "revoked");
  for (const endpoint of [`/mobile/vpn/config?subscriptionId=${id}`, `/provision/status/${id}`]) {
    const response = await request(endpoint);
    ok(response, 403);
    assert.equal(response.body.code, "CONFIG_REVOKED");
    assert.equal(response.body.scope, "subscription");
    assert.equal(response.body.subscriptionId, id);
    assert.equal(response.body.temporary, false);
  }
  const activate = await request("/provision/activate", accessToken(), { method: "POST", body: { dataToken: one.body.subscription.dataToken, deviceId } });
  ok(activate, 403); assert.equal(activate.body.code, "CONFIG_REVOKED");
  const sync = await request("/provision/sync", accessToken(), { method: "POST", body: { subscriptionId: id, deviceId, downloadBytes: 1 } });
  ok(sync, 403); assert.equal(sync.body.code, "CONFIG_REVOKED");
  ok(await api("r1", "DELETE", `/subscriptions/${id}`));
  const deleted = await request(`/mobile/vpn/config?subscriptionId=${id}`);
  ok(deleted, 404); assert.equal(deleted.body.code, "CONFIG_DELETED");
  assert.deepEqual((await state()).body.subscriptions.map(s => s.id), [two.body.subscription.id]);
  assert.deepEqual(row("VpnClient", "c1"), before);
});

test("lifecycle: snapshots are minimal, complete and content-versioned without secret or timestamp noise", async () => {
  bind();
  const sub = await createSub();
  ok(sub, 201);
  const first = await state();
  ok(first);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal(first.headers.get("x-accel-buffering"), "no");
  assert.deepEqual(Object.keys(first.body).sort(), ["device", "revision", "serverTime", "subscriptions"]);
  assert.deepEqual(Object.keys(first.body.device).sort(), ["activationRequired", "code", "expireAt", "id", "status"]);
  assert.deepEqual(Object.keys(first.body.subscriptions[0]).sort(), [
    "configHash", "configVersion", "expireAt", "id", "name", "quotaTotalBytes", "quotaUsedBytes", "status",
  ]);
  for (const secret of ["SXB-USER", "SXB-DATA", "password", "payload", "encrypted", "secret.invalid", "@example.test", "configKey"]) {
    assert.equal(JSON.stringify(first.body).includes(secret), false, `Leaked ${secret}`);
  }
  row("VpnClient", "c1").lastSeenAt = new Date();
  row("Subscription", sub.body.subscription.id).lastSyncAt = new Date();
  await delay(5);
  const second = await state();
  assert.equal(first.body.revision, second.body.revision);
  assert.notEqual(first.body.serverTime, second.body.serverTime);
  assert.equal(first.body.device.id, "c1");
  row("VpnProfile", "p1").configVersion = 2;
  assert.notEqual((await state()).body.revision, first.body.revision);
});

test("lifecycle: device suspend/disable/resume is reversible and leaves all subscription data unchanged", async () => {
  bind();
  ok(await createSub(), 201);
  const original = structuredClone(row("VpnClient", "c1"));
  const subscriptions = structuredClone(db.state.Subscription);
  const control = await ticket();
  for (const [action, status] of [["suspend", "suspended"], ["revoke", "disabled"]]) {
    const response = await api("r1", "POST", `/devices/c1/${action}`, {});
    ok(response);
    assert.equal(response.body.status, status);
    const snapshot = await state(control.ticket);
    ok(snapshot);
    assert.equal(snapshot.body.device.status, status);
    assert.equal(snapshot.body.device.activationRequired, false);
    assert.equal(snapshot.body.device.code, `DEVICE_${status.toUpperCase()}`);
    const denied = await request("/mobile/connections");
    ok(denied, 403);
    assert.equal(denied.body.scope, "device");
    assert.equal(denied.body.code, `DEVICE_${status.toUpperCase()}`);
    assert.equal(denied.body.temporary, true);
    const refreshed = await request("/mobile/auth/refresh", accessToken(), {
      method: "POST", body: { refreshToken: accessToken({}, process.env.REFRESH_SECRET) },
    });
    ok(refreshed);
    assert.equal(jwt.decode(refreshed.body.accessToken).role, "CLIENT");
    assert.deepEqual(jwt.decode(refreshed.body.accessToken).permissions, []);
    ok(await request("/mobile/connections", refreshed.body.accessToken), 403);
    ok(await state(refreshed.body.accessToken));
    ok(await api("r1", "POST", "/devices/c1/resume", {}));
    assert.deepEqual(db.state.Subscription, subscriptions);
    assert.equal(row("VpnClient", "c1").token, original.token);
    assert.equal(+row("VpnClient", "c1").expireAt, +original.expireAt);
    assert.equal(+row("VpnClient", "c1").activatedAt, +original.activatedAt);
  }
  row("VpnClient", "c1").expireAt = yesterday();
  for (const [method, path, body] of [
    ["POST", "/devices/c1/resume", {}], ["POST", "/clients/c1/activate", {}], ["PATCH", "/clients/c1", { status: "active" }],
  ]) {
    const response = await api("r1", method, path, body);
    ok(response, 409); assert.equal(response.body.code, "DEVICE_EXPIRED");
  }
  assert.deepEqual(db.state.Subscription, subscriptions);
});

test("lifecycle: renewal rotates a crypto code and extends the device only, retaining identity and exact sessions", async () => {
  bind();
  ok(await createSub(), 201);
  const before = structuredClone(row("VpnClient", "c1"));
  const subscriptions = structuredClone(db.state.Subscription);
  db.state.ActivationSession.push(
    { id: "right", clientId: "c1", deviceId, activationDate: before.activatedAt, expirationDate: before.expireAt, status: "suspended" },
    { id: "wrong", clientId: "c1", deviceId: "OLD-DEVICE", status: "revoked" },
  );
  db.state.AppRegistration.push(
    { id: "right-app", clientId: "c1", deviceId, status: "suspended" },
    { id: "wrong-app", clientId: "c1", deviceId: "OLD-DEVICE", status: "revoked" },
  );
  row("VpnClient", "c1").status = "suspended";
  const response = await api("r1", "POST", "/devices/c1/renew", { durationDays: 3 });
  ok(response);
  assert.match(response.body.token, /^SXB-USER-(?:[A-Z0-9]{4}-){2}[A-Z0-9]{4}$/);
  assert.notEqual(response.body.token, before.token);
  assert.equal(new Date(response.body.expireAt).getTime(), +before.expireAt + 3 * 86400000);
  for (const key of ["id", "userId", "deviceId", "activatedAt"]) assert.deepEqual(row("VpnClient", "c1")[key], before[key]);
  assert.equal(row("ActivationSession", "right").status, "active");
  assert.equal(+row("ActivationSession", "right").activationDate, +before.activatedAt);
  assert.equal(+row("ActivationSession", "right").expirationDate, +before.expireAt + 3 * 86400000);
  assert.equal(row("ActivationSession", "wrong").status, "revoked");
  assert.equal(row("AppRegistration", "wrong-app").status, "revoked");
  assert.equal(row("AppRegistration", "right-app").status, "matched");
  assert.deepEqual(db.state.Subscription, subscriptions);
  const previous = response.body.token;
  const second = await api("r1", "POST", "/clients/c1/renew", {});
  ok(second); assert.notEqual(second.body.token, previous);
  assert.equal(new Date(second.body.expireAt).getTime(), +before.expireAt + 33 * 86400000);
  ok(await request("/mobile/me", accessToken()));
  ok(await request("/provision/activate", accessToken(), { method: "POST", body: { dataToken: subscriptions[0].dataToken, deviceId } }));
  const expired = await api(null, "POST", "/mobile/auth/activate", { token: previous, deviceId });
  ok(expired, 404);
  for (const durationDays of [0, -1, 3651, 0.5, "invalid"]) {
    ok(await api("r1", "POST", "/devices/c1/renew", { durationDays }), 400);
    ok(await api("r1", "POST", "/clients/c1/renew", { durationDays }), 400);
  }
  const concurrent = await Promise.all([1, 2].map(() => api("r1", "POST", "/clients/c1/renew", { durationDays: 1 })));
  concurrent.forEach(value => ok(value));
  assert.equal(+row("VpnClient", "c1").expireAt, +before.expireAt + 35 * 86400000);
  assert.notEqual(concurrent[0].body.token, concurrent[1].body.token);
});

test("lifecycle: quota and duration mutations never rotate or renew the device, or undo manual config suspension", async () => {
  bind();
  const created = await createSub("r1", 2);
  ok(created, 201);
  const id = created.body.subscription.id;
  const original = structuredClone(row("VpnClient", "c1"));
  for (const status of ["active", "suspended", "revoked"]) {
    row("Subscription", id).status = status;
    const expireAt = +row("Subscription", id).expireAt;
    const extension = await api("r1", "POST", "/subscriptions/bulk", { action: "extend_duration", subscriptionIds: [id], durationDays: 2 });
    ok(extension); assert.equal(extension.body.succeeded, 1);
    assert.equal(+row("Subscription", id).expireAt, expireAt + 2 * 86400000);
    assert.equal(row("Subscription", id).status, status);
    ok(await api("r1", "POST", "/subscriptions/bulk", { action: "add_data", subscriptionIds: [id], quotaGB: 1 }));
    assert.equal(row("Subscription", id).status, status);
  }
  row("Subscription", id).status = "exhausted";
  row("Subscription", id).quotaUsed = row("Subscription", id).quotaBytes;
  ok(await api("r1", "POST", "/subscriptions/bulk", { action: "add_data", subscriptionIds: [id], quotaGB: 1 }));
  assert.equal(row("Subscription", id).status, "active");
  ok(await api("r1", "PUT", `/subscriptions/${id}`, { quotaGB: 8, durationDays: 40 }));
  assert.deepEqual(row("VpnClient", "c1"), original);
  row("Subscription", id).expireAt = yesterday();
  row("Subscription", id).status = "expired";
  const now = Date.now();
  ok(await api("r1", "POST", "/subscriptions/bulk", { action: "extend_duration", subscriptionIds: [id], durationDays: 1 }));
  assert.ok(+row("Subscription", id).expireAt >= now + 86400000);
  assert.deepEqual(row("VpnClient", "c1"), original);
});

test("lifecycle: config statuses and effective duration/quota are explicit on every provision surface", async () => {
  bind();
  const created = await createSub("r1", 1);
  ok(created, 201);
  const id = created.body.subscription.id;
  for (const [status, updates] of [
    ["suspended", { status: "suspended", expireAt: tomorrow(), quotaUsed: 0n }],
    ["expired", { status: "active", expireAt: yesterday(), quotaUsed: 0n }],
    ["exhausted", { status: "active", expireAt: tomorrow(), quotaUsed: GO }],
  ]) {
    Object.assign(row("Subscription", id), updates);
    const response = await request(`/provision/status/${id}`);
    ok(response, 403);
    assert.equal(response.body.code, `CONFIG_${status.toUpperCase()}`);
    assert.equal(response.body.scope, "subscription");
    assert.equal(response.body.temporary, true);
    const snapshot = await state();
    assert.equal(snapshot.body.device.status, "active");
    assert.equal(snapshot.body.subscriptions[0].status, status);
  }
  row("Subscription", id).status = "revoked";
  const tamper = await request(`/mobile/connections/${id}/status`, accessToken(), { method: "POST", body: { disabledReason: "expired" } });
  ok(tamper, 403); assert.equal(tamper.body.code, "CONFIG_REVOKED");
  assert.equal(row("Subscription", id).status, "revoked");
});

test("lifecycle: upstream profile suspension, archival and missing relation affect only linked configs", async () => {
  bind();
  const created = await createSub("r1", 1);
  ok(created, 201);
  const profile = { ...row("VpnProfile", "p1"), id: "independent-profile", name: "Independent offer" };
  db.state.VpnProfile.push(profile);
  db.state.VpnProfileReseller.push({ profileId: profile.id, resellerId: "res-r1" });
  const other = await api("r1", "POST", "/subscriptions", { clientId: "c1", profileId: profile.id, quotaGB: 1, durationDays: 30 });
  ok(other, 201);
  const before = structuredClone(row("VpnClient", "c1"));
  for (const [profileStatus, expected] of [["suspended", "CONFIG_SUSPENDED"], ["archived", "CONFIG_REVOKED"]]) {
    row("VpnProfile", "p1").status = profileStatus;
    const snapshot = await state();
    ok(snapshot); assert.equal(snapshot.body.device.status, "active");
    assert.equal(snapshot.body.subscriptions.find(s => s.id === other.body.subscription.id).status, "active");
    assert.equal(snapshot.body.subscriptions.find(s => s.id === created.body.subscription.id).status, expected === "CONFIG_SUSPENDED" ? "suspended" : "revoked");
    const account = await request(`/mobile/me?subscriptionId=${created.body.subscription.id}`);
    ok(account);
    assert.equal(account.body.accountState.device.status, "active");
    assert.equal(account.body.accountState.state, "no_package");
    assert.equal(account.body.accountState.subscriptionState, expected === "CONFIG_SUSPENDED" ? "suspended" : "revoked");
    const config = await request(`/mobile/vpn/config?subscriptionId=${created.body.subscription.id}`);
    ok(config, 403); assert.equal(config.body.code, expected);
    const provision = await request("/provision/activate", accessToken(), {
      method: "POST", body: { dataToken: created.body.subscription.dataToken, deviceId },
    });
    ok(provision, 403); assert.equal(provision.body.code, expected);
  }
  // Fixture models a corrupt/missing relation; a real FK normally prevents it.
  db.state.VpnProfile = db.state.VpnProfile.filter(value => value.id !== "p1");
  const missing = await state();
  assert.equal(missing.body.subscriptions.find(s => s.id === created.body.subscription.id).status, "deleted");
  const config = await request(`/mobile/vpn/config?subscriptionId=${created.body.subscription.id}`);
  ok(config, 404); assert.equal(config.body.code, "CONFIG_DELETED");
  assert.deepEqual(row("VpnClient", "c1"), before);
});

test("lifecycle: a legacy zero-volume plan is date-limited, unlike a zero reseller allocation", async () => {
  bind();
  const created = await createSub("r1", 1);
  ok(created, 201);
  const id = created.body.subscription.id;
  row("Subscription", id).quotaBytes = 0n;
  row("Subscription", id).quotaUsed = 10n;
  assert.equal((await state()).body.subscriptions[0].status, "active");
  ok(await request(`/provision/status/${id}`));
  ok(await request("/provision/activate", accessToken(), { method: "POST", body: { dataToken: created.body.subscription.dataToken, deviceId } }));
  row("Subscription", id).expireAt = yesterday();
  assert.equal((await state()).body.subscriptions[0].status, "expired");
  const expired = await request(`/provision/status/${id}`);
  ok(expired, 403); assert.equal(expired.body.code, "CONFIG_EXPIRED");
  row("Reseller", "res-r1").quotaBytes = 0n;
  ok(await createSub("r1", 1), 409);
  ok(await createSub("r1", 0), 400);
});

test("lifecycle: strict signed user/client/device binding rejects cross-tenant, ambiguous and dashboard tokens", async () => {
  bind(); bind("c2", "LIFECYCLE-ANDROID-TWO");
  const created = await createSub();
  ok(created, 201);
  for (const token of [
    accessToken({ role: "OWNER" }), accessToken({ role: "RESELLER" }),
    accessToken({ userId: "u2" }), accessToken({ clientId: "c2" }), accessToken({ deviceId: "LIFECYCLE-ANDROID-TWO" }),
    jwt.sign({ userId: "u1", role: "CLIENT", deviceId }, process.env.JWT_SECRET, { expiresIn: "15m" }),
  ]) {
    const response = await state(token);
    ok(response, 401); assert.equal(response.body.code, "SESSION_INVALID");
    assert.equal(JSON.stringify(response.body).includes("SXB-"), false);
  }
  ok(await request("/mobile/access-state", accessToken(), { headers: { "X-SXB-Device-ID": "WRONG-DEVICE" } }), 401);
  ok(await request(`/mobile/vpn/config?subscriptionId=${created.body.subscription.id}`, accessToken({ userId: "u2", clientId: "c2", deviceId: "LIFECYCLE-ANDROID-TWO" }),
    { headers: { "X-SXB-Device-ID": "LIFECYCLE-ANDROID-TWO" } }), 404);
  db.state.VpnClient.push({ ...row("VpnClient", "c1"), id: "ambiguous", deviceId: "THIRD-DEVICE", token: "SXB-USER-9999-9999-9999" });
  const legacy = jwt.sign({ userId: "u1", role: "CLIENT" }, process.env.JWT_SECRET, { expiresIn: "15m" });
  ok(await request("/mobile/connections", legacy), 401);
  ok(await state(accessToken()));
});

test("lifecycle: control tickets have a separate key, bounded expiry and cannot authorize business/config/refresh", async () => {
  bind();
  ok(await createSub(), 201);
  const response = await ticket();
  const decoded = jwt.decode(response.ticket);
  assert.equal(decoded.clientId, "c1"); assert.equal(decoded.userId, "u1"); assert.equal(decoded.deviceId, deviceId);
  assert.equal(decoded.aud, routes.ACCESS_TICKET_AUDIENCE); assert.equal(decoded.iss, routes.ACCESS_TICKET_ISSUER);
  assert.equal(decoded.exp - decoded.iat, 7 * 86400);
  assert.equal(new Date(response.expiresAt).getTime(), decoded.exp * 1000);
  assert.throws(() => jwt.verify(response.ticket, process.env.JWT_SECRET));
  ok(await state(response.ticket));
  for (const path of ["/mobile/me", "/mobile/vpn/config", "/mobile/connections", "/clients", "/devices", "/auth/me"]) {
    ok(await request(path, response.ticket), 401);
  }
  for (const path of ["/mobile/access-ticket", "/provision/activate", "/mobile/vpn/traffic"]) {
    ok(await request(path, response.ticket, { method: "POST", body: {} }), 401);
  }
  for (const path of ["/auth/refresh", "/mobile/auth/refresh"]) {
    const denial = await request(path, response.ticket, { method: "POST", body: { refreshToken: response.ticket } });
    ok(denial, 401); assert.equal(denial.body.code, "SESSION_INVALID");
  }
  const key = routes.accessTicketKey(process.env.JWT_SECRET);
  const now = Math.floor(Date.now() / 1000);
  for (const changes of [{ exp: now - 1 }, { aud: "business" }, { iss: "wrong" }, { exp: now + 8 * 86400 }, { deviceId: "OTHER" }]) {
    const forged = jwt.sign({ ...decoded, ...changes }, key, { algorithm: "HS256" });
    const denied = await state(forged);
    ok(denied, 401); assert.equal(denied.body.code, "SESSION_INVALID"); assert.equal(denied.body.scope, "session");
  }
  const accessSignedTicket = jwt.sign(decoded, process.env.JWT_SECRET, { algorithm: "HS256" });
  ok(await state(accessSignedTicket), 401);
});

test("lifecycle: tickets retain minimal observation on user/owner blocks, deletion and reset without inheriting another binding", async () => {
  bind();
  ok(await createSub(), 201);
  const control = await ticket();
  for (const [model, id, status, expected] of [
    ["User", "u1", "suspended", "suspended"], ["User", "u1", "revoked", "revoked"],
    ["Reseller", "res-r1", "suspended", "suspended"], ["User", "r1", "revoked", "revoked"],
  ]) {
    row(model, id).status = status;
    const snapshot = await state(control.ticket);
    ok(snapshot); assert.equal(snapshot.body.device.status, expected);
    assert.equal((await request("/mobile/connections")).body.scope, "device");
    ok(await request("/mobile/access-ticket", accessToken(), { method: "POST", body: {} }), 403);
    row(model, id).status = "active";
  }
  row("Reseller", "res-r1").accessExpiresAt = yesterday();
  assert.equal((await state(control.ticket)).body.device.status, "expired");
  row("Reseller", "res-r1").accessExpiresAt = tomorrow();
  row("VpnClient", "c1").deviceId = "NEW-DEVICE";
  const reset = await state(control.ticket);
  ok(reset); assert.equal(reset.body.device.status, "revoked");
  assert.equal(reset.body.device.activationRequired, true); assert.deepEqual(reset.body.subscriptions, []);
  row("VpnClient", "c1").deviceId = deviceId;
  ok(await api("r1", "DELETE", "/clients/c1"));
  const deleted = await state(control.ticket);
  ok(deleted); assert.equal(deleted.body.device.code, "DEVICE_DELETED");
  assert.equal(deleted.body.device.activationRequired, true);
  assert.deepEqual(deleted.body.subscriptions, []);
});

test("lifecycle: mobile refresh is bound, least-privileged, non-extending and distinguishes outage from invalid session", async () => {
  bind();
  const refresh = accessToken({}, process.env.REFRESH_SECRET);
  row("VpnClient", "c1").status = "disabled";
  for (const path of ["/auth/refresh", "/mobile/auth/refresh"]) {
    const updated = await request(path, accessToken(), { method: "POST", body: { refreshToken: refresh } });
    ok(updated);
    assert.equal(jwt.decode(updated.body.refreshToken).exp, jwt.decode(refresh).exp);
    assert.deepEqual(jwt.decode(updated.body.accessToken).permissions, []);
    ok(await state(updated.body.accessToken));
    ok(await request("/mobile/connections", updated.body.accessToken), 403);
    const wrong = await request(path, accessToken(), { method: "POST", body: { refreshToken: refresh }, headers: { "X-SXB-Device-ID": "OTHER" } });
    ok(wrong, 401); assert.equal(wrong.body.code, "SESSION_INVALID");
    const expired = jwt.sign({ userId: "u1", clientId: "c1", deviceId, role: "CLIENT", exp: 1 }, process.env.REFRESH_SECRET);
    ok(await request(path, accessToken(), { method: "POST", body: { refreshToken: expired } }), 401);
    db.failModel = "VpnClient";
    const outage = await request(path, accessToken(), { method: "POST", body: { refreshToken: refresh } });
    ok(outage, 503); assert.equal(outage.body.code, undefined);
    db.failModel = null;
  }
});

test("lifecycle: reseller/support ACLs and quota rollback hold for all device actions", async () => {
  bind(); ok(await createSub(), 201);
  for (const action of ["renew", "resume", "suspend", "revoke"]) {
    ok(await api("r2", "POST", `/devices/c1/${action}`, {}), 403);
    ok(await api("support", "POST", `/devices/c1/${action}`, {}), 403);
  }
  ok(await api("r1", "POST", "/devices/c1/suspend", {}));
  row("Reseller", "res-r1").quotaBytes = 0n;
  const before = structuredClone(row("VpnClient", "c1"));
  for (const path of ["/devices/c1/resume", "/devices/c1/renew", "/clients/c1/activate", "/clients/c1/renew"]) {
    ok(await api("r1", "POST", path, {}), 409);
    assert.deepEqual(row("VpnClient", "c1"), before);
  }
});

test("lifecycle: long-poll wakes within milliseconds only after commit, including subscription deletion", async () => {
  bind();
  const created = await createSub();
  ok(created, 201);
  const initial = await state();
  let done = false;
  const pending = state(accessToken(), `?revision=${initial.body.revision}&wait=25`).then(value => { done = true; return value; });
  await waitForWaiters();
  let release, reached;
  const committing = new Promise(resolve => { reached = resolve; });
  db.beforeCommit = () => { reached(); return new Promise(resolve => { release = resolve; }); };
  const mutation = api("r1", "POST", `/subscriptions/${created.body.subscription.id}/revoke`, {});
  await committing;
  await delay(75);
  assert.equal(done, false);
  assert.equal(row("Subscription", created.body.subscription.id).status, "active");
  const committedAt = Date.now();
  release();
  ok(await mutation);
  const snapshot = await pending;
  ok(snapshot);
  assert.ok(Date.now() - committedAt < 750, "Local commit must wake before 2s resync");
  assert.equal(snapshot.body.subscriptions[0].status, "revoked");
  empty();
  db.beforeCommit = null;
  const deletedWait = state(accessToken(), `?revision=${snapshot.body.revision}&wait=25`);
  await waitForWaiters();
  ok(await api("r1", "DELETE", `/subscriptions/${created.body.subscription.id}`));
  const deleted = await deletedWait;
  ok(deleted); assert.deepEqual(deleted.body.subscriptions, []);
  empty();
});

test("lifecycle: long-poll observes remote-worker quota and wall-clock expiry without local events", async () => {
  bind();
  const created = await createSub("r1", 1);
  ok(created, 201);
  const initial = await state();
  const started = Date.now();
  const remote = state(accessToken(), `?revision=${initial.body.revision}&wait=25`);
  await waitForWaiters();
  row("Subscription", created.body.subscription.id).quotaUsed = GO;
  const snapshot = await remote;
  ok(snapshot);
  assert.equal(snapshot.body.subscriptions[0].status, "exhausted");
  assert.ok(Date.now() - started < 3500);
  row("VpnClient", "c1").expireAt = new Date(Date.now() + 300);
  const expiring = await state();
  const expired = await state(accessToken(), `?revision=${expiring.body.revision}&wait=25`);
  ok(expired); assert.equal(expired.body.device.status, "expired");
  assert.equal(expired.body.device.activationRequired, false);
  empty();
});

test("lifecycle: long-poll abort, deadline, credential expiry and waiter caps release resources", async () => {
  bind();
  const first = await state();
  const abort = new AbortController();
  const wait = request(`/mobile/access-state?revision=${first.body.revision}&wait=25`, accessToken(), { signal: abort.signal });
  await waitForWaiters();
  const duplicate = await state(accessToken(), `?revision=${first.body.revision}&wait=25`);
  ok(duplicate, 429);
  assert.equal(duplicate.body.code, "ACCESS_STATE_BUSY");
  abort.abort();
  await assert.rejects(wait, error => error.name === "AbortError");
  await waitForWaiters(0);
  const started = Date.now();
  const timed = await state(accessToken(), `?revision=${first.body.revision}&wait=1`);
  ok(timed);
  assert.equal(timed.body.revision, first.body.revision);
  assert.ok(Date.now() - started >= 850 && Date.now() - started < 1500);
  empty();
  const short = jwt.sign({ userId: "u1", clientId: "c1", deviceId, role: "CLIENT" }, process.env.JWT_SECRET, { expiresIn: 1 });
  const expiry = await state(short, `?revision=${first.body.revision}&wait=25`);
  ok(expiry, 401); assert.equal(expiry.body.code, "SESSION_INVALID");
  empty();
  ok(await state(accessToken(), `?revision=${first.body.revision}&wait=26`), 400);
  const hub = new routes.AccessStateHub(2);
  const identity = { userId: "u1", clientId: "c1", deviceId };
  const one = hub.subscribe(identity, () => {});
  const two = hub.subscribe({ ...identity, clientId: "c2" }, () => {});
  assert.throws(() => hub.subscribe({ ...identity, clientId: "c3" }, () => {}), routes.AccessWaitLimitError);
  one.close(); two.close(); assert.equal(hub.size, 0);
});

test("lifecycle: limiter verifies dedicated tickets only on the exact read route and shares signed account budgets", async () => {
  bind();
  const issued = await ticket();
  const app = express();
  app.use(express.json());
  app.use("/api", routes.createApiRateLimiter({ access: process.env.JWT_SECRET, refresh: process.env.REFRESH_SECRET }));
  app.use((_req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  const send = (path, token = issued.ticket, custom = {}) => fetch(`${origin}${path}`, {
    headers: { Authorization: `Bearer ${token}`, ...headers, ...custom },
  });

  test("lifecycle: failed commit emits no invalidation and rolls back renewal code, date and sessions", async () => {
    bind();
    ok(await createSub(), 201);
    const initial = await state();
    const before = structuredClone(db.state);
    let notifications = 0;
    const listener = routes.accessStateHub.subscribe({ userId: "u1", clientId: "c1", deviceId }, () => { notifications++; });
    listener.update(initial.body);
    db.beforeCommit = () => { throw new Error("Simulated commit failure"); };
    try {
      ok(await api("r1", "POST", "/clients/c1/renew", { durationDays: 2 }), 500);
      assert.equal(notifications, 0);
      assert.deepEqual(db.state, before);
    } finally {
      db.beforeCommit = null;
      listener.close();
    }
    empty();
  });

  test("lifecycle: coalesced client invalidations do not create concurrent reads or leave futures on abort", async () => {
    bind();
    const snapshot = (await state()).body;
    const hub = new routes.AccessStateHub(1);
    const abort = new AbortController();
    const identity = { userId: "u1", clientId: "c1", deviceId, exp: Math.floor(Date.now() / 1000) + 60, kind: "access", boundInToken: true };
    let reads = 0, concurrent = 0, maxConcurrent = 0;
    const pending = routes.waitForMobileAccess(identity, snapshot.revision, 25, abort.signal, hub, async () => {
      reads++; concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      await delay(10); concurrent--;
      return snapshot;
    });
    await delay(20);
    hub.invalidate({ clientId: "unrelated" });
    await delay(20);
    assert.equal(reads, 1);
    for (let count = 0; count < 100; count++) hub.invalidate({ clientId: "c1" });
    await delay(70);
    assert.equal(reads, 2);
    assert.equal(maxConcurrent, 1);
    abort.abort();
    assert.equal(await pending, null);
    assert.equal(hub.size, 0);
    await delay(60);
    assert.equal(reads, 2);
  });
  try {
    const first = await send("/mobile/access-state");
    assert.equal(first.headers.get("ratelimit-limit"), "600");
    const renewed = await send("/mobile/access-state", (await ticket()).ticket);
    assert.equal(renewed.headers.get("ratelimit-remaining"), "598");
    const access = await send("/mobile/access-state", accessToken());
    assert.equal(access.headers.get("ratelimit-remaining"), "597");
    const wrong = await send("/mobile/access-state", issued.ticket, { "X-SXB-Device-ID": "WRONG" });
    assert.equal(wrong.headers.get("ratelimit-limit"), "200");
    const business = await send("/mobile/connections");
    assert.equal(business.headers.get("ratelimit-limit"), "200");
    const other = routes.issueAccessTicket({ userId: "u2", clientId: "c2", deviceId }, process.env.JWT_SECRET);
    const secondAccount = await send("/mobile/access-state", other.ticket);
    assert.equal(secondAccount.headers.get("ratelimit-remaining"), "599");
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

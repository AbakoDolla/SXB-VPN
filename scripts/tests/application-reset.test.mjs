import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(path.join(root, "backend", "package.json"));
const temporary = await mkdtemp(path.join(root, "backend", ".sxb-reset-http-"));
const { build } = require("esbuild");
const { Prisma } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const express = require("express");
const models = new Map(Prisma.dmmf.datamodel.models.map(model => [model.name, model]));
const password = "owner-reset-fixture-only";
const secretCanary = "do-not-expose-password-pgurl-private-host";
const deviceId = "RESET-OLD-ANDROID";
const bundlePath = path.join(temporary, "reset.cjs");
await build({
  stdin: {
    contents: 'export * from "./server/services/application-reset";' +
      'export * from "./server/services/reset-state";' +
      'export { setMaintenanceMode } from "./server/services/maintenance";' +
      'export { createOpsRouter, resetRequestErrorHandler } from "./server/routes/ops";',
    resolveDir: root, loader: "ts",
  },
  bundle: true, platform: "node", format: "cjs", packages: "external", outfile: bundlePath, logLevel: "silent",
  plugins: [{
    name: "reset-isolated-database",
    setup(builder) {
      builder.onResolve({ filter: /(?:^|\/)database$/ }, () => ({ path: "database", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: `export const prisma = globalThis.__sxbResellerHttpDb;
          export const inMemoryDb = {};
          export async function logDbActivity() {}`,
      }));
    },
  }],
});
// Register our tests immediately after importing the shared HTTP fixture.
// Awaiting another build afterwards lets Node 22 finish its filtered tests and
// run its teardown before the additional tests have been registered.
const { db, base, routes, row, tomorrow } = await import("./reseller-http.test.mjs");
const reset = require(bundlePath);
after(() => rm(temporary, { recursive: true, force: true }));

function seed() {
  const add = (name, data) => db.create(name, data, db.state);
  for (const user of db.state.User) Object.assign(user, {
    passwordHash: bcrypt.hashSync(password, 4), phone: "+10000000000", avatarUrl: "/preserved-avatar.png",
    createdAt: new Date("2025-01-01Z"), updatedAt: new Date("2025-02-01Z"),
  });
  Object.assign(row("VpnClient", "c1"), { deviceId, activatedAt: new Date("2025-01-01Z") });
  add("VpnClient", { id: "admin-client", userId: "admin", token: "SXB-ADMIN-VPN-FIXTURE", quotaUsed: 7n });
  add("Reseller", { id: "admin-reseller", userId: "admin", quotaBytes: 4n, quotaUsedBytes: 3n });
  add("SshPayload", { id: "payload", name: "Technical payload", content: secretCanary });
  Object.assign(row("VpnProfile", "p1"), {
    lockPasswordHash: bcrypt.hashSync("separate-profile-password", 4), lockVersion: 3,
    configVersion: 2, payloadId: "payload", canonicalConfigHash: "a".repeat(64),
  });
  add("SshAccount", { id: "ssh", name: "SSH", host: secretCanary, username: "fixture", password: secretCanary, payloadId: "payload" });
  add("XrayAccount", { id: "xray", name: "Xray", protocol: "vless", host: secretCanary, port: 443, clientId: "c1" });
  add("SingboxAccount", { id: "singbox", name: "Singbox", protocol: "tuic", host: secretCanary, port: 443, clientId: "c1" });
  add("Subscription", {
    id: "sub", name: "VPN", clientId: "c1", profileId: "p1", dataToken: "SXB-DATA-AAAA-BBBB-CCCC",
    quotaBytes: 1024n ** 3n, quotaUsed: 13n, durationDays: 30, expireAt: tomorrow(), deviceId,
  });
  add("SubscriptionDevice", { id: "sd", subscriptionId: "sub", deviceId });
  add("ActivationSession", { id: "activation", clientId: "c1", deviceId, activationDate: new Date(), expirationDate: tomorrow() });
  add("AppRegistration", { id: "registration", clientId: "c1", deviceId, status: "matched" });
  add("PushToken", { id: "push", userId: "admin", deviceId: "ADMIN-PUSH", token: secretCanary });
  add("TokenSXB", { id: "token", clientId: "c1", token: "SXB-DATA-DDDD-EEEE-FFFF", quota: 123n, expiration: tomorrow() });
  add("Voucher", { id: "voucher", code: "VCH-FIXTURE", quota: 12n, durationDays: 1, resellerId: "res-r1", redeemedClientId: "c1" });
  add("TrafficUsage", { id: "traffic", clientId: "c1", deviceId, download: 23n, upload: 45n });
  add("VpnLog", { id: "vpn-log", clientId: "c1", action: "connect", details: secretCanary });
  add("MobileHealthDevice", { id: "health-device", pseudonym: "pseudo", appVersion: "1.0", versionCode: 1, tunnelState: "connected" });
  add("MobileHealthReport", { id: "health-report", reportId: "report", deviceId: "health-device", tunnelState: "connected" });
  add("SupportTicket", { id: "support-ticket", title: "Fixture", clientName: secretCanary, userId: "admin" });
  for (const userId of ["root", "admin", "super", "r1"]) {
    add("AdminToken", { id: `admin-token-${userId}`, userId, token: `SXB-ADMIN-${userId}`, expiresAt: tomorrow() });
  }
  add("AuditLog", { id: "old-audit", userId: "u1", action: "Preserve content", type: "info" });
  add("AuditLog", { id: "owner-audit", userId: "root", action: "Private owner entry", type: "info", visibleOwnerOnly: true });
  add("ResellerQuotaMovement", {
    id: "ledger", resellerId: "res-r1", resellerUserId: "r1", resellerName: "Retained snapshot",
    actorUserId: "admin", actorName: "Administrator", kind: "ADMIN_ALLOCATION", reason: "Fixture",
    deltaBytes: 123n, quotaBeforeBytes: 0n, quotaAfterBytes: 123n, allocatedBeforeBytes: 0n, allocatedAfterBytes: 0n,
  });
  add("VPSServer", { id: "server", name: "Preserved infrastructure", ip: "192.0.2.1", location: "fixture" });
  add("ServerConfig", { id: "server-config", serverId: "server", type: "ssh", configurationEncrypted: secretCanary });
  add("Setting", { key: "privacy.policy", value: "Preserved privacy policy" });
  add("Setting", { key: "apk.current", value: "Preserved APK metadata" });
  add("Setting", { key: reset.MAINTENANCE_KEY, value: "false" });
}

function token(actor, overrides = {}) {
  const user = row("User", actor);
  return jwt.sign({
    userId: actor, email: user?.email ?? "old@example.test", role: user?.roleId ?? "CLIENT",
    ...(actor === "u1" ? { clientId: "c1", deviceId } : {}), ...overrides,
  }, process.env.JWT_SECRET, { expiresIn: "15m" });
}
const bodyFor = preview => ({ mode: "production", challenge: preview.challenge, confirmation: "RESET SXB VPN", password });
const failure = code => error => {
  assert.equal(error.code, code);
  assert.equal(JSON.stringify(error).includes(secretCanary), false);
  return true;
};
const business = () => Object.fromEntries(Object.entries(db.state)
  .filter(([name]) => name !== "Setting").map(([name, rows]) => [name, structuredClone(rows)]));

// Extend the existing Prisma-shaped fixture only inside each reset test. The
// independent committed maintenance transaction and PostgreSQL-style advisory
// lock are important: a single serialized fake transaction would miss races.
async function harness(t, { backup, invalidateAccess } = {}) {
  seed();
  const originalTransaction = db.$transaction;
  const originalMatches = db.matches;
  const state = {
    held: null, tablesLocked: false, backupCalls: 0, invalidations: 0, events: [],
    failDelete: null, failCommit: false, loseCommitResponse: false, failRestore: false,
    beforeTables: null, beforeCommit: null, now: Date.now(), transactions: 0,
  };
  db.matches = function(name, row, where, snapshot) {
    if (!where) return true;
    const normalized = { ...where };
    for (const [key, filter] of Object.entries(where)) {
      if (filter && typeof filter === "object" && "startsWith" in filter) {
        if (typeof row[key] !== "string" || !row[key].startsWith(filter.startsWith)) return false;
        normalized[key] = row[key];
      }
    }
    return originalMatches.call(this, name, row, normalized, snapshot);
  };
  db.$transaction = async function(callback) {
    const id = ++state.transactions;
    let draft = structuredClone(db.state);
    const dirty = new Set();
    let kind = "read";
    const enforceDeletion = (name, args) => {
      if (name === "ResellerQuotaMovement" || name === "AuditLog") throw new Error("Append-only fixture");
      if (name === state.failDelete) throw new Error(`Foreign key ${secretCanary}`);
      const deleted = draft[name].filter(row => db.matches(name, row, args.where, draft));
      for (const child of models.values()) {
        for (const field of child.fields.filter(field => field.kind === "object" && field.type === name && field.relationFromFields.length)) {
          const references = draft[child.name].filter(row => deleted.some(parent =>
            field.relationFromFields.every((key, index) => row[key] != null && row[key] === parent[field.relationToFields[index]])));
          if (!references.length) continue;
          if (field.relationOnDelete === "SetNull") {
            for (const row of references) for (const key of field.relationFromFields) row[key] = null;
            dirty.add(child.name);
          } else {
            throw new Error(`Unordered deletion: ${child.name} -> ${name}`);
          }
        }
      }
    };
    const tx = {
      $queryRawUnsafe: async sql => {
        assert.equal(sql, reset.RESET_LOCK_SQL);
        const acquired = state.held === null || state.held === id;
        if (acquired) state.held = id;
        return [{ acquired }];
      },
      $executeRawUnsafe: async sql => {
        state.events.push(sql);
        if (sql === reset.RESET_TABLE_LOCK_SQL) {
          assert.equal(state.held, id);
          if (state.beforeTables) await state.beforeTables();
          draft = structuredClone(db.state);
          state.tablesLocked = true;
          kind = "purge";
        } else assert.match(sql, /^SET (?:LOCAL lock_timeout|TRANSACTION READ ONLY)/);
        return 0;
      },
    };
    for (const model of models.values()) {
      const delegate = db.delegate(model.name, () => draft);
      const name = model.name;
      for (const method of ["create", "createMany", "update", "updateMany", "delete", "deleteMany", "upsert"]) {
        const original = delegate[method];
        delegate[method] = async (args = {}) => {
          if (method.startsWith("delete")) enforceDeletion(name, args);
          if (name === "Setting" && args.where?.key === reset.RESET_EXECUTION_KEY) {
            if (method === "upsert") kind = "prepare";
            if (method === "deleteMany") kind = "restore";
          }
          dirty.add(name);
          state.events.push(`${name}.${method}`);
          return original(args);
        };
      }
      tx[model.name[0].toLowerCase() + model.name.slice(1)] = delegate;
    }
    try {
      const result = await callback(tx);
      if (kind === "purge" && state.beforeCommit) await state.beforeCommit();
      if ((kind === "purge" && state.failCommit) || (kind === "restore" && state.failRestore)) throw new Error(secretCanary);
      for (const name of dirty) db.state[name] = draft[name];
      state.events.push(`${kind}:commit`);
      if (kind === "purge" && state.loseCommitResponse) {
        state.loseCommitResponse = false;
        throw new Error(secretCanary);
      }
      return result;
    } catch (error) {
      state.events.push(`${kind}:rollback`);
      throw error;
    } finally {
      if (state.held === id) { state.held = null; state.tablesLocked = false; }
    }
  };
  const serviceOptions = {
    db, jwtSecret: process.env.JWT_SECRET, now: () => state.now,
    backup: async context => {
      state.backupCalls++;
      assert.ok(state.held);
      assert.equal(state.tablesLocked, true);
      assert.equal(db.state.Setting.find(row => row.key === reset.MAINTENANCE_KEY)?.value, "true");
      state.events.push("backup");
      return backup ? backup(context) : { id: context.resetId, bytes: 2048, sha256: "b".repeat(64) };
    },
    invalidateAccess: () => {
      state.invalidations++;
      assert.equal(db.state.VpnClient.length, 0, "invalidation must follow commit");
      routes.accessStateHub.invalidate();
      invalidateAccess?.();
    },
  };
  const service = reset.createResetService(serviceOptions);
  const app = express();
  app.use(express.json());
  app.use("/api", reset.createOpsRouter({ resetService: service }));
  app.use(reset.resetRequestErrorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api`;
  t.after(async () => {
    db.$transaction = originalTransaction;
    db.matches = originalMatches;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const request = async (actor, method, route, body, accessToken = actor ? token(actor) : null) => {
    const response = await fetch(`${url}${route}`, {
      method, headers: { "Content-Type": "application/json", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    assert.equal(JSON.stringify(data).includes(secretCanary), false);
    assert.equal(JSON.stringify(data).includes(password), false);
    return { status: response.status, body: data, headers: response.headers };
  };
  return { state, service, serviceOptions, request, url };
}

test("reset: real HTTP rejects every non-OWNER and stale JWT role claims for preview and execute", async t => {
  const { request, state } = await harness(t);
  for (const actor of ["admin", "super", "support", "r1", "u1"]) {
    for (const [method, route, body] of [["GET", "/ops/reset/preview"], ["GET", "/ops/reset/status"], ["POST", "/ops/reset/execute", {}]]) {
      const response = await request(actor, method, route, body);
      assert.equal(response.status, 403, JSON.stringify(response.body));
      assert.equal(response.body.code, "OWNER_ONLY");
    }
  }
  assert.equal((await request(null, "GET", "/ops/reset/preview")).status, 401);
  const spoofed = await request("admin", "GET", "/ops/reset/preview", undefined, token("admin", { role: "OWNER" }));
  assert.equal(spoofed.status, 403);
  assert.equal(state.backupCalls, 0);
  assert.equal(db.state.Setting.some(row => row.key.startsWith(reset.RESET_SETTING_PREFIX)), false);
});

test("reset: preview is read-only, structural, private, complete and has no memory fallback", async t => {
  const { request, state } = await harness(t);
  const before = structuredClone(db.state);
  const preview = await request("root", "GET", "/ops/reset/preview");
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("cache-control"), "no-store");
  assert.equal(preview.body.mode, "production");
  assert.equal(preview.body.confirmationText, "RESET SXB VPN");
  assert.equal(preview.body.backupRequired, true);
  assert.equal(Object.keys(preview.body.counts).length, 22);
  assert.ok(Object.values(preview.body.counts).every(value => Number.isInteger(value) && value > 0));
  assert.equal(preview.body.counts.users, 6);
  assert.equal(preview.body.counts.adminTokens, 1);
  assert.deepEqual(preview.body.preserved.usersByRole, { OWNER: 1, ADMIN: 1, SUPER_ADMIN: 1 });
  assert.equal(preview.body.preserved.projectFiles, true);
  assert.deepEqual(preview.body.warnings, reset.RESET_WARNINGS);
  assert.deepEqual(db.state, before);
  assert.equal(state.backupCalls, 0);
  const withoutDatabase = reset.createResetService({ db: null, jwtSecret: "fixture", backup: () => assert.fail(), invalidateAccess: () => assert.fail() });
  await assert.rejects(withoutDatabase.status("root"), failure("RESET_DATABASE_UNAVAILABLE"));
  await assert.rejects(withoutDatabase.preview("root"), failure("RESET_DATABASE_UNAVAILABLE"));
  await assert.rejects(withoutDatabase.execute("root", bodyFor(preview.body)), failure("RESET_DATABASE_UNAVAILABLE"));
  db.failModel = "Setting";
  await assert.rejects(reset.createResetService({ db, jwtSecret: "fixture", backup: () => assert.fail(), invalidateAccess: () => assert.fail() }).preview("root"), failure("RESET_FAILED"));
  db.failModel = null;
});

test("reset: confirmation, strict body, HMAC binding, expiry and current OWNER password fail before writes", async t => {
  const { service, request, state } = await harness(t);
  const preview = await service.preview("root");
  const body = bodyFor(preview);
  const snapshot = business();
  for (const extra of [{ mode: "test" }, { skipBackup: true }, { password: "" }]) {
    await assert.rejects(service.execute("root", { ...body, ...extra }), failure("RESET_INVALID_REQUEST"));
  }
  for (const confirmation of [undefined, "RESET", "reset sxb vpn", "RESET SXB VPN "]) {
    await assert.rejects(service.execute("root", { ...body, confirmation }), failure("RESET_CONFIRMATION_REQUIRED"));
  }
  const denied = await request("root", "POST", "/ops/reset/execute", { ...body, password: "wrong-password" });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "RESET_REAUTH_FAILED");
  await assert.rejects(service.execute("root", { ...body, challenge: `${body.challenge}tampered` }), failure("RESET_CHALLENGE_INVALID"));
  const claims = jwt.decode(body.challenge);
  const key = createHmac("sha256", process.env.JWT_SECRET).update("sxb:production-reset:v1").digest();
  for (const change of [{ version: 2 }, { mode: "preview" }, { exp: claims.exp + 1 }, { aud: "sxb:profile-unlock" }]) {
    await assert.rejects(service.execute("root", {
      ...body, challenge: jwt.sign({ ...claims, ...change }, key, { algorithm: "HS256" }),
    }), failure("RESET_CHALLENGE_INVALID"));
  }
  await assert.rejects(service.execute("admin", body), failure("RESET_CHALLENGE_INVALID"));
  row("User", "root").passwordHash = bcrypt.hashSync("rotated-owner-password", 4);
  await assert.rejects(service.execute("root", body), failure("RESET_REAUTH_FAILED"));
  row("User", "root").passwordHash = snapshot.User.find(user => user.id === "root").passwordHash;
  state.now += (reset.RESET_CHALLENGE_SECONDS + 1) * 1000;
  await assert.rejects(service.execute("root", body), failure("RESET_CHALLENGE_EXPIRED"));
  assert.deepEqual(business(), snapshot);
  assert.equal(state.backupCalls, 0);
  assert.equal(state.events.includes("Setting.upsert"), false);
});

test("reset: malformed request bodies never echo or log password fragments via the generic error boundary", async t => {
  const { url, state } = await harness(t);
  const response = await fetch(`${url}/ops/reset/execute`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token("root")}` },
    body: `{"password":"${secretCanary}",not-valid-json}`,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "RESET_INVALID_REQUEST", code: "RESET_INVALID_REQUEST" });
  assert.equal(state.backupCalls, 0);
});

test("reset: atomic FK-ordered purge retains all admin fields/tokens, audit, ledger, settings and infrastructure", async t => {
  const { service, request, state } = await harness(t);
  const preview = await service.preview("root");
  const original = structuredClone(db.state);
  state.beforeCommit = () => {
    assert.ok(db.state.VpnClient.length > 0, "business data is uncommitted inside callback");
    assert.equal(db.state.Setting.find(row => row.key === reset.MAINTENANCE_KEY).value, "true");
  };
  const result = await request("root", "POST", "/ops/reset/execute", bodyFor(preview));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.status, "completed");
  assert.equal(result.body.maintenanceRestored, true);
  assert.deepEqual(result.body.deletedCounts, preview.counts);
  assert.ok(Object.values(result.body.countsAfter).every(value => value === 0));
  assert.deepEqual(db.state.User, original.User.filter(user => ["OWNER", "ADMIN", "SUPER_ADMIN"].includes(user.roleId)));
  assert.deepEqual(db.state.AdminToken, original.AdminToken.filter(token => ["root", "admin", "super"].includes(token.userId)));
  for (const name of ["Role", "Permission", "RolePermission", "VPSServer", "ServerConfig", "ResellerQuotaMovement"]) {
    assert.deepEqual(db.state[name], original[name], name);
  }
  assert.deepEqual(db.state.Setting.filter(row => !row.key.startsWith(reset.RESET_SETTING_PREFIX)), original.Setting);
  assert.deepEqual(db.state.AuditLog.slice(0, 2), original.AuditLog.map(row => row.userId === "u1" ? { ...row, userId: null } : row));
  assert.equal(db.state.AuditLog.length, 3);
  assert.equal(db.state.AuditLog[2].userId, "root");
  assert.equal(db.state.AuditLog[2].visibleOwnerOnly, true);
  assert.equal(state.backupCalls, 1);
  assert.equal(state.invalidations, 1);
  assert.ok(state.events.indexOf("backup") < state.events.indexOf("MobileHealthReport.deleteMany"));
  assert.ok(state.events.indexOf("purge:commit") < state.events.indexOf("restore:commit"));
  assert.equal(db.state.Setting.some(row => row.key === reset.RESET_EXECUTION_KEY), false);
});

test("reset: snapshot rejects new users, bindings, role promotions and configuration lock changes under the table lock", async t => {
  const { service, state } = await harness(t);
  const mutations = [
    () => db.create("User", { id: "new-user", name: "New", email: "new@example.test", roleId: "CLIENT", passwordHash: "hash" }, db.state),
    () => { row("User", "r1").roleId = "ADMIN"; },
    () => { row("VpnProfile", "p1").lockVersion++; },
    () => { row("Subscription", "sub").profileId = "changed-profile"; },
    () => db.state.VpnProfileReseller.push({ profileId: "p1", resellerId: "res-r2" }),
  ];
  for (const mutate of mutations) {
    const before = structuredClone(db.state);
    const preview = await service.preview("root");
    state.beforeTables = mutate;
    await assert.rejects(service.execute("root", bodyFor(preview)), failure("RESET_PREVIEW_CHANGED"));
    state.beforeTables = null;
    assert.equal(state.backupCalls, 0);
    assert.ok(!state.events.some(event => event === "User.deleteMany"));
    db.state = before;
  }
});

test("reset: traffic and ephemeral health/lastSeen/quota deltas do not stale the plan and are fully purged", async t => {
  const { service } = await harness(t);
  const preview = await service.preview("root");
  row("VpnClient", "c1").lastSeenAt = new Date();
  row("VpnClient", "c1").quotaUsed += 29n;
  row("Subscription", "sub").lastSyncAt = new Date();
  row("Subscription", "sub").quotaUsed += 17n;
  row("SshAccount", "ssh").quotaUsed += 11n;
  row("Reseller", "res-r1").quotaUsedBytes += 42n;
  db.create("TrafficUsage", { clientId: "c1", download: 31n }, db.state);
  db.create("MobileHealthReport", { reportId: "new-report", deviceId: "health-device", tunnelState: "connected" }, db.state);
  const receipt = await service.execute("root", bodyFor(preview));
  assert.equal(receipt.deletedCounts.traffic, preview.counts.traffic + 1);
  assert.equal(receipt.deletedCounts.healthReports, preview.counts.healthReports + 1);
  assert.ok(Object.values(receipt.countsAfter).every(count => count === 0));
});

test("reset: failed backup and transaction rollback leave business untouched and maintenance restored", async t => {
  let failBackup = true;
  const { service, state } = await harness(t, { backup: async ({ resetId }) => {
    if (failBackup) throw new Error(`postgresql://owner:${secretCanary}@private-host/db`);
    return { id: resetId, bytes: 2048, sha256: "c".repeat(64) };
  } });
  const before = business();
  const body = bodyFor(await service.preview("root"));
  await assert.rejects(service.execute("root", body), failure("RESET_BACKUP_FAILED"));
  assert.deepEqual(business(), before);
  assert.equal(state.events.includes("MobileHealthReport.deleteMany"), false);
  failBackup = false;
  state.failDelete = "SshPayload";
  await assert.rejects(service.execute("root", body), failure("RESET_FAILED"));
  assert.deepEqual(business(), before);
  state.failDelete = null;
  state.failCommit = true;
  await assert.rejects(service.execute("root", body), failure("RESET_FAILED"));
  assert.deepEqual(business(), before);
  assert.equal(state.invalidations, 0);
  assert.equal(db.state.Setting.find(row => row.key === reset.MAINTENANCE_KEY).value, "false");
  assert.equal(db.state.Setting.some(row => row.key === reset.RESET_EXECUTION_KEY), false);
});

test("reset: invalid backup metadata and request cancellation cannot authorize a single deletion", async t => {
  let metadata;
  const controller = new AbortController();
  const { service, state } = await harness(t, { backup: async ({ resetId }) => {
    if (metadata === "abort") {
      controller.abort();
      return { id: resetId, bytes: 2048, sha256: "c".repeat(64) };
    }
    return metadata;
  } });
  const original = business();
  const body = bodyFor(await service.preview("root"));
  for (const value of [
    { id: "fake", bytes: 0, sha256: "c".repeat(64) },
    { id: "fake", bytes: 2048, sha256: "not-a-hash" },
    { id: "fake", bytes: 2048, sha256: "c".repeat(64), path: secretCanary },
  ]) {
    metadata = value;
    await assert.rejects(service.execute("root", body), failure("RESET_BACKUP_FAILED"));
    assert.deepEqual(business(), original);
  }
  metadata = "abort";
  await assert.rejects(service.execute("root", body, { signal: controller.signal }), failure("RESET_FAILED"));
  assert.deepEqual(business(), original);
  assert.equal(state.events.includes("MobileHealthReport.deleteMany"), false);
  assert.equal(db.state.Setting.find(row => row.key === reset.MAINTENANCE_KEY).value, "false");
});

test("reset: one database admits only one reset, including across service instances and public maintenance writes", async t => {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const { service, state, serviceOptions } = await harness(t, { backup: async ({ resetId }) => {
    enter();
    await hold;
    return { id: resetId, bytes: 2048, sha256: "d".repeat(64) };
  } });
  const body = bodyFor(await service.preview("root"));
  const running = service.execute("root", body);
  await entered;
  try {
    await assert.rejects(reset.createResetService(serviceOptions).execute("root", body), failure("RESET_IN_PROGRESS"));
    await assert.rejects(service.preview("root"), failure("RESET_IN_PROGRESS"));
    assert.deepEqual(await service.status("root"), { mode: "production", status: "in_progress", recoveryAvailable: false });
    await assert.rejects(reset.setMaintenanceMode(false), failure("RESET_IN_PROGRESS"));
    assert.equal(db.state.Setting.find(row => row.key === reset.MAINTENANCE_KEY).value, "true");
  } finally { release(); await running; }
  assert.equal(state.backupCalls, 1);
  assert.equal(state.invalidations, 1);
});

test("reset: exact replay after TTL returns the fixed receipt and never purges newly created data", async t => {
  const { service, state } = await harness(t);
  const body = bodyFor(await service.preview("root"));
  const first = await service.execute("root", body);
  db.create("VpnClient", { id: "new-admin-client", userId: "admin", token: "SXB-NEW-AFTER-RESET" }, db.state);
  state.now += (reset.RESET_CHALLENGE_SECONDS + 2) * 1000;
  assert.deepEqual(await service.execute("root", body), first);
  assert.equal(db.state.VpnClient.length, 1);
  assert.equal(state.backupCalls, 1);
  assert.equal(state.invalidations, 1);
  state.now += 31 * 86_400_000;
  await assert.rejects(service.execute("root", body), failure("RESET_CHALLENGE_EXPIRED"));
  assert.deepEqual(await service.status("root"), { mode: "production", status: "idle", recoveryAvailable: false });
  assert.equal(db.state.VpnClient.length, 1);
});

test("reset: receipt retention is bounded and an evicted nonce cannot repeat even an already empty reset", async t => {
  const { service, state } = await harness(t);
  await service.execute("root", bodyFor(await service.preview("root")));
  const emptyBody = bodyFor(await service.preview("root"));
  await service.execute("root", emptyBody);
  const nonce = jwt.decode(emptyBody.challenge).nonce;
  db.state.Setting = db.state.Setting.filter(row => row.key !== `${reset.RESET_RECEIPT_PREFIX}${nonce}`);
  await assert.rejects(service.execute("root", emptyBody), failure("RESET_PREVIEW_CHANGED"));
  assert.equal(state.backupCalls, 2);
  const template = JSON.parse(db.state.Setting.find(row => row.key.startsWith(reset.RESET_RECEIPT_PREFIX)).value);
  const oldKey = `${reset.RESET_RECEIPT_PREFIX}${randomBytes(32).toString("hex")}`;
  db.state.Setting.push({ key: oldKey, value: JSON.stringify({
    ...template, receipt: { ...template.receipt, completedAt: new Date(state.now - 31 * 86_400_000).toISOString() },
  }) });
  for (let index = 0; index < reset.RESET_RECEIPT_LIMIT + 1; index++) {
    db.state.Setting.push({
      key: `${reset.RESET_RECEIPT_PREFIX}${randomBytes(32).toString("hex")}`,
      value: JSON.stringify({ ...template, receipt: { ...template.receipt, resetId: randomUUID() } }),
    });
  }
  const last = await service.execute("root", bodyFor(await service.preview("root")));
  const retained = db.state.Setting.filter(row => row.key.startsWith(reset.RESET_RECEIPT_PREFIX));
  assert.equal(retained.length, reset.RESET_RECEIPT_LIMIT);
  assert.equal(retained.some(row => row.key === oldKey), false);
  assert.ok(retained.some(row => JSON.parse(row.value).receipt.resetId === last.resetId));
});

test("reset: maintenance restoration failure is explicit and expired-nonce retry recovers without a second purge", async t => {
  const { service, state, request } = await harness(t);
  const body = bodyFor(await service.preview("root"));
  state.failRestore = true;
  const response = await request("root", "POST", "/ops/reset/execute", body);
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "RESET_MAINTENANCE_RESTORE_FAILED");
  assert.equal(response.body.status, "completed");
  assert.equal(response.body.maintenanceRestored, false);
  assert.equal(db.state.VpnClient.length, 0);
  assert.equal(db.state.Setting.find(row => row.key === reset.MAINTENANCE_KEY).value, "true");
  assert.equal(state.invalidations, 1);
  state.failRestore = false;
  state.now += (reset.RESET_CHALLENGE_SECONDS + 2) * 1000;
  const recovered = await service.execute("root", body);
  assert.equal(recovered.resetId, response.body.resetId);
  assert.equal(recovered.maintenanceRestored, true);
  assert.equal(state.backupCalls, 1);
  assert.equal(db.state.Setting.find(row => row.key === reset.MAINTENANCE_KEY).value, "false");
});

test("reset: expired-nonce recovery after a failed backup restores only maintenance, never resumes the purge", async t => {
  const { service, state } = await harness(t, { backup: async () => { throw new Error(secretCanary); } });
  const before = business();
  const body = bodyFor(await service.preview("root"));
  state.failRestore = true;
  await assert.rejects(service.execute("root", body), error => {
    assert.equal(error.code, "RESET_MAINTENANCE_RESTORE_FAILED");
    assert.notEqual(error.details.status, "completed");
    return true;
  });
  assert.deepEqual(business(), before);
  state.failRestore = false;
  state.now += (reset.RESET_CHALLENGE_SECONDS + 2) * 1000;
  await assert.rejects(service.execute("root", body), error => {
    assert.equal(error.code, "RESET_RECOVERED_NOT_EXECUTED");
    assert.equal(error.details.maintenanceRestored, true);
    assert.equal(error.details.status, "not_completed");
    assert.equal(error.details.requiresFreshPreview, true);
    return true;
  });
  assert.equal(state.backupCalls, 1);
  assert.deepEqual(business(), before);
  await assert.rejects(service.execute("root", body), failure("RESET_CHALLENGE_EXPIRED"));
});

test("reset: lost COMMIT response is resolved using the durable receipt, not a repeated DELETE", async t => {
  const { service, state } = await harness(t);
  const body = bodyFor(await service.preview("root"));
  state.loseCommitResponse = true;
  const receipt = await service.execute("root", body);
  assert.equal(receipt.maintenanceRestored, true);
  assert.equal(state.backupCalls, 1);
  assert.equal(state.invalidations, 1);
  assert.deepEqual(await service.execute("root", body), receipt);
});

test("reset: original absent/enabled maintenance values are restored and invalidation failure cannot strand maintenance", async t => {
  const { service } = await harness(t, { invalidateAccess: () => { throw new Error(secretCanary); } });
  db.state.Setting = db.state.Setting.filter(row => row.key !== reset.MAINTENANCE_KEY);
  await assert.rejects(service.execute("root", bodyFor(await service.preview("root"))), error => {
    assert.equal(error.code, "RESET_FAILED");
    assert.equal(error.details.status, "completed");
    assert.equal(error.details.maintenanceRestored, true);
    return true;
  });
  assert.equal(db.state.Setting.some(row => row.key === reset.MAINTENANCE_KEY), false);
  db.state.Setting.push({ key: reset.MAINTENANCE_KEY, value: "true" });
  await assert.rejects(service.execute("root", bodyFor(await service.preview("root"))), failure("RESET_FAILED"));
  assert.equal(db.state.Setting.find(row => row.key === reset.MAINTENANCE_KEY).value, "true");
});

test("reset: status recovers the exact challenge after process loss only for its original OWNER", async t => {
  const { service, serviceOptions, state, request } = await harness(t);
  db.create("User", {
    id: "other-owner", name: "Other owner", email: "owner-two@example.test", roleId: "OWNER",
    passwordHash: bcrypt.hashSync(password, 4), status: "active",
  }, db.state);
  assert.deepEqual((await request("root", "GET", "/ops/reset/status")).body, {
    mode: "production", status: "idle", recoveryAvailable: false,
  });
  const preview = await service.preview("root");
  const otherBody = bodyFor(await service.preview("other-owner"));
  state.failRestore = true;
  await assert.rejects(service.execute("root", bodyFor(preview)), failure("RESET_MAINTENANCE_RESTORE_FAILED"));
  const previous = structuredClone(db.state);
  const visible = await request("root", "GET", "/ops/reset/status");
  assert.equal(visible.status, 200);
  assert.equal(visible.headers.get("cache-control"), "no-store");
  assert.equal(visible.body.status, "recovery_required");
  assert.equal(visible.body.recoveryAvailable, true);
  assert.equal(visible.body.challenge, preview.challenge);
  assert.equal(visible.body.expiresAt, preview.expiresAt);
  assert.equal(visible.body.receipt.status, "completed");
  assert.equal(visible.body.receipt.maintenanceRestored, false);
  assert.deepEqual((await request("other-owner", "GET", "/ops/reset/status")).body, {
    mode: "production", status: "in_progress", recoveryAvailable: false,
  });
  assert.deepEqual(db.state, previous, "status must not restore maintenance or mutate data");
  await assert.rejects(service.execute("other-owner", otherBody), failure("RESET_IN_PROGRESS"));
  assert.deepEqual(db.state, previous);
  state.failRestore = false;
  const restarted = reset.createResetService(serviceOptions);
  const receipt = await restarted.execute("root", bodyFor(visible.body));
  const completed = await restarted.status("root");
  assert.equal(completed.status, "completed");
  assert.equal(completed.challenge, preview.challenge);
  assert.deepEqual(completed.receipt, receipt);
  assert.deepEqual(await restarted.status("other-owner"), { mode: "production", status: "idle", recoveryAvailable: false });
  assert.equal(state.backupCalls, 1);
});

test("reset: orphan recovery consumes an unexpired nonce and requires a fresh preview before any purge", async t => {
  let failBackup = true;
  const { service, state, request } = await harness(t, { backup: async ({ resetId }) => {
    if (failBackup) throw new Error(secretCanary);
    return { id: resetId, bytes: 2048, sha256: "a".repeat(64) };
  } });
  const before = business();
  const preview = await service.preview("root");
  state.failRestore = true;
  await assert.rejects(service.execute("root", bodyFor(preview)), failure("RESET_MAINTENANCE_RESTORE_FAILED"));
  const pending = await service.status("root");
  assert.equal(pending.status, "recovery_required");
  assert.equal(pending.receipt, undefined);
  assert.equal(pending.challenge, preview.challenge);
  assert.deepEqual(business(), before);
  state.failRestore = false;
  failBackup = false;
  const recovered = await request("root", "POST", "/ops/reset/execute", bodyFor(pending));
  assert.equal(recovered.status, 409);
  assert.deepEqual(recovered.body, {
    error: "RESET_RECOVERED_NOT_EXECUTED", code: "RESET_RECOVERED_NOT_EXECUTED",
    resetId: pending.resetId, status: "not_completed", maintenanceRestored: true, requiresFreshPreview: true,
  });
  assert.equal(state.backupCalls, 1);
  assert.equal(state.invalidations, 0);
  assert.deepEqual(business(), before);
  await assert.rejects(service.execute("root", bodyFor(preview)), failure("RESET_PREVIEW_CHANGED"));
  assert.equal(state.backupCalls, 1);
  const receipt = await service.execute("root", bodyFor(await service.preview("root")));
  assert.equal(receipt.status, "completed");
  assert.equal(state.backupCalls, 2);
});

test("reset: old real mobile JWT and access ticket observe deletion and the outstanding wait is invalidated after commit", async t => {
  const { service, state } = await harness(t);
  const oldToken = token("u1");
  const mobile = async (route, credential = oldToken, options = {}) => {
    const response = await fetch(`${base}${route}`, {
      ...options, headers: { Authorization: `Bearer ${credential}`, "X-SXB-Device-ID": deviceId, "Content-Type": "application/json" },
    });

    return { status: response.status, body: await response.json() };
  };
  const before = await mobile("/mobile/access-state");
  assert.equal(before.status, 200);
  const ticket = await mobile("/mobile/access-ticket", oldToken, { method: "POST", body: "{}" });
  assert.equal(ticket.status, 200);
  const waiting = mobile(`/mobile/access-state?revision=${before.body.revision}&wait=25`, ticket.body.ticket);
  const deadline = Date.now() + 1500;
  while (routes.accessStateHub.size !== 1 && Date.now() < deadline) await delay(5);
  assert.equal(routes.accessStateHub.size, 1);
  await service.execute("root", bodyFor(await service.preview("root")));
  const change = await waiting;
  assert.equal(change.status, 200);
  assert.equal(change.body.device.status, "deleted");
  assert.deepEqual(change.body.subscriptions, []);
  assert.equal(state.invalidations, 1);
  assert.equal(routes.accessStateHub.size, 0);
  for (const credential of [oldToken, ticket.body.ticket]) {
    const deleted = await mobile("/mobile/access-state", credential);
    assert.equal(deleted.body.device.code, "DEVICE_DELETED");
    assert.equal(deleted.body.device.activationRequired, true);
  }
  assert.notEqual((await mobile("/mobile/vpn/config?subscriptionId=sub")).status, 200);
  db.failModel = "VpnClient";
  assert.equal((await mobile("/mobile/access-state")).status, 503);
  db.failModel = null;
});

test("reset: the static write-lock allowlist covers every Prisma table without DROP, TRUNCATE or trigger bypass", () => {
  const names = [...reset.RESET_TABLE_LOCK_SQL.matchAll(/"([^"]+)"/g)].map(match => match[1]).sort();
  assert.deepEqual(names, [...models.values()].map(model => model.dbName).sort());
  assert.match(reset.RESET_TABLE_LOCK_SQL, /IN SHARE ROW EXCLUSIVE MODE$/);
  assert.doesNotMatch(reset.RESET_TABLE_LOCK_SQL, /ACCESS EXCLUSIVE|TRUNCATE|DROP|DISABLE TRIGGER/i);
});

import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(path.join(root, "backend", "package.json"));
const { build } = require("esbuild");
const { Prisma } = require("@prisma/client");
const express = require("express");
const jwt = require("jsonwebtoken");
const models = new Map(Prisma.dmmf.datamodel.models.map(model => [model.name, model]));
const modelKey = name => name[0].toLowerCase() + name.slice(1);
const GO = 1024n ** 3n;
const tomorrow = () => new Date(Date.now() + 86400000);
const yesterday = () => new Date(Date.now() - 86400000);
const permissionNames = [
  "clients.view", "clients.create", "clients.manage", "clients.delete",
  "subscription.view", "subscription.manage", "tokens.view", "tokens.create", "tokens.revoke",
  "vouchers.view", "vouchers.create", "vouchers.redeem", "vouchers.revoke",
  "users.view", "users.create", "users.delete", "reseller.manage", "rbac.manage",
  "analytics.read", "vpnprofile.view",
];

// Prisma-shaped isolated store: real routers, validators, auth and transactions
// run unchanged. Scalar fields and unique constraints come from the real schema.
class Database {
  state = {};
  tail = Promise.resolve();
  failModel = null;

  constructor() {
    for (const model of models.values()) {
      this.state[model.name] = [];
      this[modelKey(model.name)] = this.delegate(model.name, () => this.state);
    }
  }

  related(modelName, row, field, state) {
    const target = models.get(field.type);
    if (field.relationFromFields.length) {
      return state[target.name].find(candidate => field.relationFromFields.every(
        (from, index) => row[from] != null && row[from] === candidate[field.relationToFields[index]]
      )) ?? null;
    }
    const inverse = target.fields.find(candidate =>
      candidate.kind === "object" && candidate.relationName === field.relationName &&
      candidate.relationFromFields.length
    );
    const found = state[target.name].filter(candidate => inverse.relationFromFields.every(
      (from, index) => candidate[from] === row[inverse.relationToFields[index]]
    ));
    return field.isList ? found : found[0] ?? null;
  }

  matches(name, row, where, state) {
    if (!where) return true;
    return Object.entries(where).every(([key, value]) => {
      if (value === undefined) return true;
      if (key === "AND") return (Array.isArray(value) ? value : [value]).every(v => this.matches(name, row, v, state));
      if (key === "OR") return value.some(v => this.matches(name, row, v, state));
      if (key === "NOT") return !(Array.isArray(value) ? value : [value]).some(v => this.matches(name, row, v, state));
      const field = models.get(name).fields.find(f => f.name === key);
      if (!field && value && typeof value === "object") return this.matches(name, row, value, state);
      assert.ok(field, `Unknown ${name} filter: ${key}`);
      if (field.kind === "object") {
        const relation = this.related(name, row, field, state);
        if (field.isList) {
          if (value.some) return relation.some(v => this.matches(field.type, v, value.some, state));
          if (value.none) return !relation.some(v => this.matches(field.type, v, value.none, state));
          if (value.every) return relation.every(v => this.matches(field.type, v, value.every, state));
        }
        if (value === null || value.is === null) return relation === null;
        if (value.isNot === null) return relation !== null;
        return !!relation && this.matches(field.type, relation, value.is ?? value, state);
      }
      const current = row[key] ?? null;
      if (value === null) return current === null;
      if (value instanceof Date) return current?.getTime() === value.getTime();
      if (typeof value !== "object") return current === value;
      return Object.entries(value).every(([op, operand]) => {
        if (op === "equals") return current === operand;
        if (op === "in") return operand.includes(current);
        if (op === "notIn") return !operand.includes(current);
        if (op === "not") return current !== operand;
        if (op === "gt") return current > operand;
        if (op === "gte") return current >= operand;
        if (op === "lt") return current < operand;
        if (op === "lte") return current <= operand;
        if (op === "mode") return true;
        if (op === "contains") return String(current).includes(operand);
        throw new Error(`Unsupported filter ${op}`);
      });
    });
  }

  project(name, row, args, state) {
    if (!row) return null;
    const result = args.select ? {} : structuredClone(row);
    for (const [key, value] of Object.entries(args.select ?? args.include ?? {})) {
      if (!value) continue;
      const field = models.get(name).fields.find(f => f.name === key);
      assert.ok(field, `Unknown ${name} selection: ${key}`);
      if (field.kind !== "object") result[key] = row[key] ?? null;
      else {
        const relation = this.related(name, row, field, state);
        const nested = value === true ? {} : value;
        result[key] = field.isList
          ? this.query(field.type, relation, nested, state)
          : this.project(field.type, relation, nested, state);
      }
    }
    return result;
  }

  query(name, rows, args, state) {
    let result = rows.filter(row => this.matches(name, row, args.where, state));
    const ordering = args.orderBy ? (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]) : [];
    result.sort((a, b) => {
      for (const order of ordering) {
        const [key, direction] = Object.entries(order)[0];
        if (a[key] > b[key]) return direction === "desc" ? -1 : 1;
        if (a[key] < b[key]) return direction === "desc" ? 1 : -1;
      }
      return 0;
    });
    if (args.take != null) result = result.slice(0, args.take);
    return result.map(row => this.project(name, row, args, state));
  }

  mutate(name, row, data, state) {
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      const field = models.get(name).fields.find(f => f.name === key);
      assert.ok(field, `Unknown ${name} write: ${key}`);
      if (field.kind === "object") {
        const related = this.related(name, row, field, state);
        if (value.update) this.mutate(field.type, related, value.update, state);
        else if (value.create) {
          const inverse = models.get(field.type).fields.find(f => f.relationName === field.relationName && f.relationFromFields.length);
          this.create(field.type, {
            ...value.create,
            [inverse.relationFromFields[0]]: row[inverse.relationToFields[0]],
          }, state);
        } else throw new Error(`Unsupported nested write ${key}`);
      } else {
        const resolved = value && typeof value === "object" && !(value instanceof Date) && field.type !== "Json"
          ? value.increment !== undefined ? (row[key] ?? 0n) + value.increment : value.set
          : value;
        if (resolved != null) {
          if (field.type === "Int") assert.ok(Number.isInteger(resolved), `${name}.${key} must be an integer`);
          if (field.type === "BigInt") assert.equal(typeof resolved, "bigint", `${name}.${key}`);
          if (field.type === "DateTime") assert.ok(resolved instanceof Date && Number.isFinite(+resolved), `${name}.${key}`);
          if (field.type === "String") assert.equal(typeof resolved, "string", `${name}.${key}`);
        }
        row[key] = resolved;
      }
    }
    const unique = models.get(name).fields.filter(f => f.isUnique || f.isId).map(f => [f.name]);
    unique.push(...models.get(name).uniqueFields);
    for (const fields of unique) {
      if (fields.some(field => row[field] == null)) continue;
      if (state[name].some(other => other !== row && fields.every(field => other[field] === row[field]))) {
        throw Object.assign(new Error("Unique constraint"), { code: "P2002", meta: { target: fields } });
      }
    }
    return row;
  }

  create(name, data, state) {
    const row = {};
    for (const field of models.get(name).fields.filter(f => f.kind !== "object")) {
      if (field.default && typeof field.default === "object") {
        row[field.name] = field.default.name === "now" ? new Date() : randomUUID();
      } else if (field.default !== undefined) {
        row[field.name] = field.type === "BigInt" ? BigInt(field.default) : field.default;
      } else if (field.isUpdatedAt) row[field.name] = new Date();
      else if (!field.isRequired) row[field.name] = null;
    }
    this.mutate(name, row, data, state);
    state[name].push(row);
    return row;
  }

  delegate(name, getState) {
    const run = callback => async (args = {}) => {
      if (this.failModel === name) throw new Error("Simulated database outage");
      return callback(args, getState());
    };
    return {
      findMany: run((args, state) => this.query(name, state[name], args, state)),
      findUnique: run((args, state) => this.query(name, state[name], args, state)[0] ?? null),
      findFirst: run((args, state) => this.query(name, state[name], args, state)[0] ?? null),
      count: run((args, state) => this.query(name, state[name], args, state).length),
      create: run((args, state) => this.project(name, this.create(name, args.data, state), args, state)),
      createMany: run((args, state) => {
        for (const data of args.data) this.create(name, data, state);
        return { count: args.data.length };
      }),
      update: run((args, state) => {
        const row = state[name].find(r => this.matches(name, r, args.where, state));
        if (!row) throw Object.assign(new Error("Not found"), { code: "P2025" });
        this.mutate(name, row, args.data, state);
        return this.project(name, row, args, state);
      }),
      updateMany: run((args, state) => {
        const rows = state[name].filter(r => this.matches(name, r, args.where, state));
        for (const row of rows) this.mutate(name, row, args.data, state);
        return { count: rows.length };
      }),
      delete: run((args, state) => {
        const index = state[name].findIndex(r => this.matches(name, r, args.where, state));
        if (index < 0) throw Object.assign(new Error("Not found"), { code: "P2025" });
        return state[name].splice(index, 1)[0];
      }),
      deleteMany: run((args, state) => {
        const previous = state[name].length;
        state[name] = state[name].filter(r => !this.matches(name, r, args.where, state));
        return { count: previous - state[name].length };
      }),
      upsert: run((args, state) => {
        const row = state[name].find(r => this.matches(name, r, args.where, state));
        return this.project(name, row
          ? this.mutate(name, row, args.update, state)
          : this.create(name, args.create, state), args, state);
      }),
      aggregate: run((args, state) => {
        const rows = state[name].filter(r => this.matches(name, r, args.where, state));
        return { _sum: Object.fromEntries(Object.keys(args._sum).map(key =>
          [key, rows.reduce((sum, row) => sum + BigInt(row[key] ?? 0), 0n)])) };
      }),
    };
  }

  async $transaction(callback) {
    const previous = this.tail;
    let release;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    const draft = structuredClone(this.state);
    const tx = { $queryRawUnsafe: async () => [], $executeRawUnsafe: async () => 1 };
    for (const model of models.values()) tx[modelKey(model.name)] = this.delegate(model.name, () => draft);
    try {
      const result = await callback(tx);
      this.state = draft;
      return result;
    } finally {
      release();
    }
  }
}

const db = new Database();
globalThis.__sxbResellerHttpDb = db;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "sxb-http-regression-access-only";
process.env.REFRESH_SECRET = "sxb-http-regression-refresh-only";
process.env.ENCRYPTION_KEY = "1".repeat(32);
process.env.PROVISION_SECRET = "sxb-http-regression-provision-only";
process.env.DATABASE_URL = "";
const temporary = await mkdtemp(path.join(root, "backend", "node_modules", ".sxb-http-"));
const bundlePath = path.join(temporary, "routes.cjs");
const routeNames = ["devices", "clients", "subscriptions", "tokens", "vouchers", "mobile", "resellers", "users", "rbac", "auth", "sessions", "dashboard", "provision"];
await build({
  stdin: {
    contents: routeNames.map(name => `export { default as ${name} } from "./server/routes/${name}";`).join("\n") +
      '\nexport { applyUsageDelta } from "./server/routes/mobile";',
    resolveDir: root,
    loader: "ts",
  },
  bundle: true, platform: "node", format: "cjs", packages: "external",
  outfile: bundlePath, logLevel: "silent",
  plugins: [{
    name: "isolated-database",
    setup(builder) {
      builder.onResolve({ filter: /(?:^|\/)database$/ }, () => ({ path: "database", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: `export const prisma = globalThis.__sxbResellerHttpDb;
          export const inMemoryDb = {};
          export async function logDbActivity() {}`,
        loader: "js",
      }));
    },
  }],
});
const routes = require(bundlePath);
const app = express();
app.use(express.json());
for (const name of routeNames) app.use(`/api/${name}`, routes[name]);
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
  delete globalThis.__sxbResellerHttpDb;
});

beforeEach(() => {
  db.failModel = null;
  for (const model of models.values()) db.state[model.name] = [];
  for (const role of ["OWNER", "SUPER_ADMIN", "ADMIN", "RESELLER", "SUPPORT", "CLIENT"]) {
    db.state.Role.push({ id: role, name: role });
  }
  db.state.Permission = permissionNames.map(name => ({ id: name, name }));
  for (const role of ["SUPER_ADMIN", "ADMIN", "RESELLER", "SUPPORT"]) {
    for (const permission of permissionNames) db.state.RolePermission.push({ roleId: role, permissionId: permission });
  }
  for (const [id, role] of [["admin","ADMIN"],["root","OWNER"],["super","SUPER_ADMIN"],["r1","RESELLER"],["r2","RESELLER"],["support","SUPPORT"],["u1","CLIENT"],["u2","CLIENT"],["direct-user","CLIENT"]]) {
    db.state.User.push({ id, roleId: role, status: "active", name: id, email: `${id}@example.test`, passwordHash: "never-expose" });
  }
  db.state.Reseller = ["r1", "r2"].map(id => ({
    id: `res-${id}`, userId: id, status: "active", quotaBytes: 10n * GO,
    quotaUsedBytes: 0n, accessExpiresAt: tomorrow(),
  }));
  db.state.VpnClient = [["c1","u1","res-r1"],["c2","u2","res-r2"],["direct","direct-user",null]].map(([id,userId,resellerId]) => ({
    id, userId, resellerId, status: "active", token: `SXB-USER-${id.toUpperCase().padEnd(4,"A")}-BBBB-CCCC`,
    quotaTotal: null, quotaUsed: 0n, expireAt: tomorrow(), deviceId: null, activatedAt: null, deviceLimit: 1,
  }));
  db.state.VpnProfile = [{ id: "p1", name: "Service privé", status: "active", protocol: "ssh", host: "secret.invalid", password: "encrypted", port: 22 }];
  db.state.VpnProfileReseller = [{ profileId: "p1", resellerId: "res-r1" }];
});

async function api(actor, method, route, body) {
  const user = db.state.User.find(row => row.id === actor);
  const token = user ? jwt.sign({
    userId: user.id, email: user.email, role: user.roleId,
    ...(actor === "u1" ? { clientId: "c1" } : {}),
  }, process.env.JWT_SECRET, { expiresIn: "15m" }) : null;
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
const ok = (response, status = 200) => assert.equal(response.status, status, JSON.stringify(response.body));
const row = (model, id) => db.state[model].find(value => value.id === id);
const createSub = (actor = "r1", quotaGB = 5, clientId = "c1") =>
  api(actor, "POST", "/subscriptions", { clientId, profileId: "p1", quotaGB, durationDays: 30 });

test("activation: a fresh dashboard token binds once and stays in its reseller roster", async () => {
  const generated = await api("r1", "POST", "/devices/generate-token", { deviceId: "DASHBOARD-TEMP-123", label: "Mon client" });
  ok(generated, 201);
  const id = generated.body.id;
  const token = generated.body.token;
  assert.equal(db.state.Subscription.length, 0);
  const attempts = await Promise.all(["ANDROID-ONE","ANDROID-TWO"].map(deviceId =>
    api(null, "POST", "/mobile/auth/activate", { token, deviceId })));
  assert.deepEqual(attempts.map(r => r.status).sort(), [200, 409]);
  const device = row("VpnClient", id);
  ok(await api(null, "POST", "/mobile/auth/activate", { token, deviceId: device.deviceId }));
  const own = await api("r1", "GET", "/devices");
  ok(own);
  assert.ok(own.body.devices.some(d => d.id === id));
  const foreign = await api("r2", "GET", "/devices");
  assert.ok(!foreign.body.devices.some(d => d.id === id));
  assert.equal(generated.body.resellerId, "res-r1");
});

test("subscriptions: explicit assignment, exact quota, rollback and cross-owner reductions", async () => {
  const created = await createSub();
  ok(created, 201);
  assert.equal(created.body.subscription.quotaBytes, String(5n * GO));
  assert.equal(created.body.subscription.profile.host, undefined);
  const id = created.body.subscription.id;
  ok(await api("r2", "PUT", `/subscriptions/${id}`, { status: "suspended" }), 404);
  ok(await api("r1", "PUT", `/subscriptions/${id}`, { quotaGB: -5 }), 400);
  ok(await api("r1", "PUT", `/subscriptions/${id}`, { quotaGB: 11 }), 409);
  assert.equal(row("Subscription", id).quotaBytes, 5n * GO);
  ok(await api("r1", "PUT", `/subscriptions/${id}`, { status: "suspended" }));
  assert.equal(row("Reseller","res-r1").quotaUsedBytes, 0n);
  ok(await api("r1", "PUT", `/subscriptions/${id}`, { status: "active" }));
  ok(await api("r1", "POST", `/subscriptions/${id}/revoke`, { reason: "Fin du service" }));
  assert.equal(row("Subscription", id).status, "revoked");
});

for (const actor of ["super", "admin", "r1"]) {
  for (const name of [undefined, "", "   ", "  Forfait choisi  "]) {
    test(`plan assignment accepts an optional name for ${actor}: ${JSON.stringify(name)}`, async () => {
      const created = await api(actor, "POST", "/subscriptions", {
        clientId: "c1",
        profileId: "p1",
        name,
        quotaGB: "01",
        durationDays: 3,
        deviceLimit: 1,
      });
      ok(created, 201);
      const subscription = created.body.subscription;
      assert.equal(subscription.name, name?.trim() || "Service privé — 3j");
      assert.equal(subscription.quotaBytes, String(GO));
      assert.equal(subscription.durationDays, 3);
      assert.equal(subscription.deviceLimit, 1);
      assert.equal(db.state.Subscription.length, 1);
      assert.equal(row("Reseller", "res-r1").quotaUsedBytes, GO);
    });
  }
}

test("optional plan names do not weaken required selections, limits or strict validation", async () => {
  const payload = { clientId: "c1", profileId: "p1", name: "", quotaGB: 1, durationDays: 3, deviceLimit: 1 };
  for (const invalid of [
    { clientId: "" },
    { profileId: "" },
    { name: "n".repeat(161) },
    { quotaGB: 0 },
    { quotaGB: -1 },
    { durationDays: 1.5 },
    { durationDays: 3651 },
    { deviceLimit: 0 },
    { deviceLimit: 101 },
    { unexpected: true },
  ]) {
    const refused = await api("r1", "POST", "/subscriptions", { ...payload, ...invalid });
    ok(refused, 400);
    assert.equal(refused.body.error, "errors.validation");
    assert.ok(refused.body.details.some(issue => typeof issue.message === "string"));
    assert.equal(db.state.Subscription.length, 0);
    assert.equal(row("Reseller", "res-r1").quotaUsedBytes, 0n);
  }
});

test("client naming, suspended renewals and device limits are transactional", async () => {
  const created = await createSub("r1", 8);
  ok(created, 201);
  db.state.VpnClient.push({
    ...row("VpnClient","c1"), id: "suspended", userId: "u1",
    token: "SXB-USER-DDDD-EEEE-FFFF", status: "suspended", quotaTotal: 4n * GO,
  });
  ok(await api("r1","POST","/clients/suspended/renew"), 409);
  assert.equal(row("VpnClient","suspended").status, "suspended");
  ok(await api("r1","PATCH","/clients/c1",{name:"Client nommé",deviceLimit:2}));
  assert.equal(row("User","u1").name, "Client nommé");
  assert.equal(row("VpnClient","c1").deviceLimit, 2);
  ok(await api("r2","PATCH","/clients/c1",{name:"Interdit"}), 403);
});

test("tokens reserve capacity and can only be applied or revoked once", async () => {
  const created = await api("r1","POST","/tokens",{clientId:"c1",quotaGb:6});
  ok(created,201);
  assert.equal(row("Reseller","res-r1").quotaUsedBytes,6n * GO);
  ok(await api("r1","POST","/tokens/generate",{clientId:"c1",quotaGb:5}),409);
  const list = await api("r1","GET","/tokens");
  ok(list);
  assert.ok(!JSON.stringify(list.body).includes("never-expose"));
  const attempts = await Promise.all([1,2].map(() => api("r1","POST","/tokens/validate",{token:created.body.token})));
  assert.deepEqual(attempts.map(r => r.status).sort(),[200,409]);
  assert.equal(row("VpnClient","c1").quotaTotal,6n * GO);
  assert.equal(row("Reseller","res-r1").quotaUsedBytes,6n * GO);
  ok(await api("r2","POST",`/tokens/${created.body.id}/revoke`),404);
  const direct = await api("admin","POST","/tokens",{clientId:"direct",quotaGb:1});
  ok(direct,201);
});

test("vouchers reserve quota, require an explicit client and redeem atomically", async () => {
  const created = await api("r1","POST","/vouchers",{quotaGb:6,durationDays:30,activationDays:90});
  ok(created,201);
  const voucher = created.body.vouchers[0];
  assert.equal(row("Reseller","res-r1").quotaUsedBytes,6n * GO);
  ok(await api("r1","POST","/vouchers",{quotaGb:5}),409);
  const list = await api("r2","GET","/vouchers");
  ok(list);
  assert.equal(list.body.vouchers.length,0);
  ok(await api("r1","POST","/vouchers/redeem",{code:voucher.code}),400);
  ok(await api("r2","POST","/vouchers/redeem",{code:voucher.code,clientId:"c2"}),404);
  const attempts = await Promise.all([1,2].map(() =>
    api("r1","POST","/vouchers/redeem",{code:voucher.code,clientId:"c1"})));
  assert.deepEqual(attempts.map(r => r.status).sort(),[200,409]);
  assert.equal(row("VpnClient","c1").quotaTotal,6n * GO);
  assert.equal(row("Reseller","res-r1").quotaUsedBytes,6n * GO);
  assert.equal(row("Voucher",voucher.id).redeemedClientId,"c1");
});

test("reseller expiry blocks every write but retains records and read access", async () => {
  row("Reseller","res-r1").accessExpiresAt = yesterday();
  const snapshot = structuredClone(db.state);
  for (const [route,body] of [
    ["/devices/generate-token",{deviceId:"ABCDEF123"}],
    ["/users/me",{name:"Changed"}],
    ["/vouchers/missing/revoke",{}],
    ["/sessions/missing/reset",{}],
  ]) {
    const response = await api("r1",route === "/users/me" ? "PATCH":"POST",route,body);
    ok(response,403);
    assert.equal(response.body.code,"RESELLER_EXPIRED");
  }
  ok(await api("r1","GET","/clients"));
  assert.deepEqual(db.state,snapshot);
});

test("permissions are authoritative and reseller accounts cannot gain admin control", async () => {
  ok(await api("r1","POST","/resellers",{name:"x",email:"x@example.test",accessExpiresAt:tomorrow().toISOString()}),403);
  ok(await api("r1","PATCH","/users/admin",{password:"modified"}),403);
  ok(await api("u1","POST","/resellers/res-r1/create-client",{name:"Bad"}),403);
  const sub = await createSub();
  ok(sub,201);
  db.state.RolePermission = db.state.RolePermission.filter(p => !(p.roleId === "RESELLER" && p.permissionId === "subscription.manage"));
  ok(await api("r1","PUT",`/subscriptions/${sub.body.subscription.id}`,{status:"suspended"}),403);
  ok(await api("support","PUT",`/subscriptions/${sub.body.subscription.id}`,{status:"suspended"}),403);
});

test("a database outage is not reported as an expired or invalid token", async () => {
  db.failModel = "User";
  const response = await api("r1","GET","/clients");
  ok(response,503);
  assert.equal(response.body.error,"errors.auth.unavailable");
});

test("session rosters and writes follow client ownership", async () => {
  db.state.ActivationSession = [
    {id:"s1",clientId:"c1",deviceId:"D1",status:"active"},
    {id:"s2",clientId:"c2",deviceId:"D2",status:"active"},
  ];
  const list = await api("r1","GET","/sessions");
  ok(list);
  assert.deepEqual(list.body.sessions.map(s => s.id),["s1"]);
  ok(await api("r1","POST","/sessions/s2/revoke"),404);
  ok(await api("r1","POST","/sessions/s1/revoke"));
  assert.equal(row("VpnClient","c1").status,"suspended");
});

test("administrators create a complete reseller account with validity and no automatic plan", async () => {
  ok(await api("admin","POST","/resellers",{name:"New reseller",email:"new@example.test",quotaGB:20}),400);
  const created = await api("admin","POST","/resellers",{
    name:"New reseller",email:"new@example.test",quotaGB:20,accessExpiresAt:tomorrow().toISOString(),
  });
  ok(created,201);
  assert.equal(created.body.quotaBytes,String(20n * GO));
  assert.equal(row("User",created.body.userId).roleId,"RESELLER");
  const client = await api("admin","POST",`/resellers/${created.body.id}/create-client`,{name:"Customer"});
  ok(client,201);
  assert.match(client.body.token,/^SXB-USER-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(db.state.Subscription.length,0);
});

test("quota dashboard is based on reseller envelopes, not direct client capacity", async () => {
  row("VpnClient","direct").quotaTotal = 1000n * GO;
  const own = await api("r1","GET","/dashboard/stats");
  ok(own);
  assert.equal(own.body.resellerQuota.assignedBytes,String(10n * GO));
  const admin = await api("admin","GET","/dashboard/stats");
  ok(admin);
  assert.equal(admin.body.resellerQuota.assignedBytes,String(20n * GO));
});

test("bulk additions are cumulative, duplicate targets are ignored, and quota cannot overspend", async () => {
  const created = await createSub("r1",2);
  ok(created,201);
  const id = created.body.subscription.id;
  const added = await api("r1","POST","/subscriptions/bulk",{
    action:"add_data",subscriptionIds:[id,id],quotaGB:1,
  });
  ok(added);
  assert.equal(added.body.succeeded,1);
  assert.equal(row("Subscription",id).quotaBytes,3n * GO);
  const concurrent = await Promise.all([1,2].map(() => api("r1","POST","/subscriptions/bulk",{
    action:"add_data",subscriptionIds:[id],quotaGB:1,
  })));
  concurrent.forEach(response => ok(response));
  assert.equal(row("Subscription",id).quotaBytes,5n * GO);
  ok(await api("r1","POST","/subscriptions/bulk",{action:"add_data",subscriptionIds:[id],quotaGB:6}),409);
  assert.equal(row("Subscription",id).quotaBytes,5n * GO);
});

test("traffic counters and reseller consumption remain consistent after retryable failures", async () => {
  const created = await createSub();
  ok(created,201);
  const id = created.body.subscription.id;
  const session = randomUUID();
  db.failModel = "TrafficUsage";
  await assert.rejects(routes.applyUsageDelta("c1",id,20n,session,1,5n));
  assert.equal(row("Subscription",id).quotaUsed,0n);
  assert.equal(row("VpnClient","c1").quotaUsed,0n);
  db.failModel = null;
  assert.equal((await routes.applyUsageDelta("c1",id,20n,session,1,5n)).applied,true);
  assert.equal((await routes.applyUsageDelta("c1",id,20n,session,1,5n)).applied,false);
  assert.equal(row("Subscription",id).quotaUsed,20n);
  assert.equal(db.state.TrafficUsage.length,1);
  assert.equal(db.state.TrafficUsage[0].upload,5n);
  const access = await api("r1","GET","/dashboard/stats");
  ok(access);
  assert.equal(access.body.resellerQuota.consumedBytes,"20");
});

test("legacy global vouchers keep working without granting access to newly orphaned vouchers", async () => {
  db.state.Voucher.push({id:"legacy",code:"VCH-AAAAA-BBBBB",quota:1n * GO,durationDays:30,isRedeemed:false,status:"active",resellerId:null,expiresAt:null});
  ok(await api("u1","POST","/mobile/packages/activate",{code:"VCH-AAAAA-BBBBB"}));
  assert.equal(row("VpnClient","c1").quotaTotal,1n * GO);
  db.state.Voucher.push({id:"orphan",code:"VCH-CCCCC-DDDDD",quota:1n * GO,durationDays:30,isRedeemed:false,status:"active",resellerId:null,expiresAt:tomorrow()});
  ok(await api("u1","POST","/mobile/packages/activate",{code:"VCH-CCCCC-DDDDD"}),409);
  assert.equal(row("Voucher","orphan").isRedeemed,false);
});

test("provisioning and its traffic alias enforce the same client and reseller boundaries", async () => {
  const created = await createSub();
  ok(created,201);
  const subscription = created.body.subscription;
  ok(await api("u2","POST","/provision/activate",{dataToken:subscription.dataToken,deviceId:"D2"}),404);
  ok(await api("u2","POST","/provision/sync",{subscriptionId:subscription.id,downloadBytes:10}),404);
  ok(await api("u2","GET",`/provision/status/${subscription.id}`),404);
  const reported = await api("u1","POST","/provision/sync",{
    subscriptionId:subscription.id,downloadBytes:10,uploadBytes:5,sessionId:randomUUID(),seq:1,
  });
  ok(reported);
  assert.equal(row("VpnClient","c1").quotaUsed,15n);
  assert.equal(db.state.TrafficUsage[0].clientId,"c1");
  row("Reseller","res-r1").accessExpiresAt = yesterday();
  const denied = await api("u1","POST","/provision/activate",{dataToken:subscription.dataToken,deviceId:"D1"});
  ok(denied,403);
  assert.equal(denied.body.code,"RESELLER_EXPIRED");
});

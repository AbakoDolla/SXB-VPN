import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(path.join(root, "backend", "package.json"));
const { build } = require("esbuild");
const express = require("express");
const jwt = require("jsonwebtoken");
const secret = "isolated-public-privacy-fixture-secret-not-production";
const origin = "https://vpnsxb.afrihall.com";
const publicBase = "/api/public";

async function fixture(t, settings = {}, { rootAlias = false } = {}) {
  const tickets = [];
  const roles = ["OWNER", "SUPER_ADMIN", "ADMIN", "SUPPORT", "RESELLER", "CLIENT"];
  const users = roles.map(role => ({
    id: role.toLowerCase(), name: role, email: `${role.toLowerCase()}@example.test`,
    status: "active", role: { name: role, permissions: [] },
  }));
  const db = {
    fail: false,
    user: { findUnique: async ({ where }) => users.find(user => user.id === where.id) },
    permission: { findMany: async () => [] },
    vpnClient: { findFirst: async () => ({ status: "active" }) },
    reseller: { findUnique: async () => ({ status: "active", quotaBytes: 10n, quotaUsedBytes: 0n, accessExpiresAt: null }) },
    supportTicket: {
      async create({ data }) {
        if (db.fail) throw new Error("fixture database unavailable: do not expose email");
        assert.equal(data.userId, null);
        const ticket = { ...data, id: `ticket-${tickets.length + 1}`, createdAt: new Date(), updatedAt: new Date() };
        tickets.push(ticket);
        return ticket;
      },
      async findMany({ where = {}, take }) {
        return tickets.filter(ticket => Object.entries(where).every(([key, value]) => ticket[key] === value)).slice(0, take);
      },
      async findUnique({ where }) { return tickets.find(ticket => ticket.id === where.id) ?? null; },
    },
  };
  const bundled = await build({
    stdin: {
      contents: `export * from "./server/routes/public-privacy";
        export * from "./server/services/public-privacy";
        export { default as support } from "./server/routes/support";`,
      resolveDir: root, loader: "ts",
    },
    bundle: true, platform: "node", format: "cjs", packages: "external", write: false, logLevel: "silent",
    plugins: [{
      name: "privacy-fixture",
      setup(builder) {
        builder.onResolve({ filter: /(?:^|\/)(database|config)$/ }, args => ({
          path: args.path.endsWith("database") ? "database" : "config", namespace: "fixture",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({
          contents: args.path === "database"
            ? "export const prisma = globalThis.fixtureDb; export const inMemoryDb = {}; export async function logDbActivity() {}"
            : `export const config = { NODE_ENV: "production", JWT_SECRET: ${JSON.stringify(secret)} };`,
          loader: "js",
        }));
      },
    }],
  });
  const module = { exports: {} };
  const logs = [];
  runInNewContext(bundled.outputFiles[0].text, {
    module, require, Buffer, process: { env: {} }, fixtureDb: db,
    console: { ...console, error: (...args) => logs.push(args.join(" ")) },
  });
  const api = module.exports;
  let clock = Date.now();
  const app = express();
  app.set("trust proxy", 1);
  assert.equal(api.PUBLIC_PRIVACY_BASE_PATH, publicBase);
  const publicRouter = api.createPublicPrivacyRouter({ now: () => clock, settings: api.readPrivacySettings(settings) });
  app.use(publicBase, publicRouter);
  if (rootAlias) app.use(publicRouter);
  app.use(express.json());
  app.use("/api/support", api.support);
  // Public resources must terminate before the API/SPA maintenance fallback.
  app.use((_req, res) => res.status(503).send("fixture maintenance"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (route, headers = {}) => fetch(base + route, { headers });
  async function form(lang = "en", prefix = publicBase) {
    const response = await get(`${prefix}/data-deletion?lang=${lang}`);
    const html = await response.text();
    const cookie = response.headers.get("set-cookie").split(";")[0];
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
    clock += 3000;
    return { cookie, csrf, html, headers: response.headers };
  }
  const valid = fields => ({
    lang: "en", kind: "deletion", email: "requester@example.test",
    deviceId: "SXBTESTDEVICE123", message: "Please delete my individual account and data.",
    acknowledge: "yes", website: "", ...fields,
  });
  async function post(form, fields = {}, options = {}) {
    const { headers, body, prefix = publicBase, ...rest } = options;
    return fetch(`${base}${prefix}/data-deletion?lang=${fields.lang || "en"}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded", Origin: origin,
        "Sec-Fetch-Site": "same-origin", Cookie: form.cookie,
        "X-Forwarded-For": "198.51.100.1", ...headers,
      },
      body: body ?? new URLSearchParams(valid({ csrf: form.csrf, ...fields })).toString(), ...rest,
    });
  }
  async function staff(route, role) {
    return get(route, {
      Authorization: `Bearer ${jwt.sign({ userId: role.toLowerCase(), role }, secret, { expiresIn: "5m" })}`,
    });
  }
  return { api, db, tickets, logs, get, form, post, staff, advance: milliseconds => { clock += milliseconds; } };
}

test("privacy and deletion are public, localized and available ahead of maintenance", async t => {
  const f = await fixture(t);
  for (const lang of ["fr", "en"]) {
    for (const route of ["/privacy", "/data-deletion"]) {
      const response = await f.get(`${publicBase}${route}?lang=${lang}`);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, new RegExp(`<html lang="${lang}">`));
      assert.match(html, /SXB VPN/);
      assert.match(html, lang === "fr" ? /prépublication/ : /Pre-publication/);
      assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.doesNotMatch(html, /<script|<iframe|mailto:|sxbvpn\.com\/legal/);
      assert.ok(html.includes(`href="${publicBase}${route}?lang=fr"`));
      assert.ok(html.includes(`href="${publicBase}${route}?lang=en"`));
      assert.doesNotMatch(html, /(?:href|action)="\/(?:privacy|data-deletion)\b/);
      if (route === "/data-deletion") {
        assert.ok(html.includes(`action="${publicBase}/data-deletion?lang=${lang}"`));
      } else {
        assert.ok(html.includes(`href="${publicBase}/data-deletion?lang=${lang}"`));
      }
    }
  }
  assert.match(await (await f.get(`${publicBase}/privacy`, { "Accept-Language": "en-GB,en;q=0.9" })).text(), /<html lang="en">/);
  assert.equal((await f.get("/privacy")).status, 503);
  assert.equal((await f.get("/data-deletion")).status, 503);
  assert.equal((await f.get("/dashboard")).status, 503);
});

test("submission persists a null-owner ticket without echoing personal data or claiming deletion", async t => {
  const f = await fixture(t);
  const form = await f.form();
  assert.match(form.headers.get("set-cookie"), /__Host-sxb-privacy-csrf=.*HttpOnly; Secure; SameSite=Strict/);
  const result = await f.post(form);
  assert.equal(result.status, 202);
  const html = await result.text();
  assert.match(html, /manual review/);
  assert.ok(html.includes(`href="${publicBase}/privacy?lang=en"`));
  assert.doesNotMatch(html, /requester@example|SXBTESTDEVICE|ticket-1/);
  assert.equal(f.tickets.length, 1);
  assert.equal(f.tickets[0].userId, null);
  const details = JSON.parse(f.tickets[0].description);
  assert.equal(details.identityVerified, false);
  assert.equal(details.replyEmail, "requester@example.test");
  assert.equal(details.deviceId, "SXBTESTDEVICE123");
  assert.equal("ipAddress" in details, false);
});

test("all staff roles can read public tickets; clients/resellers and anonymous visitors cannot", async t => {
  const f = await fixture(t);
  assert.equal((await f.post(await f.form())).status, 202);
  for (const role of ["OWNER", "SUPER_ADMIN", "ADMIN", "SUPPORT"]) {
    const list = await f.staff("/api/support", role);
    assert.equal(list.status, 200);
    assert.equal((await list.json()).tickets.length, 1);
    assert.equal((await f.staff("/api/support/ticket-1", role)).status, 200);
  }
  for (const role of ["CLIENT", "RESELLER"]) {
    for (const route of ["/api/support", "/api/support?status=open", "/api/support?userId=null"]) {
      const list = await f.staff(route, role);
      assert.equal(list.status, 200);
      assert.equal((await list.json()).tickets.length, 0);
    }
    assert.equal((await f.staff("/api/support/ticket-1", role)).status, 404);
  }
  assert.equal((await f.get("/api/support/ticket-1")).status, 401);
});

test("receipt is identical for unknown device, omitted device and different contact addresses", async t => {
  const f = await fixture(t);
  const responses = [];
  for (const [deviceId, email] of [["SXBUNKNOWN99", "unknown@example.test"], ["", "known@example.test"]]) {
    const response = await f.post(await f.form(), { deviceId, email });
    assert.equal(response.status, 202);
    responses.push(await response.text());
  }
  assert.equal(responses[0], responses[1]);
});

test("French contact requests use the same intake without account lookup", async t => {
  const f = await fixture(t);
  const response = await f.post(await f.form("fr"), { lang: "fr", kind: "privacy", deviceId: "" });
  assert.equal(response.status, 202);
  assert.match(await response.text(), /examen manuel/);
  assert.equal(JSON.parse(f.tickets[0].description).kind, "privacy");
});

test("HTML injection from settings and request data is never rendered as markup", async t => {
  const f = await fixture(t, { SXB_PRIVACY_OPERATOR_NAME: `<img src=x onerror="alert('x')">&` });
  const html = await (await f.get(`${publicBase}/privacy`)).text();
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(&#39;x&#39;\)&quot;&gt;&amp;/);
  assert.doesNotMatch(html, /<img/);
  const response = await f.post(await f.form(), { message: '<script>alert("sensitive")</script>' });
  assert.equal(response.status, 202);
  assert.doesNotMatch(await response.text(), /<script>|sensitive/);
});

test("invalid fields, excess keys, honeypots, secrets and bounds reject without storing or echoing", async t => {
  const f = await fixture(t);
  const invalid = [
    { email: "not-an-email" }, { email: `${"a".repeat(250)}@example.test` },
    { message: "short" }, { message: "x".repeat(2001) }, { deviceId: "x".repeat(84) },
    { userId: "owner" }, { kind: "erase-everything" }, { website: "spam" },
    { acknowledge: "" }, { deviceId: "SXB-USER-NOT-AN-ID" },
    { message: "My code is SXB-USER-AAAA-BBBB-CCCC" }, { lang: "de" },
    { message: "bad\u0000control characters" },
  ];
  for (const [index, fields] of invalid.entries()) {
    const response = await f.post(await f.form(), fields, { headers: { "X-Forwarded-For": `198.51.100.${index + 10}` } });
    assert.equal(response.status, 400, JSON.stringify(fields));
    assert.doesNotMatch(await response.text(), /SXB-USER-AAAA|erase-everything|not-an-email/);
  }
  assert.equal(f.tickets.length, 0);
  assert.equal((await f.post(await f.form(), { message: "x".repeat(2000) })).status, 202);
});

test("origin, same-site cookies and CSRF signature are required", async t => {
  const f = await fixture(t);
  const form = await f.form();
  const bad = [
    { headers: { Origin: "https://attacker.example" } },
    { headers: { Origin: "null" } },
    { headers: { Cookie: "" } },
    { headers: { "Sec-Fetch-Site": "cross-site" } },
    { headers: { Cookie: `${form.cookie}; ${form.cookie}` } },
  ];
  for (const [index, options] of bad.entries()) {
    assert.equal((await f.post(form, {}, { ...options, headers: { ...options.headers, "X-Forwarded-For": `198.51.100.${index + 30}` } })).status, 403);
  }
  const tampered = form.csrf.replace(/.$/, form.csrf.endsWith("0") ? "1" : "0");
  assert.equal((await f.post({ csrf: tampered, cookie: `__Host-sxb-privacy-csrf=${tampered}` })).status, 403);
  assert.equal(f.tickets.length, 0);
});

test("too-fast and expired submissions fail", async t => {
  const f = await fixture(t);
  const form = await f.form();
  f.advance(-2500);
  assert.equal((await f.post(form)).status, 403);
  f.advance(f.api.PUBLIC_FORM_LIFETIME_MS + 3000);
  assert.equal((await f.post(form)).status, 403);
  assert.equal(f.tickets.length, 0);
});

test("only small URL-encoded bodies are parsed; duplicates and parameter flooding fail", async t => {
  const f = await fixture(t);
  const form = await f.form();
  assert.equal((await f.post(form, {}, { body: "message=" + "x".repeat(17 * 1024) })).status, 413);
  assert.equal((await f.post(form, {}, { body: Array.from({ length: 12 }, (_, i) => `x${i}=1`).join("&") })).status, 413);
  assert.equal((await f.post(form, {}, { headers: { "Content-Type": "application/json" }, body: "{}" })).status, 415);
  assert.equal((await f.post(form, {}, { body: `csrf=${form.csrf}&csrf=duplicate` })).status, 400);
  assert.equal(f.tickets.length, 0);
});

test("IP limits apply even to invalid attempts; public GET remains readable", async t => {
  const f = await fixture(t);
  const form = await f.form();
  for (let i = 0; i < f.api.PUBLIC_REQUEST_LIMIT; i++) {
    assert.equal((await f.post(form, { message: "x" })).status, 400);
  }
  const limited = await f.post(form);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.ok((await limited.text()).includes(`href="${publicBase}/data-deletion?lang=en"`));
  assert.equal((await f.get(`${publicBase}/privacy`)).status, 200);
  assert.equal((await f.get(`${publicBase}/data-deletion`)).status, 200);
  assert.equal(f.tickets.length, 0);
});

test("database failure is an explicit failure without sensitive exception text", async t => {
  const f = await fixture(t);
  f.db.fail = true;
  const response = await f.post(await f.form());
  assert.equal(response.status, 503);
  assert.match(await response.text(), /Receipt is not confirmed/);
  assert.equal(f.tickets.length, 0);
  assert.deepEqual(f.logs, ["[public-privacy] support ticket persistence failed"]);
});

test("a reviewed flag alone cannot approve incomplete legal configuration", async t => {
  const f = await fixture(t);
  assert.throws(() => f.api.readPrivacySettings({ SXB_PRIVACY_REVIEWED: "true" }));
  assert.throws(() => f.api.readPrivacySettings({ SXB_PRIVACY_CONTACT_EMAIL: "invalid" }));
  const settings = {
    SXB_PRIVACY_REVIEWED: "true", SXB_PRIVACY_OPERATOR_NAME: "Fixture only",
    SXB_PRIVACY_CONTACT_EMAIL: "fixture@example.test",
    SXB_PRIVACY_RETENTION_NOTE_FR: "Fixture", SXB_PRIVACY_RETENTION_NOTE_EN: "Fixture",
    SXB_PRIVACY_PROCESSORS_NOTE_FR: "Fixture", SXB_PRIVACY_PROCESSORS_NOTE_EN: "Fixture",
  };
  assert.equal(f.api.readPrivacySettings(settings).SXB_PRIVACY_REVIEWED, "true");
});

test("optional root aliases share CSRF and rate limits and always link to the canonical API namespace", async t => {
  const f = await fixture(t, {}, { rootAlias: true });
  const aliasForm = await f.form("fr", "");
  assert.ok(aliasForm.html.includes(`action="${publicBase}/data-deletion?lang=fr"`));
  assert.ok(aliasForm.html.includes(`href="${publicBase}/data-deletion?lang=en"`));
  assert.ok(aliasForm.html.includes(`href="${publicBase}/privacy?lang=fr"`));
  assert.match(aliasForm.headers.get("set-cookie"), /Path=\//);
  assert.equal((await f.post(aliasForm, { lang: "fr" })).status, 202);
  const canonicalForm = await f.form();
  assert.equal((await f.post(canonicalForm, {}, { prefix: "" })).status, 202);
  for (let i = 2; i < f.api.PUBLIC_REQUEST_LIMIT; i++) {
    const response = await f.post(canonicalForm, { message: "x" }, { prefix: i % 2 ? "" : publicBase });
    assert.equal(response.status, 400);
    assert.ok((await response.text()).includes(`href="${publicBase}/data-deletion?lang=en"`));
  }
  for (const prefix of ["", publicBase]) {
    const response = await f.post(canonicalForm, {}, { prefix });
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get("retry-after")) > 0);
    assert.equal((await f.get(`${prefix}/privacy`)).status, 200);
  }
  assert.equal(f.tickets.length, 2);
});

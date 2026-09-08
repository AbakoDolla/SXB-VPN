import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(path.join(root, "backend", "package.json"));
const { build } = require("esbuild");
const express = require("express");
const jwt = require("jsonwebtoken");
const compiled = { exports: {} };
const bundled = await build({
  entryPoints: [path.join(root, "server", "middleware", "rate-limit.ts")],
  bundle: true, platform: "node", format: "cjs", packages: "external", write: false,
  logLevel: "silent",
});
runInNewContext(bundled.outputFiles[0].text, { module: compiled, require });
const { createApiRateLimiter, API_RATE_LIMITS } = compiled.exports;
const secrets = { access: "test-access-rate-limit", refresh: "test-refresh-rate-limit" };
const tokenFor = (userId, extra = {}, secret = secrets.access) =>
  jwt.sign({ userId, ...extra }, secret, { expiresIn: "15m" });

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use("/api", createApiRateLimiter(secrets));
app.all("/api/*", (_req, res) => res.json({ reachedRoute: true }));
const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

async function request(route, { ip = "198.51.100.1", token, method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": ip,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, headers: response.headers, data: await response.json() };
}

function allowed(response, remaining) {
  assert.equal(response.status, 200, JSON.stringify(response.data));
  if (remaining !== undefined) assert.equal(Number(response.headers.get("ratelimit-remaining")), remaining);
}

test("normal dashboard and mobile polling behind the same IP leaves login available", async () => {
  const token = tokenFor("dashboard");
  for (let count = 0; count < 250; count++) {
    allowed(await request("/dashboard/stats", { token }));
  }
  for (const clientId of ["phone-a", "phone-b"]) {
    const mobile = tokenFor("shared-historical-owner", { role: "CLIENT", clientId });
    for (let count = 0; count < 200; count++) {
      allowed(await request("/mobile/me", { token: mobile }));
    }
  }
  allowed(await request("/auth/login", { method: "POST" }), API_RATE_LIMITS.authentication - 1);
  allowed(await request("/auth/me"), API_RATE_LIMITS.anonymous - 1);
});

test("the anonymous limit remains enforced without consuming the authentication budget", async () => {
  const ip = "198.51.100.2";
  for (let count = 0; count < API_RATE_LIMITS.anonymous; count++) {
    allowed(await request("/anonymous", { ip }));
  }
  const refused = await request("/anonymous", { ip });
  assert.equal(refused.status, 429);
  assert.equal(refused.data.code, "RATE_LIMITED");
  assert.match(refused.data.message, /Trop de requêtes/);
  assert.equal(refused.data.retryAfterSeconds, Number(refused.headers.get("retry-after")));
  assert.ok(refused.data.retryAfterSeconds > 0 && refused.data.retryAfterSeconds <= 900);
  allowed(await request("/auth/login", { ip, method: "POST" }), API_RATE_LIMITS.authentication - 1);
  allowed(await request("/health?probe=true", { ip }));
  allowed(await request("/metrics/", { ip }));
  assert.equal((await request("/anonymous", { ip })).status, 429);
});

test("login aliases, token activation and registration share an IP budget even with valid JWTs", async () => {
  const ip = "198.51.100.3";
  const routes = ["/auth/login", "/AUTH/LOGIN/?source=dashboard", "/auth/register", "/auth/token-login", "/admin-tokens/activate", "/mobile/auth/activate"];
  for (let count = 0; count < API_RATE_LIMITS.authentication; count++) {
    allowed(await request(routes[count % routes.length], {
      ip, method: "POST", token: tokenFor(`different-user-${count}`),
    }));
  }
  for (const route of routes) {
    assert.equal((await request(route, { ip, method: "POST", token: tokenFor("another-user") })).status, 429);
  }
  allowed(await request("/clients", { ip, token: tokenFor("existing-session") }), API_RATE_LIMITS.authenticated - 1);
  allowed(await request("/auth/refresh", {
    ip, method: "POST", body: { refreshToken: tokenFor("existing-session", {}, secrets.refresh) },
  }), API_RATE_LIMITS.refresh - 1);
});

test("authenticated quotas stay bounded and survive token, device-header and IP changes", async () => {
  const token = tokenFor("busy-user", { clientId: "phone" });
  for (let count = 0; count < API_RATE_LIMITS.authenticated; count++) {
    allowed(await request("/mobile/me", { token, ip: "198.51.100.4" }));
  }
  const renewed = tokenFor("busy-user", { clientId: "phone", extra: "new-signature" });
  assert.equal((await request("/mobile/me", {
    token: renewed, ip: "198.51.100.5", headers: { "X-SXB-Device-ID": "another-header" },
  })).status, 429);
  allowed(await request("/mobile/me", {
    token: tokenFor("busy-user", { clientId: "second-phone" }), ip: "198.51.100.4",
  }), API_RATE_LIMITS.authenticated - 1);
  allowed(await request("/auth/refresh", {
    method: "POST", ip: "198.51.100.4",
    body: { refreshToken: tokenFor("busy-user", { clientId: "phone" }, secrets.refresh) },
  }), API_RATE_LIMITS.refresh - 1);
});

test("forged and expired JWT identities cannot create new anonymous buckets", async () => {
  const ip = "198.51.100.6";
  for (let count = 0; count < API_RATE_LIMITS.anonymous; count++) {
    const token = count % 2
      ? jwt.sign({ userId: `expired-${count}` }, secrets.access, { expiresIn: -1 })
      : tokenFor(`forged-${count}`, {}, "wrong-signature");
    allowed(await request("/clients", { ip, token }));
  }
  assert.equal((await request("/clients", { ip, token: tokenFor("more-forged", {}, "wrong-signature") })).status, 429);
  allowed(await request("/clients", { ip, token: tokenFor("real-user") }), API_RATE_LIMITS.authenticated - 1);
});

test("refresh quotas use the refresh signature and a stable session identity", async () => {
  const ip = "198.51.100.7";
  for (let count = 0; count < API_RATE_LIMITS.refresh; count++) {
    allowed(await request("/auth/refresh", {
      ip, method: "POST", body: { refreshToken: tokenFor(`access-is-not-refresh-${count}`) },
    }));
  }
  assert.equal((await request("/AUTH/REFRESH/", {
    ip, method: "POST", body: { refreshToken: "not-signed" },
  })).status, 429);
  const valid = tokenFor("refresh-user", {}, secrets.refresh);
  allowed(await request("/auth/refresh", { ip, method: "POST", body: { refreshToken: valid } }), API_RATE_LIMITS.refresh - 1);
  const renewed = tokenFor("refresh-user", { version: 2 }, secrets.refresh);
  allowed(await request("/auth/refresh", {
    ip: "198.51.100.8", method: "POST", body: { refreshToken: renewed },
  }), API_RATE_LIMITS.refresh - 2);
});

test("IPv6 privacy addresses in the same subnet keep a shared anonymous quota", async () => {
  allowed(await request("/clients", { ip: "2001:db8:abcd:1::1" }), API_RATE_LIMITS.anonymous - 1);
  allowed(await request("/clients", { ip: "2001:db8:abcd:2::2" }), API_RATE_LIMITS.anonymous - 2);
  allowed(await request("/clients", { ip: "2001:db8:abcd:100::1" }), API_RATE_LIMITS.anonymous - 1);
});

test("the production gateway mounts the isolated limiter before its routes", () => {
  const source = readFileSync(path.join(root, "server.ts"), "utf8");
  const limiter = source.indexOf('app.use("/api/", createApiRateLimiter(');
  assert.ok(limiter > source.indexOf("app.use(express.json())"));
  assert.ok(limiter < source.indexOf('app.use("/api/auth", authRouter)'));
  assert.doesNotMatch(source, /max: 200|Too many requests\. Please wait/);
});

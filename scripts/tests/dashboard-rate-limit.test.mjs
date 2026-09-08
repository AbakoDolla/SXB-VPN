import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(path.join(root, "backend", "package.json"));
const { build } = require("esbuild");
const bundled = await build({
  entryPoints: [path.join(root, "artifacts", "sxb-dashboard", "src", "api", "client.ts")],
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
});

function fixture(replies) {
  const tokens = new Map([["sxb_access_token", "access-before"], ["sxb_refresh_token", "refresh-before"]]);
  const state = { calls: [], redirects: [], removals: [], tokens };
  const compiled = { exports: {} };
  runInNewContext(bundled.outputFiles[0].text, {
    module: compiled,
    localStorage: {
      getItem: key => tokens.get(key) ?? null,
      setItem: (key, value) => tokens.set(key, value),
      removeItem: key => { state.removals.push(key); tokens.delete(key); },
    },
    window: { location: { assign: url => state.redirects.push(url) } },
    fetch: async (url, options) => {
      state.calls.push({ url, ...options });
      assert.ok(replies.length, `Unexpected request to ${url}`);
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: reply.headers });
    },
  });
  return { ...compiled.exports, state };
}

test("a throttled login displays French retry instructions without clearing the session", async () => {
  const { apiRequest, state } = fixture([{
    status: 429, headers: { "Retry-After": "37" },
    body: { message: "Too many requests. Please wait before retrying." },
  }]);
  await assert.rejects(apiRequest("/auth/login", { method: "POST", skipAuth: true }), error =>
    error.status === 429 && error.retryAfterSeconds === 37 &&
    error.message === "Trop de requêtes. Réessayez dans 37 s."
  );
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].headers.Authorization, undefined);
  assert.deepEqual(state.removals, []);
  assert.deepEqual(state.redirects, []);
});

test("API throttling preserves tokens and does not trigger refresh or a redirect", async () => {
  const { apiRequest, state } = fixture([{
    status: 429, body: { retryAfterSeconds: 12 },
  }]);
  await assert.rejects(apiRequest("/dashboard/stats"), error =>
    error.code === "RATE_LIMITED" && error.errorKey === "errors.rate_limit" && error.retryAfterSeconds === 12
  );
  assert.equal(state.calls.length, 1);
  assert.equal(state.tokens.get("sxb_access_token"), "access-before");
  assert.deepEqual(state.removals, []);
  assert.deepEqual(state.redirects, []);
});

test("a 429 during refresh is retryable and never converted into session_expired", async () => {
  const { apiRequest, state } = fixture([
    { status: 401 },
    { status: 429, headers: { "Retry-After": "1" } },
    { status: 401 },
    { status: 200, body: { accessToken: "access-after", refreshToken: "refresh-after" } },
    { status: 200, body: { id: "user" } },
  ]);
  await assert.rejects(apiRequest("/auth/me"), error => error.status === 429 && error.retryAfterSeconds === 1);
  assert.deepEqual(state.removals, []);
  assert.deepEqual(state.redirects, []);
  assert.equal((await apiRequest("/auth/me")).id, "user");
  assert.equal(state.tokens.get("sxb_access_token"), "access-after");
  assert.equal(state.calls.at(-1).headers.Authorization, "Bearer access-after");
});

for (const failure of [{ status: 503 }, new TypeError("Network unavailable")]) {
  test(`transient refresh failure preserves credentials: ${failure.status ?? failure.message}`, async () => {
    const { apiRequest, state } = fixture([{ status: 401 }, failure]);
    await assert.rejects(apiRequest("/auth/me"));
    assert.equal(state.tokens.get("sxb_refresh_token"), "refresh-before");
    assert.deepEqual(state.removals, []);
    assert.deepEqual(state.redirects, []);
  });
}

test("an actually invalid refresh token still returns the user to login", async () => {
  const { apiRequest, state } = fixture([{ status: 401 }, { status: 401 }]);
  await assert.rejects(apiRequest("/auth/me"), error => error.code === "session_expired");
  assert.equal(state.tokens.size, 0);
  assert.deepEqual(state.redirects, ["/"]);
});

test("Retry-After dates and absent or malformed delays remain readable", async () => {
  const future = new Date(Date.now() + 30_000).toUTCString();
  const { apiRequest } = fixture([
    { status: 429, headers: { "Retry-After": future } },
    { status: 429, headers: { "Retry-After": "invalid" }, body: { retryAfterSeconds: 8 } },
    { status: 429, body: { retryAfterSeconds: -1 } },
  ]);
  await assert.rejects(apiRequest("/clients"), error =>
    error.retryAfterSeconds >= 28 && error.retryAfterSeconds <= 30
  );
  await assert.rejects(apiRequest("/clients"), error => error.retryAfterSeconds === 8);
  await assert.rejects(apiRequest("/clients"), error =>
    error.retryAfterSeconds === undefined && /Trop de requêtes/.test(error.message)
  );
});

test("unlock headers are scoped to one request and cannot replace authentication or language", async () => {
  const { apiRequest, state } = fixture([
    { status: 200, body: { profile: { id: "profile" } } },
    { status: 200, body: { clients: [] } },
  ]);
  state.tokens.set("sxb_vpn_lang", "en");
  await apiRequest("/vpn-profiles/profile", {
    headers: {
      "X-VPN-Profile-Unlock": "request-scoped-proof",
      authorization: "Bearer different-user",
      "CONTENT-TYPE": "text/plain",
      "accept-language": "fr",
    },
  });
  const headers = state.calls[0].headers;
  assert.equal(headers["X-VPN-Profile-Unlock"], "request-scoped-proof");
  assert.equal(headers.Authorization, "Bearer access-before");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["Accept-Language"], "en");
  assert.equal(headers.authorization, undefined);
  state.tokens.set("sxb_vpn_lang", "fr");
  await apiRequest("/clients");
  assert.equal(state.calls[1].headers["X-VPN-Profile-Unlock"], undefined);
  assert.equal(state.calls[1].headers["Accept-Language"], "fr");
});

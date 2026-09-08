import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createRequire, Module } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(path.join(root, "backend", "package.json"));
const { build } = require("esbuild");
const bundled = await build({
  stdin: {
    contents: `
      export { getSessionUser } from "./artifacts/sxb-dashboard/src/api/auth";
      export { state } from "session-fixture";
    `,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  plugins: [{
    name: "session-api-fixture",
    setup(builder) {
      builder.onResolve({ filter: /^(session-fixture|\.\/client)$/ }, args => {
        if (args.path === "session-fixture" || args.importer.endsWith("auth.ts")) {
          return { path: "session-fixture", namespace: "fixture" };
        }
      });
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: `
          export const state = { token: null, profile: null, calls: [], error: null };
          export const getAccessToken = () => state.token;
          export const setTokens = token => { state.token = token; };
          export const clearTokens = () => { state.token = null; };
          export async function apiRequest(url) {
            state.calls.push(url);
            if (state.error) throw state.error;
            return state.profile;
          }
        `,
        loader: "js",
      }));
    },
  }],
});
const compiledPath = path.join(root, "backend", "node_modules", ".session-test.cjs");
const compiled = new Module(compiledPath);
compiled._compile(bundled.outputFiles[0].text, compiledPath);
const { state, getSessionUser } = compiled.exports;
const { schemaFingerprint } = require(path.join(root, "scripts", "verify-prisma-runtime.cjs"));

beforeEach(() => {
  state.token = null;
  state.profile = null;
  state.calls = [];
  state.error = null;
});

test("anonymous sessions do not request a protected profile", async () => {
  assert.equal(await getSessionUser(), null);
  assert.deepEqual(state.calls, []);
});

for (const [role, permissions] of [
  ["SUPER_ADMIN", ["vpnprofile.view", "vpnprofile.manage", "subscription.view", "subscription.manage"]],
  ["ADMIN", ["vpnprofile.view", "subscription.view"]],
  ["RESELLER", ["clients.view", "subscription.view", "subscription.manage"]],
]) {
  test(`${role} restores effective permissions even when the JWT omits them`, async () => {
    const payload = Buffer.from(JSON.stringify({ userId: "user", role })).toString("base64");
    state.token = `e30.${payload}.signature`;
    state.profile = { id: "user", name: "Compte", email: "user@example.test", role, permissions };
    const user = await getSessionUser();
    assert.deepEqual(user, state.profile);
    assert.deepEqual(state.calls, ["/auth/me"]);
    if (role === "RESELLER") assert.equal(user.permissions.includes("vpnprofile.view"), false);
  });
}

test("a reload reads role and permission changes from the server rather than the old JWT", async () => {
  state.token = "unchanged-access-token";
  state.profile = { id: "user", role: "ADMIN", permissions: ["subscription.manage"] };
  assert.deepEqual((await getSessionUser()).permissions, ["subscription.manage"]);
  state.profile = { id: "user", role: "SUPPORT", permissions: ["subscription.view"] };
  assert.deepEqual(await getSessionUser(), state.profile);
  assert.deepEqual(state.calls, ["/auth/me", "/auth/me"]);
});

test("a profile retrieval failure is not converted into a session with no permissions", async () => {
  state.token = "existing-access-token";
  state.error = new Error("Session service unavailable");
  await assert.rejects(getSessionUser(), state.error);
  assert.equal(state.token, "existing-access-token");
});

test("the runtime guard distinguishes the stale Prisma model from the reseller schema", () => {
  const client = fields => ({ Prisma: { dmmf: { datamodel: {
    models: [{ name: "VpnClient", fields }],
  } } } });
  assert.notEqual(
    schemaFingerprint(client(["id", "userId"])),
    schemaFingerprint(client(["id", "userId", "resellerId", "reseller"]))
  );
  assert.throws(() => schemaFingerprint({}), /Generated Prisma schema is missing/);
});

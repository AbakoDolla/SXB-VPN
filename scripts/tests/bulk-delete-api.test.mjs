import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(path.join(root, "backend", "package.json"));
const { build } = require("esbuild");
const bundle = await build({
  stdin: {
    contents: `
      export { deleteClient } from "./artifacts/sxb-dashboard/src/api/clients";
      export { deleteAccount } from "./artifacts/sxb-dashboard/src/api/accounts";
      export { deleteSubscription } from "./artifacts/sxb-dashboard/src/api/subscriptions";
      export { deleteVpnProfile } from "./artifacts/sxb-dashboard/src/api/vpn-profiles";
    `,
    resolveDir: root, loader: "ts",
  },
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
});
function fixture() {
  const calls = [], writes = [];
  let status = 204, response = null;
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    localStorage: {
      getItem: key => key === "sxb_access_token" ? "fixture-access" : null,
      setItem: (...args) => writes.push(args), removeItem: key => writes.push(key),
    },
    window: { location: { assign: () => assert.fail("Deletion must not log out") } },
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => response ? JSON.stringify(response) : "" };
    },
  });
  return { api: module.exports, calls, writes, respond: (code, data) => { status = code; response = data; } };
}

test("bulk adapters reuse only the existing individual DELETE paths; profile removal never disables devices", async () => {
  const f = fixture();
  await f.api.deleteClient("client-id");
  await f.api.deleteAccount("account-id");
  await f.api.deleteSubscription("plan-id");
  await f.api.deleteVpnProfile("profile-a", "fixture-proof-a");
  await f.api.deleteVpnProfile("profile-b", "fixture-proof-b");
  assert.deepEqual(f.calls.map(call => [call.method, call.url]), [
    ["DELETE", "/xapi/clients/client-id"], ["DELETE", "/xapi/users/account-id"],
    ["DELETE", "/xapi/subscriptions/plan-id"],
    ["DELETE", "/xapi/vpn-profiles/profile-a"], ["DELETE", "/xapi/vpn-profiles/profile-b"],
  ]);
  assert.equal(f.calls[3].headers["X-VPN-Profile-Unlock"], "fixture-proof-a");
  assert.equal(f.calls[4].headers["X-VPN-Profile-Unlock"], "fixture-proof-b");
  assert.ok(f.calls.every(call => call.body === undefined));
  assert.equal(f.calls.some(call => /devices|suspend|disable|revoke|bulk/.test(call.url)), false);
  assert.deepEqual(f.writes, []);
});

test("individual HTTP errors propagate to the bulk result, never resolving as successful voids", async () => {
  const f = fixture();
  for (const method of ["deleteClient", "deleteAccount", "deleteSubscription", "deleteVpnProfile"]) {
    for (const status of [403, 404, 409, 423, 500]) {
      f.respond(status, { code: status === 423 ? "PROFILE_LOCKED" : "SERVER_ERROR", success: false });
      await assert.rejects(f.api[method]("fixture-id"), error => error.status === status);
    }
  }
  assert.deepEqual(f.writes, []);
});

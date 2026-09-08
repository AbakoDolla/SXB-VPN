import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(path.join(root, "backend", "package.json"));
const { build } = require("esbuild");
const errorsFr = JSON.parse(readFileSync(path.join(root, "artifacts", "sxb-dashboard", "src", "locales", "fr", "errors.json"), "utf8"));
const bundled = await build({
  stdin: {
    contents: `
      export { createSubscription } from "./artifacts/sxb-dashboard/src/api/subscriptions";
      export { apiRequest, ApiError } from "./artifacts/sxb-dashboard/src/api/client";
    `,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  logLevel: "silent",
});
const state = { calls: [], status: 201, response: null };
const compiled = { exports: {} };
runInNewContext(bundled.outputFiles[0].text, {
  module: compiled,
  localStorage: { getItem: key => key === "sxb_access_token" ? "fixture-access-token" : null },
  fetch: async (url, options) => {
    state.calls.push({ url, ...options });
    return {
      ok: state.status >= 200 && state.status < 300,
      status: state.status,
      text: async () => JSON.stringify(state.response),
    };
  },
});
const { createSubscription, apiRequest, ApiError } = compiled.exports;

beforeEach(() => {
  state.calls = [];
  state.status = 201;
  state.response = { success: true, subscription: { id: "created-plan", name: "Profil — 3j" } };
});

for (const name of [undefined, "", "   ", "  Nom choisi  "]) {
  test(`the dashboard submits the optional name correctly: ${JSON.stringify(name)}`, async () => {
    const result = await createSubscription({
      clientId: "client",
      profileId: "profile",
      name,
      quotaGB: 1,
      durationDays: 3,
      deviceLimit: 1,
    });
    assert.equal(result.id, "created-plan");
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0].url, "/xapi/subscriptions");
    const sent = JSON.parse(state.calls[0].body);
    assert.equal(sent.name, name?.trim() || undefined);
    assert.equal(sent.quotaGB, 1);
    assert.equal(sent.durationDays, 3);
    assert.equal(sent.clientId, "client");
    assert.equal(sent.profileId, "profile");
  });
}

test("validation details identify the rejected field instead of displaying only Error 400", async () => {
  state.status = 400;
  state.response = {
    error: "errors.validation",
    details: [{ path: ["durationDays"], message: "La durée doit être un nombre entier de jours." }],
  };
  await assert.rejects(apiRequest("/subscriptions", { method: "POST", body: {} }), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 400);
    assert.equal(error.errorKey, "errors.validation");
    assert.match(error.message, /durationDays/);
    assert.match(error.message, /La durée doit être un nombre entier/);
    return true;
  });
});

test("existing message arrays and reseller refusals retain their meaningful explanations", async () => {
  state.status = 400;
  state.response = { message: [{ path: ["name"], message: "Nom trop long" }] };
  await assert.rejects(apiRequest("/subscriptions"), /Nom trop long/);
  state.status = 409;
  state.response = {
    code: "RESELLER_QUOTA_REACHED",
    error: "errors.resellers.quota_exceeded",
    message: "Le plafond du revendeur serait dépassé.",
  };
  await assert.rejects(apiRequest("/subscriptions"), error =>
    error.code === "RESELLER_QUOTA_REACHED" &&
    error.message === errorsFr.resellers.quota_exceeded &&
    error.responseData.message === "Le plafond du revendeur serait dépassé."
  );
});

test("safe HTTP errors display their text, while malformed details keep a readable fallback", async () => {
  state.status = 404;
  state.response = { error: "Client VPN introuvable" };
  await assert.rejects(apiRequest("/subscriptions"), /Client VPN introuvable/);
  state.status = 400;
  state.response = { error: "errors.validation", details: [null, {}, { message: 4 }] };
  await assert.rejects(apiRequest("/subscriptions"), error => error.message === errorsFr.validation);
  state.status = 500;
  state.response = { error: "Internal database trace" };
  await assert.rejects(apiRequest("/subscriptions"), error =>
    error.message.includes(errorsFr.server) &&
    error.message.includes("HTTP 500") &&
    !error.message.includes("Internal database trace")
  );
});

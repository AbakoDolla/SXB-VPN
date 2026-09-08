import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(path.join(root, "backend", "package.json"));
const { build } = require("esbuild");
const src = path.join(root, "artifacts", "sxb-dashboard", "src");
const bundled = await build({
  stdin: {
    contents: `
      export * from "./artifacts/sxb-dashboard/src/lib/i18n";
      export * from "./artifacts/sxb-dashboard/src/lib/language";
      export * from "./artifacts/sxb-dashboard/src/lib/errors";
      export { ApiError } from "./artifacts/sxb-dashboard/src/api/client";
      export { toBigInt, percentOf, canPerform, ownerLabel, messageForCode } from "./artifacts/sxb-dashboard/src/lib/resellerAccess";
    `,
    resolveDir: root, loader: "ts",
  },
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
});

function fixture(saved, browser = "fr-FR") {
  const storage = new Map(saved ? [["sxb_vpn_lang", saved]] : []);
  const events = new Set();
  const module = { exports: {} };
  runInNewContext(bundled.outputFiles[0].text, {
    module, console, navigator: { language: browser },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    window: {
      addEventListener: (type, callback) => { if (type === "storage") events.add(callback); },
      removeEventListener: (type, callback) => { if (type === "storage") events.delete(callback); },
    },
  });
  return { ...module.exports, storage, storageEvent: event => events.forEach(callback => callback(event)), events };
}

function flatten(value, prefix = "") {
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    return typeof child === "string" ? [[fullKey, child]] : Object.entries(flatten(child, fullKey));
  }));
}

test("all FR/EN namespaces have the same keys and interpolation parameters", () => {
  const directory = language => path.join(src, "locales", language);
  const files = readdirSync(directory("fr")).filter(file => file.endsWith(".json")).sort();
  assert.deepEqual(files, readdirSync(directory("en")).filter(file => file.endsWith(".json")).sort());
  for (const file of files) {
    const fr = flatten(JSON.parse(readFileSync(path.join(directory("fr"), file), "utf8")));
    const en = flatten(JSON.parse(readFileSync(path.join(directory("en"), file), "utf8")));
    assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort(), file);
    for (const key of Object.keys(fr)) {
      const parameters = text => [...text.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]).sort();
      assert.deepEqual(parameters(fr[key]), parameters(en[key]), `${file}:${key}`);
      assert.ok(fr[key].trim() && en[key].trim(), `${file}:${key} must not be empty`);
    }
  }
});

test("language preference persists, browser fallback and cross-tab updates are deterministic", () => {
  assert.equal(fixture(undefined, "en-GB").getLanguage(), "en");
  assert.equal(fixture(undefined, "de-DE").getLanguage(), "fr");
  assert.equal(fixture("fr", "en-US").getLanguage(), "fr");
  assert.equal(fixture("invalid", "en-US").getLanguage(), "en");
  const f = fixture("fr");
  let renders = 0;
  const unsubscribe = f.subscribeLanguage(() => renders++);
  f.setLanguage("en");
  assert.equal(f.storage.get("sxb_vpn_lang"), "en");
  assert.equal(f.getLanguage(), "en");
  assert.equal(f.getLocale(), "en-US");
  assert.equal(renders, 1);
  assert.equal(fixture(f.storage.get("sxb_vpn_lang")).getLanguage(), "en");
  f.storage.set("sxb_vpn_lang", "fr");
  f.storageEvent({ key: "sxb_vpn_lang" });
  assert.equal(f.getLanguage(), "fr");
  assert.equal(renders, 2);
  f.storageEvent({ key: "unrelated" });
  assert.equal(renders, 2);
  unsubscribe();
  assert.equal(f.events.size, 0);
});

test("semantic lookup preserves common fallback, interpolation, and literal user data", () => {
  const f = fixture();
  assert.equal(f.translate("en", "save"), "Save");
  assert.equal(f.translate("fr", "common.save"), "Enregistrer");
  assert.equal(f.translate("en", "core.login.retryIn", { seconds: 7 }), "Retry in 7 s");
  assert.equal(f.translate("en", "core.owner.reseller", { name: "<script>$&{{name}}</script>" }), "Client of <script>$&{{name}}</script>");
  assert.equal(f.resolveTranslation("en", "missing.key"), undefined);
  assert.equal(f.translate("en", "missing.key"), "missing.key");
});

test("dates, numbers, relative time and exact BigInt quotas follow the chosen locale", () => {
  const f = fixture("fr");
  const options = { timeZone: "UTC", day: "2-digit", month: "long", year: "numeric" };
  for (const [language, locale] of [["fr", "fr-FR"], ["en", "en-US"]]) {
    f.setLanguage(language);
    assert.equal(f.formatDate("2026-09-08T12:30:00Z", language, options), new Intl.DateTimeFormat(locale, options).format(new Date("2026-09-08T12:30:00Z")));
    assert.equal(f.formatNumber(1234567.5), new Intl.NumberFormat(locale).format(1234567.5));
    assert.equal(f.formatNumber(9007199254740993n), new Intl.NumberFormat(locale).format(9007199254740993n));
    assert.equal(f.formatRelativeTime(-1, "day"), new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-1, "day"));
  }
  assert.equal(f.toBigInt("9007199254740993"), 9007199254740993n);
  const bytes = 9007199254740993n * 1024n ** 6n;
  assert.equal(f.formatBytes(bytes, "en"), `${new Intl.NumberFormat("en-US").format(9007199254740993n)} EB`);
  assert.equal(f.formatBytes(1536, "en"), "1.5 KB");
  assert.equal(f.formatBytes("1536", "fr"), "1,5 Ko");
  assert.equal(f.formatBytes(-1, "en"), "Unlimited");
  assert.equal(f.formatBytes(0, "en"), "0 B");
  assert.equal(f.formatBytes("invalid", "en"), "—");
  assert.equal(f.formatDate("invalid"), "—");
  assert.equal(f.percentOf("9007199254740993", "18014398509481986"), 50);
});

test("a stored API error rerenders in the new language without losing metadata", () => {
  const f = fixture("fr");
  const data = { error: "errors.resellers.quota_exceeded", message: "Le plafond du revendeur serait dépassé." };
  const error = new f.ApiError("", 409, "RESELLER_QUOTA_REACHED", data);
  assert.match(error.message, /plafond global du revendeur/);
  f.setLanguage("en");
  assert.match(error.message, /reseller's total quota ceiling/);
  assert.equal(error.responseData, data);
  assert.equal(error.code, "RESELLER_QUOTA_REACHED");
  assert.equal(f.errorMessage(error, "en"), error.message);
  assert.notEqual(f.errorMessage(error, "en"), f.apiErrorMessage({ error: "errors.subscriptions.quota_below_usage" }, 409, "en"));
});

test("validation retains translated field paths, constraints and unknown diagnostics", () => {
  const f = fixture("en");
  const result = f.apiErrorMessage({ error: "errors.validation", details: [
    { path: ["durationDays"], code: "invalid_type", expected: "integer", received: "float" },
    { path: ["name"], code: "too_small", origin: "string", minimum: 3, inclusive: true },
    { path: ["resellerIds", 0], code: "custom", message: "Revendeur retiré" },
  ] }, 400, "en");
  assert.match(result, /Duration in days \(durationDays\): A whole number is required/);
  assert.match(result, /Name \(name\): At least 3 characters/);
  assert.match(result, /Resellers.0 \(resellerIds.0\): Invalid value. Diagnostic: Revendeur retiré/);
  assert.match(f.apiErrorMessage({ message: "Fournisseur indisponible" }, 503, "en"), /temporarily unavailable.*Diagnostic: Fournisseur indisponible/);
  assert.doesNotMatch(f.apiErrorMessage({ error: "Internal database trace" }, 500, "en"), /Internal database trace/);
});

test("reseller access guards and labels preserve their business distinctions", () => {
  const f = fixture("en");
  assert.equal(f.canPerform({ accessState: "expired", quotaState: "available" }, { reducesExposure: true }), false);
  assert.equal(f.canPerform({ accessState: "active", quotaState: "reached" }), false);
  assert.equal(f.canPerform({ accessState: "active", quotaState: "reached" }, { reducesExposure: true }), true);
  assert.match(f.messageForCode("SUPPORT_READ_ONLY"), /read-only/);
  assert.equal(f.ownerLabel("Acme"), "Client of Acme");
  f.setLanguage("fr");
  assert.equal(f.ownerLabel("Acme"), "Client de Acme");
});

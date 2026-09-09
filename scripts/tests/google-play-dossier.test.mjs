import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(root, "store", "google-play", "validate.mjs");
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SXB_PRIVACY_")));

test("the dossier satisfies listing limits, evidence ranges and exact image formats", () => {
  const result = spawnSync(process.execPath, ["--max-old-space-size=256", script], { cwd: root, encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dossier structure and branding valid/);
  assert.match(result.stdout, /not submission approval/);
});

test("submission is explicitly blocked by missing approvals and identity, not a script error", () => {
  const result = spawnSync(process.execPath, ["--max-old-space-size=256", script, "--submission"], { cwd: root, encoding: "utf8", env });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /SUBMISSION BLOCKED/);
  for (const blocker of ["organizationAccountVerified", "dunsVerified", "deletionProcessOperational", "SXB_PRIVACY_OPERATOR_NAME", "SXB_PRIVACY_CONTACT_EMAIL", "SXB_PRIVACY_REVIEWED", "vpnService.videoConnectionUrl"]) {
    assert.ok(result.stderr.includes(blocker), blocker);
  }
  assert.doesNotMatch(result.stderr, /AssertionError|TypeError|ENOENT/);
});

test("public FR and EN content have the same fields, all populated, and real request wording", () => {
  const copy = JSON.parse(readFileSync(path.join(root, "server", "resources", "privacy-content.json"), "utf8"));
  assert.deepEqual(Object.keys(copy.fr).sort(), Object.keys(copy.en).sort());
  assert.equal(copy.fr.sections.length, copy.en.sections.length);
  for (const lang of ["fr", "en"]) {
    for (const [key, value] of Object.entries(copy[lang])) {
      if (key === "sections") {
        for (const section of value) assert.ok(section.title.trim() && section.text.trim());
      } else assert.ok(typeof value === "string" && value.trim(), `${lang}.${key}`);
    }
    assert.ok(copy[lang].sections.some(section => section.text.includes("Cloudflare")));
    assert.ok(copy[lang].sections.some(section => section.text.includes("Firebase")));
  }
  assert.match(copy.en.sent, /confirms neither the existence of an account nor deletion/);
  assert.match(copy.fr.sent, /ni l'existence d'un compte ni une suppression/);
});

test("unused legacy routes and public web intake are not classified as automatic mobile collection", () => {
  const { dataSafety } = JSON.parse(readFileSync(path.join(root, "store", "google-play", "declarations.json"), "utf8"));
  assert.equal(dataSafety.legacyServiceContext.currentMobileCallsLegacyRoutes, false);
  assert.ok(dataSafety.legacyServiceContext.actualLegacyRoutes.includes("POST /api/app"));
  assert.equal(dataSafety.webRequestInventory.includedInPlayForm, null);
  assert.deepEqual(dataSafety.dataTypes.find(item => item.id === "in-app-support-messages").playTypes, ["Messages / Other in-app messages"]);
  assert.ok(!dataSafety.dataTypes.some(item => item.collected === true && item.playTypes.includes("Personal info / Phone number")));
});

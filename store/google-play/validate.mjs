import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "..", "..");
const json = name => JSON.parse(readFileSync(path.join(directory, name), "utf8"));
const declarations = json("declarations.json");
const readiness = json("readiness.json");
const manifests = [json("listing.fr.json"), json("listing.en.json")];
for (const listing of manifests) {
  for (const [field, max] of [["title", 30], ["shortDescription", 80], ["fullDescription", 4000]]) {
    assert.equal(typeof listing[field], "string", `${listing.locale}.${field}`);
    const count = [...listing[field]].length;
    assert.ok(count > 0 && count <= max, `${listing.locale}.${field}: ${count}/${max}`);
    console.log(`${listing.locale}.${field}: ${count}/${max}`);
  }
  assert.doesNotMatch(listing.shortDescription, /[\r\n]/);
  assert.match(listing.fullDescription, /VpnService/);
  assert.equal(typeof listing.reviewed, "boolean");
}

function walk(value, callback, location = "") {
  if (!value || typeof value !== "object") return;
  callback(value, location);
  for (const [key, child] of Object.entries(value)) walk(child, callback, `${location}.${key}`);
}
walk(declarations, value => {
  if (value.reviewed !== undefined) assert.equal(typeof value.reviewed, "boolean");
  if (Array.isArray(value.evidence)) {
    for (const reference of value.evidence) {
      const match = /^([^:]+)(?::(\d+)(?:-(\d+))?)?$/.exec(reference);
      assert.ok(match, `Invalid reference: ${reference}`);
      const filename = path.resolve(root, ...match[1].split("/"));
      assert.ok(filename.startsWith(root + path.sep) && existsSync(filename), `Missing evidence: ${reference}`);
      if (match[2]) {
        const lines = readFileSync(filename, "utf8").split("\n").length;
        assert.ok(Number(match[2]) >= 1 && Number(match[3] || match[2]) <= lines, `Out-of-range evidence: ${reference}`);
      }
    }
  }
});
for (const [name, width, height, color] of [
  ["icon-512.png", 512, 512, 6], ["feature-1024x500.png", 1024, 500, 2],
]) {
  const png = readFileSync(path.join(directory, "assets", name));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), width, name);
  assert.equal(png.readUInt32BE(20), height, name);
  assert.equal(png[24], 8, `${name}: 8-bit channels`);
  assert.equal(png[25], color, `${name}: RGB/RGBA format`);
  if (name === "icon-512.png") assert.ok(png.length <= 1024 * 1024, "Icon exceeds 1 MiB");
}

const requiredConfirmations = [
  "organizationAccountVerified", "dunsVerified", "publicIdentityVerified", "publicSupportEmailVerified",
  "privacyApprovedAndLive", "deletionProcessOperational", "dataSafetyApproved", "vpnServiceApproved",
  "foregroundServiceApproved", "reviewAccessReady", "releaseArtifactApproved",
  "screenshotsAndVideosReady", "distributionChoicesApproved", "assetsRightsApproved",
];
for (const key of requiredConfirmations) {
  assert.equal(typeof readiness[key]?.reviewed, "boolean", `Missing readiness flag: ${key}`);
}

if (process.argv.includes("--submission")) {
  const blockers = [];
  for (const key of requiredConfirmations) {
    const item = readiness[key];
    if (item.reviewed !== true || typeof item.evidence !== "string" || !item.evidence.trim()) blockers.push(key);
  }
  walk(declarations, (value, location) => {
    if (value.reviewed === false) blockers.push(`declarations${location}.reviewed`);
  });
  for (const listing of manifests) {
    if (!listing.reviewed) blockers.push(`${listing.locale}.reviewed`);
  }
  const safety = declarations.dataSafety;
  for (const key of ["collectsUserData", "allDataEncryptedInTransit", "independentSecurityReview", "accountCreation"]) {
    if (typeof safety[key]?.proposed !== "boolean") blockers.push(`dataSafety.${key}.proposed`);
  }
  if (safety.allDataEncryptedInTransit?.proposed !== true) blockers.push("all data encrypted in transit");
  for (const type of safety.dataTypes) {
    for (const key of ["collected", "sharing", "ephemeral"]) {
      if (typeof type[key] !== "boolean") blockers.push(`dataTypes.${type.id}.${key}`);
    }
  }
  for (const [index, party] of safety.thirdParties.entries()) {
    if (typeof party.name !== "string" || !party.name.trim() ||
      typeof party.sharingClassification !== "string" || !party.sharingClassification.trim()) {
      blockers.push(`thirdParties.${index}.classification`);
    }
  }
  for (const key of ["trafficEncryptionVerified", "prominentDisclosureAndRefusalVerified"]) {
    if (declarations.vpnService[key] !== true) blockers.push(`vpnService.${key}`);
  }
  if (declarations.vpnService.trafficManipulationForMonetization !== false) blockers.push("no VPN monetization manipulation");
  for (const [key, value] of [
    ["vpnService.videoConnectionUrl", declarations.vpnService.videoConnectionUrl],
    ["vpnService.videoDisclosureUrl", declarations.vpnService.videoDisclosureUrl],
    ["foregroundService.videoUrl", declarations.foregroundService.videoUrl],
  ]) {
    let valid = false;
    try { valid = new URL(value).protocol === "https:"; } catch { /* An absent or invalid URL blocks submission. */ }
    if (!valid) blockers.push(key);
  }
  for (const key of ["playDownloadPrice", "containsAds", "targetAudience", "contentRating", "countries"]) {
    if (declarations.distribution[key] == null || declarations.distribution[key] === "") blockers.push(`distribution.${key}`);
  }
  const envKeys = [
    "SXB_PRIVACY_OPERATOR_NAME", "SXB_PRIVACY_CONTACT_EMAIL",
    "SXB_PRIVACY_RETENTION_NOTE_FR", "SXB_PRIVACY_RETENTION_NOTE_EN",
    "SXB_PRIVACY_PROCESSORS_NOTE_FR", "SXB_PRIVACY_PROCESSORS_NOTE_EN",
  ];
  for (const key of envKeys) {
    if (!process.env[key]?.trim()) blockers.push(key);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.SXB_PRIVACY_CONTACT_EMAIL || "")) blockers.push("valid public email");
  if (process.env.SXB_PRIVACY_REVIEWED !== "true") blockers.push("SXB_PRIVACY_REVIEWED");
  if (blockers.length) {
    console.error(`SUBMISSION BLOCKED (${blockers.length} approvals/configuration items):\n${blockers.map(item => `- ${item}`).join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log("Recorded approvals are complete. This local gate neither verifies Play approval nor authorizes upload.");
  }
} else {
  console.log("Dossier structure and branding valid. This is not submission approval; use --submission for the blocking gate.");
}

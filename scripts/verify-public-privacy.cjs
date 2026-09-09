const path = require("node:path");
const { createRequire } = require("node:module");

const root = process.cwd();
const runtimeRequire = createRequire(path.join(root, "backend", "package.json"));
runtimeRequire("dotenv").config();
const bundle = require(path.resolve(process.argv[2] || ".sxb-release/public-privacy-settings.cjs"));
const settings = bundle.readPrivacySettings();
console.log(settings.SXB_PRIVACY_REVIEWED === "true"
  ? "Public privacy configuration: operator-reviewed"
  : "Public privacy configuration: pre-publication draft; Play submission remains blocked");

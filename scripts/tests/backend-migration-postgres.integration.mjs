/**
 * Real isolated PostgreSQL, not part of the database-free *.test.mjs glob.
 * Resets ONLY the explicitly supplied sxb_rollout_{child,parent}_<hex> database.
 * All rows and backup archives are synthetic fixtures. No production .env is loaded.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
assert.equal(process.env.SXB_ROLLOUT_TEST_RESET, "1", "Explicit synthetic schema-reset consent required");
assert.ok(process.env.SXB_ROLLOUT_TEST_CONNECTION_FILE, "Private isolated connection file required");
assert.ok(process.env.SXB_ROLLOUT_BASELINE_SQL, "Historical baseline SQL required");
assert.ok(process.env.SXB_ROLLOUT_PG_BIN, "Existing PostgreSQL tool directory required");
const bytes = await readFile(process.env.SXB_ROLLOUT_TEST_CONNECTION_FILE);
let databaseUrl;
try {
  databaseUrl = JSON.parse(bytes.toString(bytes[0] === 255 && bytes[1] === 254 ? "utf16le" : "utf8")
    .replace(/^\uFEFF/, "")).url;
  const parsed = new URL(databaseUrl);
  assert.ok(parsed.hostname === "127.0.0.1" && /^\/sxb_rollout_(child|parent)_[a-f0-9]+$/.test(parsed.pathname));
} catch {
  throw new Error("ISOLATED_ROLLOUT_TARGET_REQUIRED");
}
const require = createRequire(path.join(root, "backend/package.json"));
const load = require("tsx/cjs/api").require;
const { postgresEnvironment } = load(path.join(root, "server/services/reset-backup.ts"), import.meta.url);
const { prepareBackendMigration, checkBackendSchema } = load(path.join(root, "server/services/backend-migration.ts"), import.meta.url);
const suffix = process.platform === "win32" ? ".exe" : "";
const tool = name => path.join(process.env.SXB_ROLLOUT_PG_BIN, name + suffix);
const scratch = await mkdtemp(path.join(os.tmpdir(), "sxb-rollout-postgres-"));
console.log(`Synthetic proof directory: ${scratch}`);
const backupDirectory = path.join(scratch, "backups");
const env = postgresEnvironment(databaseUrl);
const options = { root, databaseUrl, prismaCli: require.resolve("prisma/build/index.js"),
  backupDirectory, psqlCommand: tool("psql"), dumpCommand: tool("pg_dump"), restoreCommand: tool("pg_restore") };
function processResult(executable, args, extra = {}) {
  const result = spawnSync(executable, args, { env, encoding: "utf8", timeout: 120_000, ...extra });
  assert.equal(result.error, undefined, "Isolated PostgreSQL tool unavailable");
  return result;
}
function sql(statement) {
  const result = processResult(tool("psql"), ["-X", "--no-password", "-v", "ON_ERROR_STOP=1", "-Atc", statement]);
  assert.equal(result.status, 0, "Synthetic SQL fixture/query failed (diagnostics withheld)");
  return result.stdout.trim();
}
function apply(file) {
  const result = processResult(tool("psql"), ["-X", "--no-password", "-v", "ON_ERROR_STOP=1", "-f", file]);
  assert.equal(result.status, 0, "Synthetic DDL failed (diagnostics withheld)");
}
const schemaFingerprint = () => sql(`SELECT md5(
  (SELECT coalesce(string_agg(table_name||column_name||data_type||is_nullable||coalesce(column_default,''), '|' ORDER BY table_name, ordinal_position),'')
   FROM information_schema.columns WHERE table_schema='public') ||
  (SELECT coalesce(string_agg(indexdef,'|' ORDER BY indexname),'') FROM pg_indexes WHERE schemaname='public') ||
  (SELECT coalesce(string_agg(conname||pg_get_constraintdef(c.oid),'|' ORDER BY conrelid::regclass::text,conname),'')
   FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'));`);
const businessFingerprint = () => sql(`SELECT md5(jsonb_build_array(
  (SELECT to_jsonb(t) - 'rollout_unknown' FROM users t WHERE id='rollout-user'),
  (SELECT to_jsonb(t) - ARRAY['devicePublicKey','deviceKeyId','keyEnrolledAt','enrollmentGrantHash','enrollmentGrantExpiresAt']
   FROM vpn_clients t WHERE id='rollout-client'),
  (SELECT to_jsonb(t) - ARRAY['authGeneration','authIssuedAt','authExpiresAt','authRevokedAt','activationRequestId',
    'refreshGeneration','refreshJti','refreshIssuedAt','previousRefreshJti','refreshRetryUntil']
   FROM activation_sessions t WHERE id='rollout-activation'),
  (SELECT to_jsonb(t) - 'json_config' FROM vpn_profiles t WHERE id='rollout-profile'),
  (SELECT to_jsonb(t) FROM subscriptions t WHERE id='rollout-subscription'),
  (SELECT to_jsonb(t) FROM traffic_usage t WHERE id='rollout-usage'),
  (SELECT to_jsonb(t) - ARRAY['sessionId','sessionGeneration','connectionId','eventKey','policyVersion','riskLevel']
   FROM security_events t WHERE id='rollout-event'))::text);`);
let checks = 0;
function passed(name) { checks++; console.log(`PASS ${name}`); }

sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
apply(process.env.SXB_ROLLOUT_BASELINE_SQL);
sql(`INSERT INTO roles(id,name) VALUES ('rollout-role','CLIENT');
  INSERT INTO users(id,name,email,"passwordHash","roleId","updatedAt")
    VALUES ('rollout-user','SYNTHETIC ROLLOUT','rollout@example.invalid','not-a-real-hash','rollout-role',CURRENT_TIMESTAMP);
  INSERT INTO vpn_clients(id,"userId",token,"deviceId","quotaUsed","updatedAt")
    VALUES ('rollout-client','rollout-user','SXB-USER-TEST-ROLLOUT','SYNTHETIC-DEVICE',731,CURRENT_TIMESTAMP);
  INSERT INTO activation_sessions(id,"clientId","deviceId","updatedAt")
    VALUES ('rollout-activation','rollout-client','SYNTHETIC-DEVICE',CURRENT_TIMESTAMP);
  INSERT INTO vpn_profiles(id,name,protocol,host,port,"canonicalConfig","updatedAt")
    VALUES ('rollout-profile','SYNTHETIC PROFILE','ssh','fixture.example.invalid',22,'synthetic-preserved-config',CURRENT_TIMESTAMP);
  INSERT INTO subscriptions(id,name,"clientId","profileId","dataToken","durationDays","quotaBytes","quotaUsed","updatedAt")
    VALUES ('rollout-subscription','SYNTHETIC PLAN','rollout-client','rollout-profile','SXB-DATA-TEST-ROLLOUT',7,1048576,731,CURRENT_TIMESTAMP);
  INSERT INTO traffic_usage(id,"clientId",download,upload,"reportKey")
    VALUES ('rollout-usage','rollout-client',700,31,'SYNTHETIC-REPORT-1');
  INSERT INTO security_events(id,"eventType","userId","deviceId",metadata)
    VALUES ('rollout-event','LOGIN_FAILED','rollout-user','SYNTHETIC-DEVICE','{"synthetic":true}');`);
sql(`ALTER TABLE vpn_profiles ADD COLUMN json_config TEXT;
  UPDATE vpn_profiles SET json_config='SYNTHETIC-LEGACY-PLAINTEXT-NOT-API' WHERE id='rollout-profile';`);
const originalBusiness = businessFingerprint();
const originalSchema = schemaFingerprint();
await assert.rejects(checkBackendSchema(options), { code: "BACKEND_SCHEMA_DRIFT" });
assert.equal(schemaFingerprint(), originalSchema);
assert.equal(businessFingerprint(), originalBusiness);
passed("populated historical schema refuses missing security DDL without mutation");

await assert.rejects(prepareBackendMigration({ ...options, dumpCommand: path.join(scratch, "missing-pg-dump") }),
  { code: "BACKEND_BACKUP_FAILED" });
assert.equal(schemaFingerprint(), originalSchema);
assert.equal(businessFingerprint(), originalBusiness);
passed("real backup-tool failure prevents all DDL and downstream work");

const indexIds = () => sql(`SELECT 'public."vpn_clients_managedById_deviceId_key"'::regclass::oid,
  'public."vpn_profiles_createdBy_uuid_key"'::regclass::oid;`);
const originalIndexIds = indexIds();
const first = await prepareBackendMigration(options);
assert.equal(first.status, "backend-schema-ready");
assert.equal(businessFingerprint(), originalBusiness);
assert.equal(indexIds(), originalIndexIds);
assert.equal(sql(`SELECT count(*) FROM pg_constraint WHERE conrelid='public.vpn_clients'::regclass
  AND conname='vpn_clients_managedById_deviceId_key'`), "1");
assert.equal(sql(`SELECT count(*) FROM pg_constraint WHERE conrelid='public.vpn_profiles'::regclass
  AND conname='vpn_profiles_createdBy_uuid_key'`), "1");
const currentSchema = schemaFingerprint();
const migrationMetadata = () => sql(`SELECT md5(jsonb_build_array(
  (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM roles t),
  (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM permissions t),
  (SELECT jsonb_agg(to_jsonb(t) ORDER BY key) FROM settings t))::text);`);
const firstMetadata = migrationMetadata();
const second = await prepareBackendMigration(options);
assert.equal(second.status, "backend-schema-ready");
assert.equal(schemaFingerprint(), currentSchema);
assert.equal(businessFingerprint(), originalBusiness);
assert.equal(migrationMetadata(), firstMetadata);
assert.equal(indexIds(), originalIndexIds);
assert.equal(sql("SELECT json_config FROM vpn_profiles WHERE id='rollout-profile'"), "SYNTHETIC-LEGACY-PLAINTEXT-NOT-API");
assert.notEqual(first.backup.id, second.backup.id);
passed("full prepare twice succeeds with distinct verified backups, adopted original indexes and stable records/RBAC metadata");

for (const result of [first, second]) {
  const content = await readFile(path.join(backupDirectory, `reset-${result.backup.id}.dump`));
  assert.equal(createHash("sha256").update(content).digest("hex"), result.backup.sha256);
}
const archive = path.join(backupDirectory, `reset-${first.backup.id}.dump`);
const content = await readFile(archive);
assert.equal(content.subarray(0, 5).toString(), "PGDMP");
function restoreOriginal() {
  sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const restored = processResult(tool("pg_restore"), ["--clean", "--if-exists", "--no-owner", "--no-privileges",
    "--exit-on-error", "--dbname", new URL(databaseUrl).pathname.slice(1), archive]);
  assert.equal(restored.status, 0, "Real restore into the same isolated database must succeed");
}
restoreOriginal();
assert.equal(schemaFingerprint(), originalSchema);
assert.equal(businessFingerprint(), originalBusiness);
passed("verified pre-migration custom archive restores the original schema and all business fixture values");

const security = path.join(root, "backend/prisma/security-layer.sql");
apply(security);
const once = schemaFingerprint();
apply(security);
assert.equal(schemaFingerprint(), once);
assert.equal(businessFingerprint(), originalBusiness);
assert.equal(sql(`SELECT "authGeneration" FROM activation_sessions WHERE id='rollout-activation'`), "0");
assert.equal(sql(`SELECT count(*) FROM vpn_clients WHERE id='rollout-client'
  AND "devicePublicKey" IS NULL AND "deviceKeyId" IS NULL AND "quotaUsed"=731`), "1");
passed("security DDL twice is idempotent, preserves populated records and does not enroll the legacy cohort");

await prepareBackendMigration(options);
await checkBackendSchema(options);
const cli = processResult(process.execPath, [path.join(root, "scripts/backend-migrate.cjs"), "check"], {
  env: { ...env, DATABASE_URL: databaseUrl, PSQL_BIN: tool("psql"), NODE_OPTIONS: "", NODE_PATH: "" },
});
assert.equal(cli.status, 0, "Real CLI check must use the same verified schema");
assert.match(cli.stdout, /BACKEND_SCHEMA_VERIFIED/);
assert.equal((cli.stdout + cli.stderr).includes(databaseUrl), false);
passed("real Prisma diff and direct CLI check accept the complete historical/additive migration chain");

const isolatedSchema = path.join(root, "backend", `.sxb-rollout-${randomUUID()}.prisma`);
try {
  const schema = (await readFile(path.join(root, "backend/prisma/schema.prisma"), "utf8"))
    .replace('provider = "prisma-client-js"', `provider = "prisma-client-js"\n  output = ${JSON.stringify(path.join(scratch, "client"))}`);
  await writeFile(isolatedSchema, schema);
  const generated = processResult(process.execPath, [options.prismaCli, "generate", "--schema", isolatedSchema], {
    env: { ...env, DATABASE_URL: databaseUrl, PRISMA_GENERATE_SKIP_AUTOINSTALL: "1", CHECKPOINT_DISABLE: "1",
      NODE_OPTIONS: "", NODE_PATH: "" },
  });
  assert.equal(generated.status, 0, "Isolated Prisma 5.22 generation failed");
  const { PrismaClient } = require(path.join(scratch, "client"));
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const profile = await client.vpnProfile.findUnique({ where: { id: "rollout-profile" } });
    assert.ok(profile);
    assert.equal(Object.hasOwn(profile, "legacyJsonConfig"), false);
    assert.equal(Object.hasOwn(profile, "json_config"), false);
    assert.equal(JSON.stringify(profile).includes("SYNTHETIC-LEGACY-PLAINTEXT-NOT-API"), false);
  } finally { await client.$disconnect(); }
  const ts = require("typescript");
  const typeFile = path.join(scratch, "ignored-field.ts");
  await writeFile(typeFile, `import { Prisma } from "./client";\n` +
    `// @ts-expect-error The retained plaintext field is deliberately absent from the client API.\n` +
    `const forbidden: Prisma.VpnProfileSelect = { legacyJsonConfig: true };\nexport { forbidden };\n`);
  const program = ts.createProgram([typeFile], {
    strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    typeRoots: [path.join(root, "backend/node_modules/@types")],
  });
  assert.equal(ts.getPreEmitDiagnostics(program).length, 0, "Ignored field must be rejected by generated client types");
  passed("isolated generated Prisma client omits the retained plaintext field at runtime and in select types");
} finally { await rm(isolatedSchema, { force: true }); }

for (const [name, index, definition] of [
  ["reversed columns", "vpn_clients_managedById_deviceId_key", 'UNIQUE INDEX "vpn_clients_managedById_deviceId_key" ON vpn_clients("deviceId","managedById")'],
  ["non-unique", "vpn_clients_managedById_deviceId_key", 'INDEX "vpn_clients_managedById_deviceId_key" ON vpn_clients("managedById","deviceId")'],
  ["predicate", "vpn_clients_managedById_deviceId_key", 'UNIQUE INDEX "vpn_clients_managedById_deviceId_key" ON vpn_clients("managedById","deviceId") WHERE "deviceId" IS NOT NULL'],
  ["expression", "vpn_clients_managedById_deviceId_key", 'UNIQUE INDEX "vpn_clients_managedById_deviceId_key" ON vpn_clients(lower("managedById"),"deviceId")'],
  ["included column", "vpn_clients_managedById_deviceId_key", 'UNIQUE INDEX "vpn_clients_managedById_deviceId_key" ON vpn_clients("managedById","deviceId") INCLUDE(id)'],
  ["descending", "vpn_clients_managedById_deviceId_key", 'UNIQUE INDEX "vpn_clients_managedById_deviceId_key" ON vpn_clients("managedById" DESC,"deviceId")'],
  ["NULLS NOT DISTINCT", "vpn_clients_managedById_deviceId_key", 'UNIQUE INDEX "vpn_clients_managedById_deviceId_key" ON vpn_clients("managedById","deviceId") NULLS NOT DISTINCT'],
  ["wrong table", "vpn_clients_managedById_deviceId_key", 'UNIQUE INDEX "vpn_clients_managedById_deviceId_key" ON vpn_profiles("createdBy","uuid")'],
  ["second scope atomic rollback", "vpn_profiles_createdBy_uuid_key", 'UNIQUE INDEX "vpn_profiles_createdBy_uuid_key" ON vpn_profiles("uuid","createdBy")'],
]) {
  restoreOriginal();
  sql(`DROP INDEX "${index}"; CREATE ${definition};`);
  const incompatible = schemaFingerprint();
  await assert.rejects(prepareBackendMigration(options), {
    code: "BACKEND_MIGRATION_FAILED", stage: "backend/prisma/backend-rollout-compat.sql",
  });
  assert.equal(schemaFingerprint(), incompatible);
  assert.equal(businessFingerprint(), originalBusiness);
  passed(`incompatible scope index refused without replacement: ${name}`);
}
restoreOriginal();
sql('DROP INDEX "vpn_clients_managedById_deviceId_key"; DROP INDEX "vpn_profiles_createdBy_uuid_key";');
sql("ALTER TABLE vpn_profiles DROP COLUMN json_config;");
await prepareBackendMigration(options);
assert.equal(businessFingerprint(), originalBusiness);
assert.equal(sql("SELECT count(*) FROM vpn_profiles WHERE id='rollout-profile' AND json_config IS NULL"), "1");
passed("absent indexes are created by historical migrations and absent legacy column is added nullable");

sql('ALTER TABLE users ADD COLUMN rollout_unknown TEXT;');
const drifted = schemaFingerprint();
await assert.rejects(checkBackendSchema(options), { code: "BACKEND_SCHEMA_DRIFT" });
assert.equal(schemaFingerprint(), drifted);
assert.equal(businessFingerprint(), originalBusiness);
sql('ALTER TABLE users DROP COLUMN rollout_unknown;');
passed("unknown schema drift is rejected read-only, never repaired automatically");

sql('DROP INDEX "mobile_proof_nonces_keyId_nonce_key";');
await assert.rejects(checkBackendSchema(options), { code: "BACKEND_SCHEMA_DRIFT" });
apply(security);
sql('ALTER TABLE reseller_quota_movements DISABLE TRIGGER reseller_quota_movements_append_only;');
await assert.rejects(checkBackendSchema(options), { code: "BACKEND_LEDGER_PROTECTION_MISSING" });
sql('ALTER TABLE reseller_quota_movements ENABLE TRIGGER reseller_quota_movements_append_only;');
await checkBackendSchema(options);
passed("missing nonce uniqueness and disabled ledger trigger both block readiness");

const receipt = { checks, baseline: "5ba8f701", data: "8 synthetic records in 8 tables",
  fullHistoricalPrepare: "passed twice with verified independent backup archives",
  securityDdlTwice: true, realBackupRestore: true, physicalOrProductionActions: false,
  backups: [first.backup, second.backup] };
await writeFile(path.join(scratch, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
console.log(`REAL_BACKEND_MIGRATION_CHECKS=${checks}`);
console.log("FULL_HISTORICAL_PREPARE=VERIFIED_IN_ISOLATED_TEST_ONLY");

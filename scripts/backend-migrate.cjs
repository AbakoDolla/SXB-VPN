const { createRequire } = require("node:module");
const path = require("node:path");

async function main() {
  const action = process.argv[2];
  if (!["check", "prepare"].includes(action) || process.argv.length !== 3) {
    throw new Error("BACKEND_MIGRATION_USAGE: node scripts/backend-migrate.cjs check|prepare");
  }
  const root = path.resolve(__dirname, "..");
  const backend = createRequire(path.join(root, "backend", "package.json"));
  if (!process.env.DATABASE_URL) {
    const result = backend("dotenv").config({ path: path.join(root, ".env"), quiet: true });
    if (result.error) throw new Error("BACKEND_DATABASE_CONFIG_INVALID");
  }
  const { require: loadTypescript } = backend("tsx/cjs/api");
  const { checkBackendSchema, prepareBackendMigration } =
    loadTypescript(path.join(root, "server", "services", "backend-migration.ts"), __filename);
  const options = {
    root, databaseUrl: process.env.DATABASE_URL,
    prismaCli: backend.resolve("prisma/build/index.js"),
    backupDirectory: process.env.SXB_MIGRATION_BACKUP_DIR,
    psqlCommand: process.env.PSQL_BIN,
    dumpCommand: process.env.PG_DUMP_BIN,
    restoreCommand: process.env.PG_RESTORE_BIN,
  };
  if (action === "check") {
    await checkBackendSchema(options);
    console.log("BACKEND_SCHEMA_VERIFIED");
  } else {
    console.log(JSON.stringify(await prepareBackendMigration(options)));
  }
}

main().catch(error => {
  const code = typeof error?.code === "string" && /^BACKEND_[A-Z_]+$/.test(error.code)
    ? error.code : /^BACKEND_[A-Z_]+(?=:|$)/.exec(error?.message ?? "")?.[0] ?? "BACKEND_MIGRATION_FAILED";
  console.error(code);
  if (typeof error?.stage === "string" && /^(?:[a-z-]+|backend\/prisma\/[a-z0-9_./-]+)$/.test(error.stage)) {
    console.error(`Stage: ${error.stage}`);
  }
  const backup = error?.backup;
  if (backup && /^[a-f0-9-]{36}$/.test(backup.id) && Number.isSafeInteger(backup.bytes) &&
      backup.bytes >= 1024 && /^[a-f0-9]{64}$/.test(backup.sha256)) {
    console.error(JSON.stringify({ backup: { id: backup.id, bytes: backup.bytes, sha256: backup.sha256 } }));
  }
  console.error("Deployment stopped; do not replace/restart/seed or use db push. See docs/SECURITY-LAYER-REPORT.md.");
  process.exitCode = 1;
});

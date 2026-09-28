import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { createPostgresResetBackup, postgresEnvironment, type ResetBackup } from "./reset-backup";

export const BACKEND_SCHEMA = "backend/prisma/schema.prisma";
export const BACKEND_MIGRATIONS = [
  { file: "backend/prisma/backend-rollout-compat.sql", transaction: "file" },
  { file: "backend/prisma/migrations_manual.sql", transaction: "command" },
  { file: "backend/prisma/migrations/20260920185000_vpn_client_device_scope/migration.sql", transaction: "file" },
  { file: "backend/prisma/migrations/20260920220000_vpn_profile_uuid_scope/migration.sql", transaction: "file" },
  { file: "backend/prisma/migrations/20260907120000_reseller_access_and_client_ownership/migration.sql", transaction: "command" },
  { file: "backend/prisma/migrations/20260907130000_token_revoke_permission/migration.sql", transaction: "command" },
  { file: "backend/prisma/migrations/20260907140000_voucher_ownership_and_lifecycle/migration.sql", transaction: "command" },
  { file: "backend/prisma/migrations/20260908220000_profile_password_lock/migration.sql", transaction: "command" },
  { file: "backend/prisma/migrations/20260907050730_reseller_quota_ledger/migration.sql", transaction: "command" },
  { file: "backend/prisma/security-layer.sql", transaction: "file" },
] as const;

export class BackendMigrationError extends Error {
  backup?: ResetBackup;
  constructor(readonly code: string, readonly stage?: string) {
    super(code);
  }
}

export interface BackendMigrationOptions {
  root: string;
  databaseUrl: string | undefined;
  prismaCli: string;
  backupDirectory?: string;
  psqlCommand?: string;
  dumpCommand?: string;
  restoreCommand?: string;
}

function connection(options: BackendMigrationOptions): NodeJS.ProcessEnv {
  try {
    const url = new URL(options.databaseUrl ?? "");
    const keys = [...url.searchParams.keys()];
    // Historical DDL explicitly references public. Never migrate another
    // search_path or silently substitute a different database/schema.
    if ((url.searchParams.get("schema") ?? "public") !== "public" ||
        ["options", "host", "hostaddr"].some(key => url.searchParams.has(key)) ||
        new Set(keys).size !== keys.length) {
      throw new Error("Invalid migration target");
    }
    return { ...postgresEnvironment(options.databaseUrl), PGAPPNAME: "sxb-backend-migration",
      PGOPTIONS: "-c search_path=public -c lock_timeout=30000 -c statement_timeout=120000" };
  } catch {
    throw new BackendMigrationError("BACKEND_DATABASE_CONFIG_INVALID");
  }
}

async function command(
  executable: string, args: string[], env: NodeJS.ProcessEnv, stage: string, capture = false,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref();
    }, 120_000);
    timer.unref();
    const clear = () => { clearTimeout(timer); clearTimeout(killTimer); };
    // SQL and driver diagnostics can include credentials, defaults or row
    // contents. Only the fixed ledger-count query is captured, never logged.
    child.stderr?.resume();
    child.stdout?.on("data", (data: Buffer) => {
      if (capture) output = (output + data.toString("utf8")).slice(0, 4096);
    });
    child.once("error", () => {
      clear();
      reject(new BackendMigrationError("BACKEND_TOOL_FAILED", stage));
    });
    child.once("close", code => {
      clear();
      if (timedOut) reject(new BackendMigrationError("BACKEND_TOOL_TIMEOUT", stage));
      else resolve({ code, output });
    });
  });
}

async function files(options: BackendMigrationOptions): Promise<void> {
  try {
    for (const file of [BACKEND_SCHEMA, "prisma/schema.prisma", ...BACKEND_MIGRATIONS.map(item => item.file)]) {
      const info = await lstat(path.join(options.root, file));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Missing deployment input");
    }
    const [schema, mirror, security, securityMirror] = await Promise.all([
      readFile(path.join(options.root, BACKEND_SCHEMA), "utf8"),
      readFile(path.join(options.root, "prisma/schema.prisma"), "utf8"),
      readFile(path.join(options.root, "backend/prisma/security-layer.sql"), "utf8"),
      readFile(path.join(options.root, "prisma/security-layer.sql"), "utf8"),
    ]);
    if (schema !== mirror || security !== securityMirror) throw new Error("Mirror drift");
    const datasource = schema.match(/^datasource db\s*\{([^}]*)\}/m)?.[1].trim();
    if (!datasource || !/^provider\s*=\s*"postgresql"\s+url\s*=\s*env\("DATABASE_URL"\)$/.test(datasource) ||
        [...schema.matchAll(/^datasource\s/gm)].length !== 1) throw new Error("Different database target");
    const cli = await lstat(options.prismaCli);
    if (!cli.isFile()) throw new Error("Missing Prisma CLI");
  } catch {
    throw new BackendMigrationError("BACKEND_MIGRATION_INPUTS_INVALID");
  }
}

export async function checkBackendSchema(options: BackendMigrationOptions): Promise<void> {
  const env = connection(options);
  await files(options);
  const schema = path.join(options.root, BACKEND_SCHEMA);
  const result = await command(process.execPath, [
    options.prismaCli, "migrate", "diff",
    "--from-schema-datasource", schema, "--to-schema-datamodel", schema, "--exit-code",
  ], { ...env, DATABASE_URL: options.databaseUrl, CHECKPOINT_DISABLE: "1",
    PRISMA_HIDE_UPDATE_MESSAGE: "1" }, "schema-diff");
  if (result.code === 2) throw new BackendMigrationError("BACKEND_SCHEMA_DRIFT", "schema-diff");
  if (result.code !== 0) throw new BackendMigrationError("BACKEND_SCHEMA_CHECK_FAILED", "schema-diff");

  // Prisma cannot describe these PostgreSQL protections.
  const protections = await command(options.psqlCommand ?? "psql", [
    "--no-psqlrc", "--no-password", "-v", "ON_ERROR_STOP=1", "-At", "-c",
    `SELECT (SELECT count(*) FROM pg_trigger WHERE tgname='reseller_quota_movements_append_only'
      AND tgrelid='public.reseller_quota_movements'::regclass AND NOT tgisinternal AND tgenabled='O'),
      (SELECT count(*) FROM pg_constraint WHERE conname='reseller_quota_movements_kind_check'
      AND conrelid='public.reseller_quota_movements'::regclass AND convalidated);`,
  ], { ...env, PGOPTIONS: `${env.PGOPTIONS} -c default_transaction_read_only=on` }, "ledger-check", true);
  if (protections.code !== 0 || protections.output.trim() !== "1|1") {
    throw new BackendMigrationError("BACKEND_LEDGER_PROTECTION_MISSING", "ledger-check");
  }
}

export async function prepareBackendMigration(options: BackendMigrationOptions) {
  const env = connection(options);
  await files(options);
  let backup: ResetBackup;
  try {
    backup = await createPostgresResetBackup({
      databaseUrl: options.databaseUrl, backupDirectory: options.backupDirectory,
      dumpCommand: options.dumpCommand, restoreCommand: options.restoreCommand,
    })({ resetId: randomUUID(), signal: new AbortController().signal });
  } catch {
    throw new BackendMigrationError("BACKEND_BACKUP_FAILED", "backup");
  }

  try {
    for (const migration of BACKEND_MIGRATIONS) {
      const result = await command(options.psqlCommand ?? "psql", [
        "--no-psqlrc", "--no-password", "-v", "ON_ERROR_STOP=1",
        ...(migration.transaction === "command" ? ["--single-transaction"] : []),
        "--file", path.join(options.root, migration.file),
      ], env, migration.file);
      if (result.code !== 0) throw new BackendMigrationError("BACKEND_MIGRATION_FAILED", migration.file);
    }
    await checkBackendSchema(options);
  } catch (error) {
    const failure = error instanceof BackendMigrationError ? error :
      new BackendMigrationError("BACKEND_MIGRATION_FAILED");
    failure.backup = backup;
    throw failure;
  }
  return { status: "backend-schema-ready", backup, schema: BACKEND_SCHEMA };
}

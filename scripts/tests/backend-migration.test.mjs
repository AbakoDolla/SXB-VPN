import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(root, "backend/package.json"));
const scratch = await mkdtemp(path.join(os.tmpdir(), "sxb-migration-fixture-"));
const bundle = path.join(scratch, "migration.cjs");
await require("esbuild").build({
  entryPoints: [path.join(root, "server/services/backend-migration.ts")],
  bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "silent",
  plugins: [{
    name: "synthetic-process-boundary-no-database",
    setup(build) {
      build.onResolve({ filter: /^node:child_process$/ }, () => ({ path: "child", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: "export const spawn = (...args) => globalThis.__sxbMigrationSpawn(...args);",
      }));
    },
  }],
});
const { BACKEND_SCHEMA, BACKEND_MIGRATIONS, checkBackendSchema, prepareBackendMigration } = require(bundle);
const fixture = path.join(scratch, "source");
for (const file of [BACKEND_SCHEMA, "prisma/schema.prisma", "prisma/security-layer.sql",
  "prisma/migrations/20261002043000_data_allocation_ownership/migration.sql",
  ...BACKEND_MIGRATIONS.map(item => item.file)]) {
  await mkdir(path.dirname(path.join(fixture, file)), { recursive: true });
  await copyFile(path.join(root, file), path.join(fixture, file));
}
const archive = Buffer.alloc(2048, 42);
archive.write("PGDMP");
const password = "synthetic:p@ss";
const databaseUrl = `postgresql://fixture_user:${encodeURIComponent(password)}@127.0.0.1:1/sxb_rollout_fixture` +
  "?schema=public&connection_limit=4&pool_timeout=5&sslmode=verify-full&sslrootcert=%2Fprivate%2Fca.pem";
const options = {
  root: fixture, databaseUrl, prismaCli: require.resolve("prisma/build/index.js"),
  backupDirectory: path.join(scratch, "backups"),
};
let calls, fail, drift, ledger;
beforeEach(() => {
  calls = []; fail = null; drift = false; ledger = "1|1|1|1\n";
  globalThis.__sxbMigrationSpawn = (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => true;
    queueMicrotask(async () => {
      const stage = command === process.execPath ? "diff" :
        args.includes("--file") && command !== "pg_dump" ? path.basename(path.dirname(args.at(-1))) :
        command === "psql" ? "ledger" : command;
      try {
        child.stderr.write(`Untrusted diagnostic ${databaseUrl}`);
        if (stage === fail) {
          child.emit("error", new Error(databaseUrl));
          return;
        }
        if (command === "pg_dump") await writeFile(args.at(-1), archive);
        if (stage === "ledger") child.stdout.write(ledger);
        child.emit("close", stage === "diff" && drift ? 2 : 0);
      } catch (error) { child.emit("error", error); }
    });
    return child;
  };
});
after(async () => {
  delete globalThis.__sxbMigrationSpawn;
  await rm(scratch, { recursive: true, force: true });
});
function code(expected) {
  return error => {
    assert.equal(error.code, expected);
    assert.equal(JSON.stringify(error).includes(password), false);
    assert.equal(JSON.stringify(error).includes(databaseUrl), false);
    return true;
  };
}

test("backup is verified before every explicit migration; real schema comparison is last", async () => {
  const receipt = await prepareBackendMigration(options);
  assert.equal(receipt.status, "backend-schema-ready");
  assert.equal(receipt.schema, BACKEND_SCHEMA);
  assert.equal(receipt.backup.bytes, archive.length);
  assert.match(receipt.backup.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(calls.slice(0, 2).map(call => call.command), ["pg_dump", "pg_restore"]);
  const migrations = calls.filter(call => call.command === "psql" && call.args.includes("--file"));
  assert.deepEqual(migrations.map(call => path.relative(fixture, call.args.at(-1)).replaceAll("\\", "/")),
    BACKEND_MIGRATIONS.map(item => item.file));
  for (const [index, migration] of BACKEND_MIGRATIONS.entries()) {
    const args = migrations[index].args;
    assert.ok(args.includes("ON_ERROR_STOP=1"));
    assert.ok(args.includes("--no-psqlrc"));
    assert.equal(args.includes("--single-transaction"), migration.transaction === "command");
    if (migration.transaction === "file") {
      const source = await readFile(path.join(root, migration.file), "utf8");
      assert.match(source, /^BEGIN;$/m);
      assert.match(source, /^COMMIT;\s*$/m);
    }
  }
  assert.equal(BACKEND_MIGRATIONS.at(-1).file, "backend/prisma/migrations/20261002043000_data_allocation_ownership/migration.sql");
  assert.deepEqual(calls.at(-2).args.slice(1), [
    "migrate", "diff", "--from-schema-datasource", path.join(fixture, BACKEND_SCHEMA),
    "--to-schema-datamodel", path.join(fixture, BACKEND_SCHEMA), "--exit-code",
  ]);
  assert.ok(calls.at(-1).options.env.PGOPTIONS.includes("default_transaction_read_only=on"));
});

test("PostgreSQL credentials stay in child environments and TLS settings survive", async () => {
  await prepareBackendMigration(options);
  for (const call of calls) {
    assert.equal(call.options.shell, false);
    assert.equal(JSON.stringify(call.args).includes("fixture_user"), false);
    assert.equal(JSON.stringify(call.args).includes(password), false);
    assert.equal(JSON.stringify(call.args).includes("postgresql:"), false);
    assert.equal(call.options.env.PGSSLMODE, "verify-full");
    assert.equal(call.options.env.PGSSLROOTCERT, "/private/ca.pem");
    assert.equal(call.options.env.PGDATABASE, "sxb_rollout_fixture");
    assert.equal(call.options.env.PGPASSWORD, password);
    if (call.command !== process.execPath) assert.equal(call.options.env.DATABASE_URL, undefined);
  }
});

test("read-only check refuses absent DDL or unknown drift without dump or mutation", async () => {
  drift = true;
  await assert.rejects(checkBackendSchema(options), code("BACKEND_SCHEMA_DRIFT"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.ok(calls[0].args.includes("--exit-code"));
});

test("backup and migration failures prevent all subsequent migration/publication/restart/seed work", async () => {
  for (const stage of ["pg_dump", "pg_restore", "20260907120000_reseller_access_and_client_ownership", "prisma"]) {
    calls = []; fail = stage;
    let published = false;
    await assert.rejects(async () => {
      await prepareBackendMigration(options);
      published = true;
    });
    assert.equal(published, false);
    assert.equal(calls.some(call => call.command === process.execPath), false);
    if (stage.startsWith("pg_")) {
      assert.equal(calls.some(call => call.command === "psql"), false);
    }
  }
});

test("post-migration schema errors and missing ledger protections block readiness", async () => {
  drift = true;
  await assert.rejects(prepareBackendMigration(options), code("BACKEND_SCHEMA_DRIFT"));
  drift = false; fail = "diff";
  await assert.rejects(checkBackendSchema(options), code("BACKEND_TOOL_FAILED"));
  fail = null; ledger = "0|1\n";
  await assert.rejects(checkBackendSchema(options), code("BACKEND_LEDGER_PROTECTION_MISSING"));
  ledger = "1|1|0|1\n";
  await assert.rejects(checkBackendSchema(options), code("BACKEND_ALLOCATION_PROTECTION_MISSING"));
});

test("missing DDL, non-public schemas, duplicate and unsupported parameters fail before backup", async () => {
  const missing = path.join(fixture, "backend/prisma/security-layer.sql");
  await rm(missing);
  await assert.rejects(prepareBackendMigration(options), code("BACKEND_MIGRATION_INPUTS_INVALID"));
  await copyFile(path.join(root, "backend/prisma/security-layer.sql"), missing);
  for (const databaseUrl of [undefined, "invalid",
    options.databaseUrl + "&schema=public", options.databaseUrl.replace("schema=public", "schema=private"),
    options.databaseUrl + "&options=-c%20search_path%3Devil", options.databaseUrl + "&sslaccept=unknown",
    options.databaseUrl + "&host=another.invalid", options.databaseUrl + "&hostaddr=192.0.2.1"]) {
    await assert.rejects(prepareBackendMigration({ ...options, databaseUrl }), code("BACKEND_DATABASE_CONFIG_INVALID"));
  }
  assert.equal(calls.length, 0);
});

test("schema inspection cannot target a different database from the mandatory backup", async () => {
  const original = await readFile(path.join(root, BACKEND_SCHEMA), "utf8");
  try {
    for (const file of [BACKEND_SCHEMA, "prisma/schema.prisma"]) {
      await writeFile(path.join(fixture, file), original.replace('env("DATABASE_URL")', 'env("OTHER_DATABASE_URL")'));
    }
    await assert.rejects(prepareBackendMigration(options), code("BACKEND_MIGRATION_INPUTS_INVALID"));
    assert.equal(calls.length, 0);
  } finally {
    for (const file of [BACKEND_SCHEMA, "prisma/schema.prisma"]) {
      await writeFile(path.join(fixture, file), original);
    }
  }
});

test("workflow publishes and seeds only after the mandatory gate; no schema push fallback", async () => {
  const workflow = await readFile(path.join(root, ".github/workflows/deploy-vps.yml"), "utf8");
  const gate = workflow.indexOf("node scripts/backend-migrate.cjs prepare");
  assert.ok(gate > 0);
  for (const after of ["--schema=backend/prisma/schema.prisma", "--schema=prisma/schema.prisma",
    "$ESBUILD backend/prisma/seed-owner.ts", "mv .sxb-release/server.cjs dist/server.cjs", "pm2 restart"]) {
    assert.ok(workflow.indexOf(after, gate) > gate, `${after} must follow the gate`);
  }
  assert.match(workflow.slice(0, gate), /export PRISMA_SKIP_POSTINSTALL_GENERATE=true/);
  assert.match(workflow, /set -eo pipefail/);
  assert.doesNotMatch(workflow, /db\s+push|accept-data-loss/);
  assert.doesNotMatch(workflow, /backend-migrate\.cjs prepare[^\n]*(?:\|\||;)/);
  for (const filename of ["deploy.sh", "update.sh"]) {
    const legacy = await readFile(path.join(root, "scripts", filename), "utf8");
    assert.match(legacy, /BACKEND_LEGACY_\w+_BLOCKED/);
    assert.match(legacy, /^exit 1$/m);
    assert.doesNotMatch(legacy, /^\s*(?:git |npm |npx |docker|psql|pg_dump|crontab)/m);
  }
  const hook = await readFile(path.join(root, "scripts/post-merge.sh"), "utf8");
  assert.doesNotMatch(hook, /pnpm --filter db push/);
});

test("successful synthetic backups are retained, not overwritten or pruned", async () => {
  const first = await prepareBackendMigration(options);
  const second = await prepareBackendMigration(options);
  assert.notEqual(first.backup.id, second.backup.id);
  const names = await readdir(options.backupDirectory);
  for (const result of [first, second]) assert.ok(names.includes(`reset-${result.backup.id}.dump`));
});

test("root cron check is read-only, secret-safe and fail-closed before checkout replacement", async () => {
  const { checkLegacyCron } = require(path.join(root, "scripts/check-backend-cron.cjs"));
  const run = result => (command, args, options) => {
    assert.equal(command, "sudo");
    assert.deepEqual(args, ["-n", "crontab", "-u", "root", "-l"]);
    assert.equal(options.shell, false);
    assert.equal(options.env.LC_ALL, "C");
    return result;
  };
  checkLegacyCron(run({ status: 1, stdout: "", stderr: "no crontab for root\n" }));
  checkLegacyCron(run({ status: 0, stdout: "# cd /var/www/sxb-vpn && git pull && docker-compose up -d\n", stderr: "" }));
  for (const compose of ["docker-compose", "docker compose"]) {
    assert.throws(() => checkLegacyCron(run({
      status: 0, stderr: "", stdout: `0 3 * * 0 cd /var/www/sxb-vpn && git pull origin main && ${compose} up -d --build\n`,
    })), /^Error: BACKEND_LEGACY_CRON_PRESENT$/);
  }
  for (const result of [{ status: 1, stderr: "sudo: permission denied" },
    { status: 1, stderr: "no crontab for somebody-else" }, { status: null, error: new Error(password) }]) {
    assert.throws(() => checkLegacyCron(run(result)), /^Error: BACKEND_CRON_CHECK_FAILED$/);
  }
  const workflow = await readFile(path.join(root, ".github/workflows/deploy-vps.yml"), "utf8");
  const check = workflow.indexOf("git show FETCH_HEAD:scripts/check-backend-cron.cjs | node");
  assert.ok(check > workflow.indexOf('DEPLOYED_SHA=$(git rev-parse FETCH_HEAD)'));
  assert.ok(check < workflow.indexOf("git reset --hard FETCH_HEAD"));
  assert.ok(check < workflow.indexOf("node scripts/backend-migrate.cjs prepare"));
});

test("the exact git-show pipefail stdin entrypoint runs the cron guard before further work", async () => {
  const directory = path.join(scratch, "cron-stdin");
  await mkdir(path.join(directory, "scripts"), { recursive: true });
  await copyFile(path.join(root, "scripts/check-backend-cron.cjs"), path.join(directory, "scripts/check-backend-cron.cjs"));
  const git = args => {
    const result = spawnSync("git", [
      "-c", `core.hooksPath=${path.join(directory, "no-hooks")}`, "-c", "commit.gpgSign=false", ...args,
    ], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, "Synthetic local Git fixture failed");
    return result.stdout.trim();
  };
  git(["init", "--quiet"]);
  git(["add", "scripts/check-backend-cron.cjs"]);
  git(["-c", "user.name=Synthetic Test", "-c", "user.email=test@example.invalid",
    "commit", "--quiet", "-m", "Synthetic stdin fixture\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"]);
  await writeFile(path.join(directory, ".git/FETCH_HEAD"), git(["rev-parse", "HEAD"]) + "\n");
  const preload = path.join(directory, "boundary.cjs");
  await writeFile(preload, `
    require("node:child_process").spawnSync = () => {
      switch (process.env.SXB_CRON_FIXTURE) {
        case "present": return { status: 0, stdout: "0 3 * * 0 cd /var/www/sxb-vpn && git pull && docker-compose up -d --build # synthetic-secret", stderr: "" };
        case "absent": return { status: 1, stdout: "", stderr: "no crontab for root\\n" };
        default: return { status: 1, stdout: "", stderr: "sudo: synthetic-secret" };
      }
    };
  `);
  for (const mode of ["present", "absent", "denied"]) {
    const result = spawnSync("bash", ["-c",
      "set -eo pipefail\ngit show FETCH_HEAD:scripts/check-backend-cron.cjs | node\nprintf NEXT_STAGE_ALLOWED"],
    { cwd: directory, encoding: "utf8", env: { ...process.env,
      NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, SXB_CRON_FIXTURE: mode } });
    assert.equal(result.status, mode === "absent" ? 0 : 1, "The stdin guard must run and control the pipeline");
    assert.equal(result.stdout.includes("NEXT_STAGE_ALLOWED"), mode === "absent");
    assert.equal((result.stdout + result.stderr).includes("synthetic-secret"), false);
    assert.match(result.stdout + result.stderr, new RegExp(mode === "absent" ? "BACKEND_LEGACY_CRON_ABSENT" :
      mode === "present" ? "BACKEND_LEGACY_CRON_PRESENT" : "BACKEND_CRON_CHECK_FAILED"));
  }
  const failedShow = spawnSync("bash", ["-c",
    "set -eo pipefail\ngit show FETCH_HEAD:missing.cjs | node\nprintf NEXT_STAGE_ALLOWED"],
  { cwd: directory, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
  assert.notEqual(failedShow.status, 0);
  assert.equal(failedShow.stdout.includes("NEXT_STAGE_ALLOWED"), false);
});

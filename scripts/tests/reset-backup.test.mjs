import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(path.join(root, "backend", "package.json"));
const { build } = require("esbuild");
const bundleDirectory = await mkdtemp(path.join(root, "backend", ".sxb-reset-backup-"));
// The real provider refuses project/public directories, including the fixture
// bundle folder. Only synthetic archive bytes are written to this private temp.
const backupDirectory = await mkdtemp(path.join(os.tmpdir(), "sxb-reset-backup-fixture-"));
const bundlePath = path.join(bundleDirectory, "backup.cjs");
await build({
  stdin: { contents: 'export * from "./server/services/reset-backup";', resolveDir: root, loader: "ts" },
  bundle: true, platform: "node", format: "cjs", packages: "external", outfile: bundlePath, logLevel: "silent",
  plugins: [{
    name: "no-real-postgres-processes",
    setup(builder) {
      builder.onResolve({ filter: /^node:child_process$/ }, () => ({ path: "child", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: "export const spawn = (...args) => globalThis.__sxbResetBackupSpawn(...args);",
      }));
    },
  }],
});
const { createPostgresResetBackup } = require(bundlePath);
const password = "fixture:p@ss";
const databaseUrl = "postgresql://fixture_user:fixture%3Ap%40ss@127.0.0.1:5432/sxb_reset_fixture" +
  "?schema=public&connection_limit=4&pool_timeout=5&sslmode=verify-full&sslrootcert=%2Fprivate%2Fca.pem";
const archive = Buffer.alloc(2048, 42);
archive.write("PGDMP", 0, "ascii");
let dumpMode, restoreMode, calls, kills, onSpawn;
beforeEach(() => {
  dumpMode = "success"; restoreMode = "success"; calls = []; kills = []; onSpawn = null;
  globalThis.__sxbResetBackupSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.kill = signal => {
      kills.push(signal);
      queueMicrotask(() => child.emit("close", 143));
      return true;
    };
    queueMicrotask(async () => {
      try {
        onSpawn?.();
        const mode = command === "pg_dump" ? dumpMode : restoreMode;
        if (mode === "missing") {
          child.emit("error", Object.assign(new Error(password), { code: "ENOENT" }));
          return;
        }
        if (mode === "hold") return;
        child.stderr.write(`untrusted diagnostics ${databaseUrl}`);
        if (command === "pg_dump") {
          const bytes = mode === "empty" ? Buffer.alloc(0) : mode === "invalid" ? Buffer.alloc(2048) : archive;
          await writeFile(args[args.indexOf("--file") + 1], bytes);
        }
        child.emit("close", mode === "exit-failure" ? 1 : 0);
      } catch (error) { child.emit("error", error); }
    });
    return child;
  };
});
after(async () => {
  delete globalThis.__sxbResetBackupSpawn;
  await rm(bundleDirectory, { recursive: true, force: true });
  await rm(backupDirectory, { recursive: true, force: true });
});
const provider = extra => createPostgresResetBackup({ databaseUrl, backupDirectory, ...extra });
const context = () => ({ resetId: randomUUID(), signal: new AbortController().signal });
const fails = error => {
  assert.equal(error.code, "RESET_BACKUP_FAILED");
  assert.equal(error.message, "RESET_BACKUP_FAILED");
  assert.equal(JSON.stringify(error).includes(password), false);
  assert.equal(JSON.stringify(error).includes(databaseUrl), false);
  return true;
};

test("reset backup: custom compressed archive is private, verified, hashed and has credentials only in the child environment", async () => {
  const call = context();
  const receipt = await provider()(call);
  assert.deepEqual(receipt, { id: call.resetId, bytes: archive.length, sha256: createHash("sha256").update(archive).digest("hex") });
  assert.deepEqual(Object.keys(receipt).sort(), ["bytes", "id", "sha256"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "pg_dump");
  assert.deepEqual(calls[0].args.slice(0, 3), ["--format=custom", "--compress=6", "--no-password"]);
  assert.equal(calls[0].options.shell, false);
  for (const { args, options } of calls) {
    assert.equal(JSON.stringify(args).includes(password), false);
    assert.equal(JSON.stringify(args).includes("fixture_user"), false);
    assert.equal(JSON.stringify(args).includes("postgresql:"), false);
    assert.equal(options.env.PGPASSWORD, password);
    assert.equal(options.env.PGDATABASE, "sxb_reset_fixture");
    assert.equal(options.env.PGHOST, "127.0.0.1");
    assert.equal(options.env.PGSSLMODE, "verify-full");
    assert.equal(options.env.PGSSLROOTCERT, "/private/ca.pem");
    assert.equal(options.env.DATABASE_URL, undefined);
  }
  assert.equal(calls[1].command, "pg_restore");
  assert.deepEqual(calls[1].args, ["--list", calls[0].args.at(-1)]);
  const file = path.join(backupDirectory, `reset-${call.resetId}.dump`);
  assert.deepEqual(await readFile(file), archive);
  if (process.platform !== "win32") {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(backupDirectory)).mode & 0o777, 0o700);
  }
});

test("reset backup: both a missing pg_restore and a present tool rejecting the archive fail closed", async () => {
  restoreMode = "missing";
  await assert.rejects(provider()(context()), fails);
  restoreMode = "exit-failure";
  await assert.rejects(provider()(context()), fails);
});

test("reset backup: nonzero pg_dump, missing executable, empty output and invalid headers all fail closed", async () => {
  for (const mode of ["exit-failure", "missing", "empty", "invalid"]) {
    dumpMode = mode;
    calls = [];
    await assert.rejects(provider()(context()), fails);
    assert.equal(calls.some(call => call.command === "pg_restore"), false);
  }
});

test("reset backup: an existing archive is not overwritten or removed, even on failure", async () => {
  const call = context();
  const file = path.join(backupDirectory, `reset-${call.resetId}.dump`);
  const previous = Buffer.from("Existing backup must survive");
  await writeFile(file, previous, { mode: 0o600 });
  await assert.rejects(provider()(call), fails);
  assert.deepEqual(await readFile(file), previous);
  assert.equal(calls.length, 0);
});

test("reset backup: rejects project paths, relative paths, root paths and symlink destinations before running a command", async () => {
  for (const directory of [root, bundleDirectory, "relative-backups", path.parse(backupDirectory).root]) {
    await assert.rejects(provider({ backupDirectory: directory })(context()), fails);
  }
  const link = path.join(backupDirectory, "linked");
  const target = await mkdtemp(path.join(backupDirectory, "target-"));
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(provider({ backupDirectory: link })(context()), fails);
  assert.equal(calls.length, 0);
});

test("reset backup: invalid database URLs and unsupported TLS parameters never fall back to another database", async () => {
  for (const url of [undefined, "", "not-a-url", "mysql://user:pass@localhost/db", "postgres://user:pass@localhost/",
    "postgres://user:pass@localhost/db?sslaccept=unknown", "postgres://user:pass@localhost/db?connect_timeout=0"]) {
    await assert.rejects(provider({ databaseUrl: url })(context()), fails);
  }
  assert.equal(calls.length, 0);
});

test("reset backup: cancellation and deadlines terminate the owned child and cannot produce a successful backup", async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(provider()({ resetId: randomUUID(), signal: cancelled.signal }), fails);
  assert.equal(calls.length, 0);
  dumpMode = "hold";
  const controller = new AbortController();
  onSpawn = () => controller.abort();
  await assert.rejects(provider()({ resetId: randomUUID(), signal: controller.signal }), fails);
  assert.deepEqual(kills, ["SIGTERM"]);
  onSpawn = null;
  kills = [];
  await assert.rejects(provider({ timeoutMs: 1000 })(context()), fails);
  assert.deepEqual(kills, ["SIGTERM"]);
});

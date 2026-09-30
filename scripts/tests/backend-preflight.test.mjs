import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(root, "app-mobile/package.json"));
const YAML = require("yaml");
const { collectBackendPreflight } = require(path.join(root, "scripts/backend-preflight.cjs"));
const workflow = YAML.parse(await readFile(path.join(root, ".github/workflows/vps-audit.yml"), "utf8"));
const job = workflow.jobs["backend-preflight"];
const remote = job.steps.at(-1).with.script;
const scratch = await mkdtemp(path.join(os.tmpdir(), "sxb-preflight-fixture-"));
after(() => rm(scratch, { recursive: true, force: true }));
const marker = "synthetic-private-data-never-for-output";
const sha = "a".repeat(40);

function fixture() {
  const calls = [];
  const fileSystem = {
    statfsSync: () => ({ blocks: 8192n, bavail: 4096n, bsize: 512n }),
    lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => true, uid: 1000, mode: 0o40700 }),
    accessSync: () => {},
    readFileSync: name => {
      if (name.endsWith("pm2.pid")) return "123\n";
      if (name.endsWith("cmdline")) return `PM2 v6.0.0: God Daemon (${marker})\0`;
      if (name.endsWith("stat")) return "123 (PM2 daemon) S 1 2 3";
      throw new Error(marker);
    },
  };
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: command === "git" ? sha + "\n" :
      `${command} (PostgreSQL) 16.9 (vendor ${marker})\n`, stderr: marker };
  };
  return { fileSystem, run, home: "/synthetic-home", pm2Home: "/synthetic-pm2", uid: 1000, calls };
}

test("preflight is manual, mutually exclusive, uses the exact run SHA and existing SSH protection", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.mode.options,
    ["audit", "backend-preflight", "verify-reset", "ssh-relay-preflight", "tls-pinning-inspect"]);
  assert.equal(job.if, "inputs.mode == 'backend-preflight'");
  assert.equal(workflow.jobs.audit.if, "inputs.mode == 'audit'");
  assert.equal(workflow.jobs["verify-reset"].if, "inputs.mode == 'verify-reset'");
  assert.equal(workflow.jobs["tls-pinning-inspect"].if, "inputs.mode == 'tls-pinning-inspect'");
  assert.equal(job.environment.name, "production");
  assert.equal(job.steps[0].with.ref, "${{ github.sha }}");
  assert.equal(job.steps[0].with["persist-credentials"], false);
  const ssh = job.steps.at(-1);
  const existing = workflow.jobs.audit.steps[0];
  assert.equal(ssh.uses, "appleboy/ssh-action@0ff4204d59e8e51228ff73bce53f80d53301dee2");
  for (const key of ["host", "username", "key", "passphrase", "fingerprint"]) {
    assert.equal(ssh.with[key], existing.with[key]);
  }
  assert.equal(ssh.with.envs, "SXB_PREFLIGHT_CODE,SXB_CRON_CODE");
  assert.equal(job.steps.length, 3);
  assert.match(remote, /export NODE_OPTIONS= NODE_PATH=/);
  assert.doesNotMatch(remote, /\b(?:git|pm2|npm|npx|pnpm|psql|pg_dump|pg_restore|curl|docker|mkdir|touch|tee)\b/);
  assert.doesNotMatch(remote, /\.env|secrets\.|fetch|restart|migrat|backup|>>/i);
});

test("metadata uses only bounded read commands and allowlisted values, never PM2 CLI or database access", () => {
  const f = fixture();
  const result = collectBackendPreflight(f);
  assert.equal(result.readiness, "not_assessed");
  assert.equal(result.deployedCheckout.value, sha);
  assert.equal(result.tools.pg_dump.value, "16.9");
  assert.equal(result.disk.checkout.availableBytes, "2097152");
  assert.equal(result.disk.backup.scope, "existing_directory");
  assert.deepEqual(result.backupDirectory, {
    state: "present", ownerMatches: true, permissions: "700", access: { state: "permitted" },
  });
  assert.deepEqual(result.pm2Daemon, { state: "running", processState: "S" });
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.deepEqual(f.calls.map(call => [call.command, call.args]), [
    ["git", ["-C", "/var/www/sxb-vpn", "rev-parse", "--verify", "HEAD"]],
    ["psql", ["--version"]], ["pg_dump", ["--version"]], ["pg_restore", ["--version"]],
  ]);
  for (const { options } of f.calls) {
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 10000);
    assert.deepEqual(Object.keys(options.env).sort(), ["GIT_OPTIONAL_LOCKS", "LC_ALL", "PATH"]);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "ignore"]);
  }
});

test("absent, denied and malformed observations stay explicit without exposing diagnostics or claiming readiness", () => {
  const f = fixture();
  f.run = () => ({ status: 1, stdout: marker, stderr: marker, error: new Error(marker) });
  f.fileSystem.lstatSync = () => { throw Object.assign(new Error(marker), { code: "ENOENT" }); };
  f.fileSystem.statfsSync = () => { throw new Error(marker); };
  f.fileSystem.readFileSync = () => { throw Object.assign(new Error(marker), { code: "EACCES" }); };
  const result = collectBackendPreflight(f);
  assert.equal(result.backupDirectory.state, "absent");
  assert.equal(result.pm2Daemon.state, "read_denied");
  assert.equal(result.disk.backup.state, "unavailable");
  assert.equal(result.disk.backup.scope, "home");
  assert.equal(result.tools.pg_restore.state, "unavailable");
  assert.equal(result.deployedCheckout.state, "unavailable");
  assert.equal(JSON.stringify(result).includes(marker), false);
  f.run = () => ({ status: 0, stdout: `pg_dump (PostgreSQL) 16.9\n${marker}` });
  assert.equal(collectBackendPreflight(f).tools.pg_dump.state, "unrecognized");
});

test("backup symlinks, permission failures and reused/non-PM2 PIDs are not successful observations", () => {
  const f = fixture();
  f.fileSystem.lstatSync = () => ({ isSymbolicLink: () => true });
  assert.equal(collectBackendPreflight(f).backupDirectory.state, "symlink_refused");
  const denied = fixture();
  denied.fileSystem.accessSync = () => { throw Object.assign(new Error(marker), { code: "EACCES" }); };
  denied.fileSystem.readFileSync = () => "not-a-pid " + marker;
  assert.equal(collectBackendPreflight(denied).backupDirectory.access.state, "read_denied");
  assert.equal(collectBackendPreflight(denied).pm2Daemon.state, "invalid_pid");
  denied.fileSystem.readFileSync = name => name.endsWith("pm2.pid") ? "123" : marker;
  assert.equal(collectBackendPreflight(denied).pm2Daemon.state, "pid_not_pm2");
});

test("runner packaging preserves both exact source files byte-for-byte and the remote script parses", async () => {
  const output = path.join(scratch, "runner-env");
  const pack = spawnSync("bash", ["-c", job.steps[1].run], {
    cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_ENV: output },
  });
  assert.equal(pack.status, 0, pack.stderr);
  const encoded = Object.fromEntries((await readFile(output, "utf8")).trim().split("\n").map(line => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  for (const [key, name] of [["SXB_PREFLIGHT_CODE", "backend-preflight.cjs"], ["SXB_CRON_CODE", "check-backend-cron.cjs"]]) {
    assert.deepEqual(Buffer.from(encoded[key], "base64"), await readFile(path.join(root, "scripts", name)));
  }
  const syntax = spawnSync("bash", ["-n"], { input: remote, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("the exact remote stdin pipelines report only safe cron codes and fail closed on denied or corrupt input", async () => {
  const preload = path.join(scratch, "synthetic-boundary.cjs");
  await writeFile(preload, `
    const fs = require("node:fs");
    const originalRead = fs.readFileSync;
    fs.readFileSync = function(name, ...args) {
      if (String(name).endsWith("pm2.pid")) throw Object.assign(new Error("${marker}"), {code:"ENOENT"});
      return originalRead.call(this, name, ...args);
    };
    fs.lstatSync = () => { throw Object.assign(new Error("${marker}"), {code:"ENOENT"}); };
    fs.statfsSync = () => ({blocks:8192n,bavail:4096n,bsize:512n});
    require("node:child_process").spawnSync = (command) => {
      if(command !== "sudo") return {status:1,stdout:"${marker}",stderr:"${marker}"};
      switch(process.env.SXB_CRON_FIXTURE) {
        case "absent": return {status:1,stdout:"",stderr:"no crontab for root\\n"};
        case "present": return {status:0,stdout:"0 3 * * 0 cd /var/www/sxb-vpn && git pull && docker compose up -d # ${marker}",stderr:""};
        default: return {status:1,stdout:"",stderr:"sudo: ${marker}"};
      }
    };
  `);
  const errors = path.join(scratch, "synthetic-node-errors");
  const prefix = `node() {
    local result=0
    NODE_OPTIONS="--require=$SXB_BOUNDARY_PRELOAD" "$SXB_REAL_NODE" 2>"$SXB_BOUNDARY_ERRORS" || result=$?
    cat "$SXB_BOUNDARY_ERRORS" >&2
    return "$result"
  }\n`;
  const code = (await readFile(path.join(root, "scripts/backend-preflight.cjs"))).toString("base64");
  const cron = (await readFile(path.join(root, "scripts/check-backend-cron.cjs"))).toString("base64");
  for (const mode of ["absent", "present", "denied", "corrupt"]) {
    const result = spawnSync("bash", ["-c", prefix + remote], {
      cwd: root, encoding: "utf8", timeout: 20000, env: { ...process.env,
        SXB_BOUNDARY_PRELOAD: JSON.stringify(preload), SXB_BOUNDARY_ERRORS: errors,
        SXB_REAL_NODE: process.execPath.replaceAll("\\", "/"),
        SXB_PREFLIGHT_CODE: code, SXB_CRON_CODE: mode === "corrupt" ? cron + "!" : cron,
        SXB_CRON_FIXTURE: mode === "corrupt" ? "absent" : mode },
    });
    assert.equal(result.status, mode === "absent" ? 0 : 1,
      result.stderr + result.stdout + await readFile(errors, "utf8"));
    assert.equal((result.stdout + result.stderr).includes(marker), false);
    assert.equal(result.stderr, "");
    const lines = result.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).kind, "BACKEND_PREFLIGHT_METADATA");
    assert.equal(lines[1], mode === "absent" ? "BACKEND_LEGACY_CRON_ABSENT" :
      mode === "present" ? "BACKEND_LEGACY_CRON_PRESENT" : "BACKEND_CRON_CHECK_FAILED");
  }
});

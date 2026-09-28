const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function collectBackendPreflight({
  fileSystem = fs, run = spawnSync, home = os.homedir(),
  pm2Home = process.env.PM2_HOME || path.join(home, ".pm2"),
  uid = process.getuid?.(),
} = {}) {
  const checkout = "/var/www/sxb-vpn";
  const backup = path.join(home, "sxb-backups");
  const observe = read => {
    try { return read(); } catch (error) {
      return { state: error.code === "ENOENT" ? "absent" :
        ["EACCES", "EPERM"].includes(error.code) ? "read_denied" : "unavailable" };
    }
  };
  const command = (name, args, pattern) => observe(() => {
    const result = run(name, args, {
      shell: false, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024,
      env: { PATH: process.env.PATH, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.error || result.status !== 0) return { state: "unavailable" };
    const match = pattern.exec(result.stdout ?? "");
    return match ? { state: "available", value: match[1] } : { state: "unrecognized" };
  });
  const disk = target => observe(() => {
    const info = fileSystem.statfsSync(target, { bigint: true });
    return { state: "available", totalBytes: String(info.blocks * info.bsize),
      availableBytes: String(info.bavail * info.bsize) };
  });
  const backupDirectory = observe(() => {
    const info = fileSystem.lstatSync(backup);
    if (info.isSymbolicLink()) return { state: "symlink_refused" };
    if (!info.isDirectory()) return { state: "not_directory" };
    return { state: "present", ownerMatches: uid === undefined ? null : info.uid === uid,
      permissions: (info.mode & 0o777).toString(8).padStart(3, "0"),
      access: observe(() => {
        fileSystem.accessSync(backup, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
        return { state: "permitted" };
      }) };
  });
  const pm2 = observe(() => {
    const pid = fileSystem.readFileSync(path.join(pm2Home, "pm2.pid"), "utf8").trim();
    if (!/^[1-9]\d{0,9}$/.test(pid) || Number(pid) > 2147483647) return { state: "invalid_pid" };
    // Never invoke the PM2 CLI: even jlist can start a daemon and write files.
    const identity = fileSystem.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (!/^PM2 v[0-9][^\0\r\n]*: God Daemon \(/.test(identity)) return { state: "pid_not_pm2" };
    const stat = fileSystem.readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[0];
    if (!/^[RSDTtXZPIW]$/.test(state)) return { state: "unrecognized" };
    return { state: ["Z", "X"].includes(state) ? "not_running" : "running", processState: state };
  });
  return {
    kind: "BACKEND_PREFLIGHT_METADATA", readiness: "not_assessed",
    deployedCheckout: command("git", ["-C", checkout, "rev-parse", "--verify", "HEAD"], /^([a-f0-9]{40})\s*$/),
    tools: {
      node: { state: "available", value: process.versions.node },
      ...Object.fromEntries(["psql", "pg_dump", "pg_restore"].map(name => [
        name, command(name, ["--version"],
          new RegExp(`^${name} \\(PostgreSQL\\) (\\d+(?:\\.\\d+){0,2})(?: [^\\r\\n]*)?\\r?\\n?$`)),
      ])),
    },
    disk: { checkout: disk(checkout), backup: {
      scope: backupDirectory.state === "present" ? "existing_directory" : "home",
      ...disk(backupDirectory.state === "present" ? backup : home),
    } },
    backupDirectory, pm2Daemon: pm2,
  };
}

module.exports = { collectBackendPreflight };
if (require.main === module || !process.argv[1]) {
  try { console.log(JSON.stringify(collectBackendPreflight())); } catch {
    console.error("BACKEND_PREFLIGHT_METADATA_FAILED");
    process.exitCode = 1;
  }
}

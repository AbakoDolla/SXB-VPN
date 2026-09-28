const { spawnSync } = require("node:child_process");

function checkLegacyCron(run = spawnSync) {
  const result = run("sudo", ["-n", "crontab", "-u", "root", "-l"], {
    shell: false, windowsHide: true, encoding: "utf8", timeout: 10_000,
    maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const empty = result.status === 1 && result.stderr?.trim() === "no crontab for root" &&
    !result.stdout?.trim();
  if (result.error || (result.status !== 0 && !empty)) throw new Error("BACKEND_CRON_CHECK_FAILED");
  const unsafe = (result.stdout ?? "").split(/\r?\n/).some(line => {
    const command = line.trim();
    return !command.startsWith("#") && command.includes("/var/www/sxb-vpn") &&
      /\bgit\s+pull\b/.test(command) && /\bdocker(?:-compose|\s+compose)\s+up\b/.test(command);
  });
  if (unsafe) throw new Error("BACKEND_LEGACY_CRON_PRESENT");
}

module.exports = { checkLegacyCron };
if (require.main === module || !process.argv[1]) {
  try {
    checkLegacyCron();
    console.log("BACKEND_LEGACY_CRON_ABSENT");
  } catch (error) {
    console.error(error.message === "BACKEND_LEGACY_CRON_PRESENT"
      ? "BACKEND_LEGACY_CRON_PRESENT" : "BACKEND_CRON_CHECK_FAILED");
    console.error("Deployment stopped. Review root cron with the operator; no automatic removal.");
    process.exitCode = 1;
  }
}

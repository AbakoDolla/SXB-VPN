import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { ResetError } from "./reset-state";

export const RESET_BACKUP_TIMEOUT_MS = 120_000;
export interface ResetBackup {
  id: string;
  bytes: number;
  sha256: string;
}
export type ResetBackupProvider = (context: {
  resetId: string;
  signal: AbortSignal;
}) => Promise<ResetBackup>;

export interface PostgresResetBackupOptions {
  databaseUrl: string | undefined;
  backupDirectory?: string;
  timeoutMs?: number;
  dumpCommand?: string;
  restoreCommand?: string;
}

const prismaParameters = new Set(["schema", "connection_limit", "pool_timeout", "pgbouncer", "statement_cache_size"]);
const libpqParameters: Record<string, string> = {
  sslmode: "PGSSLMODE", sslcert: "PGSSLCERT", sslkey: "PGSSLKEY",
  sslrootcert: "PGSSLROOTCERT", sslcrl: "PGSSLCRL", sslcrldir: "PGSSLCRLDIR",
  sslpassword: "PGSSLPASSWORD", channel_binding: "PGCHANNELBINDING",
  gssencmode: "PGGSSENCMODE", host: "PGHOST", hostaddr: "PGHOSTADDR",
  options: "PGOPTIONS",
};

function postgresEnvironment(databaseUrl: string | undefined): NodeJS.ProcessEnv {
  if (!databaseUrl) throw new ResetError("RESET_BACKUP_FAILED");
  const url = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.pathname || url.pathname === "/" || url.hash) {
    throw new ResetError("RESET_BACKUP_FAILED");
  }
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^PG/i.test(key) && key !== "DATABASE_URL"));
  Object.assign(env, {
    PGHOST: url.hostname.replace(/^\[|\]$/g, ""),
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGCONNECT_TIMEOUT: "10",
    PGAPPNAME: "sxb-production-reset-backup",
  });
  for (const [key, value] of url.searchParams) {
    if (prismaParameters.has(key)) continue;
    if (key === "connect_timeout") {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 20) throw new ResetError("RESET_BACKUP_FAILED");
      env.PGCONNECT_TIMEOUT = value;
    } else if (libpqParameters[key]) {
      env[libpqParameters[key]] = value;
    } else {
      // In particular, never silently discard a TLS/connection security option.
      throw new ResetError("RESET_BACKUP_FAILED");
    }
  }
  if (!env.PGHOST || !env.PGUSER || !env.PGDATABASE ||
      Object.values(env).some(value => value?.includes("\0"))) throw new ResetError("RESET_BACKUP_FAILED");
  return env;
}

async function runCommand(
  command: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let finished = false;
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => {
      aborted = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref();
    };
    // pg_dump diagnostics can contain credentials or connection details. Drain,
    // but never forward or retain them in an API response or application log.
    child.stderr?.resume();
    child.once("error", () => finish(new ResetError("RESET_BACKUP_FAILED")));
    child.once("close", code => finish(code === 0 && !aborted ? undefined : new ResetError("RESET_BACKUP_FAILED")));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function inside(directory: string, parent: string): boolean {
  const relative = path.relative(parent, directory);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function createPostgresResetBackup(options: PostgresResetBackupOptions): ResetBackupProvider {
  return async ({ resetId, signal }) => {
    try {
      if (!/^[0-9a-f-]{36}$/.test(resetId)) throw new ResetError("RESET_BACKUP_FAILED");
      const timeout = options.timeoutMs ?? RESET_BACKUP_TIMEOUT_MS;
      if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > RESET_BACKUP_TIMEOUT_MS) {
        throw new ResetError("RESET_BACKUP_FAILED");
      }
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
      bounded.throwIfAborted();
      const env = postgresEnvironment(options.databaseUrl);
      const directory = options.backupDirectory ?? "/var/backups/sxb-vpn";
      if (!path.isAbsolute(directory) || path.parse(directory).root === directory ||
          inside(path.resolve(directory), process.cwd())) throw new ResetError("RESET_BACKUP_FAILED");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const directoryInfo = await lstat(directory);
      const canonicalDirectory = await realpath(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() ||
          inside(canonicalDirectory, await realpath(process.cwd())) ||
          (process.getuid && directoryInfo.uid !== process.getuid())) throw new ResetError("RESET_BACKUP_FAILED");
      await chmod(canonicalDirectory, 0o700);

      const file = path.join(canonicalDirectory, `reset-${resetId}.dump`);
      // Exclusive creation prevents clobbering any previous backup, including a
      // failed attempt. Backup files are never deleted by application reset.
      const reserved = await open(file, "wx", 0o600);
      await reserved.close();
      await runCommand(options.dumpCommand ?? "pg_dump", [
        "--format=custom", "--compress=6", "--no-password", "--file", file,
      ], env, bounded);
      bounded.throwIfAborted();
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || !Number.isSafeInteger(info.size) || info.size < 1024 ||
          (process.platform !== "win32" && (info.mode & 0o077) !== 0)) throw new ResetError("RESET_BACKUP_FAILED");
      const handle = await open(file, "r+");
      try {
        const header = Buffer.alloc(5);
        await handle.read(header, 0, header.length, 0);
        if (header.toString("ascii") !== "PGDMP") throw new ResetError("RESET_BACKUP_FAILED");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await runCommand(options.restoreCommand ?? "pg_restore", ["--list", file], env, bounded);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file, { signal: bounded })) hash.update(chunk);
      bounded.throwIfAborted();
      const after = await lstat(file);
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ino !== info.ino) {
        throw new ResetError("RESET_BACKUP_FAILED");
      }
      if (process.platform !== "win32") {
        const parent = await open(canonicalDirectory, "r");
        try { await parent.sync(); } finally { await parent.close(); }
      }
      return { id: resetId, bytes: info.size, sha256: hash.digest("hex") };
    } catch {
      // All backup failures are fail-closed, including aborts, missing tools,
      // invalid archives, filesystem permissions and libpq configuration.
      throw new ResetError("RESET_BACKUP_FAILED");
    }
  };
}

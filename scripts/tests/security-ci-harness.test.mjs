import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = file => readFileSync(path.join(root, file), "utf8");

test("native proof harness uses the explicitly installed mobile TypeScript loader", () => {
  const mobile = JSON.parse(read("app-mobile/package.json"));
  assert.ok(mobile.devDependencies.tsx);
  const runner = read("app-mobile/tests/run-device-security.cjs");
  assert.match(runner, /require\('tsx\/cjs\/api'\)/);
  assert.doesNotMatch(runner, /backend|esbuild/);
  assert.match(runner, /requireTypescript\([\s\S]*?'mobile-proof\.ts'/);
});

test("exact CI PREPARE generates its isolated Prisma client without autoinstall or a database", () => {
  const workflow = read(".github/workflows/verification-pr.yml");
  const prepare = workflow.match(/node <<'PREPARE'\r?\n([\s\S]*?)\s+PREPARE\r?\n/);
  assert.ok(prepare);
  assert.match(workflow, /trap 'rm -f "\$SXB_SECURITY_SCHEMA"' EXIT/);
  assert.match(workflow, /generate --schema "\$SXB_SECURITY_SCHEMA"/);
  const temporary = mkdtempSync(path.join(tmpdir(), "sxb-ci-generator-"));
  const schema = path.join(root, "backend", `.sxb-security-schema-${randomUUID()}.prisma`);
  const client = path.join(temporary, "client", "index.js");
  const env = {
    ...process.env, RUNNER_TEMP: temporary, SXB_SECURITY_SCHEMA: schema,
    SXB_SECURITY_PRISMA_CLIENT: client, PRISMA_GENERATE_SKIP_AUTOINSTALL: "1",
    CHECKPOINT_DISABLE: "1",
    DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/sxb_security_impl",
  };
  const execute = args => execFileSync(process.execPath, args, {
    cwd: root, env, encoding: "utf8", timeout: 120_000, stdio: "pipe",
  });
  try {
    execute(["-e", prepare[1]]);
    assert.equal(path.dirname(schema), path.join(root, "backend"));
    const cli = path.join(root, "backend", "node_modules", "prisma", "build", "index.js");
    execute([cli, "generate", "--schema", schema]);
    assert.ok(existsSync(client), "The real generator must produce the exact isolated output");
    const generated = readFileSync(path.join(temporary, "client", "schema.prisma"), "utf8");
    assert.match(generated, /model MobileConnection/);
    assert.match(generated, /model MobileProofNonce/);
  } finally {
    rmSync(schema, { force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
});

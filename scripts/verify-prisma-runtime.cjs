const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const path = require("node:path");

function schemaFingerprint(client) {
  assert.ok(client.Prisma?.dmmf?.datamodel, "Generated Prisma schema is missing");
  return createHash("sha256")
    .update(JSON.stringify(client.Prisma.dmmf.datamodel))
    .digest("hex");
}

function verifyPrismaRuntime(root = process.cwd()) {
  const expectedRequire = createRequire(path.join(root, "backend", "package.json"));
  const runtimeRequire = createRequire(path.join(root, "dist", "server.cjs"));
  const expected = expectedRequire("@prisma/client");
  const runtime = runtimeRequire("@prisma/client");
  assert.equal(
    schemaFingerprint(runtime),
    schemaFingerprint(expected),
    "The server resolves a stale Prisma client. Generate both mirrored schemas after dependency installation."
  );
  console.log(`Prisma runtime schema verified: ${runtimeRequire.resolve("@prisma/client")}`);
}

module.exports = { schemaFingerprint, verifyPrismaRuntime };
if (require.main === module) verifyPrismaRuntime();

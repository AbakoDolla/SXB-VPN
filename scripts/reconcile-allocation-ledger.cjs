const { createRequire } = require('node:module');
const path = require('node:path');

async function main() {
  const root = path.resolve(__dirname, '..');
  const backend = createRequire(path.join(root, 'backend', 'package.json'));
  if (!process.env.DATABASE_URL) {
    const result = backend('dotenv').config({ path: path.join(root, '.env'), quiet: true });
    if (result.error) throw new Error('ALLOCATION_DATABASE_CONFIG_INVALID');
  }
  const { require: load } = backend('tsx/cjs/api');
  const { checkBackendSchema } = load(path.join(root, 'server', 'services', 'backend-migration.ts'), __filename);
  await checkBackendSchema({
    root, databaseUrl: process.env.DATABASE_URL, prismaCli: backend.resolve('prisma/build/index.js'),
    psqlCommand: process.env.PSQL_BIN,
  });
  const { reconcilierAllocationsRevendeurs } = load(path.join(root, 'server', 'services', 'reseller-quota.ts'), __filename);
  const { PrismaClient } = backend('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const result = await reconcilierAllocationsRevendeurs(prisma);
    console.log(JSON.stringify({ status: 'allocation-reservations-reconciled', ...result }));
  } finally { await prisma.$disconnect(); }
}

main().catch(() => {
  console.error('ALLOCATION_LEDGER_RECONCILIATION_FAILED');
  process.exitCode = 1;
});

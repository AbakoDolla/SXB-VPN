import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serviceUrl = pathToFileURL(path.join(root, "server/services/reseller-quota.ts")).href;
const {
  executerMutationQuota,
  modifierPlafondQuota,
  PlafondQuotaDepasse,
  porteeHistoriqueQuota,
  serialiserMouvementQuota,
} = await import(`${serviceUrl}?test=${Date.now()}`);

function fakeDatabase(initial) {
  const state = structuredClone(initial);
  const transaction = async (callback) => {
    const draft = structuredClone(state);
    const tx = {
      $queryRawUnsafe: async () => [],
      reseller: {
        findUnique: async ({ where }) =>
          where.id === draft.reseller.id || where.userId === draft.reseller.userId
            ? structuredClone(draft.reseller)
            : null,
        update: async ({ data }) => {
          Object.assign(draft.reseller, data);
          return structuredClone(draft.reseller);
        },
      },
      vpnClient: {
        findMany: async ({ where }) =>
          structuredClone(draft.clients.filter((client) => client.userId === where.userId)),
        create: async ({ data }) => {
          const client = { id: `client-${draft.clients.length + 1}`, subscriptions: [], ...data };
          draft.clients.push(client);
          return structuredClone(client);
        },
        delete: async ({ where }) => {
          const index = draft.clients.findIndex((client) => client.id === where.id);
          return draft.clients.splice(index, 1)[0];
        },
      },
      resellerQuotaMovement: {
        create: async ({ data }) => {
          draft.movements.push(structuredClone(data));
          return data;
        },
      },
    };
    const result = await callback(tx);
    Object.assign(state, draft);
    return result;
  };
  return { state, $transaction: transaction };
}

const baseState = {
  reseller: {
    id: "reseller-1",
    userId: "user-1",
    quotaBytes: BigInt(10),
    quotaUsedBytes: BigInt(0),
    user: { name: "Alice", email: "alice@example.test", role: { name: "RESELLER" } },
  },
  clients: [],
  movements: [],
};

// Permissions: un revendeur ne peut jamais injecter l'identifiant d'un tiers.
assert.deepEqual(porteeHistoriqueQuota("RESELLER", "user-1", "reseller-2"), {
  resellerUserId: "user-1",
});
assert.deepEqual(porteeHistoriqueQuota("ADMIN", "admin-1", "reseller-2"), {
  resellerId: "reseller-2",
});
assert.throws(() => porteeHistoriqueQuota("SUPPORT", "support-1"));

// BigInt: aucune conversion Number ne doit alterer les octets exposes en JSON.
const huge = BigInt("900719925474099312345");
const serialized = serialiserMouvementQuota({
  resellerName: "Alice",
  actorName: "Admin",
  kind: "ADMIN_ALLOCATION",
  reason: "Test",
  deltaBytes: huge,
  quotaBeforeBytes: BigInt(0),
  quotaAfterBytes: huge,
  allocatedBeforeBytes: BigInt(0),
  allocatedAfterBytes: BigInt(0),
  createdAt: new Date("2026-09-07T00:00:00Z"),
});
assert.equal(serialized.deltaBytes, "900719925474099312345");
assert.equal(serialized.quotaAfterBytes, "900719925474099312345");

// Invariant: depassement = rollback complet, sans client ni ligne d'audit.
const rejected = fakeDatabase(baseState);
await assert.rejects(
  executerMutationQuota(
    rejected,
    { resellerUserId: "user-1", auteur: { name: "Admin" }, reason: "Trop grand" },
    (tx) => tx.vpnClient.create({
      data: { userId: "user-1", quotaTotal: BigInt(11), quotaUsed: BigInt(0) },
    })
  ),
  PlafondQuotaDepasse
);
assert.equal(rejected.state.clients.length, 0);
assert.equal(rejected.state.movements.length, 0);
assert.equal(rejected.state.reseller.quotaUsedBytes, BigInt(0));

// Invariant: engagement, compteur et audit sont valides ensemble, une seule fois.
const accepted = fakeDatabase(baseState);
const client = await executerMutationQuota(
  accepted,
  { resellerUserId: "user-1", auteur: { name: "Admin" }, reason: "Nouveau client" },
  (tx) => tx.vpnClient.create({
    data: { userId: "user-1", quotaTotal: BigInt(4), quotaUsed: BigInt(0) },
  })
);
assert.equal(accepted.state.reseller.quotaUsedBytes, BigInt(4));
assert.equal(accepted.state.movements.length, 1);
assert.equal(accepted.state.movements[0].deltaBytes, BigInt(4));

await executerMutationQuota(
  accepted,
  { resellerUserId: "user-1", auteur: { name: "Admin" }, reason: "Suppression" },
  (tx) => tx.vpnClient.delete({ where: { id: client.id } })
);
assert.equal(accepted.state.reseller.quotaUsedBytes, BigInt(0));
assert.equal(accepted.state.movements.length, 2);
assert.equal(accepted.state.movements[1].kind, "QUOTA_RELEASE");
assert.equal(accepted.state.movements[1].deltaBytes, BigInt(-4));

await executerMutationQuota(
  accepted,
  { resellerUserId: "user-1", auteur: { name: "Admin" }, reason: "Sans changement" },
  async () => null
);
assert.equal(accepted.state.movements.length, 2, "aucune ligne ne doit doubler un decompte inchange");

// Un retrait sous l'engagement courant est refuse sans changer le plafond.
const capped = fakeDatabase({
  ...baseState,
  clients: [{
    id: "client-1",
    userId: "user-1",
    quotaTotal: BigInt(6),
    quotaUsed: BigInt(0),
    subscriptions: [],
  }],
});
await assert.rejects(
  modifierPlafondQuota(capped, {
    resellerId: "reseller-1",
    nouveauPlafond: BigInt(5),
    auteur: { name: "Admin" },
    reason: "Retrait invalide",
  }),
  PlafondQuotaDepasse
);
assert.equal(capped.state.reseller.quotaBytes, BigInt(10));
assert.equal(capped.state.movements.length, 0);

await modifierPlafondQuota(capped, {
  resellerId: "reseller-1",
  nouveauPlafond: BigInt(20),
  auteur: { name: "Admin" },
  reason: "Extension contractuelle",
});
assert.equal(capped.state.movements[0].kind, "ADMIN_ALLOCATION");
assert.equal(capped.state.movements[0].quotaBeforeBytes, BigInt(10));
assert.equal(capped.state.movements[0].quotaAfterBytes, BigInt(20));

await modifierPlafondQuota(capped, {
  resellerId: "reseller-1",
  nouveauPlafond: BigInt(15),
  auteur: { name: "Admin" },
  reason: "Regularisation",
  correction: true,
});
assert.equal(capped.state.movements[1].kind, "ADMIN_CORRECTION");

const migration = await fs.readFile(
  path.join(root, "backend/prisma/migrations/20260907050730_reseller_quota_ledger/migration.sql"),
  "utf8"
);
assert.match(migration, /CREATE TABLE IF NOT EXISTS "reseller_quota_movements"/);
assert.match(migration, /BEFORE UPDATE OR DELETE/);
assert.doesNotMatch(migration, /INSERT INTO "reseller_quota_movements"/);

console.log("reseller quota ledger: permissions, BigInt and invariants OK");

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
      voucher: { findMany: async () => [] },
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
        findMany: async ({ where }) => {
          const conditions = Array.isArray(where.OR) ? where.OR : [where];
          return structuredClone(draft.clients.filter((client) =>
            conditions.some((condition) =>
              (condition.userId === undefined || client.userId === condition.userId) &&
              (condition.resellerId === undefined ||
                (condition.resellerId === null
                  ? client.resellerId == null
                  : client.resellerId === condition.resellerId))
            )
          ));
        },
        create: async ({ data }) => {
          const client = {
            id: `client-${draft.clients.length + 1}`,
            subscriptions: [],
            tokens: [],
            ...data,
          };
          draft.clients.push(client);
          return structuredClone(client);
        },
        delete: async ({ where }) => {
          const index = draft.clients.findIndex((client) => client.id === where.id);
          return draft.clients.splice(index, 1)[0];
        },
        update: async ({ where, data }) => {
          const client = draft.clients.find((candidate) => candidate.id === where.id);
          Object.assign(client, data);
          return structuredClone(client);
        },
      },
      tokenSXB: {
        create: async ({ data }) => {
          const client = draft.clients.find((candidate) => candidate.id === data.clientId);
          const token = { id: `token-${client.tokens.length + 1}`, ...data };
          client.tokens.push(token);
          return structuredClone(token);
        },
        update: async ({ where, data }) => {
          for (const client of draft.clients) {
            const token = (client.tokens || []).find((candidate) => candidate.id === where.id);
            if (token) {
              Object.assign(token, data);
              return structuredClone(token);
            }
          }
          throw new Error("token not found");
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

// Un jeton non utilisé réserve l'enveloppe. Sa révocation la libère dans la
// même transaction et le compteur matérialisé reste cohérent.
const tokenReservation = fakeDatabase({
  ...baseState,
  clients: [{
    id: "client-token",
    userId: "user-1",
    status: "active",
    expireAt: new Date(Date.now() + 86_400_000),
    quotaTotal: 0n,
    quotaUsed: 0n,
    subscriptions: [],
    tokens: [],
  }],
});
const reservedToken = await executerMutationQuota(
  tokenReservation,
  {
    resellerUserId: "user-1",
    auteur: { name: "Alice" },
    reason: "Jeton réservé",
  },
  (tx) => tx.tokenSXB.create({
    data: {
      clientId: "client-token",
      quota: 6n,
      status: "active",
      expiration: new Date(Date.now() + 86_400_000),
    },
  })
);
assert.equal(tokenReservation.state.reseller.quotaUsedBytes, 6n);
assert.equal(tokenReservation.state.movements[0].kind, "QUOTA_COMMITMENT");

await executerMutationQuota(
  tokenReservation,
  {
    resellerUserId: "user-1",
    auteur: { name: "Alice" },
    reason: "Jeton révoqué",
    autoriserReductionAuDessusDuPlafond: true,
  },
  (tx) => tx.tokenSXB.update({
    where: { id: reservedToken.id },
    data: { status: "revoked" },
  })
);
assert.equal(tokenReservation.state.reseller.quotaUsedBytes, 0n);
assert.equal(tokenReservation.state.movements[1].kind, "QUOTA_RELEASE");

await executerMutationQuota(
  accepted,
  { resellerUserId: "user-1", auteur: { name: "Admin" }, reason: "Sans changement" },
  async () => null
);
assert.equal(accepted.state.movements.length, 2, "aucune ligne ne doit doubler un decompte inchange");

// Un revendeur déjà au-dessus de son plafond doit pouvoir réduire son
// engagement ; sinon la transaction l'empêcherait précisément de se remettre
// en conformité.
const overLimit = fakeDatabase({
  ...baseState,
  reseller: { ...baseState.reseller, quotaBytes: 10n, quotaUsedBytes: 12n },
  clients: [{ id: "client-over", userId: "user-1", quotaTotal: 12n, quotaUsed: 1n, subscriptions: [] }],
});
await executerMutationQuota(
  overLimit,
  {
    resellerUserId: "user-1",
    auteur: { name: "Alice" },
    reason: "Réduction sous dépassement",
    autoriserReductionAuDessusDuPlafond: true,
  },
  (tx) => tx.vpnClient.delete({ where: { id: "client-over" } })
);
assert.equal(overLimit.state.clients.length, 0);
assert.equal(overLimit.state.reseller.quotaUsedBytes, 0n);

// Réactiver ou renouveler un client suspendu réengage son volume. La même
// transaction doit donc refuser l'opération si d'autres clients occupent déjà
// l'enveloppe, sans laisser le client partiellement réactivé.
const renewalOverLimit = fakeDatabase({
  ...baseState,
  clients: [
    { id: "active-client", userId: "user-1", status: "active", quotaTotal: 8n, quotaUsed: 0n, subscriptions: [] },
    { id: "suspended-client", userId: "user-1", status: "suspended", quotaTotal: 4n, quotaUsed: 0n, subscriptions: [] },
  ],
});
await assert.rejects(
  executerMutationQuota(
    renewalOverLimit,
    { resellerUserId: "user-1", auteur: { name: "Alice" }, reason: "Renouvellement" },
    (tx) => tx.vpnClient.update({
      where: { id: "suspended-client" },
      data: { status: "active" },
    })
  ),
  PlafondQuotaDepasse
);
assert.equal(
  renewalOverLimit.state.clients.find((candidate) => candidate.id === "suspended-client").status,
  "suspended"
);
assert.equal(renewalOverLimit.state.movements.length, 0);

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

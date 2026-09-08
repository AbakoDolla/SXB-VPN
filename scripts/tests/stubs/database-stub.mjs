/**
 * database-stub.mjs — Stub Prisma en mémoire pour tests E2E de routes.
 * Remplace server/database.ts (résolution redirigée par resolve-hooks.mjs).
 *
 * L'état est MUTABLE par le test via `__fixtures` pour couvrir tous les
 * scénarios : abonnement actif, expiré, suspendu, révoqué, mauvais appareil…
 */
export const __fixtures = {
  subscription: null,   // objet Subscription (avec .profile, .client.user)
  subscriptionUpdateCalls: [],
  sshPayload: null,     // objet SshPayload
  user: null,           // objet User (avec role.permissions)
  trafficUsageCreates: [],
  vpnClient: null,      // objet VpnClient (avec .user)
  auditLogs: [],
};

export const prisma = {
  user: {
    async findUnique() { return __fixtures.user; },
  },
  subscription: {
    async findFirst({ where } = {}) {
      const sub = __fixtures.subscription;
      if (!sub) return null;
      // Filtrage minimal des clauses utilisées par provision.ts / mobile.ts
      if (where?.dataToken && sub.dataToken !== where.dataToken) return null;
      if (where?.clientId && sub.clientId !== where.clientId) return null;
      if (where?.status && sub.status !== where.status) return null;
      return sub;
    },
    async findMany({ where } = {}) {
      const sub = __fixtures.subscription;
      if (!sub) return [];
      if (where?.clientId && sub.clientId !== where.clientId) return [];
      return [sub];
    },
    async findUnique({ where }) {
      return __fixtures.subscription && __fixtures.subscription.id === where.id
        ? __fixtures.subscription : null;
    },
    async update({ where, data }) {
      __fixtures.subscriptionUpdateCalls.push({ where, data });
      if (__fixtures.subscription && __fixtures.subscription.id === where.id) {
        Object.assign(__fixtures.subscription, data);
      }
      return __fixtures.subscription;
    },
    async updateMany({ where, data }) {
      const sub = __fixtures.subscription;
      if (!sub) return { count: 0 };
      if (where?.id && sub.id !== where.id) return { count: 0 };
      if (where?.clientId && sub.clientId !== where.clientId) return { count: 0 };
      __fixtures.subscriptionUpdateCalls.push({ where, data });
      if (data?.quotaUsed?.increment !== undefined) {
        sub.quotaUsed = BigInt(sub.quotaUsed ?? 0) + BigInt(data.quotaUsed.increment);
      } else {
        Object.assign(sub, data);
      }
      return { count: 1 };
    },
  },
  sshPayload: {
    async findUnique() { return __fixtures.sshPayload; },
  },
  trafficUsage: {
    async create({ data }) { __fixtures.trafficUsageCreates.push(data); return data; },
  },
  vpnClient: {
    async findMany() {
      return __fixtures.vpnClient ? [__fixtures.vpnClient] : [];
    },
    async findFirst({ where } = {}) {
      const c = __fixtures.vpnClient;
      if (!c) return null;
      if (where?.userId && c.userId !== where.userId) return null;
      return c;
    },
    async findUnique({ where } = {}) {
      const c = __fixtures.vpnClient;
      if (!c) return null;
      if (where?.id && c.id !== where.id) return null;
      if (where?.deviceId && c.deviceId !== where.deviceId) return null;
      return c;
    },
    async update({ where, data }) {
      if (__fixtures.vpnClient && __fixtures.vpnClient.id === where.id) {
        if (data?.quotaUsed?.increment !== undefined) {
          __fixtures.vpnClient.quotaUsed =
            BigInt(__fixtures.vpnClient.quotaUsed ?? 0) + BigInt(data.quotaUsed.increment);
        } else {
          Object.assign(__fixtures.vpnClient, data);
        }
      }
      return __fixtures.vpnClient;
    },
  },
  activationSession: {
    async upsert() { return { id: 'sess-001' }; },
  },
  subscriptionDevice: {
    async updateMany() { return { count: 0 }; },
  },
  auditLog: {
    async findMany() { return __fixtures.auditLogs; },
  },
  voucher: {
    async findFirst({ where } = {}) {
      const v = __fixtures.voucher;
      if (!v) return null;
      if (where?.code && v.code !== where.code) return null;
      return v;
    },
    async update({ where, data }) {
      if (__fixtures.voucher && __fixtures.voucher.id === where.id) {
        Object.assign(__fixtures.voucher, data);
      }
      return __fixtures.voucher;
    },
  },
  async $transaction(arg) {
    if (typeof arg === 'function') {
      return arg(prisma);
    }
    return Promise.all(arg);
  },
  async $executeRawUnsafe() { return 1; },
};

export const inMemoryDb = {
  users: [], rolePermissions: [], permissions: [], vpnClients: [], vouchers: [],
};

export async function logDbActivity() { /* stub — pas d'écriture en test */ }

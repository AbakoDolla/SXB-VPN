import type { Prisma } from '@prisma/client';

export type DataAllocationType = 'sold' | 'free_trial';
type Instant = Date | string | null;
interface AllocationIdentity {
  allocationType?: string | null;
  allocationUserId?: string | null;
  allocationOwnerId?: string | null;
  allocationOwnerName?: string | null;
  allocationResellerId?: string | null;
  allocationOrigin?: string | null;
  freeTrialRequestId?: string | null;
  createdBy?: string | null;
  client?: { userId?: string | null; resellerId?: string | null;
    reseller?: { id?: string; user?: { name?: string | null } } | null } | null;
}
interface AllocationRecord extends AllocationIdentity {
  id: string;
  quotaBytes?: bigint | number | string | null;
  quotaUsed?: bigint | number | string | null;
  createdAt?: Instant;
  profileId?: string;
  profile?: { name?: string | null; status?: string } | null;
  status?: string;
  startAt?: Instant;
  expireAt?: Instant;
  deviceId?: string | null;
  devices?: Array<{ deviceId: string }>;
  deviceLimit?: number;
  allocationFundingStatus?: string;
}
type MerchantIdentity = { id: string; userId: string };
export interface AllocationOwner {
  resellerId: string | null;
  ownerId: string | null;
  ownerName: string | null;
  type: DataAllocationType;
}

export function dataAllocationType(row: AllocationIdentity | null | undefined): DataAllocationType {
  if (row?.allocationType != null) {
    if (row.allocationType !== 'sold' && row.allocationType !== 'free_trial') throw new Error('ALLOCATION_TYPE_INVALID');
    return row.allocationType;
  }
  return row?.freeTrialRequestId ? 'free_trial' : 'sold';
}

export function dataAllocationOwner(row: AllocationIdentity | null | undefined): AllocationOwner {
  const type = dataAllocationType(row);
  const explicit = row?.allocationType != null;
  return {
    type,
    resellerId: type === 'free_trial' ? null : explicit
      ? row?.allocationResellerId ?? null : row?.client?.resellerId ?? row?.client?.reseller?.id ?? null,
    ownerId: row?.allocationOwnerId ?? (type === 'free_trial' ? row?.createdBy : row?.client?.userId) ?? null,
    ownerName: row?.allocationOwnerName ?? (explicit ? null : row?.client?.reseller?.user?.name) ?? null,
  };
}

export function ownsDataAllocation(row: AllocationIdentity | null | undefined, reseller: MerchantIdentity | null | undefined): boolean {
  if (!row || !reseller || dataAllocationType(row) !== 'sold') return false;
  const owner = dataAllocationOwner(row);
  return owner.resellerId ? owner.resellerId === reseller.id :
    row.allocationType == null && row?.client?.userId === reseller.userId;
}

export function dataAllocationScope(reseller: MerchantIdentity | null | undefined): Prisma.SubscriptionWhereInput {
  if (!reseller) return { id: '__aucun__' };
  return { OR: [
    { allocationType: 'sold', allocationResellerId: reseller.id },
    { allocationType: null, freeTrialRequestId: null, client: { OR: [
      { resellerId: reseller.id }, { resellerId: null, userId: reseller.userId },
    ] } },
  ] };
}

export function dataAllocationQuotaOwner(row: AllocationIdentity | null | undefined) {
  const owner = dataAllocationOwner(row);
  return {
    resellerId: owner.resellerId,
    resellerUserId: row?.allocationType == null && owner.type === 'sold' ? row?.client?.userId ?? null : null,
  };
}

export function dataAllocationView(row: AllocationRecord) {
  const allocated = BigInt(row.quotaBytes ?? 0), used = BigInt(row.quotaUsed ?? 0);
  const owner = dataAllocationOwner(row);
  return {
    id: row.id,
    userId: row.allocationUserId ?? row.client?.userId ?? null,
    ownerId: owner.ownerId,
    resellerId: owner.resellerId,
    ownerName: owner.ownerName,
    type: owner.type,
    allocatedBytes: allocated.toString(),
    usedBytes: used.toString(),
    remainingBytes: allocated < 0n ? null : (allocated > used ? allocated - used : 0n).toString(),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    profileId: row.profileId,
    configurationName: row.profile?.name ?? null,
    origin: row.allocationOrigin ?? 'legacy',
  };
}

export function summarizeDataAllocations(rows: readonly AllocationRecord[], deviceId?: string | null, now = Date.now()) {
  const total = { sold: 0n, freeTrial: 0n, used: 0n, remaining: 0n, unlimited: false };
  for (const row of rows) {
    if (!['active', 'exhausted'].includes(row.status) || row.allocationFundingStatus && row.allocationFundingStatus !== 'active' ||
        row.expireAt && new Date(row.expireAt).getTime() <= now ||
        row.startAt && new Date(row.startAt).getTime() > now ||
        row.profile === null || row.profile && row.profile.status !== 'active' ||
        deviceId && row.deviceId && row.deviceId !== deviceId ||
        deviceId && row.devices?.length && !row.devices.some(binding => binding.deviceId === deviceId)
          && row.devices.length >= (row.deviceLimit ?? 1)) continue;
    const allocated = BigInt(row.quotaBytes ?? 0), used = BigInt(row.quotaUsed ?? 0);
    total.used += used;
    if (allocated < 0n) { total.unlimited = true; continue; }
    if (dataAllocationType(row) === 'free_trial') total.freeTrial += allocated;
    else total.sold += allocated;
    total.remaining += allocated > used ? allocated - used : 0n;
  }

  return {
    soldBytes: total.sold.toString(), freeTrialBytes: total.freeTrial.toString(),
    allocatedBytes: (total.sold + total.freeTrial).toString(), usedBytes: total.used.toString(),
    remainingBytes: total.unlimited ? null : total.remaining.toString(), unlimited: total.unlimited,
  };
}

export async function withAllocationAccess<T extends AllocationRecord>(
  db: Pick<Prisma.TransactionClient, 'reseller'>, rows: T[], now = Date.now(),
) {
  const ids = [...new Set(rows.filter(row => row.allocationType === 'sold')
    .map(row => row.allocationResellerId).filter((id): id is string => !!id))];
  if (!ids.length) return rows;
  const owners = await db.reseller.findMany({
    where: { id: { in: ids } }, select: { id: true, status: true, accessExpiresAt: true,
      user: { select: { status: true } } },
  });
  const byId = new Map(owners.map(owner => [owner.id, owner]));
  return rows.map(row => {
    if (row.allocationType !== 'sold' || !row.allocationResellerId) return row;
    const owner = byId.get(row.allocationResellerId);
    const status = !owner || owner.status !== 'active' || owner.user?.status !== 'active' ? 'suspended'
      : owner.accessExpiresAt && new Date(owner.accessExpiresAt).getTime() <= now ? 'expired' : 'active';
    return { ...row, allocationFundingStatus: status };
  });
}

/** Project financial counters only; never mutate the customer's account ledger. */
export function resellerClientAllocationView<T extends {
  userId?: string; resellerId?: string | null; status?: string; expireAt?: Instant;
  quotaTotal?: bigint | number | null; quotaUsed?: bigint | number | null;
  subscriptions?: AllocationRecord[];
}>(client: T, merchant: MerchantIdentity | null | undefined, now = Date.now()) {
  if (!merchant) return client;
  const all = client.subscriptions ?? [];
  const subscriptions = all.filter(row => ownsDataAllocation({ ...row, client }, merchant));
  const accountOwned = client.resellerId ? client.resellerId === merchant.id : client.userId === merchant.userId;
  const used = subscriptions.reduce((sum, row) => sum + BigInt(row.quotaUsed ?? 0), 0n);
  const legacyTotal = accountOwned ? BigInt(client.quotaTotal ?? 0) : 0n;
  const attributedUsed = all.reduce((sum, row) => sum + BigInt(row.quotaUsed ?? 0), 0n);
  const legacyUsed = legacyTotal !== 0n ? BigInt(client.quotaUsed ?? 0) - attributedUsed : 0n;
  const allocated = subscriptions.reduce((sum, row) => {
    if (!['active', 'exhausted'].includes(row.status ?? '') || row.expireAt && new Date(row.expireAt).getTime() <= now) return sum;
    return sum + BigInt(row.quotaBytes ?? 0);
  }, 0n);
  return {
    ...client, subscriptions,
    quotaTotal: subscriptions.length ? allocated : legacyTotal,
    quotaUsed: subscriptions.length ? used : legacyUsed > 0n ? legacyUsed : 0n,
  };
}

export async function resellerTrafficAllocationScope(db: Pick<Prisma.TransactionClient, 'subscription' | 'dataAddition'>,
  merchant: MerchantIdentity | null | undefined): Promise<Prisma.TrafficUsageWhereInput> {
  if (!merchant) return { id: '__aucun__' };
  const [current, historical] = await Promise.all([
    db.subscription.findMany({ where: dataAllocationScope(merchant), select: { id: true } }),
    db.dataAddition.findMany({ where: { allocationResellerId: merchant.id, allocationType: 'sold' }, select: { subscriptionId: true } }),
  ]);
  const ids = [...new Set([...current.map(row => row.id), ...historical.map(row => row.subscriptionId)])];
  return { OR: [
    { accountId: { in: ids } },
    { accountId: null, client: { OR: [{ resellerId: merchant.id }, { resellerId: null, userId: merchant.userId }] } },
  ] };
}

/** Stamp once, inside the mutation's transaction; later account reassignments cannot change funding. */
export function withDataAllocationIdentity(tx: any, owner: {
  resellerId?: string | null; resellerUserId?: string | null; actorUserId?: string | null; actorName?: string | null;
}) {
  const delegate = tx.subscription;
  if (!delegate?.create) return tx;
  const subscriptions = new Proxy(delegate, {
    get(target, key) {
      const method = Reflect.get(target, key);
      if (key !== 'create' || typeof method !== 'function') return typeof method === 'function' ? method.bind(target) : method;
      return async (args: any) => {
        const client = await tx.vpnClient.findUnique({ where: { id: args.data.clientId }, select: { userId: true } });
        if (!client) throw new Error('ALLOCATION_CLIENT_REQUIRED');
        const trial = Boolean(args.data.freeTrialRequestId) || args.data.allocationType === 'free_trial';
        const resellerId = trial ? null : owner.resellerId ?? null;
        const merchant = resellerId
          ? await tx.reseller.findUnique({ where: { id: resellerId }, include: { user: true } })
          : null;
        if (resellerId && !merchant) throw new Error('ALLOCATION_OWNER_REQUIRED');
        const data = {
          ...args.data,
          allocationUserId: client.userId,
          allocationOwnerId: merchant?.userId ?? owner.actorUserId ?? 'system',
          allocationOwnerName: merchant?.user?.name || merchant?.user?.email || 'Systeme',
          allocationResellerId: resellerId,
          allocationType: trial ? 'free_trial' : 'sold',
          allocationOrigin: 'explicit',
        };
        return method.call(target, { ...args, data });
      };
    },
  });
  return new Proxy(tx, {
    get(target, key) {
      if (key === 'subscription') return subscriptions;
      const method = Reflect.get(target, key);
      return typeof method === 'function' ? method.bind(target) : method;
    },
  });
}

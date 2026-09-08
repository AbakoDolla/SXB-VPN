import type { Prisma, VpnProfile } from '@prisma/client';
import { prisma } from '../database';
import type { AuthenticatedRequest } from '../middleware/auth';
import { encryptCanonical } from './canonical-config';
import { assertProfileUnlocked, createProfileLock, ProfileLockError, profileUnlockExpiry } from './profile-lock';

export type ProfileEngine = 'ssh' | 'xray' | 'singbox';
type Db = Prisma.TransactionClient;
type Account = {
  id: string; name: string; host: string; port: number; protocol?: string;
  username?: string | null; uuid?: string | null; password?: string | null;
  [key: string]: any;
};
const tables = { ssh: 'ssh_accounts', xray: 'xray_accounts', singbox: 'singbox_accounts' } as const;
async function findAccounts(db: Db, engine: ProfileEngine, host: string, port: number): Promise<Account[]> {
  const where = { host, port };
  if (engine === 'ssh') return db.sshAccount.findMany({ where });
  if (engine === 'xray') return db.xrayAccount.findMany({ where });
  return db.singboxAccount.findMany({ where });
}
async function findAccount(db: Db, engine: ProfileEngine, id: string): Promise<Account | null> {
  if (engine === 'ssh') return db.sshAccount.findUnique({ where: { id } });
  if (engine === 'xray') return db.xrayAccount.findUnique({ where: { id } });
  return db.singboxAccount.findUnique({ where: { id } });
}
const profileName = (engine: ProfileEngine, account: Account) =>
  engine === 'ssh' ? `[SSH] ${account.name}` :
    `[${account.protocol!.toUpperCase()}${engine === 'singbox' ? '-SB' : ''}] ${account.name}`;

function legacyWhere(engine: ProfileEngine, account: Account) {
  return {
    engineAccountId: null, engineType: null, name: profileName(engine, account),
    host: account.host, port: account.port, protocol: engine === 'ssh' ? 'ssh' : account.protocol!,
    ...(engine === 'ssh' ? { username: account.username } : { uuid: account.uuid }),
  };
}

async function engineProfiles(db: Db, engine: ProfileEngine, account: Account) {
  return db.vpnProfile.findMany({
    where: { OR: [{ engineType: engine, engineAccountId: account.id }, legacyWhere(engine, account)] },
    orderBy: { id: 'asc' },
  });
}

// All engine writes lock the source row first, then profile rows. Adding or
// rotating a profile lock uses the same ordering so a stale proof cannot win.
async function lockAccount(db: Db, engine: ProfileEngine, id: string) {
  await db.$queryRawUnsafe(`SELECT "id" FROM "${tables[engine]}" WHERE "id" = $1 FOR UPDATE`, id);
}

export async function prepareProfileEngineLock(db: Db, profile: VpnProfile): Promise<VpnProfile> {
  if (profile.engineAccountId && profile.engineType) {
    if (!(profile.engineType in tables)) throw new ProfileLockError(409, 'PROFILE_ENGINE_LINK_INVALID');
    await lockAccount(db, profile.engineType as ProfileEngine, profile.engineAccountId);
    return profile;
  }
  const candidates: { engine: ProfileEngine; account: Account }[] = [];
  for (const engine of ['ssh', 'xray', 'singbox'] as const) {
    const accounts = await findAccounts(db, engine, profile.host, profile.port);
    for (const account of accounts) {
      const a: Account = account;
      if (profile.name === profileName(engine, a) &&
          profile.protocol === (engine === 'ssh' ? 'ssh' : a.protocol) &&
          (engine === 'ssh' ? !!a.username && profile.username === a.username : !!a.uuid && profile.uuid === a.uuid)) {
        candidates.push({ engine, account: a });
      }
    }
  }
  if (candidates.length > 1) throw new ProfileLockError(409, 'PROFILE_ENGINE_LINK_AMBIGUOUS');
  if (!candidates.length) return profile;
  const { engine, account } = candidates[0];
  await lockAccount(db, engine, account.id);
  const related = await engineProfiles(db, engine, account);
  if (related.length !== 1 || related[0].id !== profile.id) {
    throw new ProfileLockError(409, 'PROFILE_ENGINE_LINK_AMBIGUOUS');
  }
  return db.vpnProfile.update({
    where: { id: profile.id }, data: { engineType: engine, engineAccountId: account.id },
  });
}

export async function createLockedEngineAccount<T extends Account>(
  engine: ProfileEngine, password: unknown, create: (db: Db) => Promise<T>,
) {
  const lock = await createProfileLock(password);
  return prisma.$transaction(async db => {
    const account = await create(db);
    await db.vpnProfile.create({ data: {
      name: profileName(engine, account), protocol: engine === 'ssh' ? 'ssh' : account.protocol!,
      host: account.host, port: account.port, username: account.username || null,
      password: account.password ? (engine === 'ssh' ? account.password : encryptCanonical(account.password)) : null,
      uuid: account.uuid || null, path: account.path || null, network: account.network || 'tcp',
      tls: account.tls || false, sni: account.sni || null, method: account.method || null,
      payloadId: account.payloadId || null, dns: account.dns || null,
      offlineValidDays: 7, status: 'active', engineType: engine, engineAccountId: account.id, ...lock,
    } });
    return account;
  });
}

export async function withUnlockedEngine<T>(
  engine: ProfileEngine, id: string, req: AuthenticatedRequest,
  action: (db: Db, account: Account) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async db => {
    await lockAccount(db, engine, id);
    const account = await findAccount(db, engine, id);
    if (!account) throw new ProfileLockError(404, 'PROFILE_ENGINE_NOT_FOUND');
    const profiles = await engineProfiles(db, engine, account);
    for (const profile of profiles) {
      if (!profile.engineAccountId) await prepareProfileEngineLock(db, profile);
      await db.$queryRawUnsafe('SELECT "id" FROM "vpn_profiles" WHERE "id" = $1 FOR UPDATE', profile.id);
      const current = await db.vpnProfile.findUnique({ where: { id: profile.id } });
      if (!current) throw new ProfileLockError(423, 'PROFILE_LOCKED');
      assertProfileUnlocked(current, req);
    }
    const result = await action(db, account);
    for (const profile of profiles) assertProfileUnlocked(profile, req);
    return result;
  }, { timeout: 25000 });
}

export async function serializeEngineAccount(
  engine: ProfileEngine, account: Account, req?: AuthenticatedRequest,
): Promise<Record<string, any>> {
  const profiles = await engineProfiles(prisma, engine, account);
  const hasLock = profiles.some(profile => !!profile.lockPasswordHash);
  const isLocked = profiles.some(profile => profile.lockPasswordHash && !profileUnlockExpiry(profile, req));
  const lock = { profileId: profiles[0]?.id ?? null, hasLock, isLocked };
  const out: Record<string, any> = {};
  const fields = isLocked
    ? ['id', 'name', 'status', 'expireAt', 'quotaTotal', 'quotaUsed', 'clientId', 'createdAt', 'updatedAt']
    : Object.keys(account).filter(key => key !== 'client');
  for (const key of fields) {
    if (account[key] !== undefined) out[key] = typeof account[key] === 'bigint' ? String(account[key]) : account[key];
  }
  if (account.client) out.client = {
    id: account.client.id, userId: account.client.userId,
    user: account.client.user ? { name: account.client.user.name, email: account.client.user.email } : null,
  };
  return { ...out, ...lock };
}

async function payloadProfiles(db: Db, id: string) {
  const accounts = await db.sshAccount.findMany({ where: { payloadId: id } });
  const linked = (await Promise.all(accounts.map(a => engineProfiles(db, 'ssh', a)))).flat();
  const direct = await db.vpnProfile.findMany({ where: { payloadId: id } });
  return [...new Map([...linked, ...direct].map(p => [p.id, p])).values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function serializePayload(payload: Record<string, any>, req?: AuthenticatedRequest) {
  const profiles = await payloadProfiles(prisma, payload.id);
  const hasLock = profiles.some(p => !!p.lockPasswordHash);
  const isLocked = profiles.some(p => p.lockPasswordHash && !profileUnlockExpiry(p, req));
  const fields = isLocked ? ['id', 'name', 'status', 'createdAt', 'updatedAt'] : Object.keys(payload).filter(k => k !== 'sshAccounts');
  const out: Record<string, any> = { profileId: profiles[0]?.id ?? null, hasLock, isLocked };
  for (const field of fields) if (payload[field] !== undefined) out[field] = payload[field];
  return out;
}

export async function withUnlockedPayload<T>(
  id: string, req: AuthenticatedRequest, action: (db: Db) => Promise<T>,
) {
  return prisma.$transaction(async db => {
    const profiles = await payloadProfiles(db, id);
    for (const profile of profiles) {
      await db.$queryRawUnsafe('SELECT "id" FROM "vpn_profiles" WHERE "id" = $1 FOR UPDATE', profile.id);
      const current = await db.vpnProfile.findUnique({ where: { id: profile.id } });
      if (!current) throw new ProfileLockError(423, 'PROFILE_LOCKED');
      assertProfileUnlocked(current, req);
    }
    const result = await action(db);
    for (const profile of profiles) assertProfileUnlocked(profile, req);
    return result;
  });
}

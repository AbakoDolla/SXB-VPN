import type { Prisma, PrismaClient } from '@prisma/client';
import { OWNER_ROLE } from '../middleware/rbac/owner';

type Identity = { userId?: string | null; role?: string | null } | null | undefined;
type PrivacyDatabase = Pick<PrismaClient, 'user' | 'vpnClient' | 'activationSession'>;

export async function ownerIds(db: Pick<PrismaClient, 'user'>): Promise<string[]> {
  const owners = await db.user.findMany({ where: { role: { name: OWNER_ROLE } }, select: { id: true } });
  return owners.map(owner => owner.id);
}

export function nonOwnerAccountScope(owners: string[]): Prisma.UserWhereInput {
  return {
    role: { name: { not: OWNER_ROLE } },
    vpnClients: { none: { OR: [
      { managedById: { in: owners } },
      { reseller: { createdBy: { in: owners } } },
      { reseller: { userId: { in: owners } } },
    ] } },
    OR: [{ resellerInfo: null }, { resellerInfo: { OR: [{ createdBy: null }, { createdBy: { notIn: owners } }] } }],
  };
}

export async function auditVisibility(db: Pick<PrismaClient, 'user'>, requester: Identity): Promise<Prisma.AuditLogWhereInput> {
  if (requester?.role === OWNER_ROLE) return {};
  const owners = await ownerIds(db);
  return {
    visibleOwnerOnly: false,
    user: nonOwnerAccountScope(owners),
    ...(requester?.role === 'SUPER_ADMIN' ? {} : { userId: requester?.userId ?? '__none__' }),
  };
}

// Security events deliberately have snapshot identifiers rather than foreign keys.
// Resolve every attribution path, including events without a userId and legacy rows.
export async function securityEventVisibility(db: PrivacyDatabase, requester: Identity): Promise<Prisma.SecurityEventWhereInput> {
  if (requester?.role === OWNER_ROLE) return {};
  if (!requester?.userId) return { id: { in: [] } };
  const owners = await ownerIds(db);
  const clients = await db.vpnClient.findMany({
    where: { OR: [
      { userId: { in: owners } },
      { managedById: { in: owners } },
      { reseller: { OR: [{ userId: { in: owners } }, { createdBy: { in: owners } }] } },
    ] },
    select: { id: true, userId: true, deviceId: true },
  });
  const [sessions, resellerUsers] = await Promise.all([
    db.activationSession.findMany({
      where: { clientId: { in: clients.map(client => client.id) } },
      select: { id: true, deviceId: true },
    }),
    db.user.findMany({ where: { resellerInfo: { createdBy: { in: owners } } }, select: { id: true } }),
  ]);
  const users = [...new Set([...owners, ...clients.map(client => client.userId), ...resellerUsers.map(user => user.id)])];
  const devices = [...new Set([...clients, ...sessions].map(row => row.deviceId).filter((id): id is string => !!id))];
  return {
    AND: [
      { OR: [{ userId: null }, { userId: { notIn: users } }] },
      { OR: [{ deviceId: null }, { deviceId: { notIn: devices } }] },
      { OR: [{ sessionId: null }, { sessionId: { notIn: sessions.map(session => session.id) } }] },
      { OR: [{ acknowledgedById: null }, { acknowledgedById: { notIn: owners } }] },
      // The role snapshot also protects owner actions on somebody else's session.
      { OR: [{ metadata: null }, { metadata: { not: { contains: OWNER_ROLE } } }] },
    ],
  };
}

import type { Request } from "express";
import type { Prisma } from "@prisma/client";
import { prisma, inMemoryDb } from "../database";
import { MobileAccessError, sessionInvalidFailure } from "./access-lifecycle";

const ownerSelect = {
  status: true, accessExpiresAt: true, user: { select: { id: true, status: true } },
} satisfies Prisma.ResellerSelect;

export const mobileClientSelect = {
  id: true, userId: true, deviceId: true, activatedAt: true, expireAt: true, status: true, resellerId: true,
  user: { select: { id: true, email: true, status: true, resellerInfo: { select: ownerSelect } } },
  reseller: { select: ownerSelect },
} satisfies Prisma.VpnClientSelect;

export interface MobileClaims {
  userId: string;
  role: string;
  clientId?: string;
  deviceId?: string;
}

export function deviceIdFromRequest(req: Request): string | null {
  const value = req.headers["x-sxb-device-id"];
  return typeof value === "string" && value.trim() && value.length <= 255 ? value.trim() : null;
}

export function invalidMobileSession(): never {
  throw new MobileAccessError(401, sessionInvalidFailure());
}

export async function loadMobileClient(claims: MobileClaims, deviceId: string | null, requireBinding = false) {
  if (typeof claims.userId !== "string" || !claims.userId || claims.role !== "CLIENT" ||
      (claims.clientId !== undefined && (typeof claims.clientId !== "string" || !claims.clientId)) ||
      (claims.deviceId !== undefined && (typeof claims.deviceId !== "string" || !claims.deviceId)) ||
      (requireBinding && (!claims.clientId || !deviceId))) invalidMobileSession();
  if (claims.deviceId && deviceId && claims.deviceId !== deviceId) invalidMobileSession();
  const clients = prisma
    ? await prisma.vpnClient.findMany({
        where: { userId: claims.userId, ...(claims.clientId ? { id: claims.clientId } : {}) },
        select: mobileClientSelect, take: 2,
      })
    : inMemoryDb.vpnClients.filter(client =>
        client.userId === claims.userId && (!claims.clientId || client.id === claims.clientId)
      ).map(client => {
        const user = inMemoryDb.users.find(value => value.id === client.userId);
        const reseller = inMemoryDb.resellers.find(value => client.resellerId
          ? value.id === client.resellerId : value.userId === client.userId);
        const owner = reseller ? { ...reseller, user: inMemoryDb.users.find(value => value.id === reseller.userId) ?? null } : null;
        return { ...client, user: user ? { ...user, resellerInfo: owner } : null, reseller: owner };
      });
  // An old user-only JWT is usable only for a single unambiguous client.
  if (clients.length > 1) invalidMobileSession();
  const client = clients[0] ?? null;
  if (!client) return null;
  if ((deviceId && client.deviceId !== deviceId) ||
      (claims.deviceId && client.deviceId !== claims.deviceId) ||
      (requireBinding && !client.activatedAt)) invalidMobileSession();
  return client;
}

export function mobileClientOwner(client: Awaited<ReturnType<typeof loadMobileClient>>) {
  return client?.reseller ?? client?.user?.resellerInfo ?? null;
}

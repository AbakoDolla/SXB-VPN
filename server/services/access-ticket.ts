import { createHmac } from "node:crypto";
import jwt from "jsonwebtoken";

export const ACCESS_TICKET_MAX_SECONDS = 7 * 24 * 60 * 60;
export const ACCESS_TICKET_ISSUER = "sxb-vpn:access-control";
export const ACCESS_TICKET_AUDIENCE = "sxb-vpn:mobile-access-state";
const ACCESS_TICKET_KEY_LABEL = "SXB-VPN/mobile-access-state-ticket/v1";

export interface MobileIdentity {
  userId: string;
  clientId: string;
  deviceId: string;
}

export function accessTicketKey(secret: string): Buffer {
  return createHmac("sha256", secret).update(ACCESS_TICKET_KEY_LABEL).digest();
}

export function issueAccessTicket(identity: MobileIdentity, secret: string) {
  const now = Math.floor(Date.now() / 1000);
  const expires = now + ACCESS_TICKET_MAX_SECONDS;
  const ticket = jwt.sign({
    ...identity, type: "access-state-ticket", scope: "mobile:access-state", iat: now, exp: expires,
  }, accessTicketKey(secret), {
    algorithm: "HS256", issuer: ACCESS_TICKET_ISSUER, audience: ACCESS_TICKET_AUDIENCE,
    subject: identity.clientId,
  });
  return { ticket, expiresAt: new Date(expires * 1000).toISOString() };
}

export function verifyAccessTicket(token: string, secret: string, deviceId: string): MobileIdentity & { exp: number } {
  const payload = jwt.verify(token, accessTicketKey(secret), {
    algorithms: ["HS256"], issuer: ACCESS_TICKET_ISSUER, audience: ACCESS_TICKET_AUDIENCE,
  });
  if (typeof payload === "string" ||
      payload.type !== "access-state-ticket" || payload.scope !== "mobile:access-state" ||
      typeof payload.userId !== "string" || !payload.userId ||
      typeof payload.clientId !== "string" || !payload.clientId || payload.sub !== payload.clientId ||
      typeof payload.deviceId !== "string" || !payload.deviceId || payload.deviceId !== deviceId ||
      typeof payload.iat !== "number" || typeof payload.exp !== "number" ||
      !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) ||
      payload.iat > Math.floor(Date.now() / 1000) || payload.exp <= payload.iat ||
      payload.exp - payload.iat > ACCESS_TICKET_MAX_SECONDS) {
    throw new jwt.JsonWebTokenError("Invalid access-state ticket claims");
  }
  return { userId: payload.userId, clientId: payload.clientId, deviceId: payload.deviceId, exp: payload.exp };
}

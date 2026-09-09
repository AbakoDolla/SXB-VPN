import type { Request } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { deviceIdFromRequest, invalidMobileSession, loadMobileClient, mobileClientOwner, type MobileClaims } from "./mobile-principal";
import { deviceAccessFailure, deviceAccessStatus, MobileAccessError } from "./access-lifecycle";

export async function refreshMobileSession(req: Request, decoded: MobileClaims & { exp?: number }) {
  if (typeof decoded.exp !== "number" || decoded.exp <= Math.floor(Date.now() / 1000)) invalidMobileSession();
  const deviceId = deviceIdFromRequest(req);
  const client = await loadMobileClient(decoded, deviceId, true);
  const status = deviceAccessStatus(client, mobileClientOwner(client));
  if (!client?.user || status === "revoked" || status === "deleted") {
    throw new MobileAccessError(403, deviceAccessFailure(status === "revoked" ? status : "deleted"));
  }
  const payload = {
    userId: client.userId, email: client.user.email, clientId: client.id, deviceId,
    role: "CLIENT", permissions: [],
  };
  // A valid refresh may preserve observation while blocked, not extend its own lifetime.
  // Every business request still reloads device/user/owner state in requireAuth.
  const remaining = decoded.exp - Math.floor(Date.now() / 1000);
  if (remaining <= 0) invalidMobileSession();
  return {
    accessToken: jwt.sign(payload, config.JWT_SECRET, { algorithm: "HS256", expiresIn: Math.min(15 * 60, remaining) }),
    refreshToken: jwt.sign({ ...payload, exp: decoded.exp }, config.REFRESH_SECRET, { algorithm: "HS256" }),
  };
}

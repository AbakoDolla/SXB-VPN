import type { Request } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { generateTokens } from "../middleware/auth";
import { deviceIdFromRequest, invalidMobileSession, loadMobileClient, mobileClientOwner, type MobileClaims } from "./mobile-principal";
import { deviceAccessFailure, deviceAccessStatus, MobileAccessError } from "./access-lifecycle";
import { rotateBoundSession, recordMobileSecurityRefusal } from "./mobile-session-security";

export async function refreshMobileSession(req: Request, decoded: MobileClaims & { exp?: number }) {
  if (typeof decoded.exp !== "number" || decoded.exp <= Math.floor(Date.now() / 1000)) invalidMobileSession();
  const deviceId = deviceIdFromRequest(req);
  if (!deviceId) invalidMobileSession();
  const client = await loadMobileClient(decoded, deviceId, true);
  const status = deviceAccessStatus(client, mobileClientOwner(client));
  if (!client?.user || status === "revoked" || status === "deleted") {
    throw new MobileAccessError(403, deviceAccessFailure(status === "revoked" ? status : "deleted"));
  }
  const boundTokens = await rotateBoundSession(req, { ...decoded, clientId: client.id }).catch(async error => {
    await recordMobileSecurityRefusal(error, decoded);
    throw error;
  });
  if (boundTokens) return boundTokens;
  const payload = {
    userId: client.userId, email: client.user.email, clientId: client.id, deviceId,
    role: "CLIENT", permissions: [],
  };
  const remaining = decoded.exp - Math.floor(Date.now() / 1000);
  if (remaining <= 0) invalidMobileSession();
  if (status === "active") return generateTokens(payload);
  // A valid refresh may preserve observation while blocked, not extend its own lifetime.
  // Every business request still reloads device/user/owner state in requireAuth.
  return {
    accessToken: jwt.sign(payload, config.JWT_SECRET, { algorithm: "HS256", expiresIn: Math.min(15 * 60, remaining) }),
    refreshToken: jwt.sign({ ...payload, exp: decoded.exp }, config.REFRESH_SECRET, { algorithm: "HS256" }),
  };
}

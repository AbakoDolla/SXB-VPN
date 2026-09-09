import { Router, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "../config";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { issueAccessTicket, verifyAccessTicket } from "../services/access-ticket";
import { deviceIdFromRequest, invalidMobileSession } from "../services/mobile-principal";
import { deviceAccessFailure, MobileAccessError } from "../services/access-lifecycle";
import {
  readMobileAccessSnapshot, waitForMobileAccess, AccessWaitLimitError, AccessWaitTimeoutError,
  type AccessCredential,
} from "../services/mobile-access-state";

const router = Router();
const querySchema = z.object({
  revision: z.string().max(128).optional(),
  wait: z.coerce.number().int().min(0).max(25).default(0),
});

function credential(req: Request): AccessCredential {
  const deviceId = deviceIdFromRequest(req);
  const header = req.headers.authorization;
  if (!deviceId || !header?.startsWith("Bearer ") || header.length > 8192) invalidMobileSession();
  const token = header.slice(7);
  let access: jwt.JwtPayload | string;
  try {
    access = jwt.verify(token, config.JWT_SECRET, { algorithms: ["HS256"] });
  } catch (error) {
    if (!(error instanceof jwt.JsonWebTokenError)) throw error;
    if (req.method !== "GET") invalidMobileSession();
    try {
      return { ...verifyAccessTicket(token, config.JWT_SECRET, deviceId), boundInToken: true, kind: "ticket" };
    } catch (ticketError) {
      if (!(ticketError instanceof jwt.JsonWebTokenError)) throw ticketError;
      invalidMobileSession();
    }
  }
  if (typeof access === "string" || access.role !== "CLIENT" ||
      typeof access.userId !== "string" || !access.userId ||
      typeof access.clientId !== "string" || !access.clientId ||
      typeof access.exp !== "number" || !Number.isInteger(access.exp) ||
      (access.deviceId !== undefined && access.deviceId !== deviceId)) invalidMobileSession();
  return {
    userId: access.userId, clientId: access.clientId, deviceId, exp: access.exp,
    boundInToken: access.deviceId === deviceId, kind: "access",
  };
}

function failure(res: Response, error: unknown) {
  if (error instanceof MobileAccessError) return res.status(error.status).json(error.body);
  if (error instanceof z.ZodError) return res.status(400).json({ error: "errors.validation", details: error.issues });
  if (error instanceof AccessWaitLimitError) {
    res.set("Retry-After", "2");
    return res.status(429).json({ error: "errors.rate_limit", code: "ACCESS_STATE_BUSY", retryAfterSeconds: 2 });
  }
  if (!(error instanceof AccessWaitTimeoutError)) console.error("Mobile access-state unavailable:", error);
  return res.status(503).json({ error: "errors.auth.unavailable", message: "Lecture des droits temporairement indisponible." });
}

router.get("/access-state", async (req: Request, res: Response) => {
  res.set({ "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  const abort = new AbortController();
  const close = () => abort.abort();
  res.once("close", close);
  try {
    const identity = credential(req);
    const query = querySchema.parse(req.query);
    const snapshot = query.revision && query.wait > 0
      ? await waitForMobileAccess(identity, query.revision, query.wait, abort.signal)
      : await readMobileAccessSnapshot(identity);
    if (snapshot && !abort.signal.aborted) return res.json(snapshot);
  } catch (error) {
    if (!abort.signal.aborted) return failure(res, error);
  } finally {
    res.removeListener("close", close);
  }
});

router.post("/access-ticket", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  res.set("Cache-Control", "no-store");
  try {
    const identity = credential(req);
    if (identity.kind !== "access") invalidMobileSession();
    const snapshot = await readMobileAccessSnapshot(identity);
    if (snapshot.device.status !== "active") return res.status(403).json(deviceAccessFailure(snapshot.device.status));
    if (snapshot.device.activationRequired) invalidMobileSession();
    return res.json(issueAccessTicket({
      userId: identity.userId, clientId: identity.clientId, deviceId: identity.deviceId,
    }, config.JWT_SECRET));
  } catch (error) {
    return failure(res, error);
  }
});

export default router;

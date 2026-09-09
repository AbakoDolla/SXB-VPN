import { createHash } from "node:crypto";
import type { Request } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import jwt from "jsonwebtoken";
import { verifyAccessTicket } from "../services/access-ticket";

export const API_RATE_LIMITS = {
  windowMs: 15 * 60 * 1000,
  anonymous: 200,
  authentication: 200,
  refresh: 200,
  authenticated: 600,
} as const;

const AUTHENTICATION_PATHS = new Set([
  "/auth/login",
  "/auth/register",
  "/auth/token-login",
  "/admin-tokens/activate",
  "/mobile/auth/activate",
]);

function normalizedPath(req: Request): string {
  return req.path.toLowerCase().replace(/\/+$/, "") || "/";
}

function verifiedPrincipal(token: unknown, secret: string): string | null {
  if (typeof token !== "string" || !token) return null;
  try {
    const payload = jwt.verify(token, secret, { algorithms: ["HS256"] });
    if (typeof payload === "string" || typeof payload.userId !== "string" || !payload.userId) return null;
    // Seule une identité signée partitionne les compteurs : changer de JWT,
    // d'en-tête appareil ou d'adresse IP ne remet pas le compteur à zéro.
    return createHash("sha256")
      .update(JSON.stringify([payload.userId, typeof payload.clientId === "string" ? payload.clientId : null]))
      .digest("hex");
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) return null;
    throw error;
  }
}

export function createApiRateLimiter(secrets: { access: string; refresh: string }) {
  const quotas = new WeakMap<Request, { key: string; limit: number }>();
  const quotaFor = (req: Request) => {
    const cached = quotas.get(req);
    if (cached) return cached;
    const ip = ipKeyGenerator(req.ip?.replace(/\\/g, "") || "unknown");
    const pathname = normalizedPath(req);
    let quota: { key: string; limit: number };
    if (req.method === "POST" && AUTHENTICATION_PATHS.has(pathname)) {
      // Les appels du dashboard et du VPN ne consomment jamais les tentatives
      // de connexion. Un JWT joint au login ne contourne pas la limite par IP.
      quota = { key: `authentication:${ip}`, limit: API_RATE_LIMITS.authentication };
    } else if (req.method === "POST" && pathname === "/auth/refresh") {
      const principal = verifiedPrincipal(req.body?.refreshToken, secrets.refresh);
      quota = { key: `refresh:${principal ? `session:${principal}` : `ip:${ip}`}`, limit: API_RATE_LIMITS.refresh };
    } else {
      const authorization = req.headers.authorization;
      let principal = verifiedPrincipal(
        authorization?.startsWith("Bearer ") ? authorization.slice(7) : null,
        secrets.access
      );
      if (!principal && req.method === "GET" && pathname === "/mobile/access-state" &&
          authorization?.startsWith("Bearer ") && typeof req.headers["x-sxb-device-id"] === "string") {
        try {
          const identity = verifyAccessTicket(authorization.slice(7), secrets.access, req.headers["x-sxb-device-id"].trim());
          principal = createHash("sha256").update(JSON.stringify([identity.userId, identity.clientId])).digest("hex");
        } catch (error) {
          if (!(error instanceof jwt.JsonWebTokenError)) throw error;
        }
      }
      quota = principal
        ? { key: `session:${principal}`, limit: API_RATE_LIMITS.authenticated }
        : { key: `anonymous:${ip}`, limit: API_RATE_LIMITS.anonymous };
    }
    quotas.set(req, quota);
    return quota;
  };

  return rateLimit({
    windowMs: API_RATE_LIMITS.windowMs,
    limit: req => quotaFor(req).limit,
    keyGenerator: req => quotaFor(req).key,
    standardHeaders: true,
    legacyHeaders: false,
    skip: req => ["/health", "/metrics"].includes(normalizedPath(req)),
    handler: (_req, res) => {
      const retryAfterSeconds = Number(res.getHeader("Retry-After"));
      res.status(429).json({
        error: "errors.rate_limit",
        code: "RATE_LIMITED",
        message: "Trop de requêtes. Veuillez patienter avant de réessayer.",
        ...(Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0 ? { retryAfterSeconds } : {}),
      });
    },
  });
}

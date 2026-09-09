import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { prisma, inMemoryDb } from "../database";
import { refusPourEtatAcces, resumerAccesRevendeur } from "../services/reseller-state";
import { deviceIdFromRequest, loadMobileClient, mobileClientOwner } from "../services/mobile-principal";
import { deviceAccessStatus, deviceAccessFailure, sessionInvalidFailure, MobileAccessError } from "../services/access-lifecycle";

export interface TokenPayload {
  userId: string;
  email: string;
  role: string;
  permissions: string[];
  /** Session mobile liée à une ligne VpnClient précise. */
  clientId?: string;
  deviceId?: string;
  exp?: number;
}

export interface AuthenticatedRequest extends Request {
  user?: TokenPayload;
}

// Generates access and refresh tokens
export function generateTokens(payload: Omit<TokenPayload, "permissions"> & { permissions?: string[] }) {
  const accessToken = jwt.sign(payload, config.JWT_SECRET, { expiresIn: "15m" });
  const refreshToken = jwt.sign(payload, config.REFRESH_SECRET, { expiresIn: "7d" });
  return { accessToken, refreshToken };
}

// Verify authorization header JWT
export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ ...sessionInvalidFailure(), error: "errors.auth.unauthorized", message: "Authorization token required" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET, { algorithms: ["HS256"] }) as TokenPayload;
    if (!decoded || typeof decoded !== "object" || typeof decoded.userId !== "string" ||
        !decoded.userId || typeof decoded.role !== "string" ||
        (decoded.clientId !== undefined && typeof decoded.clientId !== "string") ||
        (decoded.deviceId !== undefined && typeof decoded.deviceId !== "string")) {
      return res.status(401).json(sessionInvalidFailure());
    }
    if (decoded.role === "CLIENT") {
      const client = await loadMobileClient(decoded, deviceIdFromRequest(req));
      const state = deviceAccessStatus(client, mobileClientOwner(client));
      if (state !== "active") return res.status(403).json(deviceAccessFailure(state));
      req.user = { ...decoded, role: "CLIENT", permissions: [] };
      return next();
    }
    
    // Fetch latest user status and permissions to avoid stale roles
    let isActive = false;
    let permissions: string[] = [];

    let dbRoleName: string | null = null;
    let resellerRecord: any = null;
    if (prisma) {
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        include: {
          role: {
            include: {
              permissions: {
                include: { permission: true }
              }
            }
          }
        }
      });
      if (user && user.status === "active") {
        dbRoleName = user.role.name;
        // Le rôle RESELLER ne vaut que s'il existe une fiche revendeur en face.
        // Les comptes d'appareil (device.*@sxbvpn.local) ont longtemps été créés
        // avec ce rôle : ils héritaient alors de clients.create, tokens.create et
        // subscription.manage, donc du pouvoir de se provisionner du quota sans
        // limite — et échappaient au contrôle de suspension réservé aux CLIENT.
        // Sans fiche revendeur, le compte est traité comme un simple client.
        if (dbRoleName === "RESELLER") {
          const fiche = await (prisma as any).reseller.findUnique({
            where: { userId: user.id },
            select: { id: true, status: true, accessExpiresAt: true, quotaBytes: true, quotaUsedBytes: true },
          });
          resellerRecord = fiche;
          if (!fiche) dbRoleName = "CLIENT";
        }
        isActive = true;
        if (dbRoleName === "CLIENT") {
          // Une session mobile n'hérite jamais des permissions du compte
          // porteur historique, même si celui-ci est encore marqué RESELLER.
          permissions = [];
        } else if (dbRoleName === "OWNER") {
          // Le rôle racine OWNER dispose de toutes les permissions (bypass centralisé).
          const allPerms = await prisma.permission.findMany();
          permissions = allPerms.map((p) => p.name);
        } else {
          permissions = user.role.permissions.map((rp) => rp.permission.name);
        }
      }
    } else {
      // In-Memory Database Fallback
      const user = inMemoryDb.users.find((u) => u.id === decoded.userId);
      if (user && user.status === "active") {
        const roleRecord = inMemoryDb.roles.find((r) => r.id === user.roleId);
        dbRoleName = roleRecord?.name ?? null;
        // Même règle qu'avec Prisma : pas de fiche revendeur, pas de rôle revendeur.
        if (dbRoleName === "RESELLER") {
          resellerRecord = inMemoryDb.resellers.find((r) => r.userId === user.id);
          if (!resellerRecord) dbRoleName = "CLIENT";
        }
        isActive = dbRoleName !== null;
        if (dbRoleName === "CLIENT") {
          permissions = [];
        } else {
          const rolePermIds = inMemoryDb.rolePermissions
            .filter((rp) => rp.roleId === user.roleId)
            .map((rp) => rp.permissionId);
          permissions = inMemoryDb.permissions
            .filter((p) => rolePermIds.includes(p.id))
            .map((p) => p.name);
        }
      }
    }

    if (!isActive) {
      return res.status(403).json({ error: "errors.auth.suspended", message: "User account is suspended" });
    }
    if (dbRoleName === "CLIENT") {
      const client = await loadMobileClient({ ...decoded, role: "CLIENT" }, deviceIdFromRequest(req));
      const state = deviceAccessStatus(client, mobileClientOwner(client));
      if (state !== "active") return res.status(403).json(deviceAccessFailure(state));
    }

    if (dbRoleName === "RESELLER" && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const accessError = refusPourEtatAcces(resumerAccesRevendeur(resellerRecord));
      if (accessError) return res.status(accessError.status).json(accessError.body);
    }

    req.user = {
      ...decoded,
      // Le rôle réel vient de la base (jamais du JWT seul) : suspension, changement
      // de rôle ou promotion OWNER sont pris en compte immédiatement.
      role: dbRoleName ?? decoded.role,
      permissions,
    };
    next();
  } catch (err) {
    if (err instanceof MobileAccessError) return res.status(err.status).json(err.body);
    if (err instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({ ...sessionInvalidFailure(), error: "errors.auth.invalid_token", message: "Invalid or expired session token" });
    }
    console.error("Session verification error:", err);
    return res.status(503).json({ error: "errors.auth.unavailable", message: "Vérification de la session temporairement indisponible" });
  }
}

// Middleware to enforce minimum role
export function requireRole(allowedRoles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "errors.auth.unauthorized", message: "Authorization required" });
    }
    // POINT UNIQUE DE BYPASS : le rôle racine OWNER accède à tout endpoint.
    if (req.user.role === "OWNER") {
      return next();
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "errors.auth.forbidden", message: "Insufficient privilege role level" });
    }
    next();
  };
}

// Middleware to enforce specific permissions (RBAC)
export function requirePermission(permissionName: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "errors.auth.unauthorized", message: "Authorization required" });
    }
    // POINT UNIQUE DE BYPASS : le rôle racine OWNER accède à tout endpoint.
    if (req.user.role === "OWNER") {
      return next();
    }
    const hasPermission = req.user.permissions.includes(permissionName);
    if (!hasPermission) {
      return res.status(403).json({ error: "errors.auth.forbidden_permission", message: `Missing required permission: ${permissionName}` });
    }
    next();
  };
}

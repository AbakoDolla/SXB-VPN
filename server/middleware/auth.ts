import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { prisma, inMemoryDb } from "../database";

const RESELLER_REQUIRED_PERMISSIONS = [
  "clients.view",
  "clients.view_own",
  "clients.create",
  "clients.edit",
  "tokens.view",
  "tokens.create",
  "subscription.view",
  "subscription.manage",
  "resellers.view",
];

const CORE_DATA_PERMISSIONS = [
  "tokens.view",
  "tokens.create",
  "subscription.view",
  "subscription.manage",
];

export interface TokenPayload {
  userId: string;
  email: string;
  role: string;
  permissions: string[];
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
    return res.status(401).json({ error: "errors.auth.unauthorized", message: "Authorization token required" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET) as TokenPayload;
    
    // Fetch latest user status and permissions to avoid stale roles
    let isActive = false;
    let permissions: string[] = [];

    let dbRoleName: string | null = null;
    let mobileClientUsable: boolean | null = null;
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
        // Un JWT valide ne suffit pas pour un compte mobile : le compte VPN
        // peut avoir été suspendu ou supprimé depuis le dashboard.
        if (dbRoleName === "CLIENT") {
          const client = await (prisma as any).vpnClient.findFirst({
            where: { userId: user.id },
            select: { status: true },
          });
          mobileClientUsable = client?.status === "active";
        }
        isActive = dbRoleName !== "CLIENT" || mobileClientUsable === true;
        if (dbRoleName === "OWNER") {
          // Le rôle racine OWNER dispose de toutes les permissions (bypass centralisé).
          const allPerms = await prisma.permission.findMany();
          permissions = allPerms.map((p) => p.name);
        } else {
          permissions = user.role.permissions.map((rp) => rp.permission.name);
          if (dbRoleName === "SUPER_ADMIN" || dbRoleName === "ADMIN") {
            permissions = Array.from(new Set([...permissions, ...CORE_DATA_PERMISSIONS]));
          }
          if (dbRoleName === "SUPPORT") {
            permissions = Array.from(new Set([...permissions, "tokens.view", "subscription.view"]));
          }
          if (dbRoleName === "RESELLER") {
            permissions = Array.from(new Set([...permissions, ...RESELLER_REQUIRED_PERMISSIONS]));
          }
        }
      }
    } else {
      // In-Memory Database Fallback
      const user = inMemoryDb.users.find((u) => u.id === decoded.userId);
      if (user && user.status === "active") {
        const roleRecord = inMemoryDb.roles.find((r) => r.id === user.roleId);
        dbRoleName = roleRecord?.name ?? null;
        if (dbRoleName === "CLIENT") {
          const client = inMemoryDb.vpnClients.find((c) => c.userId === user.id);
          mobileClientUsable = client?.status === "active";
        }
        isActive = dbRoleName !== "CLIENT" || mobileClientUsable === true;
        const rolePermIds = inMemoryDb.rolePermissions
          .filter((rp) => rp.roleId === user.roleId)
          .map((rp) => rp.permissionId);
        permissions = inMemoryDb.permissions
          .filter((p) => rolePermIds.includes(p.id))
          .map((p) => p.name);
        if (dbRoleName === "SUPER_ADMIN" || dbRoleName === "ADMIN") {
          permissions = Array.from(new Set([...permissions, ...CORE_DATA_PERMISSIONS]));
        }
        if (dbRoleName === "SUPPORT") {
          permissions = Array.from(new Set([...permissions, "tokens.view", "subscription.view"]));
        }
        if (dbRoleName === "RESELLER") {
          permissions = Array.from(new Set([...permissions, ...RESELLER_REQUIRED_PERMISSIONS]));
        }
      }
    }

    if (!isActive) {
      return res.status(403).json({ error: "errors.auth.suspended", message: "User account is suspended" });
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
    return res.status(401).json({ error: "errors.auth.invalid_token", message: "Invalid or expired session token" });
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

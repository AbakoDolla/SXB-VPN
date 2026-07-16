import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { prisma, inMemoryDb } from "../database";

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
        isActive = true;
        permissions = user.role.permissions.map((rp) => rp.permission.name);
      }
    } else {
      // In-Memory Database Fallback
      const user = inMemoryDb.users.find((u) => u.id === decoded.userId);
      if (user && user.status === "active") {
        isActive = true;
        const rolePermIds = inMemoryDb.rolePermissions
          .filter((rp) => rp.roleId === user.roleId)
          .map((rp) => rp.permissionId);
        permissions = inMemoryDb.permissions
          .filter((p) => rolePermIds.includes(p.id))
          .map((p) => p.name);
      }
    }

    if (!isActive) {
      return res.status(403).json({ error: "errors.auth.suspended", message: "User account is suspended" });
    }

    req.user = {
      ...decoded,
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
    const hasPermission = req.user.permissions.includes(permissionName) || req.user.role === "ADMIN" || req.user.role === "SUPER_ADMIN";
    if (!hasPermission) {
      return res.status(403).json({ error: "errors.auth.forbidden_permission", message: `Missing required permission: ${permissionName}` });
    }
    next();
  };
}

/**
 * RBAC Middleware - Role Based Access Control
 * Supports: SUPER_ADMIN, ADMIN, SUPPORT, RESELLER
 */
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../../config";
import { prisma } from "../../database";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: string;
  roleId: string;
  permissions: string[];
  status: string;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

// Role hierarchy: SUPER_ADMIN > ADMIN > SUPPORT > RESELLER
export type RoleType = "SUPER_ADMIN" | "ADMIN" | "SUPPORT" | "RESELLER";

export async function authenticateUser(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "UNAUTHORIZED", message: "Token requis" });
      return;
    }
    const token = authHeader.split(" ")[1];
    try {
      const decoded = jwt.verify(token, config.JWT_SECRET) as { userId: string; email: string; role: string; roleId: string };
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        include: { role: { include: { permissions: { include: { permission: true } } } } }
      });
      if (!user) { res.status(401).json({ error: "USER_NOT_FOUND", message: "Utilisateur non trouve" }); return; }
      if (user.status !== "active") { res.status(403).json({ error: "ACCOUNT_DISABLED", message: "Compte desactive" }); return; }
      
      // SUPER_ADMIN gets all permissions automatically
      let permissions = user.role.permissions.map((rp: any) => rp.permission.name);
      if (user.role.name === "SUPER_ADMIN") {
        const allPerms = await prisma.permission.findMany();
        permissions = allPerms.map(p => p.name);
      }
      
      req.user = { id: user.id, name: user.name, email: user.email, role: user.role.name, roleId: user.roleId, permissions, status: user.status };
      next();
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) { res.status(401).json({ error: "TOKEN_EXPIRED", message: "Token expire" }); return; }
      if (err instanceof jwt.JsonWebTokenError) { res.status(401).json({ error: "INVALID_TOKEN", message: "Token invalide" }); return; }
      throw err;
    }
  } catch (error) {
    console.error("Auth middleware error:", error);
    res.status(500).json({ error: "SERVER_ERROR", message: "Erreur serveur" });
  }
}

export function authorizeRole(...allowedRoles: RoleType[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) { res.status(401).json({ error: "UNAUTHORIZED", message: "Auth requise" }); return; }
    
    // SUPER_ADMIN can do everything
    if (req.user.role === "SUPER_ADMIN") {
      next();
      return;
    }
    
    if (!allowedRoles.includes(req.user.role as RoleType)) { 
      res.status(403).json({ error: "FORBIDDEN", message: "Role insuffisant" }); 
      return; 
    }
    next();
  };
}

export function authorizePermission(...requiredPermissions: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) { res.status(401).json({ error: "UNAUTHORIZED", message: "Auth requise" }); return; }
    
    // SUPER_ADMIN bypasses permission checks
    if (req.user.role === "SUPER_ADMIN") {
      next();
      return;
    }
    
    const hasAll = requiredPermissions.every(perm => req.user!.permissions.includes(perm));
    if (!hasAll) { res.status(403).json({ error: "FORBIDDEN", message: "Permissions insuffisantes" }); return; }
    next();
  };
}

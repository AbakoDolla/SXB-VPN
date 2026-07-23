import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export const JWT_SECRET =
  process.env.JWT_SECRET || "sxb-vpn-jwt-secure-access-token-key-for-saas-platform";
export const REFRESH_SECRET =
  process.env.REFRESH_SECRET || "sxb-vpn-jwt-secure-refresh-token-key-for-saas-platform";

export interface TokenPayload {
  userId: string;
  email: string;
  role: string;
  permissions: string[];
}

export interface AuthenticatedRequest extends Request {
  user?: TokenPayload;
}

export function generateTokens(
  payload: Omit<TokenPayload, "permissions"> & { permissions?: string[] }
) {
  const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: "15m" });
  const refreshToken = jwt.sign(payload, REFRESH_SECRET, { expiresIn: "7d" });
  return { accessToken, refreshToken };
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({
      error: "errors.auth.unauthorized",
      message: "Authorization token required",
    });
    return;
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as TokenPayload;
    req.user = { ...decoded, permissions: decoded.permissions || [] };
    next();
  } catch {
    res.status(401).json({
      error: "errors.auth.invalid_token",
      message: "Invalid or expired session token",
    });
  }
}

export function requireRole(allowedRoles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "errors.auth.unauthorized", message: "Auth required" });
      return;
    }
    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({ error: "errors.auth.forbidden", message: "Insufficient role" });
      return;
    }
    next();
  };
}

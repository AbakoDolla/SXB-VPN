import { Router, Response } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { prisma, inMemoryDb, logDbActivity } from "../database";
import { generateTokens, TokenPayload, AuthenticatedRequest } from "../middleware/auth";
import { config } from "../config";

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  phone: z.string().optional(),
  roleId: z.string().optional(), // Default to CLIENT/RESELLER role if none specified
});

// POST /api/auth/register
router.post("/register", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = registerSchema.parse(req.body);
    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(body.password, salt);

    let existingUser = false;
    if (prisma) {
      const u = await prisma.user.findUnique({ where: { email: body.email } });
      if (u) existingUser = true;
    } else {
      existingUser = inMemoryDb.users.some((u) => u.email === body.email);
    }

    if (existingUser) {
      return res.status(400).json({ error: "errors.auth.email_exists", message: "Email is already registered" });
    }

    // Role handling: default to RESELLER or a base role
    let finalRoleId = body.roleId;
    if (!finalRoleId) {
      if (prisma) {
        const role = await prisma.role.findFirst({ where: { name: "RESELLER" } });
        finalRoleId = role?.id || "role-reseller";
      } else {
        finalRoleId = "role-reseller";
      }
    }

    let newUser;
    if (prisma) {
      newUser = await prisma.user.create({
        data: {
          name: body.name,
          email: body.email,
          phone: body.phone,
          passwordHash,
          roleId: finalRoleId,
          status: "active",
        },
        include: { role: true },
      });
    } else {
      newUser = {
        id: `user-${Date.now()}`,
        name: body.name,
        email: body.email,
        phone: body.phone,
        passwordHash,
        roleId: finalRoleId,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      inMemoryDb.users.push(newUser);
    }

    const roleName = prisma ? (newUser as any).role?.name : "RESELLER";
    const tokens = generateTokens({
      userId: newUser.id,
      email: newUser.email,
      role: roleName || "RESELLER",
    });

    await logDbActivity(newUser.id, `User registration: ${newUser.email}`, "success", req.ip);

    return res.status(201).json({
      message: "Registration successful",
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        role: roleName || "RESELLER",
      },
      ...tokens,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    console.error("Register error:", err);
    return res.status(500).json({ error: "errors.server", message: "Internal register server error" });
  }
});

// POST /api/auth/login
router.post("/login", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = loginSchema.parse(req.body);
    let userRecord: any = null;

    if (prisma) {
      userRecord = await prisma.user.findUnique({
        where: { email: body.email },
        include: { role: true },
      });
    } else {
      const u = inMemoryDb.users.find((u) => u.email === body.email);
      if (u) {
        const r = inMemoryDb.roles.find((role) => role.id === u.roleId);
        userRecord = { ...u, role: r };
      }
    }

    if (!userRecord) {
      return res.status(401).json({ error: "errors.auth.invalid_credentials", message: "Invalid email or password" });
    }

    const isMatch = bcrypt.compareSync(body.password, userRecord.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: "errors.auth.invalid_password", message: "Invalid email or password" });
    }

    if (userRecord.status !== "active") {
      return res.status(403).json({ error: "errors.auth.suspended", message: "User account has been suspended" });
    }

    // Load active permissions
    let permissions: string[] = [];
    if (prisma) {
      const rp = await prisma.rolePermission.findMany({
        where: { roleId: userRecord.roleId },
        include: { permission: true },
      });
      permissions = rp.map((item) => item.permission.name);
    } else {
      const rp = inMemoryDb.rolePermissions.filter((item) => item.roleId === userRecord.roleId);
      permissions = inMemoryDb.permissions
        .filter((p) => rp.some((item) => item.permissionId === p.id))
        .map((p) => p.name);
    }

    const tokens = generateTokens({
      userId: userRecord.id,
      email: userRecord.email,
      role: userRecord.role?.name || "SUPPORT",
    });

    await logDbActivity(userRecord.id, `User login: ${userRecord.email}`, "success", req.ip);

    return res.json({
      message: "Login successful",
      user: {
        id: userRecord.id,
        name: userRecord.name,
        email: userRecord.email,
        role: userRecord.role?.name || "SUPPORT",
        permissions,
      },
      ...tokens,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    console.error("Login error:", err);
    return res.status(500).json({ error: "errors.server", message: "Internal login server error" });
  }
});

// POST /api/auth/refresh
router.post("/refresh", async (req: AuthenticatedRequest, res: Response) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(401).json({ error: "errors.auth.refresh_required", message: "Refresh token is required" });
  }

  try {
    const decoded = jwt.verify(refreshToken, config.REFRESH_SECRET) as TokenPayload;
    
    let userRecord: any = null;
    if (prisma) {
      userRecord = await prisma.user.findUnique({
        where: { id: decoded.userId },
        include: { role: true },
      });
    } else {
      const u = inMemoryDb.users.find((u) => u.id === decoded.userId);
      if (u) {
        const r = inMemoryDb.roles.find((role) => role.id === u.roleId);
        userRecord = { ...u, role: r };
      }
    }

    if (!userRecord || userRecord.status !== "active") {
      return res.status(403).json({ error: "errors.auth.suspended", message: "User is suspended or deleted" });
    }

    const tokens = generateTokens({
      userId: userRecord.id,
      email: userRecord.email,
      role: userRecord.role?.name || "SUPPORT",
    });

    return res.json({
      message: "Token refreshed successfully",
      ...tokens,
    });
  } catch (err) {
    return res.status(401).json({ error: "errors.auth.invalid_refresh", message: "Invalid or expired refresh token" });
  }
});

// POST /api/auth/logout
router.post("/logout", async (req: AuthenticatedRequest, res: Response) => {
  // In stateless JWT, logout can be handled by client-side clearing,
  // but we log the activity securely on the server side
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    try {
      const token = authHeader.split(" ")[1];
      const decoded = jwt.decode(token) as TokenPayload;
      if (decoded) {
        await logDbActivity(decoded.userId, `User logout: ${decoded.email}`, "info", req.ip);
      }
    } catch {}
  }
  return res.json({ message: "Logout successful" });
});


// POST /api/auth/token-login — Connexion via token admin SXB-ADMIN-XXXX-XXXX
router.post("/token-login", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: "MISSING_TOKEN", message: "Token requis" });
    }
    if (!prisma) {
      return res.status(503).json({ error: "DB_UNAVAILABLE", message: "Base de données indisponible" });
    }
    const adminToken = await (prisma as any).adminToken.findUnique({
      where: { token },
      include: { user: { include: { role: true } } },
    });
    if (!adminToken) {
      return res.status(401).json({ error: "INVALID_TOKEN", message: "Token invalide" });
    }
    if (adminToken.status !== "active") {
      return res.status(401).json({ error: "TOKEN_USED", message: "Token déjà utilisé ou révoqué" });
    }
    if (new Date() > adminToken.expiresAt) {
      await (prisma as any).adminToken.update({ where: { id: adminToken.id }, data: { status: "revoked" } });
      return res.status(401).json({ error: "TOKEN_EXPIRED", message: "Token expiré" });
    }
    await (prisma as any).adminToken.update({
      where: { id: adminToken.id },
      data: { status: "used", usedAt: new Date() },
    });
    const tokens = generateTokens({
      userId: adminToken.user.id,
      email: adminToken.user.email,
      role: adminToken.user.role.name,
    });
    await logDbActivity(adminToken.user.id, `First login via admin token: ${token}`, "success", req.ip);
    return res.json({
      success: true,
      ...tokens,
      user: { id: adminToken.user.id, name: adminToken.user.name, email: adminToken.user.email, role: adminToken.user.role.name },
      firstLogin: true,
      message: "Connexion réussie. Définissez un mot de passe permanent.",
    });
  } catch (err) {
    console.error("Token login error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Erreur de connexion par token" });
  }
});

export default router;

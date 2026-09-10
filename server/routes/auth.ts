import { Router, Response } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { prisma, inMemoryDb, logDbActivity } from "../database";
import { generateTokens, requireAuth, TokenPayload, AuthenticatedRequest } from "../middleware/auth";
import { config } from "../config";
import { refreshMobileSession } from "../services/mobile-session-refresh";
import { MobileAccessError, sessionInvalidFailure } from "../services/access-lifecycle";
import { sessionUser } from "../services/session-user";

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

    // L'inscription publique ne peut attribuer aucun rôle de gestion.
    const clientRole = prisma
      ? await prisma.role.findUnique({ where: { name: "CLIENT" } })
      : inMemoryDb.roles.find((role) => role.name === "CLIENT");
    if (!clientRole) {
      return res.status(503).json({ error: "errors.auth.registration_unavailable", message: "Inscription indisponible" });
    }
    if (body.roleId && body.roleId !== clientRole.id) {
      return res.status(403).json({ error: "errors.auth.forbidden", message: "Les comptes de gestion sont créés par un administrateur" });
    }
    const finalRoleId = clientRole.id;

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

    const roleName = "CLIENT";
    const tokens = generateTokens({
      userId: newUser.id,
      email: newUser.email,
      role: roleName,
    });

    await logDbActivity(newUser.id, `User registration: ${newUser.email}`, "success", req.ip);

    return res.status(201).json({
      message: "Registration successful",
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        role: roleName,
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

    let effectiveRole = userRecord.role?.name || "SUPPORT";
    if (effectiveRole === "RESELLER") {
      const hasResellerRecord = prisma
        ? !!(await (prisma as any).reseller.findUnique({ where: { userId: userRecord.id }, select: { id: true } }))
        : inMemoryDb.resellers.some((reseller) => reseller.userId === userRecord.id);
      if (!hasResellerRecord) effectiveRole = "CLIENT";
    }

    // Load active permissions
    let permissions: string[] = [];
    const isOwnerLogin = effectiveRole === "OWNER";
    if (prisma) {
      if (isOwnerLogin) {
        // Le rôle racine OWNER dispose de toutes les permissions (bypass centralisé).
        const allPerms = await prisma.permission.findMany();
        permissions = allPerms.map((p) => p.name);
      } else {
        const rp = await prisma.rolePermission.findMany({
          where: { roleId: userRecord.roleId },
          include: { permission: true },
        });
        permissions = rp.map((item) => item.permission.name);
      }
    } else {
      const rp = inMemoryDb.rolePermissions.filter((item) => item.roleId === userRecord.roleId);
      permissions = inMemoryDb.permissions
        .filter((p) => rp.some((item) => item.permissionId === p.id))
        .map((p) => p.name);
    }
    if (effectiveRole === "CLIENT") permissions = [];

    const tokens = generateTokens({
      userId: userRecord.id,
      email: userRecord.email,
      role: effectiveRole,
    });

    // Traçabilité de sécurité : les authentifications OWNER réussies écrivent
    // un AuditLog normal EN PLUS du flag visibleOwnerOnly=true (invisible
    // des journaux consultés par les non-OWNER).
    await logDbActivity(
      userRecord.id,
      `User login: ${userRecord.email}`,
      "success",
      req.ip,
      { visibleOwnerOnly: isOwnerLogin }
    );

    return res.json({
      message: "Login successful",
      user: {
        id: userRecord.id,
        name: userRecord.name,
        email: userRecord.email,
        role: effectiveRole,
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
    return res.status(401).json({ ...sessionInvalidFailure(), error: "errors.auth.refresh_required", message: "Refresh token is required" });
  }

  try {
    const decoded = jwt.verify(refreshToken, config.REFRESH_SECRET, { algorithms: ["HS256"] }) as TokenPayload;
    if (!decoded || typeof decoded !== "object" || typeof decoded.userId !== "string" || !decoded.userId) {
      return res.status(401).json(sessionInvalidFailure());
    }
    if (decoded.role === "CLIENT") {
      return res.json({ message: "Token refreshed successfully", ...await refreshMobileSession(req, decoded) });
    }
    
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

    let effectiveRole = decoded.role === "CLIENT"
      ? "CLIENT"
      : userRecord.role?.name || "SUPPORT";
    if (effectiveRole === "RESELLER") {
      const hasResellerRecord = prisma
        ? !!(await (prisma as any).reseller.findUnique({ where: { userId: userRecord.id }, select: { id: true } }))
        : inMemoryDb.resellers.some((reseller) => reseller.userId === userRecord.id);
      if (!hasResellerRecord) effectiveRole = "CLIENT";
    }

    const tokens = generateTokens({
      userId: userRecord.id,
      email: userRecord.email,
      role: effectiveRole,
      ...(decoded.clientId ? { clientId: decoded.clientId } : {}),
    });

    return res.json({
      message: "Token refreshed successfully",
      ...tokens,
    });
  } catch (err) {
    if (err instanceof MobileAccessError) return res.status(err.status).json(err.body);
    if (err instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({ ...sessionInvalidFailure(), error: "errors.auth.invalid_refresh", message: "Invalid or expired refresh token" });
    }
    console.error("Refresh session error:", err);
    return res.status(503).json({ error: "errors.auth.unavailable", message: "Renouvellement de session temporairement indisponible" });
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

// GET /api/auth/me — Retourne l'utilisateur authentifié courant
router.get('/me', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'errors.auth.unauthorized', message: 'Non authentifié' });
    }
    if (prisma) {
      const user = await prisma.user.findUnique({
        where: { id: req.user.userId },
        include: { role: { include: { permissions: { include: { permission: true } } } } },
      });
      if (!user) return res.status(404).json({ error: 'errors.auth.user_not_found', message: 'Utilisateur introuvable' });
      return res.json(sessionUser(user, req));
    }
    // Fallback in-memory
    const memUser = inMemoryDb.users.find((u) => u.id === req.user!.userId);
    if (!memUser) return res.status(404).json({ error: 'errors.auth.user_not_found', message: 'Utilisateur introuvable' });
    return res.json(sessionUser({ ...memUser, name: (memUser as any).name || req.user.email }, req));
  } catch (err) {
    console.error('auth/me error:', err);
    return res.status(500).json({ error: 'errors.server', message: 'Erreur interne' });
  }
});

export default router;

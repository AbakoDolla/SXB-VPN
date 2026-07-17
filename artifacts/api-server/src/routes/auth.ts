import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import jwt from "jsonwebtoken";
import {
  generateTokens,
  JWT_SECRET,
  REFRESH_SECRET,
  type AuthenticatedRequest,
} from "../middleware/auth.js";

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  phone: z.string().optional(),
});

const refreshSchema = z.object({ refreshToken: z.string() });

// In-memory users for local dev (no DB in Replit API server)
interface DevUser {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  role: string;
  status: string;
}
const devUsers: DevUser[] = [
  {
    id: "dev-admin-001",
    name: "Admin SXB",
    email: "admin@sxbvpn.com",
    passwordHash: bcrypt.hashSync("admin123", 10),
    role: "SUPER_ADMIN",
    status: "active",
  },
];

// POST /api/auth/login
router.post("/login", async (req: AuthenticatedRequest, res) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const user = devUsers.find((u) => u.email === email);
    if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
      return res.status(401).json({
        error: "errors.auth.invalid_credentials",
        message: "Email ou mot de passe invalide",
      });
    }
    if (user.status !== "active") {
      return res
        .status(403)
        .json({ error: "errors.auth.suspended", message: "Compte suspendu" });
    }
    const tokens = generateTokens({ userId: user.id, email: user.email, role: user.role });
    return res.json({
      ...tokens,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    if (err instanceof z.ZodError)
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    return res
      .status(500)
      .json({ error: "errors.server", message: "Internal server error" });
  }
});

// POST /api/auth/register
router.post("/register", async (req: AuthenticatedRequest, res) => {
  try {
    const body = registerSchema.parse(req.body);
    if (devUsers.some((u) => u.email === body.email)) {
      return res
        .status(400)
        .json({ error: "errors.auth.email_exists", message: "Email déjà enregistré" });
    }
    const newUser: DevUser = {
      id: `user-${Date.now()}`,
      name: body.name,
      email: body.email,
      passwordHash: bcrypt.hashSync(body.password, 10),
      role: "RESELLER",
      status: "active",
    };
    devUsers.push(newUser);
    const tokens = generateTokens({
      userId: newUser.id,
      email: newUser.email,
      role: newUser.role,
    });
    return res.status(201).json({
      ...tokens,
      user: { id: newUser.id, name: newUser.name, email: newUser.email, role: newUser.role },
    });
  } catch (err) {
    if (err instanceof z.ZodError)
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    return res.status(500).json({ error: "errors.server", message: "Server error" });
  }
});

// POST /api/auth/refresh
router.post("/refresh", async (req: AuthenticatedRequest, res) => {
  try {
    const { refreshToken } = refreshSchema.parse(req.body);
    const decoded = jwt.verify(refreshToken, REFRESH_SECRET) as {
      userId: string;
      email: string;
      role: string;
    };
    const tokens = generateTokens({
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role,
    });
    return res.json(tokens);
  } catch {
    return res
      .status(401)
      .json({ error: "errors.auth.invalid_token", message: "Refresh token invalide" });
  }
});

// GET /api/auth/me
router.get("/me", async (req: AuthenticatedRequest, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "errors.auth.unauthorized" });
  }
  try {
    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET) as {
      userId: string;
      email: string;
      role: string;
    };
    const user = devUsers.find((u) => u.id === decoded.userId);
    return res.json({
      user: user
        ? { id: user.id, name: user.name, email: user.email, role: user.role }
        : decoded,
    });
  } catch {
    return res.status(401).json({ error: "errors.auth.invalid_token" });
  }
});

// POST /api/auth/token-login
router.post("/token-login", async (req: AuthenticatedRequest, res) => {
  return res.status(503).json({
    error: "DEV_MODE",
    message:
      "Token login uniquement disponible en production via le backend VPS. Utilisez /api/auth/login.",
  });
});

// POST /api/auth/logout
router.post("/logout", (req, res) => {
  return res.json({ message: "Déconnecté" });
});

export default router;

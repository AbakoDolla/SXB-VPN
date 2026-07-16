import { Router, Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma, inMemoryDb, logDbActivity } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";

const router = Router();

// Génère un mot de passe aléatoire lisible (12 chars)
function generatePassword(): string {
  const upper = "ABCDEFGHJKMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const special = "@#!";
  const all = upper + lower + digits + special;
  const rand = crypto.randomBytes(16);
  let pass = "";
  pass += upper[rand[0] % upper.length];
  pass += lower[rand[1] % lower.length];
  pass += digits[rand[2] % digits.length];
  pass += special[rand[3] % special.length];
  for (let i = 4; i < 12; i++) {
    pass += all[rand[i] % all.length];
  }
  // Shuffle
  return pass.split("").sort(() => (crypto.randomBytes(1)[0] > 127 ? 1 : -1)).join("");
}

const createUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6).optional(), // optionnel - auto-généré si absent
  phone: z.string().optional(),
  roleId: z.string().uuid({ message: "Veuillez sélectionner un rôle valide" }),
  status: z.enum(["active", "suspended"]).default("active"),
});

const updateUserSchema = z.object({
  name: z.string().min(2).optional(),
  email: z.string().email().optional(),
  password: z.string().min(6).optional(),
  phone: z.string().optional(),
  roleId: z.string().optional(),
  status: z.enum(["active", "suspended"]).optional(),
});

// GET /api/users
router.get("/", requireAuth, requirePermission("users.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    let users: any[] = [];
    if (prisma) {
      users = await prisma.user.findMany({
        include: { role: true },
        orderBy: { createdAt: "desc" },
      });
    } else {
      users = inMemoryDb.users.map((u) => {
        const r = inMemoryDb.roles.find((role) => role.id === u.roleId);
        return { ...u, role: r };
      });
    }
    const sanitized = users.map(({ passwordHash, ...rest }) => rest);
    return res.json(sanitized);
  } catch (err) {
    console.error("Fetch users error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch users" });
  }
});

// GET /api/users/:id
// ─── ROUTES PROFIL UTILISATEUR ───────────────────────────────────────────────

// Setup Multer pour avatars
const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads", "avatars");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, "avatar_" + Date.now() + (path.extname(file.originalname) || ".jpg"));
  },
});
const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Seules les images sont acceptées'));
  },
});

// GET /api/users/me — profil utilisateur courant
router.get("/me", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "DB_UNAVAILABLE" });
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      include: { role: true },
    });
    if (!user) return res.status(404).json({ error: "errors.users.not_found" });
    const { passwordHash, ...safe } = user as any;
    return res.json(safe);
  } catch (err) {
    console.error("GET /me error:", err);
    return res.status(500).json({ error: "errors.server" });
  }
});

// PATCH /api/users/me — mise à jour profil
router.patch("/me", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "DB_UNAVAILABLE" });
    const { name, phone, password } = req.body;
    const data: any = {};
    if (name && typeof name === 'string') data.name = name;
    if (phone !== undefined) data.phone = phone || null;
    if (password && typeof password === 'string' && password.length >= 6) {
      data.passwordHash = bcrypt.hashSync(password, 10);
    }
    const updated = await prisma.user.update({
      where: { id: req.user!.userId },
      data,
      include: { role: true },
    });
    const { passwordHash, ...safe } = updated as any;
    return res.json(safe);
  } catch (err) {
    console.error("PATCH /me error:", err);
    return res.status(500).json({ error: "errors.server" });
  }
});

// POST /api/users/me/avatar — upload photo profil
router.post("/me/avatar", requireAuth, avatarUpload.single("avatar"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ error: "NO_FILE", message: "Aucun fichier reçu" });
    if (!prisma) return res.status(503).json({ error: "DB_UNAVAILABLE" });
    const avatarUrl = "/uploads/avatars/" + req.file.filename;
    const updated = await prisma.user.update({
      where: { id: req.user!.userId },
      data: { avatarUrl },
      include: { role: true },
    });
    const { passwordHash, ...safe } = updated as any;
    return res.json({ success: true, avatarUrl, user: safe });
  } catch (err) {
    console.error("POST /me/avatar error:", err);
    return res.status(500).json({ error: "errors.server" });
  }
});


router.get("/:id", requireAuth, requirePermission("users.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    let userRecord: any = null;
    if (prisma) {
      userRecord = await prisma.user.findUnique({ where: { id }, include: { role: true } });
    } else {
      const u = inMemoryDb.users.find((user) => user.id === id);
      if (u) {
        const r = inMemoryDb.roles.find((role) => role.id === u.roleId);
        userRecord = { ...u, role: r };
      }
    }
    if (!userRecord) {
      return res.status(404).json({ error: "errors.users.not_found", message: "User not found" });
    }
    const { passwordHash, ...sanitized } = userRecord;
    return res.json(sanitized);
  } catch (err) {
    console.error("Fetch user by ID error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch user" });
  }
});

// POST /api/users — crée un compte ADMIN/SUPPORT/etc.
// Si `password` absent → auto-généré et retourné dans `generatedPassword`
router.post("/", requireAuth, requirePermission("users.create"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = createUserSchema.parse(req.body);

    const wasAutoGenerated = !body.password;
    const rawPassword = body.password || generatePassword();
    const passwordHash = bcrypt.hashSync(rawPassword, 10);

    let existingUser = false;
    if (prisma) {
      existingUser = !!(await prisma.user.findUnique({ where: { email: body.email } }));
    } else {
      existingUser = inMemoryDb.users.some((u) => u.email === body.email);
    }

    if (existingUser) {
      return res.status(400).json({ error: "errors.users.email_exists", message: "Email is already in use" });
    }

    let newUser: any = null;
    if (prisma) {
      newUser = await prisma.user.create({
        data: {
          name: body.name,
          email: body.email,
          phone: body.phone,
          passwordHash,
          roleId: body.roleId,
          status: body.status,
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
        roleId: body.roleId,
        status: body.status,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      inMemoryDb.users.push(newUser);
      const role = inMemoryDb.roles.find((r) => r.id === body.roleId);
      newUser = { ...newUser, role };
    }

    await logDbActivity(req.user?.userId || null, `Created user account: ${newUser.email} (role: ${newUser.role?.name})`, "success", req.ip);

    const { passwordHash: _, ...sanitized } = newUser;
    // Retourne le mot de passe généré pour que l'admin puisse le transmettre
    const response: any = { ...sanitized };
    if (wasAutoGenerated) {
      response.generatedPassword = rawPassword;
    }
    return res.status(201).json(response);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    console.error("Create user error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to create user" });
  }
});

// PATCH /api/users/:id
router.patch("/:id", requireAuth, requirePermission("users.create"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const body = updateUserSchema.parse(req.body);

    let userExists = false;
    if (prisma) {
      userExists = !!(await prisma.user.findUnique({ where: { id } }));
    } else {
      userExists = inMemoryDb.users.some((u) => u.id === id);
    }
    if (!userExists) {
      return res.status(404).json({ error: "errors.users.not_found", message: "User not found" });
    }

    const updates: any = { ...body };
    if (body.password) {
      updates.passwordHash = bcrypt.hashSync(body.password, 10);
      delete updates.password;
    }

    let updatedUser: any = null;
    if (prisma) {
      updatedUser = await prisma.user.update({ where: { id }, data: updates, include: { role: true } });
    } else {
      const index = inMemoryDb.users.findIndex((u) => u.id === id);
      const old = inMemoryDb.users[index];
      const merged = { ...old, ...updates, updatedAt: new Date() };
      inMemoryDb.users[index] = merged;
      const r = inMemoryDb.roles.find((role) => role.id === merged.roleId);
      updatedUser = { ...merged, role: r };
    }

    await logDbActivity(req.user?.userId || null, `Modified user account: ${updatedUser.email}`, "info", req.ip);
    const { passwordHash: _, ...sanitized } = updatedUser;
    return res.json(sanitized);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    console.error("Update user error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to update user" });
  }
});

// DELETE /api/users/:id
router.delete("/:id", requireAuth, requirePermission("users.delete"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    // Protect super admin
    if (prisma) {
      const u = await prisma.user.findUnique({ where: { id }, include: { role: true } });
      if (u?.role?.name === "SUPER_ADMIN") {
        return res.status(403).json({ error: "errors.auth.forbidden", message: "Cannot delete Super Admin" });
      }
      await prisma.user.delete({ where: { id } });
    } else {
      const index = inMemoryDb.users.findIndex((u) => u.id === id);
      if (index === -1) {
        return res.status(404).json({ error: "errors.users.not_found", message: "User not found" });
      }
      inMemoryDb.users.splice(index, 1);
    }

    await logDbActivity(req.user?.userId || null, `Deleted user account ID: ${id}`, "warning", req.ip);
    return res.status(204).send();
  } catch (err) {
    console.error("Delete user error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to delete user" });
  }
});


export default router;

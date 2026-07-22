/**
 * Users Routes - RBAC Protected
 * Accepts role by name OR by UUID (roleId), auto-generates password if absent
 */
import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import crypto from "crypto";
import multer from "multer";
import path from "path";
import fs from "fs";
import { prisma, logDbActivity } from "../../database";
import { authenticateUser, authorizeRole, AuthRequest } from "../../middleware/rbac";

function sanitizeUser(user: any) {
  if (!user) return null;
  const { passwordHash, ...safeUser } = user;
  return safeUser;
}

function generatePassword(len = 14): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#";
  return Array.from({ length: len }, () => chars[crypto.randomInt(chars.length)]).join("");
}

// Multer for avatar uploads
const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads", "avatars");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (req: any, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    cb(null, req.user.id + ext);
  },
});
const upload = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, /^image\//.test(file.mimetype));
  },
});

const router = Router();

// GET /api/users
router.get("/", authenticateUser, authorizeRole("ADMIN", "SUPPORT", "SUPER_ADMIN"), async (_req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      include: { role: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, users: users.map(sanitizeUser) });
  } catch (error) {
    console.error("Get users error:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// GET /api/users/me
router.get("/me", authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    });
    if (!user) { res.status(404).json({ error: "Utilisateur non trouvé" }); return; }
    res.json({ success: true, user: sanitizeUser(user) });
  } catch (error) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// PATCH /api/users/me — update own profile
router.patch("/me", authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const { name, phone } = req.body;
    const updated = await prisma.user.update({
      where: { id: req.user!.id },
      data: { ...(name && { name }), ...(phone !== undefined && { phone }) },
      include: { role: true },
    });
    res.json({ success: true, user: sanitizeUser(updated) });
  } catch (err) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// POST /api/users/me/avatar — upload profile photo
router.post("/me/avatar", authenticateUser, upload.single("avatar"), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Aucun fichier fourni" });
    const avatarUrl = "/uploads/avatars/" + req.file.filename;
    const updated = await prisma.user.update({
      where: { id: req.user!.id },
      data: { avatarUrl },
      include: { role: true },
    });
    res.json({ success: true, avatarUrl, user: sanitizeUser(updated) });
  } catch (err) {
    console.error("Avatar upload error:", err);
    res.status(500).json({ error: "Erreur upload" });
  }
});

// POST /api/users — create user (accepts role name OR roleId UUID)
const createUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6).optional(),
  phone: z.string().optional(),
  role: z.string().optional(),    // role name: "ADMIN", "SUPPORT", etc.
  roleId: z.string().optional(),  // role UUID from dropdown
  commission: z.number().optional(),
  status: z.string().optional(),
});

router.post("/", authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const body = createUserSchema.parse(req.body);
    const callerRole = req.user!.role;

    // Resolve role record from UUID OR name
    let roleRecord: any = null;
    if (body.roleId) {
      roleRecord = await prisma.role.findUnique({ where: { id: body.roleId } });
    }
    if (!roleRecord && body.role) {
      roleRecord = await prisma.role.findFirst({ where: { name: body.role.toUpperCase() } });
    }
    if (!roleRecord) {
      roleRecord = await prisma.role.findFirst({ where: { name: "RESELLER" } });
    }
    if (!roleRecord) return res.status(500).json({ error: "Rôle introuvable" });

    const roleName: string = roleRecord.name;

    // Hierarchy check
    const allowedRoles: Record<string, string[]> = {
      SUPER_ADMIN: ["ADMIN", "SUPPORT", "RESELLER", "SUPER_ADMIN"],
      ADMIN: ["SUPPORT", "RESELLER"],
    };
    const allowed = allowedRoles[callerRole] || [];
    if (!allowed.includes(roleName)) {
      return res.status(403).json({ error: `Vous ne pouvez pas créer le rôle ${roleName}` });
    }

    const existingUser = await prisma.user.findUnique({ where: { email: body.email } });
    if (existingUser) return res.status(400).json({ error: "Cet email est déjà utilisé" });

    // Auto-generate password if not provided
    const wasAutoGenerated = !body.password;
    const plainPassword = body.password || generatePassword(14);
    const passwordHash = await bcrypt.hash(plainPassword, 10);

    const userData: any = {
      name: body.name,
      email: body.email,
      phone: body.phone,
      passwordHash,
      roleId: roleRecord.id,
      status: body.status || "active",
    };
    if (roleName === "RESELLER") {
      userData.resellerInfo = { create: { commission: body.commission || 0, status: "active" } };
    }

    const user = await prisma.user.create({
      data: userData,
      include: { role: true, resellerInfo: true },
    });

    await logDbActivity(req.user!.id, `Created ${roleName} user: ${body.email}`, "success", req.ip);

    res.status(201).json({
      success: true,
      message: `Utilisateur ${roleName} créé avec succès`,
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      createdAt: user.createdAt,
      status: user.status,
      role: { id: roleRecord.id, name: roleName },
      generatedPassword: wasAutoGenerated ? plainPassword : undefined,
      user: sanitizeUser(user),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Validation error", details: error.errors });
    }
    console.error("Create user error:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// PATCH /api/users/:id
router.patch("/:id", authenticateUser, authorizeRole("ADMIN", "SUPER_ADMIN"), async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, phone, status, role, roleId } = req.body;
    const updateData: any = {};
    if (name) updateData.name = name;
    if (email) updateData.email = email;
    if (phone !== undefined) updateData.phone = phone;
    if (status) updateData.status = status;
    if (roleId) {
      updateData.roleId = roleId;
    } else if (role) {
      const r = await prisma.role.findFirst({ where: { name: role.toUpperCase() } });
      if (r) updateData.roleId = r.id;
    }
    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: updateData,
      include: { role: true },
    });
    res.json({ success: true, user: sanitizeUser(updated) });
  } catch (err) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// DELETE /api/users/:id
router.delete("/:id", authenticateUser, authorizeRole("ADMIN", "SUPER_ADMIN"), async (req: AuthRequest, res: Response) => {
  try {
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// POST /api/users/create-super-admin
router.post("/create-super-admin", authenticateUser, authorizeRole("SUPER_ADMIN"), async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, password, phone } = req.body;
    const role = await prisma.role.findFirst({ where: { name: "SUPER_ADMIN" } });
    if (!role) return res.status(500).json({ error: "Role SUPER_ADMIN non trouvé" });
    const passwordHash = await bcrypt.hash(password || generatePassword(), 10);
    const user = await prisma.user.create({
      data: { name, email, phone, passwordHash, roleId: role.id, status: "active" },
      include: { role: true },
    });
    res.json({ success: true, user: sanitizeUser(user) });
  } catch (err) { res.status(500).json({ error: "Erreur serveur" }); }
});

// POST /api/users/create-admin
router.post("/create-admin", authenticateUser, authorizeRole("SUPER_ADMIN"), async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, password, phone } = req.body;
    const role = await prisma.role.findFirst({ where: { name: "ADMIN" } });
    if (!role) return res.status(500).json({ error: "Role ADMIN non trouvé" });
    const passwordHash = await bcrypt.hash(password || generatePassword(), 10);
    const user = await prisma.user.create({
      data: { name, email, phone, passwordHash, roleId: role.id, status: "active" },
      include: { role: true },
    });
    res.json({ success: true, user: sanitizeUser(user) });
  } catch (err) { res.status(500).json({ error: "Erreur serveur" }); }
});

// POST /api/users/create-support
router.post("/create-support", authenticateUser, authorizeRole("ADMIN", "SUPER_ADMIN"), async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, password, phone } = req.body;
    const role = await prisma.role.findFirst({ where: { name: "SUPPORT" } });
    if (!role) return res.status(500).json({ error: "Role SUPPORT non trouvé" });
    const passwordHash = await bcrypt.hash(password || generatePassword(), 10);
    const user = await prisma.user.create({
      data: { name, email, phone, passwordHash, roleId: role.id, status: "active" },
      include: { role: true },
    });
    res.json({ success: true, user: sanitizeUser(user) });
  } catch (err) { res.status(500).json({ error: "Erreur serveur" }); }
});

export default router;

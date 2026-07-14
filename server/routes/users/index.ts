/**
 * Users Routes - RBAC Protected
 */
import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../../database";
import { authenticateUser, authorizeRole, authorizePermission, AuthRequest } from "../../middleware/rbac";
import { generateTokens } from "../../middleware/auth";

const router = Router();

// Get all users (ADMIN only)
router.get("/", authenticateUser, authorizeRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      include: { role: true },
      orderBy: { createdAt: "desc" }
    });
    res.json({ success: true, users: users.map(u => ({ ...u, passwordHash: undefined })) });
  } catch (error) {
    console.error("Get users error:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Get current user
router.get("/me", authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { role: { include: { permissions: { include: { permission: true } } } } }
    });
    if (!user) { res.status(404).json({ error: "Utilisateur non trouve" }); return; }
    res.json({ success: true, user: { ...user, passwordHash: undefined } });
  } catch (error) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Create admin user (ADMIN only)
router.post("/create-admin", authenticateUser, authorizeRole("ADMIN"), async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, password } = req.body;
    const role = await prisma.role.findUnique({ where: { name: "ADMIN" } });
    if (!role) { res.status(500).json({ error: "Role ADMIN non trouve" }); return; }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { name, email, passwordHash, roleId: role.id },
      include: { role: true }
    });
    res.json({ success: true, user: { ...user, passwordHash: undefined } });
  } catch (error) {
    console.error("Create admin error:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Create support user (ADMIN only)
router.post("/create-support", authenticateUser, authorizeRole("ADMIN"), async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, password } = req.body;
    const role = await prisma.role.findUnique({ where: { name: "SUPPORT" } });
    if (!role) { res.status(500).json({ error: "Role SUPPORT non trouve" }); return; }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { name, email, passwordHash, roleId: role.id },
      include: { role: true }
    });
    res.json({ success: true, user: { ...user, passwordHash: undefined } });
  } catch (error) {
    console.error("Create support error:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Create reseller user (ADMIN only)
router.post("/create-reseller", authenticateUser, authorizeRole("ADMIN"), async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, password, commission } = req.body;
    const role = await prisma.role.findUnique({ where: { name: "RESELLER" } });
    if (!role) { res.status(500).json({ error: "Role RESELLER non trouve" }); return; }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        name, email, passwordHash, roleId: role.id,
        resellerInfo: { create: { commission: commission || 0 } }
      },
      include: { role: true, resellerInfo: true }
    });
    res.json({ success: true, user: { ...user, passwordHash: undefined } });
  } catch (error) {
    console.error("Create reseller error:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Update user (ADMIN only)
router.patch("/:id", authenticateUser, authorizeRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const { name, email, status, roleId } = req.body;
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { name, email, status, roleId },
      include: { role: true }
    });
    res.json({ success: true, user: { ...user, passwordHash: undefined } });
  } catch (error) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Delete user (ADMIN only)
router.delete("/:id", authenticateUser, authorizeRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: "Utilisateur supprime" });
  } catch (error) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Get roles and permissions (ADMIN only)
router.get("/roles-permissions", authenticateUser, authorizeRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const roles = await prisma.role.findMany({
      include: { permissions: { include: { permission: true } } }
    });
    const permissions = await prisma.permission.findMany();
    res.json({ success: true, roles, permissions });
  } catch (error) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;

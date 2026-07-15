/**
 * Users Routes - RBAC Protected
 * Complete user management with role-based access control
 */
import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma, logDbActivity } from "../../database";
import { authenticateUser, authorizeRole, authorizePermission, AuthRequest } from "../../middleware/rbac";

// Helper to remove sensitive data from user object
function sanitizeUser(user: any) {
  if (!user) return null;
  const { passwordHash, ...safeUser } = user;
  return safeUser;
}

const router = Router();

// Get all users (ADMIN only)
router.get("/", authenticateUser, authorizeRole("ADMIN", "SUPPORT"), async (req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      include: { role: true },
      orderBy: { createdAt: "desc" }
    });
    res.json({ success: true, users: users.map(sanitizeUser) });
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
    res.json({ success: true, user: sanitizeUser(user) });
  } catch (error) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Create user with specific role (ADMIN or SUPER_ADMIN can create)
const createUserSchema = z.object({
  name: z.string().min(2, "Le nom doit contenir au moins 2 caractères"),
  email: z.string().email("Email invalide"),
  password: z.string().min(6, "Le mot de passe doit contenir au moins 6 caractères"),
  phone: z.string().optional(),
  role: z.enum(["ADMIN", "SUPPORT", "RESELLER", "SUPER_ADMIN"]).default("RESELLER"),
  commission: z.number().optional(), // For RESELLER
});

// Create user endpoint - ADMIN can create SUPPORT, RESELLER. SUPER_ADMIN can create ADMIN
router.post("/", authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const body = createUserSchema.parse(req.body);
    const userRole = req.user!.role;

    // Permission check based on role hierarchy
    let allowedRoles: string[] = [];
    if (userRole === "SUPER_ADMIN") {
      allowedRoles = ["ADMIN", "SUPPORT", "RESELLER"];
    } else if (userRole === "ADMIN") {
      allowedRoles = ["SUPPORT", "RESELLER"];
    } else {
      return res.status(403).json({ error: "Vous n'avez pas le droit de créer des utilisateurs" });
    }

    if (!allowedRoles.includes(body.role)) {
      return res.status(403).json({ 
        error: `Vous ne pouvez créer que des rôles: ${allowedRoles.join(", ")}` 
      });
    }

    // Check if email already exists
    const existingUser = await prisma.user.findUnique({ where: { email: body.email } });
    if (existingUser) {
      return res.status(400).json({ error: "Cet email est déjà utilisé" });
    }

    // Find the role
    const role = await prisma.role.findUnique({ where: { name: body.role } });
    if (!role) {
      return res.status(500).json({ error: `Rôle ${body.role} non trouvé` });
    }

    const passwordHash = await bcrypt.hash(body.password, 10);

    // Create user with optional reseller info
    const userData: any = {
      name: body.name,
      email: body.email,
      phone: body.phone,
      passwordHash,
      roleId: role.id,
      status: "active",
    };

    // Add reseller info if role is RESELLER
    if (body.role === "RESELLER") {
      userData.resellerInfo = {
        create: { commission: body.commission || 0, status: "active" }
      };
    }

    const user = await prisma.user.create({
      data: userData,
      include: { 
        role: true, 
        resellerInfo: true 
      }
    });

    await logDbActivity(req.user!.id, `Created ${body.role} user: ${body.email}`, "success", req.ip);

    res.status(201).json({ 
      success: true, 
      message: `Utilisateur ${body.role} créé avec succès`,
      user: sanitizeUser(user) 
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Validation error", details: error.errors });
    }
    console.error("Create user error:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Create SUPER_ADMIN (SUPER_ADMIN only)
router.post("/create-super-admin", authenticateUser, authorizeRole("SUPER_ADMIN"), async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, password, phone } = req.body;
    
    const role = await prisma.role.findUnique({ where: { name: "SUPER_ADMIN" } });
    if (!role) {
      // Create SUPER_ADMIN role if it doesn't exist
      const newRole = await prisma.role.create({
        data: { name: "SUPER_ADMIN", description: "Super Administrator with full access" }
      });
      // Give all permissions to SUPER_ADMIN
      const allPerms = await prisma.permission.findMany();
      await prisma.rolePermission.createMany({
        data: allPerms.map(p => ({ roleId: newRole.id, permissionId: p.id }))
      });
    }

    const roleId = role?.id || (await prisma.role.findUnique({ where: { name: "SUPER_ADMIN" } }))!.id;
    const passwordHash = await bcrypt.hash(password, 10);
    
    const user = await prisma.user.create({
      data: { name, email, phone, passwordHash, roleId, status: "active" },
      include: { role: true }
    });

    await logDbActivity(user.id, `SUPER_ADMIN created: ${email}`, "success", req.ip);

    res.status(201).json({ success: true, user: sanitizeUser(user) });
  } catch (error) {
    console.error("Create super admin error:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Create ADMIN user (SUPER_ADMIN only)
router.post("/create-admin", authenticateUser, authorizeRole("SUPER_ADMIN"), async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, password, phone } = req.body;
    const role = await prisma.role.findUnique({ where: { name: "ADMIN" } });
    if (!role) { res.status(500).json({ error: "Role ADMIN non trouve" }); return; }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { name, email, phone, passwordHash, roleId: role.id, status: "active" },
      include: { role: true }
    });
    await logDbActivity(req.user!.id, `Created ADMIN user: ${email}`, "success", req.ip);
    res.json({ success: true, user: sanitizeUser(user) });
  } catch (error) {
    console.error("Create admin error:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Create SUPPORT user (ADMIN and SUPER_ADMIN)
router.post("/create-support", authenticateUser, authorizeRole("ADMIN", "SUPER_ADMIN"), async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, password, phone } = req.body;
    const role = await prisma.role.findUnique({ where: { name: "SUPPORT" } });
    if (!role) { res.status(500).json({ error: "Role SUPPORT non trouve" }); return; }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { name, email, phone, passwordHash, roleId: role.id, status: "active" },
      include: { role: true }
    });
    await logDbActivity(req.user!.id, `Created SUPPORT user: ${email}`, "success", req.ip);
    res.json({ success: true, user: sanitizeUser(user) });
  } catch (error) {
    console.error("Create support error:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Create RESELLER user (ADMIN and SUPER_ADMIN)
router.post("/create-reseller", authenticateUser, authorizeRole("ADMIN", "SUPER_ADMIN"), async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, password, phone, commission } = req.body;
    const role = await prisma.role.findUnique({ where: { name: "RESELLER" } });
    if (!role) { res.status(500).json({ error: "Role RESELLER non trouve" }); return; }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        name, email, phone, passwordHash, roleId: role.id, status: "active",
        resellerInfo: { create: { commission: commission || 0, status: "active" } }
      },
      include: { role: true, resellerInfo: true }
    });
    await logDbActivity(req.user!.id, `Created RESELLER user: ${email}`, "success", req.ip);
    res.json({ success: true, user: sanitizeUser(user) });
  } catch (error) {
    console.error("Create reseller error:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Update user (ADMIN and SUPER_ADMIN)
router.patch("/:id", authenticateUser, authorizeRole("ADMIN", "SUPER_ADMIN"), async (req: Request, res: Response) => {
  try {
    const { name, email, status, roleId } = req.body;
    
    // Prevent modifying SUPER_ADMIN role
    const targetUser = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (targetUser) {
      const targetRole = await prisma.role.findUnique({ where: { id: targetUser.roleId } });
      if (targetRole?.name === "SUPER_ADMIN" && req.user!.role !== "SUPER_ADMIN") {
        return res.status(403).json({ error: "Vous ne pouvez pas modifier un SUPER_ADMIN" });
      }
    }
    
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { name, email, status, roleId },
      include: { role: true }
    });
    await logDbActivity(req.user!.id, `Updated user: ${user.email}`, "info", req.ip);
    res.json({ success: true, user: sanitizeUser(user) });
  } catch (error) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Delete user (ADMIN and SUPER_ADMIN)
router.delete("/:id", authenticateUser, authorizeRole("ADMIN", "SUPER_ADMIN"), async (req: Request, res: Response) => {
  try {
    const targetUser = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!targetUser) {
      return res.status(404).json({ error: "Utilisateur non trouvé" });
    }
    
    const targetRole = await prisma.role.findUnique({ where: { id: targetUser.roleId } });
    
    // Prevent deleting SUPER_ADMIN
    if (targetRole?.name === "SUPER_ADMIN") {
      return res.status(403).json({ error: "Vous ne pouvez pas supprimer un SUPER_ADMIN" });
    }
    
    // Prevent deleting yourself
    if (targetUser.id === req.user!.id) {
      return res.status(403).json({ error: "Vous ne pouvez pas vous supprimer vous-même" });
    }
    
    await prisma.user.delete({ where: { id: req.params.id } });
    await logDbActivity(req.user!.id, `Deleted user: ${targetUser.email}`, "danger", req.ip);
    res.json({ success: true, message: "Utilisateur supprimé" });
  } catch (error) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Get roles and permissions (ADMIN and SUPER_ADMIN)
router.get("/roles-permissions", authenticateUser, authorizeRole("ADMIN", "SUPER_ADMIN"), async (req: Request, res: Response) => {
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

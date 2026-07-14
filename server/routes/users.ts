import { Router, Response } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma, inMemoryDb, logDbActivity } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";

const router = Router();

const createUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  phone: z.string().optional(),
  roleId: z.string(),
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

    // Strip password hashes
    const sanitized = users.map(({ passwordHash, ...rest }) => rest);
    return res.json(sanitized);
  } catch (err) {
    console.error("Fetch users error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch users" });
  }
});

// GET /api/users/:id
router.get("/:id", requireAuth, requirePermission("users.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    let userRecord: any = null;

    if (prisma) {
      userRecord = await prisma.user.findUnique({
        where: { id },
        include: { role: true },
      });
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

// POST /api/users
router.post("/", requireAuth, requirePermission("users.create"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = createUserSchema.parse(req.body);
    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(body.password, salt);

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

    await logDbActivity(req.user?.userId || null, `Created user account: ${newUser.email}`, "success", req.ip);

    const { passwordHash: _, ...sanitized } = newUser;
    return res.status(201).json(sanitized);
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
      const salt = bcrypt.genSaltSync(10);
      updates.passwordHash = bcrypt.hashSync(body.password, salt);
      delete updates.password;
    }

    let updatedUser: any = null;
    if (prisma) {
      updatedUser = await prisma.user.update({
        where: { id },
        data: updates,
        include: { role: true },
      });
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

    if (id === req.user?.userId) {
      return res.status(400).json({ error: "errors.users.self_delete", message: "You cannot delete your own account" });
    }

    let deletedEmail = "";
    if (prisma) {
      const user = await prisma.user.delete({ where: { id } });
      deletedEmail = user.email;
    } else {
      const index = inMemoryDb.users.findIndex((u) => u.id === id);
      if (index === -1) {
        return res.status(404).json({ error: "errors.users.not_found", message: "User not found" });
      }
      deletedEmail = inMemoryDb.users[index].email;
      inMemoryDb.users.splice(index, 1);
    }

    await logDbActivity(req.user?.userId || null, `Deleted user account: ${deletedEmail}`, "danger", req.ip);
    return res.json({ message: "User account deleted successfully" });
  } catch (err) {
    console.error("Delete user error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to delete user" });
  }
});

export default router;

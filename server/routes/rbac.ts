import { Router, Response } from "express";
import { z } from "zod";
import { prisma, inMemoryDb, logDbActivity } from "../database";
import { requireAuth, requireRole, AuthenticatedRequest } from "../middleware/auth";

const router = Router();

const updateRolePermissionsSchema = z.object({
  permissionIds: z.array(z.string()),
});

// GET /api/rbac/roles — liste des rôles avec leurs permissions actuelles
router.get("/roles", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    let roles: any[] = [];
    if (prisma) {
      roles = await prisma.role.findMany({
        include: { permissions: { include: { permission: true } } },
      });
      roles = roles.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        permissions: r.permissions.map((rp: any) => rp.permission.name),
      }));
    } else {
      roles = inMemoryDb.roles.map((r) => {
        const rp = inMemoryDb.rolePermissions.filter((item) => item.roleId === r.id);
        const perms = inMemoryDb.permissions
          .filter((p) => rp.some((item) => item.permissionId === p.id))
          .map((p) => p.name);
        return { id: r.id, name: r.name, description: r.description, permissions: perms };
      });
    }
    return res.json(roles);
  } catch (err) {
    console.error("Fetch RBAC roles error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch roles" });
  }
});

// GET /api/rbac/permissions — catalogue complet des permissions système
router.get("/permissions", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    let permissions: any[] = [];
    if (prisma) {
      permissions = await prisma.permission.findMany({ orderBy: { name: "asc" } });
    } else {
      permissions = inMemoryDb.permissions;
    }
    return res.json(permissions);
  } catch (err) {
    console.error("Fetch permissions catalog error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch permissions" });
  }
});

// PATCH /api/rbac/roles/:id — remplace l'ensemble des permissions d'un rôle (ADMIN uniquement)
router.patch("/roles/:id", requireAuth, requireRole(["ADMIN"]), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const body = updateRolePermissionsSchema.parse(req.body);

    let updated: any = null;
    if (prisma) {
      await prisma.rolePermission.deleteMany({ where: { roleId: id } });
      if (body.permissionIds.length > 0) {
        await prisma.rolePermission.createMany({
          data: body.permissionIds.map((permissionId) => ({ roleId: id, permissionId })),
        });
      }
      const role = await prisma.role.findUnique({
        where: { id },
        include: { permissions: { include: { permission: true } } },
      });
      updated = {
        id: role?.id,
        name: role?.name,
        permissions: role?.permissions.map((rp) => rp.permission.name) ?? [],
      };
    } else {
      inMemoryDb.rolePermissions = inMemoryDb.rolePermissions.filter((rp) => rp.roleId !== id);
      body.permissionIds.forEach((permissionId) => {
        inMemoryDb.rolePermissions.push({ roleId: id, permissionId });
      });
      const role = inMemoryDb.roles.find((r) => r.id === id);
      const perms = inMemoryDb.permissions
        .filter((p) => body.permissionIds.includes(p.id))
        .map((p) => p.name);
      updated = { id: role?.id, name: role?.name, permissions: perms };
    }

    await logDbActivity(req.user?.userId || null, `Updated RBAC permission matrix for role: ${updated?.name}`, "warning", req.ip);
    return res.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    console.error("Update role permissions error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to update role permissions" });
  }
});

export default router;

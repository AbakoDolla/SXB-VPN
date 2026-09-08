import { Router, Response } from "express";
import { z } from "zod";
import { prisma, inMemoryDb, logDbActivity } from "../database";
import { requireAuth, requirePermission, requireRole, AuthenticatedRequest } from "../middleware/auth";
import { isOwnerRequest, OWNER_ROLE } from "../middleware/rbac/owner";

const router = Router();

const updateRolePermissionsSchema = z.object({
  permissionIds: z.array(z.string()).optional(),
  permissions: z.array(z.string()).optional(), // accepte aussi les codes/noms
}).refine(body => (body.permissionIds !== undefined) !== (body.permissions !== undefined), {
  message: "Fournissez soit permissionIds soit permissions, y compris une liste vide pour retirer les droits.",
});

const baselinePermissionDescriptions: Record<string, string> = {
  "subscription.view": "Voir les forfaits data",
  "subscription.manage": "Créer et gérer les forfaits data",
};

async function ensureBaselinePermissions() {
  if (!prisma) return;
  for (const name of Object.keys(baselinePermissionDescriptions)) {
    await prisma.permission.upsert({
      where: { name },
      update: { description: baselinePermissionDescriptions[name] },
      create: { name, description: baselinePermissionDescriptions[name] },
    });
  }
}

// GET /api/rbac/roles — liste des rôles avec leurs permissions actuelles
router.get("/roles", requireAuth, requireRole(["SUPER_ADMIN", "ADMIN"]), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!isOwnerRequest(req) && !req.user?.permissions.some(permission => ["rbac.manage", "users.create"].includes(permission))) {
      return res.status(403).json({ error: "errors.auth.forbidden_permission", message: "Permission rbac.manage ou users.create requise" });
    }
    let roles: any[] = [];
    if (prisma) {
      await ensureBaselinePermissions();
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
    // Stealth : le rôle OWNER n'apparaît que pour un OWNER.
    const visibleRoles = isOwnerRequest(req) ? roles : roles.filter((r) => r.name !== OWNER_ROLE);
    return res.json(visibleRoles);
  } catch (err) {
    console.error("Fetch RBAC roles error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch roles" });
  }
});

// GET /api/rbac/permissions — catalogue complet des permissions système
router.get("/permissions", requireAuth, requireRole(["SUPER_ADMIN", "ADMIN"]), requirePermission("rbac.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    let permissions: any[] = [];
    if (prisma) {
      await ensureBaselinePermissions();
      const raw = await prisma.permission.findMany({ orderBy: { name: "asc" } });
      permissions = raw.map((p: any) => ({
        id: p.id,
        code: p.name,
        description: p.description || p.name,
        category: p.name.includes(":") ? p.name.split(":")[0] :
                  p.name.includes(".") ? p.name.split(".")[0] : "general",
      }));
    } else {
      permissions = inMemoryDb.permissions.map((p: any) => ({
        id: p.id,
        code: p.name,
        description: p.description || p.name,
        category: p.name.includes(":") ? p.name.split(":")[0] :
                  p.name.includes(".") ? p.name.split(".")[0] : "general",
      }));
    }
    return res.json(permissions);
  } catch (err) {
    console.error("Fetch permissions catalog error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch permissions" });
  }
});

// PATCH /api/rbac/roles/:id — seul le SUPER_ADMIN modifie la matrice d’habilitations.
router.patch("/roles/:id", requireAuth, requireRole(["SUPER_ADMIN"]), requirePermission("rbac.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const body = updateRolePermissionsSchema.parse(req.body);

    let updated: any = null;
    if (prisma) {
      const roleCible = await prisma.role.findUnique({ where: { id } });
      if (!roleCible) return res.status(404).json({ error: "errors.rbac.role_not_found" });
      if (roleCible.name === OWNER_ROLE) {
        return res.status(403).json({
          error: "errors.rbac.owner_locked",
          code: "RBAC_OWNER_LOCKED",
          message: "Le rôle OWNER est immuable et contourne la matrice de permissions.",
        });
      }

      const codesDemandes = body.permissions
        ? Array.from(new Set(body.permissions))
        : null;
      const idsDemandes = codesDemandes === null
        ? Array.from(new Set(body.permissionIds || []))
        : [];
      const permissionsTrouvees = codesDemandes !== null
        ? await prisma.permission.findMany({ where: { name: { in: codesDemandes } } })
        : await prisma.permission.findMany({ where: { id: { in: idsDemandes } } });
      const nombreAttendu = codesDemandes?.length ?? idsDemandes.length;
      if (permissionsTrouvees.length !== nombreAttendu) {
        return res.status(400).json({
          error: "errors.rbac.unknown_permission",
          code: "RBAC_UNKNOWN_PERMISSION",
          message: "Une ou plusieurs permissions sont inconnues.",
        });
      }
      const noms = permissionsTrouvees.map((permission) => permission.name);
      if (roleCible.name === "SUPER_ADMIN" && !noms.includes("rbac.manage")) {
        return res.status(409).json({
          error: "errors.rbac.lockout",
          code: "RBAC_LOCKOUT_PREVENTED",
          message: "SUPER_ADMIN doit conserver la permission rbac.manage.",
        });
      }

      const permIds = permissionsTrouvees.map((permission) => permission.id);
      await prisma.$transaction(async (tx: any) => {
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        if (permIds.length > 0) {
          await tx.rolePermission.createMany({
            data: permIds.map((permissionId) => ({ roleId: id, permissionId })),
          });
        }
      });
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
      const role = inMemoryDb.roles.find((item) => item.id === id);
      if (!role) return res.status(404).json({ error: "errors.rbac.role_not_found" });
      if (role.name === OWNER_ROLE) {
        return res.status(403).json({ error: "errors.rbac.owner_locked", code: "RBAC_OWNER_LOCKED" });
      }
      const requested = body.permissions ?? body.permissionIds ?? [];
      const resolvedIds = body.permissions
        ? inMemoryDb.permissions.filter((permission) => requested.includes(permission.name)).map((permission) => permission.id)
        : requested;
      const resolvedNames = inMemoryDb.permissions
        .filter((permission) => resolvedIds.includes(permission.id))
        .map((permission) => permission.name);
      if (role.name === "SUPER_ADMIN" && !resolvedNames.includes("rbac.manage")) {
        return res.status(409).json({ error: "errors.rbac.lockout", code: "RBAC_LOCKOUT_PREVENTED" });
      }
      inMemoryDb.rolePermissions = inMemoryDb.rolePermissions.filter((rp) => rp.roleId !== id);
      resolvedIds.forEach((permissionId) => {
        inMemoryDb.rolePermissions.push({ roleId: id, permissionId });
      });
      const perms = inMemoryDb.permissions
        .filter((p) => resolvedIds.includes(p.id))
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

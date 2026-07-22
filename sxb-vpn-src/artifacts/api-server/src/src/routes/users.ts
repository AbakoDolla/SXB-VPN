import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

interface DevUser {
  id: string;
  name: string;
  email: string;
  phone?: string;
  passwordHash: string;
  role: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

const devUsers: DevUser[] = [
  {
    id: "dev-admin-001",
    name: "Admin SXB",
    email: "admin@sxbvpn.com",
    passwordHash: bcrypt.hashSync("admin123", 10),
    role: "SUPER_ADMIN",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

function sanitize(u: DevUser) {
  const { passwordHash, ...rest } = u;
  return rest;
}

const createSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  phone: z.string().optional(),
  role: z.string().optional(),
});

// GET /api/users
router.get("/", requireAuth, requireRole(["SUPER_ADMIN", "ADMIN"]), async (req, res) => {
  return res.json(devUsers.map(sanitize));
});

// GET /api/users/:id
router.get("/:id", requireAuth, async (req: AuthenticatedRequest, res) => {
  const user = devUsers.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: "errors.users.not_found" });
  return res.json(sanitize(user));
});

// POST /api/users
router.post("/", requireAuth, requireRole(["SUPER_ADMIN", "ADMIN"]), async (req, res) => {
  try {
    const body = createSchema.parse(req.body);
    if (devUsers.some((u) => u.email === body.email)) {
      return res.status(400).json({ error: "errors.auth.email_exists" });
    }
    const newUser: DevUser = {
      id: `user-${Date.now()}`,
      name: body.name,
      email: body.email,
      phone: body.phone,
      passwordHash: bcrypt.hashSync(body.password, 10),
      role: body.role || "RESELLER",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    devUsers.push(newUser);
    return res.status(201).json(sanitize(newUser));
  } catch (err) {
    if (err instanceof z.ZodError)
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    return res.status(500).json({ error: "errors.server" });
  }
});

// PATCH /api/users/:id
router.patch("/:id", requireAuth, requireRole(["SUPER_ADMIN", "ADMIN"]), async (req, res) => {
  const idx = devUsers.findIndex((u) => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "errors.users.not_found" });
  const { password, ...rest } = req.body;
  devUsers[idx] = {
    ...devUsers[idx],
    ...rest,
    ...(password ? { passwordHash: bcrypt.hashSync(password, 10) } : {}),
    updatedAt: new Date().toISOString(),
  };
  return res.json(sanitize(devUsers[idx]));
});

// DELETE /api/users/:id
router.delete("/:id", requireAuth, requireRole(["SUPER_ADMIN"]), async (req, res) => {
  const idx = devUsers.findIndex((u) => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "errors.users.not_found" });
  devUsers.splice(idx, 1);
  return res.json({ message: "Utilisateur supprimé" });
});

export default router;

import { Router } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

// Dev in-memory clients store
const devClients: Record<string, unknown>[] = [];

const createSchema = z.object({
  userId: z.string().optional(),
  name: z.string().min(2),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  quotaTotalGb: z.coerce.number().min(1).optional(),
  durationDays: z.coerce.number().min(1).optional(),
  deviceLimit: z.coerce.number().min(1).default(1),
});

function generateToken() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const seg = () =>
    Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `SXB-USER-${seg()}-${seg()}-${seg()}`;
}

// GET /api/clients
router.get("/", requireAuth, async (req: AuthenticatedRequest, res) => {
  return res.json(devClients);
});

// GET /api/clients/:id
router.get("/:id", requireAuth, async (req: AuthenticatedRequest, res) => {
  const client = devClients.find((c: any) => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: "errors.clients.not_found" });
  return res.json(client);
});

// POST /api/clients
router.post("/", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const body = createSchema.parse(req.body);
    const client = {
      id: `client-${Date.now()}`,
      ...body,
      token: generateToken(),
      quotaTotal: body.quotaTotalGb ? body.quotaTotalGb * 1024 * 1024 * 1024 : 0,
      quotaUsed: 0,
      expireAt: body.durationDays
        ? new Date(Date.now() + body.durationDays * 86400000).toISOString()
        : null,
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    devClients.push(client);
    return res.status(201).json(client);
  } catch (err) {
    if (err instanceof z.ZodError)
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    return res.status(500).json({ error: "errors.server" });
  }
});

// PATCH /api/clients/:id
router.patch("/:id", requireAuth, async (req: AuthenticatedRequest, res) => {
  const idx = devClients.findIndex((c: any) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "errors.clients.not_found" });
  devClients[idx] = { ...devClients[idx], ...req.body, updatedAt: new Date().toISOString() };
  return res.json(devClients[idx]);
});

// DELETE /api/clients/:id
router.delete("/:id", requireAuth, async (req: AuthenticatedRequest, res) => {
  const idx = devClients.findIndex((c: any) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "errors.clients.not_found" });
  devClients.splice(idx, 1);
  return res.json({ message: "Client supprimé" });
});

export default router;

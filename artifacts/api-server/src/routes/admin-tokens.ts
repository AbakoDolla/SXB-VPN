import { Router } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

function makeAdminToken() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const seg = () =>
    Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `SXB-ADMIN-${seg()}-${seg()}`;
}

interface AdminToken {
  id: string;
  token: string;
  userId: string;
  expiresAt: string;
  status: string;
  createdAt: string;
  usedAt?: string;
}

const devTokens: AdminToken[] = [];

const generateSchema = z.object({
  userId: z.string(),
  expiresInHours: z.coerce.number().min(1).max(168).default(24),
});

// POST /api/admin-tokens/generate
router.post("/generate", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, expiresInHours } = generateSchema.parse(req.body);

    // Révoquer tokens actifs existants pour cet user
    devTokens.forEach((t) => {
      if (t.userId === userId && t.status === "active") t.status = "revoked";
    });

    const token: AdminToken = {
      id: `token-${Date.now()}`,
      token: makeAdminToken(),
      userId,
      expiresAt: new Date(Date.now() + expiresInHours * 3600000).toISOString(),
      status: "active",
      createdAt: new Date().toISOString(),
    };
    devTokens.push(token);

    return res.status(201).json({
      message: "Token généré avec succès",
      token: token.token,
      expiresAt: token.expiresAt,
    });
  } catch (err) {
    if (err instanceof z.ZodError)
      return res.status(400).json({ error: "errors.validation" });
    return res.status(500).json({ error: "errors.server" });
  }
});

// GET /api/admin-tokens
router.get("/", requireAuth, async (req: AuthenticatedRequest, res) => {
  return res.json(devTokens);
});

// POST /api/admin-tokens/activate (alias for auth/token-login)
router.post("/activate", async (req, res) => {
  return res.status(503).json({
    error: "DEV_MODE",
    message: "Activation via token uniquement disponible sur le backend VPS.",
  });
});

// DELETE /api/admin-tokens/:id/revoke
router.delete("/:id/revoke", requireAuth, async (req, res) => {
  const token = devTokens.find((t) => t.id === req.params.id);
  if (!token) return res.status(404).json({ error: "TOKEN_NOT_FOUND" });
  token.status = "revoked";
  return res.json({ message: "Token révoqué" });
});

export default router;

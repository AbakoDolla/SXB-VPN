import { Router, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { prisma, inMemoryDb, logDbActivity } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";

const router = Router();

const generateTokenSchema = z.object({
  clientId: z.string(),
  quotaGb: z.coerce.number().min(1).default(50),
  durationDays: z.coerce.number().min(1).default(30),
  deviceLimit: z.coerce.number().min(1).max(10).default(1),
});

const validateTokenSchema = z.object({
  token: z.string().regex(/^SXB-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/, "Invalid SXB token format"),
});

// Helper to convert BigInt to string
function sanitizeToken(tok: any) {
  if (!tok) return null;
  return {
    ...tok,
    quota: tok.quota ? tok.quota.toString() : "0",
  };
}

// Helper to generate SXB-XXXX-XXXX-XXXX format
function makeSxbToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const part = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `SXB-${part()}-${part()}-${part()}`;
}

// POST /api/tokens/generate
router.post("/generate", requireAuth, requirePermission("tokens.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = generateTokenSchema.parse(req.body);
    const tokenStr = makeSxbToken();
    const quotaBytes = BigInt(body.quotaGb) * BigInt(1024 * 1024 * 1024);
    const expiration = new Date();
    expiration.setDate(expiration.getDate() + body.durationDays);

    let newToken: any = null;
    if (prisma) {
      newToken = await prisma.tokenSXB.create({
        data: {
          token: tokenStr,
          clientId: body.clientId,
          quota: quotaBytes,
          expiration,
          deviceLimit: body.deviceLimit,
          status: "active",
        },
      });
    } else {
      newToken = {
        id: `token-${Date.now()}`,
        token: tokenStr,
        clientId: body.clientId,
        quota: quotaBytes,
        expiration,
        deviceLimit: body.deviceLimit,
        status: "active",
        createdAt: new Date(),
      };
      inMemoryDb.tokens.push(newToken);
    }

    await logDbActivity(req.user?.userId || null, `Generated SXB Activation Token: ${tokenStr}`, "success", req.ip);
    return res.status(201).json(sanitizeToken(newToken));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    console.error("Token generation error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to generate token" });
  }
});

// GET /api/tokens/:token
router.get("/:token", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { token } = req.params;
    let tokenRecord: any = null;

    if (prisma) {
      tokenRecord = await prisma.tokenSXB.findUnique({
        where: { token },
        include: { client: true },
      });
    } else {
      const t = inMemoryDb.tokens.find((item) => item.token === token);
      if (t) {
        const client = inMemoryDb.vpnClients.find((c) => c.id === t.clientId);
        tokenRecord = { ...t, client };
      }
    }

    if (!tokenRecord) {
      return res.status(404).json({ error: "errors.tokens.not_found", message: "Token not found" });
    }

    return res.json(sanitizeToken(tokenRecord));
  } catch (err) {
    console.error("Retrieve token error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch token" });
  }
});

// POST /api/tokens/validate
router.post("/validate", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = validateTokenSchema.parse(req.body);
    let tokenRecord: any = null;

    if (prisma) {
      tokenRecord = await prisma.tokenSXB.findUnique({
        where: { token: body.token },
        include: { client: true },
      });
    } else {
      const t = inMemoryDb.tokens.find((item) => item.token === body.token);
      if (t) {
        const client = inMemoryDb.vpnClients.find((c) => c.id === t.clientId);
        tokenRecord = { ...t, client };
      }
    }

    if (!tokenRecord) {
      return res.status(404).json({ error: "errors.tokens.invalid", message: "Invalid activation token" });
    }

    if (tokenRecord.status !== "active") {
      return res.status(400).json({ error: "errors.tokens.already_used", message: `Token has already been ${tokenRecord.status}` });
    }

    const now = new Date();
    if (new Date(tokenRecord.expiration) < now) {
      // Mark as expired
      if (prisma) {
        await prisma.tokenSXB.update({ where: { id: tokenRecord.id }, data: { status: "expired" } });
      } else {
        tokenRecord.status = "expired";
      }
      return res.status(400).json({ error: "errors.tokens.expired", message: "Token has expired" });
    }

    // Set token as used and extend client bounds
    let updatedToken: any = null;
    if (prisma) {
      updatedToken = await prisma.tokenSXB.update({
        where: { id: tokenRecord.id },
        data: { status: "used" },
      });
      // Extend client quota and expiration
      await prisma.vpnClient.update({
        where: { id: tokenRecord.clientId },
        data: {
          quotaTotal: { increment: tokenRecord.quota },
          expireAt: tokenRecord.expiration,
          status: "active",
        },
      });
    } else {
      tokenRecord.status = "used";
      const index = inMemoryDb.vpnClients.findIndex((c) => c.id === tokenRecord.clientId);
      if (index !== -1) {
        inMemoryDb.vpnClients[index].quotaTotal += tokenRecord.quota;
        inMemoryDb.vpnClients[index].expireAt = tokenRecord.expiration;
        inMemoryDb.vpnClients[index].status = "active";
      }
      updatedToken = tokenRecord;
    }

    await logDbActivity(req.user?.userId || null, `Validated & applied SXB Token: ${body.token} to Client ID: ${tokenRecord.clientId}`, "success", req.ip);

    return res.json({
      success: true,
      message: "Token validated and applied successfully",
      token: sanitizeToken(updatedToken),
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: err.issues });
    }
    console.error("Token validation error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to validate token" });
  }
});

export default router;

/**
 * Support Tickets Route — /api/support
 * Gestion des tickets d'assistance technique.
 * Données 100% persistées en base PostgreSQL, aucune donnée mockée.
 */
import { Router, Response } from "express";
import { z } from "zod";
import { prisma, logDbActivity } from "../database";
import { requireAuth, AuthenticatedRequest } from "../middleware/auth";

const router = Router();

const createTicketSchema = z.object({
  title: z.string().min(3).max(200),
  clientName: z.string().min(2).max(100),
  description: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
});

const updateTicketSchema = z.object({
  status: z.enum(["open", "in_progress", "resolved", "closed"]).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  title: z.string().min(3).max(200).optional(),
  description: z.string().optional(),
});

// GET /api/support — liste tous les tickets (filtrable par status)
router.get("/", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) {
      return res.status(503).json({ error: "DB_UNAVAILABLE", message: "Base de données indisponible" });
    }
    const { status, limit = "100" } = req.query;

    const tickets = await prisma.supportTicket.findMany({
      where: status ? { status: String(status) } : undefined,
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: Math.min(Number(limit), 500),
    });

    return res.json({ tickets, total: tickets.length });
  } catch (err) {
    console.error("Fetch support tickets error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Impossible de récupérer les tickets" });
  }
});

// GET /api/support/:id — détail d'un ticket
router.get("/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) {
      return res.status(503).json({ error: "DB_UNAVAILABLE", message: "Base de données indisponible" });
    }
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: req.params.id },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    if (!ticket) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Ticket introuvable" });
    }
    return res.json(ticket);
  } catch (err) {
    console.error("Fetch ticket error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Erreur lors de la récupération" });
  }
});

// POST /api/support — ouvre un nouveau ticket
router.post("/", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) {
      return res.status(503).json({ error: "DB_UNAVAILABLE", message: "Base de données indisponible" });
    }
    const body = createTicketSchema.parse(req.body);

    const ticket = await prisma.supportTicket.create({
      data: {
        title: body.title,
        clientName: body.clientName,
        description: body.description,
        priority: body.priority,
        status: "open",
        userId: req.user?.userId || null,
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    await logDbActivity(
      req.user?.userId || null,
      `Ticket ouvert: "${body.title}" pour ${body.clientName}`,
      "info",
      req.ip
    );

    return res.status(201).json(ticket);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "VALIDATION_ERROR", message: err.issues });
    }
    console.error("Create support ticket error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Impossible de créer le ticket" });
  }
});

// PATCH /api/support/:id — mise à jour du statut ou des champs
router.patch("/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) {
      return res.status(503).json({ error: "DB_UNAVAILABLE", message: "Base de données indisponible" });
    }
    const body = updateTicketSchema.parse(req.body);

    const existing = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Ticket introuvable" });
    }

    const updated = await prisma.supportTicket.update({
      where: { id: req.params.id },
      data: {
        ...(body.status && { status: body.status }),
        ...(body.priority && { priority: body.priority }),
        ...(body.title && { title: body.title }),
        ...(body.description !== undefined && { description: body.description }),
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    await logDbActivity(
      req.user?.userId || null,
      `Ticket #${req.params.id.substring(0, 8)} mis à jour → statut: ${body.status || "inchangé"}`,
      body.status === "resolved" ? "success" : "info",
      req.ip
    );

    return res.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "VALIDATION_ERROR", message: err.issues });
    }
    console.error("Update support ticket error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Impossible de mettre à jour le ticket" });
  }
});

// DELETE /api/support/:id — suppression (ADMIN/SUPER_ADMIN seulement)
router.delete("/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) {
      return res.status(503).json({ error: "DB_UNAVAILABLE", message: "Base de données indisponible" });
    }
    const role = req.user?.role;
    if (!["ADMIN", "SUPER_ADMIN"].includes(role || "")) {
      return res.status(403).json({ error: "FORBIDDEN", message: "Accès refusé" });
    }

    await prisma.supportTicket.delete({ where: { id: req.params.id } });
    await logDbActivity(req.user?.userId || null, `Ticket #${req.params.id.substring(0, 8)} supprimé`, "warning", req.ip);
    return res.status(204).send();
  } catch (err) {
    console.error("Delete support ticket error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Impossible de supprimer le ticket" });
  }
});

export default router;

import { Router, Response } from "express";
import { z } from "zod";
import { prisma } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";

const router = Router();

const announcementSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  type: z.enum(["info", "warning", "success", "critical"]).default("info"),
  target: z.string().optional().nullable(),
  isActive: z.boolean().default(true),
  expiresAt: z.string().optional().nullable(),
});

// GET /api/announcements (Admin)
router.get("/", requireAuth, requirePermission("announcements.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const announcements = await prisma.announcement.findMany({
      orderBy: { createdAt: "desc" },
    });
    return res.json(announcements);
  } catch (err) {
    console.error("Fetch announcements error:", err);
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
});

// POST /api/announcements (Admin)
router.post("/", requireAuth, requirePermission("announcements.create"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = announcementSchema.parse(req.body);
    const announcement = await prisma.announcement.create({
      data: {
        title: body.title,
        content: body.content,
        type: body.type,
        target: body.target,
        isActive: body.isActive,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      },
    });
    return res.status(201).json(announcement);
  } catch (err) {
    console.error("Create announcement error:", err);
    return res.status(400).json({ error: "VALIDATION_ERROR" });
  }
});

// PATCH /api/announcements/:id (Admin)
router.patch("/:id", requireAuth, requirePermission("announcements.create"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const body = announcementSchema.partial().parse(req.body);
    const data: any = { ...body };
    if (body.expiresAt !== undefined) {
      data.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    }
    const announcement = await prisma.announcement.update({
      where: { id },
      data,
    });
    return res.json(announcement);
  } catch (err) {
    console.error("Update announcement error:", err);
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
});

// DELETE /api/announcements/:id (Admin)
router.delete("/:id", requireAuth, requirePermission("announcements.create"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.announcement.delete({ where: { id } });
    return res.json({ success: true });
  } catch (err) {
    console.error("Delete announcement error:", err);
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
});

export default router;

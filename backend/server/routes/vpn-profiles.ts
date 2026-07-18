import { Router, Response } from "express";
import { z } from "zod";
import { prisma } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";

const router = Router();

const profileSchema = z.object({
  name:             z.string().min(2),
  description:      z.string().optional(),
  protocol:         z.enum(["ssh", "vless", "vmess", "trojan", "shadowsocks", "singbox"]),
  host:             z.string().min(1),
  port:             z.coerce.number().min(1).max(65535),
  username:         z.string().optional(),
  password:         z.string().optional(),
  uuid:             z.string().optional(),
  path:             z.string().optional(),
  network:          z.string().default("ws"),
  tls:              z.boolean().default(false),
  sni:              z.string().optional(),
  dns:              z.string().optional(),
  payloadId:        z.string().optional(),
  offlineValidDays: z.coerce.number().default(7),
  method:           z.string().optional(),
  status:           z.enum(["active", "inactive"]).default("active"),
});

// GET /api/vpn-profiles
router.get("/", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "DB unavailable" });
    const profiles = await (prisma as any).vpnProfile.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { subscriptions: true } } },
    });
    return res.json({ profiles });
  } catch (err) {
    console.error("List vpn-profiles error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/vpn-profiles/stats/all
router.get("/stats/all", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "DB unavailable" });
    const [total, active, byProtocol] = await Promise.all([
      (prisma as any).vpnProfile.count(),
      (prisma as any).vpnProfile.count({ where: { status: "active" } }),
      (prisma as any).vpnProfile.groupBy({ by: ["protocol"], _count: true }),
    ]);
    return res.json({ total, active, byProtocol });
  } catch (err) {
    console.error("vpn-profiles stats error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/vpn-profiles/:id
router.get("/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "DB unavailable" });
    const profile = await (prisma as any).vpnProfile.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { subscriptions: true } } },
    });
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    return res.json({ profile });
  } catch (err) {
    console.error("Get vpn-profile error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /api/vpn-profiles
router.post("/", requireAuth, requirePermission("servers.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "DB unavailable" });
    const data = profileSchema.parse(req.body);
    const profile = await (prisma as any).vpnProfile.create({ data });
    return res.status(201).json({ profile });
  } catch (err: any) {
    if (err.name === "ZodError") return res.status(400).json({ error: "Validation error", details: err.errors });
    console.error("Create vpn-profile error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// PUT /api/vpn-profiles/:id
router.put("/:id", requireAuth, requirePermission("servers.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "DB unavailable" });
    const data = profileSchema.partial().parse(req.body);
    const profile = await (prisma as any).vpnProfile.update({ where: { id: req.params.id }, data });
    return res.json({ profile });
  } catch (err: any) {
    if (err.name === "ZodError") return res.status(400).json({ error: "Validation error", details: err.errors });
    console.error("Update vpn-profile error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// DELETE /api/vpn-profiles/:id
router.delete("/:id", requireAuth, requirePermission("servers.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "DB unavailable" });
    await (prisma as any).vpnProfile.delete({ where: { id: req.params.id } });
    return res.json({ success: true });
  } catch (err) {
    console.error("Delete vpn-profile error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;

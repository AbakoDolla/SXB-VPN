/**
 * Xray Manager Routes — SXB VPN
 * Standalone V2Ray/Xray account manager (VLESS, VMess, Trojan, Shadowsocks)
 * Stores configs in local DB — no X-Panel dependency required.
 */
import { Router, Response } from "express";
import { prisma } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";
import { logDbActivity } from "../database";

const router = Router();

function buildLink(acc: any): string {
  const host = encodeURIComponent(acc.host);
  const name = encodeURIComponent(acc.name);
  switch (acc.protocol) {
    case "vless": {
      const params = new URLSearchParams();
      if (acc.network) params.set("type", acc.network);
      if (acc.tls)     params.set("security", "tls");
      if (acc.sni)     params.set("sni", acc.sni);
      if (acc.path)    params.set("path", acc.path);
      return `vless://${acc.uuid}@${acc.host}:${acc.port}?${params.toString()}#${name}`;
    }
    case "vmess": {
      const obj = { v:"2", ps: acc.name, add: acc.host, port: acc.port, id: acc.uuid,
        aid: 0, net: acc.network || "ws", path: acc.path || "/",
        tls: acc.tls ? "tls" : "", sni: acc.sni || "" };
      return "vmess://" + Buffer.from(JSON.stringify(obj)).toString("base64");
    }
    case "trojan":
      return `trojan://${acc.uuid || acc.password}@${acc.host}:${acc.port}?sni=${acc.sni || acc.host}#${name}`;
    case "shadowsocks": {
      const auth = Buffer.from(`${acc.method}:${acc.password}`).toString("base64");
      return `ss://${auth}@${acc.host}:${acc.port}#${name}`;
    }
    default:
      return "";
  }
}

// GET /api/xray/accounts
router.get("/accounts", requireAuth, requirePermission("xray.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const accounts = await (prisma as any).xrayAccount.findMany({
      orderBy: { createdAt: "desc" },
      include: { client: { include: { user: { select: { name: true, email: true } } } } },
    });
    const result = accounts.map((a: any) => ({ ...a, link: buildLink(a) }));
    return res.json({ success: true, accounts: result });
  } catch (err: any) {
    console.error("xray list error:", err);
    return res.status(500).json({ error: err.message || "Failed to list xray accounts" });
  }
});

// GET /api/xray/stats
router.get("/stats", requireAuth, requirePermission("xray.view"), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const total  = await (prisma as any).xrayAccount.count();
    const active = await (prisma as any).xrayAccount.count({ where: { status: "active" } });
    const byProtocol = await (prisma as any).xrayAccount.groupBy({
      by: ["protocol"], _count: { id: true },
    });
    return res.json({ success: true, total, active, byProtocol });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to get stats" });
  }
});

// GET /api/xray/protocols
router.get("/protocols", requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  return res.json({ success: true, protocols: ["vless", "vmess", "trojan", "shadowsocks"] });
});

// POST /api/xray/accounts
router.post("/accounts", requireAuth, requirePermission("xray.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, protocol, host, port, path, tls, sni, network,
            quotaGB, expireAt, maxDevices, password, method, clientId } = req.body;
    if (!name || !protocol || !host || !port)
      return res.status(400).json({ error: "name, protocol, host, port required" });
    const acc = await (prisma as any).xrayAccount.create({
      data: {
        name, protocol, host, port: Number(port),
        path: path || null, tls: Boolean(tls), sni: sni || null,
        network: network || "ws",
        quotaTotal: quotaGB ? BigInt(Math.round(Number(quotaGB) * 1024 ** 3)) : null,
        quotaUsed: BigInt(0),
        expireAt: expireAt ? new Date(expireAt) : null,
        maxDevices: Number(maxDevices) || 1,
        password: password || null,
        method: method || null,
        clientId: clientId || null,
        status: "active",
      },
    });
    await logDbActivity(req.user!.userId, `Created Xray account: ${name}`, "success", req.ip || "");
    return res.status(201).json({ success: true, account: { ...acc, link: buildLink(acc) } });
  } catch (err: any) {
    console.error("xray create error:", err);
    return res.status(500).json({ error: err.message || "Failed to create xray account" });
  }
});

// PUT /api/xray/accounts/:id
router.put("/accounts/:id", requireAuth, requirePermission("xray.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, host, port, path, tls, sni, network, quotaGB, expireAt, maxDevices, password, method, status } = req.body;
    const data: any = {};
    if (name !== undefined) data.name = name;
    if (host !== undefined) data.host = host;
    if (port !== undefined) data.port = Number(port);
    if (path !== undefined) data.path = path;
    if (tls  !== undefined) data.tls  = Boolean(tls);
    if (sni  !== undefined) data.sni  = sni;
    if (network   !== undefined) data.network   = network;
    if (password  !== undefined) data.password  = password;
    if (method    !== undefined) data.method    = method;
    if (status    !== undefined) data.status    = status;
    if (maxDevices !== undefined) data.maxDevices = Number(maxDevices);
    if (quotaGB   !== undefined) data.quotaTotal = BigInt(Math.round(Number(quotaGB) * 1024 ** 3));
    if (expireAt  !== undefined) data.expireAt  = expireAt ? new Date(expireAt) : null;
    const acc = await (prisma as any).xrayAccount.update({ where: { id: req.params.id }, data });
    return res.json({ success: true, account: { ...acc, link: buildLink(acc) } });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to update" });
  }
});

// DELETE /api/xray/accounts/:id
router.delete("/accounts/:id", requireAuth, requirePermission("xray.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    await (prisma as any).xrayAccount.delete({ where: { id: req.params.id } });
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to delete" });
  }
});

// POST /api/xray/accounts/:id/suspend
router.post("/accounts/:id/suspend", requireAuth, requirePermission("xray.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const acc = await (prisma as any).xrayAccount.update({
      where: { id: req.params.id },
      data: { status: req.body.status || "suspended" },
    });
    return res.json({ success: true, account: acc });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to update status" });
  }
});

export default router;

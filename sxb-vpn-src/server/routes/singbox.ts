/**
 * Sing-box Manager Routes — SXB VPN
 * Supports: VLESS, VMess, Trojan, Shadowsocks, Hysteria2, TUIC
 */
import { Router, Response } from "express";
import { prisma } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";
import { logDbActivity } from "../database";

const router = Router();

function buildSingboxLink(acc: any): string {
  const name = encodeURIComponent(acc.name);
  switch (acc.protocol) {
    case "vless":
      return `vless://${acc.uuid}@${acc.host}:${acc.port}?security=${acc.tls ? "tls" : "none"}&sni=${acc.sni || acc.host}&type=${acc.network || "tcp"}&path=${encodeURIComponent(acc.path || "/")}#${name}`;
    case "vmess": {
      const obj = { v:"2", ps: acc.name, add: acc.host, port: acc.port, id: acc.uuid,
        aid: 0, net: acc.network || "ws", path: acc.path || "/",
        tls: acc.tls ? "tls" : "", sni: acc.sni || "" };
      return "vmess://" + Buffer.from(JSON.stringify(obj)).toString("base64");
    }
    case "trojan":
      return `trojan://${acc.uuid || acc.password}@${acc.host}:${acc.port}?sni=${acc.sni || acc.host}#${name}`;
    case "shadowsocks": {
      const auth = Buffer.from(`${acc.method || "aes-256-gcm"}:${acc.password}`).toString("base64");
      return `ss://${auth}@${acc.host}:${acc.port}#${name}`;
    }
    case "hysteria2":
      return `hysteria2://${acc.password || acc.uuid}@${acc.host}:${acc.port}?sni=${acc.sni || acc.host}#${name}`;
    case "tuic":
      return `tuic://${acc.uuid}:${acc.password}@${acc.host}:${acc.port}?sni=${acc.sni || acc.host}&congestion_control=bbr#${name}`;
    default:
      return "";
  }
}

// GET /api/singbox/accounts
router.get("/accounts", requireAuth, requirePermission("singbox.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const accounts = await (prisma as any).singboxAccount.findMany({
      orderBy: { createdAt: "desc" },
      include: { client: { include: { user: { select: { name: true, email: true } } } } },
    });
    const result = accounts.map((a: any) => ({ ...a, link: buildSingboxLink(a) }));
    return res.json({ success: true, accounts: result });
  } catch (err: any) {
    console.error("singbox list error:", err);
    return res.status(500).json({ error: err.message || "Failed to list singbox accounts" });
  }
});

// GET /api/singbox/stats
router.get("/stats", requireAuth, requirePermission("singbox.view"), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const total  = await (prisma as any).singboxAccount.count();
    const active = await (prisma as any).singboxAccount.count({ where: { status: "active" } });
    return res.json({ success: true, total, active });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to get stats" });
  }
});

// GET /api/singbox/protocols
router.get("/protocols", requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  return res.json({ success: true, protocols: ["vless", "vmess", "trojan", "shadowsocks", "hysteria2", "tuic"] });
});

// POST /api/singbox/accounts
router.post("/accounts", requireAuth, requirePermission("singbox.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, protocol, host, port, path, tls, sni, network,
            quotaGB, expireAt, maxDevices, password, method, clientId } = req.body;
    if (!name || !protocol || !host || !port)
      return res.status(400).json({ error: "name, protocol, host, port required" });
    const acc = await (prisma as any).singboxAccount.create({
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
    await logDbActivity(req.user!.userId, `Created Singbox account: ${name}`, "success", req.ip || "");
    return res.status(201).json({ success: true, account: { ...acc, link: buildSingboxLink(acc) } });
  } catch (err: any) {
    console.error("singbox create error:", err);
    return res.status(500).json({ error: err.message || "Failed to create singbox account" });
  }
});

// PUT /api/singbox/accounts/:id
router.put("/accounts/:id", requireAuth, requirePermission("singbox.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, host, port, path, tls, sni, network, quotaGB, expireAt, maxDevices, password, method, status } = req.body;
    const data: any = {};
    if (name      !== undefined) data.name      = name;
    if (host      !== undefined) data.host      = host;
    if (port      !== undefined) data.port      = Number(port);
    if (path      !== undefined) data.path      = path;
    if (tls       !== undefined) data.tls       = Boolean(tls);
    if (sni       !== undefined) data.sni       = sni;
    if (network   !== undefined) data.network   = network;
    if (password  !== undefined) data.password  = password;
    if (method    !== undefined) data.method    = method;
    if (status    !== undefined) data.status    = status;
    if (maxDevices !== undefined) data.maxDevices = Number(maxDevices);
    if (quotaGB   !== undefined) data.quotaTotal = BigInt(Math.round(Number(quotaGB) * 1024 ** 3));
    if (expireAt  !== undefined) data.expireAt  = expireAt ? new Date(expireAt) : null;
    const acc = await (prisma as any).singboxAccount.update({ where: { id: req.params.id }, data });
    return res.json({ success: true, account: { ...acc, link: buildSingboxLink(acc) } });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to update" });
  }
});

// DELETE /api/singbox/accounts/:id
router.delete("/accounts/:id", requireAuth, requirePermission("singbox.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    await (prisma as any).singboxAccount.delete({ where: { id: req.params.id } });
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to delete" });
  }
});

// POST /api/singbox/accounts/:id/suspend
router.post("/accounts/:id/suspend", requireAuth, requirePermission("singbox.manage"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const acc = await (prisma as any).singboxAccount.update({
      where: { id: req.params.id },
      data: { status: req.body.status || "suspended" },
    });
    return res.json({ success: true, account: acc });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to update status" });
  }
});

// GET /api/singbox/config/:id — generate sing-box JSON config for account
router.get("/config/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const acc = await (prisma as any).singboxAccount.findUnique({ where: { id: req.params.id } });
    if (!acc) return res.status(404).json({ error: "Account not found" });
    const config = {
      log: { level: "info" },
      dns: { servers: [{ address: "8.8.8.8" }, { address: "1.1.1.1" }] },
      inbounds: [{ type: "mixed", listen: "127.0.0.1", listen_port: 2080 }],
      outbounds: [{
        type: acc.protocol, tag: "proxy",
        server: acc.host, server_port: acc.port,
        ...(acc.uuid    && { uuid: acc.uuid }),
        ...(acc.password && { password: acc.password }),
        ...(acc.network  && { transport: { type: acc.network, path: acc.path || "/" } }),
        tls: { enabled: Boolean(acc.tls), server_name: acc.sni || acc.host },
      }],
    };
    return res.json({ success: true, config });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to get config" });
  }
});

export default router;

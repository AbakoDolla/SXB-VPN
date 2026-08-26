import express, { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import cors from "cors";
import helmet from "helmet";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { createServer as createViteServer } from "vite";
import { config } from "./server/config";

// Import Routers
import authRouter from "./server/routes/auth";
import usersRouter from "./server/routes/users";
import clientsRouter from "./server/routes/clients";
import tokensRouter from "./server/routes/tokens";
import resellersRouter from "./server/routes/resellers";
import vouchersRouter from "./server/routes/vouchers";
import analyticsRouter from "./server/routes/analytics";
import serversRouter from "./server/routes/servers";
import docsRouter from "./server/routes/docs";
import vpnRouter from "./server/routes/vpn";
import rbacRouter from "./server/routes/rbac";
import dashboardRouter from "./server/routes/dashboard";
import mobileRouter from "./server/routes/mobile";
import adminTokensRouter from "./server/routes/admin-tokens";
import supportRouter from "./server/routes/support";
import auditLogsRouter from "./server/routes/audit-logs";
import announcementsRouter from "./server/routes/announcements";
import appUpdatesRouter from "./server/routes/app-updates";
import devicesRouter from "./server/routes/devices";
import sshRouter from "./server/routes/ssh";
import payloadRouter from "./server/routes/payload";
import sessionsRouter from "./server/routes/sessions";
import vpnProfilesRouter from "./server/routes/vpn-profiles";
import subscriptionsRouter from "./server/routes/subscriptions";
import appRegisterRouter  from "./server/routes/app-register";
import provisionRouter from "./server/routes/provision";
import configTestRouter from "./server/routes/config-test";
import xrayRouter from "./server/routes/xray";
import singboxRouter from "./server/routes/singbox";
import xpanelRouter from "./server/routes/xpanel";
import opsRouter from "./server/routes/ops";
import xapiRouter from "./server/routes/xapi";
import { maintenanceGuard, MAINTENANCE_PAGE_HTML } from "./server/middleware/maintenance";
import { getMaintenanceMode } from "./server/services/maintenance";

async function startServer() {
  const app = express();
  app.set("trust proxy", 1);

  // Global BigInt serializer — prevents "Do not know how to serialize a BigInt"
  app.set("json replacer", (_key: string, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value
  );
  const PORT = config.PORT;

  // 1. Security & Core Middleware
  // CORS configuration - whitelist allowed origins for production
  const allowedOrigins = config.NODE_ENV === "production" 
    ? [
        "https://vpnsxb.afrihall.com",
        "https://sxbvpn.afrihall.com",
        "https://api.sxbvpn.com",
        "http://localhost:3000", // dev only
        "http://localhost:5173", // dev only
      ]
    : "*"; // Allow all in development
    
  app.use(cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "PATCH", "DELETE", "PUT", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }));

  // Configure Helmet securely, with exceptions for Swagger and scripts
  app.use(helmet({
    contentSecurityPolicy: false, // disabled for smooth swagger load & iframe preview rendering
  }));

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Request logger middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    const cleanIp = req.ip?.replace(/\\/g, '') || 'unknown';
    console.log(`[${new Date().toISOString()}] 📡 ${req.method} ${req.url} - IP: ${cleanIp}`);
    next();
  });

  // Global Rate Limiting - protect against brute force and DDoS
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200, // limit each IP to 200 requests per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "errors.rate_limit", message: "Too many requests. Please wait before retrying." },
    keyGenerator: (req: Request) => {
      // Clean up the IP address - remove any backslash escape sequences
      const ip = req.ip?.replace(/\\/g, '') || 'unknown';
      // Use ipKeyGenerator for proper IPv6 handling
      return ipKeyGenerator(ip);
    },
    skip: (req: Request) => {
      // Skip rate limiting for health checks
      return req.url === '/metrics' || req.url === '/health';
    },
  });
  app.use("/api/", limiter);
  // Health check endpoint
  app.get("/api/health", (req: Request, res: Response) => {
    res.json({ status: "ok", timestamp: new Date().toISOString(), service: "sxb-vpn-backend" });
  });

  // 2. SaaS API Endpoints Gateway Routing
  // ── Mode maintenance : après auth possible, avant les routes ──────────────
  // maintenance_mode='true' → 503 { error: 'maintenance' } sur TOUT /api/*
  // sauf /api/auth/login, /api/auth/refresh, /api/ops/*, /api/health ;
  // l'OWNER (JWT valide) traverse toujours.
  app.use("/api/", maintenanceGuard);
  app.use("/api", opsRouter); // GET/POST /api/ops/maintenance (OWNER only)
  app.use("/api/auth", authRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/clients", clientsRouter);
  app.use("/api/tokens", tokensRouter);
  app.use("/api/resellers", resellersRouter);
  app.use("/api/vouchers", vouchersRouter);
  app.use("/api/analytics", analyticsRouter);
  app.use("/api/servers", serversRouter);
  app.use("/api/docs", docsRouter);
  app.use("/api/vpn", vpnRouter);
  app.use("/api/rbac", rbacRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use("/api/mobile", mobileRouter);
  app.use("/api/admin-tokens", adminTokensRouter);
  app.use("/api/support", supportRouter);
  app.use("/api/audit-logs", auditLogsRouter);
  app.use("/api/announcements", announcementsRouter);
  app.use("/api/app-updates", appUpdatesRouter);
  app.use("/api/devices", devicesRouter);
  app.use("/api/ssh", sshRouter);
  app.use("/api/payload", payloadRouter);
  app.use("/api/sessions", sessionsRouter);
  app.use("/api/vpn-profiles", vpnProfilesRouter);
  app.use("/api/xray", xrayRouter);
  app.use("/api/singbox", singboxRouter);
  app.use("/api/xpanel", xpanelRouter);
  app.use("/api/subscriptions", subscriptionsRouter);
  app.use("/api/app",           appRegisterRouter);
  app.use("/api/provision", provisionRouter);
  app.use("/api/config-test", configTestRouter);

  // ── xapi — endpoints publics légers pour l'app mobile ─────────────────────
  // Namespace dédié /xapi (hors /api) pour :
  //   - éviter la maintenanceGuard qui bloque tout /api/* en mode maintenance
  //   - permettre au client de vérifier une nouvelle version même hors ligne
  //     partielle (endpoint sans base, sans auth, cache-friendly).
  // GET /xapi/mobile/app-version → { versionCode, versionName, apkUrl, notes? }
  app.use("/xapi", xapiRouter);

  // Global Error Handler with support for Multilingual Error i18n
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    console.error("💥 Unhandled Server Exception:", err);
    
    // Determine language from request headers (default to French)
    const lang = req.headers["accept-language"]?.startsWith("en") ? "en" : "fr";
    
    const isEnglish = lang === "en";
    const status = err.status || 500;
    
    res.status(status).json({
      error: err.code || "errors.server.internal",
      message: err.message || (isEnglish ? "Internal service malfunction occurred" : "Une erreur interne s'est produite"),
    });
  });

  // 3. Frontend Static Assets / Vite Dev Middleware Integration
  if (config.NODE_ENV !== "production") {
    console.log("🚀 Mounting Vite development middleware for real-time React preview rendering...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("📦 Mounting production static file serving (Serving compiled React frontend)...");
    const distPath = path.join(process.cwd(), "dist");
    const _uploadDir = path.join(process.cwd(), "public", "uploads", "avatars"); if (!fs.existsSync(_uploadDir)) fs.mkdirSync(_uploadDir, { recursive: true }); app.use("/uploads", express.static(path.join(process.cwd(), "public", "uploads")));
    app.use(express.static(distPath));
    app.get("*", async (req: Request, res: Response) => {
      // Page maintenance statique pour les routes non-API (sauf /login et
      // /maintenance) — l'OWNER garde l'accès au dashboard pendant la pause.
      try {
        const maintenanceOn = await getMaintenanceMode();
        const pathname = req.path || "/";
        if (maintenanceOn && pathname !== "/login" && pathname !== "/maintenance" && !pathname.startsWith("/xapi/")) {
          res.status(503).send(MAINTENANCE_PAGE_HTML);
          return;
        }
        if (pathname === "/maintenance") {
          res.status(503).send(MAINTENANCE_PAGE_HTML);
          return;
        }
      } catch (err) {
        console.error("Maintenance static page check error:", err);
      }
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // 4. Listen on Host
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`=============================================================`);
    console.log(`🛡️ SXB VPN SaaS PRO Backend online and listening on PORT ${PORT}`);
    console.log(`🌐 Local Gateway Router: http://localhost:${PORT}`);
    console.log(`📚 Interactive Swagger API Docs: http://localhost:${PORT}/api/docs`);
    console.log(`=============================================================`);
  });
}

// ── Fix 5 : Gestionnaires globaux pour éviter les crashes PM2 silencieux ────────
// Sans ces handlers, une exception non catchée tue le process → PM2 restart loop.
// On log l'erreur et on continue sauf si c'est un crash fatal (SIGKILL etc).
process.on("uncaughtException", (err: Error) => {
  console.error("💥 [UNCAUGHT_EXCEPTION] Non-fatal — keeping process alive:", err.message);
  console.error(err.stack);
  // Ne pas appeler process.exit() ici — laisser PM2 décider
});

process.on("unhandledRejection", (reason: unknown, promise: Promise<unknown>) => {
  console.error("💥 [UNHANDLED_REJECTION] Promise rejected without handler:");
  console.error("  Reason:", reason);
  // Log seulement, ne pas crasher
});

startServer().catch((err) => {
  console.error("💥 Critical Failure during backend server boot sequence:", err);
  process.exit(1);
});

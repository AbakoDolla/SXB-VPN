/**
 * Ops Routes — exploitation système (OWNER uniquement).
 *
 *   GET  /api/ops/maintenance  → état courant du mode maintenance
 *   POST /api/ops/maintenance  → bascule { enabled: boolean }
 *   GET  /api/ops/reset/preview → production reset, OWNER only
 *   POST /api/ops/reset/execute → reauthenticated, backed-up atomic reset
 *   GET  /api/ops/reset/status  → actor-bound receipt/maintenance recovery
 *
 * Chaque bascule écrit une entrée AuditLog visibleOwnerOnly=true
 * (traçabilité de sécurité : visible uniquement par le rôle OWNER).
 */
import { Router, Response, type Request, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { logDbActivity, prisma } from "../database";
import { config } from "../config";
import { requireAuth, AuthenticatedRequest } from "../middleware/auth";
import { requireOwner } from "../middleware/rbac/owner";
import { getMaintenanceMode, setMaintenanceMode, MAINTENANCE_KEY } from "../services/maintenance";
import { createResetService, createPostgresResetBackup, ResetError, type ResetService } from "../services/application-reset";
import { accessStateHub } from "../services/access-state-events";

const productionResetService = createResetService({
  db: prisma,
  jwtSecret: config.JWT_SECRET,
  backup: createPostgresResetBackup({
    databaseUrl: config.DATABASE_URL,
    backupDirectory: process.env.SXB_RESET_BACKUP_DIR,
    dumpCommand: process.env.SXB_PG_DUMP_BIN,
    restoreCommand: process.env.SXB_PG_RESTORE_BIN,
  }),
  invalidateAccess: () => accessStateHub.invalidate(),
});

function resetFailure(error: unknown, res: Response) {
  const safe = error instanceof ResetError ? error : new ResetError("RESET_FAILED");
  if (safe.status >= 500) console.error(`[reset] code=${safe.code}`);
  if (!res.destroyed && !res.headersSent) res.status(safe.status).json({
    error: safe.code, code: safe.code, ...safe.details,
  });
}

// Body-parser errors reach the application's error boundary before this
// router's handlers. Never let its raw body/message reach the generic logger.
export function resetRequestErrorHandler(error: unknown, req: Request, res: Response, next: NextFunction) {
  if (!/^\/api\/ops\/reset(?:\/|$)/i.test(req.path)) return next(error);
  res.setHeader("Cache-Control", "no-store");
  const invalidBody = typeof error === "object" && error !== null && "type" in error &&
    typeof error.type === "string" && ["entity.parse.failed", "entity.too.large", "encoding.unsupported",
      "charset.unsupported", "request.aborted", "request.size.invalid"].includes(error.type);
  return resetFailure(invalidBody ? new ResetError("RESET_INVALID_REQUEST") : error, res);
}

export function createOpsRouter({ resetService = productionResetService }: { resetService?: ResetService } = {}) {
  const router = Router();
  const resetReauthLimit = rateLimit({
    windowMs: 900_000, limit: 10, standardHeaders: true, legacyHeaders: false,
    skipSuccessfulRequests: true,
    keyGenerator: (req: AuthenticatedRequest) => `reset:${req.user!.userId}`,
    handler: (_req, res) => res.status(429).json({
      error: "RESET_RATE_LIMITED", code: "RESET_RATE_LIMITED",
      retryAfterSeconds: Number(res.getHeader("Retry-After")),
    }),
  });

  router.use("/ops/reset", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    try {
      // requireAuth has a development-memory fallback. Reset must never use it.
      resetService.assertAvailable();
      next();
    } catch (error) { resetFailure(error, res); }
  });
  router.get("/ops/reset/preview", requireAuth, requireOwner, async (req: AuthenticatedRequest, res: Response) => {
    try { res.json(await resetService.preview(req.user!.userId)); }
    catch (error) { resetFailure(error, res); }
  });
  router.get("/ops/reset/status", requireAuth, requireOwner, async (req: AuthenticatedRequest, res: Response) => {
    try { res.json(await resetService.status(req.user!.userId)); }
    catch (error) { resetFailure(error, res); }
  });
  router.post("/ops/reset/execute", requireAuth, requireOwner, resetReauthLimit, async (req: AuthenticatedRequest, res: Response) => {
    const abort = new AbortController();
    const disconnect = () => { if (!res.writableEnded) abort.abort(); };
    req.once("aborted", disconnect);
    res.once("close", disconnect);
    try {
      const receipt = await resetService.execute(req.user!.userId, req.body, { signal: abort.signal });
      if (!res.destroyed) res.json(receipt);
    } catch (error) { resetFailure(error, res); }
    finally {
      req.removeListener("aborted", disconnect);
      res.removeListener("close", disconnect);
    }
  });

  // GET /api/ops/maintenance — état courant (OWNER only)
  router.get("/ops/maintenance", requireAuth, requireOwner, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const enabled = await getMaintenanceMode();
      return res.json({ enabled, key: MAINTENANCE_KEY });
    } catch (err) {
      console.error("GET ops/maintenance error:", err);
      return res.status(500).json({ error: "SERVER_ERROR", message: "Impossible de lire l'état de maintenance" });
    }
  });

  // POST /api/ops/maintenance — bascule pause/play du dashboard (OWNER only)
  router.post("/ops/maintenance", requireAuth, requireOwner, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const enabled = req.body?.enabled;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "INVALID_BODY", message: "enabled (boolean) est requis" });
      }

      await setMaintenanceMode(enabled);

      await logDbActivity(
        req.user?.userId || null,
        `Mode maintenance ${enabled ? "ACTIVÉ" : "DÉSACTIVÉ"} par le propriétaire`,
        enabled ? "warning" : "success",
        req.ip,
        { visibleOwnerOnly: true }
      );

      return res.json({
        enabled,
        key: MAINTENANCE_KEY,
        message: enabled ? "Mode maintenance activé" : "Mode maintenance désactivé",
      });
    } catch (err) {
      if (err instanceof ResetError) return resetFailure(err, res);
      console.error("POST ops/maintenance error:", err);
      return res.status(500).json({ error: "SERVER_ERROR", message: "Impossible de basculer le mode maintenance" });
    }
  });

  return router;
}

export default createOpsRouter();

/**
 * Maintenance guard — middleware global appliqué à /api/*.
 *
 * Si maintenance_mode='true' :
 *   - /api/auth/login   → TOUJOURS accessible (l'OWNER doit pouvoir se connecter)
 *   - /api/auth/refresh → accessible (rotation de token de l'OWNER)
 *   - /api/health       → accessible (sondes de déploiement)
 *   - requêtes porteuses d'un JWT valide du rôle OWNER → accès total
 *     (y compris /api/ops/* : l'OWNER peut lire et basculer le mode)
 *   - TOUT le reste     → HTTP 503 { error: 'maintenance' }
 *
 * Note : /api/ops/* n'est PAS exempté globalement — un non-OWNER reçoit
 * le même 503 générique que les autres routes (aucune fuite d'information
 * sur l'existence des routes d'exploitation). Quand la maintenance est
 * INACTIVE, la sécurité des routes ops/* est assurée par requireOwner.
 */
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { getMaintenanceMode } from "../services/maintenance";
import { OWNER_ROLE } from "./rbac/owner";

const MAINTENANCE_PATHS_OK = ["/auth/login", "/auth/refresh", "/health"];

export function isMaintenancePathExempt(path: string): boolean {
  return MAINTENANCE_PATHS_OK.some((p) => path.startsWith(p));
}

export async function maintenanceGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const enabled = await getMaintenanceMode();
    if (!enabled) {
      next();
      return;
    }

    const path = req.path || "/";
    if (isMaintenancePathExempt(path)) {
      next();
      return;
    }

    // Bypass OWNER : un JWT valide du rôle OWNER traverse le mode maintenance.
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const decoded = jwt.verify(authHeader.split(" ")[1], config.JWT_SECRET) as { role?: string };
        if (decoded?.role === OWNER_ROLE) {
          next();
          return;
        }
      } catch {
        // token invalide/expiré → traitement normal (503 ou 401 selon la route)
      }
    }

    res.status(503).json({
      error: "maintenance",
      message: "Maintenance en cours, réessayez plus tard",
    });
  } catch (err) {
    console.error("Maintenance guard error:", err);
    next();
  }
}

/** Page statique publique affichée pour les routes non-API pendant la maintenance. */
export const MAINTENANCE_PAGE_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SXB VPN — Maintenance</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #07090e; color: #e2e8f0; font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
      padding: 24px; text-align: center;
    }
    .card { max-width: 440px; padding: 40px 32px; border: 1px solid #1a1f2e; border-radius: 16px; background: #0a0d14; }
    .badge {
      display: inline-block; padding: 4px 12px; border-radius: 999px;
      background: #f59e0b1a; color: #fbbf24; border: 1px solid #f59e0b33;
      font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 18px;
    }
    h1 { font-size: 20px; margin-bottom: 10px; color: #fff; }
    p { font-size: 13px; color: #94a3b8; line-height: 1.6; }
    .spinner {
      width: 36px; height: 36px; margin: 0 auto 20px; border-radius: 50%;
      border: 3px solid #1e293b; border-top-color: #22d3ee; animation: spin 1s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <span class="badge">Mode maintenance actif</span>
    <h1>Maintenance en cours</h1>
    <p>Notre plateforme est momentanément indisponible.<br/>Merci de réessayer dans quelques instants.</p>
  </div>
</body>
</html>`;

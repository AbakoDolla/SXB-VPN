import { Router, Response } from "express";
import { config } from "../config";
import {
  AuthenticatedRequest,
  requireAuth,
  requireRole,
} from "../middleware/auth";
import {
  getMobileHealthSummary,
  mobileHealthReportSchema,
  storeMobileHealthReport,
} from "../services/mobile-health";

const router = Router();

function readDeviceId(req: AuthenticatedRequest): string | null {
  const raw = req.headers["x-sxb-device-id"];
  if (typeof raw !== "string") return null;
  const normalized = raw.trim();
  return /^SXB[A-Z0-9]{6,80}$/.test(normalized) ? normalized : null;
}

router.post("/report", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  if (req.user?.role !== "CLIENT") {
    return res.status(403).json({ error: "MOBILE_CLIENT_ONLY", message: "Mobile client session required" });
  }
  const deviceId = readDeviceId(req);
  if (!deviceId || !req.user?.userId) {
    return res.status(422).json({ error: "DEVICE_ID_REQUIRED", message: "A valid activated device identifier is required" });
  }
  const parsed = mobileHealthReportSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({
      error: "INVALID_MOBILE_HEALTH_REPORT",
      message: parsed.error.issues[0]?.message || "Invalid mobile health report",
    });
  }

  try {
    const pseudonymSecret = config.MOBILE_HEALTH_PSEUDONYM_SECRET
      || (config.NODE_ENV !== "production" ? config.JWT_SECRET : null);
    if (!pseudonymSecret) {
      return res.status(503).json({
        error: "MOBILE_HEALTH_NOT_CONFIGURED",
        message: "Mobile health pseudonymization is not configured",
      });
    }
    const result = await storeMobileHealthReport(
      req.user.userId,
      deviceId,
      pseudonymSecret,
      parsed.data,
    );
    if (result === "device_not_activated") {
      return res.status(403).json({ error: "DEVICE_NOT_ACTIVATED", message: "Device is not activated for this account" });
    }
    if (result === "db_unavailable") {
      return res.status(503).json({ error: "DB_UNAVAILABLE", message: "Mobile health storage is unavailable" });
    }
    return res.status(202).json({ accepted: true });
  } catch (error: any) {
    console.error("[mobile-health] report storage failed:", error?.message || error);
    return res.status(503).json({ error: "DB_UNAVAILABLE", message: "Mobile health report could not be stored" });
  }
});

// LECTURE RÉSERVÉE AU SOMMET. Le résumé agrège le parc Android ENTIER : les
// lignes de `MobileHealthDevice` sont indexées par un pseudonyme dérivé
// (`pseudonymizeMobileDevice(userId, deviceId, secret)`) qui, par construction,
// ne porte AUCUN propriétaire. Il n'existe donc aucun moyen de restreindre ce
// résumé au périmètre d'un admin sans rattacher une identité au pseudonyme,
// c'est-à-dire sans défaire la pseudonymisation qui protège les clients.
//
// Mesuré à l'écran le 20/09/2026 sur un admin de recette ne possédant qu'UN
// appareil : la page affichait les 9 appareils de la plateforme, « 713 rapports
// retenus », les modèles (TECNO KI5k, moto g24, SM-A175F…), les versions
// Android et le taux d'échec global — de quoi déduire la taille d'activité des
// autres exploitants. L'observabilité du parc rejoint donc « Sécurité » : hors
// du périmètre admin, réservée au sommet. OWNER traverse par le contournement
// central de `requireRole`.
router.get(
  "/summary",
  requireAuth,
  requireRole(["SUPER_ADMIN"]),
  async (_req: AuthenticatedRequest, res: Response) => {
    try {
      const summary = await getMobileHealthSummary();
      if (!summary) {
        return res.status(503).json({ error: "DB_UNAVAILABLE", message: "Mobile health storage is unavailable" });
      }
      return res.json(summary);
    } catch (error: any) {
      console.error("[mobile-health] summary failed:", error?.message || error);
      return res.status(503).json({ error: "DB_UNAVAILABLE", message: "Mobile health summary is unavailable" });
    }
  },
);

export default router;

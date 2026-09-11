/**
 * Présence VPN — /api/presence
 *
 * Répond à une seule question, honnêtement : QUI utilise le VPN en ce moment ?
 *
 * CE QUE CES ROUTES MESURENT : le dernier signal de santé émis par
 * l'application déclare le tunnel monté, et ce signal date de moins de
 * `presenceWindowMinutes`. Rien d'autre. La plateforme n'observe ni le trafic,
 * ni les destinations, ni le contenu de ce que fait l'utilisateur.
 *
 * CE QU'ELLES NE MESURENT PAS : une déconnexion. Un appareil qui se tait peut
 * avoir coupé le VPN comme avoir perdu le réseau ou vu son application tuée
 * par le système. Les réponses ne portent donc jamais d'état « déconnecté » ;
 * elles portent `lastSeenAt`, que l'interface rend en « dernière activité il
 * y a X ».
 *
 * CLOISONNEMENT
 *   • RESELLER : ne voit QUE ses propres clients connectés, et reçoit 403 sur
 *     la vue globale des revendeurs. Le filtre est appliqué sur l'index des
 *     identités, donc AVANT tout rapprochement.
 *   • SUPPORT : lecture seule — ces routes le sont toutes.
 *   • Hors OWNER : les comptes OWNER restent invisibles (furtivité).
 */
import { Router, Response } from "express";
import { config } from "../config";
import { prisma } from "../database";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";
import { isOwnerRequest } from "../middleware/rbac/owner";
import { chargerFicheRevendeur, porteeClientsRevendeur } from "../services/reseller-access";
import {
  listerConnectes,
  listerRevendeursConnectes,
  normaliserPagination,
  PRESENCE_HEARTBEAT_MINUTES,
  PRESENCE_WINDOW_MINUTES,
  type OptionsPresence,
} from "../services/vpn-presence";

const router = Router();

/**
 * Secret de pseudonymisation — strictement le même que celui de l'ingestion,
 * sans quoi aucun rapprochement ne pourrait aboutir. En production il doit
 * être explicitement configuré ; en développement on retombe sur le secret JWT
 * comme le fait déjà la route d'ingestion.
 */
function secretPseudonyme(): string | null {
  return config.MOBILE_HEALTH_PSEUDONYM_SECRET
    || (config.NODE_ENV !== "production" ? config.JWT_SECRET : null);
}

/** Portée de lecture du demandeur : parc propre pour un revendeur, sinon tout. */
async function porteeDemandeur(req: AuthenticatedRequest): Promise<OptionsPresence> {
  const isReseller = req.user?.role === "RESELLER";
  const fiche = isReseller ? await chargerFicheRevendeur(prisma, req.user?.userId) : null;
  return {
    porteeClients: isReseller ? (porteeClientsRevendeur(fiche) as Record<string, unknown>) : null,
    masquerProprietaire: !isOwnerRequest(req),
  };
}

/** Réponse commune quand la présence ne peut pas être mesurée. */
function nonMesurable(res: Response, raison: "db_unavailable" | "not_configured") {
  // On ne renvoie pas zéro : zéro voudrait dire « personne n'est connecté »,
  // alors que la vérité est « la plateforme n'a rien pu mesurer ».
  return res.status(503).json({
    error: raison === "db_unavailable" ? "DB_UNAVAILABLE" : "PRESENCE_NOT_CONFIGURED",
    message: raison === "db_unavailable"
      ? "La mesure de présence nécessite la base de données."
      : "La pseudonymisation de la santé mobile n'est pas configurée : la présence ne peut pas être rapprochée.",
    measured: false,
    presenceWindowMinutes: PRESENCE_WINDOW_MINUTES,
    heartbeatMinutes: PRESENCE_HEARTBEAT_MINUTES,
  });
}

/**
 * GET /api/presence/connected — utilisateurs actuellement connectés.
 *
 * Réponse :
 *   { generatedAt, presenceWindowMinutes, heartbeatMinutes, measured: true,
 *     scope: "own" | "platform", total, limit, offset, truncated, unmatched,
 *     users: [{ clientId, clientName, deviceId, resellerId, resellerName,
 *               directClient, protocol, appVersion, deviceModel,
 *               lastSeenAt, lastSeenSecondsAgo,
 *               connectedSinceAt, connectedSinceMeasured }] }
 *
 * `total` est le nombre de lignes rapprochées AVANT pagination ; `users` en est
 * une tranche. Les deux sortent du même calcul.
 */
router.get("/connected", requireAuth, requirePermission("analytics.read"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return nonMesurable(res, "db_unavailable");
    const secret = secretPseudonyme();
    if (!secret) return nonMesurable(res, "not_configured");

    const { limit, offset } = normaliserPagination(req.query.limit, req.query.offset);
    const portee = await porteeDemandeur(req);
    const presence = await listerConnectes(prisma as any, secret, portee);

    return res.json({
      generatedAt: presence.generatedAt,
      presenceWindowMinutes: presence.presenceWindowMinutes,
      heartbeatMinutes: presence.heartbeatMinutes,
      measured: true,
      scope: req.user?.role === "RESELLER" ? "own" : "platform",
      total: presence.lignes.length,
      limit,
      offset,
      truncated: presence.devicesTruncated,
      // Appareils présents qu'aucune identité visible n'explique. Exposé pour
      // l'honnêteté du chiffre, jamais additionné au total listé.
      unmatched: presence.orphelins,
      users: presence.lignes.slice(offset, offset + limit),
    });
  } catch (error: any) {
    console.error("[presence] connected users failed:", error?.message || error);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch connected users" });
  }
});

/**
 * GET /api/presence/resellers — revendeurs enregistrés et leurs connectés.
 *
 * Réponse :
 *   { generatedAt, presenceWindowMinutes, heartbeatMinutes, measured: true,
 *     totalConnected, unmatched, truncated,
 *     resellers: [{ resellerId, resellerName, status, connectedNow,
 *                   totalClients, activeClients, users: [...] }],
 *     direct: { connectedNow, users: [...] } }
 *
 * INTERDITE AUX REVENDEURS : elle nomme les autres revendeurs et donne leurs
 * chiffres. Un revendeur passe par /connected, qui ne lui rend que son parc.
 */
router.get("/resellers", requireAuth, requirePermission("analytics.read"), async (req: AuthenticatedRequest, res: Response) => {
  if (req.user?.role === "RESELLER") {
    return res.status(403).json({
      error: "errors.auth.forbidden",
      code: "PRESENCE_RESELLER_SCOPE",
      message: "Un revendeur ne consulte que ses propres clients connectés.",
    });
  }
  try {
    if (!prisma) return nonMesurable(res, "db_unavailable");
    const secret = secretPseudonyme();
    if (!secret) return nonMesurable(res, "not_configured");

    const vue = await listerRevendeursConnectes(prisma as any, secret, {
      masquerProprietaire: !isOwnerRequest(req),
    });

    return res.json({
      generatedAt: vue.generatedAt,
      presenceWindowMinutes: vue.presenceWindowMinutes,
      heartbeatMinutes: vue.heartbeatMinutes,
      measured: true,
      totalConnected: vue.totalConnected,
      unmatched: vue.unmatched,
      truncated: vue.devicesTruncated,
      resellers: vue.resellers,
      direct: vue.direct,
    });
  } catch (error: any) {
    console.error("[presence] reseller presence failed:", error?.message || error);
    return res.status(500).json({ error: "errors.server", message: "Failed to fetch reseller presence" });
  }
});

export default router;

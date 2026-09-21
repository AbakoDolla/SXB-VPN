import { Router, Response, NextFunction } from "express";
import { XPanelService } from "../services/xpanel";
import { requireAuth, requirePermission, AuthenticatedRequest } from "../middleware/auth";
import { logDbActivity, inMemoryDb, prisma } from "../database";
import { porteeClients, porteeServeurs, estCloisonne } from "../services/portee-donnees";
import { etFiltres } from "../services/free-trial-marks";

const router = Router();

// ── Infrastructure partagée : hors du périmètre d'un compte cloisonné ───────
//
// Mesuré en production avec un ADMIN neuf : `GET /users`, `GET /configs`,
// `POST /configs`, `POST /sync` et `DELETE /configs/:id` répondaient tous 200.
// L'habilitation ne le bloquait pas, car le rôle ADMIN porte `xpanel.manage`.
//
// Ces routes ne lisent ni n'écrivent des données de locataire : elles parlent
// au panneau distant (`/api/subscribers`, `/api/inbounds`), dont les objets
// n'ont aucun propriétaire. On ne peut donc pas les filtrer par compartiment —
// il n'y a rien sur quoi filtrer. Un admin y lirait le parc complet de la
// plateforme et pourrait supprimer l'entrée d'un autre exploitant.
//
// C'est un paramètre global, exclu du périmètre admin par contrat. D'où un
// refus franc plutôt qu'un 404 indifférencié : il n'y a ici aucun identifiant
// à énumérer, seulement une capacité qui n'appartient pas à ce rôle.
function refuserCloisonne(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (estCloisonne(req.user?.role)) {
    return res.status(403).json({
      error: "errors.auth.forbidden_permission",
      message: "XPanel engine administration is reserved for platform operators",
    });
  }
  return next();
}

// GET /api/xpanel/status
router.get("/status", requireAuth, requirePermission("xpanel.view"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const start = Date.now();
    let isConnected = false;
    
    try {
      const connResult = await XPanelService.testConnection();
      isConnected = connResult.success;
    } catch {
      isConnected = false;
    }

    const latency = Date.now() - start;
    let clientCount = 0;
    let configCount = 0;

    if (prisma) {
      // ── Un écran « moteur » reste un écran de données ──────────────────────
      //
      // Mesuré en production : un administrateur sans aucun client ni serveur
      // lisait ici « 753 utilisateurs synchronisés, 3 serveurs, 6 configs » —
      // les chiffres exacts du propriétaire. L'habillage technique de la page
      // avait fait oublier que ces compteurs portent sur le parc réel.
      const porteeClientsRequerant = await porteeClients(prisma, req.user);
      const porteeServeursRequerant = await porteeServeurs(prisma, req.user);
      clientCount = await prisma.vpnClient.count({
        where: etFiltres({ status: "active" }, porteeClientsRequerant) as any,
      });
      configCount = await prisma.vPSServer.count({
        where: (porteeServeursRequerant ?? undefined) as any,
      });
    } else {
      clientCount = inMemoryDb.vpnClients.filter((c) => c.status === "active").length;
      configCount = inMemoryDb.vpsServers.length;
    }

    return res.json({
      status: isConnected ? "online" : "offline",
      connectedServers: configCount,
      synchronizedUsers: clientCount,
      availableConfigs: configCount * 2,
      isSyncing: false,
    });
  } catch (err) {
    console.error("XPanel status retrieval error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to probe XPanel Engine" });
  }
});

// POST /api/xpanel/sync
router.post("/sync", requireAuth, requirePermission("xpanel.manage"), refuserCloisonne, async (req: AuthenticatedRequest, res: Response) => {
  try {
    console.log("Triggering manual XPanel database sync...");
    const result = await XPanelService.sync();
    await logDbActivity(req.user?.userId || null, `Manual database-XPanel synchronization completed (${result.synchronizedCount} accounts updated)`, "success", req.ip);
    return res.json({
      success: true,
      message: "Synchronization completed successfully",
      ...result,
    });
  } catch (err) {
    console.error("XPanel sync action error:", err);
    return res.status(500).json({ error: "errors.server", message: "Synchronization failed" });
  }
});

// GET /api/xpanel/users
router.get("/users", requireAuth, requirePermission("xpanel.view"), refuserCloisonne, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const xpanelUsers = await XPanelService.getUsers();
    return res.json({ users: xpanelUsers });
  } catch (err) {
    console.error("XPanel getUsers error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to query XPanel users" });
  }
});

// GET /api/xpanel/configs
router.get("/configs", requireAuth, requirePermission("xpanel.view"), refuserCloisonne, async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Return VPN configurations stored locally (inbound configs)
    const configs = await XPanelService.getConfigs();
    return res.json({ configs });
  } catch (err) {
    console.error("XPanel getConfigs error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to query XPanel configs" });
  }
});

// POST /api/xpanel/configs - Create new config on XPanel
router.post("/configs", requireAuth, requirePermission("xpanel.manage"), refuserCloisonne, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, protocol, port, settings } = req.body;
    const config = await XPanelService.createConfig(name, protocol, port, settings);
    await logDbActivity(req.user?.userId || null, `Created XPanel config: ${name}`, "success", req.ip);
    return res.json(config);
  } catch (err) {
    console.error("XPanel createConfig error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to create XPanel config" });
  }
});

// DELETE /api/xpanel/configs/:id
router.delete("/configs/:id", requireAuth, requirePermission("xpanel.manage"), refuserCloisonne, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    await XPanelService.deleteConfig(id);
    await logDbActivity(req.user?.userId || null, `Deleted XPanel config: ${id}`, "danger", req.ip);
    return res.json({ success: true });
  } catch (err) {
    console.error("XPanel deleteConfig error:", err);
    return res.status(500).json({ error: "errors.server", message: "Failed to delete XPanel config" });
  }
});

export default router;

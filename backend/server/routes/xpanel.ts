/**
 * XPanel Router — SXB VPN
 * Proxy/management layer for external XPanel VPN engine.
 * Toutes les opérations sont optionnelles : si XPANEL_URL n'est pas défini,
 * les endpoints renvoient un état "non configuré" sans planter.
 */
import { Router, Response } from 'express';
import { requireAuth, requirePermission, AuthenticatedRequest } from '../middleware/auth';
import { XPanelService } from '../services/xpanel';

const router = Router();

// ─── GET /api/xpanel/status ───────────────────────────────────────────────────
router.get('/status', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await XPanelService.testConnection();
    return res.json({ success: true, ...result });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err?.message || 'XPanel unreachable' });
  }
});

// ─── GET /api/xpanel/users ───────────────────────────────────────────────────
router.get('/users', requireAuth, requirePermission('clients.view'), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const users = await XPanelService.getUsers();
    return res.json({ success: true, users });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to list XPanel users', message: err?.message });
  }
});

// ─── GET /api/xpanel/configs ─────────────────────────────────────────────────
router.get('/configs', requireAuth, requirePermission('clients.view'), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const configs = await XPanelService.getConfigs();
    return res.json({ success: true, configs });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to list XPanel configs', message: err?.message });
  }
});

// ─── POST /api/xpanel/configs ────────────────────────────────────────────────
router.post('/configs', requireAuth, requirePermission('clients.create'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const config = await XPanelService.createConfig(req.body);
    return res.status(201).json({ success: true, config });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to create XPanel config', message: err?.message });
  }
});

// ─── DELETE /api/xpanel/configs/:id ─────────────────────────────────────────
router.delete('/configs/:id', requireAuth, requirePermission('clients.delete'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    await XPanelService.deleteConfig(req.params.id);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to delete XPanel config', message: err?.message });
  }
});

// ─── POST /api/xpanel/sync ───────────────────────────────────────────────────
router.post('/sync', requireAuth, requirePermission('clients.create'), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await XPanelService.sync();
    return res.json({ success: true, ...result });
  } catch (err: any) {
    return res.status(500).json({ error: 'XPanel sync failed', message: err?.message });
  }
});

export default router;

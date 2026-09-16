/**
 * /api/security — le Centre de sécurité.
 *
 * DEUX BARRIÈRES, DANS CET ORDRE
 * ──────────────────────────────
 *  1. LE RÔLE. `OWNER` et `SUPER_ADMIN` uniquement. Vérifié en premier, et sans
 *     consulter le RBAC configurable : une permission mal cochée ne doit pas
 *     ouvrir la console qui décrit les défenses.
 *  2. LE VERROU. Mot de passe défini par le propriétaire, puis clé d'accès
 *     (empreinte) dès qu'une est enrôlée. La preuve voyage par en-tête, expire
 *     en dix minutes, et meurt à chaque rotation du mot de passe.
 *
 * CE QUI N'EST PAS TOUCHÉ
 * ───────────────────────
 * Aucune route existante n'est modifiée. L'application mobile n'appelle rien
 * ici. Une base qui n'a pas appliqué la migration répond « non configuré » au
 * lieu de tomber : le reste du tableau de bord continue de fonctionner.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { logDbActivity, prisma } from '../database';
import { AuthenticatedRequest, requireAuth } from '../middleware/auth';
import { isOwnerRequest } from '../middleware/rbac/owner';
import {
  SECURITY_UNLOCK_SECONDS,
  SecurityGateError,
  handleSecurityGateError,
  hasSecurityCenterRole,
  issueSecurityUnlock,
  readSecurityGate,
  readSecurityUnlock,
  securityUnlockLimiters,
  verifyGatePassword,
  writeSecurityGate,
} from '../services/security-gate';
import {
  deletePasskey,
  hashIp,
  credentialIdsFor,
  issueChallenge,
  listPasskeys,
  registerPasskey,
  relyingPartyId,
  verifyPasskeyAssertion,
} from '../services/security-passkey';
import {
  SECURITY_EVENT_TYPES,
  SECURITY_SEVERITIES,
  acknowledgeSecurityEvents,
  listSecurityEvents,
  recordSecurityEvent,
  securityOverview,
} from '../services/security-events';

const router = Router();

/** Barrière 1 — le rôle. Posée sur TOUT le routeur, avant toute autre chose. */
router.use(requireAuth, (req: AuthenticatedRequest, res: Response, next) => {
  if (!hasSecurityCenterRole(req)) {
    // 404 et non 403 : l'existence même de cette console n'a pas à être
    // confirmée à un compte qui n'y a pas droit.
    return res.status(404).json({ error: 'errors.notFound', code: 'NOT_FOUND' });
  }
  return next();
});

/** Barrière 2 — le verrou. Posée sur les routes qui exposent des données. */
async function exigerOuverture(req: AuthenticatedRequest, res: Response, next: () => void) {
  try {
    const gate = await readSecurityGate();
    if (!gate) {
      return res.status(423).json({ error: 'SECURITY_GATE_UNCONFIGURED', code: 'SECURITY_GATE_UNCONFIGURED' });
    }
    const ouverture = readSecurityUnlock(req, gate);
    if (!ouverture) {
      return res.status(423).json({ error: 'SECURITY_GATE_LOCKED', code: 'SECURITY_GATE_LOCKED' });
    }
    // Une console ouverte sans clé d'accès alors qu'une est enrôlée ne vaut
    // pas ouverture : la preuve porte cette distinction, on la relit.
    const cles = await listPasskeys(req.user!.userId);
    if (cles.length > 0 && !ouverture.passkeyVerified) {
      return res.status(423).json({ error: 'SECURITY_PASSKEY_REQUIRED', code: 'SECURITY_PASSKEY_REQUIRED' });
    }
    (req as any).securityUnlock = ouverture;
    return next();
  } catch (error) {
    if (handleSecurityGateError(error, res)) return;
    return res.status(503).json({ error: 'DB_UNAVAILABLE', code: 'DB_UNAVAILABLE' });
  }
}

// ── État du verrou ───────────────────────────────────────────────────────────

router.get('/gate', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const gate = await readSecurityGate();
    const ouverture = gate ? readSecurityUnlock(req, gate) : null;
    const passkeys = await listPasskeys(req.user!.userId);
    return res.json({
      configured: !!gate,
      // Seul le propriétaire définit le mot de passe ; le super-administrateur
      // s'en sert sans pouvoir le changer.
      canConfigure: isOwnerRequest(req),
      unlocked: !!ouverture && (passkeys.length === 0 || ouverture.passkeyVerified),
      unlockExpiresAt: ouverture ? new Date(ouverture.expiresAt).toISOString() : null,
      passkeyVerified: ouverture?.passkeyVerified ?? false,
      passkeyRequired: passkeys.length > 0,
      passkeys,
      rpId: relyingPartyId(),
      unlockSeconds: SECURITY_UNLOCK_SECONDS,
      updatedAt: gate?.updatedAt ?? null,
    });
  } catch (error) {
    if (handleSecurityGateError(error, res)) return;
    return res.status(503).json({ error: 'DB_UNAVAILABLE', code: 'DB_UNAVAILABLE' });
  }
});

const passwordSchema = z.object({
  currentPassword: z.string().max(200).optional(),
  newPassword: z.string().max(200),
});

/** Définition et rotation du mot de passe — PROPRIÉTAIRE uniquement. */
router.post('/gate/password', ...securityUnlockLimiters, async (req: AuthenticatedRequest, res: Response) => {
  if (!isOwnerRequest(req)) {
    return res.status(403).json({ error: 'errors.auth.forbidden', code: 'OWNER_ONLY' });
  }
  try {
    const corps = passwordSchema.parse(req.body);
    const existant = await readSecurityGate();
    // Une rotation exige le mot de passe courant : sans cela, une session
    // laissée ouverte suffirait à s'approprier le verrou.
    if (existant) await verifyGatePassword(corps.currentPassword);
    const gate = await writeSecurityGate(corps.newPassword, req.user!.userId);
    await logDbActivity(
      req.user!.userId,
      existant ? 'Mot de passe du Centre de sécurité renouvelé' : 'Mot de passe du Centre de sécurité défini',
      'warning',
      req.ip || '',
    );
    await recordSecurityEvent({
      eventType: 'SECURITY_GATE_PASSWORD_ROTATED',
      severity: 'warning',
      userId: req.user!.userId,
      ipHash: hashIp(req.ip),
      // Code stable, traduit par le tableau de bord : une phrase figée ici
      // s'afficherait en français à un opérateur anglophone.
      actionTaken: 'SESSIONS_CLOSED',
      metadata: { role: req.user!.role },
    });
    return res.status(201).json({ configured: true, updatedAt: gate.updatedAt });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'SECURITY_GATE_PASSWORD_INVALID', code: 'SECURITY_GATE_PASSWORD_INVALID' });
    }
    if (handleSecurityGateError(error, res)) return;
    return res.status(503).json({ error: 'DB_UNAVAILABLE', code: 'DB_UNAVAILABLE' });
  }
});

/** Étape 1 — le mot de passe. Rend un défi quand une clé d'accès est enrôlée. */
router.post('/gate/unlock', ...securityUnlockLimiters, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const gate = await verifyGatePassword(req.body?.password).catch(async (error) => {
      await recordSecurityEvent({
        eventType: 'SECURITY_GATE_REJECTED',
        severity: 'warning',
        userId: req.user!.userId,
        ipHash: hashIp(req.ip),
        metadata: { role: req.user!.role, reason: 'password' },
      });
      throw error;
    });
    const passkeys = await listPasskeys(req.user!.userId);
    if (passkeys.length > 0) {
      // Le mot de passe seul n'ouvre RIEN : aucune preuve n'est émise ici.
      //
      // Le défi porte les identifiants des empreintes enrôlées. Sans eux, un
      // capteur de plateforme qui a créé une clé non découvrable — Windows
      // Hello, plusieurs capteurs Android — ne retrouve rien, et le
      // propriétaire reste enfermé dehors sans aucun recours.
      return res.json({
        step: 'passkey',
        ...issueChallenge(req.user!.userId, 'authenticate'),
        allowCredentials: await credentialIdsFor(req.user!.userId),
      });
    }
    const ouverture = issueSecurityUnlock(gate, req.user!.userId, false);
    await recordSecurityEvent({
      eventType: 'SECURITY_GATE_OPENED',
      severity: 'info',
      userId: req.user!.userId,
      ipHash: hashIp(req.ip),
      metadata: { role: req.user!.role, reason: 'password' },
    });
    return res.json({ step: 'unlocked', ...ouverture });
  } catch (error) {
    if (handleSecurityGateError(error, res)) return;
    return res.status(503).json({ error: 'DB_UNAVAILABLE', code: 'DB_UNAVAILABLE' });
  }
});

/** Étape 2 — l'empreinte. Seule cette route émet une preuve complète. */
router.post('/gate/unlock/passkey', ...securityUnlockLimiters, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const gate = await readSecurityGate();
    if (!gate) throw new SecurityGateError(423, 'SECURITY_GATE_UNCONFIGURED');
    await verifyPasskeyAssertion(req.user!.userId, req.body).catch(async (error) => {
      await recordSecurityEvent({
        eventType: 'SECURITY_PASSKEY_REJECTED',
        severity: 'critical',
        userId: req.user!.userId,
        ipHash: hashIp(req.ip),
        metadata: { role: req.user!.role },
      });
      throw error;
    });
    const ouverture = issueSecurityUnlock(gate, req.user!.userId, true);
    await recordSecurityEvent({
      eventType: 'SECURITY_GATE_OPENED',
      severity: 'info',
      userId: req.user!.userId,
      ipHash: hashIp(req.ip),
      metadata: { role: req.user!.role, reason: 'passkey' },
    });
    return res.json({ step: 'unlocked', ...ouverture });
  } catch (error) {
    if (handleSecurityGateError(error, res)) return;
    return res.status(503).json({ error: 'DB_UNAVAILABLE', code: 'DB_UNAVAILABLE' });
  }
});

// ── Clés d'accès ─────────────────────────────────────────────────────────────

/** Défi d'enrôlement. Exige une console DÉJÀ ouverte. */
router.post('/passkeys/challenge', exigerOuverture, (req: AuthenticatedRequest, res: Response) => {
  return res.json(issueChallenge(req.user!.userId, 'register'));
});

router.post('/passkeys', exigerOuverture, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const passkey = await registerPasskey(req.user!.userId, req.body);
    await logDbActivity(req.user!.userId, 'Clé d’accès enrôlée pour le Centre de sécurité', 'warning', req.ip || '');
    await recordSecurityEvent({
      eventType: 'SECURITY_PASSKEY_ENROLLED',
      severity: 'warning',
      userId: req.user!.userId,
      ipHash: hashIp(req.ip),
      metadata: { role: req.user!.role, label: passkey.label || undefined },
    });
    return res.status(201).json({ passkey });
  } catch (error) {
    if (handleSecurityGateError(error, res)) return;
    return res.status(503).json({ error: 'DB_UNAVAILABLE', code: 'DB_UNAVAILABLE' });
  }
});

router.delete('/passkeys/:id', exigerOuverture, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supprimee = await deletePasskey(req.user!.userId, req.params.id);
    if (!supprimee) return res.status(404).json({ error: 'errors.notFound', code: 'NOT_FOUND' });
    await logDbActivity(req.user!.userId, 'Clé d’accès retirée du Centre de sécurité', 'warning', req.ip || '');
    await recordSecurityEvent({
      eventType: 'SECURITY_PASSKEY_REMOVED',
      severity: 'warning',
      userId: req.user!.userId,
      ipHash: hashIp(req.ip),
      metadata: { role: req.user!.role },
    });
    return res.json({ success: true });
  } catch (error) {
    if (handleSecurityGateError(error, res)) return;
    return res.status(503).json({ error: 'DB_UNAVAILABLE', code: 'DB_UNAVAILABLE' });
  }
});

// ── Données du Centre ────────────────────────────────────────────────────────

router.get('/overview', exigerOuverture, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json({
      overview: await securityOverview(),
      severities: [...SECURITY_SEVERITIES],
      eventTypes: [...SECURITY_EVENT_TYPES],
    });
  } catch {
    return res.status(503).json({ error: 'DB_UNAVAILABLE', code: 'DB_UNAVAILABLE' });
  }
});

router.get('/events', exigerOuverture, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const acknowledged = req.query.acknowledged === 'true' ? true
      : req.query.acknowledged === 'false' ? false : undefined;
    const page = await listSecurityEvents({
      severity: typeof req.query.severity === 'string' ? req.query.severity : undefined,
      eventType: typeof req.query.eventType === 'string' ? req.query.eventType : undefined,
      acknowledged,
      limit: Number(req.query.limit),
      offset: Number(req.query.offset),
    });
    return res.json(page);
  } catch {
    return res.status(503).json({ error: 'DB_UNAVAILABLE', code: 'DB_UNAVAILABLE' });
  }
});

const acknowledgeSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) });

router.post('/events/acknowledge', exigerOuverture, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { ids } = acknowledgeSchema.parse(req.body);
    const acknowledged = await acknowledgeSecurityEvents(ids, req.user!.userId);
    return res.json({ acknowledged });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'errors.validation', code: 'VALIDATION' });
    }
    return res.status(503).json({ error: 'DB_UNAVAILABLE', code: 'DB_UNAVAILABLE' });
  }
});

/** Journal d'audit — ce que les administrateurs ont FAIT. */
router.get('/audit', exigerOuverture, async (req: AuthenticatedRequest, res: Response) => {
  if (!prisma) return res.json({ entries: [], total: 0 });
  try {
    const limitBrut = Number(req.query.limit);
    const limit = Number.isSafeInteger(limitBrut) && limitBrut > 0 ? Math.min(limitBrut, 200) : 50;
    // Les entrées réservées au propriétaire restent invisibles au
    // super-administrateur, exactement comme ailleurs dans le produit.
    const where = isOwnerRequest(req) ? {} : { visibleOwnerOnly: false };
    const [entries, total] = await Promise.all([
      (prisma as any).auditLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: limit,
        select: {
          id: true, action: true, type: true, timestamp: true,
          user: { select: { name: true, email: true } },
        },
      }),
      (prisma as any).auditLog.count({ where }),
    ]);
    return res.json({ entries, total, limit });
  } catch {
    return res.status(503).json({ error: 'DB_UNAVAILABLE', code: 'DB_UNAVAILABLE' });
  }
});

export default router;

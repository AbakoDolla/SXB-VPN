/**
 * Remontée de sécurité mobile — /api/mobile-security
 *
 * L'application signale ce qu'elle a OBSERVÉ sur l'appareil : instrumentation
 * active, signature d'APK altérée, leurre touché, attestation refusée. Elle
 * n'annonce jamais de verdict, et le serveur ne lui en demande pas : un client
 * compromis est justement celui dont la conclusion ne vaut rien.
 *
 * Ce que cette route ajoute à ce que l'appareil sait déjà :
 *
 *  • L'ATTRIBUTION. Un incident sans nom ni adresse ne se traite pas. Chaque
 *    alerte porte l'adresse source réelle et, quand l'appareil est rattaché, le
 *    nom enregistré du client. Ces champs ne ressortent que par la console
 *    propriétaire, déjà cloisonnée aux deux rôles les plus hauts.
 *
 *  • LA DÉCISION. Le score et l'action sont calculés côté serveur.
 *
 *  • LA PORTEE. Une observation locale ne suspend jamais un compte.
 *
 * La réponse ne dit PAS à l'appelant ce qui a été retenu contre lui. Renvoyer
 * le score reviendrait à offrir un banc d'essai : il suffirait d'itérer jusqu'à
 * passer sous le seuil.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../database';
import { MobileAccessError } from '../services/access-lifecycle';
import { proofFor, securityFailure } from '../services/mobile-proof';
import { consumeSessionProof } from '../services/mobile-session-security';
import { AuthenticatedRequest, requireAuth } from '../middleware/auth';
import { hashIp } from '../services/security-passkey';
import { recordSecurityEvent, persistSecurityEvent } from '../services/security-events';
import {
  evaluerRisque,
  meriteUneTrace,
  normaliserSignaux,
  SIGNAUX_MOBILES,
  type SignalMobile,
  type EvaluationRisque,
} from '../services/mobile-risk';
import { signalDepuisAttestation, verifierAttestation } from '../services/play-integrity';
import { readSecurityPolicy } from '../services/security-policy';

const router = Router();

const eventSchema = z.object({
  id: z.string().uuid(), eventType: z.enum(['VPN_STARTED', 'VPN_STOPPED', 'VPN_REVOKED', 'VPN_CONFLICT']),
  timestamp: z.number().int().nonnegative().refine(value => value <= Date.now() + 90_000),
  securitySessionId: z.string().max(200).optional(), securityGeneration: z.number().int().positive().optional(),
  connectionId: z.string().uuid().optional(), usageSessionId: z.string().max(200).optional(),
  accessAttempt: z.string().uuid().optional(),
}).strict();
router.post('/events', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.role !== 'CLIENT' || !req.user.clientId) securityFailure('MOBILE_CLIENT_ONLY', 403);
    const principal = req.user;
    if (!prisma) throw new Error('SECURITY_DATABASE_REQUIRED');
    const body = z.object({ events: z.array(eventSchema).min(1).max(25) }).strict().parse(req.body);
    const acceptedIds = await prisma.$transaction(async tx => {
      await consumeSessionProof(tx, req.user!, proofFor(req));
      const accepted: string[] = [];
      for (const event of body.events) {
      const connection = event.connectionId ? await tx.mobileConnection.findUnique({ where: { id: event.connectionId } }) : null;
      if (req.user!.sid && !connection) securityFailure('EVENT_CONNECTION_REQUIRED', 409);
      if (event.connectionId && (!connection || connection.clientId !== principal.clientId ||
          connection.deviceId !== principal.deviceId || connection.authSessionId !== event.securitySessionId ||
          connection.authGeneration !== event.securityGeneration)) securityFailure('EVENT_AUTHORITY_MISMATCH', 403);
      if (connection && ['VPN_REVOKED', 'VPN_STOPPED'].includes(event.eventType)) {
        await tx.mobileConnection.updateMany({
          where: { id: connection.id, closedAt: null },
          data: { closedAt: new Date(), closeReason: event.eventType },
        });
      }
      await persistSecurityEvent(tx, {
        eventType: event.eventType, severity: event.eventType === 'VPN_REVOKED' ? 'warning' : 'info',
        userId: principal.userId, deviceId: principal.deviceId,
        sessionId: connection?.authSessionId, sessionGeneration: connection?.authGeneration,
        connectionId: connection?.id, eventKey: `${principal.clientId}:${event.id}`,
        actionTaken: event.eventType === 'VPN_REVOKED' ? 'CONNECTION_CLOSED' : null,
        metadata: { reason: event.eventType === 'VPN_REVOKED' ? 'SYSTEM_VPN_REVOKE' : event.eventType,
          evidence: 'client_observation', observedAt: new Date(event.timestamp).toISOString() },
      });
      accepted.push(event.id);
      }
      return accepted;
    });
    return res.status(202).json({ acceptedIds });
  } catch (error) {
    if (error instanceof MobileAccessError) return res.status(error.status).json(error.body);
    if (error instanceof z.ZodError) return res.status(400).json({ error: 'INVALID_SECURITY_EVENT' });
    console.warn('[security] EVENT_DELIVERY_DEFERRED');
    return res.status(503).json({ error: 'SECURITY_EVENT_STORAGE_UNAVAILABLE' });
  }
});

const rapportSchema = z.object({
  signals: z.record(z.string(), z.boolean()).optional(),
  deviceModel: z.string().max(80).optional(),
  appVersion: z.string().max(40).optional(),
  /** Renseigné quand l'application a touché une valeur appât. */
  decoy: z.string().max(120).optional(),
  /** Jeton Play Integrity, quand l'application a pu en obtenir un. */
  integrityToken: z.string().max(8000).optional(),
  integrity: z.object({
    packageName: z.string().max(100).optional(),
    buildType: z.enum(['debug', 'release']).optional(),
    channel: z.enum(['OFFICIAL', 'BETA', 'INTERNAL', 'UNKNOWN']).optional(),
    certificateDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(8).optional(),
  }).strict().optional(),
}).strict();

function lireIdAppareil(req: AuthenticatedRequest): string | null {
  const brut = req.headers['x-sxb-device-id'];
  if (typeof brut !== 'string') return null;
  const normalise = brut.trim();
  return /^SXB[A-Z0-9]{6,80}$/.test(normalise) ? normalise : null;
}

/**
 * Adresse source réelle.
 *
 * Derrière le proxy, `req.ip` suit `trust proxy`. On borne la longueur : une
 * en-tête forgée ne doit pas pouvoir remplir la colonne.
 */
function adresseSource(req: AuthenticatedRequest): string | null {
  const ip = req.ip || req.socket?.remoteAddress || null;
  return ip ? String(ip).slice(0, 60) : null;
}

/** Nom enregistré du client porteur de l'appareil, pour que l'alerte ait un visage. */
async function attribuerAppareil(deviceId: string, req: AuthenticatedRequest) {
  if (!prisma) return null;
  try {
    return await (prisma as any).vpnClient.findFirst({
      where: {
        deviceId,
        userId: req.user?.userId,
        ...(req.user?.clientId ? { id: req.user.clientId } : {}),
      },
      select: {
        id: true,
        status: true,
        userId: true,
        user: { select: { name: true, email: true } },
      },
    });
  } catch {
    return null;
  }
}

router.post('/report', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  // Seule une session mobile parle ici. Un compte d'exploitation qui posterait
  // sur cette route fabriquerait des alertes contre un appareil qui n'est pas
  // le sien.
  if (req.user?.role !== 'CLIENT') {
    return res.status(403).json({ error: 'MOBILE_CLIENT_ONLY', message: 'Mobile client session required' });
  }
  const deviceId = lireIdAppareil(req);
  if (!deviceId) {
    return res.status(422).json({ error: 'DEVICE_ID_REQUIRED', message: 'A valid activated device identifier is required' });
  }
  const analyse = rapportSchema.safeParse(req.body ?? {});
  if (!analyse.success) {
    return res.status(422).json({ error: 'INVALID_SECURITY_REPORT', message: 'Invalid mobile security report' });
  }

  const signaux: SignalMobile[] = normaliserSignaux(analyse.data.signals);
  if (analyse.data.decoy && !signaux.includes('decoyTouched')) signaux.push('decoyTouched');

  // Attestation Google. Seul un REFUS produit un signal : une attestation
  // absente, non configurée ou indisponible ne prouve rien, et la compter
  // comme un échec allumerait tout le parc le jour du déploiement.
  let attestation = 'absent';
  if (analyse.data.integrityToken) {
    const resultat = await verifierAttestation(analyse.data.integrityToken);
    attestation = resultat.statut === 'refused' ? `refused:${resultat.raison}` : resultat.statut;
    if (signalDepuisAttestation(resultat) && !signaux.includes('attestationFailed')) {
      signaux.push('attestationFailed');
    }
  }

  let evaluation: EvaluationRisque;
  try {
    const policy = await readSecurityPolicy();
    const integrity = analyse.data.integrity;
    if (integrity && ((integrity.packageName && integrity.packageName !== policy.packageName) ||
        (integrity.certificateDigests?.length && integrity.certificateDigests.some(cert => !policy.certificates.includes(cert))))) {
      if (!signaux.includes('signatureInvalid')) signaux.push('signatureInvalid');
    }
    evaluation = evaluerRisque(signaux, policy);
  } catch {
    console.warn('[security] POLICY_UNAVAILABLE');
    return res.status(503).json({ error: 'SECURITY_POLICY_UNAVAILABLE' });
  }

  // Un appareil sain n'a rien à raconter : le flux d'alertes doit rester lisible.
  if (!meriteUneTrace(evaluation)) {
    return res.status(202).json({ accepted: true });
  }

  const fiche = await attribuerAppareil(deviceId, req);
  const contexte = {
    ip: adresseSource(req),
    clientName: fiche?.user?.name || fiche?.user?.email || null,
    deviceModel: analyse.data.deviceModel || null,
    appVersion: analyse.data.appVersion || null,
    signals: evaluation.signaux.join(','),
    riskScore: evaluation.score,
    action: evaluation.action,
    riskLevel: evaluation.level,
    evidence: evaluation.evidence,
    policyVersion: evaluation.policyVersion,
    attestation,
  };

  const typeAlerte = evaluation.signaux.includes('decoyTouched')
    ? 'DEVICE_DECOY_TOUCHED'
    : evaluation.signaux.includes('attestationFailed') && evaluation.signaux.length === 1
      ? 'DEVICE_ATTESTATION_FAILED'
      : 'DEVICE_INTEGRITY_ALERT';

  await recordSecurityEvent({
    eventType: typeAlerte as any,
    severity: evaluation.severity,
    userId: fiche?.userId ?? req.user.userId,
    deviceId,
    ipHash: hashIp(adresseSource(req)),
    appVersion: analyse.data.appVersion || null,
    metadata: contexte,
    sessionId: req.user.sid, sessionGeneration: req.user.sg,
    policyVersion: evaluation.policyVersion, riskLevel: evaluation.level,
  });
  const signalEvents = {
    rooted: 'ROOT_DETECTED', debugger: 'DEBUG_DETECTED', hooked: 'HOOKING_RISK',
    frida: 'INSTRUMENTATION_RISK', xposed: 'INSTRUMENTATION_RISK', signatureInvalid: 'APP_INTEGRITY_FAILED',
  } as const;
  const types = new Set(evaluation.signaux.flatMap(signal => signal in signalEvents
    ? [signalEvents[signal as keyof typeof signalEvents]] : []));
  for (const eventType of types) await recordSecurityEvent({
    eventType, severity: evaluation.severity, userId: req.user.userId, deviceId,
    sessionId: req.user.sid, sessionGeneration: req.user.sg, policyVersion: evaluation.policyVersion,
    riskLevel: evaluation.level, metadata: { evidence: 'client_observation', action: evaluation.action },
  });

  // Réponse volontairement muette : ni score, ni seuil, ni signal retenu.
  return res.status(202).json({ accepted: true });
});

/** Vocabulaire exposé pour les tests et l'interface, jamais les poids. */
export const SIGNAUX_EXPOSES = SIGNAUX_MOBILES;

export default router;

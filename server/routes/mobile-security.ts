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
 *  • LA SANCTION. Au-delà du seuil, l'accès de l'appareil est coupé — de façon
 *    réversible et tracée, jamais silencieuse.
 *
 * La réponse ne dit PAS à l'appelant ce qui a été retenu contre lui. Renvoyer
 * le score reviendrait à offrir un banc d'essai : il suffirait d'itérer jusqu'à
 * passer sous le seuil.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../database';
import { AuthenticatedRequest, requireAuth } from '../middleware/auth';
import { hashIp } from '../services/security-passkey';
import { recordSecurityEvent } from '../services/security-events';
import {
  evaluerRisque,
  meriteUneTrace,
  normaliserSignaux,
  SIGNAUX_MOBILES,
  type SignalMobile,
} from '../services/mobile-risk';
import { signalDepuisAttestation, verifierAttestation } from '../services/play-integrity';

const router = Router();

const rapportSchema = z.object({
  signals: z.record(z.string(), z.boolean()).optional(),
  deviceModel: z.string().max(80).optional(),
  appVersion: z.string().max(40).optional(),
  /** Renseigné quand l'application a touché une valeur appât. */
  decoy: z.string().max(120).optional(),
  /** Jeton Play Integrity, quand l'application a pu en obtenir un. */
  integrityToken: z.string().max(8000).optional(),
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
async function attribuerAppareil(deviceId: string) {
  if (!prisma) return null;
  try {
    return await (prisma as any).vpnClient.findUnique({
      where: { deviceId },
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

/**
 * Coupe l'accès de l'appareil.
 *
 * Réversible : le compte passe en `suspended`, rien n'est supprimé. Un faux
 * positif se répare d'un clic, ce qui ne serait pas vrai d'une suppression.
 */
async function couperAcces(clientId: string): Promise<boolean> {
  if (!prisma) return false;
  try {
    await (prisma as any).vpnClient.update({
      where: { id: clientId },
      data: { status: 'suspended' },
    });
    return true;
  } catch {
    return false;
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

  const evaluation = evaluerRisque(signaux);

  // Un appareil sain n'a rien à raconter : le flux d'alertes doit rester lisible.
  if (!meriteUneTrace(evaluation)) {
    return res.status(202).json({ accepted: true });
  }

  const fiche = await attribuerAppareil(deviceId);
  const contexte = {
    ip: adresseSource(req),
    clientName: fiche?.user?.name || fiche?.user?.email || null,
    deviceModel: analyse.data.deviceModel || null,
    appVersion: analyse.data.appVersion || null,
    signals: evaluation.signaux.join(','),
    riskScore: evaluation.score,
    action: evaluation.action,
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
  });

  // La sanction est une seconde entrée, distincte de l'observation : on doit
  // pouvoir lire ce qui a été vu même si la coupure échoue.
  if (evaluation.action === 'block' && fiche?.id && fiche.status !== 'suspended') {
    const coupe = await couperAcces(fiche.id);
    await recordSecurityEvent({
      eventType: 'DEVICE_AUTO_BLOCKED' as any,
      severity: 'critical',
      userId: fiche.userId,
      deviceId,
      ipHash: hashIp(adresseSource(req)),
      appVersion: analyse.data.appVersion || null,
      actionTaken: coupe ? 'ACCESS_SUSPENDED' : 'SUSPEND_FAILED',
      metadata: { ...contexte, status: coupe ? 'suspended' : 'failed' },
    });
  }

  // Réponse volontairement muette : ni score, ni seuil, ni signal retenu.
  return res.status(202).json({ accepted: true });
});

/** Vocabulaire exposé pour les tests et l'interface, jamais les poids. */
export const SIGNAUX_EXPOSES = SIGNAUX_MOBILES;

export default router;

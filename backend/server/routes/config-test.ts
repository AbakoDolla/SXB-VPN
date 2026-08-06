/**
 * config-test.ts — POST /api/config-test — Préflight « Tester la configuration
 * importée » (mission §7).
 *
 * RÈGLES :
 *   - Ne crée/configure AUCUN serveur : sonde uniquement le serveur EXTERNE.
 *   - Aucune authentification (transport-only, aucun credential utilisé).
 *   - Jamais de canonicalConfig ni credential dans la réponse : uniquement le
 *     compte-rendu structuré (steps) + verdict + latence.
 *   - unreachable_from_probe ≠ invalid (géo/opérateur-restreinte possible).
 *   - Si profileId fourni : met à jour validatedAt/validationStatus/Message
 *     du profil (traçabilité honnête du dernier test).
 */
import { Router, Response } from 'express';
import { prisma } from '../database';
import { requireAuth, requirePermission, AuthenticatedRequest } from '../middleware/auth';
import { logDbActivity } from '../database';
import {
  parseImportedConfig, decryptCanonical, validateTransportCoherence,
} from '../services/canonical-config';
import { probeConfig, statusFromProbe, ProbeReport } from '../services/transport-probe';

const router = Router();

router.post('/', requireAuth, requirePermission('vpnprofile.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { importConfig, profileId } = req.body ?? {};
    if (!importConfig && !profileId) {
      return res.status(400).json({ error: 'importConfig (URI/JSON) ou profileId requis' });
    }

    let canonical: Record<string, any> | null = null;
    let parseErrors: string[] = [];
    let parseWarnings: string[] = [];

    if (importConfig) {
      // Mode 1 : test d'une config en cours d'import (non encore stockée)
      const parsed = parseImportedConfig(String(importConfig));
      parseErrors = parsed.errors;
      parseWarnings = parsed.warnings;
      canonical = parsed.canonical ?? null;
      if (!parsed.ok) {
        return res.json({
          success: false,
          validationStatus: 'invalid',
          parse: { errors: parseErrors, warnings: parseWarnings },
        });
      }
    } else {
      // Mode 2 : test d'un profil existant (stocké chiffré)
      const profile = await (prisma as any).vpnProfile.findUnique({ where: { id: profileId } });
      if (!profile) return res.status(404).json({ error: 'Profil introuvable' });
      if (profile.canonicalConfig) {
        const plain = decryptCanonical(profile.canonicalConfig);
        if (!plain) return res.json({ success: false, validationStatus: 'invalid', parse: { errors: ['canonicalConfig illisible — réimportez la configuration'], warnings: [] } });
        canonical = JSON.parse(plain);
        const coherence = validateTransportCoherence(canonical);
        parseErrors = coherence.errors; parseWarnings = coherence.warnings;
        if (coherence.errors.length > 0) {
          return res.json({ success: false, validationStatus: 'invalid', parse: { errors: parseErrors, warnings: parseWarnings } });
        }
      } else {
        // Profil legacy (colonnes) : reconstruire un canonique de test minimal
        canonical = {
          protocol: (profile.protocol || 'ssh').toLowerCase(),
          host: profile.host, port: profile.port, tls: !!profile.tls,
          sni: profile.sni ?? null,
        };
        if ((profile.protocol || '').includes('payload') && profile.payloadId) {
          const pl = await (prisma as any).sshPayload.findUnique({ where: { id: profile.payloadId } }).catch(() => null);
          if (pl?.content) (canonical as any).payload = pl.content;
        }
      }
    }

    const report: ProbeReport = await probeConfig(canonical!, {});
    const validationStatus = statusFromProbe(report);

    // Traçabilité : si le test vise un profil stocké, consigner le verdict
    if (profileId) {
      const failedStep = report.steps.find(s => !s.ok);
      const message = report.hint
        ?? (failedStep ? `Échec : ${failedStep.event} — ${failedStep.detail ?? ''}` : (report.steps.at(-1)?.detail ?? null));
      await (prisma as any).vpnProfile.update({
        where: { id: profileId },
        data: {
          validatedAt: new Date(),
          validationStatus,
          validationMessage: message,
        },
      }).catch(() => null);
      await logDbActivity(req.user!.userId, `Préflight profil ${profileId} → ${validationStatus}`, 'info', req.ip || '').catch(() => null);
    }

    return res.json({
      success: true,
      validationStatus,
      parse: { errors: parseErrors, warnings: parseWarnings },
      probe: {
        verdict: report.verdict,
        steps: report.steps,
        latencyMs: report.latencyMs,
        durationMs: report.durationMs,
        startedAt: report.startedAt,
        hint: report.hint ?? null,
      },
    });
  } catch (err: any) {
    console.error('[config-test]', err.message || err);
    return res.status(500).json({ error: 'Échec du préflight' });
  }
});

export default router;

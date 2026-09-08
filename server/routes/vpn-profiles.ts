/**
 * VPN Profiles Routes — SXB VPN Core
 * Manages reusable VPN configuration templates (profiles).
 * A profile defines protocol, server, credentials, payload, SNI, DNS, etc.
 * It is then attached to Subscriptions delivered to clients.
 */
import { Router, Response } from 'express';
import { prisma, inMemoryDb } from '../database';
import { requireAuth, requirePermission, AuthenticatedRequest } from '../middleware/auth';
import { logDbActivity } from '../database';
import crypto from 'crypto';
import {
  parseImportedConfig, parseImportedConfigList, canonicalJson, computeCanonicalHash, encryptCanonical,
  type ParseResult,
} from '../services/canonical-config';
import {
  assertProfileUnlocked, createProfileLock, handleProfileLockError, issueProfileUnlock,
  profileLockWhere, profileUnlockLimiters, serializeLockedProfile, verifyProfilePassword,
  ProfileLockError,
} from '../services/profile-lock';
import { prepareProfileEngineLock } from '../services/profile-engines';

const router = Router();

// ── Import canonique : champs d'identification dérivés, technique immuable ────
/**
 * Construit les données Prisma d'un profil importé.
 * - Le canonique (technique) est stocké CHIFFRÉ (canonicalConfig), jamais en clair.
 * - Les colonnes host/port/protocol/tls... servent UNIQUEMENT à l'identification
 *   et reflètent le canonique. Les credentials ne sont JAMAIS recopiés dans les
 *   colonnes en clair : canonicalConfig les détient déjà, chiffrés.
 * - jsonConfig legacy n'est plus jamais écrit (redirigé ici, chiffré, puis NULL).
 */
function buildImportDataFromParsed(parsed: ParseResult, opts: { bumpVersion?: number | null } = {}) {
  if (!parsed.ok || !parsed.canonical) {
    const err = new Error('IMPORT_INVALID');
    (err as any).details = { errors: parsed.errors, warnings: parsed.warnings };
    throw err;
  }
  const canon = parsed.canonical;
  const proto = String(canon.protocol).toLowerCase();

  // Identification dérivée du canonique (jamais inventée)
  let host = canon.host ?? null;
  let port: number = canon.port ?? 0;
  if (!host && proto === 'wireguard' && canon.endpoint) {
    const [h, p] = String(canon.endpoint).split(':');
    host = h; port = Number(p) || 0;
  }
  if (!host && proto === 'singbox') {
    const outbounds = Array.isArray(canon.outbounds) ? canon.outbounds : [];
    // sing-box natif : server/server_port. Xray : settings.vnext[0].
    // On ignore direct/dns/block et les outbounds de contrôle éventuels.
    const out0 = outbounds.find((o: any) => {
      const p = String(o?.protocol || o?.type || '').toLowerCase();
      return !['direct', 'freedom', 'dns', 'block', 'blackhole'].includes(p);
    }) || outbounds[0];
    const xrayServer = out0?.settings?.vnext?.[0];
    host = out0?.server ?? xrayServer?.address ?? 'singbox-json';
    port = Number(out0?.server_port ?? xrayServer?.port ?? 0) || 0;
  }

  return {
    protocol: proto,
    host,
    port,
    tls: canon.tls === true,
    sni: canon.sni ?? null,
    // Pour la famille SSH, `network` sert uniquement d'étiquette lisible dans
    // le dashboard. La configuration technique complète reste dans le blob
    // canonique chiffré.
    network: ['ssh', 'ssh+payload'].includes(proto)
      ? `${canon.sshTransport ?? (canon.slowDns ? 'slowdns' : canon.tls ? 'tls' : 'direct')}${canon.udpMode === 'udpgw' ? '+udpgw' : ''}`
      : (canon.network ?? null),
    path: canon.path ?? null,
    dns: canon.dns ?? null,
    username: null as string | null,   // credentials : dans canonicalConfig uniquement
    password: null as string | null,
    uuid: null as string | null,
    method: canon.method ?? null,
    jsonConfig: null as string | null, // plus JAMAIS de clair ici
    payloadId: null as string | null,
    // Bloc canonique
    sourceFormat: parsed.sourceFormat ?? null,
    canonicalConfig: encryptCanonical(canonicalJson(canon)),
    canonicalConfigHash: computeCanonicalHash(canon),
    configVersion: (opts.bumpVersion ?? 0) + 1,
    importedAt: new Date(),
    validatedAt: null,
    validationStatus: 'unknown',
    validationMessage: parsed.warnings.length ? parsed.warnings.join(' | ') : null,
    _parseWarnings: parsed.warnings,
  };
}

function buildImportData(rawImport: string, opts: { bumpVersion?: number | null } = {}) {
  return buildImportDataFromParsed(parseImportedConfig(rawImport), opts);
}

// ── Chiffrement AES-256-GCM (Phase 2 — authentifié, résistant à la falsification) ──
const ENC_KEY = (() => {
  const k = process.env.ENCRYPTION_KEY;
  if (!k || k.startsWith('CHANGE_ME')) console.error('[SECURITY] ENCRYPTION_KEY non configurée!');
  return k || '';
})();

function getKey(): Buffer {
  if (!ENC_KEY) throw new Error('[SECURITY] ENCRYPTION_KEY manquante');
  return crypto.createHash('sha256').update(ENC_KEY).digest();
}

/** Chiffrement AES-256-GCM — format : "gcm:<iv_hex>:<ciphertext_hex>:<tag_hex>" */
function encrypt(text: string): string {
  const key = getKey();
  const iv  = crypto.randomBytes(12);
  const c   = crypto.createCipheriv('aes-256-gcm', key, iv) as crypto.CipherGCM;
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return `gcm:${iv.toString('hex')}:${enc.toString('hex')}:${tag.toString('hex')}`;
}

/** Déchiffrement — supporte GCM (v2) et CBC (v1 legacy) */
function decrypt(enc: string): string {
  if (!enc) return '';
  if (enc.startsWith('gcm:')) {
    const parts = enc.slice(4).split(':');
    if (parts.length !== 3) throw new Error('Format GCM invalide');
    const key = getKey();
    const iv  = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[2], 'hex');
    const d   = crypto.createDecipheriv('aes-256-gcm', key, iv) as crypto.DecipherGCM;
    d.setAuthTag(tag);
    return Buffer.concat([d.update(Buffer.from(parts[1], 'hex')), d.final()]).toString();
  }
  // Rétro-compatibilité CBC v1
  const [ivHex, encHex] = enc.split(':');
  if (!ivHex || !encHex) return enc;
  const key = getKey();
  const d   = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
  return Buffer.concat([d.update(Buffer.from(encHex, 'hex')), d.final()]).toString();
}

const maskProfile = (p: any, req?: AuthenticatedRequest) => serializeLockedProfile(p, req);

/**
 * Profil masqué + liste des revendeurs attribués, aplatie pour l'interface.
 *
 * `resellers` vide signifie « aucune restriction » : la configuration est alors
 * disponible pour TOUS les revendeurs (voir le modèle VpnProfileReseller). Le
 * drapeau `unrestricted` évite à l'interface de réinterpréter ce cas.
 */
function withResellers(p: any, req?: AuthenticatedRequest) {
  const out = maskProfile(p, req);
  const links = Array.isArray(p.assignedResellers) ? p.assignedResellers : [];
  out.resellers = links.map((l: any) => ({
    resellerId: l.resellerId,
    name: l.reseller?.user?.name ?? null,
    email: l.reseller?.user?.email ?? null,
    assignedAt: l.assignedAt ?? null,
  }));
  out.unrestricted = out.resellers.length === 0;
  delete out.assignedResellers;
  return out;
}

// ─── GET /api/vpn-profiles ────────────────────────────────────────────────────
router.get('/', requireAuth, requirePermission('vpnprofile.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) {
      return res.json({ success: true, profiles: (inMemoryDb.vpnProfiles || []).map(p => maskProfile(p)) });
    }
    // Les attributions sont chargées si la table existe. Elles ont été ajoutées
    // après coup : tant que le schéma n'est pas poussé en base, l'`include`
    // échoue. Sans ce repli, c'est TOUTE la page Configurations qui tombe en
    // 500 — une fonctionnalité secondaire ne doit jamais emporter l'essentiel.
    try {
      const profiles = await (prisma as any).vpnProfile.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          _count: { select: { subscriptions: true } },
          assignedResellers: {
            include: { reseller: { include: { user: { select: { id: true, name: true, email: true } } } } },
          },
        },
      });
      return res.json({ success: true, profiles: profiles.map((p: any) => withResellers(p)) });
    } catch {
      const profiles = await (prisma as any).vpnProfile.findMany({
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { subscriptions: true } } },
      });
      return res.json({ success: true, profiles: profiles.map((p: any) => maskProfile(p)) });
    }
  } catch (err) {
    console.error('vpn-profiles list failed');
    return res.status(500).json({ error: 'Failed to list VPN profiles' });
  }
});

// ─── GET /api/vpn-profiles/assigned ──────────────────────────────────────────
//
// Vue du REVENDEUR. Il ne possède pas `vpnprofile.view` — il ne peut donc pas
// lister les profils par la route ci-dessus, et c'est voulu : les champs
// techniques (hôte, port, identifiants, blob canonique) ne doivent jamais lui
// parvenir. Il a néanmoins besoin de choisir une configuration pour créer un
// forfait à ses clients : cette route ne renvoie que le nom commercial et
// l'identifiant des configurations qui LUI sont attribuées.
router.get('/assigned', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.json({ success: true, profiles: [] });

    // Les rôles disposant de la vue technique voient tout : la route sert alors
    // simplement de liste de sélection.
    if (req.user?.role !== 'RESELLER') {
      const all = await (prisma as any).vpnProfile.findMany({
        where: { status: 'active' },
        select: { id: true, name: true, displayProtocol: true },
        orderBy: { name: 'asc' },
      });
      return res.json({ success: true, profiles: all });
    }

    const reseller = await (prisma as any).reseller.findUnique({ where: { userId: req.user.userId } });
    if (!reseller) return res.json({ success: true, profiles: [] });

    // STRICTEMENT les configurations attribuées par l'administrateur.
    //
    // La règle précédente considérait qu'un profil sans aucune attribution
    // restait ouvert à tous : comme la quasi-totalité du parc n'en portait
    // aucune, le revendeur voyait 45 configurations sur 47 et l'écran
    // d'attribution ne servait à rien. L'attribution devient la seule porte
    // d'entrée : un revendeur sans rien d'attribué ne vend rien, ce qui est le
    // comportement attendu et se corrige d'un clic côté administrateur.
    try {
      const profiles = await (prisma as any).vpnProfile.findMany({
        where: {
          status: 'active',
          assignedResellers: { some: { resellerId: reseller.id } },
        },
        select: { id: true, name: true, displayProtocol: true },
        orderBy: { name: 'asc' },
      });
      return res.json({ success: true, profiles });
    } catch {
      // Table d'attribution absente : renvoyer tout le parc reviendrait à
      // ouvrir l'ensemble des configurations à chaque revendeur. Une liste
      // vide est un défaut visible et réparable, pas une fuite silencieuse.
      return res.json({ success: true, profiles: [] });
    }
  } catch (err) {
    console.error('vpn-profiles assigned error:', err);
    return res.status(500).json({ error: 'Failed to list assigned profiles' });
  }
});


// Stored profiles only: a GET must never silently create an unprotected copy.
router.get("/unified", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "DB unavailable" });
    const canView = req.user?.role === 'OWNER' || req.user?.permissions.includes('vpnprofile.view');
    let where: Record<string, any> = { status: 'active' };
    if (!canView) {
      if (req.user?.role !== 'RESELLER') return res.status(403).json({ error: 'errors.auth.forbidden' });
      const reseller = await prisma.reseller.findUnique({ where: { userId: req.user.userId } });
      if (!reseller) return res.status(403).json({ error: 'errors.auth.forbidden' });
      where = { ...where, assignedResellers: { some: { resellerId: reseller.id } } };
    }
    const profiles = await prisma.vpnProfile.findMany({ where, orderBy: { createdAt: 'desc' } });
    const configs = profiles.map(p => serializeLockedProfile(p, undefined, !!canView));
    return res.json({ configs });
  } catch { return res.status(500).json({ error: "Server error" }); }
});

// ─── GET /api/vpn-profiles/stats/all ─────────────────────────────────────────
router.get('/stats/all', requireAuth, requirePermission('vpnprofile.view'), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) {
      const profiles = inMemoryDb.vpnProfiles || [];
      const total = profiles.length;
      const active = profiles.filter(p => p.status === 'active').length;
      return res.json({ success: true, total, active, byProtocol: [] });
    }
    const total      = await (prisma as any).vpnProfile.count();
    const active     = await (prisma as any).vpnProfile.count({ where: { status: 'active' } });
    const byProtocol = await (prisma as any).vpnProfile.groupBy({ where: { lockPasswordHash: null }, by: ['protocol'], _count: { id: true } });
    return res.json({ success: true, total, active, byProtocol });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get stats' });
  }
});

// ─── GET /api/vpn-profiles/:id ───────────────────────────────────────────────
router.get('/:id', requireAuth, requirePermission('vpnprofile.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) {
      const p = (inMemoryDb.vpnProfiles || []).find((prof) => prof.id === req.params.id);
      if (!p) return res.status(404).json({ error: 'Profile not found' });
      if (req.get('X-VPN-Profile-Unlock')) assertProfileUnlocked(p, req);
      res.set('Cache-Control', 'no-store');
      return res.json({ success: true, profile: maskProfile(p, req) });
    }
    const p = await (prisma as any).vpnProfile.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { subscriptions: true } } },
    });
    if (!p) return res.status(404).json({ error: 'Profile not found' });
    if (req.get('X-VPN-Profile-Unlock')) assertProfileUnlocked(p, req);
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, profile: maskProfile(p, req) });
  } catch (err) {
    if (handleProfileLockError(err, res)) return;
    return res.status(500).json({ error: 'Failed to get VPN profile' });
  }
});

router.post('/:id/unlock', requireAuth, requirePermission('vpnprofile.view'), ...profileUnlockLimiters, async (req: AuthenticatedRequest, res: Response) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (!prisma) return res.status(503).json({ error: 'errors.db.unavailable' });
    if (!req.body || Object.keys(req.body).some(key => key !== 'password')) {
      throw new ProfileLockError(400, 'PROFILE_LOCK_PASSWORD_INVALID');
    }
    const profile = await prisma.vpnProfile.findUnique({ where: { id: req.params.id } });
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    if (!profile.lockPasswordHash) throw new ProfileLockError(409, 'PROFILE_NOT_LOCKED');
    await verifyProfilePassword(profile, req.body.password);
    const current = await prisma.vpnProfile.findUnique({ where: { id: profile.id } });
    if (!current || current.lockPasswordHash !== profile.lockPasswordHash || current.lockVersion !== profile.lockVersion) {
      throw new ProfileLockError(423, 'PROFILE_LOCKED');
    }
    const proof = issueProfileUnlock(current, req.user!.userId);
    req.headers['x-vpn-profile-unlock'] = proof.unlockToken;
    return res.json({ success: true, ...proof, profile: maskProfile(current, req) });
  } catch (error) {
    if (handleProfileLockError(error, res)) return;
    console.error('VPN profile unlock failed');
    return res.status(500).json({ error: 'PROFILE_UNLOCK_UNAVAILABLE' });
  }
});

router.put('/:id/lock', requireAuth, requirePermission('vpnprofile.manage'), ...profileUnlockLimiters, async (req: AuthenticatedRequest, res: Response) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (!prisma) return res.status(503).json({ error: 'errors.db.unavailable' });
    if (!req.body || Object.keys(req.body).some(key => key !== 'password')) {
      throw new ProfileLockError(400, 'PROFILE_LOCK_PASSWORD_INVALID');
    }
    const existing = await prisma.vpnProfile.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Profile not found' });
    assertProfileUnlocked(existing, req);
    const lock = await createProfileLock(req.body.password);
    assertProfileUnlocked(existing, req);
    const changed = await prisma.$transaction(async tx => {
      await prepareProfileEngineLock(tx, existing);
      assertProfileUnlocked(existing, req);
      const result = await tx.vpnProfile.updateMany({
        where: profileLockWhere(existing),
        data: { lockPasswordHash: lock.lockPasswordHash, lockVersion: { increment: 1 } },
      });
      if (result.count !== 1) throw new ProfileLockError(423, 'PROFILE_LOCKED');
      return result;
    });
    if (changed.count !== 1) throw new ProfileLockError(423, 'PROFILE_LOCKED');
    const profile = await prisma.vpnProfile.findUnique({ where: { id: existing.id } });
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    await logDbActivity(req.user!.userId, `VPN profile lock changed: ${existing.id}`, 'warning', req.ip || '');
    return res.json({ success: true, profile: maskProfile(profile) });
  } catch (error) {
    if (handleProfileLockError(error, res)) return;
    console.error('VPN profile lock change failed');
    return res.status(500).json({ error: 'PROFILE_LOCK_UNAVAILABLE' });
  }
});

// ─── GET /api/vpn-profiles/:id/resellers ─────────────────────────────────────
router.get('/:id/resellers', requireAuth, requirePermission('vpnprofile.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.json({ success: true, resellers: [], unrestricted: true });
    const links = await (prisma as any).vpnProfileReseller.findMany({
      where: { profileId: req.params.id },
      include: { reseller: { include: { user: { select: { id: true, name: true, email: true } } } } },
    });
    return res.json({
      success: true,
      resellers: links.map((l: any) => ({
        resellerId: l.resellerId,
        name: l.reseller?.user?.name ?? null,
        email: l.reseller?.user?.email ?? null,
        assignedAt: l.assignedAt,
      })),
      unrestricted: links.length === 0,
    });
  } catch (err: any) {
    console.error('vpn-profiles get resellers error:', err);
    return res.status(500).json({ error: 'Failed to list assigned resellers' });
  }
});

// ─── PUT /api/vpn-profiles/:id/resellers ─────────────────────────────────────
//
// Remplace l'ENSEMBLE des attributions en un appel : ajouter, retirer, ou tout
// retirer relèvent de la même opération. Un tableau vide rend la configuration
// disponible à tous les revendeurs, ce qui est le comportement par défaut des
// profils historiques.
router.put('/:id/resellers', requireAuth, requirePermission('vpnprofile.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: 'errors.db.unavailable' });
    const { resellerIds } = req.body ?? {};
    if (!Array.isArray(resellerIds)) {
      return res.status(400).json({ error: 'errors.profiles.invalid_resellers', message: 'resellerIds doit être un tableau' });
    }

    const profile = await (prisma as any).vpnProfile.findUnique({ where: { id: req.params.id }, select: { id: true, name: true } });
    if (!profile) return res.status(404).json({ error: 'Profil VPN introuvable' });

    // Écarter les identifiants inconnus plutôt que d'échouer : l'interface
    // pourrait référencer un revendeur supprimé entre-temps.
    const known = await (prisma as any).reseller.findMany({
      where: { id: { in: resellerIds } },
      select: { id: true },
    });
    const validIds: string[] = known.map((r: any) => r.id);

    await prisma.$transaction(async tx => {
      await tx.vpnProfileReseller.deleteMany({ where: { profileId: profile.id } });
      if (validIds.length) await tx.vpnProfileReseller.createMany({
            data: validIds.map((resellerId) => ({
              profileId: profile.id,
              resellerId,
              assignedBy: req.user!.userId,
            })),
            skipDuplicates: true,
          });
    });

    await logDbActivity(
      req.user!.userId,
      validIds.length
        ? `Configuration "${profile.name}" attribuée à ${validIds.length} revendeur(s)`
        : `Configuration "${profile.name}" rendue disponible à tous les revendeurs`,
      'info',
      req.ip || '',
    );
    return res.json({ success: true, assigned: validIds.length, unrestricted: validIds.length === 0 });
  } catch (err: any) {
    console.error('vpn-profiles set resellers error:', err);
    return res.status(500).json({ error: err.message || 'Failed to assign resellers' });
  }
});

// ─── POST /api/vpn-profiles ───────────────────────────────────────────────────
// ─── POST /api/vpn-profiles/import-batch ─────────────────────────────────────
// Importe atomiquement les conteneurs multi-profils (HTTP Custom CONFIGS[],
// abonnements URI, exports v2rayN). Aucune configuration n'est créée si une
// seule entrée est invalide : le dashboard peut corriger le fichier sans avoir
// à rechercher puis supprimer un import partiel.
router.post('/import-batch', requireAuth, requirePermission('vpnprofile.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: 'Base de données indisponible' });
    const lock = await createProfileLock(req.body?.lockPassword);
    const rawImport = String(req.body?.importConfig ?? '').trim();
    const namePrefix = String(req.body?.namePrefix ?? req.body?.name ?? '').trim().slice(0, 100) || 'SSH importé';
    const description = req.body?.description ? String(req.body.description).slice(0, 500) : null;
    const displayProtocol = req.body?.displayProtocol ? String(req.body.displayProtocol).slice(0, 100) : null;
    const requestedOfflineDays = Number(req.body?.offlineValidDays ?? 7);
    const offlineValidDays = Number.isFinite(requestedOfflineDays)
      ? Math.max(1, Math.min(30, Math.round(requestedOfflineDays)))
      : 7;
    const status = req.body?.status === 'inactive' ? 'inactive' : 'active';
    if (!rawImport) return res.status(400).json({ error: 'importConfig est requis' });

    const parsed = parseImportedConfigList(rawImport);
    if (parsed.length > 50) {
      return res.status(413).json({ error: 'Maximum 50 configurations par import' });
    }
    const invalid = parsed
      .map((result, index) => ({ index, name: result.displayName, errors: result.errors, warnings: result.warnings }))
      .filter((result) => result.errors.length > 0);
    if (invalid.length > 0) {
      return res.status(422).json({
        success: false,
        error: `${invalid.length} configuration(s) invalide(s) — aucune importation effectuée`,
        details: invalid,
      });
    }

    const prepared = parsed.map((result, index) => {
      const data: any = buildImportDataFromParsed(result);
      const parseWarnings = data._parseWarnings || [];
      delete data._parseWarnings;
      return {
        data: {
          name: String(result.displayName || `${namePrefix} ${index + 1}`).slice(0, 120),
          description,
          displayProtocol,
          offlineValidDays,
          status,
          ...data,
          ...lock,
        },
        warnings: parseWarnings as string[],
      };
    });

    const profiles = await prisma.$transaction(async tx => {
      const result = [];
      for (const entry of prepared) result.push(await tx.vpnProfile.create({ data: entry.data }));
      return result;
    });
    await logDbActivity(
      req.user!.userId,
      `Imported ${profiles.length} VPN profiles atomically`,
      'info',
      req.ip || '',
    );
    return res.status(201).json({
      success: true,
      imported: profiles.length,
      profiles: profiles.map(p => maskProfile(p)),
      warnings: [],
    });
  } catch (err: any) {
    if (handleProfileLockError(err, res)) return;
    console.error('VPN profile batch import error:', err?.code || err?.name || 'UNKNOWN');
    return res.status(500).json({ error: 'Échec de l’import multiple' });
  }
});

router.post('/', requireAuth, requirePermission('vpnprofile.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: 'errors.db.unavailable' });
    const lock = await createProfileLock(req.body?.lockPassword);
    const {
      name, description, protocol, displayProtocol,
      host, port, username, password,
      uuid, path, network, tls, sni, dns,
      payloadId, offlineValidDays, status,
      method, jsonConfig, importConfig,
    } = req.body;

    // ── FLUX CIBLE : import d'une configuration externe (URI/JSON) ────────────
    // jsonConfig legacy est traité comme un import (désormais chiffré, plus en clair).
    const rawImport = importConfig || (jsonConfig ? String(jsonConfig) : null);
    if (rawImport) {
      if (!name) return res.status(400).json({ error: 'name est requis' });
      let data: any;
      try {
        data = buildImportData(String(rawImport));
      } catch (e: any) {
        if (e.message === 'IMPORT_INVALID') {
          return res.status(422).json({
            success: false, error: 'Configuration importée invalide',
            details: e.details,
          });
        }
        throw e;
      }
      const parseWarnings = data._parseWarnings; delete data._parseWarnings;

      // Détection de doublon : le hash canonique identifie un contenu technique
      // strictement identique. Rien n'empêchait jusqu'ici de réimporter dix fois
      // la même configuration sous des noms différents — la production en compte
      // déjà six, dont quatre partageant le même hash, ce qui rend impossible de
      // savoir lequel fait foi lors d'une rotation de serveur.
      //
      // L'import n'est PAS bloqué (un même serveur peut légitimement servir deux
      // offres commerciales distinctes) : l'avertissement remonte au dashboard
      // pour que l'opérateur décide en connaissance de cause.
      const duplicateWarnings: string[] = [];
      if (data.canonicalConfigHash) {
        const twin = await (prisma as any).vpnProfile.findFirst({
          where: { canonicalConfigHash: data.canonicalConfigHash, status: { not: 'archived' } },
          select: { id: true, name: true },
        });
        if (twin) {
          duplicateWarnings.push(
            `Configuration technique identique au profil « ${twin.name} » — vérifiez qu'un doublon est bien voulu.`,
          );
        }
      }

      const profile = await (prisma as any).vpnProfile.create({
        data: {
          name, description,
          displayProtocol: displayProtocol || null,
          dns: dns || null,
          offlineValidDays: offlineValidDays ? Number(offlineValidDays) : 7,
          status: status || 'active',
          ...data,
          ...lock,
        },
      });
      await logDbActivity(req.user!.userId, `Imported VPN profile: ${name} (${data.sourceFormat})`, 'info', req.ip || '');
      return res.status(201).json({
        success: true,
        profile: maskProfile(profile),
        warnings: duplicateWarnings,
        imported: true,
      });
    }

    // ── FLUX LEGACY (colonnes) — conservé pour compatibilité ──────────────────
    if (!name || !protocol || !host || !port) {
      return res.status(400).json({ error: 'name + importConfig (recommandé) ou name, protocol, host, port (legacy) requis' });
    }

    const encPassword = password ? encrypt(password) : null;

    const profile = await (prisma as any).vpnProfile.create({
      data: {
        name, description, protocol,
        displayProtocol: displayProtocol || null,
        host, port: Number(port),
        username: username || null,
        password: encPassword,
        uuid: uuid || (!['ssh', 'ssh+payload'].includes(protocol) ? crypto.randomUUID() : null),
        path: path || null,
        network: network || 'ws',
        tls: !!tls,
        sni: sni || null,
        dns: dns || null,
        payloadId: payloadId || null,
        offlineValidDays: offlineValidDays ? Number(offlineValidDays) : 7,
        method: method || null,
        jsonConfig: null, // plus jamais de clair — legacy jsonConfig a été redirigé vers l'import chiffré
        status: status || 'active',
        ...lock,
      },
    });

    await logDbActivity(req.user!.userId, `Created VPN profile (legacy): ${name}`, 'info', req.ip || '');
    return res.status(201).json({ success: true, profile: maskProfile(profile) });
  } catch (err: any) {
    if (handleProfileLockError(err, res)) return;
    console.error('vpn-profile create failed');
    return res.status(500).json({ error: 'Failed to create VPN profile' });
  }
});

// ─── PUT /api/vpn-profiles/:id ───────────────────────────────────────────────
// Champs ADMINISTRATIFS (name, description, displayProtocol, status, dns,
// offlineValidDays) : exigent aussi le deverrouillage du profil.
// Champs TECHNIQUES (protocol, host, port, credentials, tls, sni, network,
// path, payload, jsonConfig…) : IMMUABLES hors « importConfig » (réimport
// explicite → nouveau canonique chiffré + configVersion incrémentée).
router.put('/:id', requireAuth, requirePermission('vpnprofile.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    res.set('Cache-Control', 'no-store');
    const existing = await (prisma as any).vpnProfile.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Profile not found' });
    assertProfileUnlocked(existing, req);
    await prisma.$transaction(tx => prepareProfileEngineLock(tx, existing));
    assertProfileUnlocked(existing, req);
    if (['lockPassword', 'lockPasswordHash', 'lockVersion', 'engineType', 'engineAccountId'].some(key => key in req.body)) {
      return res.status(400).json({ error: 'PROFILE_LOCK_FIELDS_FORBIDDEN' });
    }

    const {
      name, description, protocol, displayProtocol,
      host, port, username, password,
      uuid, path, network, tls, sni, dns,
      payloadId, offlineValidDays, status, method, jsonConfig, importConfig,
    } = req.body;

    // ── Réimport explicite (seule voie de modification technique) ─────────────
    const rawImport = importConfig || (jsonConfig ? String(jsonConfig) : null);
    if (rawImport) {
      let data: any;
      try {
        data = buildImportData(String(rawImport), { bumpVersion: existing.configVersion ?? 0 });
      } catch (e: any) {
        if (e.message === 'IMPORT_INVALID') {
          return res.status(422).json({ success: false, error: 'Configuration importée invalide', details: e.details });
        }
        throw e;
      }
      const parseWarnings = data._parseWarnings; delete data._parseWarnings;
      assertProfileUnlocked(existing, req);
      const updated = await (prisma as any).vpnProfile.update({
        where: profileLockWhere(existing),
        data: {
          ...data,
          ...(name !== undefined && { name }),
          ...(description !== undefined && { description }),
          ...(displayProtocol !== undefined && { displayProtocol: displayProtocol || null }),
          ...(dns !== undefined && { dns }),
          ...(offlineValidDays !== undefined && { offlineValidDays: Number(offlineValidDays) }),
          ...(status !== undefined && { status }),
        },
      });
      await logDbActivity(req.user!.userId,
        `Re-imported VPN profile: ${updated.name} (v${updated.configVersion}, ${data.sourceFormat})`, 'warning', req.ip || '');
      return res.json({ success: true, profile: maskProfile(updated, req), warnings: parseWarnings, reimported: true });
    }

    // ── Édition administrative : aucun champ technique accepté ────────────────
    const technicalAttempt = [
      ['protocol', protocol], ['host', host], ['port', port], ['username', username],
      ['password', password], ['uuid', uuid], ['path', path], ['network', network],
      ['tls', tls], ['sni', sni], ['payloadId', payloadId], ['method', method],
    ].filter(([, v]) => v !== undefined);
    if (technicalAttempt.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'Champs techniques immuables — modifiez la configuration via "importConfig" (réimport explicite)',
        technicalFieldsRejected: technicalAttempt.map(([k]) => k),
      });
    }

    const updated = await (prisma as any).vpnProfile.update({
      where: profileLockWhere(existing),
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(displayProtocol !== undefined && { displayProtocol: displayProtocol || null }),
        ...(dns !== undefined && { dns }),
        ...(offlineValidDays !== undefined && { offlineValidDays: Number(offlineValidDays) }),
        ...(status !== undefined && { status }),
      },
    });

    await logDbActivity(req.user!.userId, `Updated VPN profile (admin): ${updated.name}`, 'info', req.ip || '');
    return res.json({ success: true, profile: maskProfile(updated, req) });
  } catch (err: any) {
    if (handleProfileLockError(err, res)) return;
    if (err?.code === 'P2025') return res.status(423).json({ error: 'PROFILE_LOCKED', code: 'PROFILE_LOCKED' });
    return res.status(500).json({ error: 'Failed to update VPN profile' });
  }
});

// ─── DELETE /api/vpn-profiles/:id ────────────────────────────────────────────
router.delete('/:id', requireAuth, requirePermission('vpnprofile.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const existing = await (prisma as any).vpnProfile.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { subscriptions: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Profile not found' });
    assertProfileUnlocked(existing, req);
    const linked = await prisma.$transaction(tx => prepareProfileEngineLock(tx, existing));
    assertProfileUnlocked(existing, req);
    if (linked.engineAccountId) return res.status(409).json({ error: 'PROFILE_ENGINE_LINKED' });
    if (existing._count.subscriptions > 0) {
      return res.status(409).json({ error: `Cannot delete: profile has ${existing._count.subscriptions} active subscription(s)` });
    }

    await (prisma as any).vpnProfile.delete({ where: profileLockWhere(existing) });
    await logDbActivity(req.user!.userId, `Deleted VPN profile: ${existing.name}`, 'warning', req.ip || '');
    return res.json({ success: true, message: 'Profile deleted' });
  } catch (err: any) {
    if (handleProfileLockError(err, res)) return;
    if (err?.code === 'P2025') return res.status(423).json({ error: 'PROFILE_LOCKED', code: 'PROFILE_LOCKED' });
    return res.status(500).json({ error: 'Failed to delete VPN profile' });
  }
});

// ─── GET /api/vpn-profiles/:id/stats ─────────────────────────────────────────
router.get('/:id/stats', requireAuth, requirePermission('vpnprofile.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const profile = await prisma.vpnProfile.findUnique({ where: { id: req.params.id } });
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    assertProfileUnlocked(profile, req);
    const total     = await (prisma as any).vpnProfile.count();
    const active    = await (prisma as any).vpnProfile.count({ where: { status: 'active' } });
    const byProtocol = await (prisma as any).vpnProfile.groupBy({ where: { id: req.params.id }, by: ['protocol'], _count: { id: true } });
    return res.json({ success: true, total, active, byProtocol });
  } catch (err) {
    if (handleProfileLockError(err, res)) return;
    return res.status(500).json({ error: 'Failed to get stats' });
  }
});

export default router;

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
  parseImportedConfig, canonicalJson, computeCanonicalHash, encryptCanonical,
} from '../services/canonical-config';

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
function buildImportData(rawImport: string, opts: { bumpVersion?: number | null } = {}) {
  const parsed = parseImportedConfig(rawImport);
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
    network: canon.network ?? null,
    path: canon.path ?? null,
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

function maskProfile(p: any) {
  // `delete` est indispensable : affecter `undefined` ne retire pas la clé
  // copiée par le spread, et le blob chiffré ressortait donc dans la réponse.
  const out: any = { ...p };
  delete out.canonicalConfig;
  out.password = p.password ? '••••••••' : null;
  out.jsonConfig = p.jsonConfig ? '(chiffré — non exposé)' : null;
  out.hasCanonicalConfig = !!p.canonicalConfig;
  out.canonicalConfigHash = p.canonicalConfigHash ?? null;
  out.configVersion = p.configVersion ?? 1;
  out.sourceFormat = p.sourceFormat ?? null;
  out.validationStatus = p.validationStatus ?? null;
  out.validationMessage = p.validationMessage ?? null;
  out.validatedAt = p.validatedAt ?? null;
  out.importedAt = p.importedAt ?? null;
  return out;
}

/**
 * Profil masqué + liste des revendeurs attribués, aplatie pour l'interface.
 *
 * `resellers` vide signifie « aucune restriction » : la configuration est alors
 * disponible pour TOUS les revendeurs (voir le modèle VpnProfileReseller). Le
 * drapeau `unrestricted` évite à l'interface de réinterpréter ce cas.
 */
function withResellers(p: any) {
  const out = maskProfile(p);
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
      return res.json({ success: true, profiles: (inMemoryDb.vpnProfiles || []).map(maskProfile) });
    }
    const profiles = await (prisma as any).vpnProfile.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { subscriptions: true } },
        // Attributions : l'administrateur doit voir d'un coup d'œil quels
        // revendeurs reçoivent chaque configuration.
        assignedResellers: {
          include: { reseller: { include: { user: { select: { id: true, name: true, email: true } } } } },
        },
      },
    });
    return res.json({ success: true, profiles: profiles.map(withResellers) });
  } catch (err) {
    console.error('vpn-profiles list error:', err);
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
        select: { id: true, name: true, displayProtocol: true, protocol: true },
        orderBy: { name: 'asc' },
      });
      return res.json({ success: true, profiles: all });
    }

    const reseller = await (prisma as any).reseller.findUnique({ where: { userId: req.user.userId } });
    if (!reseller) return res.json({ success: true, profiles: [] });

    // Un profil sans AUCUNE attribution reste accessible à tous (voir le
    // commentaire du modèle VpnProfileReseller) : restreindre d'office aurait
    // coupé les revendeurs déjà en production.
    const profiles = await (prisma as any).vpnProfile.findMany({
      where: {
        status: 'active',
        OR: [
          { assignedResellers: { none: {} } },
          { assignedResellers: { some: { resellerId: reseller.id } } },
        ],
      },
      select: { id: true, name: true, displayProtocol: true },
      orderBy: { name: 'asc' },
    });
    return res.json({ success: true, profiles });
  } catch (err) {
    console.error('vpn-profiles assigned error:', err);
    return res.status(500).json({ error: 'Failed to list assigned profiles' });
  }
});


// GET /api/vpn-profiles/unified — agrège les profils SSH SXB VPN
router.get("/unified", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) return res.status(503).json({ error: "DB unavailable" });
    const [sshAccs, xrayAccs, singboxAccs] = await Promise.all([
      (prisma as any).sshAccount.findMany({ where: { status: "active" }, orderBy: { createdAt: "desc" } }),
      (prisma as any).xrayAccount.findMany({ where: { status: "active" }, orderBy: { createdAt: "desc" } }),
      (prisma as any).singboxAccount.findMany({ where: { status: "active" }, orderBy: { createdAt: "desc" } }),
    ]);
    const configs: any[] = [];
    async function syncProfile(data: any, namePrefix: string, proto: string) {
      const profileName = namePrefix + data.name;
      let p = await (prisma as any).vpnProfile.findFirst({ where: { name: profileName } });
      if (!p) p = await (prisma as any).vpnProfile.create({ data: {
          name: profileName, description: namePrefix.replace(/[\[\]]/g, "").trim() + " — " + data.name,
          protocol: proto, host: data.host, port: data.port,
          username: data.username || null, password: data.password || null, uuid: data.uuid || null,
          path: data.path || null, network: data.network || (proto === "ssh" ? "tcp" : "ws"),
          tls: data.tls || false, sni: data.sni || null, method: data.method || null, offlineValidDays: 7, status: "active",
      }});
      return p;
    }
    for (const a of sshAccs) { const p = await syncProfile(a, "[SSH] ", "ssh"); configs.push({ id: p.id, name: p.name, protocol: "ssh", host: a.host, port: a.port, sourceType: "ssh", status: a.status }); }
    for (const a of xrayAccs) { const pfx = "[" + a.protocol.toUpperCase() + "] "; const p = await syncProfile(a, pfx, a.protocol); configs.push({ id: p.id, name: p.name, protocol: a.protocol, host: a.host, port: a.port, sourceType: "xray", status: a.status }); }
    for (const a of singboxAccs) { const pfx = "[" + a.protocol.toUpperCase() + "-SB] "; const p = await syncProfile(a, pfx, a.protocol); configs.push({ id: p.id, name: p.name, protocol: a.protocol, host: a.host, port: a.port, sourceType: "singbox", status: a.status }); }
    return res.json({ configs });
  } catch (err) { console.error("Unified configs error:", err); return res.status(500).json({ error: "Server error" }); }
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
    const byProtocol = await (prisma as any).vpnProfile.groupBy({ by: ['protocol'], _count: { id: true } });
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
      return res.json({ success: true, profile: maskProfile(p) });
    }
    const p = await (prisma as any).vpnProfile.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { subscriptions: true } } },
    });
    if (!p) return res.status(404).json({ error: 'Profile not found' });
    return res.json({ success: true, profile: maskProfile(p) });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get VPN profile' });
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

    await (prisma as any).$transaction([
      (prisma as any).vpnProfileReseller.deleteMany({ where: { profileId: profile.id } }),
      ...(validIds.length
        ? [(prisma as any).vpnProfileReseller.createMany({
            data: validIds.map((resellerId) => ({
              profileId: profile.id,
              resellerId,
              assignedBy: req.user!.userId,
            })),
            skipDuplicates: true,
          })]
        : []),
    ]);

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
router.post('/', requireAuth, requirePermission('vpnprofile.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
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
        },
      });
      await logDbActivity(req.user!.userId, `Imported VPN profile: ${name} (${data.sourceFormat})`, 'info', req.ip || '');
      return res.status(201).json({
        success: true,
        profile: maskProfile(profile),
        warnings: [...(parseWarnings || []), ...duplicateWarnings],
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
      },
    });

    await logDbActivity(req.user!.userId, `Created VPN profile (legacy): ${name}`, 'info', req.ip || '');
    return res.status(201).json({ success: true, profile: maskProfile(profile) });
  } catch (err: any) {
    console.error('vpn-profile create error:', err);
    return res.status(500).json({ error: err.message || 'Failed to create VPN profile' });
  }
});

// ─── PUT /api/vpn-profiles/:id ───────────────────────────────────────────────
// Champs ADMINISTRATIFS (name, description, displayProtocol, status, dns,
// offlineValidDays) : toujours éditables.
// Champs TECHNIQUES (protocol, host, port, credentials, tls, sni, network,
// path, payload, jsonConfig…) : IMMUABLES hors « importConfig » (réimport
// explicite → nouveau canonique chiffré + configVersion incrémentée).
router.put('/:id', requireAuth, requirePermission('vpnprofile.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const existing = await (prisma as any).vpnProfile.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Profile not found' });

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
      const updated = await (prisma as any).vpnProfile.update({
        where: { id: req.params.id },
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
      return res.json({ success: true, profile: maskProfile(updated), warnings: parseWarnings, reimported: true });
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
      where: { id: req.params.id },
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
    return res.json({ success: true, profile: maskProfile(updated) });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to update VPN profile' });
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
    if (existing._count.subscriptions > 0) {
      return res.status(409).json({ error: `Cannot delete: profile has ${existing._count.subscriptions} active subscription(s)` });
    }

    await (prisma as any).vpnProfile.delete({ where: { id: req.params.id } });
    await logDbActivity(req.user!.userId, `Deleted VPN profile: ${existing.name}`, 'warning', req.ip || '');
    return res.json({ success: true, message: 'Profile deleted' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to delete VPN profile' });
  }
});

// ─── GET /api/vpn-profiles/:id/stats ─────────────────────────────────────────
router.get('/:id/stats', requireAuth, requirePermission('vpnprofile.view'), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const total     = await (prisma as any).vpnProfile.count();
    const active    = await (prisma as any).vpnProfile.count({ where: { status: 'active' } });
    const byProtocol = await (prisma as any).vpnProfile.groupBy({ by: ['protocol'], _count: { id: true } });
    return res.json({ success: true, total, active, byProtocol });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get stats' });
  }
});

export default router;

/**
 * canonical-config.ts — Modèle « intermédiaire d'import » SXB
 *
 * PRINCIPE (architecture imposée) :
 *   Le dashboard ne crée ni n'installe aucun serveur. Une configuration
 *   externe est IMPORTÉE, validée, stockée CHIFFRÉE et sans altération
 *   technique, puis provisionnée chiffrée à l'appareil.
 *
 * Ce module est la SEULE source de vérité d'un profil importé :
 *   - parseImportedConfig(raw)   → URI/JSON externe → config canonique plate
 *   - normalizeCanonical(cfg)    → JSON déterministe (clés triées récursivement)
 *   - computeCanonicalHash(cfg)  → sha256 hex du JSON normalisé
 *   - encryptCanonical / decryptCanonical → AES-256-GCM (ENCRYPTION_KEY)
 *   - validateTransportCoherence → règles moteur (ssh+tls direct = REJET, …)
 *
 * AUCUN appel réseau ici — le préflight vit dans transport-probe.ts.
 */
import crypto from 'crypto';

// ── Types ────────────────────────────────────────────────────────────────────

export type SourceFormat =
  | 'ssh-json' | 'ssh+payload-json'
  | 'vless-uri' | 'vmess-uri' | 'trojan-uri' | 'ss-uri'
  | 'wireguard-conf' | 'hysteria2-uri' | 'tuic-uri'
  | 'singbox-json' | 'xray-json' | 'sxb-canonical';

export interface ParseResult {
  ok: boolean;
  sourceFormat?: SourceFormat;
  canonical?: Record<string, any>;
  errors: string[];
  warnings: string[];
  displayName?: string;
}

// ── Normalisation déterministe + hash ────────────────────────────────────────

/**
 * Normalise récursivement : objets → clés triées (ordre déterministe),
 * tableaux → ordre conservé (sémantique sing-box outbounds), nombres inchangés.
 */
export function normalizeCanonical(value: any): any {
  if (Array.isArray(value)) return value.map(normalizeCanonical);
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v === undefined) continue;          // undefined ≠ absent → ignoré
      out[key] = normalizeCanonical(v);
    }
    return out;
  }
  return value;
}

export function canonicalJson(cfg: Record<string, any>): string {
  return JSON.stringify(normalizeCanonical(cfg));
}

export function computeCanonicalHash(cfg: Record<string, any>): string {
  return crypto.createHash('sha256').update(canonicalJson(cfg), 'utf8').digest('hex');
}

// ── Chiffrement AES-256-GCM (même format que provision.ts : gcm:iv:ct:tag) ──

function dbKey(): Buffer {
  const k = process.env.ENCRYPTION_KEY;
  if (!k) throw new Error('[SECURITY] ENCRYPTION_KEY non définie — stockage canonique impossible');
  return crypto.createHash('sha256').update(k).digest();
}

export function encryptCanonical(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', dbKey(), iv) as crypto.CipherGCM;
  const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return `gcm:${iv.toString('hex')}:${enc.toString('hex')}:${c.getAuthTag().toString('hex')}`;
}

export function decryptCanonical(blob: string): string | null {
  try {
    if (!blob?.startsWith('gcm:')) return null;
    const parts = blob.slice(4).split(':');
    if (parts.length !== 3) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', dbKey(), Buffer.from(parts[0], 'hex')) as crypto.DecipherGCM;
    d.setAuthTag(Buffer.from(parts[2], 'hex'));
    return Buffer.concat([d.update(Buffer.from(parts[1], 'hex')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ── Validation de cohérence transport (règles du MOTEUR, pas cosmétiques) ────

const VALID_PROTOCOLS = [
  'ssh', 'ssh+payload', 'vless', 'vmess', 'trojan', 'shadowsocks',
  'wireguard', 'hysteria2', 'tuic', 'singbox',
] as const;

const VALID_SS_METHODS = [
  'aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305',
  'aes-128-cfb', 'aes-256-cfb', 'rc4-md5', 'chacha20',
  '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305',
];

function isPort(p: any): boolean {
  const n = Number(p);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

export function validateTransportCoherence(cfg: Record<string, any>): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const proto = String(cfg.protocol ?? '').toLowerCase();

  if (!VALID_PROTOCOLS.includes(proto as any)) {
    errors.push(`protocol inconnu : "${cfg.protocol}" (attendu: ${VALID_PROTOCOLS.join(', ')})`);
    return { errors, warnings };
  }

  // ── Règle #1 incident APK #165 : SSH direct + TLS est IMPOSSIBLE au moteur ──
  // En SSH direct, SxbVpnService ouvre une socket TCP brute (le bouton TLS est
  // ignoré). Décision produit validée : REJET à l'import (pas de SSH-over-TLS).
  if (proto === 'ssh' && cfg.tls === true) {
    errors.push(
      'Combinaison impossible : "ssh" direct avec tls=true — le moteur mobile ignore TLS en SSH direct ' +
      '(socket TCP brute). Choix : 1) tls=false pour du SSH direct, ou 2) protocol "ssh+payload" ' +
      'avec un payload WebSocket/TLS fourni par le fournisseur.'
    );
  }

  // ── Champs requis par protocole ──
  const req = (fields: string[]) => {
    for (const f of fields) {
      const v = cfg[f];
      if (v === undefined || v === null || v === '') errors.push(`champ requis manquant : "${f}" (${proto})`);
    }
  };
  switch (proto) {
    case 'ssh':
    case 'ssh+payload':
      req(['host', 'port', 'username']);
      if (cfg.host) req([]);
      if (cfg.port !== undefined && !isPort(cfg.port)) errors.push(`port invalide : ${cfg.port}`);
      if (!cfg.password && !cfg.privateKeyBase64) errors.push('"password" ou "privateKeyBase64" requis (ssh)');
      if (proto === 'ssh+payload' && !cfg.payload) {
        warnings.push('ssh+payload sans "payload" — le moteur utilisera le payload WebSocket par défaut');
      }
      if (proto === 'ssh+payload' && cfg.payload !== undefined && typeof cfg.payload !== 'string') {
        errors.push('"payload" doit être une chaîne');
      }
      break;
    case 'vless':
      req(['host', 'port', 'uuid']);
      break;
    case 'vmess':
      req(['host', 'port', 'uuid']);
      break;
    case 'tuic':
      req(['host', 'port', 'uuid', 'password']);
      break;
    case 'trojan':
    case 'hysteria2':
      req(['host', 'port', 'password']);
      break;
    case 'shadowsocks':
      req(['host', 'port', 'method', 'password']);
      if (cfg.method && !VALID_SS_METHODS.includes(String(cfg.method).toLowerCase())) {
        warnings.push(`méthode Shadowsocks non standard : "${cfg.method}"`);
      }
      break;
    case 'wireguard':
      req(['privateKey', 'publicKey', 'endpoint']);
      if (cfg.endpoint && !String(cfg.endpoint).includes(':')) {
        errors.push('wireguard "endpoint" attendu au format host:port');
      }
      break;
    case 'singbox':
      if (!Array.isArray(cfg.outbounds) || cfg.outbounds.length === 0) {
        errors.push('singbox : "outbounds" doit être un tableau non vide');
      }
      if (!cfg.inbounds) warnings.push('singbox : "inbounds" absent — le mode TUN peut échouer');
      return { errors, warnings }; // pas de contrôle host/port (outbounds internes)
  }

  if (proto !== 'wireguard' && proto !== 'singbox') {
    if (!cfg.host || !String(cfg.host).trim()) errors.push('"host" requis');
    if (cfg.port !== undefined && !isPort(cfg.port)) errors.push(`port invalide : ${cfg.port}`);
    if (cfg.port === undefined) errors.push('"port" requis');
  }
  if (cfg.tls !== undefined && typeof cfg.tls !== 'boolean') {
    errors.push('"tls" doit être un booléen (true/false)');
  }
  return { errors, warnings };
}

// ── Parseurs URI ─────────────────────────────────────────────────────────────

function parseQuery(raw: string): URLSearchParams {
  return new URLSearchParams(raw || '');
}

function boolParam(v: string | null): boolean | undefined {
  if (v === null) return undefined;
  return ['1', 'true', 'tls', 'yes'].includes(v.toLowerCase());
}

function applyCommonTransport(q: URLSearchParams, out: Record<string, any>): void {
  const security = (q.get('security') || '').toLowerCase();
  if (security) out.tls = security === 'tls' || security === 'reality';
  const sni = q.get('sni');
  if (sni) out.sni = sni;
  const type = (q.get('type') || '').toLowerCase();
  if (type) out.network = type;
  const path = q.get('path');
  if (path) out.path = decodeURIComponent(path);
  const host = q.get('host');
  if (host) out.wsHost = decodeURIComponent(host);
  const fp = q.get('fp');
  if (fp) out.fingerprint = fp;
  const flow = q.get('flow');
  if (flow) out.flow = flow;
  // Reality
  const pbk = q.get('pbk');
  if (pbk) out.publicKey = pbk;
  const sid = q.get('sid');
  if (sid) out.shortId = sid;
  const spx = q.get('spx');
  if (spx) out.spiderX = decodeURIComponent(spx);
}

function parseVlessUri(uri: string, errors: string[]): { cfg: Record<string, any>; name?: string } | null {
  // vless://uuid@host:port?params#name
  const m = uri.match(/^vless:\/\/([^@]+)@([^:/?#]+):(\d+)(\?[^#]*)?(?:#(.*))?$/i);
  if (!m) { errors.push('URI vless malformée (attendu: vless://uuid@host:port?params#nom)'); return null; }
  const cfg: Record<string, any> = {
    protocol: 'vless',
    uuid: decodeURIComponent(m[1]),
    host: m[2],
    port: Number(m[3]),
  };
  applyCommonTransport(parseQuery((m[4] || '').slice(1)), cfg);
  if (cfg.tls === undefined) cfg.tls = false;
  return { cfg, name: m[5] ? decodeURIComponent(m[5]) : undefined };
}

function parseTrojanUri(uri: string, errors: string[]): { cfg: Record<string, any>; name?: string } | null {
  const m = uri.match(/^trojan:\/\/([^@]+)@([^:/?#]+):(\d+)(\?[^#]*)?(?:#(.*))?$/i);
  if (!m) { errors.push('URI trojan malformée'); return null; }
  const cfg: Record<string, any> = {
    protocol: 'trojan',
    password: decodeURIComponent(m[1]),
    host: m[2],
    port: Number(m[3]),
  };
  applyCommonTransport(parseQuery((m[4] || '').slice(1)), cfg);
  if (cfg.tls === undefined) cfg.tls = true; // trojan = TLS par nature
  return { cfg, name: m[5] ? decodeURIComponent(m[5]) : undefined };
}

function parseSsUri(uri: string, errors: string[]): { cfg: Record<string, any>; name?: string } | null {
  // ss://base64(method:pass)@host:port#name  |  ss://method:pass@host:port#name
  let body = uri.replace(/^ss:\/\//i, '');
  let name: string | undefined;
  const hash = body.indexOf('#');
  if (hash >= 0) { name = decodeURIComponent(body.slice(hash + 1)); body = body.slice(0, hash); }
  let userinfo = '', server = '';
  const at = body.lastIndexOf('@');
  if (at >= 0) { userinfo = body.slice(0, at); server = body.slice(at + 1); }
  else {
    try { const dec = Buffer.from(body, 'base64').toString('utf8'); const at2 = dec.lastIndexOf('@');
      if (at2 < 0) { errors.push('URI ss malformée'); return null; }
      userinfo = dec.slice(0, at2); server = dec.slice(at2 + 1);
    } catch { errors.push('URI ss : base64 illisible'); return null; }
  }
  // userinfo peut être base64(method:pass)
  if (!userinfo.includes(':')) {
    try { userinfo = Buffer.from(userinfo.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { /* ignore */ }
  }
  const sep = userinfo.indexOf(':');
  const method = userinfo.slice(0, sep), password = userinfo.slice(sep + 1);
  const hm = server.match(/^([^:]+):(\d+)/);
  if (!method || !password || !hm) { errors.push('URI ss : method/password/host:port introuvables'); return null; }
  return {
    cfg: { protocol: 'shadowsocks', method: decodeURIComponent(method), password: decodeURIComponent(password), host: hm[1], port: Number(hm[2]) },
    name,
  };
}

function parseVmessUri(uri: string, errors: string[]): { cfg: Record<string, any>; name?: string } | null {
  // vmess://base64(json)
  const b64 = uri.replace(/^vmess:\/\//i, '');
  try {
    const j = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    if (!j.add || !j.port || !j.id) { errors.push('vmess : champs add/port/id manquants'); return null; }
    const cfg: Record<string, any> = {
      protocol: 'vmess',
      host: j.add,
      port: Number(j.port),
      uuid: j.id,
    };
    if (j.aid !== undefined) cfg.alterId = Number(j.aid);
    if (j.scy || j.security) cfg.security = j.scy || j.security;
    if (j.net) cfg.network = j.net;
    if (j.path) cfg.path = j.path;
    if (j.host) cfg.wsHost = j.host;
    if (j.type && j.type !== 'none') cfg.headerType = j.type;
    cfg.tls = j.tls === 'tls' || j.tls === true;
    if (j.sni) cfg.sni = j.sni;
    return { cfg, name: j.ps };
  } catch {
    errors.push('vmess : JSON base64 illisible');
    return null;
  }
}

function parseHysteria2Uri(uri: string, errors: string[]): { cfg: Record<string, any>; name?: string } | null {
  const m = uri.match(/^(?:hysteria2|hy2):\/\/([^@]+)@([^:/?#]+):(\d+)(\?[^#]*)?(?:#(.*))?$/i);
  if (!m) { errors.push('URI hysteria2 malformée'); return null; }
  const cfg: Record<string, any> = {
    protocol: 'hysteria2',
    password: decodeURIComponent(m[1]),
    host: m[2],
    port: Number(m[3]),
  };
  const q = parseQuery((m[4] || '').slice(1));
  if (q.get('sni')) cfg.sni = q.get('sni');
  const insecure = boolParam(q.get('insecure'));
  if (insecure !== undefined) cfg.insecure = insecure;
  if (q.get('obfs')) cfg.obfs = q.get('obfs');
  if (q.get('obfs-password')) cfg.obfsPassword = q.get('obfs-password');
  return { cfg, name: m[5] ? decodeURIComponent(m[5]) : undefined };
}

function parseTuicUri(uri: string, errors: string[]): { cfg: Record<string, any>; name?: string } | null {
  const m = uri.match(/^tuic:\/\/([^:@]+):([^@]+)@([^:/?#]+):(\d+)(\?[^#]*)?(?:#(.*))?$/i);
  if (!m) { errors.push('URI tuic malformée (attendu tuic://uuid:password@host:port?params#nom)'); return null; }
  const cfg: Record<string, any> = {
    protocol: 'tuic',
    uuid: decodeURIComponent(m[1]),
    password: decodeURIComponent(m[2]),
    host: m[3],
    port: Number(m[4]),
  };
  const q = parseQuery((m[5] || '').slice(1));
  if (q.get('sni')) cfg.sni = q.get('sni');
  if (q.get('alpn')) cfg.alpn = decodeURIComponent(q.get('alpn')!);
  if (q.get('congestion_control')) cfg.congestionControl = q.get('congestion_control');
  return { cfg, name: m[6] ? decodeURIComponent(m[6]) : undefined };
}

function parseWireguardConf(text: string, errors: string[]): Record<string, any> | null {
  // Format INI [Interface]/[Peer]
  const get = (section: string, key: string): string | null => {
    const re = new RegExp(`\\[${section}\\][^\\[]*?^\\s*${key}\\s*=\\s*(.+?)$`, 'ims');
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };
  const privateKey = get('Interface', 'PrivateKey');
  const publicKey = get('Peer', 'PublicKey');
  const endpoint = get('Peer', 'Endpoint');
  if (!privateKey || !publicKey || !endpoint) {
    errors.push('WireGuard : PrivateKey (Interface), PublicKey et Endpoint (Peer) requis');
    return null;
  }
  const cfg: Record<string, any> = { protocol: 'wireguard', privateKey, publicKey, endpoint };
  const dns = get('Interface', 'DNS'); if (dns) cfg.dns = dns;
  const address = get('Interface', 'Address'); if (address) cfg.address = address;
  const mtu = get('Interface', 'MTU'); if (mtu) cfg.mtu = Number(mtu);
  const keepalive = get('Peer', 'PersistentKeepalive'); if (keepalive) cfg.persistentKeepalive = Number(keepalive);
  const allowed = get('Peer', 'AllowedIPs'); if (allowed) cfg.allowedIps = allowed;
  const psk = get('Peer', 'PresharedKey'); if (psk) cfg.presharedKey = psk;
  return cfg;
}

// ── Parseur principal ────────────────────────────────────────────────────────

export function parseImportedConfig(raw: string): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const text = (raw ?? '').trim();
  if (!text) return { ok: false, errors: ['configuration vide'], warnings };

  let parsed: { cfg: Record<string, any>; name?: string } | null = null;
  let sourceFormat: SourceFormat | null = null;

  if (/^vless:\/\//i.test(text))       { parsed = parseVlessUri(text, errors);      sourceFormat = 'vless-uri'; }
  else if (/^vmess:\/\//i.test(text))  { parsed = parseVmessUri(text, errors);      sourceFormat = 'vmess-uri'; }
  else if (/^trojan:\/\//i.test(text)) { parsed = parseTrojanUri(text, errors);     sourceFormat = 'trojan-uri'; }
  else if (/^ss:\/\//i.test(text))     { parsed = parseSsUri(text, errors);         sourceFormat = 'ss-uri'; }
  else if (/^(hysteria2|hy2):\/\//i.test(text)) { parsed = parseHysteria2Uri(text, errors); sourceFormat = 'hysteria2-uri'; }
  else if (/^tuic:\/\//i.test(text))   { parsed = parseTuicUri(text, errors);       sourceFormat = 'tuic-uri'; }
  else if (/^\s*\[Interface\]/im.test(text)) {
    const cfg = parseWireguardConf(text, errors);
    if (cfg) parsed = { cfg };
    sourceFormat = 'wireguard-conf';
  } else {
    // JSON : singbox natif, canonique SXB, ou heuristiques par contenu
    let obj: any;
    try { obj = JSON.parse(text); }
    catch { errors.push('format non reconnu : ni URI (vless://, vmess://, trojan://, ss://, tuic://, hy2://) ni JSON ni WireGuard conf'); return { ok: false, errors, warnings }; }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      errors.push('le JSON importé doit être un objet');
      return { ok: false, errors, warnings };
    }
    if (Array.isArray(obj.outbounds)) {
      // Xray/v2ray et sing-box ont tous deux « outbounds », mais leur schéma
      // diffère : protocol/settings/streamSettings doit rester intact pour la
      // conversion native Android, au lieu d’être interprété comme du sing-box.
      const isXray = obj.outbounds.some((o: any) => o && (
        typeof o.protocol === 'string' || o.settings?.vnext !== undefined || o.streamSettings !== undefined
      ));
      parsed = { cfg: { ...obj, protocol: 'singbox' } };
      sourceFormat = isXray ? 'xray-json' : 'singbox-json';
    } else if (obj.protocol) {
      const proto = String(obj.protocol).toLowerCase();
      parsed = { cfg: { ...obj, protocol: proto } };
      sourceFormat = proto === 'ssh' ? 'ssh-json' : proto === 'ssh+payload' ? 'ssh+payload-json' : 'sxb-canonical';
    } else {
      errors.push('JSON SXB : champ "protocol" requis (ssh, ssh+payload, vless, vmess, trojan, shadowsocks, wireguard, hysteria2, tuic) ou format sing-box avec "outbounds"');
      return { ok: false, errors, warnings };
    }
  }

  if (!parsed) return { ok: false, errors, warnings };

  // Normalisation des types (port entier, tls booléen)
  const cfg = parsed.cfg;
  if (cfg.port !== undefined) cfg.port = Number(cfg.port);
  if (cfg.tls !== undefined) cfg.tls = cfg.tls === true;

  // Cohérence transport — règles moteur
  const coherence = validateTransportCoherence(cfg);
  errors.push(...coherence.errors);
  warnings.push(...coherence.warnings);

  return {
    ok: errors.length === 0,
    sourceFormat: sourceFormat ?? undefined,
    canonical: errors.length === 0 ? normalizeCanonical(cfg) : undefined,
    errors,
    warnings,
    displayName: parsed.name,
  };
}

// ── Vue moteur : config technique canonique TELLE QUELLE (aucune altération) ─
// Les métadonnées commerciales sont ajoutées SÉPARÉMENT par provision.ts.
export function engineConfigFromCanonical(canonical: Record<string, any>): Record<string, any> {
  return normalizeCanonical(JSON.parse(JSON.stringify(canonical)));
}

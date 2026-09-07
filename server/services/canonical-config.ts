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
 *   - validateTransportCoherence → règles moteur (SSH/TLS/Payload/SlowDNS/UDPGW)
 *
 * AUCUN appel réseau ici — le préflight vit dans transport-probe.ts.
 */
import crypto from 'crypto';
import { translateXrayToSingbox, isSingboxNativeJson, hasXrayMarkers } from './xray-translate';

// ── Types ────────────────────────────────────────────────────────────────────

export type SourceFormat =
  | 'ssh-json' | 'ssh+payload-json'
  | 'http-custom-json'
  | 'vless-uri' | 'vmess-uri' | 'trojan-uri' | 'ss-uri'
  | 'wireguard-conf' | 'hysteria2-uri' | 'tuic-uri'
  | 'uri-list' | 'v2ray-subscription'
  | 'singbox-json' | 'xray-json' | 'v2rayn-json' | 'http-tweak-json' | 'sxb-canonical';

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

function normalizeSshAlias(obj: Record<string, any>): Record<string, any> {
  const raw = String(obj.protocol ?? '').toLowerCase().replace(/\s+/g, '');
  const aliases: Record<string, Partial<Record<string, any>>> = {
    'ssh+tls': { protocol: 'ssh', sshTransport: 'tls', tls: true },
    'ssh+ssl': { protocol: 'ssh', sshTransport: 'tls', tls: true },
    'ssh+payload+tls': { protocol: 'ssh+payload', sshTransport: 'payload-tls', usePayload: true, tls: true },
    'ssh+payload+ssl': { protocol: 'ssh+payload', sshTransport: 'payload-tls', usePayload: true, tls: true },
    'ssh+http': { protocol: 'ssh+payload', sshTransport: 'payload', usePayload: true },
    'ssh+http-connect': { protocol: 'ssh+payload', sshTransport: 'http-connect', usePayload: true, proxyEnabled: true },
    'ssh+proxy': { protocol: 'ssh+payload', sshTransport: 'http-connect', usePayload: true, proxyEnabled: true },
    'ssh+slowdns': { protocol: 'ssh', sshTransport: 'slowdns', slowDns: obj.slowDns ?? true },
    'slowdns': { protocol: 'ssh', sshTransport: 'slowdns', slowDns: obj.slowDns ?? true },
    'ssh+udp': {
      protocol: 'ssh',
      sshTransport: 'direct',
      udpMode: 'udpgw',
      udpGatewayHost: obj.udpGatewayHost || '127.0.0.1',
      udpGatewayPort: obj.udpGatewayPort || 7300,
    },
  };
  return aliases[raw] ? { ...obj, ...aliases[raw] } : obj;
}

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

  // SSH over TLS (« SSL Tunnel ») — anciennement rejeté à l'import.
  //
  // Le moteur ouvrait une socket TCP brute en SSH direct et ignorait le drapeau
  // TLS : contre un serveur qui n'accepte que du TLS sur 443, le handshake SSH
  // partait en clair et la connexion expirait sans message exploitable. Le rejet
  // à l'import était donc justifié tant que le moteur ne savait pas faire.
  //
  // SxbTlsSocketFactory monte désormais TLS avant SSH, sans payload HTTP, ce qui
  // correspond au « SSL Tunnel » des clients de tunneling. La combinaison est
  // donc valide, et la sonde de transport la vérifie réellement : handshake TLS
  // puis recherche de la bannière SSH dans le tunnel.

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
      const sshTransport = String(cfg.sshTransport ?? '').toLowerCase();
      const effectiveSlowDns = cfg.slowDns === true || sshTransport === 'slowdns';
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
      if (cfg.sshTransport !== undefined && ![
        'direct', 'tls', 'payload', 'payload-tls', 'http-connect', 'slowdns',
      ].includes(sshTransport)) {
        errors.push(`transport SSH inconnu : "${cfg.sshTransport}"`);
      }
      if (cfg.localPort !== undefined && !isPort(cfg.localPort)) {
        errors.push(`localPort invalide : ${cfg.localPort}`);
      }
      if (effectiveSlowDns && Number(cfg.localPort) === 1080) {
        errors.push('SlowDNS : localPort 1080 est réservé au relais SOCKS5 de l’application');
      }
      if (cfg.timeoutMs !== undefined) {
        const timeout = Number(cfg.timeoutMs);
        if (!Number.isInteger(timeout) || timeout < 5_000 || timeout > 120_000) {
          errors.push('"timeoutMs" doit être compris entre 5000 et 120000');
        }
      }
      if (cfg.slowDns === false && sshTransport === 'slowdns') {
        errors.push('SlowDNS contradictoire : sshTransport=slowdns mais slowDns=false');
      }
      if (effectiveSlowDns) {
        req(['dns', 'nameServer', 'slowDnsPublicKey', 'localPort']);
        if (cfg.slowDnsPublicKey && !/^[0-9a-f]{64}$/i.test(String(cfg.slowDnsPublicKey))) {
          errors.push('SlowDNS : "slowDnsPublicKey" doit contenir exactement 64 caractères hexadécimaux');
        }
        if (cfg.dns && !/^(?:https:\/\/[^\s]+|tls:\/\/(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d{1,5})?|(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d{1,5})?)$/i.test(String(cfg.dns))) {
          errors.push('SlowDNS : résolveur DNS invalide');
        }
        if (cfg.nameServer && !/^(?=.{1,253}\.?$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.?$/i.test(String(cfg.nameServer))) {
          errors.push('SlowDNS : domaine NSSERVER invalide');
        }
      }
      if (cfg.udpMode !== undefined && !['none', 'udpgw'].includes(String(cfg.udpMode).toLowerCase())) {
        errors.push('SSH UDP : "udpMode" doit valoir "none" ou "udpgw"');
      }
      if (String(cfg.udpMode ?? '').toLowerCase() === 'udpgw') {
        req(['udpGatewayHost', 'udpGatewayPort']);
        if (cfg.udpGatewayPort !== undefined && !isPort(cfg.udpGatewayPort)) {
          errors.push(`udpGatewayPort invalide : ${cfg.udpGatewayPort}`);
        }
      }
      if (cfg.proxyPort !== undefined && !isPort(cfg.proxyPort)) {
        errors.push(`proxyPort invalide : ${cfg.proxyPort}`);
      }
      if (effectiveSlowDns && cfg.proxyEnabled === true && String(cfg.proxyHost ?? '').trim()) {
        errors.push('SlowDNS et proxyHost explicite ne peuvent pas être combinés : le tunnel DNS fournit déjà l’endpoint physique');
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
  if (cfg.insecure !== undefined && typeof cfg.insecure !== 'boolean') {
    errors.push('"insecure" doit être un booléen (true/false)');
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

function stripBom(text: string): string {
  return String(text ?? '').replace(/^\uFEFF/, '');
}

function safeDecodeURIComponent(value: string): string {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

function decodeBase64Flexible(raw: string): string | null {
  const compact = stripBom(raw).trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!compact || compact.length < 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
  const padded = compact + '='.repeat((4 - (compact.length % 4)) % 4);
  try {
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    return stripBom(decoded);
  } catch {
    return null;
  }
}

const URI_LINE_RE = /^(?:vless|vmess|trojan|ss|hysteria2|hy2|tuic):\/\//i;

function uriLinesFromText(text: string): string[] {
  return stripBom(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => URI_LINE_RE.test(line));
}

function detectUriList(raw: string): { lines: string[]; sourceFormat: SourceFormat } | null {
  const text = stripBom(raw ?? '').trim();
  const direct = uriLinesFromText(text);
  if (direct.length > 1) return { lines: direct, sourceFormat: 'uri-list' };

  if (/^(?:\{|\[|vless:\/\/|vmess:\/\/|trojan:\/\/|ss:\/\/|hysteria2:\/\/|hy2:\/\/|tuic:\/\/|\[Interface\])/i.test(text)) return null;
  const decoded = decodeBase64Flexible(text);
  if (!decoded) return null;
  const decodedLines = uriLinesFromText(decoded);
  if (decodedLines.length > 0) return { lines: decodedLines, sourceFormat: 'v2ray-subscription' };
  return null;
}

function applyCommonTransport(q: URLSearchParams, out: Record<string, any>): void {
  const security = (q.get('security') || '').toLowerCase();
  if (security) out.tls = security === 'tls' || security === 'reality';
  const sni = q.get('sni');
  if (sni) out.sni = safeDecodeURIComponent(sni);
  const type = (q.get('type') || '').toLowerCase();
  if (type) out.network = type;
  const path = q.get('path');
  if (path) out.path = decodeURIComponent(path);
  const host = q.get('host');
  if (host) out.wsHost = decodeURIComponent(host);
  const fp = q.get('fp');
  if (fp) out.fingerprint = fp;
  const insecure = q.get('allowInsecure') || q.get('insecure');
  if (insecure) out.insecure = boolParam(insecure);
  const flow = q.get('flow');
  if (flow) out.flow = safeDecodeURIComponent(flow);
  // ALPN — imposé par certains serveurs (h2 seul). Il était ignoré, ce qui
  // faisait échouer le handshake TLS sans diagnostic exploitable.
  const alpn = q.get('alpn');
  if (alpn) out.alpn = decodeURIComponent(alpn);
  // gRPC — le nom de service est porté par `serviceName`, jamais par `path`.
  // Sans lui le moteur retombait sur `path`, donc sur un service inexistant.
  const serviceName = q.get('serviceName');
  if (serviceName) out.grpcServiceName = decodeURIComponent(serviceName);
  // Obfuscation d'en-tête TCP (`headerType=http`).
  const headerType = q.get('headerType');
  if (headerType && headerType.toLowerCase() !== 'none') out.headerType = headerType;
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
    uuid: safeDecodeURIComponent(m[1]),
    host: m[2],
    port: Number(m[3]),
  };
  applyCommonTransport(parseQuery((m[4] || '').slice(1)), cfg);
  if (cfg.tls === undefined) cfg.tls = false;
  return { cfg, name: m[5] ? safeDecodeURIComponent(m[5]) : undefined };
}

function parseTrojanUri(uri: string, errors: string[]): { cfg: Record<string, any>; name?: string } | null {
  const m = uri.match(/^trojan:\/\/([^@]+)@([^:/?#]+):(\d+)(\?[^#]*)?(?:#(.*))?$/i);
  if (!m) { errors.push('URI trojan malformée'); return null; }
  const cfg: Record<string, any> = {
    protocol: 'trojan',
    password: safeDecodeURIComponent(m[1]),
    host: m[2],
    port: Number(m[3]),
  };
  applyCommonTransport(parseQuery((m[4] || '').slice(1)), cfg);
  if (cfg.tls === undefined) cfg.tls = true; // trojan = TLS par nature
  return { cfg, name: m[5] ? safeDecodeURIComponent(m[5]) : undefined };
}

function parseSsUri(uri: string, errors: string[]): { cfg: Record<string, any>; name?: string } | null {
  // ss://base64(method:pass)@host:port#name  |  ss://method:pass@host:port#name
  let body = uri.replace(/^ss:\/\//i, '');
  let name: string | undefined;
  const hash = body.indexOf('#');
  if (hash >= 0) { name = safeDecodeURIComponent(body.slice(hash + 1)); body = body.slice(0, hash); }
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
    const decodedUserinfo = decodeBase64Flexible(userinfo);
    if (decodedUserinfo) userinfo = decodedUserinfo;
  }
  const sep = userinfo.indexOf(':');
  const method = userinfo.slice(0, sep), password = userinfo.slice(sep + 1);
  const hm = server.match(/^([^:]+):(\d+)/);
  if (!method || !password || !hm) { errors.push('URI ss : method/password/host:port introuvables'); return null; }
  return {
    cfg: { protocol: 'shadowsocks', method: safeDecodeURIComponent(method), password: safeDecodeURIComponent(password), host: hm[1], port: Number(hm[2]) },
    name,
  };
}

function parseVmessUri(uri: string, errors: string[]): { cfg: Record<string, any>; name?: string } | null {
  // vmess://base64(json)
  const b64 = uri.replace(/^vmess:\/\//i, '');
  try {
    const decoded = decodeBase64Flexible(b64);
    if (!decoded) throw new Error('base64');
    const j = JSON.parse(decoded);
    return parseVmessShareObject(j, errors);
  } catch {
    errors.push('vmess : JSON base64 illisible');
    return null;
  }
}

function parseVmessShareObject(j: any, errors: string[]): { cfg: Record<string, any>; name?: string } | null {
  const host = j.add ?? j.address ?? j.server;
  const port = j.port ?? j.serverPort;
  const uuid = j.id ?? j.uuid;
  if (!host || !port || !uuid) { errors.push('vmess : champs add/address, port, id manquants'); return null; }
  const network = String(j.net ?? j.network ?? 'tcp').toLowerCase();
  const cfg: Record<string, any> = {
    protocol: 'vmess',
    host: String(host),
    port: Number(port),
    uuid: String(uuid),
  };
  const alterId = j.aid ?? j.alterId;
  if (alterId !== undefined && alterId !== '') cfg.alterId = Number(alterId);
  const security = j.scy ?? j.security;
  if (security) cfg.security = String(security);
  if (network) cfg.network = network;
  const path = j.path ?? j.requestPath;
  if (path) cfg.path = safeDecodeURIComponent(String(path));
  const wsHost = j.requestHost ?? j.wsHost ?? j.host;
  if (wsHost) cfg.wsHost = safeDecodeURIComponent(String(wsHost));
  const headerType = j.type ?? j.headerType;
  if (headerType && String(headerType).toLowerCase() !== 'none') cfg.headerType = String(headerType);
  const tlsValue = j.tls ?? j.streamSecurity;
  cfg.tls = tlsValue === true || String(tlsValue ?? '').toLowerCase() === 'tls';
  if (j.sni) cfg.sni = safeDecodeURIComponent(String(j.sni));
  const fp = j.fp ?? j.fingerprint;
  if (fp) cfg.fingerprint = String(fp);
  if (j.alpn) cfg.alpn = Array.isArray(j.alpn) ? j.alpn.map((v: any) => String(v)).join(',') : String(j.alpn);
  return { cfg, name: j.ps ?? j.remarks ?? j.name };
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

// ── Adaptateur HTTP Tweak V2RAY ──────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseHttpTweakV2ray(obj: any, warnings: string[], errors: string[]): { cfg: Record<string, any>; name?: string } | null {
  const entry = Array.isArray(obj?.configs) ? obj.configs[0] : null;
  const profile = entry?.v2rayProfile;
  if (!profile || typeof profile !== 'object') return null;

  const uuid = String(profile.password ?? '').trim();
  const host = String(profile.server ?? '').trim();
  const port = Number(profile.serverPort ?? 0);
  const network = String(profile.network ?? 'tcp').trim().toLowerCase();
  const security = String(profile.security ?? 'none').trim().toLowerCase();
  if (!UUID_RE.test(uuid)) errors.push('HTTP Tweak V2RAY : password doit contenir un UUID VLESS valide');
  if (!host) errors.push('HTTP Tweak V2RAY : server manquant');
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('HTTP Tweak V2RAY : serverPort invalide');
  if (!['tcp', 'ws', 'grpc'].includes(network)) errors.push(`HTTP Tweak V2RAY : réseau "${network}" non supporté`);
  if (security !== 'none' && security !== 'tls') errors.push(`HTTP Tweak V2RAY : security "${security}" non supportée`);
  if (errors.length > 0) return null;

  if (profile.method && String(profile.method).toLowerCase() !== 'none') {
    warnings.push(`HTTP Tweak V2RAY : method "${profile.method}" ignorée pour le profil VLESS`);
  }
  warnings.push('HTTP Tweak V2RAY : enveloppe convertie en VLESS canonique SXB ; inbounds et lockConfig sont gérés par l’application');
  const cfg: Record<string, any> = {
    protocol: 'vless', host, port, uuid, network,
    tls: security === 'tls',
    insecure: profile.insecure === true,
  };
  if (network === 'ws') {
    cfg.path = String(profile.path || '/');
    cfg.wsHost = String(profile.host || profile.sni || host);
  }
  if (profile.sni) cfg.sni = String(profile.sni);
  return { cfg, name: String(entry?.name || profile.remarks || '').trim() || undefined };
}

function parseV2rayNProfile(obj: any, protocolHint: string | null, errors: string[]): { cfg: Record<string, any>; name?: string } | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const proto = String(protocolHint || obj.protocol || obj.configType || '').toLowerCase();
  const network = String(obj.net ?? obj.network ?? obj.type ?? 'tcp').toLowerCase();
  const host = obj.add ?? obj.address ?? obj.server ?? (obj.host && (obj.id || obj.password) ? obj.host : undefined);
  const port = obj.port ?? obj.serverPort;
  if (!host || !port) return null;

  if (proto === 'vmess' || (!proto && (obj.id || obj.uuid))) {
    return parseVmessShareObject({ ...obj, add: host, port, net: network }, errors);
  }

  const cfg: Record<string, any> = { protocol: proto, host: String(host), port: Number(port) };
  const name = obj.ps ?? obj.remarks ?? obj.name;
  if (proto === 'vless') {
    const uuid = obj.id ?? obj.uuid ?? obj.password;
    if (!uuid) return null;
    cfg.uuid = String(uuid);
    if (obj.flow) cfg.flow = String(obj.flow);
  } else if (proto === 'trojan') {
    const password = obj.password ?? obj.id;
    if (!password) return null;
    cfg.password = String(password);
  } else if (proto === 'shadowsocks' || proto === 'ss') {
    const method = obj.method ?? obj.security;
    const password = obj.password ?? obj.pass;
    if (!method || !password) return null;
    cfg.protocol = 'shadowsocks';
    cfg.method = String(method);
    cfg.password = String(password);
  } else {
    return null;
  }

  if (network) cfg.network = network;
  const tlsValue = obj.tls ?? obj.streamSecurity ?? obj.security;
  cfg.tls = tlsValue === true || String(tlsValue ?? '').toLowerCase() === 'tls';
  const path = obj.path ?? obj.requestPath;
  if (path) cfg.path = safeDecodeURIComponent(String(path));
  const wsHost = obj.requestHost ?? obj.wsHost ?? ((obj.add || obj.address || obj.server) ? obj.host : undefined);
  if (wsHost) cfg.wsHost = safeDecodeURIComponent(String(wsHost));
  if (obj.sni) cfg.sni = safeDecodeURIComponent(String(obj.sni));
  const headerType = obj.headerType ?? (obj.type && String(obj.type).toLowerCase() !== network ? obj.type : undefined);
  if (headerType && String(headerType).toLowerCase() !== 'none') cfg.headerType = String(headerType);
  const fp = obj.fp ?? obj.fingerprint;
  if (fp) cfg.fingerprint = String(fp);
  if (obj.alpn) cfg.alpn = Array.isArray(obj.alpn) ? obj.alpn.map((v: any) => String(v)).join(',') : String(obj.alpn);
  return { cfg, name };
}

function collectV2rayNProfiles(obj: any): Array<{ item: any; protocolHint: string | null }> {
  const found: Array<{ item: any; protocolHint: string | null }> = [];
  const seen = new Set<any>();
  const arrayHints: Record<string, string> = {
    vmess: 'vmess', vless: 'vless', trojan: 'trojan',
    shadowsocks: 'shadowsocks', ss: 'shadowsocks',
  };
  const visit = (value: any, keyHint: string | null, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 5 || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, keyHint, depth + 1);
      return;
    }
    const parsed = parseV2rayNProfile(value, keyHint, []);
    if (parsed) found.push({ item: value, protocolHint: keyHint });
    for (const [key, child] of Object.entries(value)) {
      const nextHint = arrayHints[key.toLowerCase()] ?? null;
      if (Array.isArray(child) || (child && typeof child === 'object' && ['profiles', 'servers', 'configs', 'subscriptions'].includes(key.toLowerCase()))) {
        visit(child, nextHint, depth + 1);
      }
    }
  };
  visit(obj, null, 0);
  return found;
}

function parseV2rayNJson(obj: any, warnings: string[], errors: string[]): { cfg: Record<string, any>; name?: string; total: number } | null {
  const profiles = collectV2rayNProfiles(obj);
  for (const profile of profiles) {
    const parsed = parseV2rayNProfile(profile.item, profile.protocolHint, errors);
    if (parsed) return { ...parsed, total: profiles.length };
  }
  return null;
}

// ── HTTP Custom / SSH Injector ───────────────────────────────────────────────

/**
 * Les exports HTTP Custom utilisent des clés en majuscules, parfois séparées
 * par des espaces (`PAYLOAD ENABLED`) ou des tirets. Une table normalisée évite
 * une cascade fragile de variantes orthographiques.
 */
function externalFields(obj: Record<string, any>): Map<string, any> {
  const fields = new Map<string, any>();
  for (const [key, value] of Object.entries(obj)) {
    fields.set(key.toUpperCase().replace(/[^A-Z0-9]/g, ''), value);
  }
  return fields;
}

function externalValue(fields: Map<string, any>, ...names: string[]): any {
  for (const name of names) {
    const key = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (fields.has(key)) return fields.get(key);
  }
  return undefined;
}

function externalBoolean(value: any): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value ?? '').trim().toLowerCase());
}

function isHttpCustomEntry(entry: any): entry is Record<string, any> {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const fields = externalFields(entry);
  const address = externalValue(fields, 'ADDRESS', 'HOST', 'SERVER');
  const username = externalValue(fields, 'USERNAME', 'USER');
  const marker = externalValue(fields, 'PAYLOAD ENABLED', 'PROXY ENABLED', 'NSSERVER', 'LOCALPORT', 'TYPE');
  return !!address && !!username && marker !== undefined;
}

function httpCustomEntries(obj: any): Record<string, any>[] {
  if (!obj || typeof obj !== 'object') return [];
  if (Array.isArray(obj)) return obj.length > 0 && obj.every(isHttpCustomEntry) ? obj : [];
  const fields = externalFields(obj);
  const configs = externalValue(fields, 'CONFIGS');
  if (Array.isArray(configs)) {
    const entries = configs.filter((entry) => entry && typeof entry === 'object');
    return entries.length > 0 && entries.every(isHttpCustomEntry) ? entries : [];
  }
  // Une entrée unitaire porte au minimum ADDRESS + USERNAME et un marqueur
  // propre aux injecteurs SSH. Cela évite de voler les JSON canoniques SXB.
  const marker = externalValue(fields, 'PAYLOAD ENABLED', 'PROXY ENABLED', 'NSSERVER', 'LOCALPORT', 'TYPE');
  const address = externalValue(fields, 'ADDRESS', 'HOST', 'SERVER');
  const username = externalValue(fields, 'USERNAME', 'USER');
  return address && username && marker !== undefined ? [obj] : [];
}

function parseHttpCustomProfile(
  obj: Record<string, any>,
  warnings: string[],
  errors: string[],
): { cfg: Record<string, any>; name?: string } | null {
  // Un canonique SXB emploie `protocol` en minuscules : ne jamais le
  // reclassifier comme export HTTP Custom au seul motif qu'il possède host et
  // username.
  if (typeof obj.protocol === 'string') return null;
  const fields = externalFields(obj);
  const host = String(externalValue(fields, 'ADDRESS', 'HOST', 'SERVER') ?? '').trim();
  const username = String(externalValue(fields, 'USERNAME', 'USER') ?? '').trim();
  const password = String(externalValue(fields, 'PASSWORD', 'PASS') ?? '');
  const externalMarker = externalValue(
    fields,
    'PAYLOAD ENABLED',
    'PROXY ENABLED',
    'NSSERVER',
    'LOCALPORT',
    'TYPE',
  );
  if (!host || !username || externalMarker === undefined) return null;

  const port = Number(externalValue(fields, 'PORT', 'SERVER PORT') ?? 22);
  const type = String(externalValue(fields, 'TYPE', 'CONNECTION TYPE', 'MODE') ?? '').trim().toLowerCase();
  const payloadEnabled = externalBoolean(externalValue(fields, 'PAYLOAD ENABLED', 'PAYLOADENABLED'));
  const proxyEnabled = externalBoolean(externalValue(fields, 'PROXY ENABLED', 'PROXYENABLED'));
  const dns = String(externalValue(fields, 'DNS', 'DNS SERVER', 'RESOLVER') ?? '').trim();
  const nameServer = String(externalValue(fields, 'NSSERVER', 'NS SERVER', 'TUNNEL DOMAIN') ?? '').trim();
  const slowDnsPublicKey = String(externalValue(fields, 'PUBKEY', 'PUBLIC KEY', 'DNSTT PUBLIC KEY') ?? '').trim();
  const explicitSlowDns = externalValue(fields, 'SLOWDNS', 'SLOW DNS', 'SLOWDNS ENABLED');
  const slowDns = explicitSlowDns !== undefined
    ? externalBoolean(explicitSlowDns)
    : /slow\s*dns|dns\s*tunnel/i.test(type)
      || (!!dns && !!nameServer && /^[0-9a-f]{64}$/i.test(slowDnsPublicKey));
  const udpEnabled = externalBoolean(externalValue(fields, 'UDP', 'UDP ENABLED', 'UDPENABLED'))
    || /udp(?:\s*relay|\s*over\s*tcp)?/i.test(type);
  const tls = externalBoolean(externalValue(fields, 'TLS', 'TLS ENABLED'))
    || /(?:^|[+ _-])(tls|ssl)(?:$|[+ _-])/i.test(type);
  const insecure = externalBoolean(externalValue(
    fields,
    'INSECURE',
    'ALLOW INSECURE',
    'SKIP CERT VERIFY',
  ));
  const rawPayload = String(externalValue(
    fields,
    'PAYLOAD',
    'PAYLOAD CONTENT',
    'HTTP PAYLOAD',
    'CUSTOM PAYLOAD',
  ) ?? '').trim();
  const usePayload = payloadEnabled || proxyEnabled || rawPayload.length > 0
    || /payload|http(?:\s*connect)?|proxy/i.test(type);
  const defaultPayload =
    'CONNECT [host_port] HTTP/1.1[crlf]' +
    'Host: [host_port][crlf]' +
    'Proxy-Connection: Keep-Alive[crlf]' +
    'Connection: Keep-Alive[crlf][crlf]';

  const localPort = Number(externalValue(fields, 'LOCALPORT', 'LOCAL PORT') ?? (slowDns ? 2222 : 1080));
  const timeoutMs = Number(externalValue(fields, 'TIMEOUT', 'CONNECT TIMEOUT') ?? 30_000);
  const proxyHost = String(externalValue(fields, 'PROXY HOST', 'PROXYHOST') ?? '').trim();
  const proxyPortRaw = externalValue(fields, 'PROXY PORT', 'PROXYPORT');
  const udpGatewayHost = String(externalValue(fields, 'UDP GATEWAY HOST', 'UDPGWHOST') ?? '127.0.0.1').trim();
  const udpGatewayPort = Number(externalValue(fields, 'UDP GATEWAY PORT', 'UDPGWPORT') ?? 7300);

  if (usePayload && !rawPayload) {
    warnings.push('Payload activé sans contenu : modèle HTTP CONNECT sûr appliqué automatiquement');
  }
  if (proxyEnabled && !proxyHost) {
    warnings.push('Proxy activé sans hôte proxy distinct : ADDRESS/PORT seront utilisés comme point de connexion');
  }
  if (slowDns && explicitSlowDns === undefined) {
    warnings.push('SlowDNS activé automatiquement : DNS + NSSERVER + PUBKEY valide détectés');
  }
  if (udpEnabled) {
    warnings.push(`UDP sur SSH nécessite BadVPN udpgw sur ${udpGatewayHost}:${udpGatewayPort}`);
  }

  const sshTransport = slowDns
    ? 'slowdns'
    : usePayload && tls
      ? 'payload-tls'
      : usePayload
        ? (proxyEnabled ? 'http-connect' : 'payload')
        : tls
          ? 'tls'
          : 'direct';

  const cfg: Record<string, any> = {
    protocol: usePayload ? 'ssh+payload' : 'ssh',
    sshTransport,
    host,
    port,
    username,
    password,
    tls,
    usePayload,
    proxyEnabled,
    localPort,
    timeoutMs,
    compressionLevel: Number(externalValue(fields, 'COMPRESSIONLEVEL', 'COMPRESSION LEVEL') ?? 0),
  };
  if (insecure) {
    cfg.insecure = true;
    warnings.push('Vérification du nom TLS désactivée explicitement par le profil');
  }
  if (rawPayload || usePayload) cfg.payload = rawPayload || defaultPayload;
  const sni = String(externalValue(fields, 'SNI', 'SERVER NAME') ?? '').trim();
  if (sni) cfg.sni = sni;
  if (dns) cfg.dns = dns;
  if (nameServer) cfg.nameServer = nameServer;
  if (slowDnsPublicKey) cfg.slowDnsPublicKey = slowDnsPublicKey;
  if (slowDns) cfg.slowDns = true;
  if (proxyHost) cfg.proxyHost = proxyHost;
  if (proxyPortRaw !== undefined && proxyPortRaw !== '') cfg.proxyPort = Number(proxyPortRaw);
  if (udpEnabled) {
    cfg.udpMode = 'udpgw';
    cfg.udpGatewayHost = udpGatewayHost;
    cfg.udpGatewayPort = udpGatewayPort;
  }
  const fingerprint = String(externalValue(fields, 'FINGERPRINT', 'SSH FINGERPRINT') ?? '').trim();
  if (fingerprint) cfg.fingerprint = fingerprint;

  return {
    cfg,
    name: String(externalValue(fields, 'CONFIGNAME', 'CONFIG NAME', 'NAME') ?? '').trim() || undefined,
  };
}

// ── Parseur principal ────────────────────────────────────────────────────────

export function parseImportedConfig(raw: string): ParseResult {
  const list = detectUriList(raw);
  if (list) {
    const first = parseImportedConfigSingle(list.lines[0]);
    first.sourceFormat = list.sourceFormat;
    const others = Math.max(0, list.lines.length - 1);
    if (others > 0) first.warnings.push(`${others} autres configurations détectées — importez-les séparément`);
    return first;
  }
  try {
    const obj = JSON.parse(stripBom(raw ?? '').trim());
    const profiles = httpCustomEntries(obj);
    if (profiles.length > 0) {
      const first = parseImportedConfigSingle(JSON.stringify(profiles[0]));
      const others = Math.max(0, profiles.length - 1);
      if (others > 0) first.warnings.push(`${others} autres configurations HTTP Custom détectées — utilisez l'import multiple`);
      return first;
    }
  } catch { /* le parseur unitaire produira l'erreur détaillée */ }
  return parseImportedConfigSingle(raw);
}

export function parseImportedConfigList(raw: string): ParseResult[] {
  const list = detectUriList(raw);
  if (list) return list.lines.map((line) => parseImportedConfigSingle(line));
  try {
    const obj = JSON.parse(stripBom(raw ?? '').trim());
    const profiles = httpCustomEntries(obj);
    if (profiles.length > 0) return profiles.map((profile) => parseImportedConfigSingle(JSON.stringify(profile)));
  } catch { /* retour unitaire ci-dessous */ }
  const single = parseImportedConfigSingle(raw);
  if (single.ok && single.sourceFormat === 'v2rayn-json') {
    try {
      const obj = JSON.parse(stripBom(raw ?? '').trim());
      const profiles = collectV2rayNProfiles(obj);
      if (profiles.length > 1) return profiles.map(({ item, protocolHint }) => {
        const errors: string[] = [];
        const parsed = parseV2rayNProfile(item, protocolHint, errors);
        if (!parsed) return { ok: false, sourceFormat: 'v2rayn-json' as SourceFormat, errors, warnings: [] };
        const coherence = validateTransportCoherence(parsed.cfg);
        const allErrors = [...errors, ...coherence.errors];
        return {
          ok: allErrors.length === 0,
          sourceFormat: 'v2rayn-json' as SourceFormat,
          canonical: allErrors.length === 0 ? normalizeCanonical(parsed.cfg) : undefined,
          errors: allErrors,
          warnings: coherence.warnings,
          displayName: parsed.name,
        };
      });
    } catch { /* retour unitaire ci-dessous */ }
  }
  return [single];
}

function parseImportedConfigSingle(raw: string): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const text = stripBom(raw ?? '').trim();
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
    // JSON : détection stricte sing-box natif / Xray / canonique SXB
    let obj: any;
    try { obj = JSON.parse(text); }
    catch { errors.push('format non reconnu : ni URI (vless://, vmess://, trojan://, ss://, tuic://, hy2://) ni JSON ni WireGuard conf'); return { ok: false, errors, warnings }; }
    if (Array.isArray(obj)) {
      const v2rayN = parseV2rayNJson(obj, warnings, errors);
      if (v2rayN) {
        parsed = v2rayN;
        sourceFormat = 'v2rayn-json';
        const others = Math.max(0, v2rayN.total - 1);
        if (others > 0) warnings.push(`${others} autres configurations détectées — importez-les séparément`);
      } else {
        errors.push('le JSON importé doit être un objet');
        return { ok: false, errors, warnings };
      }
    } else if (typeof obj !== 'object' || obj === null) {
      errors.push('le JSON importé doit être un objet');
      return { ok: false, errors, warnings };
    } else {
    const httpCustom = parseHttpCustomProfile(obj, warnings, errors);
    if (httpCustom) {
      parsed = httpCustom;
      sourceFormat = 'http-custom-json';
    }
    else {
    const httpTweak = parseHttpTweakV2ray(obj, warnings, errors);
    if (httpTweak) {
      parsed = httpTweak;
      sourceFormat = 'http-tweak-json';
    }
    // sing-box natif : outbounds[] d'objets ayant un champ type (string)
    // ET absence de markers Xray (PARTIE 1 — détection stricte).
    else if (isSingboxNativeJson(obj)) {
      parsed = { cfg: { ...obj, protocol: 'singbox' } };
      sourceFormat = 'singbox-json';
    } else if (hasXrayMarkers(obj)) {
      // Xray/v2ray : traduction immédiate vers sing-box (PARTIE 2).
      const t = translateXrayToSingbox(obj);
      if (!t.ok) {
        errors.push(...t.errors);
        return { ok: false, errors, warnings };
      }
      warnings.push(...t.warnings);
      parsed = { cfg: { ...t.singboxJson!, protocol: 'singbox' } };
      sourceFormat = 'xray-json';
    } else {
      const v2rayN = parseV2rayNJson(obj, warnings, errors);
      if (v2rayN) {
        parsed = v2rayN;
        sourceFormat = 'v2rayn-json';
        const others = Math.max(0, v2rayN.total - 1);
        if (others > 0) warnings.push(`${others} autres configurations détectées — importez-les séparément`);
      }
    }
    if (!parsed && obj.protocol) {
      const normalized = normalizeSshAlias(obj);
      const proto = String(normalized.protocol).toLowerCase();
      parsed = { cfg: { ...normalized, protocol: proto } };
      sourceFormat = proto === 'ssh' ? 'ssh-json' : proto === 'ssh+payload' ? 'ssh+payload-json' : 'sxb-canonical';
    } else if (obj.protocol) {
      // déjà traité par un format plus spécifique.
    } else if (!parsed) {
      errors.push('JSON non reconnu : ni HTTP Custom, sing-box ni Xray — champ "protocol" requis (ssh, ssh+payload, vless, vmess, trojan, shadowsocks, wireguard, hysteria2, tuic) pour le format canonique SXB');
      return { ok: false, errors, warnings };
    }
    }
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

// ── Vue moteur : config technique prête pour le moteur mobile ────────────────
// Les anciens profils peuvent avoir été stockés avant la traduction Xray. Leur
// hash DB reste volontairement vérifié sur le contenu historique ; seule la
// copie destinée à libbox est réparée à la volée.
function normalizeSingboxTransportCompatibility(cfg: Record<string, any>): Record<string, any> {
  const outbounds = Array.isArray(cfg.outbounds) ? cfg.outbounds : [];
  for (const outbound of outbounds) {
    if (!outbound || typeof outbound !== 'object') continue;
    const transport = outbound.transport;
    if (!transport || typeof transport !== 'object') continue;
    if (String(transport.type ?? '').toLowerCase() !== 'ws' || transport.host === undefined) continue;
    const headers = transport.headers && typeof transport.headers === 'object'
      ? transport.headers
      : {};
    if (headers.Host === undefined && headers.host === undefined) {
      const legacyHost = Array.isArray(transport.host) ? transport.host[0] : transport.host;
      if (typeof legacyHost === 'string' && legacyHost.trim()) headers.Host = legacyHost;
    }
    transport.headers = headers;
    delete transport.host;
  }
  return cfg;
}

export function engineConfigFromCanonical(canonical: Record<string, any>): Record<string, any> {
  const copy = JSON.parse(JSON.stringify(canonical)) as Record<string, any>;
  if (hasXrayMarkers(copy)) {
    const translated = translateXrayToSingbox(copy);
    if (!translated.ok || !translated.singboxJson) {
      throw new Error(`Configuration Xray historique non traduisible : ${translated.errors.join(' | ')}`);
    }
    return normalizeCanonical(normalizeSingboxTransportCompatibility({ ...translated.singboxJson, protocol: 'singbox' }));
  }
  return normalizeCanonical(normalizeSingboxTransportCompatibility(copy));
}

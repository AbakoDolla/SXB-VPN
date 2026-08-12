/**
 * configValidator.ts — Validation des configurations VPN SXB
 *
 * Protocoles supportés :
 *   SSH, SSH+Payload, VLESS, VMess, Trojan, Shadowsocks,
 *   WireGuard, Hysteria2, TUIC, Sing-box JSON natif
 *
 * Usage :
 *   const result = validateVpnConfig(raw);
 *   if (!result.valid) console.error(result.errors);
 */

export type SupportedProtocol =
  | 'ssh' | 'ssh+payload'
  | 'vless' | 'vmess' | 'trojan' | 'shadowsocks'
  | 'wireguard' | 'hysteria2' | 'tuic'
  | 'singbox';

export interface ValidationResult {
  valid:    boolean;
  protocol: SupportedProtocol | null;
  errors:   string[];
  warnings: string[];
  config:   Record<string, any> | null;
}

// ── Champs requis par protocole ──────────────────────────────────────────────

// Note : 'payload' n'est PAS requis pour ssh+payload.
// Le moteur natif (SxbVpnService.kt) utilise un payload WebSocket par défaut
// si le champ payload est absent ou vide.
// Une vérification non-bloquante (warning) est effectuée dans extraValidation().
const REQUIRED_FIELDS: Record<SupportedProtocol, string[]> = {
  'ssh':         ['host', 'port', 'username'],
  'ssh+payload': ['host', 'port', 'username'],
  'vless':       ['host', 'port', 'uuid'],
  'vmess':       ['host', 'port', 'uuid'],
  'trojan':      ['host', 'port', 'password'],
  'shadowsocks': ['host', 'port', 'method', 'password'],
  'wireguard':   ['privateKey', 'publicKey', 'endpoint'],
  'hysteria2':   ['host', 'port', 'password'],
  'tuic':        ['host', 'port', 'uuid', 'password'],
  'singbox':     ['outbounds'],   // sing-box JSON natif
};

// ── Détection stricte du format JSON (PARTIE 1 — miroir du backend) ───────────

/**
 * Marqueurs Xray/v2ray : au moins un de ces éléments suffit à classer un
 * JSON comme « Xray » (et non sing-box). Miroir de hasXrayMarkers() backend.
 */
export function hasXrayMarkers(obj: Record<string, any>): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const outbounds = Array.isArray(obj.outbounds) ? obj.outbounds : [];
  // outbounds[].protocol (string)
  if (outbounds.some((o: any) => o && typeof o.protocol === 'string')) return true;
  // settings.vnext
  if (outbounds.some((o: any) => o?.settings?.vnext !== undefined)) return true;
  // streamSettings
  if (outbounds.some((o: any) => o?.streamSettings !== undefined)) return true;
  // inbound protocol: dokodemo-door
  if (Array.isArray(obj.inbounds) && obj.inbounds.some((i: any) => i?.protocol === 'dokodemo-door')) return true;
  // dns.servers[] commençant par tcp+local:// ou https+local://
  if (Array.isArray(obj.dns?.servers)
    && obj.dns.servers.some((s: any) => typeof s === 'string' && /^(tcp|https)\+local:\/\//i.test(s))) return true;
  // outbound protocol: blackhole | freedom
  if (outbounds.some((o: any) => o?.protocol === 'blackhole' || o?.protocol === 'freedom')) return true;
  return false;
}

/**
 * sing-box natif : outbounds[] d'objets ayant un champ type (string) ET
 * absence de markers Xray. Miroir de isSingboxNativeJson() backend.
 */
export function isSingboxNativeJson(obj: Record<string, any>): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (!Array.isArray(obj.outbounds) || obj.outbounds.length === 0) return false;
  if (!obj.outbounds.every((o: any) => o && typeof o.type === 'string')) return false;
  return !hasXrayMarkers(obj);
}

// ── Détection du protocole ────────────────────────────────────────────────────

/**
 * Détection du protocole depuis les champs présents (exportée pour VpnContext.connect()).
 * Utilisée comme fallback quand le champ protocol est vide/absent.
 */
export function detectProtocolFromFields(obj: Record<string, any>): SupportedProtocol | null {
  return detectProtocol(obj);
}

function detectProtocol(obj: Record<string, any>): SupportedProtocol | null {
  // Un JSON Xray complet transporte ses paramètres dans outbounds/settings et
  // doit être remis tel quel au convertisseur Android, sans exiger host/port
  // à la racine comme une URI VLESS aplatie.
  if (hasXrayMarkers(obj) && Array.isArray(obj.outbounds)) return 'singbox';

  const raw = (obj.protocol ?? obj.type ?? '').toString().toLowerCase().trim();

  if (raw === 'ssh')              return 'ssh';
  if (raw === 'ssh+payload' || raw === 'ssh_payload') return 'ssh+payload';
  if (raw === 'vless')            return 'vless';
  if (raw === 'vmess')            return 'vmess';
  if (raw === 'trojan')           return 'trojan';
  if (raw === 'shadowsocks' || raw === 'ss') return 'shadowsocks';
  if (raw === 'wireguard' || raw === 'wg')   return 'wireguard';
  if (raw === 'hysteria2' || raw === 'hy2')  return 'hysteria2';
  if (raw === 'tuic')             return 'tuic';

  if (hasXrayMarkers(obj)) return 'vless';
  if (isSingboxNativeJson(obj)) return 'singbox';

  // Heuristiques
  if (obj.uuid && obj.flow)                        return 'vless';
  if (obj.uuid && obj.alterId !== undefined)       return 'vmess';
  if (obj.uuid && obj.password)                    return 'tuic';
  if (obj.password && obj.sni && !obj.method)      return 'trojan';
  if (obj.method && obj.password)                  return 'shadowsocks';
  if (obj.privateKey && obj.endpoint)              return 'wireguard';
  if (obj.payload && obj.username)                 return 'ssh+payload';
  if (obj.username && (obj.password || obj.privateKeyBase64)) return 'ssh';

  return null;
}

// ── Validations spécifiques par protocole ─────────────────────────────────────

function validatePort(port: any, errors: string[]): boolean {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    errors.push(`Port invalide : ${port} (doit être entre 1 et 65535)`);
    return false;
  }
  return true;
}

function validateUUID(uuid: any, errors: string[]): boolean {
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid || !re.test(String(uuid))) {
    errors.push(`UUID invalide : "${uuid}"`);
    return false;
  }
  return true;
}

const VALID_SS_METHODS = [
  'aes-128-gcm','aes-256-gcm','chacha20-ietf-poly1305',
  'aes-128-cfb','aes-256-cfb','rc4-md5','chacha20',
  '2022-blake3-aes-128-gcm','2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305',
];

function extraValidation(
  proto: SupportedProtocol,
  obj: Record<string, any>,
  errors: string[],
  warnings: string[],
): void {
  switch (proto) {
    case 'ssh':
    case 'ssh+payload':
      if (obj.port !== undefined) validatePort(obj.port, errors);
      if (!obj.password && !obj.privateKeyBase64) {
        errors.push('SSH : "password" ou "privateKeyBase64" requis');
      }
      if (proto === 'ssh' && obj.tls === true) {
        // Mission §6.2 — « SSH direct + TLS » est REJETÉ : le moteur natif
        // ignore TLS en SSH direct (SxbLoggingSocketFactory = socket TCP brut,
        // SxbVpnService.kt l.447-457) — c'est la cause du SSH_TIMEOUT de
        // l'incident APK #165. Si le fournisseur expose SSH derrière TLS, le
        // transport doit être « ssh+payload » (WebSocket/HTTP + TLS réel).
        errors.push(
          'SSH direct + TLS activé : combinaison REJETÉE — le tunnel SSH direct ' +
          'n\'applique pas TLS (connexion impossible : timeout). Utilisez ' +
          '« ssh+payload » (WebSocket/HTTP) si le serveur exige TLS, ou désactivez TLS.',
        );
      }
      if (proto === 'ssh+payload') {
        if (obj.payload !== undefined && typeof obj.payload !== 'string') {
          errors.push('SSH+Payload : "payload" doit être une chaîne (ou absent pour utiliser le payload WebSocket par défaut)');
        } else if (!obj.payload) {
          warnings.push('SSH+Payload : "payload" absent — le moteur utilisera le payload WebSocket par défaut');
        }
      }
      break;

    case 'vless':
    case 'vmess':
    case 'tuic':
      validatePort(obj.port, errors);
      validateUUID(obj.uuid, errors);
      break;

    case 'trojan':
      validatePort(obj.port, errors);
      if (!obj.password || obj.password.length < 4) {
        errors.push('Trojan : mot de passe trop court (min 4 caractères)');
      }
      break;

    case 'shadowsocks':
      validatePort(obj.port, errors);
      if (!VALID_SS_METHODS.includes(String(obj.method).toLowerCase())) {
        warnings.push(`Méthode Shadowsocks non standard : "${obj.method}"`);
      }
      break;

    case 'wireguard':
      if (!obj.privateKey || obj.privateKey.length < 40) {
        errors.push('WireGuard : "privateKey" invalide (trop court)');
      }
      if (!obj.endpoint || !obj.endpoint.includes(':')) {
        errors.push('WireGuard : "endpoint" doit être au format "host:port"');
      }
      break;

    case 'hysteria2':
      validatePort(obj.port, errors);
      if (!obj.password || obj.password.length < 4) {
        errors.push('Hysteria2 : "password" requis (min 4 caractères)');
      }
      break;

    case 'singbox':
      if (!Array.isArray(obj.outbounds) || obj.outbounds.length === 0) {
        errors.push('Sing-box : "outbounds" doit être un tableau non vide');
      } else if (!hasXrayMarkers(obj) && !obj.outbounds.every((o: any) => o && typeof o.type === 'string')) {
        errors.push('Sing-box : chaque outbound doit avoir un champ "type" (string)');
      }
      if (!obj.inbounds && !hasXrayMarkers(obj)) {
        warnings.push('Sing-box : champ "inbounds" absent — le mode TUN peut ne pas fonctionner');
      }
      break;
  }
}

// ── Validateur principal ──────────────────────────────────────────────────────

export function validateVpnConfig(raw: string | Record<string, any>): ValidationResult {
  const errors:   string[] = [];
  const warnings: string[] = [];

  // 1. Parse si c'est une chaîne
  let obj: Record<string, any>;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      return { valid: false, protocol: null, errors: ['La configuration est vide'], warnings, config: null };
    }
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return {
        valid: false, protocol: null,
        errors: ['JSON invalide — vérifiez la syntaxe de votre configuration'],
        warnings, config: null,
      };
    }
  } else {
    obj = raw;
  }

  // 2. Doit être un objet
  if (typeof obj !== 'object' || Array.isArray(obj) || obj === null) {
    return { valid: false, protocol: null, errors: ['La configuration doit être un objet JSON'], warnings, config: null };
  }

  // 3. Détecter protocole
  const protocol = detectProtocol(obj);
  if (!protocol) {
    // Config stockée contenant des markers Xray (backend buggé) : message
    // clair au lieu d'un plantage du moteur (PARTIE 3 §4).
    // Support natif des configurations Xray/V2Ray
    if (hasXrayMarkers(obj)) {
      // Traité comme vless / singbox
    }
    if (Array.isArray(obj.outbounds)) {
      return {
        valid: false, protocol: null,
        errors: [
          'JSON non reconnu : ni sing-box ni Xray — les outbounds doivent avoir un champ "type" (string)',
        ],
        warnings, config: null,
      };
    }
    return {
      valid: false, protocol: null,
      errors: [
        'Protocole non reconnu. Ajoutez le champ "protocol" avec une valeur parmi : ' +
        'ssh, ssh+payload, vless, vmess, trojan, shadowsocks, wireguard, hysteria2, tuic, singbox',
      ],
      warnings, config: null,
    };
  }

  // 4. Vérifier champs obligatoires
  const required = REQUIRED_FIELDS[protocol];
  for (const field of required) {
    if (obj[field] === undefined || obj[field] === null || obj[field] === '') {
      errors.push(`Champ requis manquant : "${field}" (protocole : ${protocol})`);
    }
  }

  // 5. Validations spécifiques
  extraValidation(protocol, obj, errors, warnings);

  // 6. Avertissements généraux
  if (!obj.host && protocol !== 'wireguard' && protocol !== 'singbox') {
    warnings.push('Le champ "host" est absent — assurez-vous que le serveur est bien spécifié');
  }

  const valid = errors.length === 0;

  return {
    valid,
    protocol,
    errors,
    warnings,
    config: valid ? { ...obj, protocol } : null,
  };
}

// ── Utilitaire : valider et retourner config nettoyée ou lancer une erreur ────

export function parseAndValidateConfig(raw: string | Record<string, any>): Record<string, any> {
  const result = validateVpnConfig(raw);
  if (!result.valid || !result.config) {
    throw new Error(
      `Configuration VPN invalide :\n${result.errors.join('\n')}`
    );
  }
  return result.config;
}

// ── Validation de complétude Offline ───────────────────────────────────────────
// Une configuration Offline est considérée "complète" si elle contient au
// minimum les champs nécessaires au démarrage du moteur VPN sans nouvel
// appel API : host, port, protocol, et les credentials du protocole.
// Cette fonction est le gardien qui empêche toute sauvegarde d'une config
// incomplète dans SecureStore.

export interface CompletenessResult {
  complete:   boolean;
  missing:    string[];
  hasHost:    boolean;
  hasCreds:   boolean;
  hasPayload: boolean;
  protocol:   string | null;
}

export function isCompleteOfflineConfig(cfg: Record<string, any> | null | undefined): CompletenessResult {
  const missing: string[] = [];
  if (!cfg || typeof cfg !== 'object') {
    return { complete: false, missing: ['config'], hasHost: false, hasCreds: false, hasPayload: false, protocol: null };
  }

  const protocol = (cfg.protocol ?? cfg.type ?? '').toString().toLowerCase().trim() || null;
  const embeddedXray = hasXrayMarkers(cfg) && Array.isArray(cfg.outbounds) && cfg.outbounds.length > 0;
  const hasHost  = !!(cfg.host && String(cfg.host).trim());
  const hasPort  = cfg.port !== undefined && cfg.port !== null && Number(cfg.port) > 0;
  const hasPayload = !!(cfg.payload && String(cfg.payload).trim());

  // Credentials selon le protocole. Un Xray complet les conserve dans vnext/users.
  let hasCreds = false;
  if (embeddedXray) {
    hasCreds = true;
  } else if (protocol === 'ssh' || protocol === 'ssh+payload') {
    hasCreds = !!(cfg.username && (cfg.password || cfg.privateKeyBase64));
  } else if (protocol === 'vless' || protocol === 'vmess' || protocol === 'tuic') {
    hasCreds = !!(cfg.uuid);
  } else if (protocol === 'trojan' || protocol === 'hysteria2') {
    hasCreds = !!(cfg.password);
  } else if (protocol === 'shadowsocks') {
    hasCreds = !!(cfg.password && cfg.method);
  } else if (protocol === 'wireguard') {
    hasCreds = !!(cfg.privateKey && cfg.endpoint);
  } else if (protocol === 'singbox') {
    hasCreds = Array.isArray(cfg.outbounds) && cfg.outbounds.length > 0;
  } else {
    // Protocole inconnu — accepter username/uuid/password comme credentials génériques
    hasCreds = !!(cfg.username || cfg.uuid || cfg.password);
  }

  if (!hasHost && protocol !== 'wireguard' && protocol !== 'singbox' && !embeddedXray) missing.push('host');
  if (!hasPort && protocol !== 'wireguard' && protocol !== 'singbox' && !embeddedXray) missing.push('port');
  if (!protocol) missing.push('protocol');
  if (!hasCreds) missing.push('credentials');

  return {
    complete: missing.length === 0,
    missing,
    hasHost,
    hasCreds,
    hasPayload,
    protocol,
  };
}

// ── Fusion intelligente de configurations ─────────────────────────────────────
// ⚠️ LEGACY (correctif PR #8 — conservée pour compatibilité, NE PLUS UTILISER
// pour les champs techniques : voir mergeProvisionedConfig / mergeConnectionMetadata).
// Conserve les champs valides de l'ancienne config, remplace uniquement
// les champs présents et non-nuls dans la nouvelle. Ne perd jamais host,
// payload, credentials, ou paramètres de protocole.

/**
 * @deprecated Fusion historique (correctif PR #8). Le modèle « intermédiaire »
 * (mission §6) interdit toute fusion de champs techniques depuis des sources
 * non provisionnées : utiliser `mergeProvisionedConfig` (provisionné = seule
 * source technique) et `mergeConnectionMetadata` (allowlist métadonnées).
 */
export function mergeConfigs(
  oldCfg: Record<string, any> | null | undefined,
  newCfg: Record<string, any>,
): Record<string, any> {
  const base = oldCfg && typeof oldCfg === 'object' ? { ...oldCfg } : {};
  const merged: Record<string, any> = { ...base };

  for (const [key, value] of Object.entries(newCfg)) {
    // Ne remplacer que si la nouvelle valeur est présente et non-nulle
    if (value !== undefined && value !== null && value !== '') {
      merged[key] = value;
    }
  }

  // Préserver explicitement les champs critiques si absents de la nouvelle
  if (oldCfg) {
    if (!merged.host && oldCfg.host) merged.host = oldCfg.host;
    if (!merged.port && oldCfg.port) merged.port = oldCfg.port;
    if (!merged.protocol && oldCfg.protocol) merged.protocol = oldCfg.protocol;
    if (!merged.username && oldCfg.username) merged.username = oldCfg.username;
    if (!merged.password && oldCfg.password) merged.password = oldCfg.password;
    if (!merged.uuid && oldCfg.uuid) merged.uuid = oldCfg.uuid;
    if (!merged.payload && oldCfg.payload) merged.payload = oldCfg.payload;
    if (!merged.sni && oldCfg.sni) merged.sni = oldCfg.sni;
    if (!merged.tls && oldCfg.tls) merged.tls = oldCfg.tls;
    if (!merged.path && oldCfg.path) merged.path = oldCfg.path;
    if (!merged.flow && oldCfg.flow) merged.flow = oldCfg.flow;
    if (!merged.method && oldCfg.method) merged.method = oldCfg.method;
    if (!merged.privateKey && oldCfg.privateKey) merged.privateKey = oldCfg.privateKey;
    if (!merged.endpoint && oldCfg.endpoint) merged.endpoint = oldCfg.endpoint;
  }

  return merged;
}

// ═════════════════════════════════════════════════════════════════════════════
// FUSION SÛRE — modèle « intermédiaire » (mission §6)
// ═════════════════════════════════════════════════════════════════════════════
//
// Règle d'or : les champs TECHNIQUES (protocol, host, port, username, password,
// uuid, tls, sni, network, dns, payload, path, method, credentials, paramètres
// crypto...) proviennent EXCLUSIVEMENT de la configuration provisionnée
// déchiffrée (/provision/activate) — jamais d'une réponse de métadonnées
// (/mobile/connections, /mobile/vpn/config).

/**
 * Allowlist MÉTADONNÉES (mission §6.4) — les SEULES clés qu'une source non
 * provisionnée peut apporter à la configuration persistée.
 */
export const CONNECTION_METADATA_KEYS: readonly string[] = [
  'displayProtocol', 'profileName', 'profileId', 'configId', 'subscriptionId',
  'dataToken', 'quotaGB', 'quotaUsedGB', 'quota', 'expireAt', 'configExpiresAt',
  'provisionedAt', 'configVersion', 'configHash', 'signature', 'deviceId',
  'name', 'status', 'duration', 'durationDays', 'createdAt',
];

/**
 * Fusion d'une source NON provisionnée (/mobile/connections, /mobile/vpn/config).
 * ALLOWLIST MÉTADONNÉES UNIQUEMENT — aucun champ technique n'est jamais lu,
 * même s'il est présent dans la source (mission §6.4). La config `base`
 * (provisionnée) est retournée avec ses champs techniques intacts.
 */
export function mergeConnectionMetadata(
  base: Record<string, any> | null | undefined,
  meta: Record<string, any> | null | undefined,
): Record<string, any> {
  const merged: Record<string, any> = base && typeof base === 'object' ? { ...base } : {};
  if (!meta || typeof meta !== 'object') return merged;
  for (const key of CONNECTION_METADATA_KEYS) {
    if ((meta as any)[key] !== undefined) merged[key] = (meta as any)[key];
  }
  return merged;
}

/**
 * Fusion de la CONFIG PROVISIONNÉE — seule source technique autorisée (§6.1).
 * - La config fraîche fait FOI pour TOUS les champs techniques : tls:false
 *   explicite, payload/sni absents = valeurs fournisseur EXACTES (jamais
 *   complétées depuis l'ancien cache — fin de la fusion destructive).
 * - Seules les métadonnées (allowlist) absentes du frais sont reprises du prev.
 */
export function mergeProvisionedConfig(
  prev: Record<string, any> | null | undefined,
  freshProvisioned: Record<string, any>,
): Record<string, any> {
  const merged: Record<string, any> = { ...freshProvisioned };
  if (prev && typeof prev === 'object') {
    for (const key of CONNECTION_METADATA_KEYS) {
      if (merged[key] === undefined && (prev as any)[key] !== undefined) {
        merged[key] = (prev as any)[key];
      }
    }
  }
  return merged;
}

/**
 * Nettoie la config moteur avant sérialisation vers le natif (mission §6.4).
 * Supprime TOUTES les propriétés null/undefined : côté Android, AOSP
 * JSONObject.optString(name, fallback) lit JSONObject.NULL.toString() ==
 * "null" — c'est ce qui produisait payload_len=4 dans l'incident APK #165.
 * Aucun champ null ne doit jamais atteindre le JSON moteur natif.
 */
export function sanitizeEngineConfig(cfg: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(cfg || {})) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

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

const REQUIRED_FIELDS: Record<SupportedProtocol, string[]> = {
  'ssh':         ['host', 'port', 'username'],
  'ssh+payload': ['host', 'port', 'username', 'payload'],
  'vless':       ['host', 'port', 'uuid'],
  'vmess':       ['host', 'port', 'uuid'],
  'trojan':      ['host', 'port', 'password'],
  'shadowsocks': ['host', 'port', 'method', 'password'],
  'wireguard':   ['privateKey', 'publicKey', 'endpoint'],
  'hysteria2':   ['host', 'port', 'password'],
  'tuic':        ['host', 'port', 'uuid', 'password'],
  'singbox':     ['outbounds'],   // sing-box JSON natif
};

// ── Détection du protocole ────────────────────────────────────────────────────

function detectProtocol(obj: Record<string, any>): SupportedProtocol | null {
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

  // Détection sing-box JSON natif (champ "outbounds" présent)
  if (Array.isArray(obj.outbounds)) return 'singbox';

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
      if (proto === 'ssh+payload' && typeof obj.payload !== 'string') {
        errors.push('SSH+Payload : "payload" doit être une chaîne');
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
      }
      if (!obj.inbounds) {
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

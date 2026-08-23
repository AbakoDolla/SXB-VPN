/**
 * ProtocolDetector — Détection automatique du protocole VPN SXB
 *
 * Analyse la configuration reçue (depuis le dashboard ou importée) et
 * retourne le protocole canonique à utiliser ainsi que les options dérivées.
 *
 * Protocoles supportés :
 *   ssh | ssh+payload | vless | vmess | trojan | shadowsocks |
 *   wireguard | hysteria2 | tuic | singbox
 *
 * Usage :
 *   const result = ProtocolDetector.detect(rawConfig);
 *   if (result.protocol) startVpn({ ...rawConfig, protocol: result.protocol });
 */

import { parseVpnUri } from './vlessUri';

export type DetectableProtocol =
  | 'ssh' | 'ssh+payload'
  | 'vless' | 'vmess' | 'trojan' | 'shadowsocks'
  | 'wireguard' | 'hysteria2' | 'tuic' | 'singbox';

export interface DetectionResult {
  /** Protocole détecté, ou null si non reconnu */
  protocol: DetectableProtocol | null;
  /** Configuration normalisée prête pour le module natif */
  config:   Record<string, any>;
  /** Vrai si la détection est certaine (champ "protocol" explicite) */
  certain:  boolean;
  /** Raison textuelle si détection échouée */
  reason:   string | null;
}

// ── Normalisation des alias de noms de protocoles ────────────────────────────

const PROTOCOL_ALIASES: Record<string, DetectableProtocol> = {
  // SSH
  'ssh':         'ssh',
  'ssh+payload': 'ssh+payload',
  'ssh_payload': 'ssh+payload',
  'sshpayload':  'ssh+payload',
  // V2Ray / Xray
  'vless':       'vless',
  'vmess':       'vmess',
  'trojan':      'trojan',
  'trojan-go':   'trojan',
  // Shadowsocks
  'shadowsocks': 'shadowsocks',
  'ss':          'shadowsocks',
  // WireGuard
  'wireguard':   'wireguard',
  'wg':          'wireguard',
  // Hysteria
  'hysteria2':   'hysteria2',
  'hy2':         'hysteria2',
  'hysteria':    'hysteria2',
  // TUIC
  'tuic':        'tuic',
  // Sing-box natif
  'singbox':     'singbox',
  'sing-box':    'singbox',
};

// ── Classe principale ──────────────────────────────────────────────────────

export class ProtocolDetector {

  /**
   * Détecte le protocole depuis une configuration brute.
   * @param raw  Objet de configuration (peut venir du backend ou d'un import manuel)
   */
  static detect(raw: Record<string, any> | string): DetectionResult {
    let input: Record<string, any>;
    if (typeof raw === 'string') {
      const text = raw.trim();
      if (!text) return { protocol: null, config: {}, certain: false, reason: 'Configuration vide' };
      try {
        const uri = parseVpnUri(text);
        input = uri ? uri.config : JSON.parse(text);
      } catch (error: any) {
        return { protocol: null, config: {}, certain: false, reason: error?.message || 'URI/JSON invalide' };
      }
    } else {
      input = raw;
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { protocol: null, config: {}, certain: false, reason: 'Configuration nulle ou invalide' };
    }

    // 1. Champ "protocol" explicite → détection certaine
    const explicitRaw = (input.protocol ?? input.type ?? '').toString().toLowerCase().trim();
    if (explicitRaw) {
      const mapped = PROTOCOL_ALIASES[explicitRaw] ?? null;
      if (mapped) {
        return {
          protocol: mapped,
          config:   ProtocolDetector._normalize(input, mapped),
          certain:  true,
          reason:   null,
        };
      }
    }

    // 2. Heuristiques sur les champs présents
    const guessed = ProtocolDetector._guessFromFields(input);
    if (guessed) {
      return {
        protocol: guessed,
        config:   ProtocolDetector._normalize(input, guessed),
        certain:  false,
        reason:   null,
      };
    }

    return {
      protocol: null,
      config:   input,
      certain:  false,
      reason:
        'Protocole non détectable. Ajoutez le champ "protocol" avec une valeur parmi : ' +
        Object.keys(PROTOCOL_ALIASES).join(', '),
    };
  }

  /**
   * Détecte et valide — lève une Error si le protocole est inconnu.
   */
  static detectOrThrow(raw: Record<string, any> | string): Required<Omit<DetectionResult, 'reason'>> & { reason: null } {
    const result = ProtocolDetector.detect(raw);
    if (!result.protocol) {
      throw new Error(result.reason ?? 'Protocole VPN inconnu');
    }
    return { ...result, protocol: result.protocol, reason: null };
  }

  // ── Heuristiques ──────────────────────────────────────────────────────────

  private static _guessFromFields(obj: Record<string, any>): DetectableProtocol | null {
    // Détection stricte sing-box natif : outbounds[] d'objets avec "type"
    // (string) ET absence de markers Xray (PARTIE 1 — miroir backend).
    const hasXrayMarkers = (o: Record<string, any>): boolean => {
      const outbounds = Array.isArray(o.outbounds) ? o.outbounds : [];
      return outbounds.some((x: any) => typeof x?.protocol === 'string')
        || outbounds.some((x: any) => x?.settings?.vnext !== undefined)
        || outbounds.some((x: any) => x?.streamSettings !== undefined)
        || (Array.isArray(o.inbounds) && o.inbounds.some((i: any) => i?.protocol === 'dokodemo-door'))
        || (Array.isArray(o.dns?.servers) && o.dns.servers.some((s: any) => typeof s === 'string' && /^(tcp|https)\+local:\/\//i.test(s)))
        || outbounds.some((x: any) => x?.protocol === 'blackhole' || x?.protocol === 'freedom');
    };
    if (hasXrayMarkers(obj)) return 'vless';
    if (Array.isArray(obj.outbounds) && obj.outbounds.length > 0
      && obj.outbounds.every((x: any) => x && typeof x.type === 'string')
      && !hasXrayMarkers(obj)) return 'singbox';

    // VLESS : uuid + flow
    if (obj.uuid && obj.flow !== undefined)            return 'vless';
    // VMess : uuid + alterId
    if (obj.uuid && obj.alterId !== undefined)         return 'vmess';
    // TUIC : uuid + password (sans flow ni alterId)
    if (obj.uuid && obj.password && !obj.flow && obj.alterId === undefined) return 'tuic';
    // Trojan : password + sni (pas de method)
    if (obj.password && obj.sni && !obj.method)        return 'trojan';
    // Shadowsocks : method + password
    if (obj.method && obj.password)                    return 'shadowsocks';
    // WireGuard : privateKey + endpoint
    if (obj.privateKey && obj.endpoint)                return 'wireguard';
    // Hysteria2 : port + password + (hy2 / obfs)
    if (obj.password && (obj.obfs || obj.upMbps || obj.downMbps)) return 'hysteria2';
    // SSH+Payload : payload + username
    if (obj.payload && obj.username)                   return 'ssh+payload';
    // SSH : username + (password | privateKeyBase64)
    if (obj.username && (obj.password || obj.privateKeyBase64)) return 'ssh';

    return null;
  }

  // ── Normalisation de la config ─────────────────────────────────────────────

  /**
   * Normalise les alias de champs courants pour uniformiser la config
   * quelle que soit sa source (dashboard, v2rayN, qr-code, etc.)
   */
  private static _normalize(
    raw: Record<string, any>,
    protocol: DetectableProtocol,
  ): Record<string, any> {
    const out: Record<string, any> = { ...raw, protocol };

    // Alias de champ "host"
    if (!out.host) out.host = raw.address ?? raw.add ?? raw.server ?? '';
    // Alias de champ "port"
    if (!out.port) out.port = Number(raw.server_port ?? raw.serverPort ?? 0);
    // Alias uuid
    if (!out.uuid) out.uuid = raw.id ?? '';
    // Alias password pour certains formats
    if (!out.password && raw.id && (protocol === 'trojan' || protocol === 'tuic')) {
      out.password = raw.id;
    }
    // Alias network/transport
    if (!out.network) out.network = raw.net ?? raw.transport ?? 'tcp';
    // Alias path
    if (!out.path) out.path = raw.wsPath ?? raw.ws_opts?.path ?? '/';
    // Alias TLS
    if (out.tls === undefined) {
      out.tls =
        raw.tls === 'tls' || raw.tls === true ||
        raw.security === 'tls' || raw.security === 'reality' || false;
    }
    // Alias SNI
    if (!out.sni) out.sni = raw.serverName ?? raw.server_name ?? raw.host ?? '';

    // SSH+Payload : dériver usePayload
    if (protocol === 'ssh+payload') out.usePayload = true;

    return out;
  }

  /**
   * Retourne true si le protocole utilise le moteur SSH (JSch).
   */
  static isSSHBased(protocol: DetectableProtocol | string | null): boolean {
    return protocol === 'ssh' || protocol === 'ssh+payload';
  }

  /**
   * Retourne true si le protocole utilise le moteur sing-box.
   */
  static isSingBoxBased(protocol: DetectableProtocol | string | null): boolean {
    return !ProtocolDetector.isSSHBased(protocol) && protocol !== null;
  }

  /**
   * Retourne une description courte pour l'affichage dans l'interface.
   */
  static describe(protocol: DetectableProtocol | string | null): string {
    const descriptions: Record<string, string> = {
      'ssh':         'SSH direct (JSch)',
      'ssh+payload': 'SSH + Payload HTTP Injector',
      'vless':       'VLESS (V2Ray/Xray)',
      'vmess':       'VMess (V2Ray)',
      'trojan':      'Trojan',
      'shadowsocks': 'Shadowsocks',
      'wireguard':   'WireGuard',
      'hysteria2':   'Hysteria2 (QUIC)',
      'tuic':        'TUIC (QUIC)',
      'singbox':     'Sing-box (config native)',
    };
    return (protocol && descriptions[protocol]) ?? 'Protocole inconnu';
  }

  /**
   * Retourne la liste de tous les protocoles reconnus.
   */
  static supportedProtocols(): DetectableProtocol[] {
    return [
      'ssh', 'ssh+payload',
      'vless', 'vmess', 'trojan', 'shadowsocks',
      'wireguard', 'hysteria2', 'tuic', 'singbox',
    ];
  }
}

export default ProtocolDetector;

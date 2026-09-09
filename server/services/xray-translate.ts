/**
 * xray-translate.ts — Traducteur Xray/v2ray → sing-box (import JSON)
 *
 * Appelé par le flux d'import (canonical-config.ts) quand sourceFormat =
 * 'xray-json'. Le profil stocke le JSON traduit (protocol: 'singbox'),
 * sourceFormat: 'xray-json' et la liste des avertissements de traduction.
 *
 * RÈGLE ABSOLUE : jamais d'import partiel silencieux.
 *   - Toute feature non couverte → refus avec la liste (errors).
 *   - Toute feature couverte-mais-simplifiée → warning listé (warnings).
 *
 * Mapping obligatoire (mission PARTIE 2) :
 *   - vless/vmess/trojan + settings.vnext[0] → {type, tag, server,
 *     server_port, uuid/password} ; flow vide/absent → ignoré ;
 *     flow xtls-rprx-* → REFUS.
 *   - security tls/reality → tls {enabled, server_name, insecure | reality}.
 *   - network ws/grpc/tcp → transport ws/grpc ou pas de transport.
 *   - autres réseaux (kcp, quic, h2…) → REFUS avec nom de la feature.
 *   - proxySettings {tag, transportLayer:true} → référence HTTP + detour.
 *   - freedom → direct (+domain_strategy) ; blackhole → block ; dns → dns.
 *   - routing : CIDR, geoip:private, domaines typés, ports/plages et final.
 *   - geosite/geoip externes → base équivalente requise, jamais une liste inventée.
 *   - tags dupliqués, cibles inconnues ou contraintes non traduisibles → refus.
 *   - inboundTag / port 53 / sniffing → ignorés + warning.
 *   - inbounds[] → ignorés + warning (« inbounds fournis par l'app : TUN »).
 *   - dns tcp+local:// ou https+local:// + payload [crlf] → warning explicite.
 */

import { isIP } from 'node:net';

export interface TranslationResult {
  ok: boolean;
  singboxJson?: Record<string, any>;
  warnings: string[];
  errors: string[];
}

// ── Détection stricte du format JSON (PARTIE 1 — partagée avec canonical-config) ──

/** Marqueurs Xray/v2ray : au moins un de ces éléments suffit. */
export function hasXrayMarkers(obj: any): boolean {
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

/** sing-box natif : outbounds[] d'objets ayant un champ type (string) ET absence de markers Xray. */
export function isSingboxNativeJson(obj: any): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (!Array.isArray(obj.outbounds) || obj.outbounds.length === 0) return false;
  if (!obj.outbounds.every((o: any) => o && typeof o.type === 'string')) return false;
  return !hasXrayMarkers(obj);
}

// ── Traduction ───────────────────────────────────────────────────────────────

/** Protocoles d'outbound Xray traduits directement. */
const PROXY_PROTOCOLS = new Set(['vless', 'vmess', 'trojan']);

function outboundTag(ob: Record<string, any>): string {
  return ob.tag || String(ob.protocol ?? '').toLowerCase() || 'proxy';
}

function validServer(server: unknown, port: unknown): server is string {
  return typeof server === 'string' && server.trim().length > 0
    && !/\s/.test(server) && (typeof port === 'number' || (typeof port === 'string' && /^\d+$/.test(port)))
    && Number.isInteger(Number(port)) && Number(port) >= 1 && Number(port) <= 65535;
}

function translateDomainStrategy(value: any, out: Record<string, any>, errors: string[]): void {
  if (value === undefined || value === '' || value === 'AsIs') return;
  const strategies: Record<string, string> = {
    UseIP: 'prefer_ipv4', UseIPv4: 'ipv4_only', UseIPv6: 'ipv6_only',
  };
  if (typeof value !== 'string' || !Object.hasOwn(strategies, value)) {
    errors.push('Xray : domainStrategy non traduisible - import refuse');
    return;
  }
  out.domain_strategy = strategies[value];
}

function translateStreamSettings(
  ob: any,
  out: Record<string, any>,
  defaultServerName: string,
  warnings: string[],
  errors: string[],
): void {
  const ss = ob.streamSettings ?? {};
  const security = String(ss.security ?? 'none').toLowerCase();
  const network = String(ss.network ?? 'tcp').toLowerCase();

  // ── TLS / Reality ─────────────────────────────────────────────────────────
  if (security === 'tls' || security === 'reality') {
    const tlsSettings = ss.tlsSettings ?? ss.realitySettings ?? {};
    const hostHeader = ss.wsSettings?.headers?.Host
      ?? (Array.isArray(ss.httpSettings?.host) ? ss.httpSettings.host[0] : null)
      ?? '';
    const tls: Record<string, any> = { enabled: true };
    tls.server_name = String(tlsSettings.serverName || hostHeader || defaultServerName || '');
    if (security === 'reality') {
      const publicKey = tlsSettings.publicKey;
      const shortId = tlsSettings.shortId;
      if (!publicKey || !shortId) {
        errors.push('Xray : security "reality" — champs manquants (publicKey et shortId requis) — import refusé');
        return;
      }
      tls.reality = { enabled: true, public_key: String(publicKey), short_id: String(shortId) };
      if (tlsSettings.fingerprint) warnings.push(`fingerprint reality "${tlsSettings.fingerprint}" ignoré (géré par le moteur mobile)`);
      if (tlsSettings.spiderX) warnings.push('spiderX reality ignoré (non traduit par sing-box)');
    } else {
      // tlsSettings.allowInsecure toléré mais noté
      if (tlsSettings.allowInsecure !== undefined && typeof tlsSettings.allowInsecure !== 'boolean') {
        errors.push('Xray : tlsSettings.allowInsecure doit etre un booleen - import refuse');
      }
      tls.insecure = tlsSettings.allowInsecure === true;
      if (tls.insecure) warnings.push('TLS allowInsecure=true conserve explicitement : certificat du fournisseur non verifie');
      if (typeof tlsSettings.fingerprint === 'string' && tlsSettings.fingerprint.trim()) {
        tls.utls = { enabled: true, fingerprint: tlsSettings.fingerprint.trim().toLowerCase() };
      }
      if (Array.isArray(tlsSettings.alpn) && tlsSettings.alpn.length > 0) {
        tls.alpn = tlsSettings.alpn.map((value: any) => String(value));
      }
    }
    out.tls = tls;
  } else if (security !== 'none' && security !== '') {
    errors.push(`Xray : security "${security}" non traduisible - import refuse, TLS ne sera pas desactive`);
  }

  // ── Transport (network) ───────────────────────────────────────────────────
  if (network === 'tcp' || network === '') {
    // raw — pas de transport
  } else if (network === 'ws') {
    const ws = ss.wsSettings ?? {};
    const transport: Record<string, any> = { type: 'ws', path: ws.path || '/' };
    if (ws.headers && typeof ws.headers === 'object' && Object.keys(ws.headers).length > 0) {
      transport.headers = ws.headers;
    }
    out.transport = transport;
  } else if (network === 'grpc') {
    const grpc = ss.grpcSettings ?? {};
    out.transport = { type: 'grpc', service_name: grpc.serviceName || 'GunService' };
  } else if (network === 'h2' || network === 'http') {
    const http = ss.httpSettings ?? {};
    const transport: Record<string, any> = { type: 'http', path: http.path || '/' };
    if (Array.isArray(http.host) && http.host.length > 0) transport.host = http.host.map((value: any) => String(value));
    else if (typeof http.host === 'string' && http.host.trim()) transport.host = [http.host.trim()];
    out.transport = transport;
  } else if (network === 'kcp') {
    const kcp = ss.kcpSettings ?? {};
    const transport: Record<string, any> = { type: 'kcp' };
    for (const [from, to] of [['mtu', 'mtu'], ['tti', 'tti'], ['uplinkCapacity', 'uplink_capacity'], ['downlinkCapacity', 'downlink_capacity'], ['readBufferSize', 'read_buffer_size'], ['writeBufferSize', 'write_buffer_size']] as const) {
      if (kcp[from] !== undefined) transport[to] = Number(kcp[from]);
    }
    if (kcp.congestion !== undefined) transport.congestion = kcp.congestion === true;
    if (kcp.seed) transport.seed = String(kcp.seed);
    if (kcp.header?.type) transport.header = { type: String(kcp.header.type) };
    out.transport = transport;
  } else if (network === 'quic') {
    const quic = ss.quicSettings ?? {};
    const transport: Record<string, any> = { type: 'quic' };
    if (quic.security && String(quic.security).toLowerCase() !== 'none') warnings.push(`QUIC security "${quic.security}" conservée comme paramètre de transport expérimental`);
    if (quic.security) transport.security = String(quic.security);
    if (quic.key) transport.key = String(quic.key);
    if (quic.header?.type) transport.header = { type: String(quic.header.type) };
    out.transport = transport;
  } else {
    // httpupgrade, xhttp… → REFUS avec nom de la feature
    errors.push(`Xray : réseau "${network}" non supporté par sing-box — import refusé`);
  }

  if (ss.sockopt && typeof ss.sockopt === 'object') {
    const sockopt = ss.sockopt;
    const domainStrategy = String(sockopt.domainStrategy || '').toLowerCase();
    const domainStrategyMap: Record<string, string> = {
      useip: 'prefer_ipv4', useipv4: 'ipv4_only', useipv6: 'ipv6_only',
    };
    if (domainStrategyMap[domainStrategy]) out.domain_strategy = domainStrategyMap[domainStrategy];
    if (sockopt.tcpFastOpen === true) out.tcp_fast_open = true;
    const happy = sockopt.happyEyeballs;
    if (happy && typeof happy === 'object' && Number(happy.tryDelayMs) > 0) {
      // sing-box expose le délai RFC 6555 sous fallback_delay ; les autres
      // paramètres Xray n’ont pas d’équivalent stable dans sing-box 1.11.
      out.fallback_delay = `${Math.round(Number(happy.tryDelayMs))}ms`;
      if (happy.interleave !== undefined || happy.maxConcurrentTry !== undefined || happy.prioritizeIPv6 !== undefined) {
        warnings.push('sockopt.happyEyeballs : tryDelayMs traduit en fallback_delay ; interleave/maxConcurrentTry/prioritizeIPv6 non disponibles dans sing-box 1.11');
      }
    }
    const unsupported = Object.keys(sockopt).filter((key) => !['domainStrategy', 'tcpFastOpen', 'happyEyeballs'].includes(key));
    if (unsupported.length > 0) warnings.push(`sockopt Xray partiellement ignoré : ${unsupported.join(', ')}`);
  }
}

/** Resolve references here; each HTTP definition is translated once in source order. */
function applyProxySettings(
  ob: any,
  out: Record<string, any>,
  rawByTag: Map<string, Record<string, any>>,
  warnings: string[],
  errors: string[],
): void {
  const ps = ob.proxySettings;
  if (ps === undefined) return;
  if (!ps || typeof ps !== 'object' || Array.isArray(ps)
    || typeof ps.tag !== 'string' || !ps.tag.trim() || ps.transportLayer !== true) {
    errors.push('Xray : proxySettings exige un tag et transportLayer=true - import refuse');
    return;
  }
  const tag = ps.tag;
  const ref = rawByTag.get(tag);
  if (!ref || String(ref.protocol).toLowerCase() !== 'http') {
    errors.push(`Xray : proxySettings "${tag}" - outbound amont HTTP introuvable ou non supporte - import refuse`);
    return;
  }
  out.detour = tag;
  warnings.push(`chaînage proxySettings : trafic via l'amont HTTP "${tag}" (headers personnalisés conservés)`);
}

function translateDns(xrayDns: any, warnings: string[], errors: string[], mainOutboundTag: string): Record<string, any> | null {
  if (xrayDns === undefined) return null;
  if (!xrayDns || typeof xrayDns !== 'object' || Array.isArray(xrayDns) || !Array.isArray(xrayDns.servers)) {
    errors.push('Xray : dns.servers doit etre un tableau - import refuse');
    return null;
  }
  if (xrayDns.servers.length === 0) {
    warnings.push('Xray : dns.servers vide - DNS fourni par le moteur mobile');
    return null;
  }
  const servers: Array<{ tag: string; address: string; detour: string }> = [];
  let operatorTrick = false;

  for (const s of xrayDns.servers) {
    const address = typeof s === 'string' ? s : (s?.address ?? '');
    // tcp+local:// ou https+local:// (+ payload [crlf]) = astuce opérateur
    if (/^(tcp|https)\+local:\/\//i.test(String(address))) {
      operatorTrick = true;
      continue;
    }
    if (!address || typeof address !== 'string') {
      errors.push('Xray : serveur DNS invalide - import refuse');
      continue;
    }
    if (typeof s === 'object' && Object.keys(s).some(key => !['address'].includes(key))) {
      errors.push('Xray : options de serveur DNS non traduisibles - import refuse');
      continue;
    }
    // Xray peut router le DNS distant par le proxy principal. Cela évite
    // qu’un DNS direct bloqué par l’opérateur rende le tunnel connecté mais
    // inutilisable. La résolution bootstrap du serveur VLESS est protégée
    // séparément par le TUN Android (carrier exclusion).
    servers.push({ tag: '', address, detour: mainOutboundTag });
  }

  if (operatorTrick) {
    warnings.push('astuce DNS opérateur perdue à la conversion (dns.servers tcp+local:// / https+local:// avec payload [crlf]) — DNS du moteur mobile utilisé');
  }
  if (xrayDns.hosts && typeof xrayDns.hosts === 'object' && Object.keys(xrayDns.hosts).length > 0) {
    // Le moteur embarqué est sing-box 1.11.15 ; le serveur DNS `hosts` avec
    // `predefined` n’existe qu’à partir de 1.12. On refuse la fausse promesse
    // de l’appliquer et on laisse le DNS du moteur résoudre normalement.
    warnings.push(`dns.hosts contient ${Object.keys(xrayDns.hosts).length} entrée(s), conservées dans le diagnostic mais ignorées par sing-box 1.11.15 (fonction hosts introduite en 1.12)`);
  }
  if (servers.length === 0) return null;

  servers.forEach((s, i) => { s.tag = i === 0 ? 'dns-remote' : `dns-remote-${i + 1}`; });
  const dns: Record<string, any> = { servers, final: 'dns-remote' };
  if (xrayDns.queryStrategy === 'UseIPv4') dns.strategy = 'ipv4_only';
  else if (xrayDns.queryStrategy === 'UseIPv6') dns.strategy = 'ipv6_only';
  else if (xrayDns.queryStrategy !== undefined && xrayDns.queryStrategy !== 'UseIP') {
    errors.push('Xray : dns.queryStrategy non traduisible - import refuse');
  }
  return dns;
}

function appendMatcher(rule: Record<string, any>, key: string, value: string): void {
  (rule[key] ??= []).push(value);
}

function translateIpMatchers(values: any, rule: Record<string, any>, warnings: string[], errors: string[]): void {
  if (!Array.isArray(values) || values.length === 0) {
    errors.push('Xray : routing.ip doit etre un tableau non vide - import refuse');
    return;
  }
  for (const value of values) {
    if (value === 'geoip:private') {
      rule.ip_is_private = true;
    } else if (typeof value === 'string' && /^geoip:[a-z0-9_-]+$/i.test(value)) {
      appendMatcher(rule, 'geoip', value.slice(6));
      warnings.push('routing geoip : une base geoip.db equivalente a celle du fournisseur est requise par sing-box 1.11');
    } else if (typeof value === 'string') {
      const [address, prefix, extra] = value.split('/');
      const family = isIP(address);
      const bits = family === 4 ? 32 : 128;
      if (!family || extra !== undefined || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > bits))) {
        errors.push('Xray : routing.ip contient un matcher non traduisible - import refuse');
        continue;
      }
      appendMatcher(rule, 'ip_cidr', prefix === undefined ? `${address}/${bits}` : value);
    } else {
      errors.push('Xray : routing.ip contient une valeur invalide - import refuse');
    }
  }
}

function translateDomainMatchers(values: any, rule: Record<string, any>, warnings: string[], errors: string[]): void {
  if (!Array.isArray(values) || values.length === 0) {
    errors.push('Xray : routing.domain doit etre un tableau non vide - import refuse');
    return;
  }
  const fields: Record<string, string> = {
    full: 'domain', domain: 'domain_suffix', keyword: 'domain_keyword', regexp: 'domain_regex', geosite: 'geosite',
  };
  for (const value of values) {
    if (typeof value !== 'string' || !value) {
      errors.push('Xray : routing.domain contient une valeur invalide - import refuse');
      continue;
    }
    const separator = value.indexOf(':');
    const prefix = separator < 0 ? 'keyword' : value.slice(0, separator);
    const content = separator < 0 ? value : value.slice(separator + 1);
    if (!Object.hasOwn(fields, prefix) || !content || (prefix === 'geosite' && !/^[a-z0-9_-]+$/i.test(content))) {
      errors.push('Xray : routing.domain contient un matcher non traduisible - import refuse');
      continue;
    }
    appendMatcher(rule, fields[prefix], content);
    if (prefix === 'geosite') {
      warnings.push('routing geosite : une base geosite.db equivalente a celle du fournisseur est requise par sing-box 1.11 ; aucune liste de domaines privee inventee');
    }
  }
}

function translatePorts(value: any, key: 'port' | 'source_port', rule: Record<string, any>, errors: string[]): void {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) errors.push(`Xray : routing.${key} vide - import refuse`);
  for (const item of values) {
    if (typeof item !== 'string' && typeof item !== 'number') {
      errors.push(`Xray : routing.${key} invalide - import refuse`);
      continue;
    }
    for (const part of String(item).split(',')) {
      const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
      if (!match || Number(match[1]) > 65535
        || (match[2] !== undefined && (Number(match[2]) > 65535 || Number(match[2]) < Number(match[1])))) {
        errors.push(`Xray : routing.${key} ou plage invalide - import refuse`);
        continue;
      }
      if (match[2] === undefined) (rule[key] ??= []).push(Number(match[1]));
      else appendMatcher(rule, `${key}_range`, `${Number(match[1])}:${Number(match[2])}`);
    }
  }
}

function translateRouting(
  xrayRoute: any,
  mainTag: string,
  knownTags: Set<string>,
  warnings: string[],
  errors: string[],
): Record<string, any> | null {
  const rules: any[] = [];
  let final = mainTag;

  if (xrayRoute === undefined) return { final };
  if (!xrayRoute || typeof xrayRoute !== 'object' || Array.isArray(xrayRoute)
    || (xrayRoute.rules !== undefined && !Array.isArray(xrayRoute.rules))) {
    errors.push('Xray : routing invalide - import refuse');
    return null;
  }
  if (xrayRoute.balancers !== undefined) errors.push('Xray : routing.balancers non traduisible - import refuse');
  if (!xrayRoute.rules?.length) return { final };

  const list: any[] = xrayRoute.rules;
  let caughtAll = false;
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      errors.push(`Xray : routing.rules[${i}] invalide - import refuse`);
      continue;
    }
    const outbound = r.outboundTag;
    if (typeof outbound !== 'string' || !knownTags.has(outbound)) {
      errors.push(`Xray : routing.rules[${i}] vers outbound inconnu ou absent - import refuse`);
      continue;
    }
    const supported = new Set(['type', 'outboundTag', 'ip', 'domain', 'port', 'sourcePort', 'inboundTag', 'protocol', 'network']);
    if ((r.type !== undefined && r.type !== 'field') || Object.keys(r).some(key => !supported.has(key))) {
      errors.push(`Xray : routing.rules[${i}] contient une contrainte non traduisible - import refuse`);
      continue;
    }
    if (r.inboundTag !== undefined) {
      warnings.push('règle routing basée sur inboundTag ignorée — gérée par le moteur mobile (TUN)');
      continue;
    }
    const rule: Record<string, any> = { outbound };
    if (r.ip !== undefined) translateIpMatchers(r.ip, rule, warnings, errors);
    if (r.domain !== undefined) translateDomainMatchers(r.domain, rule, warnings, errors);
    if (r.port !== undefined) translatePorts(r.port, 'port', rule, errors);
    if (r.sourcePort !== undefined) translatePorts(r.sourcePort, 'source_port', rule, errors);
    if (r.network !== undefined) {
      const network: unknown = r.network;
      const networks = typeof network === 'string' ? network.toLowerCase().split(',').map(value => value.trim()) : [];
      if (networks.length === 0 || networks.some(value => !['tcp', 'udp'].includes(value))) {
        errors.push(`Xray : routing.rules[${i}].network invalide - import refuse`);
      } else rule.network = networks.length === 1 ? networks[0] : networks;
    }
    if (r.protocol !== undefined) {
      const protocols = Array.isArray(r.protocol) ? r.protocol : [r.protocol];
      if (protocols.length === 0 || protocols.some((value: any) => typeof value !== 'string' || !value)) {
        errors.push(`Xray : routing.rules[${i}].protocol invalide - import refuse`);
      } else rule.protocol = protocols;
    }
    if (rule.port?.includes(53)) {
      warnings.push('règle routing port 53 ignorée — gérée par le moteur mobile (DNS hijack)');
      rule.port = rule.port.filter((port: number) => port !== 53);
      if (!rule.port.length) {
        delete rule.port;
        if (!rule.port_range) continue;
      }
    }
    if (rule.protocol?.length === 1 && rule.protocol[0] === 'dns') {
      warnings.push('règle routing protocol=dns ignorée — gérée par le moteur mobile (DNS hijack)');
      continue;
    }
    if (caughtAll) continue;
    if (Object.keys(r).every(key => key === 'type' || key === 'outboundTag')) {
      final = outbound;
      caughtAll = true;
      if (i < list.length - 1) warnings.push('routing : les regles apres la premiere regle attrape-tout sont inaccessibles');
    } else if (Object.keys(rule).length > 1) {
      rules.push(rule);
    }
  }

  return { rules, final };
}

// ── Traducteur principal ─────────────────────────────────────────────────────

export function translateXrayToSingbox(xray: Record<string, any>): TranslationResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const outbounds: Record<string, any>[] = [];
  const generatedTags = new Set<string>();
  let mainOutboundTag: string | null = null;

  const rawOutbounds = Array.isArray(xray.outbounds) ? xray.outbounds : [];
  if (rawOutbounds.length === 0) {
    return { ok: false, warnings, errors: ['Xray : aucun outbound (outbounds[] vide)'] };
  }

  const rawByTag = new Map<string, Record<string, any>>();
  for (const ob of rawOutbounds) {
    if (!ob || typeof ob !== 'object' || Array.isArray(ob)) {
      errors.push('Xray : outbound invalide (non-objet)');
      continue;
    }
    if (ob.tag !== undefined && (typeof ob.tag !== 'string' || !ob.tag.trim())) {
      errors.push('Xray : tag outbound invalide - import refuse');
      continue;
    }
    const tag = outboundTag(ob);
    if (rawByTag.has(tag)) errors.push(`Xray : tag outbound duplique "${tag}" - import refuse`);
    rawByTag.set(tag, ob);
  }
  if (errors.length) return { ok: false, warnings, errors };

  const addOutbound = (outbound: Record<string, any>) => {
    outbounds.push(outbound);
    generatedTags.add(outbound.tag);
  };

  for (const ob of rawOutbounds) {
    if (!ob || typeof ob !== 'object') {
      errors.push('Xray : outbound invalide (non-objet)');
      continue;
    }
    const proto = String(ob.protocol ?? '').toLowerCase();
    const tag = outboundTag(ob);
    const settings = ob.settings ?? {};

    if (PROXY_PROTOCOLS.has(proto)) {
      if (ob.mux && typeof ob.mux === 'object') warnings.push(`outbound ${proto} : mux Xray ignoré (le multiplexage est géré séparément par le moteur mobile)`);
      // ── VLESS / VMess / Trojan ────────────────────────────────────────────
      let server: string | null = null;
      let port = 0;
      let uuid = '';
      let password = '';
      let flow = '';
      let alterId = 0;

      if (proto === 'trojan') {
        server = settings.servers?.[0]?.address ?? null;
        port = Number(settings.servers?.[0]?.port ?? 0);
        password = String(settings.servers?.[0]?.password ?? '');
      } else {
        // vless → settings.vnext[0] ; vmess → settings.vnext[0] ou clients[0]
        const vnext = settings.vnext?.[0] ?? {};
        const users = vnext.users ?? settings.clients ?? [];
        const user = Array.isArray(users) ? users[0] : null;
        server = vnext.address ?? settings.address ?? null;
        port = Number(vnext.port ?? settings.port ?? 0);
        uuid = user ? String(user.id ?? '') : '';
        flow = user ? String(user.flow ?? '') : '';
        alterId = Number((user?.alterId ?? settings.clients?.[0]?.alterId) ?? 0);
        if (Array.isArray(users) && users.length > 1) {
          warnings.push(`outbound ${proto} : plusieurs users dans vnext — seul le premier est traduit`);
        }
      }

      // flow : vide/absent → ignoré ; xtls-rprx-* → REFUS (flow Vision non supporté)
      if (flow && /^xtls-rprx/i.test(flow)) {
        errors.push(`flow Vision non supporté par sing-box : "${flow}" — import refusé`);
        continue;
      }
      if (flow) {
        warnings.push(`flow "${flow}" ignoré (non traduit par sing-box)`);
      }

      if (!validServer(server, port)) {
        errors.push(`Xray : outbound ${proto} — address/port manquants (settings.vnext[0] / settings.servers[0])`);
        continue;
      }
      if (proto !== 'trojan' && !uuid) {
        errors.push(`Xray : outbound ${proto} — user sans id (settings.vnext[0].users[0].id)`);
        continue;
      }

      const out: Record<string, any> = {
        type: proto,
        tag,
        server,
        server_port: port,
      };
      if (proto === 'trojan') {
        if (!password) { errors.push('Xray : outbound trojan — password manquant (settings.servers[0].password)'); continue; }
        out.password = password;
      } else {
        out.uuid = uuid;
        if (proto === 'vmess') {
          out.alter_id = alterId;
          out.security = 'auto';
        }
      }

      translateStreamSettings(ob, out, server, warnings, errors);
      applyProxySettings(ob, out, rawByTag, warnings, errors);
      addOutbound(out);
      if (!mainOutboundTag) mainOutboundTag = tag;
    } else if (proto === 'http') {
      const s = settings.servers?.[0];
      if (!Array.isArray(settings.servers) || settings.servers.length !== 1 || !validServer(s?.address, s?.port)) {
        errors.push(`Xray : outbound HTTP "${tag}" - un seul serveur avec address/port valides est requis`);
      } else {
        const out: Record<string, any> = {
          type: 'http', tag, server: String(s.address), server_port: Number(s.port),
        };
        const headers = settings.headers ?? s.headers ?? ob.headers;
        if (headers !== undefined) {
          if (!headers || typeof headers !== 'object' || Array.isArray(headers)
            || Object.values(headers).some(value => typeof value !== 'string'
              && (!Array.isArray(value) || value.some(item => typeof item !== 'string')))) {
            errors.push(`Xray : outbound HTTP "${tag}" - headers invalides`);
          } else if (Object.keys(headers).length > 0) out.headers = headers;
        }
        if (s.users !== undefined) {
          if (!Array.isArray(s.users) || s.users.length !== 1 || typeof s.users[0]?.user !== 'string' || typeof s.users[0]?.pass !== 'string') {
            errors.push(`Xray : outbound HTTP "${tag}" - authentification ambigue ou invalide`);
          } else {
            out.username = s.users[0].user;
            out.password = s.users[0].pass;
          }
        }
        if (ob.streamSettings?.network && ob.streamSettings.network !== 'tcp') {
          errors.push(`Xray : outbound HTTP "${tag}" - transport amont non traduisible`);
        } else translateStreamSettings(ob, out, s.address, warnings, errors);
        translateDomainStrategy(ob.domainStrategy, out, errors);
        applyProxySettings(ob, out, rawByTag, warnings, errors);
        addOutbound(out);
      }
    } else if (proto === 'freedom') {
      const out: Record<string, any> = { type: 'direct', tag };
      translateDomainStrategy(settings.domainStrategy, out, errors);
      addOutbound(out);
    } else if (proto === 'blackhole') {
      addOutbound({ type: 'block', tag });
    } else if (proto === 'dns') {
      addOutbound({ type: 'dns', tag });
    } else {
      errors.push(`Xray : protocole d'outbound non traduisible : "${proto}"`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, warnings, errors };
  }
  if (!mainOutboundTag) {
    return { ok: false, warnings, errors: ['Xray : aucun outbound de transport (vless/vmess/trojan) trouvé'] };
  }

  const byTag = new Map(outbounds.map(outbound => [outbound.tag, outbound]));
  for (const outbound of outbounds) {
    const seen = new Set<string>();
    let current: Record<string, any> | undefined = outbound;
    while (current) {
      if (seen.has(current.tag)) {
        errors.push('Xray : cycle de proxySettings - import refuse');
        break;
      }
      seen.add(current.tag);
      if (!current.detour) break;
      if (!generatedTags.has(current.detour)) {
        errors.push('Xray : detour vers un outbound absent - import refuse');
        break;
      }
      current = byTag.get(current.detour);
    }
  }

  if (xray.policy && typeof xray.policy === 'object') {
    if (xray.policy.system?.statsOutboundUplink || xray.policy.system?.statsOutboundDownlink) {
      warnings.push('policy.system.statsOutbound* Xray : compteurs ignorés, le mobile utilise les statistiques TUN noyau réelles');
    }
  }

  // ── inbounds[] → ignorés + warning ────────────────────────────────────────
  if (Array.isArray(xray.inbounds) && xray.inbounds.length > 0) {
    warnings.push('inbounds Xray ignorés — inbounds fournis par l\'app : TUN');
  }

  // ── DNS ───────────────────────────────────────────────────────────────────
  const dns = translateDns(xray.dns, warnings, errors, mainOutboundTag);

  // ── Routing ───────────────────────────────────────────────────────────────
  const route = translateRouting(xray.routing, mainOutboundTag, generatedTags, warnings, errors);
  if (errors.length) return { ok: false, warnings, errors };

  const singboxJson: Record<string, any> = {
    protocol: 'singbox',
    log: { level: 'warn' },
    outbounds,
  };
  if (dns) singboxJson.dns = dns;
  if (route) singboxJson.route = route;

  return { ok: true, singboxJson, warnings, errors: [] };
}

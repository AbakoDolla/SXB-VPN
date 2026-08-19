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
 *   - proxySettings {tag, transportLayer} → outbound http amont + detour.
 *   - freedom → direct (+domain_strategy) ; blackhole → block ; dns → dns.
 *   - routing.rules ip[] CIDR → ip_cidr ; dernière règle attrape-tout → final.
 *   - inboundTag / port 53 / sniffing → ignorés + warning.
 *   - inbounds[] → ignorés + warning (« inbounds fournis par l'app : TUN »).
 *   - dns tcp+local:// ou https+local:// + payload [crlf] → warning explicite.
 */

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

/** Réseaux Xray traduisibles vers sing-box. */
const SUPPORTED_NETWORKS = new Set(['tcp', 'ws', 'grpc']);

/** Outbounds « spéciaux » (non transport) — utilisés pour la route.final. */
const SPECIAL_TYPES = new Set(['direct', 'block', 'dns']);

/** Protocoles d'outbound Xray traduits directement. */
const PROXY_PROTOCOLS = new Set(['vless', 'vmess', 'trojan']);

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
      tls.insecure = tlsSettings.allowInsecure === true;
      if (typeof tlsSettings.fingerprint === 'string' && tlsSettings.fingerprint.trim()) {
        tls.utls = { enabled: true, fingerprint: tlsSettings.fingerprint.trim().toLowerCase() };
      }
      if (Array.isArray(tlsSettings.alpn) && tlsSettings.alpn.length > 0) {
        tls.alpn = tlsSettings.alpn.map((value: any) => String(value));
      }
    }
    out.tls = tls;
  } else if (security !== 'none' && security !== '') {
    warnings.push(`security "${security}" non traduit — ignoré (tunnel sans TLS)`);
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
  } else {
    // kcp, quic, h2, httpupgrade, xhttp… → REFUS avec nom de la feature
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

/**
 * proxySettings {tag, transportLayer:true} → amont HTTP : génère un outbound
 * {type:'http', tag, server, server_port, headers} (en réutilisant l'outbound
 * http existant de la config Xray si présent) + detour sur l'outbound principal.
 */
function applyProxySettings(
  ob: any,
  out: Record<string, any>,
  rawOutbounds: any[],
  outbounds: any[],
  generatedTags: Set<string>,
  warnings: string[],
  errors: string[],
): void {
  const ps = ob.proxySettings;
  if (!ps || typeof ps !== 'object') return;
  const tag = ps.tag ? String(ps.tag) : '';
  if (!tag) { warnings.push('proxySettings sans tag — ignoré'); return; }
  if (ps.transportLayer !== true) {
    warnings.push(`proxySettings "${tag}" sans transportLayer=true — ignoré (non traduit)`);
    return;
  }

  const ref = rawOutbounds.find((o: any) => o && String(o.tag ?? '') === tag);
  let server = ref?.settings?.servers?.[0]?.address ?? null;
  let port = ref?.settings?.servers?.[0]?.port ?? null;
  let headers = ref?.settings?.servers?.[0]?.headers ?? undefined;

  if (!server || !port) {
    errors.push(`Xray : proxySettings "${tag}" — outbound amont introuvable ou mal défini (settings.servers[0].address/port requis) — import refusé`);
    return;
  }

  if (!generatedTags.has(tag)) {
    const httpOut: Record<string, any> = {
      type: 'http',
      tag,
      server: String(server),
      server_port: Number(port),
    };
    if (headers && typeof headers === 'object' && Object.keys(headers).length > 0) {
      httpOut.headers = headers;
    }
    outbounds.push(httpOut);
    generatedTags.add(tag);
  }
  out.detour = tag;
  warnings.push(`chaînage proxySettings : trafic via l'amont HTTP "${tag}" (headers personnalisés conservés)`);
}

function translateDns(xrayDns: any, warnings: string[]): Record<string, any> | null {
  if (!xrayDns || !Array.isArray(xrayDns.servers) || xrayDns.servers.length === 0) return null;
  const servers: Array<{ tag: string; address: string; detour: string }> = [];
  let operatorTrick = false;

  for (const s of xrayDns.servers) {
    const address = typeof s === 'string' ? s : (s?.address ?? '');
    // tcp+local:// ou https+local:// (+ payload [crlf]) = astuce opérateur
    if (/^(tcp|https)\+local:\/\//i.test(String(address))) {
      operatorTrick = true;
      continue;
    }
    if (!address || typeof address !== 'string') continue;
    servers.push({ tag: '', address, detour: 'direct' });
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
  if (xrayDns.queryStrategy) dns.strategy = 'prefer_ipv4';
  return dns;
}

/** Clés de contrainte d'une règle Xray — une règle sans aucune = attrape-tout. */
const RULE_CONSTRAINT_KEYS = [
  'ip', 'domain', 'port', 'sourcePort', 'inboundTag', 'protocol', 'source',
  'user', 'balancerTag', 'network',
];

function translateRouting(
  xrayRoute: any,
  mainTag: string,
  knownTags: Set<string>,
  warnings: string[],
): Record<string, any> | null {
  const rules: any[] = [];
  let final = mainTag;

  if (!xrayRoute || !Array.isArray(xrayRoute.rules) || xrayRoute.rules.length === 0) {
    return { final };
  }

  const list: any[] = xrayRoute.rules;
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!r || typeof r !== 'object') continue;
    const isLast = i === list.length - 1;
    const hasConstraint = RULE_CONSTRAINT_KEYS.some((k) => r[k] !== undefined);

    // ── Règle attrape-tout (aucune contrainte) ──────────────────────────────
    if (!hasConstraint) {
      if (isLast) {
        const target = r.outboundTag ? String(r.outboundTag) : mainTag;
        final = knownTags.has(target) ? target : mainTag;
        continue; // consommée → route.final
      }
      warnings.push('règle attrape-tout non finale ignorée (inopérante en routing)');
      continue;
    }

    // ── Règles gérées par le moteur mobile → ignorées + warning ─────────────
    if (r.inboundTag) {
      warnings.push(`règle routing basée sur inboundTag ignorée — gérée par le moteur mobile (TUN)`);
      continue;
    }
    if (Array.isArray(r.port) && r.port.includes(53) || r.port === 53) {
      warnings.push('règle routing port 53 ignorée — gérée par le moteur mobile (DNS hijack)');
      continue;
    }
    if (r.protocol && String(r.protocol).toLowerCase() === 'dns') {
      warnings.push('règle routing protocol=dns ignorée — gérée par le moteur mobile (DNS hijack)');
      continue;
    }

    const outbound = r.outboundTag ? String(r.outboundTag) : null;
    if (!outbound || !knownTags.has(outbound)) {
      warnings.push(`règle routing vers outbound inconnu "${outbound}" ignorée`);
      continue;
    }
    const rule: Record<string, any> = { outbound };
    // ip[] CIDR → ip_cidr (plages privées → direct, 224.0.0.0/4 → block, …)
    if (Array.isArray(r.ip) && r.ip.length > 0) {
      rule.ip_cidr = r.ip.map((x: any) => String(x));
    }
    if (Array.isArray(r.domain) && r.domain.length > 0) {
      // sémantique Xray ≈ sing-box (domain: / full: / keyword: / regexp:)
      rule.domain = r.domain.map((x: any) => String(x));
    }
    if (Array.isArray(r.port) && r.port.length > 0) {
      rule.port = r.port.map((x: any) => Number(x));
    }
    if (r.network) {
      rule.network = String(r.network).toLowerCase();
    }
    if (Object.keys(rule).length > 1) rules.push(rule);
    else warnings.push(`règle routing sans cible utile ignorée`);
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

  for (const ob of rawOutbounds) {
    if (!ob || typeof ob !== 'object') {
      errors.push('Xray : outbound invalide (non-objet)');
      continue;
    }
    const proto = String(ob.protocol ?? '').toLowerCase();
    const tag = ob.tag ? String(ob.tag) : proto || 'proxy';
    const settings = ob.settings ?? {};

    if (PROXY_PROTOCOLS.has(proto)) {
      if (ob.mux && typeof ob.mux === 'object') warnings.push(`outbound ${proto} : mux Xray ignoré (le multiplexage est géré séparément par le moteur mobile)`);
      // ── VLESS / VMess / Trojan ────────────────────────────────────────────
      let server: string | null = null;
      let port = 0;
      let uuid = '';
      let password = '';
      let flow = '';

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

      if (!server || !port) {
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
          out.alter_id = Number((settings.clients?.[0]?.alterId) ?? 0);
          out.security = 'auto';
        }
      }

      translateStreamSettings(ob, out, server, warnings, errors);
      applyProxySettings(ob, out, rawOutbounds, outbounds, generatedTags, warnings, errors);
      outbounds.push(out);
      if (!mainOutboundTag) mainOutboundTag = tag;
    } else if (proto === 'http') {
      // Outbound HTTP amont (peut être référencé par proxySettings)
      const s = settings.servers?.[0];
      if (s?.address && s?.port) {
        const out: Record<string, any> = {
          type: 'http', tag, server: String(s.address), server_port: Number(s.port),
        };
        if (s.headers && typeof s.headers === 'object' && Object.keys(s.headers).length > 0) {
          out.headers = s.headers;
        }
        outbounds.push(out);
        generatedTags.add(tag);
      }
      // sans address : ignoré ici — le cas proxySettings est géré par applyProxySettings
    } else if (proto === 'freedom') {
      const out: Record<string, any> = { type: 'direct', tag };
      const ds = settings.domainStrategy;
      if (ds) {
        const map: Record<string, string> = {
          UseIP: 'prefer_ipv4', UseIPv4: 'ipv4_only', UseIPv6: 'ipv6_only',
        };
        out.domain_strategy = map[String(ds)] ?? String(ds);
      }
      outbounds.push(out);
      generatedTags.add(tag);
    } else if (proto === 'blackhole') {
      outbounds.push({ type: 'block', tag });
      generatedTags.add(tag);
    } else if (proto === 'dns') {
      outbounds.push({ type: 'dns', tag });
      generatedTags.add(tag);
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
  const dns = translateDns(xray.dns, warnings);

  // ── Routing ───────────────────────────────────────────────────────────────
  const route = translateRouting(xray.routing, mainOutboundTag, generatedTags, warnings);

  const singboxJson: Record<string, any> = {
    protocol: 'singbox',
    log: { level: 'warn' },
    outbounds,
  };
  if (dns) singboxJson.dns = dns;
  if (route) singboxJson.route = route;

  return { ok: true, singboxJson, warnings, errors: [] };
}

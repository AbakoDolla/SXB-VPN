/**
 * vlessUri.ts — Conversion URI VLESS vers le modèle canonique SXB.
 *
 * Le serveur et le mobile utilisent le même modèle plat :
 * server/host = adresse TCP à joindre,
 * sni = nom présenté pendant TLS,
 * wsHost = en-tête HTTP Host du transport WebSocket.
 *
 * Exemple accepté :
 * vless://uuid@server:443?path=%2Fvless&security=tls&encryption=none&host=ws.example&type=ws&sni=ws.example#Nom
 */

export interface ParsedVlessUri {
  config: Record<string, any>;
  name?: string;
}

function decode(value: string): string {
  try {
    // Les query strings URI traitent également + comme un espace.
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    throw new Error(`URI VLESS : valeur encodée invalide « ${value} »`);
  }
}

function parseQuery(raw: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!raw) return result;
  for (const part of raw.split('&')) {
    if (!part) continue;
    const separator = part.indexOf('=');
    const rawKey = separator >= 0 ? part.slice(0, separator) : part;
    const rawValue = separator >= 0 ? part.slice(separator + 1) : '';
    if (!rawKey) continue;
    result.set(decode(rawKey).toLowerCase(), decode(rawValue));
  }
  return result;
}

function parseAuthority(authority: string): { host: string; port: number } | null {
  // VLESS peut cibler une IPv6 entre crochets : [2001:db8::1]:443.
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0 || authority[close + 1] !== ':') return null;
    const host = authority.slice(1, close);
    const port = Number(authority.slice(close + 2));
    return host && Number.isInteger(port) && port >= 1 && port <= 65535 ? { host, port } : null;
  }

  const colon = authority.lastIndexOf(':');
  if (colon <= 0 || colon === authority.length - 1) return null;
  const host = authority.slice(0, colon);
  const port = Number(authority.slice(colon + 1));
  return host && Number.isInteger(port) && port >= 1 && port <= 65535 ? { host, port } : null;
}

/** Parse une URI VLESS standard sans réseau ni effet de bord. */
export function parseVlessUri(rawUri: string): ParsedVlessUri {
  const text = String(rawUri ?? '').trim();
  if (!/^vless:\/\//i.test(text)) throw new Error('URI VLESS attendue (préfixe vless://)');

  const withoutScheme = text.slice(text.indexOf('//') + 2);
  const hash = withoutScheme.indexOf('#');
  const beforeName = hash >= 0 ? withoutScheme.slice(0, hash) : withoutScheme;
  const name = hash >= 0 ? decode(withoutScheme.slice(hash + 1)) : undefined;
  const question = beforeName.indexOf('?');
  const authorityPart = question >= 0 ? beforeName.slice(0, question) : beforeName;
  const queryPart = question >= 0 ? beforeName.slice(question + 1) : '';

  const at = authorityPart.lastIndexOf('@');
  if (at <= 0) throw new Error('URI VLESS malformée : UUID manquant');
  const uuid = decode(authorityPart.slice(0, at));
  const endpoint = parseAuthority(authorityPart.slice(at + 1));
  if (!endpoint) throw new Error('URI VLESS malformée : serveur attendu sous la forme host:port');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new Error('URI VLESS : UUID invalide');
  }

  const q = parseQuery(queryPart);
  const security = (q.get('security') || 'none').toLowerCase();
  const network = (q.get('type') || q.get('network') || 'tcp').toLowerCase();
  const config: Record<string, any> = {
    protocol: 'vless',
    uuid,
    host: endpoint.host,
    port: endpoint.port,
    network,
    tls: security === 'tls' || security === 'reality',
  };

  const path = q.get('path');
  if (path !== null && path !== '') config.path = path;
  const wsHost = q.get('host');
  if (wsHost !== null && wsHost !== '') config.wsHost = wsHost;
  const sni = q.get('sni');
  if (sni !== null && sni !== '') config.sni = sni;
  else if (config.tls) config.sni = wsHost || endpoint.host;

  for (const key of ['encryption', 'flow', 'fp', 'alpn', 'pbk', 'sid', 'spx', 'headerType']) {
    const value = q.get(key.toLowerCase());
    if (value !== null && value !== '') config[key] = value;
  }
  const insecure = q.get('allowinsecure') ?? q.get('insecure');
  if (insecure !== undefined) config.insecure = ['1', 'true', 'yes'].includes(insecure.toLowerCase());

  return { config, name: name || undefined };
}

/**
 * Parse uniquement les URI prises en charge par le mobile. Les JSON passent
 * directement au validateur existant.
 */
export function parseVpnUri(raw: string): ParsedVlessUri | null {
  const text = String(raw ?? '').trim();
  if (!/^vless:\/\//i.test(text)) return null;
  return parseVlessUri(text);
}

export function vlessUriToJson(raw: string): string {
  return JSON.stringify(parseVlessUri(raw).config, null, 2);
}

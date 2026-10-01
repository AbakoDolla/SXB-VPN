import { parseEndpoint, record } from './protocol-bundle';

export interface ProtocolUri { config: Record<string, any>; name?: string }

export function tlsNameForEndpoint(server: string, httpHost = ''): string {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(server) || server.includes(':') ? httpHost || server : server;
}

function decode(value: string): string {
  try { return decodeURIComponent(value); }
  catch { throw new Error('URI : valeur encodee invalide'); }
}

function decodeBase64(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) throw new Error('URI : base64 invalide');
  try {
    const bytes = globalThis.atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
    return decodeURIComponent(Array.from(bytes, c => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''));
  } catch { throw new Error('URI : base64/UTF-8 invalide'); }
}

export function vmessShareProfile(shared: Record<string, any>): ProtocolUri {
  const host = shared.add ?? shared.address ?? shared.server;
  const port = shared.port ?? shared.serverPort;
  const uuid = shared.id ?? shared.uuid;
  if (!host || !port || !uuid) throw new Error('VMess : champs add/address, port et id requis');
  const config: Record<string, any> = {
    protocol: 'vmess', host: String(host), port: Number(port), uuid: String(uuid),
    network: String(shared.net ?? shared.network ?? 'tcp').toLowerCase(),
    tls: (shared.tls ?? shared.streamSecurity) === true || String(shared.tls ?? shared.streamSecurity ?? '').toLowerCase() === 'tls',
  };
  const alterId = shared.aid ?? shared.alterId;
  if (alterId !== undefined && alterId !== '') config.alterId = Number(alterId);
  const security = shared.scy ?? shared.security;
  if (security) config.security = String(security);
  const path = shared.path ?? shared.requestPath;
  if (path) config.path = decode(String(path));
  const hostHeader = shared.requestHost ?? shared.wsHost ?? shared.host;
  if (hostHeader) config.wsHost = decode(String(hostHeader));
  const header = shared.type ?? shared.headerType;
  if (header && String(header).toLowerCase() !== 'none') config.headerType = String(header);
  if (shared.sni) config.sni = decode(String(shared.sni));
  if (shared.fp ?? shared.fingerprint) config.fingerprint = String(shared.fp ?? shared.fingerprint);
  if (shared.alpn) config.alpn = Array.isArray(shared.alpn) ? shared.alpn.map(String).join(',') : String(shared.alpn);
  return { config, name: shared.ps ?? shared.remarks ?? shared.name };
}

/** Standard share URIs, shared by server/mobile; VLESS keeps its established parser. */
export function readProtocolUri(raw: string): ProtocolUri | null {
  const text = raw.trim();
  if (/^ssh/i.test(text) && /[\r\n]/.test(text)) throw new Error('URI SSH : choisissez une seule configuration');
  const scheme = text.match(/^(vmess|ss|trojan|hysteria2|hy2|ssh(?:\+payload)?(?:\+tls|\+ssl)?):\/\//i)?.[1]?.toLowerCase();
  if (!scheme) return null;
  const body = text.slice(text.indexOf('://') + 3);
  if (scheme === 'vmess') {
    let shared: unknown;
    try { shared = JSON.parse(decodeBase64(body)); }
    catch { throw new Error('URI VMess : JSON base64 invalide'); }
    if (!record(shared)) throw new Error('URI VMess : objet requis');
    return vmessShareProfile(shared);
  }
  const hash = body.indexOf('#');
  const name = hash >= 0 ? decode(body.slice(hash + 1)) : undefined;
  const named = hash >= 0 ? body.slice(0, hash) : body;
  const question = named.indexOf('?');
  const authority = (question >= 0 ? named.slice(0, question) : named).replace(/\/$/, '');
  const query = new Map<string, string>();
  for (const part of (question >= 0 ? named.slice(question + 1) : '').split('&')) {
    if (!part) continue;
    const equal = part.indexOf('=');
    query.set(decode(equal < 0 ? part : part.slice(0, equal)).toLowerCase(),
      decode((equal < 0 ? '' : part.slice(equal + 1)).replace(/\+/g, ' ')));
  }
  if (scheme.startsWith('ssh')) {
    const at = authority.lastIndexOf('@');
    if (at < 1) throw new Error('URI SSH : utilisateur et serveur requis');
    const credentials = authority.slice(0, at), colon = credentials.indexOf(':');
    const username = decode(colon < 0 ? credentials : credentials.slice(0, colon));
    const password = colon < 0 ? '' : decode(credentials.slice(colon + 1));
    const flag = (key: string): boolean => {
      const value = query.get(key);
      if (value === undefined || value === '') return false;
      if (!['true', 'false', '1', '0'].includes(value.toLowerCase())) throw new Error('URI SSH : option booleenne invalide');
      return ['true', '1'].includes(value.toLowerCase());
    };
    const tls = /tls|ssl/.test(scheme) || flag('tls');
    const payload = query.get('payload') || '';
    const mode = query.get('transport') || (scheme.includes('payload') || payload ? (tls ? 'payload-tls' : 'payload') : tls ? 'tls' : 'direct');
    if (!['direct', 'tls', 'payload', 'payload-tls', 'http-connect', 'slowdns'].includes(mode)) throw new Error('URI SSH : transport non pris en charge');
    let endpoint = authority.slice(at + 1);
    if (/^\[[^\]]+\]$/.test(endpoint) || !endpoint.includes(':')) endpoint += `:${tls ? 443 : 22}`;
    const config: Record<string, any> = {
      protocol: ['payload', 'payload-tls', 'http-connect'].includes(mode) ? 'ssh+payload' : 'ssh',
      ...parseEndpoint(endpoint), username, password, sshTransport: mode, tls,
    };
    if (mode === 'tls' || mode === 'payload-tls') config.tls = true;
    if (payload) config.payload = payload;
    if (mode === 'http-connect') config.proxyEnabled = true;
    if (mode === 'slowdns') config.slowDns = true;
    if (flag('insecure')) config.insecure = true;
    for (const key of ['sni', 'userAgent', 'proxyHost', 'dns', 'nameServer', 'slowDnsPublicKey', 'privateKeyBase64',
      'privateKeyPassphrase', 'fingerprint', 'udpMode', 'udpGatewayHost']) {
      const value = query.get(key.toLowerCase());
      if (value !== undefined) config[key] = value;
    }
    for (const key of ['proxyPort', 'timeoutMs', 'localPort', 'udpGatewayPort']) {
      const value = query.get(key.toLowerCase());
      if (value !== undefined) {
        if (!/^\d+$/.test(value)) throw new Error('URI SSH : option numerique invalide');
        config[key] = Number(value);
      }
    }
    return { config, name };
  }
  const fullBase64 = scheme === 'ss' && !authority.includes('@');
  const combined = fullBase64 ? decodeBase64(authority) : authority;
  const at = combined.lastIndexOf('@');
  if (at <= 0) throw new Error('URI : identifiants et serveur requis');
  const endpoint = parseEndpoint(combined.slice(at + 1));
  let credentials = combined.slice(0, at);
  if (scheme === 'ss') {
    if (query.has('plugin')) throw new Error('URI Shadowsocks : plugin non pris en charge');
    const encodedCredentials = !credentials.includes(':');
    if (encodedCredentials) credentials = decodeBase64(credentials);
    const colon = credentials.indexOf(':');
    if (colon < 1) throw new Error('URI Shadowsocks : methode/password requis');
    const method = credentials.slice(0, colon), password = credentials.slice(colon + 1);
    return { config: { protocol: 'shadowsocks', ...endpoint,
      method: fullBase64 || encodedCredentials ? method : decode(method),
      password: fullBase64 || encodedCredentials ? password : decode(password) }, name };
  }
  const protocol = scheme === 'trojan' ? 'trojan' : 'hysteria2';
  const config: Record<string, any> = { protocol, ...endpoint, password: decode(credentials), tls: true };
  if (protocol === 'trojan') {
    const security = query.get('security')?.toLowerCase();
    if (security && !['none', 'tls', 'reality'].includes(security)) throw new Error('URI Trojan : security non prise en charge');
    if (security) config.tls = security !== 'none';
    if (query.get('type') || query.get('network')) config.network = (query.get('type') || query.get('network'))!.toLowerCase();
    for (const [key, target] of [['path', 'path'], ['host', 'wsHost'], ['fp', 'fingerprint'], ['alpn', 'alpn'],
      ['servicename', 'grpcServiceName'], ['flow', 'flow'], ['pbk', 'publicKey'], ['sid', 'shortId'], ['spx', 'spiderX']]) {
      const value = query.get(key);
      if (value) config[target] = value;
    }
    const header = query.get('headertype');
    if (header && header !== 'none') config.headerType = header;
    if (security === 'reality' && !config.publicKey) throw new Error('URI Trojan Reality : pbk requis');
  } else {
    if (query.get('obfs')) config.obfs = query.get('obfs');
    if (query.get('obfs-password')) config.obfsPassword = query.get('obfs-password');
  }
  if (query.get('sni')) config.sni = query.get('sni');
  const insecure = query.get('insecure') ?? query.get('allowinsecure');
  if (insecure !== undefined) {
    if (!['true', 'false', '1', '0'].includes(insecure)) throw new Error('URI : insecure invalide');
    config.insecure = insecure === 'true' || insecure === '1';
  }
  return { config, name };
}

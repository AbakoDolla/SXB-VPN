/**
 * Pure reader for the protocol bundle's Settings exports. No file access,
 * decryption, network lookup or access-policy import is permitted here.
 * Shared by the server, mobile and the dashboard's import preview.
 */
export interface BundleProfile {
  config: Record<string, unknown>;
  warnings: string[];
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, field: string, required = false): string {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`Protocols: ${field} requis`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`Protocols: ${field} doit etre une chaine`);
  if (required && !value.trim()) throw new Error(`Protocols: ${field} requis`);
  return value;
}

export function integer(value: unknown, field: string, min: number, max: number): number {
  if (!(typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value))) {
    throw new Error(`Protocols: ${field} doit etre un entier`);
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new Error(`Protocols: ${field} hors limites (${min}-${max})`);
  }
  return result;
}

export function parseEndpoint(value: unknown): { host: string; port: number } {
  const endpoint = text(value, 'endpoint', true);
  const match = endpoint.match(/^(?:\[([0-9a-f:.]+)\]|([^:\s/]+)):(\d+)$/i);
  if (!match) throw new Error('Protocols: endpoint attendu au format host:port ou [IPv6]:port');
  if (match[1]) ipPrefix(match[1], 'endpoint');
  return { host: match[1] || match[2], port: integer(match[3], 'port', 1, 65535) };
}

export function base64Key(value: unknown, bytes: number, field: string): string {
  const key = text(value, field, true);
  const padding = bytes % 3 === 1 ? '==' : bytes % 3 === 2 ? '=' : '';
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key) || key.length !== Math.ceil(bytes / 3) * 4
    || !key.endsWith(padding) || key.replace(/=+$/, '').length !== Math.ceil(bytes * 8 / 6)) {
    throw new Error(`Protocols: ${field} doit etre une cle base64 de ${bytes} octets`);
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const last = alphabet.indexOf(key.replace(/=+$/, '').slice(-1));
  if (bytes % 3 && last % (bytes % 3 === 1 ? 16 : 4) !== 0) throw new Error(`Protocols: ${field} base64 non canonique`);
  return key;
}

export function validateShadowsocksKey(method: unknown, password: unknown): void {
  const methods = [
    'none', 'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', 'xchacha20-ietf-poly1305',
    'aes-128-ctr', 'aes-192-ctr', 'aes-256-ctr', 'aes-128-cfb', 'aes-192-cfb', 'aes-256-cfb',
    'rc4-md5', 'chacha20-ietf', 'xchacha20',
    '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305',
  ];
  if (!methods.includes(String(method))) throw new Error('Shadowsocks: methode non prise en charge par libbox');
  const lengths: Record<string, number> = {
    '2022-blake3-aes-128-gcm': 16,
    '2022-blake3-aes-256-gcm': 32,
    '2022-blake3-chacha20-poly1305': 32,
  };
  const length = lengths[String(method)];
  if (!length) return;
  const keys = text(password, 'password', true).split(':');
  if (method === '2022-blake3-chacha20-poly1305' && keys.length !== 1) throw new Error('Shadowsocks2022: les cles EIH exigent AES');
  for (const key of keys) base64Key(key, length, 'Shadowsocks2022 password');
}

export function validateVmessSecurity(value: unknown): void {
  if (!['auto', 'none', 'zero', 'aes-128-gcm', 'chacha20-poly1305'].includes(String(value))) {
    throw new Error('VMess: security non prise en charge par libbox');
  }
}

export function ipPrefix(value: unknown, field: string): string {
  const input = text(value, field, true);
  const [address, prefix, extra] = input.split('/');
  const ipv6 = address.includes(':');
  if (extra !== undefined || !(ipv6 ? /^[0-9a-f:.]+$/i.test(address) : /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address))) {
    throw new Error(`Protocols: ${field} doit etre une adresse IP/CIDR`);
  }
  const validV4 = (input: string): boolean => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(input)
    && input.split('.').every(n => Number(n) <= 255 && (n === '0' || !n.startsWith('0')));
  if (!ipv6 && !validV4(address)) throw new Error(`Protocols: ${field} IPv4 invalide`);
  if (ipv6) {
    const v4 = address.slice(address.lastIndexOf(':') + 1);
    const normalized = address.includes('.') && validV4(v4) ? address.slice(0, -v4.length) + '0:0' : address;
    const parts = normalized.split('::');
    const groups = normalized.split(':').filter(Boolean);
    if (normalized.includes(':::') || normalized.startsWith(':') && !normalized.startsWith('::')
      || normalized.endsWith(':') && !normalized.endsWith('::')
      || parts.length > 2 || groups.some(group => !/^[0-9a-f]{1,4}$/i.test(group))
      || (parts.length === 1 ? groups.length !== 8 : groups.length >= 8)) {
      throw new Error(`Protocols: ${field} IPv6 invalide`);
    }
  }
  return `${address}/${prefix === undefined ? (ipv6 ? 128 : 32) : integer(prefix, field, 0, ipv6 ? 128 : 32)}`;
}

export function ipVersion(value: string): 0 | 4 | 6 {
  if (value.includes('/')) return 0;
  try { ipPrefix(value, 'IP'); return value.includes(':') ? 6 : 4; }
  catch { return 0; }
}

export function canonicalWireguardEndpoint(cfg: Record<string, unknown>): Record<string, unknown> {
  const list = (value: unknown, fallback: string[]): unknown[] => {
    if (value === undefined) return fallback;
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return value.split(',').map(item => item.trim());
    throw new Error('WireGuard: liste IP invalide');
  };
  const host = text(cfg.host, 'host');
  return wireguardEndpoint({
    secretKey: cfg.privateKey,
    address: list(cfg.address ?? cfg.localAddress, ['10.0.0.2/32']),
    mtu: cfg.mtu, reserved: cfg.reserved,
    peers: [{
      endpoint: cfg.endpoint ?? `${host.includes(':') ? `[${host}]` : host}:${cfg.port}`,
      publicKey: cfg.publicKey ?? cfg.peerPublicKey,
      preSharedKey: cfg.presharedKey ?? cfg.preSharedKey,
      allowedIPs: list(cfg.allowedIPs ?? cfg.allowedIps, ['0.0.0.0/0', '::/0']),
      keepAlive: cfg.persistentKeepalive ?? cfg.keepAlive,
    }],
  }, 'proxy');
}

export function validateProtocolOptions(cfg: Record<string, unknown>): void {
  if (cfg.protocol === 'vmess') validateVmessSecurity(cfg.security ?? 'auto');
  if (cfg.protocol === 'wireguard') canonicalWireguardEndpoint(cfg);
  if (cfg.protocol === 'hysteria1' || cfg.protocol === 'hysteria2') {
    if (cfg.tls !== undefined && cfg.tls !== true) throw new Error('Hysteria: TLS requis');
    for (const field of ['upMbps', 'downMbps']) {
      if (cfg[field] !== undefined || cfg.protocol === 'hysteria1') integer(cfg[field], field, 1, 1_000_000);
    }
    for (const field of ['recvWindowConn', 'recvWindow']) {
      if (cfg[field] !== undefined) integer(cfg[field], field, 1, Number.MAX_SAFE_INTEGER);
    }
    if (cfg.obfs !== undefined) text(cfg.obfs, 'obfs');
    if (cfg.protocol === 'hysteria2' && cfg.obfs) {
      if (cfg.obfs !== 'salamander') throw new Error('Hysteria2: seul obfs salamander est supporte');
      text(cfg.obfsPassword, 'obfsPassword', true);
    }
    if (cfg.protocol === 'hysteria2' && cfg.obfsPassword && !cfg.obfs) throw new Error('Hysteria2: obfs requis avec obfsPassword');
    if (cfg.certificate !== undefined && !text(cfg.certificate, 'certificate', true).includes('-----BEGIN CERTIFICATE-----')) {
      throw new Error('Hysteria: certificate PEM requis');
    }
  }
  if (cfg.protocol === 'ssh' || cfg.protocol === 'ssh+payload') {
    if (cfg.privateKeyBase64 !== undefined) {
      const key = text(cfg.privateKeyBase64, 'privateKeyBase64', true);
      if (key.length > 262144 || key.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) {
        throw new Error('SSH: privateKeyBase64 invalide ou trop volumineuse');
      }
    }
    if (cfg.privateKeyPassphrase !== undefined) text(cfg.privateKeyPassphrase, 'privateKeyPassphrase');
    if (cfg.payloadDialect !== undefined && cfg.payloadDialect !== 'protocols-v1') throw new Error('SSH: payloadDialect inconnu');
    if (cfg.payloadResponse !== undefined && !['http', 'none'].includes(String(cfg.payloadResponse))) throw new Error('SSH: payloadResponse invalide');
    if (cfg.payloadResponse === 'none' && (cfg.payloadDialect !== 'protocols-v1' || cfg.sshTransport !== 'payload' || cfg.tls || cfg.proxyEnabled)) {
      throw new Error('SSH: payloadResponse=none reserve au payload Dropbear direct');
    }
    if (cfg.payloadTargetPort !== undefined) integer(cfg.payloadTargetPort, 'payloadTargetPort', 1, 65535);
  }
}

export function hasWireguardEndpoints(value: Record<string, unknown>): boolean {
  return Array.isArray(value.endpoints) && value.endpoints.length > 0
    && value.endpoints.every(endpoint => record(endpoint) && endpoint.type === 'wireguard' && endpoint.system !== true);
}

export function wireguardEndpoint(settings: Record<string, unknown>, tag: string): Record<string, unknown> {
  const addresses = settings.address;
  if (!Array.isArray(addresses) || !addresses.length) throw new Error('WireGuard: address requis');
  if (!Array.isArray(settings.peers) || !settings.peers.length) throw new Error('WireGuard: peers requis');
  const reserved = (value: unknown): number[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length !== 3) throw new Error('WireGuard: reserved doit contenir trois octets');
    return value.map(n => integer(n, 'reserved', 0, 255));
  };
  const commonReserved = reserved(settings.reserved);
  return {
    type: 'wireguard', tag, system: false,
    private_key: base64Key(settings.secretKey, 32, 'secretKey'),
    address: addresses.map(address => ipPrefix(address, 'address')),
    mtu: integer(settings.mtu ?? 1420, 'mtu', 576, 65535),
    peers: settings.peers.map(peer => {
      if (!record(peer)) throw new Error('WireGuard: peer invalide');
      const target = parseEndpoint(peer.endpoint);
      if (!Array.isArray(peer.allowedIPs) || !peer.allowedIPs.length) throw new Error('WireGuard: allowedIPs requis');
      const result: Record<string, unknown> = {
        address: target.host, port: target.port,
        public_key: base64Key(peer.publicKey, 32, 'publicKey'),
        allowed_ips: peer.allowedIPs.map(ip => ipPrefix(ip, 'allowedIPs')),
        persistent_keepalive_interval: integer(peer.keepAlive ?? 0, 'keepAlive', 0, 65535),
      };
      if (peer.preSharedKey) result.pre_shared_key = base64Key(peer.preSharedKey, 32, 'preSharedKey');
      const bytes = reserved(peer.reserved) ?? commonReserved;
      if (bytes) result.reserved = bytes;
      return result;
    }),
  };
}

function flag(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  throw new Error(`Protocols: ${field} doit etre un booleen`);
}

export function isProtocolBundle(value: unknown): boolean {
  if (!record(value)) return false;
  return Object.hasOwn(value, 'tunnelType')
    || Object.hasOwn(value, 'v2rayjson')
    || Object.hasOwn(value, 'auth_str') && Object.hasOwn(value, 'up_mbps');
}

export function isProtocolBundleCatalog(value: unknown): boolean {
  const entries = Array.isArray(value) ? value : [value];
  return entries.some(entry => record(entry) && Array.isArray(entry.hosts) && Array.isArray(entry.protocols));
}

const NON_PROTOCOL_SETTINGS = [
  'time_left_ms', 'active_server_id', 'active_config_id', 'serverMode',
  'protegerConfig', 'mensagemConfig', 'validadeConfig', 'inputPassword',
  'bypassKey', 'filterApps', 'filterBypassMode', 'filterAppsList', 'tetherSubnet',
  'numberMaxThreadSocks', 'pingerSSH', 'disableDelaySSH', 'data_compression',
  'autoClearLogs', 'hideLog', 'modeDebug', 'blockRoot', 'idioma',
  'theme_mode', 'dynamic_theme', 'selected_dns_id', 'DNSType',
];

export function readProtocolBundle(value: unknown): BundleProfile | null {
  if (isProtocolBundleCatalog(value)) throw new Error('Protocols: catalogue incomplet; selectionnez un hote et un mode, puis fournissez un profil Settings complet (y compris le resolveur DNS pour SLOW_DNS). pubkey ne fournit pas une cle privee.');
  if (!isProtocolBundle(value) || !record(value)) return null;
  const warnings: string[] = [];
  for (const key of NON_PROTOCOL_SETTINGS) {
    if (Object.hasOwn(value, key)) warnings.push(`Protocols: ${key} non importe; politique SXB conservee`);
  }
  const mode = value.tunnelType === undefined
    ? (Object.hasOwn(value, 'v2rayjson') ? 7 : 6)
    : integer(value.tunnelType, 'tunnelType', 1, 7);
  if (value.protocol !== undefined && !(mode === 6 && value.protocol === 'hysteria1' || mode === 7 && value.protocol === 'singbox')) {
    throw new Error('Protocols: protocol et tunnelType/formulaire legacy ambigus');
  }
  if (mode === 7) {
    const raw = value.v2rayjson;
    let config: unknown = raw;
    if (typeof raw === 'string') {
      try { config = JSON.parse(raw); }
      catch { throw new Error('Protocols: v2rayjson invalide ou chiffre; un export JSON en clair est requis'); }
    }
    if (!record(config) || !Array.isArray(config.outbounds) || config.outbounds.length === 0) {
      throw new Error('Protocols: v2rayjson doit contenir des outbounds');
    }
    if (record(config.dns) && record(config.dns.hosts)) {
      for (const [domain, raw] of Object.entries(config.dns.hosts)) {
        const addresses = Array.isArray(raw) ? raw : [raw];
        if (!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?$/i.test(domain) || !addresses.length ||
          addresses.some(address => typeof address !== 'string' || !ipVersion(address))) {
          throw new Error('Protocols: dns.hosts exige des noms exacts vers des IP; convertir explicitement les alias/matchers avant import');
        }
      }
    }
    return { config: { ...config }, warnings };
  }
  if (mode === 6) {
    const legacySettings = value.tunnelType !== undefined;
    const endpoint = legacySettings
      ? { host: text(value.udpserver, 'udpserver', true).trim(), port: integer(value.udpport, 'udpport', 1, 65535) }
      : parseEndpoint(value.server);
    const config: Record<string, unknown> = {
      protocol: 'hysteria1', ...endpoint,
      password: text(legacySettings ? value.udpauth : value.auth_str, 'auth_str', true),
      obfs: text(legacySettings ? value.udpobfs : value.obfs, 'obfs'),
      upMbps: integer(legacySettings ? value.udpup : value.up_mbps, 'up_mbps', 1, 1_000_000),
      downMbps: integer(legacySettings ? value.udpdown : value.down_mbps, 'down_mbps', 1, 1_000_000),
      tls: true,
      // A copied insecure=true is not authorization to disable verification.
      insecure: false,
      recvWindowConn: integer(value.recv_window_conn ?? 196608, 'recv_window_conn', 1, Number.MAX_SAFE_INTEGER),
    };
    if (value.recv_window !== undefined && value.recv_window !== null) {
      config.recvWindow = integer(value.recv_window, 'recv_window', 1, Number.MAX_SAFE_INTEGER);
    }
    if (value.sni !== undefined) config.sni = text(value.sni, 'sni');
    if (value.certificate !== undefined) config.certificate = text(value.certificate, 'certificate', true);
    if (value.ca) warnings.push('Protocols: chemin ca non lu; fournir certificate PEM ou un certificat de confiance systeme');
    if (value.insecure === true) warnings.push('Protocols: insecure=true non repris; verification TLS active');
    if (value.socks5 !== undefined || value.retry !== undefined || value.retry_interval !== undefined) {
      warnings.push('Protocols: SOCKS local et reconnexion geres par le service unique SXB');
    }
    return { config, warnings };
  }
  const transports = ['direct', 'http-connect', 'tls', 'payload-tls', 'slowdns'];
  const payload = flag(value.usarDefaultPayload, 'usarDefaultPayload', false)
    ? 'CONNECT [host_port] [protocol][crlf][crlf]'
    : text(value.proxyPayload, 'proxyPayload');
  const usesPayload = mode === 2 || mode === 4 || mode === 1 && payload.length > 0;
  const config: Record<string, unknown> = {
    protocol: usesPayload ? 'ssh+payload' : 'ssh',
    sshTransport: usesPayload && mode === 1 ? 'payload' : transports[mode - 1],
    host: text(value.sshServer, 'sshServer', true).trim(),
    port: integer(mode === 3 || mode === 4 ? value.sslPort ?? value.sshPort : value.sshPort, 'port', 1, 65535),
    username: text(value.sshUser, 'sshUser', true),
    tls: mode === 3 || mode === 4,
    insecure: false,
    usePayload: usesPayload,
    // Opt-in dialect: old SXB profiles retain their historical rotate behavior.
    payloadDialect: 'protocols-v1',
    payloadResponse: mode === 1 && usesPayload ? 'none' : 'http',
  };
  if (mode === 3 || mode === 4) config.payloadTargetPort = integer(value.sshPort, 'sshPort', 1, 65535);
  const password = text(value.sshPass, 'sshPass');
  const key = text(value.privateKeyBase64, 'privateKeyBase64');
  if (password) config.password = password;
  if (key) config.privateKeyBase64 = key;
  if (!password && !key) throw new Error('Protocols: sshPass ou privateKeyBase64 requis; keyPath ne fournit pas une cle');
  if (value.keyPath) warnings.push('Protocols: keyPath non lu; fournir la cle dans privateKeyBase64');
  if (value.privateKeyPassphrase !== undefined) config.privateKeyPassphrase = text(value.privateKeyPassphrase, 'privateKeyPassphrase');
  if (value.fingerprint !== undefined) config.fingerprint = text(value.fingerprint, 'fingerprint');
  if (usesPayload) config.payload = payload || 'CONNECT [host_port] [protocol][crlf][crlf]';
  if (mode === 3 || mode === 4) {
    config.sni = text(value.wsPayload, 'wsPayload') || text(value.sni, 'sni') || config.host;
  }
  if (mode === 2) {
    config.proxyEnabled = true;
    config.proxyHost = text(value.proxyRemoto, 'proxyRemoto', true).trim();
    config.proxyPort = integer(value.proxyRemotoPorta, 'proxyRemotoPorta', 1, 65535);
  }
  if (mode === 5) {
    config.slowDns = true;
    config.dns = text(value.dnsKey, 'dnsKey', true);
    config.nameServer = text(value.serverNameKey, 'serverNameKey', true);
    config.slowDnsPublicKey = text(value.chaveKey, 'chaveKey', true);
    if (!/^[0-9a-f]{64}$/i.test(String(config.slowDnsPublicKey))) throw new Error('Protocols: chaveKey doit contenir 64 caracteres hexadecimaux');
    config.localPort = 2222;
  } else if (value.dnsResolver1 !== undefined || value.dnsResolver !== undefined) {
    config.dns = text(value.dnsResolver1 ?? value.dnsResolver, 'dnsResolver', true);
  }
  if (value.dnsResolver2 !== undefined) warnings.push('Protocols: DNS secondaire non importe; resolveur principal conserve');
  if (value.dnsForward === false) warnings.push('Protocols: DNS reste dans le tunnel; dnsForward=false non repris');
  if (flag(value.udpForward, 'udpForward', false)) {
    const gateway = parseEndpoint(value.udpResolver ?? '127.0.0.1:7300');
    config.udpMode = 'udpgw';
    config.udpGatewayHost = gateway.host;
    config.udpGatewayPort = gateway.port;
  }
  if (value.sshPortaLocal !== undefined) warnings.push('Protocols: sshPortaLocal non importe; SOCKS local gere par SXB');
  if (value.usarProxyAutenticacao === true) throw new Error('Protocols: authentification proxy sans identifiants documentes; utiliser le format canonique');
  return { config, warnings };
}

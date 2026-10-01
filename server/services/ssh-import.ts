export interface CustomSshProfile {
  config: Record<string, unknown>;
  name?: string;
  warnings: string[];
}

function fields(value: Record<string, unknown>): Map<string, unknown> {
  return new Map(Object.entries(value).map(([key, item]) => [key.toUpperCase().replace(/[^A-Z0-9]/g, ''), item]));
}

function value(table: Map<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const normalized = key.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (table.has(normalized)) return table.get(normalized);
  }
}

function flag(input: unknown): boolean {
  return typeof input === 'boolean' ? input : typeof input === 'number' ? input !== 0 :
    ['1', 'true', 'yes', 'on', 'enabled'].includes(String(input ?? '').trim().toLowerCase());
}

function record(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === 'object' && !Array.isArray(input);
}

export function readCustomSshProfile(input: unknown): CustomSshProfile | null {
  if (!record(input) || typeof input.protocol === 'string') return null;
  const table = fields(input);
  const text = (...keys: string[]) => String(value(table, ...keys) ?? '').trim();
  const host = text('ADDRESS', 'HOST', 'SERVER'), username = text('USERNAME', 'USER');
  if (!host || !username || value(table, 'PAYLOAD ENABLED', 'PROXY ENABLED', 'NSSERVER', 'LOCALPORT', 'TYPE') === undefined) return null;
  const warnings: string[] = [];
  const type = text('TYPE', 'CONNECTION TYPE', 'MODE').toLowerCase();
  const dns = text('DNS', 'DNS SERVER', 'RESOLVER'), nameServer = text('NSSERVER', 'NS SERVER', 'TUNNEL DOMAIN');
  const publicKey = text('PUBKEY', 'PUBLIC KEY', 'DNSTT PUBLIC KEY');
  const explicitSlowDns = value(table, 'SLOWDNS', 'SLOW DNS', 'SLOWDNS ENABLED');
  const slowDns = explicitSlowDns !== undefined ? flag(explicitSlowDns) :
    /slow\s*dns|dns\s*tunnel/i.test(type) || !!dns && !!nameServer && /^[0-9a-f]{64}$/i.test(publicKey);
  const proxyEnabled = flag(value(table, 'PROXY ENABLED', 'PROXYENABLED'));
  const payload = text('PAYLOAD', 'PAYLOAD CONTENT', 'HTTP PAYLOAD', 'CUSTOM PAYLOAD');
  const usePayload = flag(value(table, 'PAYLOAD ENABLED', 'PAYLOADENABLED')) || proxyEnabled ||
    !!payload || /payload|http(?:\s*connect)?|proxy/i.test(type);
  const tls = flag(value(table, 'TLS', 'TLS ENABLED')) || /(?:^|[+ _-])(tls|ssl)(?:$|[+ _-])/i.test(type);
  const udp = flag(value(table, 'UDP', 'UDP ENABLED', 'UDPENABLED')) || /udp(?:\s*relay|\s*over\s*tcp)?/i.test(type);
  const proxyHost = text('PROXY HOST', 'PROXYHOST'), udpHost = text('UDP GATEWAY HOST', 'UDPGWHOST') || '127.0.0.1';
  const udpPort = Number(value(table, 'UDP GATEWAY PORT', 'UDPGWPORT') ?? 7300);
  const config: Record<string, unknown> = {
    protocol: usePayload ? 'ssh+payload' : 'ssh',
    sshTransport: slowDns ? 'slowdns' : usePayload ? tls ? 'payload-tls' : proxyEnabled ? 'http-connect' : 'payload' : tls ? 'tls' : 'direct',
    host, port: Number(value(table, 'PORT', 'SERVER PORT') ?? 22), username,
    password: String(value(table, 'PASSWORD', 'PASS') ?? ''),
    tls, usePayload, proxyEnabled,
    localPort: Number(value(table, 'LOCALPORT', 'LOCAL PORT') ?? (slowDns ? 2222 : 1080)),
    timeoutMs: Number(value(table, 'TIMEOUT', 'CONNECT TIMEOUT') ?? 30000),
    compressionLevel: Number(value(table, 'COMPRESSIONLEVEL', 'COMPRESSION LEVEL') ?? 0),
  };
  if (usePayload) config.payload = payload ||
    'CONNECT [host_port] HTTP/1.1[crlf]Host: [host_port][crlf]Proxy-Connection: Keep-Alive[crlf]Connection: Keep-Alive[crlf][crlf]';
  if (usePayload && !payload) warnings.push('Payload activé sans contenu : modèle HTTP CONNECT sûr appliqué automatiquement');
  if (proxyEnabled && !proxyHost) warnings.push('Proxy activé sans hôte proxy distinct : ADDRESS/PORT seront utilisés comme point de connexion');
  if (slowDns && explicitSlowDns === undefined) warnings.push('SlowDNS activé automatiquement : DNS + NSSERVER + PUBKEY valide détectés');
  if (udp) {
    Object.assign(config, { udpMode: 'udpgw', udpGatewayHost: udpHost, udpGatewayPort: udpPort });
    warnings.push(`UDP sur SSH nécessite BadVPN udpgw sur ${udpHost}:${udpPort}`);
  }
  if (flag(value(table, 'INSECURE', 'ALLOW INSECURE', 'SKIP CERT VERIFY'))) {
    config.insecure = true;
    warnings.push('Vérification du nom TLS désactivée explicitement par le profil');
  }
  for (const [key, aliases] of [
    ['sni', ['SNI', 'SERVER NAME']], ['userAgent', ['USER AGENT', 'USERAGENT']],
    ['fingerprint', ['FINGERPRINT', 'SSH FINGERPRINT']],
    ['privateKeyBase64', ['PRIVATE KEY BASE64', 'PRIVATEKEYBASE64']],
    ['privateKeyPassphrase', ['PRIVATE KEY PASSPHRASE', 'PRIVATEKEYPASSPHRASE']],
  ] as const) {
    const item = key === 'privateKeyPassphrase' ? String(value(table, ...aliases) ?? '') : text(...aliases);
    if (item) config[key] = item;
  }
  if (dns) config.dns = dns;
  if (nameServer) config.nameServer = nameServer;
  if (publicKey) config.slowDnsPublicKey = publicKey;
  if (slowDns) config.slowDns = true;
  if (proxyHost) config.proxyHost = proxyHost;
  const proxyPort = value(table, 'PROXY PORT', 'PROXYPORT');
  if (proxyPort !== undefined && proxyPort !== '') config.proxyPort = Number(proxyPort);
  return { config, warnings, name: text('CONFIGNAME', 'CONFIG NAME', 'NAME') || undefined };
}

export function readCustomSshProfiles(input: unknown): CustomSshProfile[] | null {
  const list = Array.isArray(input) ? input : record(input) ? value(fields(input), 'CONFIGS') : undefined;
  if (Array.isArray(list)) {
    if (!list.length) return null;
    const profiles = list.map(readCustomSshProfile);
    return profiles.every((profile): profile is CustomSshProfile => profile !== null) ? profiles : null;
  }
  const profile = readCustomSshProfile(input);
  return profile ? [profile] : null;
}

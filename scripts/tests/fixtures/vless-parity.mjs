export const parityUuid = 'a61cdad6-48c0-4a33-a72a-682c64ec0d79';
export const parityRealityKey = Buffer.alloc(32, 7).toString('base64url');

function fixture(name, options) {
  const { address = 'tcp.example.test', network = 'ws', security = 'tls',
    serverName, host = 'ws.example.test', path = '/tunnel', fingerprint = 'chrome',
    alpn, serviceName, shortId = '0a0b', flow, staleTls = false } = options;
  const query = new URLSearchParams({ type: network, security, fp: fingerprint });
  if (serverName) query.set('sni', serverName);
  if (['ws', 'httpupgrade'].includes(network)) {
    query.set('host', host);
    query.set('path', path);
  }
  if (serviceName) query.set('serviceName', serviceName);
  if (alpn) query.set('alpn', alpn.join(','));
  if (flow) query.set('flow', flow);
  if (security === 'reality') {
    query.set('pbk', parityRealityKey);
    query.set('sid', shortId);
  }
  const settings = { fingerprint };
  if (serverName) settings.serverName = serverName;
  if (alpn) settings.alpn = alpn;
  if (security === 'reality') Object.assign(settings, { publicKey: parityRealityKey, shortId });
  const streamSettings = { network, security };
  if (security === 'tls') streamSettings.tlsSettings = settings;
  if (security === 'reality') {
    streamSettings.realitySettings = settings;
    if (staleTls) streamSettings.tlsSettings = { serverName: 'inactive.example.test', fingerprint: 'chrome' };
  }
  if (network === 'ws') streamSettings.wsSettings = { path, headers: { Host: host } };
  if (network === 'httpupgrade') streamSettings.httpupgradeSettings = { path, host };
  if (network === 'grpc') streamSettings.grpcSettings = { serviceName: serviceName ?? '' };
  const user = { id: parityUuid, encryption: 'none', ...(flow ? { flow } : {}) };
  return {
    name, options,
    uri: `vless://${parityUuid}@${address}:443?${query}`,
    xray: {
      outbounds: [{ protocol: 'vless', tag: 'proxy',
        settings: { vnext: [{ address, port: 443, users: [user] }] }, streamSettings }],
      routing: { rules: [{ outboundTag: 'proxy' }] },
      dns: { servers: ['192.0.2.53'] },
    },
  };
}

export const vlessParityFixtures = [
  fixture('ws implicit TLS name retains the TCP address', {}),
  fixture('ws explicit SNI and fingerprint', { serverName: 'tls.example.test', fingerprint: 'firefox' }),
  fixture('explicit native TLS fingerprint remains disabled', { fingerprint: 'none' }),
  fixture('ws literal address uses the HTTP hostname as fallback', { address: '203.0.113.12' }),
  fixture('Reality fingerprint and ALPN', { network: 'grpc', security: 'reality',
    serverName: 'tls.example.test', fingerprint: 'firefox', alpn: ['h2'], serviceName: 'Service' }),
  fixture('Reality selects its own settings despite dormant TLS', { network: 'tcp', security: 'reality',
    serverName: 'tls.example.test', fingerprint: 'firefox', staleTls: true }),
  fixture('Reality Vision permits an empty short ID', { network: 'tcp', security: 'reality',
    serverName: 'tls.example.test', flow: 'xtls-rprx-vision', shortId: '' }),
  fixture('gRPC name is decoded once', { network: 'grpc', serverName: 'tls.example.test',
    serviceName: 'svc%2Fliteral' }),
  fixture('empty gRPC name retains the same application default', { network: 'grpc', serverName: 'tls.example.test' }),
  fixture('WS path keeps literal percent escapes', { path: '/raw%2Fliteral?ed=2048' }),
  fixture('httpupgrade keeps HTTP Host distinct from SNI', { network: 'httpupgrade', serverName: 'tls.example.test' }),
  fixture('httpupgrade literal address retains HTTP hostname fallback', { network: 'httpupgrade', address: '203.0.113.13' }),
  fixture('plain TCP keeps TLS disabled', { network: 'tcp', security: 'none' }),
];

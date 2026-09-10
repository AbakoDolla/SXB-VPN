import { randomUUID } from 'node:crypto';

// Synthetic topology only; never replace these values with a provider export.
export function xrayHttpChainFixture() {
  return {
    dns: { servers: ['192.0.2.53'], tag: 'dns-module' },
    inbounds: [{
      listen: '127.0.0.1', port: 10808, protocol: 'socks', tag: 'socks',
      settings: { auth: 'noauth', udp: true, userLevel: 8 },
      sniffing: { enabled: true, destOverride: ['http', 'tls'], routeOnly: false },
    }],
    outbounds: [
      ...[1, 2].map(index => ({
        protocol: 'vless', tag: `proxy${index}`,
        settings: { vnext: [{
          address: 'vpn.example.test', port: 443,
          users: [{ id: randomUUID(), encryption: 'none', level: 8 }],
        }] },
        streamSettings: {
          network: 'ws', security: 'tls',
          tlsSettings: { allowInsecure: true, fingerprint: 'chrome', serverName: 'tls.example.test', show: false },
          wsSettings: { headers: { Host: 'ws.example.test' }, path: '/fixture/ws?mode=compat%2Btest' },
        },
        proxySettings: { tag: `moodyibr${index}`, transportLayer: true },
        mux: { enabled: false },
      })),
      { protocol: 'freedom', tag: 'direct', settings: { domainStrategy: 'AsIs' } },
      { protocol: 'blackhole', tag: 'block', settings: { response: { type: 'none' } } },
      ...Array.from({ length: 11 }, (_, index) => ({
        protocol: 'http', tag: `moodyibr${index + 1}`, domainStrategy: 'AsIs',
        settings: {
          // Same shape as an operator front: interchangeable upstreams differing only by address.
          servers: [{ address: `upstream${index + 1}.example.test`, port: 8080 }],
          headers: {
            Host: 'front.example.test',
            'User-Agent': 'SXB-synthetic-fixture/1.0',
            'X-iorg': 'synthetic-header-canary',
          },
        },
      })),
    ],
    routing: {
      domainStrategy: 'AsIs',
      rules: [
        { type: 'field', network: 'udp', port: '443', outboundTag: 'block' },
        { type: 'field', ip: ['geoip:private'], outboundTag: 'direct' },
        { type: 'field', domain: ['geosite:private'], outboundTag: 'direct' },
        { type: 'field', port: '0-65535', outboundTag: 'proxy1' },
        { type: 'field', inboundTag: ['domestic-dns'], outboundTag: 'direct' },
        { type: 'field', inboundTag: ['dns-module'], outboundTag: 'proxy1' },
      ],
    },
  };
}

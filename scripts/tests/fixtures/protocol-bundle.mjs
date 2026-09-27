export const protocolKey = byte => Buffer.alloc(32, byte).toString('base64');
export const bundleUuid = '3d6f34b0-9d2e-4e4b-8f2e-0a1b2c3d4e5f';

/** Synthetic versions of all six cookbook outbound shapes; no sample servers. */
export function bundleXray(protocol) {
  const server = { address: '127.0.0.1', port: 23456 };
  const outbound = { protocol, tag: 'proxy' };
  switch (protocol) {
    case 'vmess':
    case 'vless':
      outbound.settings = { vnext: [{ ...server, users: [{ id: bundleUuid,
        ...(protocol === 'vmess' ? { alterId: 0, security: 'auto' } : { encryption: 'none', flow: '' }) }] }] };
      outbound.streamSettings = { network: 'ws', security: 'tls',
        tlsSettings: { serverName: 'tls.example.test', allowInsecure: false },
        wsSettings: { path: '/synthetic', headers: { Host: 'ws.example.test' } } };
      break;
    case 'trojan':
      outbound.settings = { servers: [{ ...server, password: 'synthetic-password' }] };
      outbound.streamSettings = { network: 'tcp', security: 'tls',
        tlsSettings: { serverName: 'tls.example.test', allowInsecure: false } };
      break;
    case 'shadowsocks':
      outbound.settings = { servers: [{ ...server, method: '2022-blake3-aes-256-gcm', password: protocolKey(3) }] };
      break;
    case 'socks':
      outbound.settings = { servers: [{ ...server, users: [{ user: 'synthetic', pass: 'synthetic-password' }] }] };
      break;
    case 'wireguard':
      outbound.settings = { secretKey: protocolKey(1), address: ['10.99.0.2/32', 'fd99::2/128'],
        peers: [{ publicKey: protocolKey(2), preSharedKey: protocolKey(3), endpoint: '[::1]:23456',
          allowedIPs: ['0.0.0.0/0', '::/0'], keepAlive: 25 }],
        reserved: [0, 127, 255], mtu: 1420, remoteDNS: ['127.0.0.1'], noKernelTun: true };
      break;
    default: throw new Error(`Unknown fixture protocol ${protocol}`);
  }
  return {
    outbounds: [outbound],
    dns: { servers: ['127.0.0.1'], queryStrategy: 'UseIP', hosts: { 'only.example.test': ['192.0.2.1', '2001:db8::1'] } },
    routing: { domainStrategy: 'AsIs', rules: [{ type: 'field', domain: ['full:only.example.test'], outboundTag: 'proxy' }] },
    stats: {},
  };
}

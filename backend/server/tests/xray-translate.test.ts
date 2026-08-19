/**
 * Tests unitaires du traducteur Xray → sing-box (PARTIE 2).
 * Un test par ligne de mapping obligatoire — la couverture est exhaustive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  translateXrayToSingbox, hasXrayMarkers, isSingboxNativeJson,
} from '../services/xray-translate';

// ── T-X1 : la config réelle du rapport (vless + ws + tls + amont http + dns local) ──
const TX1_XRAY = {
  log: { access: 'none' },
  inbounds: [
    { port: 12345, protocol: 'dokodemo-door', settings: { address: '127.0.0.1', port: 54321 } },
  ],
  outbounds: [
    {
      protocol: 'vless',
      settings: {
        vnext: [
          {
            address: 'server.example.com',
            port: 443,
            users: [{ id: 'uuid-xxxx', flow: '', encryption: 'none' }],
          },
        ],
      },
      streamSettings: {
        network: 'ws',
        security: 'tls',
        tlsSettings: { serverName: 'cdn.example.com', allowInsecure: false },
        wsSettings: { path: '/ws-path', headers: { Host: 'cdn.example.com' } },
      },
      proxySettings: { tag: 'upstream-http', transportLayer: true },
      tag: 'proxy',
    },
    {
      protocol: 'http',
      settings: {
        servers: [
          { address: 'proxy.example.com', port: 8080, headers: { 'X-Operator': 'mtn' } },
        ],
      },
      tag: 'upstream-http',
    },
    { protocol: 'freedom', settings: { domainStrategy: 'UseIP' }, tag: 'direct' },
    { protocol: 'blackhole', tag: 'block' },
    { protocol: 'dns', tag: 'dns-out' },
  ],
  dns: {
    servers: [
      { address: 'tcp+local://1.1.1.1', payload: ['\r\n'] },
      '8.8.8.8',
    ],
  },
  routing: {
    domainStrategy: 'IPIfNonMatch',
    rules: [
      { type: 'field', ip: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'], outboundTag: 'direct' },
      { type: 'field', ip: ['224.0.0.0/4'], outboundTag: 'block' },
      { type: 'field', inboundTag: ['tun-in'], port: 53, outboundTag: 'dns-out' },
      { type: 'field', network: 'tcp' },
    ],
  },
};

test('T-X1 : vless + ws + tls + amont http + dns local → traduction complète', () => {
  const r = translateXrayToSingbox(TX1_XRAY as any);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const sb = r.singboxJson!;

  // outbound principal
  const main = sb.outbounds.find((o: any) => o.type === 'vless');
  assert.ok(main);
  assert.equal(main.server, 'server.example.com');
  assert.equal(main.server_port, 443);
  assert.equal(main.uuid, 'uuid-xxxx');
  // flow vide/absent → ignoré
  assert.equal(main.flow, undefined);

  // TLS
  assert.equal(main.tls.enabled, true);
  assert.equal(main.tls.server_name, 'cdn.example.com');
  assert.equal(main.tls.insecure, false);

  // WS
  assert.equal(main.transport.type, 'ws');
  assert.equal(main.transport.path, '/ws-path');
  assert.deepEqual(main.transport.headers, { Host: 'cdn.example.com' });

  // detour amont http généré
  assert.equal(main.detour, 'upstream-http');
  const http = sb.outbounds.find((o: any) => o.type === 'http');
  assert.ok(http, 'outbound http amont généré');
  assert.equal(http.server, 'proxy.example.com');
  assert.equal(http.server_port, 8080);
  assert.deepEqual(http.headers, { 'X-Operator': 'mtn' });

  // freedom → direct + domain_strategy ; blackhole → block ; dns → dns
  assert.ok(sb.outbounds.some((o: any) => o.type === 'direct' && o.domain_strategy === 'prefer_ipv4'));
  assert.ok(sb.outbounds.some((o: any) => o.type === 'block'));
  assert.ok(sb.outbounds.some((o: any) => o.type === 'dns'));

  // routing : ip_cidr + final
  const route = sb.route;
  assert.ok(route.rules.some((o: any) => o.ip_cidr && o.ip_cidr.includes('10.0.0.0/8') && o.outbound === 'direct'));
  assert.ok(route.rules.some((o: any) => o.ip_cidr && o.ip_cidr.includes('224.0.0.0/4') && o.outbound === 'block'));
  // dernière règle attrape-tout → route.final = tag de l'outbound principal
  assert.equal(route.final, 'proxy');

  // warnings : inbounds ignorés + astuce DNS perdue
  assert.ok(r.warnings.some((w: string) => w.includes('inbounds fournis par l\'app : TUN')));
  assert.ok(r.warnings.some((w: string) => w.includes('astuce DNS opérateur perdue')));
  assert.ok(r.warnings.some((w: string) => w.includes('proxySettings')));
  // inboundTag (+ port 53 sur la même règle) → ignoré + warning
  assert.ok(r.warnings.some((w: string) => w.includes('inboundTag')));
});

test('proxySettings : un seul outbound HTTP amont et headers conservés', () => {
  const r = translateXrayToSingbox({
    outbounds: [
      {
        protocol: 'vless',
        tag: 'proxy',
        settings: { vnext: [{ address: 'edge.example.com', port: 443, users: [{ id: 'uuid' }] }] },
        streamSettings: { network: 'ws', security: 'tls', wsSettings: { path: '/', headers: { Host: 'cdn.example.com' } } },
        proxySettings: { tag: 'upstream-http', transportLayer: true },
      },
      {
        protocol: 'http',
        tag: 'upstream-http',
        settings: { servers: [{ address: 'proxy.example.com', port: 8080 }], headers: { Host: 'cdn.example.com', 'X-Test': '1' } },
      },
    ],
  } as any);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const upstreams = r.singboxJson!.outbounds.filter((o: any) => o.tag === 'upstream-http');
  assert.equal(upstreams.length, 1);
  assert.deepEqual(upstreams[0].headers, { Host: 'cdn.example.com', 'X-Test': '1' });
});

test('dns : servers tcp+local:// non traduits, les serveurs simples restent', () => {
  const r = translateXrayToSingbox({
    outbounds: [{ protocol: 'vless', settings: { vnext: [{ address: 'a.example.com', port: 443, users: [{ id: 'u' }] }] }, tag: 'proxy' }],
    dns: { servers: ['8.8.8.8', { address: 'tcp+local://1.1.1.1', payload: ['\r\n'] }] },
  } as any);
  assert.equal(r.ok, true);
  assert.equal(r.singboxJson!.dns.servers.length, 1);
  assert.equal(r.singboxJson!.dns.servers[0].address, '8.8.8.8');
  assert.ok(r.warnings.some((w: string) => w.includes('astuce DNS opérateur perdue')));
});

test('vless + flow xtls-rprx-vision → REFUS explicite', () => {
  const r = translateXrayToSingbox({
    outbounds: [{
      protocol: 'vless',
      settings: { vnext: [{ address: 'a.example.com', port: 443, users: [{ id: 'u', flow: 'xtls-rprx-vision' }] }] },
      tag: 'proxy',
    }],
  } as any);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e: string) => e.includes('flow Vision non supporté par sing-box')));
});

test('flow xtls-rprx-splice → REFUS', () => {
  const r = translateXrayToSingbox({
    outbounds: [{
      protocol: 'vless',
      settings: { vnext: [{ address: 'a.example.com', port: 443, users: [{ id: 'u', flow: 'xtls-rprx-splice' }] }] },
      tag: 'proxy',
    }],
  } as any);
  assert.equal(r.ok, false);
});

test('flow non-xtls inconnu → warning + ignoré (pas de refus)', () => {
  const r = translateXrayToSingbox({
    outbounds: [{
      protocol: 'vless',
      settings: { vnext: [{ address: 'a.example.com', port: 443, users: [{ id: 'u', flow: 'weird-flow' }] }] },
      tag: 'proxy',
    }],
  } as any);
  assert.equal(r.ok, true);
  assert.equal(r.singboxJson!.outbounds[0].flow, undefined);
  assert.ok(r.warnings.some((w: string) => w.includes('flow "weird-flow" ignoré')));
});

test('vmess → type vmess + alter_id (settings.clients[0])', () => {
  const r = translateXrayToSingbox({
    outbounds: [{
      protocol: 'vmess',
      // shape v2ray legacy : settings.address/port + settings.clients[]
      settings: { address: 'vmess.example.com', port: 8443, clients: [{ id: 'u-vmess', alterId: 64 }] },
      streamSettings: { network: 'tcp', security: 'none' },
      tag: 'vmess-proxy',
    }],
  } as any);
  assert.equal(r.ok, true);
  const o = r.singboxJson!.outbounds[0];
  assert.equal(o.type, 'vmess');
  assert.equal(o.uuid, 'u-vmess');
  assert.equal(o.alter_id, 64);
});

test('trojan → password depuis settings.servers[0]', () => {
  const r = translateXrayToSingbox({
    outbounds: [{
      protocol: 'trojan',
      settings: { servers: [{ address: 't.example.com', port: 443, password: 'trojan-pass' }] },
      streamSettings: { network: 'tcp', security: 'tls', tlsSettings: { serverName: 't.example.com' } },
      tag: 'trojan-proxy',
    }],
  } as any);
  assert.equal(r.ok, true);
  const o = r.singboxJson!.outbounds[0];
  assert.equal(o.type, 'trojan');
  assert.equal(o.password, 'trojan-pass');
  assert.equal(o.tls.enabled, true);
});

test('reality : champs complets → tls.reality ; champs manquants → REFUS', () => {
  const base = {
    protocol: 'vless',
    settings: { vnext: [{ address: 'r.example.com', port: 443, users: [{ id: 'u' }] }] },
    streamSettings: {
      network: 'tcp', security: 'reality',
      realitySettings: { serverName: 'r.example.com', publicKey: 'PUBKEY', shortId: 'ABCD', fingerprint: 'chrome' },
    },
    tag: 'proxy',
  };
  const ok = translateXrayToSingbox({ outbounds: [base] } as any);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.singboxJson!.outbounds[0].tls.reality, { enabled: true, public_key: 'PUBKEY', short_id: 'ABCD' });

  const missing = translateXrayToSingbox({
    outbounds: [{ ...base, streamSettings: { ...base.streamSettings, realitySettings: { serverName: 'r.example.com' } } }],
  } as any);
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e: string) => e.includes('reality') && e.includes('manquants')));
});

test('grpc → transport {type: grpc, service_name}', () => {
  const r = translateXrayToSingbox({
    outbounds: [{
      protocol: 'vless',
      settings: { vnext: [{ address: 'g.example.com', port: 443, users: [{ id: 'u' }] }] },
      streamSettings: { network: 'grpc', security: 'tls', tlsSettings: { serverName: 'g.example.com' }, grpcSettings: { serviceName: 'GunService' } },
      tag: 'proxy',
    }],
  } as any);
  assert.deepEqual(r.singboxJson!.outbounds[0].transport, { type: 'grpc', service_name: 'GunService' });
});

test('tcp raw → pas de transport', () => {
  const r = translateXrayToSingbox({
    outbounds: [{
      protocol: 'vless',
      settings: { vnext: [{ address: 't.example.com', port: 443, users: [{ id: 'u' }] }] },
      streamSettings: { network: 'tcp', security: 'none' },
      tag: 'proxy',
    }],
  } as any);
  assert.equal(r.singboxJson!.outbounds[0].transport, undefined);
});

test('réseaux non supportés (kcp/quic/h2) → REFUS avec nom de la feature', () => {
  for (const net of ['kcp', 'quic', 'h2']) {
    const r = translateXrayToSingbox({
      outbounds: [{
        protocol: 'vless',
        settings: { vnext: [{ address: 'x.example.com', port: 443, users: [{ id: 'u' }] }] },
        streamSettings: { network: net, security: 'none' },
        tag: 'proxy',
      }],
    } as any);
    assert.equal(r.ok, false, `network ${net} doit être refusé`);
    assert.ok(r.errors.some((e: string) => e.includes(`"${net}"`)), `erreur doit nommer "${net}"`);
  }
});

test('protocole d\'outbound inconnu → REFUS', () => {
  const r = translateXrayToSingbox({
    outbounds: [{ protocol: 'wireguard-in-xray', settings: {}, tag: 'x' }],
  } as any);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e: string) => e.includes('wireguard-in-xray')));
});

test('proxySettings référence un outbound inconnu → REFUS', () => {
  const r = translateXrayToSingbox({
    outbounds: [{
      protocol: 'vless',
      settings: { vnext: [{ address: 'a.example.com', port: 443, users: [{ id: 'u' }] }] },
      proxySettings: { tag: 'missing-upstream', transportLayer: true },
      tag: 'proxy',
    }],
  } as any);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e: string) => e.includes('missing-upstream')));
});

test('warnings : inbounds, inboundTag, port 53, protocol dns', () => {
  const r = translateXrayToSingbox({
    inbounds: [{ protocol: 'socks', port: 1080 }],
    outbounds: [
      { protocol: 'vless', settings: { vnext: [{ address: 'a.example.com', port: 443, users: [{ id: 'u' }] }] }, tag: 'proxy' },
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'dns', tag: 'dns-out' },
    ],
    routing: {
      rules: [
        { type: 'field', inboundTag: ['tun0'], outboundTag: 'proxy' },
        { type: 'field', port: 53, outboundTag: 'dns-out' },
        { type: 'field', protocol: ['dns'], outboundTag: 'dns-out' },
      ],
    },
  } as any);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w: string) => w.includes('inbounds fournis par l\'app : TUN')));
  assert.ok(r.warnings.some((w: string) => w.includes('inboundTag')));
  assert.ok(r.warnings.some((w: string) => w.includes('port 53')));
  assert.ok(r.warnings.some((w: string) => w.includes('protocol=dns')));
  // aucune règle ne doit référencer dns-out (toutes ignorées)
  assert.equal(r.singboxJson!.route.rules.length, 0);
  assert.equal(r.singboxJson!.route.final, 'proxy');
});

test('proxySettings sans transportLayer=true → warning, pas de detour', () => {
  const r = translateXrayToSingbox({
    outbounds: [{
      protocol: 'vless',
      settings: { vnext: [{ address: 'a.example.com', port: 443, users: [{ id: 'u' }] }] },
      proxySettings: { tag: 'up', transportLayer: false },
      tag: 'proxy',
    }],
  } as any);
  assert.equal(r.ok, true);
  assert.equal(r.singboxJson!.outbounds[0].detour, undefined);
  assert.ok(r.warnings.some((w: string) => w.includes('transportLayer=true')));
});

test('détection stricte : markers Xray détectés, sing-box natif détecté', () => {
  assert.equal(hasXrayMarkers(TX1_XRAY), true);
  assert.equal(isSingboxNativeJson(TX1_XRAY), false);

  const native = {
    log: { level: 'warn' },
    outbounds: [
      { type: 'vless', tag: 'proxy', server: 'x.example.com', server_port: 443, uuid: 'u' },
      { type: 'direct', tag: 'direct' },
    ],
  };
  assert.equal(hasXrayMarkers(native), false);
  assert.equal(isSingboxNativeJson(native), true);

  // outbounds sans champ type → ni sing-box ni Xray
  assert.equal(isSingboxNativeJson({ outbounds: [{ server: 'x', server_port: 1 }] }), false);
  assert.equal(hasXrayMarkers({ outbounds: [{ server: 'x', server_port: 1 }] }), false);
});


test('config jointe : VLESS WS TLS avec Host distinct, uTLS Chrome et happy eyeballs', () => {
  const r = translateXrayToSingbox({
    dns: {
      hosts: { 'googleapis.cn': 'googleapis.com', 'hsnylstroom.co.za': ['45.60.38.117', '45.60.32.117'] },
      servers: ['1.1.1.1'],
    },
    inbounds: [{ tag: 'socks', port: 10808, protocol: 'socks' }],
    outbounds: [
      {
        tag: 'proxy',
        protocol: 'vless',
        settings: { vnext: [{ address: 'hsnylstroom.co.za', port: 443, users: [{ id: 'e3696a89-3e4a-493e-814b-1645adf0cc92', encryption: 'none' }] }] },
        streamSettings: {
          network: 'ws',
          security: 'tls',
          sockopt: { domainStrategy: 'UseIP', happyEyeballs: { tryDelayMs: 250, interleave: 2, maxConcurrentTry: 4, prioritizeIPv6: false } },
          tlsSettings: { allowInsecure: true, fingerprint: 'chrome', serverName: 'hsnylstroom.co.za' },
          wsSettings: { headers: { Host: 'live.faibakenya.app' }, path: '/lee' },
        },
        mux: { enabled: false, concurrency: -1 },
      },
      { tag: 'direct', protocol: 'freedom', settings: { domainStrategy: 'UseIP' } },
      { tag: 'block', protocol: 'blackhole' },
    ],
    policy: { system: { statsOutboundUplink: true, statsOutboundDownlink: true } },
    routing: { rules: [{ type: 'field', ip: ['8.8.8.8'], outboundTag: 'direct', port: '53' }] },
  } as any);

  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const proxy = r.singboxJson!.outbounds.find((out: any) => out.tag === 'proxy');
  assert.equal(proxy.server, 'hsnylstroom.co.za');
  assert.equal(proxy.tls.server_name, 'hsnylstroom.co.za');
  assert.deepEqual(proxy.tls.utls, { enabled: true, fingerprint: 'chrome' });
  assert.deepEqual(proxy.transport, { type: 'ws', path: '/lee', headers: { Host: 'live.faibakenya.app' } });
  assert.equal(proxy.domain_strategy, 'prefer_ipv4');
  assert.equal(proxy.fallback_delay, '250ms');
  assert.ok(r.warnings.some((warning: string) => warning.includes('dns.hosts')));
  assert.ok(r.warnings.some((warning: string) => warning.includes('happyEyeballs')));
  assert.ok(r.warnings.some((warning: string) => warning.includes('statsOutbound')));
});


test('Xray alpn est conservé dans TLS sing-box', () => {
  const r = translateXrayToSingbox({
    outbounds: [{
      protocol: 'vless',
      settings: { vnext: [{ address: 'a.example.com', port: 443, users: [{ id: 'u' }] }] },
      streamSettings: { network: 'ws', security: 'tls', tlsSettings: { serverName: 'a.example.com', alpn: ['h2', 'http/1.1'] }, wsSettings: { path: '/' } },
    }],
  } as any);
  assert.equal(r.ok, true);
  assert.deepEqual(r.singboxJson!.outbounds[0].tls.alpn, ['h2', 'http/1.1']);
});

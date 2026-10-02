import './register-hooks.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { xrayHttpChainFixture } from './fixtures/xray-http-chain.mjs';
import { bundleXray } from './fixtures/protocol-bundle.mjs';
import { vlessParityFixtures } from './fixtures/vless-parity.mjs';

const { parseImportedConfig, engineConfigFromCanonical } = await import('../../server/services/canonical-config.ts');
const root = fileURLToPath(new URL('../../', import.meta.url));
export const SING_BOX_VERSION = '1.12.9';

export function nativeCompatibilityHarnessSource() {
  const service = readFileSync(path.join(root, 'app-mobile', 'modules', 'android-native', 'SxbVpnService.kt'), 'utf8');
  const methods = [
    'tunInbound', 'isLiteralIp', 'dnsAddressHost', 'applyDnsLoopGuard',
    'stripUnsupportedSingBoxVlessFields', 'convertXrayToSingBoxIfNeeded',
    'normalizeRawSingBoxCompatibility', 'buildRawSingBoxConfig',
    'buildSingBoxConfig', 'connectionDnsChoice', 'applyConnectionDnsOverride', 'profileDnsObject', 'defaultDnsObject',
    'applyTransport', 'buildVlessOutbound', 'buildVmessOutbound', 'buildTrojanOutbound',
    'buildShadowsocksOutbound', 'buildWireGuardOutbound', 'buildTuicOutbound', 'buildTlsObj',
    'csvToJsonArray', 'buildTransportObj', 'buildWsTransport', 'buildGrpcTransport',
  ].map(name => {
    const match = service.match(new RegExp(`^    private fun ${name}\\([\\s\\S]*?^    }`, 'm'));
    assert.ok(match, `Native method ${name} must be extracted, not replaced with a JS approximation`);
    return match[0];
  });
  // Le refus de QUIC vit hors de ces méthodes : une constante, une fonction à
  // corps d'expression et deux fonctions nommées, toutes appelées depuis
  // buildRawSingBoxConfig. L'extraction par nom ci-dessus ne sait reprendre
  // que des fonctions à corps de bloc, donc ce bloc contigu est repris tel
  // quel — sinon le harnais compile des références orphelines.
  const quicDebut = service.indexOf('    private val TRANSPORTS_SANS_UDP');
  const quicApres = service.indexOf('    private fun tunInbound(', quicDebut);
  assert.ok(
    quicDebut >= 0 && quicApres > quicDebut,
    'QUIC refusal block must be extracted: expected TRANSPORTS_SANS_UDP before tunInbound',
  );
  const quicBrut = service.slice(quicDebut, quicApres);
  const quicBloc = quicBrut.slice(0, quicBrut.lastIndexOf('\n    }') + '\n    }'.length);
  for (const membre of ['transportSansUdp', 'quicBlockRule', 'refusDeQuicDejaPresent', 'transportDeLaSortie']) {
    assert.ok(quicBloc.includes(`fun ${membre}`), `QUIC refusal member missing from harness: ${membre}`);
  }
  const transportStart = service.indexOf('    private data class EngineTransport(');
  const transportEnd = service.indexOf('\n    )', transportStart) + '\n    )'.length;
  assert.ok(transportStart > 0 && transportEnd > transportStart);
  const nullHelperStart = service.indexOf('private fun JSONObject.optStringOrNull(');
  const nullHelperEnd = service.indexOf('\n}', nullHelperStart) + 2;
  assert.ok(nullHelperStart > 0 && nullHelperEnd > nullHelperStart);
  const resolverConstant = service.match(/^\s+private const val RESOLVEUR_TUNNEL[^\r\n]+/m)?.[0].trim();
  assert.ok(resolverConstant);
  return `import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale
import com.sxbvpn.vpnmodule.SxbTunnelPolicy
import com.sxbvpn.vpnmodule.SxbEngineSchema
import com.sxbvpn.vpnmodule.SxbProtocolCompatibility
${service.slice(nullHelperStart, nullHelperEnd)}
${resolverConstant}

private object SxbSecureLogger {
    fun warn(message: String) {}
}

private class XrayRuntimeHarness {
    // Le harnais reproduit le chemin de production EXACT : le générateur écrit
    // la configuration, puis SxbEngineSchema l'adapte au moteur — comme le fait
    // startLibboxService(), qui est la frontière unique du moteur. Vérifier la
    // sortie du seul générateur prouverait quelque chose que l'application
    // n'exécute jamais.
    fun build(config: JSONObject): String =
        SxbEngineSchema.moderniser(JSONObject(
            if (config.optString("protocol") == "vless") buildSingBoxConfig(config, "vless")
            else buildRawSingBoxConfig(config)
        )).toString(2)
    private fun broadcastLog(message: String) {}
    private fun bootstrapDnsAddress(): String = "192.0.2.1"
    private fun dnsStrategy(): String = "ipv4_only"
    private fun tunnelDnsStrategy(): String = "ipv4_only"
${quicBloc}
${service.slice(transportStart, transportEnd)}

${methods.join('\n\n')}
}

fun main(args: Array<String>) {
    require(args.size == 2) { "Expected synthetic canonical input and runtime output paths" }
    val input = JSONObject(File(args[0]).readText())
    val runtime = XrayRuntimeHarness().build(input)
    File(args[1]).writeText(runtime)
}
`;
}

export function vlessParityRuntimeInputs() {
  return vlessParityFixtures.flatMap(({ uri, xray }, index) => {
    const json = parseImportedConfig(JSON.stringify(xray));
    const flat = parseImportedConfig(uri);
    assert.ok(json.ok, json.errors.join(' | '));
    assert.ok(flat.ok, flat.errors.join(' | '));
    return [
      { name: `parity-${index}-uri`, config: { ...engineConfigFromCanonical(flat.canonical), dns: '192.0.2.53' } },
      { name: `parity-${index}-json`, config: engineConfigFromCanonical(json.canonical) },
      { name: `parity-${index}-legacy`, config: xray },
    ];
  });
}

export function effectiveVlessOutbound(runtime) {
  const outbound = structuredClone(runtime.outbounds.find(item => item.type === 'vless'));
  assert.ok(outbound, 'Runtime must contain a VLESS proxy');
  delete outbound.tag;
  if (outbound.tls?.enabled) {
    outbound.tls.insecure ??= false;
    outbound.tls.disable_sni ??= false;
    if (outbound.tls.reality?.short_id === '') delete outbound.tls.reality.short_id;
    if (outbound.tls.utls?.enabled === false) delete outbound.tls.utls;
  } else delete outbound.tls;
  if (outbound.transport?.type === 'ws') {
    outbound.transport.max_early_data ??= 0;
    outbound.transport.early_data_header_name ??= '';
  }
  return outbound;
}

export function checkVlessParityRuntime(directory) {
  for (let index = 0; index < vlessParityFixtures.length; index++) {
    const runtime = kind => JSON.parse(readFileSync(path.join(directory, `runtime-parity-${index}-${kind}.json`), 'utf8'));
    const flat = effectiveVlessOutbound(runtime('uri'));
    assert.deepEqual(effectiveVlessOutbound(runtime('json')), flat, `${vlessParityFixtures[index].name}: translated JSON`);
    assert.deepEqual(effectiveVlessOutbound(runtime('legacy')), flat, `${vlessParityFixtures[index].name}: legacy native JSON`);
  }
}

export function syntheticCanonicalForRuntime() {
  const parsed = parseImportedConfig(JSON.stringify(xrayHttpChainFixture()));
  assert.ok(parsed.ok, parsed.errors.join(' | '));
  return engineConfigFromCanonical(parsed.canonical);
}

export function bundleRuntimeInputs() {
  return ['vless', 'vmess', 'trojan', 'shadowsocks', 'shadowsocks-legacy', 'socks', 'wireguard'].flatMap(protocol => {
    const raw = bundleXray(protocol === 'shadowsocks-legacy' ? 'shadowsocks' : protocol);
    const settings = raw.outbounds[0].settings;
    if (settings.peers) settings.peers[0].endpoint = 'vpn.example.test:23456';
    else (settings.servers ?? settings.vnext)[0].address = 'vpn.example.test';
    if (protocol === 'shadowsocks-legacy') {
      settings.servers[0].method = 'aes-256-gcm';
      settings.servers[0].password = 'synthetic-password';
    }
    const parsed = parseImportedConfig(JSON.stringify({ tunnelType: 7, v2rayjson: raw }));
    assert.ok(parsed.ok, parsed.errors.join(' | '));
    return [
      { name: `${protocol}-canonical`, config: engineConfigFromCanonical(parsed.canonical) },
      { name: `${protocol}-legacy`, config: raw },
    ];
  });
}

export function checkBundleRuntime(runtime) {
  assert.equal(runtime.route.default_domain_resolver, 'dns-bootstrap', 'VPN endpoint resolution must not select a hosts table');
  assert.ok(runtime.dns.servers.some(server => server.type === 'hosts'
    && server.predefined?.['only.example.test']?.includes('192.0.2.1')), 'Exact DNS hosts mappings must survive the real native builder');
  const wireguard = runtime.endpoints?.find(endpoint => endpoint.type === 'wireguard');
  if (wireguard) {
    assert.equal(wireguard.system, false, 'No parallel system TUN');
    assert.equal(wireguard.peers[0].persistent_keepalive_interval, 25);
    assert.deepEqual(wireguard.peers[0].reserved, [0, 127, 255]);
    assert.equal(wireguard.mtu, 1420);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--check-parity') {
    assert.equal(process.argv.length, 4);
    checkVlessParityRuntime(process.argv[3]);
    console.log('Actual Kotlin VLESS outbounds match for URI, translated JSON and legacy JSON.');
  } else if (process.argv[2] === '--check-bundle') {
    assert.equal(process.argv.length, 4);
    checkBundleRuntime(JSON.parse(readFileSync(process.argv[3], 'utf8')));
    console.log('Source-derived bundle graph preserves bootstrap DNS, exact hosts and WireGuard options.');
  } else {
    assert.equal(process.argv.length, 3, 'Pass an output directory for synthetic CI artifacts');
    const output = path.resolve(process.argv[2]);
    const build = readFileSync(path.join(root, 'app-mobile', 'scripts', 'build-libbox.sh'), 'utf8');
    assert.ok(build.includes(`SING_BOX_VERSION:-v${SING_BOX_VERSION}`), 'Harness must follow the app engine pin');
    mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, 'canonical.json'), JSON.stringify(syntheticCanonicalForRuntime(), null, 2));
    writeFileSync(path.join(output, 'XrayRuntimeHarness.kt'), nativeCompatibilityHarnessSource());
    for (const { name, config } of bundleRuntimeInputs()) {
      writeFileSync(path.join(output, `bundle-${name}.json`), JSON.stringify(config, null, 2));
    }
    for (const { name, config } of vlessParityRuntimeInputs()) {
      writeFileSync(path.join(output, `${name}.json`), JSON.stringify(config, null, 2));
    }
    console.log('Synthetic canonical and source-derived Kotlin runtime harness prepared; no engine was started.');
  }
}

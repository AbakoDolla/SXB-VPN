import './register-hooks.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { xrayHttpChainFixture } from './fixtures/xray-http-chain.mjs';

const { parseImportedConfig, engineConfigFromCanonical } = await import('../../server/services/canonical-config.ts');
const root = fileURLToPath(new URL('../../', import.meta.url));
export const SING_BOX_VERSION = '1.11.15';

export function nativeCompatibilityHarnessSource() {
  const service = readFileSync(path.join(root, 'app-mobile', 'modules', 'android-native', 'SxbVpnService.kt'), 'utf8');
  const methods = [
    'tunInbound', 'isLiteralIp', 'dnsAddressHost', 'applyDnsLoopGuard',
    'stripUnsupportedSingBoxVlessFields', 'convertXrayToSingBoxIfNeeded',
    'normalizeRawSingBoxCompatibility', 'buildRawSingBoxConfig',
  ].map(name => {
    const match = service.match(new RegExp(`^    private fun ${name}\\([\\s\\S]*?^    }`, 'm'));
    assert.ok(match, `Native method ${name} must be extracted, not replaced with a JS approximation`);
    return match[0];
  });
  return `import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale
import com.sxbvpn.vpnmodule.SxbTunnelPolicy

private object SxbSecureLogger {
    fun warn(message: String) {}
}

private class XrayRuntimeHarness {
    fun build(config: JSONObject): String = buildRawSingBoxConfig(config)
    private fun broadcastLog(message: String) {}
    private fun bootstrapDnsAddress(): String = "192.0.2.1"
    private fun dnsStrategy(): String = "ipv4_only"
    private fun defaultDnsObject(detourTag: String): JSONObject =
        error("Synthetic profile DNS must not be replaced by the app default")
    // Only physical network state is stubbed. No DNS lookup or socket is opened.
    private fun carrierExclusionRule(server: String): JSONObject {
        check(server == "upstream1.example.test") { "Unexpected physical chain endpoint" }
        return JSONObject().put("ip_cidr", JSONArray().put("192.0.2.100/32")).put("outbound", "direct")
    }

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

export function syntheticCanonicalForRuntime() {
  const parsed = parseImportedConfig(JSON.stringify(xrayHttpChainFixture()));
  assert.ok(parsed.ok, parsed.errors.join(' | '));
  return engineConfigFromCanonical(parsed.canonical);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, 'Pass an output directory for synthetic CI artifacts');
  const output = path.resolve(process.argv[2]);
  const build = readFileSync(path.join(root, 'app-mobile', 'scripts', 'build-libbox.sh'), 'utf8');
  assert.ok(build.includes(`SING_BOX_VERSION:-v${SING_BOX_VERSION}`), 'Harness must follow the app engine pin');
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'canonical.json'), JSON.stringify(syntheticCanonicalForRuntime(), null, 2));
  writeFileSync(path.join(output, 'XrayRuntimeHarness.kt'), nativeCompatibilityHarnessSource());
  console.log('Synthetic canonical and source-derived Kotlin runtime harness prepared; no engine was started.');
}

const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const temp = mkdtempSync(path.join(os.tmpdir(), 'sxb-connection-dns-'));
try {
  const source = readFileSync(path.resolve(__dirname, '..', 'modules', 'android-native', 'SxbVpnService.kt'), 'utf8');
  const names = ['connectionDnsChoice', 'applyConnectionDnsOverride', 'profileDnsObject', 'buildSshSocksRelayConfig'];
  const methods = names.map(name => {
    const match = source.match(new RegExp(`^    private fun ${name}\\([\\s\\S]*?^    }`, 'm'));
    assert.ok(match, `Must extract actual DNS method ${name}`);
    return match[0];
  });
  const helper = path.join(temp, 'ConnectionDnsHarness.kt');
  writeFileSync(helper, `package com.sxbvpn.vpnmodule
import org.json.JSONObject
import org.json.JSONArray
class ConnectionDnsHarness {
 companion object { const val RESOLVEUR_TUNNEL = "tcp://8.8.8.8"; const val SOCKS5_PORT = 1080 }
 private fun JSONObject.optStringOrNull(key: String, fallback: String): String = opt(key).let { if (it is String) it else fallback }
 private fun bootstrapDnsAddress() = "192.0.2.1"
 private fun dnsStrategy() = "ipv4_only"
 private fun tunnelDnsStrategy() = "ipv4_only"
 private fun applyDnsLoopGuard(value: JSONObject, hosts: List<String>) = value
 fun ssh(choice: String) = JSONObject(buildSshSocksRelayConfig("ssh.example.test", false, choice))
 fun choice(cfg: JSONObject) = connectionDnsChoice(cfg)
 fun overrideDns(source: JSONObject, choice: String, target: String) = applyConnectionDnsOverride(source, choice, target)
${methods.join('\n')}
}`);
  const jar = path.join(temp, 'dns.jar');
  let command = process.env.KOTLINC || 'kotlinc';
  let args = [helper, path.join(__dirname, 'ConnectionDnsRuntimeTest.kt'), '-classpath', process.env.SXB_JSON_JAR,
    '-include-runtime', '-d', jar];
  if (process.platform === 'win32' && command.endsWith('.bat')) {
    const home = path.resolve(path.dirname(command), '..');
    args = [`-Dkotlin.home=${home}`, '-cp', path.join(home, 'lib', '*'),
      'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', ...args];
    command = process.env.JAVA || 'java';
  }
  let result = spawnSync(command, args, { encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.stderr || 'DNS harness compile failed');
  result = spawnSync(process.env.JAVA || 'java', ['-cp', `${jar}${path.delimiter}${process.env.SXB_JSON_JAR}`,
    'com.sxbvpn.vpnmodule.ConnectionDnsRuntimeTestKt'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || 'Actual native DNS policy failed');
  process.stdout.write(result.stdout);
} finally { rmSync(temp, { recursive: true, force: true }); }

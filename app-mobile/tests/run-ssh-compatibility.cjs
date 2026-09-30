const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const jsonJar = process.env.SXB_JSON_JAR;
const jschJar = process.env.SXB_JSCH_JAR;
assert.ok(jsonJar && existsSync(jsonJar), 'Set SXB_JSON_JAR to org.json 20240303');
assert.ok(jschJar && existsSync(jschJar), 'Set SXB_JSCH_JAR to the declared JSch 0.2.21 dependency');
const temp = mkdtempSync(path.join(os.tmpdir(), 'sxb-ssh-compat-'));
let peer;
function run(command, args) {
  if (process.platform === 'win32' && command === process.env.KOTLINC && command.endsWith('.bat')) {
    const home = path.resolve(path.dirname(command), '..');
    return run(process.env.JAVA || 'java', [
      `-Dkotlin.home=${home}`, '-cp', path.join(home, 'lib', '*'),
      'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', ...args,
    ]);
  }
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, timeout: 120000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed`);
}
try {
  const service = readFileSync(path.resolve(__dirname, '..', 'modules', 'android-native', 'SxbVpnService.kt'), 'utf8');
  const start = service.indexOf('private fun isIpLiteralHost');
  const end = service.indexOf('class SxbVpnService :');
  assert.ok(start > 0 && end > start);
  const keyStart = service.indexOf('            val privateKeyBase64 =');
  const keyEnd = service.indexOf('\n            // C5', keyStart);
  assert.ok(keyStart > end && keyEnd > keyStart);
  const declarations = `import org.json.JSONObject
import com.jcraft.jsch.*
import java.io.*
import java.net.*
import java.security.*
import java.util.*
import javax.net.ssl.*
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import com.sxbvpn.vpnmodule.SxbUdpGateway
object Log { fun i(tag: String, message: String) {} ; fun w(tag: String, message: String) {}; fun d(tag: String, message: String) {} }
object SxbSecureLogger { fun debug(message: String) {} ; fun warn(message: String) {}; fun isDiagnosticEnabled() = false }
object SystemClock { fun elapsedRealtime() = 1000L }
`;
  const harness = path.join(temp, 'SshCompatibilityHarness.kt');
  const tests = readFileSync(path.join(__dirname, 'SshCompatibilityTest.kt'), 'utf8');
  const candidateConnect = service.match(/^\s*candidate\.connect\([^\r\n]+\)$/gm);
  assert.equal(candidateConnect?.length, 1, 'Extract the exact production ladder connect call');
  const socksStart = service.indexOf('    private fun startLocalSocks5Server(');
  const socksEnd = service.indexOf('    private fun startTrafficAccounting()', socksStart);
  assert.ok(socksStart > end && socksEnd > socksStart);
  const logStart = service.indexOf('    private fun broadcastLog(message:');
  const logEnd = service.indexOf('    private fun sendLogBroadcast(', logStart);
  const classifyStart = service.indexOf('    private fun classifyVpnError(');
  const classifyEnd = service.indexOf('    private fun failVpn(', classifyStart);
  const security = readFileSync(path.resolve(__dirname, '..', 'modules', 'android-native', 'SecurityModule.kt'), 'utf8');
  const maskStart = security.indexOf('    private val MOTIF_IPV4');
  const maskEnd = security.indexOf('    // ── Leurres', maskStart);
  assert.ok(logStart > end && logEnd > logStart && classifyStart > end && classifyEnd > classifyStart && maskStart > 0 && maskEnd > maskStart);
  writeFileSync(harness, declarations + service.slice(start, end) + `
object SecurityModule {
${security.slice(maskStart, maskEnd)}
}
class LogHarness {
    companion object { const val TAG = "fixture"; const val LOG_RATE_WINDOW_MS = 1000L; const val LOG_RATE_MAX_PER_WINDOW = 12 }
    val fullLogBuffer = StringBuilder()
    val sent = mutableListOf<String>()
    val logRateWindowStart = AtomicLong(1000L)
    val logRateCount = java.util.concurrent.atomic.AtomicInteger(0)
    private val connectionTracePolicy = SxbConnectionTracePolicy()
    fun trimLogBufferLocked() {}
    fun sendLogBroadcast(message: String) { sent.add(message) }
    fun log(message: String) = broadcastLog(message)
    fun classify(message: String) = classifyVpnError(message)
    fun classify(error: Throwable) = classifyVpnError(error)
${service.slice(logStart, logEnd)}
${service.slice(classifyStart, classifyEnd)}
}
class SocksHarness {
    val running = AtomicBoolean(true)
    val uploadBytes = AtomicLong(0)
    val downloadBytes = AtomicLong(0)
    companion object { const val SOCKS5_PORT = 0; const val TAG = "fixture" }
    fun traceConnexion(message: String) {}
    fun broadcastLog(message: String) {}
    fun start(session: Session) = startLocalSocks5Server(session, "none", "127.0.0.1", 7300)
${service.slice(socksStart, socksEnd)}
}
private fun importedIdentity(cfg: JSONObject): JSch {
    val jsch = JSch()
${service.slice(keyStart, keyEnd)}
    return jsch
}
private fun connectCandidate(candidate: Session, timeoutMs: Int) {
${candidateConnect[0]}
}
` + tests);
  const base64 = path.join(temp, 'AndroidBase64.kt');
  writeFileSync(base64, `package android.util
object Base64 {
 const val DEFAULT = 0
 const val NO_WRAP = 2
 fun decode(value: String, flags: Int): ByteArray = java.util.Base64.getDecoder().decode(value)
 fun encodeToString(value: ByteArray, flags: Int): String = java.util.Base64.getEncoder().encodeToString(value)
}
`);
  const jar = path.join(temp, 'ssh-compat.jar');
  const androidContext = path.join(temp, 'Context.kt');
  writeFileSync(androidContext, 'package android.content\nopen class Context\n');
  const gatewayDependencies = path.join(temp, 'GatewayDependencies.kt');
  writeFileSync(gatewayDependencies, `package com.sxbvpn.vpnmodule
import android.content.Context
import org.json.JSONObject
object SxbBackendTls {
 fun base(context: Context): String = System.getProperty("sxb.test.gateway.url")
 fun socketFactory(context: Context) = javax.net.ssl.SSLSocketFactory.getDefault() as javax.net.ssl.SSLSocketFactory
}
object SxbDeviceProof {
 fun headers(context: Context, method: String, url: String, body: String, credential: String): JSONObject {
  check(method == "GET" && body.isEmpty() && credential == "synthetic.gateway.ticket")
  check(url == SxbBackendTls.base(context) + "/mobile/ssh-relay?connectionId=11111111-1111-4111-a111-111111111111&configId=synthetic-profile")
  return JSONObject().put("X-SXB-Time", "1234567890123").put("X-SXB-Nonce", "synthetic-proof")
 }
}
`);
  const classpath = `${jsonJar}${path.delimiter}${jschJar}`;
  run(process.env.KOTLINC || 'kotlinc', [harness, base64, androidContext, gatewayDependencies,
    path.join(__dirname, 'SshGatewayTest.kt'),
    path.resolve(__dirname, '..', 'modules', 'android-native', 'SxbGatewaySocketFactory.kt'),
    path.resolve(__dirname, '..', 'modules', 'android-native', 'SxbUdpGateway.kt'),
    '-classpath', classpath, '-include-runtime', '-d', jar]);
  const store = path.join(temp, 'loopback.p12');
  const keytool = process.env.KEYTOOL || 'keytool';
  run(keytool, ['-genkeypair', '-alias', 'loopback', '-keyalg', 'RSA', '-keysize', '2048',
    '-validity', '1', '-dname', 'CN=localhost', '-ext', 'SAN=dns:localhost',
    '-storetype', 'PKCS12', '-keystore', store, '-storepass', 'synthetic-test-only', '-noprompt']);
  const peerInfo = path.join(temp, 'peer.json');
  peer = spawn(process.execPath, [path.join(__dirname, 'ssh-data-peer.cjs'), peerInfo, store],
    { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
  const deadline = Date.now() + 15000;
  while (!existsSync(peerInfo) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  assert.ok(existsSync(peerInfo), 'Local SSH data peer did not start');
  if (!process.argv.includes('--gateway-only')) run(process.env.JAVA || 'java', [`-Djavax.net.ssl.trustStore=${store}`,
    '-Djavax.net.ssl.trustStorePassword=synthetic-test-only', '-cp', `${jar}${path.delimiter}${classpath}`,
    'SshCompatibilityHarnessKt', store, peerInfo]);
  run(process.env.JAVA || 'java', [`-Djavax.net.ssl.trustStore=${store}`,
    '-Djavax.net.ssl.trustStorePassword=synthetic-test-only', '-cp', `${jar}${path.delimiter}${classpath}`,
    'SshGatewayTestKt', peerInfo]);
} finally {
  peer?.kill();
  rmSync(temp, { recursive: true, force: true });
}

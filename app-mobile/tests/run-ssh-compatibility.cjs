const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const jsonJar = process.env.SXB_JSON_JAR;
const jschJar = process.env.SXB_JSCH_JAR;
assert.ok(jsonJar && existsSync(jsonJar), 'Set SXB_JSON_JAR to org.json 20240303');
assert.ok(jschJar && existsSync(jschJar), 'Set SXB_JSCH_JAR to the declared JSch 0.2.21 dependency');
const temp = mkdtempSync(path.join(os.tmpdir(), 'sxb-ssh-compat-'));
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
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
object Log { fun i(tag: String, message: String) {} ; fun w(tag: String, message: String) {} }
object SxbSecureLogger { fun debug(message: String) {} ; fun warn(message: String) {} }
`;
  const harness = path.join(temp, 'SshCompatibilityHarness.kt');
  const tests = readFileSync(path.join(__dirname, 'SshCompatibilityTest.kt'), 'utf8');
  writeFileSync(harness, declarations + service.slice(start, end) + `
private fun importedIdentity(cfg: JSONObject): JSch {
    val jsch = JSch()
${service.slice(keyStart, keyEnd)}
    return jsch
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
  const classpath = `${jsonJar}${path.delimiter}${jschJar}`;
  run(process.env.KOTLINC || 'kotlinc', [harness, base64, '-classpath', classpath, '-include-runtime', '-d', jar]);
  const store = path.join(temp, 'loopback.p12');
  const keytool = process.env.KEYTOOL || 'keytool';
  run(keytool, ['-genkeypair', '-alias', 'loopback', '-keyalg', 'RSA', '-keysize', '2048',
    '-validity', '1', '-dname', 'CN=localhost', '-ext', 'SAN=dns:localhost',
    '-storetype', 'PKCS12', '-keystore', store, '-storepass', 'synthetic-test-only', '-noprompt']);
  run(process.env.JAVA || 'java', [`-Djavax.net.ssl.trustStore=${store}`,
    '-Djavax.net.ssl.trustStorePassword=synthetic-test-only', '-cp', `${jar}${path.delimiter}${classpath}`,
    'SshCompatibilityHarnessKt', store]);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const { spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const jar = process.env.SXB_JSON_JAR;
assert.ok(jar && existsSync(jar), 'Set SXB_JSON_JAR to the existing org.json JVM library');
const temporary = mkdtempSync(path.join(os.tmpdir(), 'sxb-root-policy-'));
const fixtures = [];
const fixture = (name, content) => {
  const file = path.join(temporary, name); writeFileSync(file, content); fixtures.push(file);
};
function run(command, args) {
  if (process.platform === 'win32' && command.endsWith('.bat')) {
    const home = path.resolve(path.dirname(command), '..');
    return run(process.env.JAVA || 'java', [`-Dkotlin.home=${home}`, '-cp', path.join(home, 'lib', '*'),
      'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', ...args]);
  }
  const result = spawnSync(command, args, { stdio: 'inherit', timeout: 120000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed`);
}
try {
  fixture('AndroidContext.kt', `package android.content
import java.io.File
class Intent(val action: String) {
 var state = ""
 fun setPackage(name: String) = this
 fun putExtra(name: String, value: String): Intent { state = value; return this }
}
class Context(val filesDir: File, val authority: String) {
 val packageName = "synthetic.sxb"
 val applicationContext get() = this
 val packageManager = android.content.pm.PackageManager(this)
 val broadcasts = java.util.Collections.synchronizedList(mutableListOf<String>())
 fun sendBroadcast(intent: Intent) { broadcasts.add(intent.state) }
}
`);
  fixture('AndroidPackage.kt', `package android.content.pm
class Metadata(private val context: android.content.Context) {
 fun getString(name: String): String? = if (name == "com.sxbvpn.ROOT_APPROVAL_PUBLIC_KEY") context.authority else null
}
class ApplicationInfo(context: android.content.Context) { val metaData = Metadata(context) }
class PackageInfo { val versionName = "synthetic" }
class PackageManager(private val context: android.content.Context) {
 companion object { const val GET_META_DATA = 128 }
 fun getApplicationInfo(name: String, flags: Int) = ApplicationInfo(context)
 fun getPackageInfo(name: String, flags: Int) = PackageInfo()
}
`);
  fixture('AndroidUtil.kt', `package android.util
object Base64 {
 const val DEFAULT = 0
 const val NO_WRAP = 2
 fun decode(value: String, flags: Int) = java.util.Base64.getDecoder().decode(value)
 fun encodeToString(value: ByteArray, flags: Int) = java.util.Base64.getEncoder().encodeToString(value)
}
object Log {
 val messages = java.util.Collections.synchronizedList(mutableListOf<String>())
 fun e(tag: String, message: String, error: Throwable? = null) { messages.add(message) }
 fun w(tag: String, message: String, error: Throwable? = null) { messages.add(message) }
}
`);
  fixture('AndroidBuild.kt', 'package android.os\nobject Build { const val MODEL = "Synthetic root fixture" }\n');
  fixture('NativeAdapters.kt', `package com.sxbvpn.vpnmodule
import java.io.File
import org.json.JSONObject
object KeystoreManager {
 var failWrites = false
 fun exists(file: File) = file.exists()
 fun readEncoded(file: File) = file.readText()
 fun decrypt(value: String) = value
 fun writeEncrypted(file: File, value: String) {
  check(!failWrites) { "SYNTHETIC_WRITE_REFUSED" }
  file.writeText(value)
 }
}
object SecurityModule { @Volatile var rooted = false; fun isRooted(context: android.content.Context) = rooted }
object SxbDeviceProof {
 fun identity() = JSONObject().put("keyId", "a".repeat(64)).put("publicKey", "synthetic-installation-public-key")
 fun headers(context: android.content.Context, method: String, url: String, body: String, credential: String): JSONObject {
  check(method == "POST" && url == "https://root.example.test/api/mobile-security/root-access" &&
   credential == SxbRootLeasePolicy.CREDENTIAL)
  return JSONObject().put("X-SXB-Proof", "synthetic-request-adapter")
 }
}
object SxbBackendTls {
 fun base(context: android.content.Context) = "https://root.example.test/api"
 fun protect(context: android.content.Context, connection: javax.net.ssl.HttpsURLConnection) {
  check(connection.url.host == "root.example.test")
 }
}
class SxbVpnService {
 companion object { val instance: SxbVpnService? = SxbVpnService() }
 var stops = 0
 fun stopForAccess() { stops++ }
}
`);
  const native = name => path.resolve(__dirname, '..', 'modules', 'android-native', name);
  assert.ok(readFileSync(native('SxbRootAccess.kt'), 'utf8').includes('trustedKey(context)'));
  const output = path.join(temporary, 'root-access.jar');
  run(process.env.KOTLINC || 'kotlinc', [...fixtures, native('SxbRootLeasePolicy.kt'), native('SxbRootAccess.kt'),
    path.join(__dirname, 'RootAccessTest.kt'), '-classpath', jar, '-include-runtime', '-d', output]);
  const storage = path.join(temporary, 'storage');
  require('node:fs').mkdirSync(storage);
  run(process.env.JAVA || 'java', ['-cp', `${output}${path.delimiter}${jar}`, 'com.sxbvpn.vpnmodule.RootAccessTestKt', storage]);
} finally { rmSync(temporary, { recursive: true, force: true }); }

// Source-derived JVM contracts with synthetic Android adapters/software keys.
// This is NOT Android Keystore, APK or physical-device proof.
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { require: requireTypescript } = require('tsx/cjs/api');

const jsonJar = process.env.SXB_JSON_JAR;
assert.ok(jsonJar && existsSync(jsonJar), 'Set SXB_JSON_JAR to the real org.json JVM jar');
const temp = mkdtempSync(path.join(__dirname, '.device-security-'));
const source = name => readFileSync(path.resolve(__dirname, '..', 'modules', 'android-native', name), 'utf8');
const generated = [];
function fixture(name, contents) {
  const target = path.join(temp, name);
  writeFileSync(target, contents); generated.push(target);
}
function run(command, args) {
  let actual = command, parameters = args;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
    actual = 'powershell.exe';
    parameters = ['-NoProfile', '-Command', `& ${[command, ...args].map(quote).join(' ')}; exit $LASTEXITCODE`];
  }
  const result = spawnSync(actual, parameters, { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed`);
}
try {
  const proof = source('SxbDeviceProof.kt');
  const hash = proof.slice(proof.indexOf('    fun hash('), proof.indexOf('    @Synchronized'));
  const headers = proof.match(/^    fun headers\([\s\S]*?^    }/m)?.[0];
  assert.ok(hash && headers?.includes('SXB-PROOF-1'), 'Production proof methods missing');
  fixture('ProofHarness.kt', `package com.sxbvpn.vpnmodule
import android.content.Context
import android.util.Base64
import org.json.JSONObject
import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Signature
object ProofHarness {
  val softwareKey = java.security.KeyPairGenerator.getInstance("EC").apply {
    initialize(java.security.spec.ECGenParameterSpec("secp256r1"))
  }.generateKeyPair()
  private fun identity() = Unit
${hash}
${headers.replace('store().getKey(ALIAS, null) as java.security.PrivateKey', 'softwareKey.private')}
}
`);
  fixture('AndroidUtil.kt', `package android.util
object Base64 {
  const val DEFAULT = 0
  const val NO_PADDING = 1
  const val NO_WRAP = 2
  const val URL_SAFE = 8
  fun encodeToString(bytes: ByteArray, flags: Int): String {
    var encoder = if (flags and URL_SAFE != 0) java.util.Base64.getUrlEncoder() else java.util.Base64.getEncoder()
    if (flags and NO_PADDING != 0) encoder = encoder.withoutPadding()
    return encoder.encodeToString(bytes)
  }
  fun decode(value: String, flags: Int): ByteArray =
    (if (flags and URL_SAFE != 0) java.util.Base64.getUrlDecoder() else java.util.Base64.getDecoder()).decode(value)
}
object Log {
  val messages = mutableListOf<String>()
  fun w(tag: String, message: String) { messages.add(message) }
  fun e(tag: String, message: String, error: Throwable? = null) { messages.add(message) }
}
`);
  fixture('AndroidContext.kt', `package android.content
class Preferences {
  val values = mutableMapOf<String, Any>()
  var failWrites = false
  fun getString(key: String, fallback: String?): String? = values[key] as? String ?: fallback
  fun getLong(key: String, fallback: Long): Long = values[key] as? Long ?: fallback
  fun getInt(key: String, fallback: Int): Int = values[key] as? Int ?: fallback
  fun getBoolean(key: String, fallback: Boolean): Boolean = values[key] as? Boolean ?: fallback
  fun edit() = Editor(this)
}
class Editor(private val prefs: Preferences) {
  private val next = mutableMapOf<String, Any>()
  private val removed = mutableListOf<String>()
  fun putString(key: String, value: String?): Editor {
    if (value == null) removed.add(key) else next[key] = value
    return this
  }
  fun putLong(key: String, value: Long): Editor { next[key] = value; return this }
  fun putBoolean(key: String, value: Boolean): Editor { next[key] = value; return this }
  fun remove(key: String): Editor { removed.add(key); return this }
  fun commit(): Boolean {
    if (prefs.failWrites) return false
    removed.forEach { prefs.values.remove(it) }
    prefs.values.putAll(next); return true
  }
}
open class Context {
  companion object { const val MODE_PRIVATE = 0 }
  var preferences = mutableMapOf<String, Preferences>()
  val storage get() = getSharedPreferences("sxb_security_events_v1", MODE_PRIVATE)
  var apiBase = "https://127.0.0.1/api"
  val packageName = "synthetic.sxb"
  var permissionGranted = false
  var rootAllowed = true
  val packageManager = android.content.pm.PackageManager(this)
  fun getSharedPreferences(name: String, mode: Int) = preferences.getOrPut(name) { Preferences() }
}
`);
  fixture('AndroidPackageManager.kt', `package android.content.pm
class Metadata(private val context: android.content.Context) {
  fun getString(name: String): String? = if (name == "com.sxbvpn.api_base_url") context.apiBase else null
}
class ApplicationInfo(context: android.content.Context) { val metaData = Metadata(context) }
class PackageManager(private val context: android.content.Context) {
  companion object { const val GET_META_DATA = 128 }
  fun getApplicationInfo(name: String, flags: Int) = ApplicationInfo(context)
}
`);
  fixture('AndroidNet.kt', `package android.net
open class VpnService : android.content.Context() {
  companion object { fun prepare(context: android.content.Context): Any? = if (context.permissionGranted) null else Any() }
  open fun onRevoke() {}
}
`);
  fixture('AndroidOs.kt', `package android.os
object MainQueue {
  val work = mutableListOf<() -> Unit>()
  fun drain() { while (work.isNotEmpty()) work.removeAt(0)() }
}
object Looper { fun getMainLooper() = this }
class Handler(looper: Looper) { fun post(action: () -> Unit) { MainQueue.work.add(action) } }
`);
  const revoke = source('SxbVpnService.kt').match(/^    override fun onRevoke\(\)[\s\S]*?^    }/m)?.[0];
  assert.ok(revoke?.includes('VPN_REVOKED'), 'Production onRevoke missing');
  const access = source('SxbAccessControl.kt');
  const permissionMethods = ['checkStart', 'prepareStart', 'cancelStarts'].map(name => {
    const method = access.match(new RegExp(`^    fun ${name}\\([\\s\\S]*?^    }`, 'm'))?.[0];
    assert.ok(method, `Production ${name} missing`);
    return method;
  }).join('\n');
  fixture('AccessHarness.kt', `package com.sxbvpn.vpnmodule
import android.content.Context
import android.net.VpnService
import org.json.JSONObject
import java.util.UUID
// Business-authority checks are covered by run-access-policy, not this adapter.
object SxbPrivacyPolicy { fun vpnAllowed(context: Context) = true }
object SxbRootAccess {
 fun checkStart(context: Context) { check(context.rootAllowed) { "ROOT_APPROVAL_REQUIRED" } }
}
object SxbAccessPolicy { fun block(current: JSONObject, config: JSONObject): String? = null }
object AccessHarness {
  private var signedOut = false
  private var storageFailed = false
  var authority: JSONObject? = JSONObject().put("session", "synthetic-authority")
  private var allowedAttempt: String? = null
  private fun load(context: Context) {}
  private fun prefs(context: Context) = context.getSharedPreferences("sxb_access_control_v1", Context.MODE_PRIVATE)
${permissionMethods}
}
`);
  fixture('RuntimeHarness.kt', `package com.sxbvpn.vpnmodule
import android.content.Context
import android.util.Log
import org.json.JSONObject
// Identity transform is intentional: only queue behavior, not Keystore encryption, is under test.
object KeystoreManager { fun encrypt(value: String) = value; fun decrypt(value: String) = value }
object SxbAccessControl {
  fun cancelStarts(context: Context) {
    (context as RevokeHarness).cancelled++
    if (context.cancelFails) throw IllegalStateException("ACCESS_START_CANCEL_FAILED")
  }
}
class Reconnector { val reasons = mutableListOf<String>(); fun markStopped(reason: String) { reasons.add(reason) } }
class CloseableHarness { var closed = false; fun close() { closed = true }; fun disconnect() { closed = true } }
class RevokeHarness : android.net.VpnService() {
  companion object { var instance: RevokeHarness? = null; const val TAG = "test" }
  var configJson: String? = null
  var derniereCommandeStartId = 1
  lateinit var autoReconnect: Reconnector
  var cancelled = 0
  var cancelFails = false
  var cleaned = 0
  var blackholeRemoved = 0
  var interrupted = 0
  var nativeState = "connected"
  var sshTransportSocket: java.net.Socket? = java.net.Socket()
  var sshSession: CloseableHarness? = CloseableHarness()
  var socks5Server: CloseableHarness? = CloseableHarness()
  val statuses = mutableListOf<String>()
  init { instance = this; autoReconnect = Reconnector() }
  fun broadcastLog(value: String) {}
  fun broadcastStatus(value: String, code: String? = null) { statuses.add(value); errorCodes.add(code) }
  val errorCodes = mutableListOf<String?>()
  fun cleanup() { cleaned++ }
  fun interruptForAccess() { interrupted++ }
  fun setCurrentState(value: String) { nativeState = value }
  fun removeKillSwitchBlackhole() { blackholeRemoved++ }
${revoke}
}
`);
  const jar = path.join(temp, 'device-security.jar'), samples = path.join(temp, 'proofs.json');
  run(process.env.KOTLINC || 'kotlinc', [
    ...generated,
    path.resolve(__dirname, '..', 'modules', 'android-native', 'SxbSecurityMonitor.kt'),
    path.resolve(__dirname, '..', 'modules', 'android-native', 'SxbBackendTls.kt'),
    path.resolve(__dirname, '..', 'modules', 'android-native', 'SxbRootLeasePolicy.kt'),
    path.resolve(__dirname, 'DeviceSecurityTest.kt'),
    '-classpath', jsonJar, '-include-runtime', '-d', jar,
  ]);
  run(process.env.JAVA || 'java', ['-cp', `${jar}${path.delimiter}${jsonJar}`, 'com.sxbvpn.vpnmodule.DeviceSecurityTestKt', samples]);

  const { verifyMobileProof } = requireTypescript(
    path.resolve(__dirname, '..', '..', 'server', 'services', 'mobile-proof.ts'), __filename,
  );
  const request = sample => ({
    method: sample.method, originalUrl: sample.path,
    rawBody: Buffer.from(sample.body), body: sample.body ? { present: true } : {},
    get: name => sample.headers[name],
  });
  for (const sample of JSON.parse(readFileSync(samples, 'utf8'))) {
    const claims = sample.credential.split('.').length === 3
      ? JSON.parse(Buffer.from(sample.credential.split('.')[1], 'base64url').toString()) : {};
    assert.equal(verifyMobileProof(request(sample), sample.publicKey, sample.credential, claims).nonce, sample.headers['X-SXB-Nonce']);
    for (const changed of [
      { ...sample, body: sample.body + ' ' },
      { ...sample, path: sample.path + '&changed=1' },
      { ...sample, method: sample.method === 'GET' ? 'POST' : 'GET' },
    ]) assert.throws(() => verifyMobileProof(request(changed), sample.publicKey, sample.credential, claims));
    assert.throws(() => verifyMobileProof(request(sample), sample.publicKey, sample.credential + 'changed', claims));
    assert.throws(() => verifyMobileProof(request(sample), sample.publicKey, sample.credential, { ...claims, sg: 99 }));
  }
  console.log('PASS Kotlin/Node exact-byte signatures and method/path/body/credential/generation tampering (18 checks)');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

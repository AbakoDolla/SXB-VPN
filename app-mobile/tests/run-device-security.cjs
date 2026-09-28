// Source-derived JVM contracts with synthetic Android adapters/software keys.
// This is NOT Android Keystore, certificate-pinning, APK or physical-device proof.
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
object SxbBackendTls { fun base(context: Context) = context.apiBase }
`);
  fixture('AndroidUtil.kt', `package android.util
object Base64 {
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
  val values = mutableMapOf<String, String>()
  var failWrites = false
  fun getString(key: String, fallback: String?): String? = values[key] ?: fallback
  fun edit() = Editor(this)
}
class Editor(private val prefs: Preferences) {
  private val next = mutableMapOf<String, String>()
  fun putString(key: String, value: String): Editor { next[key] = value; return this }
  fun commit(): Boolean {
    if (prefs.failWrites) return false
    prefs.values.putAll(next); return true
  }
}
open class Context {
  companion object { const val MODE_PRIVATE = 0 }
  val storage = Preferences()
  var apiBase = "https://127.0.0.1/api"
  var permissionGranted = false
  fun getSharedPreferences(name: String, mode: Int) = storage
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
  fixture('RuntimeHarness.kt', `package com.sxbvpn.vpnmodule
import android.content.Context
import android.util.Log
// Identity transform is intentional: only queue behavior, not Keystore encryption, is under test.
object KeystoreManager { fun encrypt(value: String) = value; fun decrypt(value: String) = value }
object SxbAccessControl { fun cancelStarts(context: Context) { (context as RevokeHarness).cancelled++ } }
class Reconnector { val reasons = mutableListOf<String>(); fun markStopped(reason: String) { reasons.add(reason) } }
class RevokeHarness : android.net.VpnService() {
  companion object { var instance: RevokeHarness? = null; const val TAG = "test" }
  var configJson: String? = null
  var derniereCommandeStartId = 1
  lateinit var autoReconnect: Reconnector
  var cancelled = 0
  var cleaned = 0
  var blackholeRemoved = 0
  val statuses = mutableListOf<String>()
  init { instance = this; autoReconnect = Reconnector() }
  fun broadcastLog(value: String) {}
  fun broadcastStatus(value: String) { statuses.add(value) }
  fun cleanup() { cleaned++ }
  fun removeKillSwitchBlackhole() { blackholeRemoved++ }
${revoke}
}
`);
  const jar = path.join(temp, 'device-security.jar'), samples = path.join(temp, 'proofs.json');
  run(process.env.KOTLINC || 'kotlinc', [
    ...generated,
    path.resolve(__dirname, '..', 'modules', 'android-native', 'SxbSecurityMonitor.kt'),
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

package com.sxbvpn.vpnmodule

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.HttpsURLConnection

object SxbRootAccess {
    const val BROADCAST = "com.sxbvpn.ROOT_ACCESS"
    private const val CACHE = "sxb_root_access_v1.enc"
    private val refreshing = AtomicBoolean(false)
    private val scheduled = AtomicBoolean(false)
    private val executor = Executors.newSingleThreadScheduledExecutor { task ->
        Thread(task, "SXB-RootAccess").apply { isDaemon = true }
    }
    private val requests = Executors.newSingleThreadExecutor { task ->
        Thread(task, "SXB-RootRequest").apply { isDaemon = true }
    }
    private var receipt: JSONObject? = null
    private var loaded = false
    @Volatile private var cacheWriteFailed = false

    private fun trustedKey(context: Context): String {
        val info = context.packageManager.getApplicationInfo(context.packageName,
            android.content.pm.PackageManager.GET_META_DATA)
        val key = info.metaData?.getString("com.sxbvpn.ROOT_APPROVAL_PUBLIC_KEY")
        require(key != null && key.length in 100..256) { "ROOT_AUTHORITY_MISSING" }
        return key
    }

    @Synchronized
    private fun cache(context: Context): JSONObject? {
        if (!loaded) {
            val file = File(context.filesDir, CACHE)
            if (KeystoreManager.exists(file)) {
                try { receipt = JSONObject(KeystoreManager.decrypt(KeystoreManager.readEncoded(file))) }
                catch (error: Exception) {
                    receipt = null
                    Log.e("SXB-RootAccess", "ROOT_CACHE_INVALID", error)
                }
            }
            loaded = true
        }
        return receipt
    }

    fun state(context: Context): JSONObject {
        if (!SecurityModule.isRooted(context)) {
            return JSONObject().put("allowed", true).put("rooted", false)
        }
        val keyId = SxbDeviceProof.identity().getString("keyId")
        val now = System.currentTimeMillis()
        val lease = lease(context, keyId, now)
        val allowed = !cacheWriteFailed && lease?.let { SxbRootLeasePolicy.allowed(it, now) } == true
        return JSONObject().put("rooted", true).put("allowed", allowed).put("keyId", keyId)
            .put("code", if (allowed) "ROOT_ACCESS_APPROVED" else "ROOT_APPROVAL_REQUIRED")
            .put("expiresAt", lease?.optLong("expiresAt") ?: 0)
    }

    private fun lease(context: Context, keyId: String, now: Long): JSONObject? {
        val stored = cache(context) ?: return null
        return try { SxbRootLeasePolicy.verify(stored, keyId, trustedKey(context), now) }
        catch (error: Exception) {
            synchronized(this) { if (receipt === stored) receipt = null }
            Log.e("SXB-RootAccess", "ROOT_CACHE_INVALID", error)
            null
        }
    }

    fun checkStart(context: Context) {
        try {
            val current = state(context)
            if (current.getBoolean("rooted")) monitor(context)
            check(current.getBoolean("allowed")) { "ROOT_APPROVAL_REQUIRED" }
        }
        catch (error: IllegalStateException) { throw error }
        catch (error: Exception) {
            Log.e("SXB-RootAccess", "ROOT_CHECK_UNAVAILABLE", error)
            throw IllegalStateException("ROOT_CHECK_UNAVAILABLE", error)
        }
    }

    fun check(context: Context): JSONObject {
        val initial = state(context)
        if (!initial.getBoolean("rooted")) return initial
        if (!monitor(context)) requests.execute { refresh(context.applicationContext) }
        return initial
    }

    private fun monitor(context: Context): Boolean {
        if (scheduled.compareAndSet(false, true)) {
            val app = context.applicationContext
            executor.scheduleWithFixedDelay({
                enforce(app)
                requests.execute { refresh(app) }
            }, 60, 60, TimeUnit.SECONDS)
            requests.execute { refresh(app) }
            return true
        }
        return false
    }

    private fun refresh(context: Context) {
        if (!refreshing.compareAndSet(false, true)) return
        var connection: HttpsURLConnection? = null
        var deadline: java.util.concurrent.ScheduledFuture<*>? = null
        try {
            if (!SecurityModule.isRooted(context)) return
            val identity = SxbDeviceProof.identity()
            val body = JSONObject().put("publicKey", identity.getString("publicKey")).put("rooted", true)
                .put("deviceModel", Build.MODEL.take(80))
                .put("appVersion", context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "").toString()
            val endpoint = SxbBackendTls.base(context).trimEnd('/') + "/mobile-security/root-access"
            val headers = SxbDeviceProof.headers(context, "POST", endpoint, body, SxbRootLeasePolicy.CREDENTIAL)
            val http = URL(endpoint).openConnection() as HttpsURLConnection
            connection = http
            deadline = executor.schedule({ http.disconnect() }, 10, TimeUnit.SECONDS)
            SxbBackendTls.protect(context, http)
            http.requestMethod = "POST"
            http.connectTimeout = 3000
            http.readTimeout = 3000
            http.instanceFollowRedirects = false
            http.doOutput = true
            http.setRequestProperty("Content-Type", "application/json")
            for (name in headers.keys()) http.setRequestProperty(name, headers.getString(name))
            http.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            check(http.responseCode == 200) { "ROOT_ACCESS_HTTP_REFUSED" }
            val raw = http.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
                val chars = CharArray(8193)
                var count = 0
                while (count < chars.size) {
                    val read = reader.read(chars, count, chars.size - count)
                    if (read < 0) break
                    count += read
                }
                check(count < chars.size) { "ROOT_RESPONSE_TOO_LARGE" }
                String(chars, 0, count)
            }
            val next = JSONObject(raw)
            val now = System.currentTimeMillis()
            val nextLease = SxbRootLeasePolicy.verify(next, identity.getString("keyId"), trustedKey(context), now)
            synchronized(this) {
                val previous = lease(context, identity.getString("keyId"), now)
                if (!SxbRootLeasePolicy.accepts(previous, nextLease)) {
                    Log.w("SXB-RootAccess", "ROOT_RESPONSE_STALE")
                    return
                }
                receipt = next
                loaded = true
                try {
                    KeystoreManager.writeEncrypted(File(context.filesDir, CACHE), next.toString())
                    cacheWriteFailed = false
                } catch (error: Exception) {
                    cacheWriteFailed = true
                    Log.e("SXB-RootAccess", "ROOT_CACHE_WRITE_FAILED", error)
                    throw error
                }
            }
            val current = state(context)
            if (!current.getBoolean("allowed")) stopBlockedTunnel(context)
            context.sendBroadcast(Intent(BROADCAST).setPackage(context.packageName)
                .putExtra("state", current.toString()))
        } catch (error: Exception) {
            Log.w("SXB-RootAccess", "ROOT_ACCESS_REFRESH_UNAVAILABLE", error)
            val current = try { state(context) }
            catch (_: Exception) { JSONObject().put("allowed", false).put("rooted", true).put("code", "ROOT_CHECK_UNAVAILABLE") }
            if (!current.getBoolean("allowed")) {
                stopBlockedTunnel(context)
                context.sendBroadcast(Intent(BROADCAST).setPackage(context.packageName).putExtra("state", current.toString()))
            }
        } finally {
            deadline?.cancel(false)
            connection?.disconnect()
            refreshing.set(false)
        }
    }

    private fun enforce(context: Context) {
        val current = try { state(context) }
        catch (error: Exception) {
            Log.e("SXB-RootAccess", "ROOT_CHECK_UNAVAILABLE", error)
            JSONObject().put("allowed", false).put("rooted", true).put("code", "ROOT_CHECK_UNAVAILABLE")
        }
        if (!current.getBoolean("allowed")) {
            stopBlockedTunnel(context)
            context.sendBroadcast(Intent(BROADCAST).setPackage(context.packageName).putExtra("state", current.toString()))
        }
    }

    private fun stopBlockedTunnel(context: Context) {
        val allowed = try { state(context).getBoolean("allowed") }
        catch (error: Exception) { Log.e("SXB-RootAccess", "ROOT_CHECK_UNAVAILABLE", error); false }
        if (allowed) return
        try { SxbVpnService.instance?.stopForAccess() }
        catch (error: Exception) { Log.e("SXB-RootAccess", "ROOT_TUNNEL_STOP_FAILED", error) }
    }
}

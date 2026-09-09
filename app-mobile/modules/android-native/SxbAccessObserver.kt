package com.sxbvpn.vpnmodule

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.URL
import java.net.URLEncoder
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.HttpsURLConnection

/** One bounded HTTPS long poll, only while the VPN foreground service is alive. */
class SxbAccessObserver(private val context: Context) {
    private val running = AtomicBoolean(false)
    private val owner = UUID.randomUUID().toString()
    @Volatile private var connection: HttpsURLConnection? = null
    private var thread: Thread? = null

    fun start() {
        if (!SxbPrivacyPolicy.vpnAllowed(context) || !running.compareAndSet(false, true)) return
        thread = Thread({ observe() }, "SXB-Access").apply { isDaemon = true; start() }
    }

    fun stop() {
        running.set(false)
        connection?.disconnect()
        if (thread !== Thread.currentThread()) thread?.interrupt()
    }

    private fun readBody(http: HttpsURLConnection): String {
        require(http.contentType?.substringBefore(';')?.trim() == "application/json") { "ACCESS_RESPONSE_TYPE_INVALID" }
        require(http.contentLengthLong <= 2 * 1024 * 1024) { "ACCESS_RESPONSE_TOO_LARGE" }
        val stream = if (http.responseCode >= 400) http.errorStream else http.inputStream
        require(stream != null) { "ACCESS_RESPONSE_EMPTY" }
        return stream.use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (running.get()) {
                val count = input.read(buffer)
                if (count < 0) break
                require(output.size() + count <= 2 * 1024 * 1024) { "ACCESS_RESPONSE_TOO_LARGE" }
                output.write(buffer, 0, count)
            }
            check(running.get()) { "ACCESS_CANCELLED" }
            output.toString("UTF-8")
        }
    }

    private fun open(url: URL, physicalFallback: Boolean): HttpsURLConnection {
        val manager = context.getSystemService(ConnectivityManager::class.java)
            ?: throw IOException("ACCESS_NETWORK_UNAVAILABLE")
        val preferred = manager.activeNetwork
        val candidates = (listOfNotNull(preferred) + manager.allNetworks).distinct()
        val network = candidates.firstOrNull {
            val caps = manager.getNetworkCapabilities(it)
            caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true &&
                (!physicalFallback || caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN))
        } ?: throw IOException("ACCESS_NETWORK_UNAVAILABLE")
        // Prefer the active network, including the tunnel on zero-rated plans.
        // A physical-network retry helps handoff without adding any direct
        // public outbound to the Play tunnel or weakening HTTPS verification.
        return network.openConnection(url) as HttpsURLConnection
    }

    private fun observe() {
        var failures = 0
        var physicalFallback = false
        try {
            SxbAccessControl.setObserving(context, true, owner = owner)
            while (running.get() && SxbPrivacyPolicy.vpnAllowed(context)) {
                var delay = 1000L
                try {
                    val ticket = SxbAccessControl.readTicket(context) ?: break
                    val stamp = SxbAccessControl.requestStamp(context) ?: break
                    val runtime = JSONObject(SxbAccessControl.runtime(context))
                    val snapshot = runtime.optJSONObject("authority")?.optJSONObject("snapshot")
                    val revision = snapshot?.optString("revision", "")
                    val suffix = if (revision.isNullOrEmpty()) "" else "?revision=${URLEncoder.encode(revision, "UTF-8")}&wait=25"
                    val http = open(URL(ticket.getString("base") + "/mobile/access-state" + suffix), physicalFallback)
                    connection = http
                    http.instanceFollowRedirects = false
                    http.connectTimeout = 8000
                    http.readTimeout = 35_000
                    http.useCaches = false
                    http.setRequestProperty("Accept", "application/json")
                    http.setRequestProperty("Authorization", "Bearer " + ticket.getString("ticket"))
                    http.setRequestProperty("X-SXB-Device-ID", ticket.getString("deviceId"))
                    if (!running.get()) break
                    val status = http.responseCode
                    if (!running.get()) break
                    when (status) {
                        200 -> {
                            val result = JSONObject(readBody(http))
                            SxbAccessControl.applySnapshot(context, result, JSONArray(), stamp.first, stamp.second)
                            failures = 0
                            physicalFallback = false
                        }
                        401 -> {
                            // Only the read-only ticket is invalid. Never clear identity/JWT.
                            SxbAccessControl.invalidateTicket(context, "invalid")
                            break
                        }
                        403, 404, 405, 410, 501 -> {
                            val type = http.contentType?.substringBefore(';')?.trim()
                            val body = if (type == "application/json") JSONObject(readBody(http)) else null
                            if (body?.optString("scope") == "device" || body?.optString("scope") == "subscription") {
                                SxbAccessControl.applyIssue(context, body, JSONArray(), stamp.first, stamp.second)
                                delay = 30_000
                            } else {
                                SxbAccessControl.setObserving(context, false, "unsupported", owner)
                                break
                            }
                        }
                        else -> {
                            failures++
                            physicalFallback = !physicalFallback
                            delay = if (failures >= 6) 300_000 else SxbAccessPolicy.retryDelay(failures, http.getHeaderField("Retry-After"), System.currentTimeMillis())
                            Log.w("SXB-Access", "ACCESS_HTTP_DEFERRED status=$status")
                        }
                    }
                } catch (error: IOException) {
                    if (running.get()) {
                        physicalFallback = !physicalFallback
                        failures++
                        delay = if (failures >= 6) 300_000 else SxbAccessPolicy.retryDelay(failures, null, System.currentTimeMillis())
                        Log.w("SXB-Access", "ACCESS_NETWORK_DEFERRED")
                    }
                } catch (error: Exception) {
                    if (running.get()) {
                        // Invalid JSON/Keystore errors require foreground revalidation,
                        // not a success-shaped revoked/network fallback.
                        Log.e("SXB-Access", "ACCESS_REVALIDATION_REQUIRED")
                        SxbAccessControl.setObserving(context, false, "backoff", owner)
                    }
                    break
                } finally {
                    connection?.disconnect()
                    connection = null
                }
                if (running.get()) Thread.sleep(delay)
            }
        } catch (_: InterruptedException) {
            // stop() cancels both the socket and the bounded retry wait.
        } finally {
            running.set(false)
            connection?.disconnect()
            connection = null
            SxbAccessControl.setObserving(context, false, owner = owner)
        }
    }
}

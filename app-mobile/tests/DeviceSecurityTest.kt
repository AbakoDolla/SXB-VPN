package com.sxbvpn.vpnmodule

import android.content.Context
import android.os.MainQueue
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URL
import javax.net.ssl.HttpsURLConnection

private var checks = 0
private fun verify(value: Boolean, label: String) {
    check(value) { label }; checks++; println("PASS $label")
}
private fun rejects(label: String, action: () -> Unit) {
    val rejected = try { action(); false } catch (_: IllegalArgumentException) { true }
    verify(rejected, label)
}
private fun permissionRejects(label: String, action: () -> Unit) {
    val rejected = try { action(); false } catch (_: IllegalStateException) { true }
    verify(rejected, label)
}

fun main(args: Array<String>) {
    val context = Context()
    val claims = Base64.encodeToString("""{"sid":"synthetic-session","sg":7}""".toByteArray(), Base64.URL_SAFE or Base64.NO_PADDING)
    val credential = "synthetic.$claims.signature"
    val samples = JSONArray()
    for ((method, path, body, token) in listOf(
        listOf("POST", "/api/mobile/traffic", """{"bytes":42,"text":"\u00e9","space":"a b"}""", credential),
        listOf("GET", "/api/mobile-access/events?x=%2B&x=%20", "", credential),
        listOf("POST", "/api/mobile/activate", """{"deviceId":"synthetic-device"}""", "SXB-USER-SYNTHETIC")
    )) {
        val headers = ProofHarness.headers(context, method, "https://127.0.0.1$path", body, token)
        samples.put(JSONObject().put("method", method).put("path", path).put("body", body)
            .put("credential", token).put("headers", headers)
            .put("publicKey", Base64.encodeToString(ProofHarness.softwareKey.public.encoded, Base64.NO_WRAP)))
    }
    File(args.single()).writeText(samples.toString())
    rejects("proof refuses another backend origin") { ProofHarness.headers(context, "GET", "https://other.invalid/api/x", "", credential) }
    rejects("proof refuses another backend port") { ProofHarness.headers(context, "GET", "https://127.0.0.1:444/api/x", "", credential) }
    rejects("proof refuses paths outside the API prefix") { ProofHarness.headers(context, "GET", "https://127.0.0.1/apix/x", "", credential) }
    rejects("proof refuses URL fragments") { ProofHarness.headers(context, "GET", "https://127.0.0.1/api/x#part", "", credential) }
    context.apiBase = "http://127.0.0.1:4179/custom"
    verify(ProofHarness.headers(context, "GET", "http://127.0.0.1:4179/custom/x", "", credential).has("X-SXB-Proof"),
        "explicit alternate local API remains signable")

    val tlsContext = Context()
    val http = URL(tlsContext.apiBase).openConnection() as HttpsURLConnection
    val standardFactory = http.sslSocketFactory
    val standardHostname = http.hostnameVerifier
    SxbBackendTls.protect(tlsContext, http)
    verify(http.sslSocketFactory === standardFactory && http.hostnameVerifier === standardHostname,
        "observer retains normal platform certificate and hostname verification")
    rejects("observer still refuses another API origin") {
        SxbBackendTls.protect(tlsContext, URL("https://other.invalid/api/x").openConnection() as HttpsURLConnection)
    }

    val config = """{"securitySessionId":"original","securityGeneration":7,"securityClientId":"client-a","connectionId":"connection-a","usageSessionId":"usage-a","accessAttempt":"attempt-a","password":"synthetic-sensitive","token":"synthetic-sensitive","host":"private.example.invalid"}"""
    val revoked = RevokeHarness().apply { configJson = config }
    revoked.onRevoke()
    verify(revoked.cancelled == 1 && revoked.interrupted == 1, "permission loss cancels workers before the main-thread queue")
    verify(revoked.sshTransportSocket?.isClosed == true && revoked.sshSession?.closed == true,
        "permission loss closes the direct SSH transport and session synchronously")
    verify(revoked.nativeState == "disconnected", "another VPN stops the native state before the UI queue")
    MainQueue.drain()
    verify(revoked.cancelled == 1 && revoked.cleaned == 1 && revoked.blackholeRemoved == 1, "permission loss cancels starts and invokes cleanup once")
    verify(revoked.autoReconnect.reasons == listOf("system_vpn_revoke"), "permission loss disables automatic recovery")
    verify(revoked.statuses == listOf("disconnected"), "permission loss reports disconnection, not attack")
    verify(revoked.errorCodes == listOf("VPN_PERMISSION_REQUIRED"), "permission loss cancels stale JavaScript connection intents")
    val events = JSONArray(SxbSecurityMonitor.pending(revoked))
    verify(events.length() == 1 && events.getJSONObject(0).getString("connectionId") == "connection-a", "revoke event retains original connection")
    verify(!events.toString().contains("synthetic-sensitive") && !events.toString().contains("private.example.invalid"), "event excludes credentials and private config")
    val ids = JSONArray().put(events.getJSONObject(0).getString("id"))
    SxbSecurityMonitor.acknowledge(revoked, JSONArray())
    verify(JSONArray(SxbSecurityMonitor.pending(revoked)).length() == 1, "failed/offline delivery retains event")
    SxbSecurityMonitor.acknowledge(revoked, ids)
    verify(JSONArray(SxbSecurityMonitor.pending(revoked)).length() == 0, "only accepted event IDs are removed")

    val delayed = RevokeHarness().apply { configJson = config }
    delayed.onRevoke()
    delayed.permissionGranted = true
    delayed.derniereCommandeStartId++
    delayed.configJson = config.replace("connection-a", "connection-new")
    MainQueue.drain()
    verify(delayed.cleaned == 0 && delayed.cancelled == 1, "late callback cannot stop a new permission grant")
    verify(JSONArray(SxbSecurityMonitor.pending(delayed)).getJSONObject(0).getString("connectionId") == "connection-a",
        "late callback still persists its original event, not the new connection")
    val replaced = RevokeHarness().apply { configJson = config }
    replaced.onRevoke()
    val successor = RevokeHarness()
    MainQueue.drain()
    verify(replaced.cleaned == 0 && successor.cleaned == 0, "old service callback cannot stop its successor")
    val stale = RevokeHarness().apply { permissionGranted = true; configJson = config }
    stale.onRevoke(); MainQueue.drain()
    verify(stale.cleaned == 0 && SxbSecurityMonitor.pending(stale) == "[]", "already-restored permission is not misreported as a new revoke")

    val permission = Context().apply { permissionGranted = true }
    val obsolete = permission.getSharedPreferences("sxb_vpn_permission_v1", Context.MODE_PRIVATE)
    obsolete.edit().putBoolean("blocked", true).putLong("vpnPermissionGeneration", Long.MAX_VALUE).commit()
    obsolete.failWrites = true
    fun nextAttempt(): JSONObject = JSONObject(AccessHarness.prepareStart(permission,
        JSONObject().put("accessSession", "synthetic-authority")))
    val attempt = nextAttempt()
    AccessHarness.checkStart(permission, attempt)
    verify(!attempt.has("vpnPermissionGeneration"), "old APK185 permission block does not gate a normal start")
    AccessHarness.checkStart(permission, attempt)
    verify(true, "radio reconnect reuses its existing valid access attempt without a new permission grant")
    permission.permissionGranted = false
    permissionRejects("another VPN rejects an automatic retry via Android permission") {
        AccessHarness.checkStart(permission, attempt)
    }
    AccessHarness.cancelStarts(permission)
    permission.permissionGranted = true
    permissionRejects("cancelled attempt cannot restart when permission later becomes available") {
        AccessHarness.checkStart(permission, attempt)
    }
    val current = nextAttempt()
    AccessHarness.checkStart(permission, current)
    permissionRejects("old attempt cannot stop or reuse the new explicit connection") {
        AccessHarness.checkStart(permission, attempt)
    }

    val bounded = Context()
    repeat(100) { SxbSecurityMonitor.record(bounded, "VPN_OBSERVATION", config) }
    SxbSecurityMonitor.record(bounded, "VPN_REVOKED", config)
    val queue = JSONArray(SxbSecurityMonitor.pending(bounded))
    verify(queue.length() == 100 && queue.getJSONObject(99).getString("eventType") == "VPN_REVOKED", "bounded queue prioritizes permission-loss events")
    bounded.storage.failWrites = true
    SxbSecurityMonitor.record(bounded, "VPN_REVOKED", config)
    verify(android.util.Log.messages.contains("SECURITY_EVENT_STORAGE_FAILED"), "storage refusal is surfaced without throwing into service teardown")
    val failing = RevokeHarness().apply { configJson = config; cancelFails = true }
    failing.onRevoke()
    verify(failing.interrupted == 1 && failing.sshTransportSocket?.isClosed == true &&
        failing.sshSession?.closed == true && failing.nativeState == "disconnected",
        "access-attempt storage failure cannot delay stopping another-VPN takeover")
    verify(android.util.Log.messages.contains("ACCESS_START_CANCEL_FAILED"), "failed attempt cancellation is explicitly logged")
    MainQueue.drain()
    java.net.ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1")).use { listener ->
        val direct = RevokeHarness().apply {
            configJson = config
            sshTransportSocket = java.net.Socket("127.0.0.1", listener.localPort)
        }
        listener.accept().use { peer ->
            peer.soTimeout = 1000
            direct.onRevoke()
            verify(peer.getInputStream().read() == -1 && direct.nativeState == "disconnected",
                "another VPN closes a real direct TCP peer without waiting for the UI queue")
            MainQueue.drain()
        }
    }
    println("PASS $checks synthetic JVM security lifecycle contracts (not Android/device proof)")
}

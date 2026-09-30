package com.sxbvpn.vpnmodule

import android.content.Context
import android.os.MainQueue
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PublicKey
import java.security.cert.CertificateException

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

    fun publicPin(key: PublicKey): String = "sha256/" + java.util.Base64.getEncoder().encodeToString(
        MessageDigest.getInstance("SHA-256").digest(key.encoded))
    val first = ProofHarness.softwareKey.public
    val backup = KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair().public
    val untrusted = KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair().public
    val pins = SxbTlsPinPolicy.parse(JSONArray().put(publicPin(first)).put(publicPin(backup)).toString(), true)
    SxbTlsPinPolicy.check(pins, listOf(first))
    SxbTlsPinPolicy.check(pins, listOf(backup))
    verify(pins.size == 2, "current and independent backup public keys are accepted offline")
    val mismatch = try { SxbTlsPinPolicy.check(pins, listOf(untrusted)); false }
        catch (error: CertificateException) { error.message == "BACKEND_PIN_MISMATCH" }
    verify(mismatch, "another otherwise trusted certificate key is refused")
    rejects("required pin policy cannot silently become empty") { SxbTlsPinPolicy.parse("[]", true) }
    rejects("required pin policy cannot omit its backup key") {
        SxbTlsPinPolicy.parse(JSONArray().put(publicPin(first)).toString(), true)
    }
    rejects("duplicate keys are not an independent backup") {
        SxbTlsPinPolicy.parse(JSONArray().put(publicPin(first)).put(publicPin(first)).toString(), true)
    }
    rejects("malformed pin metadata is never accepted") { SxbTlsPinPolicy.parse("[\"sha256/invalid\"]", true) }
    verify(SxbTlsPinPolicy.parse("[]", false).isEmpty(), "legacy optional TLS policy retains normal platform trust")

    val config = """{"securitySessionId":"original","securityGeneration":7,"securityClientId":"client-a","connectionId":"connection-a","usageSessionId":"usage-a","accessAttempt":"attempt-a","password":"synthetic-sensitive","token":"synthetic-sensitive","host":"private.example.invalid"}"""
    val revoked = RevokeHarness().apply { configJson = config }
    revoked.onRevoke()
    verify(revoked.cancelled == 1 && revoked.interrupted == 1, "permission loss cancels workers before the main-thread queue")
    verify(revoked.gatewaySocketFactory?.closed == true && revoked.sshSession?.closed == true,
        "permission loss closes the pending gateway and SSH session synchronously")
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
    SxbVpnPermission.acknowledge(permission)
    val attempt = JSONObject()
    SxbVpnPermission.stamp(permission, attempt)
    SxbVpnPermission.checkStart(permission, attempt)
    verify(attempt.getLong("vpnPermissionGeneration") == 1L, "manual consent issues a local permission generation")
    SxbVpnPermission.checkStart(permission, attempt)
    verify(permission.getSharedPreferences("sxb_vpn_permission_v1", Context.MODE_PRIVATE)
        .getLong("vpnPermissionGeneration", 0) == 1L, "radio reconnect preserves the existing permission generation")
    permission.permissionGranted = false
    verify(SxbVpnPermission.revoke(permission, attempt), "system permission loss persists its block")
    permissionRejects("revoked permission rejects an automatic retry") { SxbVpnPermission.checkStart(permission, attempt) }
    val restored = Context().apply { preferences = permission.preferences; permissionGranted = true }
    permissionRejects("persisted revoke blocks restart even if system consent is later restored") {
        SxbVpnPermission.checkStart(restored, attempt)
    }
    permissionRejects("persisted revoke cannot be cleared by stamping another automatic start") {
        SxbVpnPermission.stamp(restored, JSONObject())
    }
    SxbVpnPermission.acknowledge(restored)
    val current = JSONObject()
    SxbVpnPermission.stamp(restored, current)
    SxbVpnPermission.checkStart(restored, current)
    permissionRejects("an old generation stays rejected after a new explicit grant") {
        SxbVpnPermission.checkStart(restored, attempt)
    }
    restored.permissionGranted = false
    verify(!SxbVpnPermission.revoke(restored, attempt), "late old revoke cannot persist a block on the new generation")
    restored.permissionGranted = true
    SxbVpnPermission.checkStart(restored, current)

    val bounded = Context()
    repeat(100) { SxbSecurityMonitor.record(bounded, "VPN_OBSERVATION", config) }
    SxbSecurityMonitor.record(bounded, "VPN_REVOKED", config)
    val queue = JSONArray(SxbSecurityMonitor.pending(bounded))
    verify(queue.length() == 100 && queue.getJSONObject(99).getString("eventType") == "VPN_REVOKED", "bounded queue prioritizes permission-loss events")
    bounded.storage.failWrites = true
    SxbSecurityMonitor.record(bounded, "VPN_REVOKED", config)
    verify(android.util.Log.messages.contains("SECURITY_EVENT_STORAGE_FAILED"), "storage refusal is surfaced without throwing into service teardown")
    val failing = Context().apply { permissionGranted = true }
    SxbVpnPermission.acknowledge(failing)
    val failingAttempt = JSONObject()
    SxbVpnPermission.stamp(failing, failingAttempt)
    failing.permissionGranted = false
    failing.getSharedPreferences("sxb_vpn_permission_v1", Context.MODE_PRIVATE).failWrites = true
    permissionRejects("permission block write failure is reported") { SxbVpnPermission.revoke(failing, failingAttempt) }
    failing.permissionGranted = true
    permissionRejects("a failed permission-block write fails closed in memory") {
        SxbVpnPermission.checkStart(failing, failingAttempt)
    }
    println("PASS $checks synthetic JVM security lifecycle contracts (not Android/device proof)")
}

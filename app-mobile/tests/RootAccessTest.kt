package com.sxbvpn.vpnmodule

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.net.URL
import java.net.URLConnection
import java.net.URLStreamHandler
import java.security.KeyPairGenerator
import java.security.Signature
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection

private var checks = 0
private fun verify(value: Boolean, label: String) {
    check(value) { label }; checks++; println("PASS $label")
}
private fun rejects(label: String, action: () -> Unit) {
    val failure = try { action(); null } catch (error: IllegalStateException) { error }
    verify(failure?.message == "ROOT_APPROVAL_REQUIRED", label)
}
private fun waitUntil(label: String, condition: () -> Boolean) {
    val deadline = System.nanoTime() + 5_000_000_000L
    while (!condition() && System.nanoTime() < deadline) Thread.sleep(10)
    check(condition()) { label }
}

object RootHttpFixture {
    @Volatile var response = ""
    @Volatile var status = 200
    @Volatile var requests = 0
    @Volatile var gate: CountDownLatch? = null
    @Volatile var entered: CountDownLatch? = null
}
private class FixtureConnection(url: URL) : HttpsURLConnection(url) {
    private val output = java.io.ByteArrayOutputStream()
    override fun connect() {}
    override fun disconnect() {}
    override fun usingProxy() = false
    override fun getCipherSuite() = "synthetic-network-adapter"
    override fun getLocalCertificates(): Array<java.security.cert.Certificate>? = null
    override fun getServerCertificates(): Array<java.security.cert.Certificate> = emptyArray()
    override fun getOutputStream() = output
    override fun getResponseCode(): Int {
        RootHttpFixture.requests++
        val body = JSONObject(output.toString("UTF-8"))
        check(body.getBoolean("rooted") && body.getString("publicKey") == SxbDeviceProof.identity().getString("publicKey"))
        RootHttpFixture.entered?.countDown()
        RootHttpFixture.gate?.await(5, TimeUnit.SECONDS)
        return RootHttpFixture.status
    }
    override fun getInputStream() = RootHttpFixture.response.byteInputStream()
}

fun main(args: Array<String>) {
    URL.setURLStreamHandlerFactory { protocol ->
        if (protocol == "https") object : URLStreamHandler() {
            override fun openConnection(url: URL): URLConnection = FixtureConnection(url)
        } else null
    }
    val signer = KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair()
    val attacker = KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair()
    val publicKey = Base64.encodeToString(signer.public.encoded, Base64.NO_WRAP)
    val context = Context(File(args.single()), publicKey)
    val keyId = SxbDeviceProof.identity().getString("keyId")
    fun receipt(status: String, revision: Int, alternate: Boolean = false, expired: Boolean = false): String {
        val pair = if (alternate) attacker else signer
        val now = System.currentTimeMillis()
        val issued = now - if (expired) SxbRootLeasePolicy.MAX_AGE_MS + 1000 else 0
        val payload = JSONObject().put("scope", SxbRootLeasePolicy.CREDENTIAL).put("version", 1)
            .put("keyId", keyId).put("status", status).put("revision", revision)
            .put("issuedAt", issued).put("expiresAt", issued + SxbRootLeasePolicy.MAX_AGE_MS).toString()
        val signature = Signature.getInstance("SHA256withECDSA").apply {
            initSign(pair.private); update(payload.toByteArray(Charsets.UTF_8))
        }.sign()
        return JSONObject().put("payload", payload).put("signature", Base64.encodeToString(signature, Base64.NO_WRAP))
            .put("publicKey", Base64.encodeToString(pair.public.encoded, Base64.NO_WRAP)).toString()
    }
    fun refresh(next: String) {
        val broadcasts = context.broadcasts.size
        RootHttpFixture.response = next
        SxbRootAccess.check(context)
        waitUntil("native cache refresh did not report its decision") { context.broadcasts.size > broadcasts }
        Thread.sleep(20)
    }
    verify(SxbRootAccess.check(context).getBoolean("allowed") && RootHttpFixture.requests == 0,
        "non-root startup needs no server request or root exception")
    SecurityModule.rooted = true
    RootHttpFixture.response = receipt("pending", 1)
    RootHttpFixture.gate = CountDownLatch(1)
    RootHttpFixture.entered = CountDownLatch(1)
    val began = System.nanoTime()
    val denied = SxbRootAccess.check(context)
    verify(!denied.getBoolean("allowed") && (System.nanoTime() - began) / 1_000_000 < 500,
        "root startup denies immediately without waiting for the request")
    check(RootHttpFixture.entered!!.await(3, TimeUnit.SECONDS))
    rejects("a pending root exception blocks a native start before network completion") { SxbRootAccess.checkStart(context) }
    RootHttpFixture.gate!!.countDown()
    RootHttpFixture.gate = null
    waitUntil("pending decision not delivered") { context.broadcasts.isNotEmpty() }
    Thread.sleep(20)
    refresh(receipt("approved", 2))
    verify(SxbRootAccess.state(context).getBoolean("allowed"), "valid signed dashboard approval is accepted")
    SxbRootAccess.checkStart(context)
    RootHttpFixture.status = 503
    val beforeFailure = RootHttpFixture.requests
    SxbRootAccess.check(context)
    waitUntil("offline failure was not observed") { RootHttpFixture.requests > beforeFailure }
    Thread.sleep(20)
    verify(SxbRootAccess.state(context).getBoolean("allowed"), "a still-valid approved root device retains its offline start")
    RootHttpFixture.status = 200
    val beforeForgery = RootHttpFixture.requests
    RootHttpFixture.response = receipt("approved", 3, alternate = true)
    SxbRootAccess.check(context)
    waitUntil("forged authority was not requested") { RootHttpFixture.requests > beforeForgery }
    Thread.sleep(20)
    verify(SxbRootAccess.state(context).getBoolean("allowed") &&
        android.util.Log.messages.contains("ROOT_ACCESS_REFRESH_UNAVAILABLE"),
        "a self-signed response cannot replace the compiled dashboard authority")
    refresh(receipt("denied", 3))
    verify(!SxbRootAccess.state(context).getBoolean("allowed") && SxbVpnService.instance!!.stops > 0,
        "dashboard denial stops the tunnel and blocks the app without deleting account data")
    val beforeStale = RootHttpFixture.requests
    RootHttpFixture.response = receipt("approved", 2)
    SxbRootAccess.check(context)
    waitUntil("stale response was not requested") { RootHttpFixture.requests > beforeStale }
    Thread.sleep(20)
    verify(!SxbRootAccess.state(context).getBoolean("allowed") && android.util.Log.messages.contains("ROOT_RESPONSE_STALE"),
        "an old valid approval cannot overwrite a newer denial")
    refresh(receipt("approved", 4))
    verify(SxbRootAccess.state(context).getBoolean("allowed"), "a newer dashboard exception can restore app access")
    KeystoreManager.failWrites = true
    refresh(receipt("denied", 5))
    verify(!SxbRootAccess.state(context).getBoolean("allowed") &&
        android.util.Log.messages.contains("ROOT_CACHE_WRITE_FAILED"),
        "failure to persist a denial cannot preserve an allowed in-memory session")
    KeystoreManager.failWrites = false
    refresh(receipt("approved", 6))
    verify(SxbRootAccess.state(context).getBoolean("allowed"), "successful authorized persistence recovers after storage failure")
    refresh(receipt("approved", 7, expired = true))
    rejects("an expired root exception refuses the native tunnel") { SxbRootAccess.checkStart(context) }
    SecurityModule.rooted = false
    verify(SxbRootAccess.state(context).getBoolean("allowed"), "non-root native startup is not dependent on a root exception")
    println("PASS $checks production root-start/cache cases with synthetic Android/network/storage adapters, not physical-device proof")
}

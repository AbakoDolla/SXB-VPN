import android.content.Context
import com.jcraft.jsch.ChannelDirectTCPIP
import com.jcraft.jsch.JSch
import com.sxbvpn.vpnmodule.SxbGatewaySocketFactory
import com.sxbvpn.vpnmodule.SxbDeviceProof
import java.io.File
import java.io.IOException
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject

fun main(args: Array<String>) {
    val peer = JSONObject(File(args[0]).readText())
    System.setProperty("sxb.test.gateway.url", "https://localhost:${peer.getInt("gatewayPort")}/api")
    var protected: Socket? = null
    val traces = mutableListOf<String>()
    val sockets = mutableListOf<Socket>()
    var handshakeEntered: CountDownLatch? = null
    fun factory(allow: Boolean, budget: Int = 4000) = SxbGatewaySocketFactory(
        Context(), "synthetic.gateway.ticket", "synthetic-device",
        "11111111-1111-4111-a111-111111111111",
        protectSocket = { socket -> check(!socket.isConnected); protected = socket; sockets.add(socket); allow },
        trace = { traces.add(it); if (it.contains("stage=SSH_GATEWAY_TLS_ATTEMPT")) handshakeEntered?.countDown() },
        configId = "synthetic-profile",
        tlsHandshakeBudgetMs = budget,
    )
    fun download(transport: SxbGatewaySocketFactory) {
        val session = JSch().getSession("sxb", "sxb-gateway", 443)
        session.setConfig("StrictHostKeyChecking", "no")
        session.setConfig("PreferredAuthentications", "password")
        session.setSocketFactory(transport)
        try {
            session.connect(15000)
            val channel = session.openChannel("direct-tcpip") as ChannelDirectTCPIP
            channel.setHost("127.0.0.1")
            channel.setPort(peer.getInt("downloadPort"))
            val received = channel.inputStream
            val sent = channel.outputStream
            try {
                channel.connect(5000)
                sent.write("GET / HTTP/1.0\r\n\r\n".toByteArray())
                sent.close()
                val bytes = received.readBytes()
                val split = bytes.toString(Charsets.ISO_8859_1).indexOf("\r\n\r\n") + 4
                check(split > 4 && bytes.copyOfRange(split, bytes.size).contentEquals(ByteArray(256 * 1024) { 0x61 })) {
                    "Gateway download received ${bytes.size} bytes with header boundary $split; expected 262144 payload bytes"
                }
            } finally { channel.disconnect() }
        } finally { session.disconnect() }
    }
    fun compatibleDownload() {
        val start = traces.size
        val protectedBefore = sockets.size
        val proofBefore = SxbDeviceProof.calls
        System.setProperty("sxb.test.gateway.url", "https://localhost:${peer.getInt("legacyTlsGatewayPort")}/api")
        val began = System.nanoTime()
        factory(true).use { download(it) }
        check((System.nanoTime() - began) / 1_000_000 < 6000)
        check(sockets.size == protectedBefore + 2 && sockets[protectedBefore].isClosed)
        check(SxbDeviceProof.calls == proofBefore + 1)
        val events = traces.drop(start)
        check(events.any { it.contains("stage=SSH_GATEWAY_TLS protocol=TLSv1.2") })
        check(events.count { it.contains("stage=SSH_GATEWAY_TLS_RETRY") } == 1)
        check(events.any { it.contains("stage=SSH_GATEWAY_READY") })
        println("PASS: TCP-only TLS 1.3 timeout recovers through verified TLS 1.2, one proof and full SSH download")
    }
    if (args.getOrNull(1) == "tls-fallback-only") {
        compatibleDownload()
        return
    }
    factory(false).use {
        try { it.createSocket("ignored.invalid", 1); error("Protection failure accepted") }
        catch (error: IOException) { check(protected?.isClosed == true && protected?.isConnected == false) }
    }
    val cancelled = factory(true)
    cancelled.close()
    try { cancelled.createSocket("ignored.invalid", 1); error("Cancelled factory connected") }
    catch (_: IOException) {}
    System.setProperty("sxb.test.gateway.url", "https://127.0.0.1:${peer.getInt("gatewayPort")}/api")
    var before = traces.size
    var proofBefore = SxbDeviceProof.calls
    factory(true).use {
        try { it.createSocket("ignored.invalid", 1); error("TLS accepted a hostname mismatch") }
        catch (_: IOException) { check(protected?.isClosed == true) }
    }
    check(traces.drop(before).none { it.contains("stage=SSH_GATEWAY_TLS_RETRY") })
    check(SxbDeviceProof.calls == proofBefore)
    System.setProperty("sxb.test.gateway.url", "https://localhost:${peer.getInt("gatewayPort")}/api")
    System.setProperty("sxb.test.reject-pin", "true")
    before = traces.size
    factory(true).use {
        try {
            it.createSocket("ignored.invalid", 1)
            error("TLS accepted a rejected backend pin")
        } catch (_: IOException) { check(protected?.isClosed == true) }
    }
    check(traces.drop(before).none { it.contains("stage=SSH_GATEWAY_TLS_RETRY") })
    check(SxbDeviceProof.calls == proofBefore)
    System.clearProperty("sxb.test.reject-pin")
    factory(true).use { download(it) }
    Socket("127.0.0.1", peer.getInt("gatewayReportPort")).use {
        val headers = it.getInputStream().readBytes().toString(Charsets.UTF_8)
        check(headers.contains("synthetic.gateway.ticket"))
        check(!headers.contains(peer.getString("password")) && !headers.contains("upstream.invalid"))
    }
    compatibleDownload()
    System.setProperty("sxb.test.gateway.url", "https://localhost:${peer.getInt("silentTlsGatewayPort")}/api")
    before = traces.size
    proofBefore = SxbDeviceProof.calls
    val protectedBefore = sockets.size
    val began = System.nanoTime()
    factory(true, 1000).use {
        try { it.createSocket("ignored.invalid", 1); error("Silent TLS endpoint accepted") }
        catch (error: IOException) { check(error.message == "SSH_RELAY_TLS_TIMEOUT") }
    }
    check((System.nanoTime() - began) / 1_000_000 < 2500)
    check(sockets.size == protectedBefore + 2 && sockets.takeLast(2).all { it.isClosed })
    check(traces.drop(before).count { it.contains("stage=SSH_GATEWAY_TLS_RETRY") } == 1)
    check(SxbDeviceProof.calls == proofBefore)
    before = traces.size
    handshakeEntered = CountDownLatch(1)
    val cancelling = factory(true)
    val error = AtomicReference<Throwable?>()
    val worker = Thread {
        try { cancelling.createSocket("ignored.invalid", 1); error.set(IllegalStateException("Cancelled TLS connected")) }
        catch (failure: Throwable) { error.set(failure) }
    }
    worker.start()
    check(handshakeEntered!!.await(3, TimeUnit.SECONDS))
    cancelling.close()
    worker.join(3000)
    check(!worker.isAlive && error.get() is IOException)
    check(traces.drop(before).none { it.contains("stage=SSH_GATEWAY_TLS_RETRY") })
    check(SxbDeviceProof.calls == proofBefore)
    handshakeEntered = null
    System.setProperty("sxb.test.gateway.url", "https://localhost:${peer.getInt("refusedGatewayPort")}/api")
    before = traces.size
    factory(true).use {
        try { it.createSocket("ignored.invalid", 1); error("HTTP refusal accepted") }
        catch (_: IOException) { check(protected?.isClosed == true) }
    }
    check(traces.drop(before).none { it.contains("stage=SSH_GATEWAY_TLS_RETRY") })
    check(SxbDeviceProof.calls == proofBefore + 1)
    check(traces.any { it.contains("stage=SSH_GATEWAY_FAILED phase=TCP") })
    check(traces.any { it.contains("stage=SSH_GATEWAY_FAILED phase=TLS") })
    check(traces.any { it.contains("stage=SSH_GATEWAY_RESPONSE status=101") })
    check(traces.any { it.contains("stage=SSH_GATEWAY_READY") })
    check(traces.none { it.contains("synthetic.gateway.ticket") || it.contains("localhost") || it.contains(peer.getString("password")) })
    println("PASS: native TLS gateway, hostname/pin rejection, bounded compatibility, cancellation, HTTP denial and full download")
}

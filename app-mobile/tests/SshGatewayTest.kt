import android.content.Context
import com.jcraft.jsch.ChannelDirectTCPIP
import com.jcraft.jsch.JSch
import com.sxbvpn.vpnmodule.SxbGatewaySocketFactory
import java.io.File
import java.io.IOException
import java.net.Socket
import org.json.JSONObject

fun main(args: Array<String>) {
    val peer = JSONObject(File(args[0]).readText())
    System.setProperty("sxb.test.gateway.url", "https://localhost:${peer.getInt("gatewayPort")}/api")
    var protected: Socket? = null
    val traces = mutableListOf<String>()
    fun factory(allow: Boolean) = SxbGatewaySocketFactory(
        Context(), "synthetic.gateway.ticket", "synthetic-device",
        "11111111-1111-4111-a111-111111111111",
        protectSocket = { socket -> check(!socket.isConnected); protected = socket; allow },
        trace = { traces.add(it) },
        configId = "synthetic-profile",
    )
    factory(false).use {
        try { it.createSocket("ignored.invalid", 1); error("Protection failure accepted") }
        catch (error: IOException) { check(protected?.isClosed == true && protected?.isConnected == false) }
    }
    val cancelled = factory(true)
    cancelled.close()
    try { cancelled.createSocket("ignored.invalid", 1); error("Cancelled factory connected") }
    catch (_: IOException) {}
    System.setProperty("sxb.test.gateway.url", "https://127.0.0.1:${peer.getInt("gatewayPort")}/api")
    factory(true).use {
        try { it.createSocket("ignored.invalid", 1); error("TLS accepted a hostname mismatch") }
        catch (_: IOException) { check(protected?.isClosed == true) }
    }
    System.setProperty("sxb.test.gateway.url", "https://localhost:${peer.getInt("gatewayPort")}/api")
    factory(true).use { transport ->
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
    Socket("127.0.0.1", peer.getInt("gatewayReportPort")).use {
        val headers = it.getInputStream().readBytes().toString(Charsets.UTF_8)
        check(headers.contains("synthetic.gateway.ticket"))
        check(!headers.contains(peer.getString("password")) && !headers.contains("upstream.invalid"))
    }
    check(traces.any { it.contains("stage=SSH_GATEWAY_FAILED phase=TCP") })
    check(traces.any { it.contains("stage=SSH_GATEWAY_FAILED phase=TLS") })
    check(traces.any { it.contains("stage=SSH_GATEWAY_RESPONSE status=101") })
    check(traces.any { it.contains("stage=SSH_GATEWAY_READY") })
    check(traces.none { it.contains("synthetic.gateway.ticket") || it.contains("localhost") || it.contains(peer.getString("password")) })
    println("PASS: native protected TLS gateway, hostname rejection, cancellation, proof request, JSch none auth and full download")
}

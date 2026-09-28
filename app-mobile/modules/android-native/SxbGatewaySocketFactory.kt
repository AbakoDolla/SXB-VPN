package com.sxbvpn.vpnmodule

import android.content.Context
import com.jcraft.jsch.SocketFactory
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLSocket

/** The only dialable relay origin is compiled into the app, never taken from a profile. */
class SxbGatewaySocketFactory(
    private val context: Context,
    private val credential: String,
    private val deviceId: String,
    private val connectionId: String,
    private val protectSocket: (Socket) -> Boolean,
) : SocketFactory, java.io.Closeable {
    private var current: Socket? = null
    private var closed = false

    @Synchronized
    private fun own(socket: Socket) {
        if (closed) { socket.close(); throw IOException("SSH_RELAY_CANCELLED") }
        current = socket
    }

    @Synchronized
    override fun close() {
        closed = true
        current?.close()
        current = null
    }

    override fun createSocket(host: String, port: Int): Socket {
        require(credential.matches(Regex("[A-Za-z0-9_.-]{1,4096}"))) { "RELAY_TICKET_INVALID" }
        require(deviceId.isNotBlank() && deviceId.length <= 256 && deviceId.all { it.code in 32..126 }) { "RELAY_DEVICE_INVALID" }
        require(connectionId.matches(Regex("[0-9a-fA-F-]{36}"))) { "RELAY_CONNECTION_INVALID" }
        val base = URI(SxbBackendTls.base(context))
        require(base.scheme == "https" && base.userInfo == null && base.rawQuery == null && base.rawFragment == null) {
            "RELAY_ORIGIN_INVALID"
        }
        val endpoint = URI(base.toString().trimEnd('/') + "/mobile/ssh-relay?connectionId=$connectionId")
        val targetPort = if (base.port < 0) 443 else base.port
        val raw = Socket()
        var owned: Socket = raw
        try {
            own(raw)
            raw.bind(null)
            check(protectSocket(raw)) { "SSH_SOCKET_PROTECT_FAILED" }
            raw.connect(InetSocketAddress(base.host, targetPort), 15000)
            val tls = SxbBackendTls.socketFactory(context).createSocket(raw, base.host, targetPort, true) as SSLSocket
            owned = tls
            own(tls)
            tls.useClientMode = true
            tls.soTimeout = 20000
            tls.tcpNoDelay = true
            tls.sslParameters = tls.sslParameters.apply {
                endpointIdentificationAlgorithm = "HTTPS"
                if (!base.host.contains(':') && !base.host.matches(Regex("[0-9.]+"))) {
                    serverNames = listOf(SNIHostName(base.host))
                }
            }
            tls.startHandshake()
            val proof = SxbDeviceProof.headers(context, "GET", endpoint.toString(), "", credential)
            val request = buildString {
                append("GET ${endpoint.rawPath}?${endpoint.rawQuery} HTTP/1.1\r\nHost: ${base.rawAuthority}\r\n")
                append("Connection: Upgrade\r\nUpgrade: sxb-ssh-relay\r\n")
                append("Authorization: Bearer $credential\r\nX-SXB-Device-ID: $deviceId\r\n")
                for (key in proof.keys()) append("$key: ${proof.getString(key)}\r\n")
                append("\r\n")
            }
            tls.outputStream.write(request.toByteArray(Charsets.US_ASCII))
            tls.outputStream.flush()
            val deadline = System.nanoTime() + 20_000_000_000L
            val response = StringBuilder()
            while (!response.endsWith("\r\n\r\n")) {
                val remaining = (deadline - System.nanoTime()) / 1_000_000L
                check(remaining > 0 && response.length < 8192) { "RELAY_RESPONSE_INVALID" }
                tls.soTimeout = remaining.coerceAtMost(20000).toInt().coerceAtLeast(1)
                val next = tls.inputStream.read()
                check(next >= 0) { "RELAY_RESPONSE_TRUNCATED" }
                response.append(next.toChar())
            }
            check(response.startsWith("HTTP/1.1 101 ") &&
                Regex("(?im)^Connection:\\s*Upgrade\\s*$").containsMatchIn(response) &&
                Regex("(?im)^Upgrade:\\s*sxb-ssh-relay\\s*$").containsMatchIn(response)) { "RELAY_ACCESS_REFUSED" }
            tls.soTimeout = 20000
            return tls
        } catch (error: Exception) {
            runCatching { owned.close() }
            runCatching { raw.close() }
            throw IOException("SSH_RELAY_CONNECTION_FAILED", error)
        }
    }

    override fun getInputStream(socket: Socket): InputStream = socket.getInputStream()
    override fun getOutputStream(socket: Socket): OutputStream = socket.getOutputStream()
}

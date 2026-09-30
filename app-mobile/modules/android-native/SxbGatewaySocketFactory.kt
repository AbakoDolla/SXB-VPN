package com.sxbvpn.vpnmodule

import android.content.Context
import com.jcraft.jsch.SocketFactory
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URI
import java.net.URLEncoder
import java.util.Timer
import java.util.TimerTask
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.SSLSocket

/** The only dialable relay origin is compiled into the app, never taken from a profile. */
class SxbGatewaySocketFactory(
    private val context: Context,
    private val credential: String,
    private val deviceId: String,
    private val connectionId: String,
    private val protectSocket: (Socket) -> Boolean,
    private val trace: (String) -> Unit = {},
    private val configId: String? = null,
    private val tlsHandshakeBudgetMs: Int = 20000,
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

    @Synchronized
    private fun isOpen(): Boolean = !closed

    private fun remainingMillis(deadline: Long): Int {
        val remaining = (deadline - System.nanoTime()) / 1_000_000L
        if (remaining <= 0) throw SocketTimeoutException("SSH_RELAY_TLS_TIMEOUT")
        return remaining.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
    }

    private fun handshake(socket: SSLSocket, timeoutMs: Int) {
        val pending = AtomicBoolean(true)
        val expired = AtomicBoolean(false)
        val timer = Timer("SXB-Gateway-TLS", true)
        timer.schedule(object : TimerTask() {
            override fun run() {
                if (pending.compareAndSet(true, false)) {
                    expired.set(true)
                    runCatching { socket.close() }
                }
            }
        }, timeoutMs.toLong())
        try {
            socket.soTimeout = timeoutMs
            socket.startHandshake()
            if (!pending.compareAndSet(true, false)) throw SocketTimeoutException("SSH_RELAY_TLS_TIMEOUT")
        } catch (error: Exception) {
            if (expired.get() && error !is SSLHandshakeException && error !is SSLPeerUnverifiedException) {
                throw SocketTimeoutException("SSH_RELAY_TLS_TIMEOUT").apply { initCause(error) }
            }
            throw error
        } finally {
            pending.set(false)
            timer.cancel()
        }
    }

    override fun createSocket(host: String, port: Int): Socket {
        require(credential.matches(Regex("[A-Za-z0-9_.-]{1,4096}"))) { "RELAY_TICKET_INVALID" }
        require(deviceId.isNotBlank() && deviceId.length <= 256 && deviceId.all { it.code in 32..126 }) { "RELAY_DEVICE_INVALID" }
        require(connectionId.matches(Regex("[0-9a-fA-F-]{36}"))) { "RELAY_CONNECTION_INVALID" }
        require(tlsHandshakeBudgetMs in 100..20000) { "RELAY_TLS_BUDGET_INVALID" }
        val base = URI(SxbBackendTls.base(context))
        require(base.scheme == "https" && base.userInfo == null && base.rawQuery == null && base.rawFragment == null) {
            "RELAY_ORIGIN_INVALID"
        }
        val attribution = configId?.let {
            require(it.isNotBlank() && it.length <= 200 && it.none { character -> character.code <= 32 || character.code == 127 }) {
                "RELAY_CONFIG_ID_INVALID"
            }
            "&configId=${URLEncoder.encode(it, "UTF-8")}"
        } ?: ""
        val endpoint = URI(base.toString().trimEnd('/') + "/mobile/ssh-relay?connectionId=$connectionId$attribution")
        val targetPort = if (base.port < 0) 443 else base.port
        var raw: Socket? = null
        var owned: Socket? = null
        var phase = "TCP"
        try {
            trace("[SXB_TRACE] stage=SSH_GATEWAY_START timeout_ms=15000")
            var tlsDeadline = 0L
            var compatibility = false
            var negotiated: SSLSocket? = null
            while (negotiated == null) {
                phase = "TCP"
                val candidate = Socket()
                raw = candidate
                owned = candidate
                own(candidate)
                candidate.bind(null)
                check(protectSocket(candidate)) { "SSH_SOCKET_PROTECT_FAILED" }
                val connectTimeout = if (tlsDeadline == 0L) 15000 else minOf(15000, remainingMillis(tlsDeadline))
                candidate.connect(InetSocketAddress(base.host, targetPort), connectTimeout)
                trace("[SXB_TRACE] stage=SSH_GATEWAY_TCP")
                if (tlsDeadline == 0L) tlsDeadline = System.nanoTime() + tlsHandshakeBudgetMs * 1_000_000L
                phase = "TLS"
                val tls = SxbBackendTls.socketFactory(context)
                    .createSocket(candidate, base.host, targetPort, true) as SSLSocket
                owned = tls
                own(tls)
                tls.useClientMode = true
                tls.tcpNoDelay = true
                val modern = listOf("TLSv1.3", "TLSv1.2").filter { it in tls.supportedProtocols }
                check(modern.isNotEmpty()) { "RELAY_TLS_VERSION_UNSUPPORTED" }
                val mayRetry = !compatibility && modern.containsAll(listOf("TLSv1.3", "TLSv1.2"))
                tls.enabledProtocols = if (compatibility) arrayOf("TLSv1.2") else modern.toTypedArray()
                tls.sslParameters = tls.sslParameters.apply {
                    endpointIdentificationAlgorithm = "HTTPS"
                    if (!base.host.contains(':') && !base.host.matches(Regex("[0-9.]+"))) {
                        serverNames = listOf(SNIHostName(base.host))
                    }
                }
                val timeout = minOf(remainingMillis(tlsDeadline),
                    if (mayRetry) tlsHandshakeBudgetMs / 2 else tlsHandshakeBudgetMs)
                trace("[SXB_TRACE] stage=SSH_GATEWAY_TLS_ATTEMPT mode=${if (compatibility) "TLS12" else "AUTO"} timeout_ms=$timeout")
                try {
                    handshake(tls, timeout)
                    negotiated = tls
                } catch (error: SocketTimeoutException) {
                    if (!mayRetry || !isOpen() || System.nanoTime() >= tlsDeadline) throw error
                    runCatching { tls.close() }
                    runCatching { candidate.close() }
                    compatibility = true
                    trace("[SXB_TRACE] stage=SSH_GATEWAY_TLS_RETRY protocol=TLSv1.2")
                }
            }
            val tls = negotiated
            check(isOpen()) { "SSH_RELAY_CANCELLED" }
            trace("[SXB_TRACE] stage=SSH_GATEWAY_TLS protocol=${tls.session.protocol}")
            phase = "PROOF"
            val proof = SxbDeviceProof.headers(context, "GET", endpoint.toString(), "", credential)
            phase = "HTTP"
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
            val status = Regex("^HTTP/1\\.[01] ([0-9]{3}) ").find(response)?.groupValues?.get(1)
            if (status != null) trace("[SXB_TRACE] stage=SSH_GATEWAY_RESPONSE status=$status")
            check(response.startsWith("HTTP/1.1 101 ") &&
                Regex("(?im)^Connection:\\s*Upgrade\\s*$").containsMatchIn(response) &&
                Regex("(?im)^Upgrade:\\s*sxb-ssh-relay\\s*$").containsMatchIn(response)) { "RELAY_ACCESS_REFUSED" }
            tls.soTimeout = 20000
            trace("[SXB_TRACE] stage=SSH_GATEWAY_READY")
            return tls
        } catch (error: Exception) {
            trace("[SXB_TRACE] stage=SSH_GATEWAY_FAILED phase=$phase error_type=${error.javaClass.simpleName}")
            runCatching { owned?.close() }
            runCatching { raw?.close() }
            val code = if (phase == "TLS" && error is SocketTimeoutException) "SSH_RELAY_TLS_TIMEOUT"
                else "SSH_RELAY_CONNECTION_FAILED"
            throw IOException(code, error)
        }
    }

    override fun getInputStream(socket: Socket): InputStream = socket.getInputStream()
    override fun getOutputStream(socket: Socket): OutputStream = socket.getOutputStream()
}

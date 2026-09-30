// Appended to the exact production transport declarations by the JVM runner.
private fun readHeaders(input: InputStream): String {
    val value = StringBuilder()
    while (!value.endsWith("\r\n\r\n")) {
        val byte = input.read()
        check(byte >= 0 && value.length < 8192)
        value.append(byte.toChar())
    }
    return value.toString()
}

private fun payloadScenario(
    response: String,
    http: Boolean,
    tls: Boolean,
    serverName: String = "localhost",
    expectFailure: Boolean = false,
    payload: String = "CONNECT [host_port] [protocol][crlf][crlf]",
    expectedTunnel: String = "SSH-2.0-Synthetic\r\n",
    waitForClient: Boolean = false,
    responseDelayMs: Long = 0,
) {
    val expectedRequest = expandSshPayloadTokens(payload, "ssh.example.test", 22, "synthetic-agent", serverName)
    val server = if (tls) {
        val store = KeyStore.getInstance("PKCS12")
        FileInputStream(System.getProperty("sxb.test.store")).use { store.load(it, "synthetic-test-only".toCharArray()) }
        val manager = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
        manager.init(store, "synthetic-test-only".toCharArray())
        val context = SSLContext.getInstance("TLS")
        context.init(manager.keyManagers, null, SecureRandom())
        context.serverSocketFactory.createServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
    } else ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
    val failure = java.util.concurrent.atomic.AtomicReference<Throwable?>()
    val received = java.util.concurrent.atomic.AtomicReference<String?>()
    val worker = Thread {
        try {
            server.accept().use { socket ->
                socket.soTimeout = 5000
                val request = ByteArray(expectedRequest.toByteArray(Charsets.ISO_8859_1).size)
                DataInputStream(socket.getInputStream()).readFully(request)
                received.set(String(request, Charsets.ISO_8859_1))
                if (responseDelayMs > 0) Thread.sleep(responseDelayMs)
                socket.getOutputStream().write(response.toByteArray(Charsets.ISO_8859_1))
                socket.getOutputStream().flush()
                if (waitForClient) {
                    val clientBanner = StringBuilder()
                    while (!clientBanner.endsWith("\n")) clientBanner.append(socket.getInputStream().read().also { check(it >= 0) }.toChar())
                    check(clientBanner.toString() == "SSH-2.0-Client\r\n")
                    socket.getOutputStream().write(expectedTunnel.toByteArray(Charsets.ISO_8859_1))
                }
            }
        } catch (error: Exception) { failure.set(error) }
    }
    worker.start()
    var protected = 0
    var physicalSocket: Socket? = null
    val events = mutableListOf<String>()
    val proxy = SxbPayloadProxy(
        payload, tls, serverName,
        "127.0.0.1", server.localPort, "ssh.example.test", 22, "synthetic-agent", false,
        { socket -> check(!socket.isConnected); physicalSocket = socket; protected++; true },
        expectHttpResponse = http, onEvent = { events.add(it) },
    )
    try {
        var rejected = false
        try {
            proxy.connect(null, "ignored", 22, 3000)
            if (waitForClient) {
                proxy.outputStream.write("SSH-2.0-Client\r\n".toByteArray())
                proxy.outputStream.flush()
            }
            val receivedTunnel = proxy.inputStream.readBytes()
            if (!expectFailure) check(receivedTunnel.contentEquals(expectedTunnel.toByteArray(Charsets.ISO_8859_1))) {
                "The transport changed the SSH byte stream"
            }
        } catch (error: IOException) {
            if (!expectFailure) throw error
            check(physicalSocket?.isClosed == true) { "Failed transport leaked its physical socket" }
            rejected = true
        }
        check(rejected == expectFailure)
        check(protected == 1)
    } finally {
        proxy.close()
        server.close()
        worker.join(6000)
        check(!worker.isAlive)
    }
    if (!expectFailure) {
        failure.get()?.let { throw AssertionError("Loopback peer failed", it) }
        check(received.get() == expectedRequest)
    }
    if (tls && expectFailure) check(received.get() == null) { "Payload escaped before TLS identity verification" }
    check(events.none { it.contains("ssh.example.test") || it.contains("X-Synthetic-Secret") || it.contains("private-marker") })
}

private const val chainPayload = "GET / HTTP/1.1[crlf]Host: public.example.test[crlf][crlf]" +
    "CONNECT [host_port] HTTP/1.1[crlf][crlf]"

private fun chainFramingScenarios() {
    val banner = "SSH-2.0-Synthetic\r\n\u0000\u0081"
    fun checkChain(prefix: String, error: String? = null, requestCount: Int = 1) {
        Socket().use { socket ->
            val input = java.io.PushbackInputStream(ByteArrayInputStream((prefix + banner).toByteArray(Charsets.ISO_8859_1)), 1)
            try {
                check(readSshPayloadChain(input, socket, 1000, {}, requestCount = requestCount).isEmpty())
                check(error == null) { "Expected $error" }
                check(input.readBytes().contentEquals(banner.toByteArray(Charsets.ISO_8859_1)))
            } catch (failure: IOException) {
                check(error != null && failure.message == error) { "Unexpected chain error: ${failure.message}, expected $error" }
            }
        }
    }
    val ok = "HTTP/1.1 200 OK\r\n\r\n"
    val forbidden = "HTTP/1.1 403 Forbidden\r\nContent-Length: 4\r\n\r\nbody"
    checkChain(ok + forbidden + ok, requestCount = 3)
    checkChain("HTTP/1.1 100 Continue\r\n\r\n" + ok + forbidden + ok, requestCount = 3)
    checkChain(forbidden, "TUNNEL_REFUSED HTTP 403", 3)
    checkChain(ok + forbidden + ok, "TUNNEL_REFUSED HTTP 403", 2)
    checkChain(ok + ok + forbidden + ok, "TUNNEL_REFUSED HTTP 403", 3)
    checkChain("HTTP/1.1 403 Forbidden\r\n\r\n" + ok, "TUNNEL_REFUSED HTTP 403", 3)
    checkChain("HTTP/1.0 403 Forbidden\r\nContent-Length: 0\r\n\r\n" + ok, "TUNNEL_REFUSED HTTP 403", 3)
    checkChain("HTTP/1.1 403 Forbidden\r\nConnection: keep-alive, close\r\nContent-Length: 0\r\n\r\n" + ok,
        "TUNNEL_REFUSED HTTP 403", 3)
    checkChain("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\n\r\n" + ok,
        "HTTP_CHAIN_FRAMING_INVALID", 3)
    val fabricatedTunnel = ok + banner
    checkChain("HTTP/1.1 403 Forbidden\r\nContent-Length: ${fabricatedTunnel.length}\r\n\r\n$fabricatedTunnel",
        "TUNNEL_REFUSED HTTP 403", 3)
    checkChain("HTTP/1.1 403 Forbidden\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nbody\r\n0\r\n\r\n" + ok,
        requestCount = 2)
    Socket().use { socket ->
        val input = java.io.PushbackInputStream(ByteArrayInputStream(forbidden.toByteArray()), 1)
        check(runCatching { readSshPayloadChain(input, socket, 1000, {}, requestCount = 3) }
            .exceptionOrNull()?.message == "TUNNEL_REFUSED HTTP 403")
    }
    checkChain("HTTP/1.1 301 Redirect\r\nContent-Length: 4\r\n\r\nbody" + ok)
    checkChain("HTTP/1.1 302 Redirect\r\nTransfer-Encoding: chunked\r\n\r\n4;ext=yes\r\nbody\r\n0\r\nTrailer: ok\r\n\r\n" + ok)
    checkChain(ok.repeat(16))
    checkChain(ok.repeat(17), "HTTP_CHAIN_TOO_MANY_RESPONSES")
    checkChain("HTTP/1.1 302 Redirect\r\n\r\n", "TUNNEL_REFUSED")
    checkChain("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\n\r\n", "HTTP_CHAIN_FRAMING_INVALID")
    checkChain("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n", "HTTP_CHAIN_FRAMING_INVALID")
    checkChain("HTTP/1.1 200 OK\r\nContent-Length: +1\r\n\r\n", "HTTP_CHAIN_FRAMING_INVALID")
    checkChain("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n-1\r\n", "HTTP_CHAIN_FRAMING_INVALID")
    checkChain("HTTP/1.1 200 OK\r\nContent-Length: 65537\r\n\r\n", "HTTP_CHAIN_BODY_TOO_LARGE")
    checkChain("HTTP/1.1 200 OK\r\nContent-Length: 300\r\n\r\nshort", "HTTP_CHAIN_TRUNCATED")
    checkChain("HTTP/1.1 302 Redirect\r\nLocation: https://captive.example.test/\r\n\r\n", "CAPTIVE_PORTAL")
    val portal = "<html>captive portal</html>"
    checkChain("HTTP/1.1 200 OK\r\nContent-Length: ${portal.length}\r\n\r\n$portal", "CAPTIVE_PORTAL")
    checkChain("HTTP/1.1 200 OK\r\nX: ${"x".repeat(8192)}\r\n\r\n", "HTTP_CHAIN_HEADER_TOO_LARGE")
    checkChain("garbage", "TUNNEL_REFUSED")
    for (code in listOf(301, 400, 403, 404)) {
        payloadScenario("HTTP/1.1 $code Rejected\r\nX-Synthetic-Secret: private-marker\r\n\r\n", true, false,
            expectFailure = true, payload = chainPayload)
    }
    payloadScenario("HTTP/1.1 301 Redirect\r\n\r\n", true, false, expectFailure = true)
    payloadScenario(ok + ok, true, false, payload = chainPayload, waitForClient = true)
    // An empty HTTP read used to discard the first byte arriving during the later peek.
    payloadScenario("SSH-2.0-Synthetic\r\n", true, false, responseDelayMs = 10_100)
    val websocketPayload = "GET / HTTP/1.1[crlf]Host: public.example.test[crlf][crlf]" +
        "GET /ssh HTTP/1.1[crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf]" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==[crlf]Sec-WebSocket-Version: 13[crlf][crlf]"
    val ssh = "SSH-2.0-Synthetic\r\n"
    payloadScenario(ok + "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n" +
        "\u0082${ssh.length.toChar()}$ssh", true, false, payload = websocketPayload)
    println("PASS: HTTP framing, rejection, portal/size/count bounds, client-first, delayed banner and chained WebSocket")
}

private fun protectFailureScenarios() {
    for (mode in listOf("direct", "tls", "payload")) {
        var physicalSocket: Socket? = null
        val protect: (Socket) -> Boolean = { physicalSocket = it; false }
        try {
            when (mode) {
                "direct" -> SxbLoggingSocketFactory(1000, "127.0.0.1", 1, protect) {}.createSocket("ignored", 1)
                "tls" -> SxbTlsSocketFactory(1000, "localhost", "127.0.0.1", 1, false, protect) {}.createSocket("ignored", 1)
                else -> SxbPayloadProxy(chainPayload, false, "", "127.0.0.1", 1, "ssh.example.test", 22, "", false, protect, onEvent = {})
                    .connect(null, "ignored", 1, 1000)
            }
            error("Unprotected $mode socket was accepted")
        } catch (failure: IOException) {
            check(failure.message == "SSH_SOCKET_PROTECT_FAILED")
            check(physicalSocket?.isClosed == true && physicalSocket?.isConnected == false)
        }
    }
    println("PASS: protection failure closes direct, TLS and payload sockets before dialing")
}

fun main(args: Array<String>) {
    val journal = LogHarness()
    repeat(40) { journal.log("[JSch:INF] evenement SSH") }
    journal.log("[SXB_TRACE] stage=SOCKET_CREATED timeout_ms=30000 tls=false")
    journal.log("[SXB_TRACE] stage=SOCKET_PROTECT result=false fd_ready=true")
    journal.log("[SXB_TRACE] seq=8 elapsed_ms=1200 stage=VPN_FAILED code=SSH_SOCKET_PROTECT_FAILED")
    check(journal.sent.any { it.contains("stage=SOCKET_PROTECT") } &&
        journal.sent.any { it.contains("stage=VPN_FAILED") }) { "Startup log burst swallowed transport steps and final failure" }
    check(journal.classify("SSH_SOCKET_PROTECT_FAILED") == "SSH_SOCKET_PROTECT_FAILED")
    check(journal.classify("Session.connect: SSH_SOCKET_PROTECT_FAILED") == "SSH_SOCKET_PROTECT_FAILED")
    check(journal.classify(IOException("Transport failed", IOException("SSH_SOCKET_PROTECT_FAILED"))) == "SSH_SOCKET_PROTECT_FAILED")
    check(journal.classify(IOException("Connection failed", java.net.UnknownHostException("synthetic.example"))) == "SERVER_UNREACHABLE")
    check(journal.classify("reject HostKey: synthetic.example") == "SSH_HOST_KEY_FAILED")
    check(journal.classify("Algorithm negotiation fail") == "SSH_ALGORITHM_FAILED")
    check(journal.classify("connection is closed by foreign host") == "SSH_PEER_CLOSED")
    check(journal.classify("Auth fail") == "AUTH_FAILED")
    check(journal.classify("Read timed out") == "TCP_TIMEOUT")
    check(journal.classify(IOException("SSH_RELAY_TLS_TIMEOUT", java.net.SocketTimeoutException("Read timed out"))) == "TLS_TIMEOUT")
    check(journal.classify("SSLHandshakeException: certificate rejected") == "TLS_FAILED")
    check(journal.classify("HTTP_BAD_REQUEST") == "HTTP_BAD_REQUEST")
    check(journal.classify("something unknown") == "VPN_FAILED")
    val beforeDuplicates = journal.sent.size
    repeat(1000) { journal.log("[SXB_TRACE] stage=SOCKET_PROTECT result=false fd_ready=true") }
    check(journal.sent.size == beforeDuplicates) { "Duplicate stages bypassed the log limit" }
    for (n in 1..1000) journal.log("[SXB_TRACE] stage=HTTP_CHAIN_RESPONSE n=$n status=200")
    check(journal.sent.size == beforeDuplicates + 16) { "HTTP response priority must be bounded at 16" }
    val policy = SxbConnectionTracePolicy()
    for (mode in listOf("raw", "tls_raw", "tls_ws", "ws")) {
        check(policy.admit("[SXB_TRACE] seq=1 elapsed_ms=10 stage=SSH_HANDSHAKE_START transport=$mode timeout_ms=30000"))
        check(!policy.admit("[SXB_TRACE] stage=SSH_HANDSHAKE_START transport=$mode timeout_ms=30000"))
    }
    check(!policy.admit("[SXB_TRACE] stage=ENDPOINT_RESOLVED remote=synthetic.example"))
    check(!policy.admit("[SXB_TRACE] stage=SSH_HANDSHAKE_START transport=synthetic.example"))
    check(policy.admit("[SXB_TRACE] seq=2 elapsed_ms=20 stage=SSH_HANDSHAKE_START payload=false tls=true timeout_ms=30000"))
    policy.reset()
    check(policy.admit("[SXB_TRACE] stage=SSH_HANDSHAKE_START transport=raw timeout_ms=30000"))
    println("PASS: startup burst retains connection diagnostics and precise socket-protection failure")
    System.setProperty("sxb.test.store", args[0])
    val regressions = linkedMapOf<String, () -> Unit>(
        "SSH banner preserves the first key-exchange byte" to {
            val bytes = "SSH-2.0-Synthetic\r\n\u0000\u0000\u0082\u00ffbinary"
            payloadScenario(bytes, true, false, expectedTunnel = bytes)
        },
        "Pipelined HTTP responses reach the SSH stream" to {
            payloadScenario(
                "HTTP/1.1 301 Moved Permanently\r\nContent-Length: 0\r\n\r\n" +
                    "HTTP/1.1 200 OK\r\n\r\nHTTP/1.1 101 Switching Protocols\r\n\r\n" +
                    "HTTP/1.1 200 OK\r\n\r\nSSH-2.0-Synthetic\r\n",
                true, false,
                payload = "GET / HTTP/1.1[crlf]Host: public.example.test[crlf][crlf]" +
                    "X / HTTP/1.1[crlf]Host: [host][crlf][crlf]" +
                    "GET / HTTP/1.1[crlf]Host: gateway.example.test[crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf][crlf]",
            )
        },
        "An intermediate method refusal does not discard the later accepted tunnel" to {
            val rejectionBody = "<html>Method not allowed</html>"
            payloadScenario(
                "HTTP/1.1 301 Moved\r\nContent-Length: 0\r\n\r\n" +
                    "HTTP/1.1 403 Forbidden\r\nContent-Length: ${rejectionBody.length}\r\n\r\n$rejectionBody" +
                    "HTTP/1.1 101 Switching Protocols\r\n\r\n" +
                    "HTTP/1.1 200 OK\r\n\r\nSSH-2.0-Synthetic\r\n",
                true, false,
                payload = "GET / HTTP/1.1[crlf]Host: public.example.test[crlf][crlf]" +
                    "X / HTTP/1.1[crlf]Host: [host][crlf][crlf]" +
                    "GET / HTTP/1.1[crlf]Host: gateway.example.test[crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf][crlf]",
            )
        },
    )
    val failed = mutableListOf<String>()
    for ((name, run) in regressions) {
        try { run(); println("PASS: $name") }
        catch (error: Exception) { failed.add(name); System.err.println("FAIL: $name: ${error.message}") }
    }
    check(failed.isEmpty()) { "SSH transport regressions: ${failed.joinToString()}" }
    chainFramingScenarios()
    protectFailureScenarios()
    payloadScenario("SSH-2.0-Synthetic\r\n", false, false)
    payloadScenario("HTTP/1.1 200 Connection established\r\n\r\nSSH-2.0-Synthetic\r\n", true, false)
    payloadScenario("HTTP/1.1 403 Forbidden\r\n\r\n", true, false, expectFailure = true)
    payloadScenario("HTTP/1.1 200 Connection established\r\n\r\nSSH-2.0-Synthetic\r\n", true, true)
    payloadScenario("SSH-2.0-Synthetic\r\n", true, true, "wrong.example.test", true)
    val output = ByteArrayOutputStream()
    val started = System.nanoTime()
    check(sendSshPayload("a[split]b[delay_split]c", output) {} == 3)
    check(output.toString("ISO-8859-1") == "abc")
    check((System.nanoTime() - started) / 1_000_000 >= 900)
    val http = expandSshPayloadTokens(
        "[method] [ssh] [protocol][crlf]Host: [host_header][cr][lf]X-SNI: [sni][crlf]User-Agent: [ua][crlf][crlf]",
        "ssh.example.test", 2222, "Synthetic-SXB/1", "tls.example.test",
    )
    check(http == "CONNECT ssh.example.test:2222 HTTP/1.0\r\nHost: ssh.example.test\r\n" +
        "X-SNI: tls.example.test\r\nUser-Agent: Synthetic-SXB/1\r\n\r\n")
    val pair = com.jcraft.jsch.KeyPair.genKeyPair(JSch(), com.jcraft.jsch.KeyPair.RSA, 2048)
    try {
        for (passphrase in listOf("", "synthetic-key-passphrase")) {
            val encoded = ByteArrayOutputStream()
            pair.writePrivateKey(encoded, passphrase.takeIf { it.isNotEmpty() }?.toByteArray(Charsets.UTF_8))
            val cfg = JSONObject().put("privateKeyBase64", Base64.getEncoder().encodeToString(encoded.toByteArray()))
                .put("privateKeyPassphrase", passphrase)
            val identities = importedIdentity(cfg).identityRepository.identities
            check(identities.size == 1 && !identities[0].isEncrypted)
        }
    } finally { pair.dispose() }
    sshDataScenarios(JSONObject(File(args[1]).readText()))
    println("SSH production JVM: Dropbear/no HTTP wait, CONNECT, HTTP rejection, verified TLS ordering/identity, split timing and memory key import passed")
}

private fun sshDataScenarios(peer: JSONObject) {
    for (mode in listOf("direct", "payloadPort", "delayedPayloadPort", "methodRefusalPayloadPort", "slowAuth")) {
        val payloadMode = mode != "direct"
        val jsch = JSch()
        jsch.setKnownHosts(ByteArrayInputStream("fixture-key ssh-rsa ${peer.getString("hostKey")}\n".toByteArray()))
        val session = jsch.getSession(if (mode == "slowAuth") "fixture-slow" else peer.getString("username"),
            "127.0.0.1", peer.getInt("sshPort"))
        session.setHostKeyAlias("fixture-key")
        session.setConfig("StrictHostKeyChecking", "yes")
        session.setConfig("PreferredAuthentications", "password")
        session.setPassword(peer.getString("password"))
        if (payloadMode) session.setProxy(SxbPayloadProxy(
            "GET / HTTP/1.1[crlf]Host: public.example.test[crlf][crlf]" +
                "X / HTTP/1.1[crlf]Host: [host][crlf][crlf]" +
                "GET / HTTP/1.1[crlf]Host: gateway.example.test[crlf][crlf]",
            false, "", "127.0.0.1", peer.getInt(if (mode == "slowAuth") "delayedPayloadPort" else mode), "ssh.example.test", 22,
            "fixture-agent", false, { true }, onEvent = {},
        ))
        val started = System.nanoTime()
        connectCandidate(session, if (mode == "slowAuth") 20000 else 10000)
        if (mode == "slowAuth") check((System.nanoTime() - started) / 1_000_000 >= 13000)
        val harness = SocksHarness()
        val server = harness.start(session)
        fun request(port: Int, action: (Socket, InputStream, Int) -> Unit) {
            Socket("127.0.0.1", server.localPort).use { client ->
                client.soTimeout = 10000
                val out = client.outputStream
                val input = DataInputStream(client.inputStream)
                out.write(byteArrayOf(5, 1, 0)); out.flush()
                check(input.readUnsignedByte() == 5 && input.readUnsignedByte() == 0)
                out.write(byteArrayOf(5, 1, 0, 1, 127, 0, 0, 1, (port ushr 8).toByte(), port.toByte()))
                out.flush()
                val reply = ByteArray(10); input.readFully(reply)
                action(client, input, reply[1].toInt())
            }
        }
        val failures = mutableListOf<String>()
        try {
            try {
                request(1) { _, _, code -> check(code != 0) { "SOCKS must not claim an SSH channel was opened when it was refused" } }
            } catch (error: Exception) { failures.add("rejection: ${error.message}") }
            try {
                request(peer.getInt("greetingPort")) { _, input, code ->
                    check(code == 0)
                    check(input.readBytes().contentEquals(byteArrayOf(0, 1, 2, 0x80.toByte(), 0xff.toByte()))) {
                        "Lost immediate downstream bytes"
                    }
                }
            } catch (error: Exception) { failures.add("greeting: ${error.message}") }
            try {
                request(peer.getInt("downloadPort")) { client, input, code ->
                    check(code == 0)
                    client.outputStream.write("GET / HTTP/1.1\r\nHost: fixture\r\n\r\n".toByteArray())
                    client.outputStream.flush()
                    client.shutdownOutput()
                    val received = input.readBytes()
                    val prefix = "HTTP/1.1 200 OK\r\nContent-Length: 262144\r\n\r\n".toByteArray()
                    check(received.size == prefix.size + 262144 && received.take(prefix.size).toByteArray().contentEquals(prefix)) {
                        "SSH download truncated after client half-close: ${received.size}"
                    }
                    check(received.drop(prefix.size).all { it == 0x61.toByte() })
                    check(harness.uploadBytes.get() > 0 && harness.downloadBytes.get() >= received.size)
                }
            } catch (error: Exception) { failures.add("download: ${error.message}") }
            try {
                var before = 0
                request(peer.getInt("uploadReportPort")) { _, input, code ->
                    check(code == 0); before = String(input.readBytes()).toInt()
                }
                request(peer.getInt("uploadPort")) { client, input, code ->
                    check(code == 0 && String(input.readBytes()) == "ready")
                    client.outputStream.write(ByteArray(262144) { 0x62.toByte() })
                    client.outputStream.flush()
                    client.shutdownOutput()
                    var received = 0
                    val deadline = System.nanoTime() + 5_000_000_000L
                    while (received < before + 262144 && System.nanoTime() < deadline) {
                        request(peer.getInt("uploadReportPort")) { _, report, status ->
                            check(status == 0); received = String(report.readBytes()).toInt()
                        }
                        if (received < before + 262144) Thread.sleep(10)
                    }
                    check(received == before + 262144) { "Remote half-close truncated upload: ${received - before}" }
                }
            } catch (error: Exception) { failures.add("upload: ${error.message}") }
            try {
                request(peer.getInt("downloadPort")) { client, input, code ->
                    check(code == 0)
                    session.disconnect()
                    client.soTimeout = 3000
                    val closed = try { input.read() == -1 } catch (_: SocketException) { true }
                    check(closed) { "Disconnect did not release an idle SOCKS client" }
                }
            } catch (error: Exception) { failures.add("shutdown: ${error.message}") }
        } finally {
            harness.running.set(false)
            server.close()
            session.disconnect()
        }
        check(failures.isEmpty()) { "SSH data path ($mode): ${failures.joinToString("; ")}" }
        println("PASS: real SSH/SOCKS $mode rejection, immediate data, 256 KiB upload/download, both half-closes and disconnect")
    }
}

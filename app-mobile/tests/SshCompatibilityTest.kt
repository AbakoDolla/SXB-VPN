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

private fun payloadScenario(response: String, http: Boolean, tls: Boolean, serverName: String = "localhost", expectFailure: Boolean = false) {
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
                received.set(readHeaders(socket.getInputStream()))
                socket.getOutputStream().write(response.toByteArray(Charsets.ISO_8859_1))
                socket.getOutputStream().flush()
            }
        } catch (error: Exception) { failure.set(error) }
    }
    worker.start()
    var protected = 0
    val proxy = SxbPayloadProxy(
        "CONNECT [host_port] [protocol][crlf][crlf]", tls, serverName,
        "127.0.0.1", server.localPort, "ssh.example.test", 22, "synthetic-agent", false,
        { socket -> check(!socket.isConnected); protected++; true },
        expectHttpResponse = http, onEvent = {},
    )
    try {
        var rejected = false
        try {
            proxy.connect(null, "ignored", 22, 3000)
            if (!expectFailure) check(proxy.inputStream.bufferedReader().readLine() == "SSH-2.0-Synthetic")
        } catch (error: IOException) {
            if (!expectFailure) throw error
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
        check(received.get() == "CONNECT ssh.example.test:22 HTTP/1.0\r\n\r\n")
    }
    if (tls && expectFailure) check(received.get() == null) { "Payload escaped before TLS identity verification" }
}

fun main(args: Array<String>) {
    System.setProperty("sxb.test.store", args.single())
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
    println("SSH production JVM: Dropbear/no HTTP wait, CONNECT, HTTP rejection, verified TLS ordering/identity, split timing and memory key import passed")
}

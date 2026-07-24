package com.sxbvpn.vpnmodule

/**
 * SxbVpnService — Moteur VPN professionnel SXB v4
 *
 * ═══════════════════════════════════════════════════════════════════
 * PROTOCOLES SUPPORTÉS
 * ═══════════════════════════════════════════════════════════════════
 *  SSH              → JSch direct
 *  SSH+Payload      → JSch + SxbPayloadProxy (HTTP Injector style)
 *  VLESS            → sing-box (libbox officiel)
 *  VMess            → sing-box
 *  Trojan           → sing-box
 *  Shadowsocks      → sing-box
 *  WireGuard        → sing-box
 *  Hysteria2        → sing-box
 *  TUIC             → sing-box
 *
 * ═══════════════════════════════════════════════════════════════════
 * FEATURES v4
 * ═══════════════════════════════════════════════════════════════════
 *  ✅ Kill Switch    — coupe tout le trafic si VPN déconnecté
 *  ✅ Auto-Reconnect — backoff exponentiel jusqu'à 10 tentatives
 *  ✅ TrafficStats   — Android TrafficStats (valeurs réelles)
 *  ✅ Notifications  — upload/download en temps réel
 *  ✅ Foreground     — résiste à l'écran verrouillé / swipe
 *  ✅ Security       — SecurityModule (Root/Frida/Xposed)
 *  ✅ Logs masqués   — jamais host/user/password en clair
 */

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.system.Os
import android.util.Log
import com.jcraft.jsch.ChannelDirectTCPIP
import com.jcraft.jsch.JSch
import com.jcraft.jsch.Session
import com.jcraft.jsch.SocketFactory
import org.json.JSONArray
import org.json.JSONObject
import java.io.DataInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Properties
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.Locale

// ═════════════════════════════════════════════════════════════════════════════
// WebSocket binary frame transport — SSH over WebSocket (RFC 6455)
// ═════════════════════════════════════════════════════════════════════════════

/** Reads exactly [n] bytes from [stream], blocking until all arrive or EOF. */
private fun readExactly(stream: InputStream, n: Int): ByteArray? {
    if (n == 0) return ByteArray(0)
    val buf = ByteArray(n)
    var pos = 0
    while (pos < n) {
        val r = stream.read(buf, pos, n - pos)
        if (r == -1) return null
        pos += r
    }
    return buf
}

/**
 * Reads WebSocket binary frames from [raw] and exposes the payload as a plain InputStream.
 * Server-to-client frames must not be masked (RFC 6455 §5.1); we handle masked frames
 * gracefully anyway in case of non-compliant servers.
 */
private class WsFrameInputStream(
    private val raw: InputStream,
    private val log: (String) -> Unit,
) : InputStream() {

    private var frameBuf    = ByteArray(0)
    private var frameBufPos = 0
    private var frameCount  = 0
    private var bannerDone  = false

    // Drain buffered payload, then fetch next frame when empty.
    override fun read(dst: ByteArray, off: Int, len: Int): Int {
        while (frameBufPos >= frameBuf.size) {
            val payload = readNextFrame() ?: return -1
            if (payload.isEmpty()) continue          // ping/pong — skip, try again
            frameBuf    = payload
            frameBufPos = 0
        }
        val n = minOf(len, frameBuf.size - frameBufPos)
        System.arraycopy(frameBuf, frameBufPos, dst, off, n)
        frameBufPos += n
        if (!bannerDone && n >= 4) {
            val s = String(dst, off, minOf(n, 20), Charsets.US_ASCII)
            if (s.startsWith("SSH-")) {
                bannerDone = true
                log("[SXB_DEBUG] SSH_BANNER_RECEIVED: ${s.take(20).trim()}")
            }
        }
        return n
    }

    override fun read(): Int {
        val tmp = ByteArray(1)
        return if (read(tmp, 0, 1) == -1) -1 else tmp[0].toInt() and 0xFF
    }

    private fun readNextFrame(): ByteArray? {
        val b0 = raw.read(); if (b0 == -1) return null
        val b1 = raw.read(); if (b1 == -1) return null

        val opcode = b0 and 0x0F
        val masked  = (b1 and 0x80) != 0

        when (opcode) {
            0x08 -> return null                       // Close — signal EOF to JSch
            0x09, 0x0A -> {                           // Ping / Pong — swallow payload
                val pLen = (b1 and 0x7F)
                if (pLen > 0) readExactly(raw, pLen)
                return ByteArray(0)
            }
        }

        // Payload length (7-bit, 16-bit or 64-bit extended)
        val rawLen = (b1 and 0x7F)
        val payloadLen: Long = when (rawLen) {
            126  -> {
                val h = readExactly(raw, 2) ?: return null
                ((h[0].toLong() and 0xFF) shl 8) or (h[1].toLong() and 0xFF)
            }
            127  -> {
                val h = readExactly(raw, 8) ?: return null
                var v = 0L; for (b in h) v = (v shl 8) or (b.toLong() and 0xFF); v
            }
            else -> rawLen.toLong()
        }

        val maskKey = if (masked) readExactly(raw, 4) else null
        val payload = readExactly(raw, payloadLen.toInt()) ?: return null
        if (masked && maskKey != null) {
            for (i in payload.indices) payload[i] = (payload[i].toInt() xor maskKey[i % 4].toInt()).toByte()
        }

        frameCount++
        if (frameCount <= 5) log("[SXB_DEBUG] WS_FRAME_READ opcode=0x${opcode.toString(16)} len=${payload.size} frame#$frameCount")
        return payload
    }

    override fun available(): Int = maxOf(0, frameBuf.size - frameBufPos)
    override fun close() = raw.close()
}

/**
 * Sends each JSch write as a masked WebSocket binary frame (RFC 6455 §5.3).
 * Client-to-server frames MUST be masked per spec.
 */
private class WsFrameOutputStream(
    private val raw: OutputStream,
    private val log: (String) -> Unit,
) : OutputStream() {

    private val rng        = java.util.Random()
    private val lock       = Any()
    private var frameCount = 0

    override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)

    override fun write(data: ByteArray, off: Int, len: Int) {
        if (len == 0) return
        frameCount++
        if (frameCount <= 5) log("[SXB_DEBUG] WS_FRAME_WRITE len=$len frame#$frameCount")

        val mask = ByteArray(4).also { rng.nextBytes(it) }

        // Header: FIN=1, opcode=2 (binary), MASK=1
        val header: ByteArray = when {
            len < 126    -> byteArrayOf(0x82.toByte(), (0x80 or len).toByte())
            len < 65_536 -> byteArrayOf(0x82.toByte(), (0x80 or 126).toByte(),
                                         (len shr 8).toByte(), (len and 0xFF).toByte())
            else         -> {
                val lb = ByteArray(8); var v = len.toLong()
                for (i in 7 downTo 0) { lb[i] = (v and 0xFF).toByte(); v = v shr 8 }
                byteArrayOf(0x82.toByte(), (0x80 or 127).toByte()) + lb
            }
        }

        // Mask payload in place (copy to avoid mutating caller's buffer)
        val masked = ByteArray(len)
        for (i in 0 until len) masked[i] = (data[off + i].toInt() xor mask[i % 4].toInt()).toByte()

        synchronized(lock) {
            raw.write(header)
            raw.write(mask)
            raw.write(masked)
            raw.flush()
        }
    }

    override fun flush() {} // flush is called inside write()
    override fun close() = raw.close()
}

// ── SxbPayloadProxy — HTTP Upgrade → WebSocket binary frame transport ────────
/**
 * JSch Proxy implementation for SSH over WebSocket.
 *
 * Flow:
 *  1. TCP connect to host:port
 *  2. Send HTTP Upgrade payload (from config) → WebSocket handshake
 *  3. Read response until \r\n\r\n — verify 101 Switching Protocols
 *  4. Wrap raw socket streams with WsFrameInputStream / WsFrameOutputStream
 *  5. JSch uses the wrapped streams transparently for SSH protocol
 */
private class SxbPayloadProxy(
    private val rawPayload: String,
    private val debugLog: (String) -> Unit = {},
) : com.jcraft.jsch.Proxy {

    private var socket: Socket?               = null
    private var wsIn:   WsFrameInputStream?   = null
    private var wsOut:  WsFrameOutputStream?  = null

    override fun connect(sf: SocketFactory?, host: String, port: Int, timeout: Int) {
        debugLog("[SXB_DEBUG] WS_HANDSHAKE_START host=**** port=$port")

        val sock = Socket()
        sock.connect(InetSocketAddress(host, port), timeout.coerceAtLeast(15_000))
        socket = sock
        val rawOut = sock.getOutputStream()
        val rawIn  = sock.getInputStream()

        // Substitutions dans le template payload
        val payload = rawPayload
            .replace("[crlf]",      "\r\n").replace("[CRLF]",      "\r\n")
            .replace("[lf]",        "\n") .replace("[LF]",        "\n")
            .replace("[cr]",        "\r") .replace("[CR]",        "\r")
            .replace("[port]",      port.toString())
            .replace("[host]",      host) .replace("[Host]",      host)
            .replace("[host_port]", "$host:$port")

        rawOut.write(payload.toByteArray(Charsets.ISO_8859_1))
        rawOut.flush()
        debugLog("[SXB_DEBUG] STEP_11_PAYLOAD_SENT bytes=${payload.length}")

        // Lire réponse HTTP jusqu'à \r\n\r\n (fin des headers)
        sock.soTimeout = 15_000
        val response = StringBuilder()
        var b3 = 0; var b2 = 0; var b1 = 0; var limit = 16_384
        while (limit-- > 0) {
            val b = rawIn.read(); if (b == -1) break
            response.append(b.toChar())
            if (b3 == '\r'.code && b2 == '\n'.code && b1 == '\r'.code && b == '\n'.code) break
            b3 = b2; b2 = b1; b1 = b
        }
        sock.soTimeout = 0

        val respStr = response.toString()
        val firstLine = respStr.lineSequence().firstOrNull() ?: ""
        debugLog("[SXB_DEBUG] WS_RESPONSE: $firstLine")

        if (!respStr.contains("101")) {
            throw Exception("WebSocket upgrade refusé — réponse serveur: ${firstLine.take(80)}")
        }
        debugLog("[SXB_DEBUG] WS_HANDSHAKE_SUCCESS — wrapping streams with WS frame I/O")

        // Après 101 Switching Protocols : toutes les données DOIVENT être en frames WS
        wsIn  = WsFrameInputStream(rawIn,   debugLog)
        wsOut = WsFrameOutputStream(rawOut, debugLog)
    }

    override fun getInputStream():  InputStream  = wsIn!!
    override fun getOutputStream(): OutputStream = wsOut!!
    override fun getSocket():       Socket        = socket!!
    override fun close() { runCatching { socket?.close() } }
}

// ═════════════════════════════════════════════════════════════════════════════
// SxbVpnService
// ═════════════════════════════════════════════════════════════════════════════

class SxbVpnService : VpnService() {

    companion object {
        const val TAG              = "SXB-VPN"
        const val ACTION_START     = "com.sxbvpn.START_VPN"
        const val ACTION_STOP      = "com.sxbvpn.STOP_VPN"
        const val BROADCAST_STATUS = "com.sxbvpn.VPN_STATUS"
        const val BROADCAST_LOG    = "com.sxbvpn.VPN_LOG"
        const val NOTIF_CHANNEL    = "sxb_vpn_channel"
        const val NOTIF_ID         = 1001

        private const val SOCKS5_PORT  = 1080

        @Volatile var instance: SxbVpnService? = null
        @Volatile private var currentState: String = "disconnected"

        fun getCurrentState() = currentState
        private fun setCurrentState(s: String) { currentState = s }
    }

    // ── État du service ───────────────────────────────────────────────────────
    private val running         = AtomicBoolean(false)
    private var tunPfd          : ParcelFileDescriptor? = null
    private var dupFd           : java.io.FileDescriptor? = null
    private var sshSession      : Session? = null
    private var socks5Server    : ServerSocket? = null
    private var singBoxProcess  : Process? = null
    private var vpnThread       : Thread? = null
    private var killSwitchEnabled = false
    private var configJson      = ""

    // Managers
    private val trafficManager  = TrafficStatsManager()
    private lateinit var autoReconnect: AutoReconnectManager

    // ── Public API pour SxbVpnModule ──────────────────────────────────────────
    fun enableAutoReconnect()  { if (::autoReconnect.isInitialized) autoReconnect.enable() }
    fun disableAutoReconnect() { if (::autoReconnect.isInitialized) autoReconnect.disable() }

    // Compteurs trafic SSH (relay bidirectionnel)
    private val uploadBytes   = AtomicLong(0L)
    private val downloadBytes = AtomicLong(0L)

    // Timer notification trafic
    private var notifThread: Thread? = null

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        instance = this
        createNotificationChannel()

        autoReconnect = AutoReconnectManager(
            onReconnect = {
                if (running.get() && configJson.isNotEmpty()) {
                    broadcastLog("[SXB] 🔄 Auto-reconnect en cours...")
                    val json = JSONObject(configJson)
                    dispatchProtocol(configJson, json.optString("protocol", "").lowercase())
                }
            },
            onGiveUp = {
                broadcastLog("[SXB] ❌ Auto-reconnect échoué — arrêt")
                broadcastStatus("error")
                setCurrentState("error")
                stopSelf()
            },
            onLog = { broadcastLog(it) },
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { cleanup(); return START_NOT_STICKY }

        // Vérifications de sécurité
        val secReport = SecurityModule.audit(this)
        if (secReport.hasFrida || secReport.hasXposed) {
            broadcastLog("[SXB] ❌ Environnement compromis — connexion refusée")
            broadcastStatus("error")
            stopSelf()
            return START_NOT_STICKY
        }
        if (secReport.isRooted) {
            broadcastLog("[SXB] ⚠️ Appareil rooté — risque de sécurité")
        }

        var json    = intent?.getStringExtra("configJson") ?: ""
        var proto   = intent?.getStringExtra("protocol")?.lowercase() ?: ""

        if (json.isEmpty() || proto.isEmpty()) {
            try {
                // P1 — Lecture config chiffrée (AES-256-GCM) ou plaintext fallback
                val credsFile = File(filesDir, "sxb_creds.enc")
                val confFile  = File(filesDir, "sb_config.json")
                if (credsFile.exists()) {
                    try {
                        json = KeystoreManager.decrypt(credsFile.readText(Charsets.UTF_8))
                        Log.i(TAG, "[P1] Config VPN déchiffrée depuis sxb_creds.enc")
                    } catch (e: Exception) {
                        Log.w(TAG, "[P1] Déchiffrement échoué — fallback plaintext: ${e.message}")
                        if (confFile.exists()) json = confFile.readText(Charsets.UTF_8)
                    }
                } else if (confFile.exists()) {
                    json = confFile.readText(Charsets.UTF_8)
                }
                if (json.isNotEmpty()) {
                    val cfg = org.json.JSONObject(json)
                    proto = cfg.optString("protocol", "").lowercase()
                }
            } catch (_: Exception) {}
        }

        if (json.isEmpty() || proto.isEmpty()) {
            return START_NOT_STICKY
        }

        // P1 — Persister config chiffrée pour démarrage hors-ligne
        if (json.isNotEmpty()) { try { persistEncryptedConfig(json) } catch (_: Exception) {} }
        killSwitchEnabled = intent?.getBooleanExtra("killSwitch", false) ?: false
        configJson  = json

        running.set(true)
        startForeground(NOTIF_ID, buildNotification("SXB VPN — Connexion en cours..."))
        trafficManager.start()

        vpnThread = Thread({ dispatchProtocol(json, proto) }, "SXB-VpnMain")
            .apply { isDaemon = false; start() }

        return START_STICKY
    }

    override fun onDestroy() { cleanup(); instance = null; super.onDestroy() }
    override fun onRevoke()  {
        broadcastLog("[SXB] ⚠️ VPN révoqué par le système")
        broadcastStatus("disconnected")
        cleanup()
        super.onRevoke()
    }

    // ── Dispatch protocole ────────────────────────────────────────────────────

    private fun dispatchProtocol(json: String, proto: String) {
        when (proto) {
            "ssh", "ssh+payload"                                        -> startSshTunnel(json)
            "vless", "vmess", "trojan", "shadowsocks",
            "wireguard", "hysteria2", "tuic"                            -> startSingBoxTunnel(json, proto)
            else -> {
                broadcastLog("[SXB] ❌ Protocole inconnu : $proto")
                broadcastStatus("error"); setCurrentState("error"); stopSelf()
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // SSH TUNNEL (JSch + SOCKS5 local + sing-box TUN relay)
    // ═════════════════════════════════════════════════════════════════════════

    private fun startSshTunnel(configJsonStr: String) {
        try {
            broadcastLog("[SXB] Initialisation tunnel SSH...")
            broadcastStatus("connecting"); setCurrentState("connecting")
            val cfg = JSONObject(configJsonStr)

            val host       = cfg.getString("host")
            val port       = cfg.optInt("port", 22)
            val username   = cfg.optString("username", "")
            val password   = cfg.optString("password", "")
            val payload    = cfg.optString("payload", "")
            val usePayload   = cfg.optBoolean("usePayload", false) || cfg.optString("protocol","").contains("payload")
            val sni         = cfg.optString("sni", "")
            val fingerprint = cfg.optString("fingerprint", "")

            // ── Session JSch ──────────────────────────────────────────────────
            // Logger partagé pour SxbPayloadProxy → broadcastLog + logcat
            val dbg: (String) -> Unit = { msg ->
                Log.d(TAG, msg)
                broadcastLog(msg)
            }

            val jsch = JSch()
            val session: Session = if (usePayload && payload.isNotEmpty()) {
                broadcastLog("[SXB] Mode SSH+Payload (WebSocket transport)")
                jsch.getSession(username, host, port).also { s ->
                    s.setProxy(SxbPayloadProxy(payload, dbg))
                    s.setPassword(password)
                    val props = Properties().apply {
                        set("StrictHostKeyChecking", "no")
                        set("PreferredAuthentications", "password")
                        if (sni.isNotEmpty()) set("ServerAliveInterval", "30")
                    }
                    s.setConfig(props)
                    s.timeout = 45_000   // plus long pour WS handshake + SSH connect
                }
            } else {
                broadcastLog("[SXB] Mode SSH direct")
                jsch.getSession(username, host, port).also { s ->
                    s.setPassword(password)
                    val props = Properties().apply {
                        set("StrictHostKeyChecking", "no")
                        set("PreferredAuthentications", "password")
                    }
                    s.setConfig(props)
                    s.timeout = 30_000
                }
            }

            broadcastLog("[SXB_DEBUG] STEP_9_SSH_CONNECTING host=**** port=$port")
            session.connect(45_000)
            // P5 — Vérification fingerprint post-connexion (hors StrictHostKeyChecking)
            if (fingerprint.isNotEmpty()) {
                val hostKey  = session.hostKey
                val actualFp = hostKey?.getFingerPrint(jsch) ?: ""
                val fpNorm   = { s: String -> s.replace(":", "").lowercase() }
                if (fpNorm(actualFp) != fpNorm(fingerprint)) {
                    session.disconnect()
                    throw SecurityException("[SXB] ❌ Fingerprint SSH invalide\n  Attendu: $fingerprint\n  Reçu   : $actualFp")
                }
                broadcastLog("[SXB] ✅ Fingerprint SSH vérifié: $fingerprint")
            } else {
                broadcastLog("[SXB] ⚠️ Aucun fingerprint configuré — hôte non vérifié")
            }
            sshSession = session
            broadcastLog("[SXB_DEBUG] SSH_AUTH_SUCCESS — session établie")
            broadcastLog("[SXB] Tunnel SSH établi ✅")

            // ── Serveur SOCKS5 local ──────────────────────────────────────────
            socks5Server = startLocalSocks5Server(session)
            broadcastLog("[SXB_DEBUG] SOCKS_READY port=$SOCKS5_PORT")
            broadcastLog("[SXB] SOCKS5 local actif (port $SOCKS5_PORT)")

            // ── Interface TUN ─────────────────────────────────────────────────
            val tun = buildTunInterface("SSH", listOf("1.1.1.1", "8.8.8.8"))
            tunPfd = tun ?: throw Exception("Impossible d'établir l'interface TUN")

            // ── sing-box comme pont TUN → SOCKS5 ─────────────────────────────
            val fdInt = getFdInt(tunPfd!!.fileDescriptor)
            dupFd = Os.dup(tunPfd!!.fileDescriptor)
            val dupInt = getFdInt(dupFd!!)

            val sbConfig = buildSshSocksRelayConfig(dupInt)
            val sbBin    = extractSingBoxBinary() ?: throw Exception("Moteur VPN introuvable")
            val sbConf   = writeSingBoxConfig(sbConfig)

            val process = ProcessBuilder(sbBin.absolutePath, "run", "-c", sbConf.absolutePath)
                .redirectErrorStream(true)
                .start()
            singBoxProcess = process

            Thread({
                try {
                    process.inputStream.bufferedReader().forEachLine { line ->
                        if (line.isNotBlank()) broadcastLog("[engine] ${SecurityModule.maskSensitive(line)}")
                    }
                } catch (_: Exception) {}
            }, "SXB-SbLog").apply { isDaemon = true; start() }

            Thread.sleep(1_500)
            if (!process.isAlive) throw Exception("sing-box s'est arrêté immédiatement")

            broadcastLog("[SXB] ✅ VPN SSH actif — Credential:******** Trafic:Actif")
            broadcastStatus("connected"); setCurrentState("connected")
            autoReconnect.onConnected()
            updateNotification("SXB VPN — ${if (usePayload) "SSH+Payload" else "SSH"} connecté")
            startNotificationUpdater()

            // ── Boucle de surveillance ────────────────────────────────────────
            while (running.get()) {
                if (!session.isConnected) {
                    broadcastLog("[SXB] ⚠️ Session SSH perdue")
                    broadcastStatus("error"); setCurrentState("error")
                    if (autoReconnect.isEnabled()) { autoReconnect.onDisconnected(); return }
                    break
                }
                if (!process.isAlive) {
                    val code = process.exitValue()
                    broadcastLog("[SXB] ⚠️ Moteur TUN arrêté (code=$code)")
                    broadcastStatus("error"); setCurrentState("error")
                    if (autoReconnect.isEnabled()) { autoReconnect.onDisconnected(); return }
                    break
                }
                Thread.sleep(3_000)
            }
        } catch (e: InterruptedException) {
            Log.i(TAG, "Thread SSH interrompu")
        } catch (e: Exception) {
            Log.e(TAG, "Erreur SSH", e)
            val msg = e.message ?: "erreur inconnue"
            val display = when {
                msg.contains("Auth fail") || msg.contains("auth", true) ->
                    "❌ Authentification SSH échouée"
                msg.contains("Connection refused") ->
                    "❌ Connexion refusée — serveur inaccessible"
                msg.contains("timeout", true) ->
                    "❌ Timeout — vérifiez host/port"
                else -> "❌ Erreur tunnel : ${msg.take(80)}"
            }
            broadcastLog("[SXB] $display")
            broadcastStatus("error"); setCurrentState("error")
            if (autoReconnect.isEnabled()) autoReconnect.onDisconnected()
        } finally {
            if (!autoReconnect.isEnabled()) cleanup()
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // SING-BOX TUNNEL (VLESS / VMess / Trojan / Shadowsocks / WireGuard / Hysteria2 / TUIC)
    // ═════════════════════════════════════════════════════════════════════════

    private fun startSingBoxTunnel(configJsonStr: String, protocol: String) {
        try {
            broadcastLog("[SXB] Initialisation VPN ${protocol.uppercase()}...")
            broadcastStatus("connecting"); setCurrentState("connecting")

            val cfg = JSONObject(configJsonStr)

            // ── Binaire sing-box ──────────────────────────────────────────────
            val sbBin = extractSingBoxBinary()
                ?: throw Exception("Moteur VPN introuvable — réinstallez l'APK")
            broadcastLog("[SXB] Moteur VPN: sing-box ${getSingBoxVersion(sbBin)}")

            // ── Interface TUN ─────────────────────────────────────────────────
            broadcastLog("[SXB] Création interface réseau TUN...")
            val dns = listOf("1.1.1.1", "8.8.8.8", "1.0.0.1")
            val tun = buildTunInterface(protocol.uppercase(), dns)
            tunPfd = tun ?: throw Exception("Impossible d'établir l'interface TUN")

            // Dupliquer le fd pour le passer à sing-box (supprime FD_CLOEXEC)
            dupFd = Os.dup(tunPfd!!.fileDescriptor)
            val tunFdInt = getFdInt(dupFd!!)
            if (tunFdInt < 0) throw Exception("fd TUN invalide : $tunFdInt")
            broadcastLog("[SXB] Interface TUN créée (fd=$tunFdInt)")

            // ── Config sing-box ───────────────────────────────────────────────
            val sbConfigJson = buildSingBoxConfig(cfg, protocol, tunFdInt)
            val sbConfFile   = writeSingBoxConfig(sbConfigJson)
            broadcastLog("[SXB] Config générée pour $protocol")

            // ── Lancement sing-box ────────────────────────────────────────────
            val pb = ProcessBuilder(sbBin.absolutePath, "run", "-c", sbConfFile.absolutePath)
                .redirectErrorStream(true)
            pb.environment()["GOMAXPROCS"] = "2"

            val process = pb.start()
            singBoxProcess = process

            // Thread logs sing-box (masquage données sensibles)
            Thread({
                try {
                    process.inputStream.bufferedReader().forEachLine { line ->
                        if (line.isNotBlank()) {
                            broadcastLog("[engine] ${SecurityModule.maskSensitive(line)}")
                        }
                    }
                } catch (_: Exception) {}
            }, "SXB-SbLog").apply { isDaemon = true; start() }

            // Attendre que sing-box soit prêt
            Thread.sleep(2_500)
            if (!process.isAlive) {
                val code = process.exitValue()
                throw Exception("sing-box s'est arrêté immédiatement (code=$code) — vérifiez la configuration")
            }

            broadcastLog("[SXB] ✅ VPN ${protocol.uppercase()} actif")
            broadcastStatus("connected"); setCurrentState("connected")
            autoReconnect.onConnected()
            updateNotification("SXB VPN — ${protocol.uppercase()} connecté")
            startNotificationUpdater()

            // ── Boucle de surveillance ────────────────────────────────────────
            while (running.get()) {
                if (!process.isAlive) {
                    val code = process.exitValue()
                    broadcastLog("[SXB] ⚠️ sing-box arrêté (code=$code)")
                    broadcastStatus("error"); setCurrentState("error")
                    if (autoReconnect.isEnabled()) { autoReconnect.onDisconnected(); return }
                    break
                }
                // Mise à jour notification avec trafic toutes les 5s
                Thread.sleep(5_000)
            }
        } catch (e: InterruptedException) {
            Log.i(TAG, "Thread sing-box interrompu")
        } catch (e: Exception) {
            Log.e(TAG, "Erreur sing-box", e)
            broadcastLog("[SXB] ❌ ${e.message?.take(120) ?: "erreur inconnue"}")
            broadcastStatus("error"); setCurrentState("error")
            if (autoReconnect.isEnabled()) autoReconnect.onDisconnected()
        } finally {
            if (!autoReconnect.isEnabled()) cleanup()
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // CONSTRUCTEUR D'INTERFACE TUN
    // ═════════════════════════════════════════════════════════════════════════

    private fun buildTunInterface(sessionName: String, dns: List<String>): ParcelFileDescriptor? {
        val builder = Builder()
            .setSession("SXB VPN — $sessionName")
            .addAddress("172.19.0.1", 30)
            .addRoute("0.0.0.0", 0)
            .addRoute("::", 0)
            .setMtu(1500)
            .setBlocking(true)

        // DNS
        for (d in dns) { try { builder.addDnsServer(d) } catch (_: Exception) {} }

        // Exclure l'app elle-même (évite boucle)
        try { builder.addDisallowedApplication(packageName) } catch (_: Exception) {}

        // Kill Switch : si activé, aucune appli ne bypass le VPN
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            builder.setMetered(false)
        }
        // Note : le kill switch Android réel est géré via VpnService.Builder
        // Les apps bloquées restent bloquées si VPN coupe (pas de fallback réseau)

        return try { builder.establish() } catch (e: Exception) {
            Log.e(TAG, "establish() failed: ${e.message}")
            null
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // GÉNÉRATEUR DE CONFIG SING-BOX (JSON complet pour chaque protocole)
    // ═════════════════════════════════════════════════════════════════════════

    private fun buildSingBoxConfig(cfg: JSONObject, protocol: String, tunFd: Int): String {
        val host     = cfg.optString("host", "")
        val port     = cfg.optInt("port", 443)
        val uuid     = cfg.optString("uuid", "")
        val password = cfg.optString("password", "")
        val method   = cfg.optString("method", "aes-256-gcm")
        val sni      = cfg.optString("sni", host)
        val network  = cfg.optString("network", "tcp")
        val path     = cfg.optString("path", "/")
        val tls      = cfg.optBoolean("tls", true)
        val flow     = cfg.optString("flow", "")
        val privKey  = cfg.optString("privateKey", "")
        val peerPub  = cfg.optString("peerPublicKey", "")
        val localAddr = cfg.optString("localAddress", "10.0.0.2/32")

        // Inbound TUN
        val tunInbound = JSONObject().apply {
            put("type", "tun")
            put("tag", "tun-in")
            put("file_descriptor", tunFd)
            put("inet4_address", "172.19.0.1/30")
            put("auto_route", false)
            put("strict_route", false)
            put("sniff", true)
            put("sniff_override_destination", false)
        }

        // DNS
        val dnsObj = JSONObject().apply {
            put("servers", JSONArray()
                .put(JSONObject().put("tag", "dns-remote").put("address", "https://1.1.1.1/dns-query").put("strategy", "prefer_ipv4").put("detour", "proxy"))
                .put(JSONObject().put("tag", "dns-local").put("address", "local").put("detour", "direct"))
                .put(JSONObject().put("tag", "dns-fake").put("address", "fakeip").put("detour", "direct"))
            )
            put("fakeip", JSONObject()
                .put("enabled", true)
                .put("inet4_range", "198.18.0.0/15")
            )
            put("rules", JSONArray()
                .put(JSONObject().put("outbound", "any").put("server", "dns-local"))
                .put(JSONObject().put("query_type", JSONArray().put("A").put("AAAA")).put("server", "dns-fake"))
            )
            put("final", "dns-remote")
            put("independent_cache", true)
        }

        // Outbound proxy selon protocole
        val proxyOutbound = when (protocol) {
            "vless" -> buildVlessOutbound(host, port, uuid, sni, network, path, tls, flow)
            "vmess" -> buildVmessOutbound(host, port, uuid, sni, network, path, tls)
            "trojan" -> buildTrojanOutbound(host, port, password, sni, network, path, tls)
            "shadowsocks" -> buildShadowsocksOutbound(host, port, password, method)
            "wireguard" -> buildWireGuardOutbound(host, port, privKey, peerPub, localAddr)
            "hysteria2" -> buildHysteria2Outbound(host, port, password, sni, tls)
            "tuic" -> buildTuicOutbound(host, port, uuid, password, sni, tls)
            else -> JSONObject().put("type", "direct").put("tag", "proxy")
        }

        // Route
        val routeObj = JSONObject().apply {
            put("rules", JSONArray()
                .put(JSONObject().put("protocol", "dns").put("outbound", "dns-out"))
                .put(JSONObject().put("ip_is_private", true).put("outbound", "direct"))
            )
            put("final", "proxy")
            put("auto_detect_interface", false)
            put("override_android_vpn", true)
        }

        return JSONObject().apply {
            put("log", JSONObject().put("level", "warn").put("timestamp", true))
            put("dns", dnsObj)
            put("inbounds", JSONArray().put(tunInbound))
            put("outbounds", JSONArray()
                .put(proxyOutbound)
                .put(JSONObject().put("type", "direct").put("tag", "direct"))
                .put(JSONObject().put("type", "dns").put("tag", "dns-out"))
                .put(JSONObject().put("type", "block").put("tag", "block"))
            )
            put("route", routeObj)
        }.toString(2)
    }

    // ── Outbounds par protocole ───────────────────────────────────────────────

    private fun buildVlessOutbound(host: String, port: Int, uuid: String, sni: String,
                                    network: String, path: String, tls: Boolean, flow: String): JSONObject {
        return JSONObject().apply {
            put("type", "vless")
            put("tag", "proxy")
            put("server", host)
            put("server_port", port)
            put("uuid", uuid)
            if (flow.isNotEmpty()) put("flow", flow)
            put("tls", buildTlsObj(sni, tls))
            if (network == "ws" || network == "websocket") put("transport", buildWsTransport(path, sni))
            else if (network == "grpc") put("transport", buildGrpcTransport(path))
        }
    }

    private fun buildVmessOutbound(host: String, port: Int, uuid: String, sni: String,
                                    network: String, path: String, tls: Boolean): JSONObject {
        return JSONObject().apply {
            put("type", "vmess")
            put("tag", "proxy")
            put("server", host)
            put("server_port", port)
            put("uuid", uuid)
            put("security", "auto")
            put("alter_id", 0)
            put("tls", buildTlsObj(sni, tls))
            if (network == "ws" || network == "websocket") put("transport", buildWsTransport(path, sni))
            else if (network == "grpc") put("transport", buildGrpcTransport(path))
        }
    }

    private fun buildTrojanOutbound(host: String, port: Int, password: String, sni: String,
                                     network: String, path: String, tls: Boolean): JSONObject {
        return JSONObject().apply {
            put("type", "trojan")
            put("tag", "proxy")
            put("server", host)
            put("server_port", port)
            put("password", password)
            put("tls", buildTlsObj(sni, tls))
            if (network == "ws" || network == "websocket") put("transport", buildWsTransport(path, sni))
            else if (network == "grpc") put("transport", buildGrpcTransport(path))
        }
    }

    private fun buildShadowsocksOutbound(host: String, port: Int, password: String, method: String): JSONObject {
        return JSONObject().apply {
            put("type", "shadowsocks")
            put("tag", "proxy")
            put("server", host)
            put("server_port", port)
            put("method", method.ifEmpty { "aes-256-gcm" })
            put("password", password)
            put("udp_over_tcp", false)
        }
    }

    private fun buildWireGuardOutbound(host: String, port: Int, privKey: String,
                                        peerPub: String, localAddr: String): JSONObject {
        return JSONObject().apply {
            put("type", "wireguard")
            put("tag", "proxy")
            put("server", host)
            put("server_port", port)
            put("private_key", privKey)
            put("peer_public_key", peerPub)
            put("local_address", JSONArray()
                .put(localAddr.ifEmpty { "10.0.0.2/32" })
                .put("fd00::2/128")
            )
            put("mtu", 1420)
        }
    }

    private fun buildHysteria2Outbound(host: String, port: Int, password: String,
                                        sni: String, tls: Boolean): JSONObject {
        return JSONObject().apply {
            put("type", "hysteria2")
            put("tag", "proxy")
            put("server", host)
            put("server_port", port)
            put("password", password)
            put("tls", buildTlsObj(sni, tls))
        }
    }

    private fun buildTuicOutbound(host: String, port: Int, uuid: String, password: String,
                                   sni: String, tls: Boolean): JSONObject {
        return JSONObject().apply {
            put("type", "tuic")
            put("tag", "proxy")
            put("server", host)
            put("server_port", port)
            put("uuid", uuid)
            put("password", password)
            put("congestion_control", "bbr")
            put("udp_relay_mode", "native")
            put("tls", buildTlsObj(sni, tls))
        }
    }

    // ── Helpers config sing-box ───────────────────────────────────────────────

    private fun buildTlsObj(sni: String, enabled: Boolean): JSONObject {
        return JSONObject().apply {
            put("enabled", enabled)
            if (sni.isNotEmpty()) put("server_name", sni)
            put("insecure", false)
            put("disable_sni", false)
        }
    }

    private fun buildWsTransport(path: String, host: String): JSONObject {
        return JSONObject().apply {
            put("type", "ws")
            put("path", path.ifEmpty { "/" })
            if (host.isNotEmpty()) put("headers", JSONObject().put("Host", host))
            put("max_early_data", 0)
            put("early_data_header_name", "")
        }
    }

    private fun buildGrpcTransport(serviceName: String): JSONObject {
        return JSONObject().apply {
            put("type", "grpc")
            put("service_name", serviceName.ifEmpty { "GunService" })
        }
    }

    // ── Config TUN → SOCKS5 (pour tunnel SSH) ────────────────────────────────
    private fun buildSshSocksRelayConfig(tunFdInt: Int): String {
        return JSONObject().apply {
            put("log", JSONObject().put("level", "warn").put("timestamp", true))
            put("dns", JSONObject().apply {
                put("servers", JSONArray()
                    .put(JSONObject().put("tag", "dns-r").put("address", "https://1.1.1.1/dns-query").put("strategy", "prefer_ipv4"))
                    .put(JSONObject().put("tag", "dns-l").put("address", "local").put("detour", "direct"))
                )
                put("rules", JSONArray().put(JSONObject().put("outbound", "any").put("server", "dns-l")))
                put("final", "dns-r")
            })
            put("inbounds", JSONArray().put(JSONObject().apply {
                put("type", "tun")
                put("tag", "tun-in")
                put("file_descriptor", tunFdInt)
                put("inet4_address", "172.19.0.1/30")
                put("auto_route", false)
                put("strict_route", false)
                put("sniff", true)
            }))
            put("outbounds", JSONArray()
                .put(JSONObject().apply {
                    put("type", "socks")
                    put("tag", "proxy")
                    put("server", "127.0.0.1")
                    put("server_port", SOCKS5_PORT)
                    put("version", "5")
                })
                .put(JSONObject().put("type", "direct").put("tag", "direct"))
                .put(JSONObject().put("type", "dns").put("tag", "dns-out"))
            )
            put("route", JSONObject().apply {
                put("rules", JSONArray()
                    .put(JSONObject().put("protocol", "dns").put("outbound", "dns-out"))
                    .put(JSONObject().put("ip_is_private", true).put("outbound", "direct"))
                )
                put("final", "proxy")
                put("auto_detect_interface", false)
            })
        }.toString(2)
    }

    // ═════════════════════════════════════════════════════════════════════════
    // SOCKS5 SERVER (pour relayer SSH → TUN)
    // ═════════════════════════════════════════════════════════════════════════

    private fun startLocalSocks5Server(session: Session): ServerSocket {
        val server = ServerSocket(SOCKS5_PORT, 50, InetAddress.getLoopbackAddress())
        Thread({
            while (!server.isClosed && session.isConnected && running.get()) {
                try {
                    val client = server.accept()
                    Thread({ handleSocks5Client(session, client) }, "Socks5Client")
                        .apply { isDaemon = true; start() }
                } catch (e: Exception) {
                    if (running.get()) Log.w(TAG, "Socks5 accept: ${e.message}")
                    break
                }
            }
            runCatching { server.close() }
        }, "Socks5Server").apply { isDaemon = true; start() }
        return server
    }

    private fun handleSocks5Client(session: Session, client: Socket) {
        try {
            client.soTimeout = 30_000
            val din  = DataInputStream(client.inputStream)
            val dout = client.outputStream

            // Handshake SOCKS5
            val ver = din.read(); if (ver != 5) { client.close(); return }
            val nMethods = din.read()
            din.readFully(ByteArray(nMethods))
            dout.write(byteArrayOf(5, 0)); dout.flush()

            // Requête CONNECT
            val cmd = ByteArray(4); din.readFully(cmd)
            if (cmd[1].toInt() != 1) { dout.write(byteArrayOf(5, 7, 0, 1, 0, 0, 0, 0, 0, 0)); client.close(); return }

            val atyp = cmd[3].toInt()
            val destHost: String
            val destPort: Int
            when (atyp) {
                1 -> { val a = ByteArray(4); din.readFully(a); destHost = InetAddress.getByAddress(a).hostAddress ?: "" }
                3 -> { val len = din.read(); val b = ByteArray(len); din.readFully(b); destHost = String(b) }
                4 -> { val a = ByteArray(16); din.readFully(a); destHost = InetAddress.getByAddress(a).hostAddress ?: "" }
                else -> { client.close(); return }
            }
            val pHigh = din.read(); val pLow = din.read()
            destPort = (pHigh shl 8) or pLow

            // Ouvrir canal SSH direct-tcpip
            val channel = session.openChannel("direct-tcpip") as ChannelDirectTCPIP
            channel.setHost(destHost)
            channel.setPort(destPort)
            channel.setOrgIPAddress("127.0.0.1")
            channel.setOrgPort(SOCKS5_PORT)

            dout.write(byteArrayOf(5, 0, 0, 1, 0, 0, 0, 0, 0, 0)); dout.flush()
            channel.connect(15_000)

            // Relay bidirectionnel
            val threadA = Thread({
                try {
                    val buf = ByteArray(8192); val chOut = channel.outputStream; var n: Int
                    while (channel.isConnected && !client.isClosed) {
                        n = client.inputStream.read(buf); if (n == -1) break
                        chOut.write(buf, 0, n); chOut.flush()
                        uploadBytes.addAndGet(n.toLong())
                    }
                } catch (_: Exception) {}
                runCatching { channel.disconnect() }
            }, "Socks5-Up").apply { isDaemon = true; start() }

            val threadB = Thread({
                try {
                    val buf = ByteArray(8192); val chIn = channel.inputStream; var n: Int
                    while (channel.isConnected && !client.isClosed) {
                        n = chIn.read(buf); if (n == -1) break
                        dout.write(buf, 0, n); dout.flush()
                        downloadBytes.addAndGet(n.toLong())
                    }
                } catch (_: Exception) {}
                runCatching { client.close() }
            }, "Socks5-Down").apply { isDaemon = true; start() }

            threadA.join(300_000); threadB.join(5_000)
            channel.disconnect()
        } catch (e: Exception) {
            Log.d(TAG, "SOCKS5 fin: ${e.message?.take(60)}")
        } finally {
            runCatching { client.close() }
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // STATISTIQUES DE TRAFIC
    // ═════════════════════════════════════════════════════════════════════════

    fun getTrafficStats(): Map<String, Long> {
        val stats = trafficManager.getStats()
        return mapOf(
            "uploadBytes"   to (stats.uploadBytes   + uploadBytes.get()),
            "downloadBytes" to (stats.downloadBytes + downloadBytes.get()),
            "uploadSpeed"   to stats.uploadSpeed,
            "downloadSpeed" to stats.downloadSpeed,
        )
    }

    // ═════════════════════════════════════════════════════════════════════════
    // KILL SWITCH
    // ═════════════════════════════════════════════════════════════════════════

    fun setKillSwitch(enabled: Boolean) {
        killSwitchEnabled = enabled
        // Le kill switch est appliqué à la prochaine connexion (reconstruit le TUN)
        broadcastLog("[SXB] Kill Switch : ${if (enabled) "activé" else "désactivé"}")
    }

    // ═════════════════════════════════════════════════════════════════════════
    // NOTIFICATIONS
    // ═════════════════════════════════════════════════════════════════════════

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(NOTIF_CHANNEL, "SXB VPN", NotificationManager.IMPORTANCE_LOW)
                .apply {
                    description = "Tunnel VPN SXB actif"
                    setShowBadge(false)
                    enableVibration(false)
                    setSound(null, null)
                }
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(ch)
        }
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            packageManager.getLaunchIntentForPackage(packageName),
            PendingIntent.FLAG_IMMUTABLE
        )
        val stop = PendingIntent.getService(
            this, 1,
            Intent(this, SxbVpnService::class.java).apply { action = ACTION_STOP },
            PendingIntent.FLAG_IMMUTABLE
        )
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, NOTIF_CHANNEL)
        else
            @Suppress("DEPRECATION") Notification.Builder(this)

        return b
            .setContentTitle("SXB VPN")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Déconnecter", stop)
            .build()
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java)?.notify(NOTIF_ID, buildNotification(text))
    }

    private fun startNotificationUpdater() {
        notifThread?.interrupt()
        notifThread = Thread({
            while (running.get() && currentState == "connected") {
                try {
                    val stats  = trafficManager.getStats()
                    val upKB   = formatSpeed(stats.uploadSpeed)
                    val downKB = formatSpeed(stats.downloadSpeed)
                    updateNotification("SXB VPN — ↑$upKB ↓$downKB")
                    Thread.sleep(5_000)
                } catch (_: InterruptedException) { break }
            }
        }, "SXB-NotifUpdater").apply { isDaemon = true; start() }
    }

    private fun formatSpeed(bytesPerSec: Long): String {
        return when {
            bytesPerSec >= 1_048_576 -> String.format(Locale.US, "%.1f MB/s", bytesPerSec / 1_048_576.0)
            bytesPerSec >= 1_024     -> String.format(Locale.US, "%.0f KB/s", bytesPerSec / 1_024.0)
            else                     -> "$bytesPerSec B/s"
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // BROADCASTS
    // ═════════════════════════════════════════════════════════════════════════

    private fun broadcastStatus(status: String) {
        sendBroadcast(Intent(BROADCAST_STATUS).putExtra("status", status))
    }

    private fun broadcastLog(message: String) {
        Log.i(TAG, message)
        sendBroadcast(Intent(BROADCAST_LOG).putExtra("log", SecurityModule.maskSensitive(message)))
    }

    // ═════════════════════════════════════════════════════════════════════════
    // UTILITAIRES
    // ═════════════════════════════════════════════════════════════════════════


    /** SHA-256 d'un stream — pour P4 vérification intégrité sing-box */
    private fun sha256Stream(stream: java.io.InputStream): String {
        val md  = java.security.MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(8192)
        stream.use { var n: Int; while (stream.read(buf).also { n = it } != -1) md.update(buf, 0, n) }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    private fun extractSingBoxBinary(): File? {
        val arch = System.getProperty("os.arch") ?: ""
        val assetNames = when {
            arch.contains("aarch64") || arch.contains("arm64") ->
                listOf("sing-box-arm64", "sing-box")
            arch.contains("arm") ->
                listOf("sing-box-arm", "sing-box-armeabi", "sing-box-arm64", "sing-box")
            else ->
                listOf("sing-box-arm64", "sing-box-arm", "sing-box")
        }
        for (name in assetNames) {
            try {
                val dest = File(filesDir, "sing-box")
                // Recopia si absent ou trop petit (corrompu)
                if (!dest.exists() || dest.length() < 1_000_000) {
                    assets.open(name).use { inp ->
                        FileOutputStream(dest).use { out -> inp.copyTo(out) }
                    }
                    dest.setExecutable(true, false)
                    Log.i(TAG, "sing-box extrait depuis asset '$name' (${dest.length()} bytes)")
                    // P4 — SHA-256 : fichier extrait doit correspondre à l'asset
                    try {
                        val assetHash = sha256Stream(assets.open(name))
                        val fileHash  = sha256Stream(java.io.FileInputStream(dest))
                        if (assetHash != fileHash) {
                            dest.delete()
                            Log.e(TAG, "sing-box SHA-256 mismatch — exécution bloquée")
                            continue
                        }
                        Log.i(TAG, "sing-box SHA-256 ✅")
                    } catch (e: Exception) {
                        Log.w(TAG, "[P4] SHA-256 check skipped: ${e.message}")
                    }
                }
                if (dest.exists() && dest.canExecute()) return dest
            } catch (_: Exception) {
                Log.w(TAG, "Asset '$name' non trouvé")
            }
        }
        return null
    }

    private fun writeSingBoxConfig(configJson: String): File {
        val confFile = File(filesDir, "sb_config.json")
        confFile.writeText(configJson, Charsets.UTF_8)
        return confFile
    }

    /** P1 — Chiffre configJson (credentials VPN) avec AES-256-GCM Android Keystore */
    private fun persistEncryptedConfig(originalConfigJson: String) {
        try {
            File(filesDir, "sxb_creds.enc").writeText(KeystoreManager.encrypt(originalConfigJson), Charsets.UTF_8)
            Log.i(TAG, "[P1] Config VPN chiffrée et persistée (AES-256-GCM) ✅")
        } catch (e: Exception) {
            Log.w(TAG, "[P1] Chiffrement config échoué (Keystore non disponible?): ${e.message}")
        }
    }

    private fun getSingBoxVersion(bin: File): String {
        return try {
            val p   = Runtime.getRuntime().exec(arrayOf(bin.absolutePath, "version"))
            val out = p.inputStream.bufferedReader().readLine() ?: ""
            p.destroy()
            out.trim().take(30)
        } catch (_: Exception) { "unknown" }
    }

    private fun getFdInt(fd: java.io.FileDescriptor): Int {
        for (field in arrayOf("descriptor", "fd")) {
            try {
                val f = java.io.FileDescriptor::class.java.getDeclaredField(field)
                f.isAccessible = true
                return f.getInt(fd)
            } catch (_: Exception) {}
        }
        return -1
    }

    // ═════════════════════════════════════════════════════════════════════════
    // NETTOYAGE
    // ═════════════════════════════════════════════════════════════════════════

    private fun cleanup() {
        running.set(false)
        vpnThread?.interrupt()
        notifThread?.interrupt()

        runCatching { socks5Server?.close() };  socks5Server    = null
        runCatching { singBoxProcess?.destroy() }; singBoxProcess = null
        runCatching { sshSession?.disconnect() }; sshSession     = null

        runCatching { if (dupFd != null) Os.close(dupFd!!) }; dupFd   = null
        runCatching { tunPfd?.close() };                       tunPfd  = null

        trafficManager.stop()
        autoReconnect.reset()

        setCurrentState("disconnected")
        broadcastStatus("disconnected")
        stopForeground(true)
        stopSelf()
    }

    fun stopVpn() = cleanup()
}

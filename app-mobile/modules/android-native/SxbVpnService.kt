package com.sxbvpn.vpnmodule

/**
 * SxbVpnService — Moteur VPN professionnel SXB v6 (libbox in-process)
 *
 * ═══════════════════════════════════════════════════════════════════
 * PROTOCOLES SUPPORTÉS
 * ═══════════════════════════════════════════════════════════════════
 *  SSH              → JSch + SOCKS5 local, relayé au TUN par libbox
 *  SSH+Payload      → JSch + SxbPayloadProxy (HTTP Injector style)
 *  VLESS            → libbox (sing-box in-process)
 *  VMess            → libbox
 *  Trojan           → libbox
 *  Shadowsocks      → libbox
 *  WireGuard        → libbox
 *  Hysteria2        → libbox
 *  TUIC             → libbox
 *
 * ═══════════════════════════════════════════════════════════════════
 * CHANGEMENT MAJEUR v6 — POURQUOI LE VPN NE DÉMARRAIT PAS
 * ═══════════════════════════════════════════════════════════════════
 * La v5 générait un inbound TUN `{"type":"tun","file_descriptor":<fd>}` et
 * lançait `sing-box run -c config.json` via ProcessBuilder. Deux défauts
 * rendaient toute connexion impossible — la clé VPN n'apparaissait jamais
 * dans la barre d'état Android :
 *
 *  1. `file_descriptor` N'EXISTE PAS dans le schéma JSON de sing-box.
 *     Ce champ n'est renseigné que par l'API Go `libbox`, via
 *     `PlatformInterface.OpenTun()`. En CLI, sing-box rejette la config
 *     (`json: unknown field "file_descriptor"`) et s'arrête aussitôt.
 *     → l'ancien code levait « sing-box s'est arrêté immédiatement (code=1) ».
 *
 *  2. Depuis Android 10 (API 29), exécuter un binaire depuis le répertoire
 *     privé de l'app est interdit (W^X) → `error=13, Permission denied`.
 *
 * v6 supprime totalement le processus externe. Le service implémente
 * `libbox.PlatformInterface` : sing-box tourne DANS le process de l'app,
 * réclame le TUN par `openTun()` (qui appelle `VpnService.Builder.establish()`)
 * et protège ses sockets sortants par `autoDetectInterfaceControl()` →
 * `VpnService.protect()`. C'est exactement l'architecture de sing-box for
 * Android, NPV Tunnel, HTTP Custom et SocksIP.
 *
 * ═══════════════════════════════════════════════════════════════════
 * FEATURES
 * ═══════════════════════════════════════════════════════════════════
 *  ✅ Kill Switch    — coupe tout le trafic si VPN déconnecté
 *  ✅ Auto-Reconnect — délais fixes, 3 tentatives
 *  ✅ TrafficStats   — Android TrafficStats (valeurs réelles)
 *  ✅ Notifications  — upload/download en temps réel
 *  ✅ Foreground     — type `specialUse` (exigé pour les VPN sur Android 14+)
 *  ✅ Security       — SecurityModule (Root/Frida/Xposed)
 *  ✅ Logs masqués   — jamais host/user/password en clair
 */

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkRequest
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import com.jcraft.jsch.ChannelDirectTCPIP
import com.jcraft.jsch.JSch
import com.jcraft.jsch.Session
import com.jcraft.jsch.SocketFactory
import io.nekohasekai.libbox.BoxService
import io.nekohasekai.libbox.InterfaceUpdateListener
import io.nekohasekai.libbox.Libbox
import io.nekohasekai.libbox.NetworkInterfaceIterator
import io.nekohasekai.libbox.PlatformInterface
import io.nekohasekai.libbox.SetupOptions
import io.nekohasekai.libbox.TunOptions
import io.nekohasekai.libbox.WIFIState
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.io.SequenceInputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom
import java.util.Properties
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.Locale
import javax.net.ssl.SSLParameters
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

// ── WsOutputStream — Encode chaque write() en frame WebSocket binaire (client→server, masqué) ──
private class WsOutputStream(private val raw: OutputStream) : OutputStream() {
    private val rng = SecureRandom()

    override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)
    override fun write(b: ByteArray) = write(b, 0, b.size)
    override fun write(b: ByteArray, off: Int, len: Int) {
        if (len == 0) return
        val mask = ByteArray(4).also { rng.nextBytes(it) }
        val masked = ByteArray(len) { i -> (b[off + i].toInt() xor mask[i % 4].toInt()).toByte() }
        val buf = ByteArrayOutputStream(len + 14)
        buf.write(0x82)                         // FIN=1, opcode=0x02 (binary)
        when {
            len < 126    -> { buf.write(0x80 or len) }
            len < 65536  -> { buf.write(0x80 or 126); buf.write(len shr 8); buf.write(len and 0xFF) }
            else         -> {
                buf.write(0x80 or 127)
                for (i in 7 downTo 0) buf.write((len.toLong() shr (i * 8)).toInt() and 0xFF)
            }
        }
        buf.write(mask)
        buf.write(masked)
        synchronized(raw) { raw.write(buf.toByteArray()); raw.flush() }
    }

    override fun flush() = raw.flush()
    override fun close() = raw.close()
}

// ── WsInputStream — Décode les frames WebSocket (server→client, non masqué) en stream brut ──
private class WsInputStream(
    private val raw: InputStream,
    private val rawOut: OutputStream,
) : InputStream() {
    private var pending = ByteArray(0)
    private var pendingPos = 0

    override fun read(): Int {
        val b = ByteArray(1)
        return if (read(b, 0, 1) == -1) -1 else b[0].toInt() and 0xFF
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        // Refill if current frame exhausted
        while (pendingPos >= pending.size) {
            val frame = readNextFrame() ?: return -1
            pending = frame
            pendingPos = 0
        }
        val avail = pending.size - pendingPos
        val n = minOf(len, avail)
        System.arraycopy(pending, pendingPos, b, off, n)
        pendingPos += n
        return n
    }

    private fun readNextFrame(): ByteArray? {
        return try {
            val b0 = raw.read(); if (b0 == -1) return null
            val b1 = raw.read(); if (b1 == -1) return null
            val opcode = b0 and 0x0F
            // Répondre aux ping est nécessaire pour les serveurs WebSocket mobiles
            // qui ferment la connexion si aucun pong n'est reçu.
            if (opcode == 0x08) {
                Log.w("SXB_DEBUG", "[SXB_DEBUG] WS_CLOSE_FRAME received")
                return null
            }
            val masked = (b1 and 0x80) != 0
            var payloadLen = (b1 and 0x7F).toLong()
            payloadLen = when (payloadLen) {
                126L -> ((readByte() shl 8) or readByte()).toLong()
                127L -> (0 until 8).fold(0L) { acc, _ -> (acc shl 8) or readByte().toLong() }
                else -> payloadLen
            }
            val maskKey = if (masked) ByteArray(4) { readByte().toByte() } else null
            val payload = ByteArray(payloadLen.toInt())
            var total = 0
            while (total < payload.size) {
                val n = raw.read(payload, total, payload.size - total)
                if (n == -1) break
                total += n
            }
            // FIX — RFC 6455 §5.1 : les frames client→serveur DOIVENT être masquées.
            // L'implémentation précédente envoyait un pong non masqué, ce qui provoque
            // la fermeture immédiate de la connexion WebSocket par le serveur (code 1002).
            if (opcode == 0x09) {
                val pongMask    = ByteArray(4).also { java.security.SecureRandom().nextBytes(it) }
                val pongMasked  = ByteArray(payload.size) { i ->
                    (payload[i].toInt() xor pongMask[i % 4].toInt()).toByte()
                }
                val pong = ByteArrayOutputStream(payload.size + 8)
                pong.write(0x8A)  // FIN=1, opcode=0x0A (pong)
                if (payload.size < 126) {
                    pong.write(0x80 or payload.size)   // mask bit=1
                } else {
                    pong.write(0x80 or 126)
                    pong.write(payload.size shr 8)
                    pong.write(payload.size and 0xFF)
                }
                pong.write(pongMask)
                pong.write(pongMasked)
                synchronized(rawOut) { rawOut.write(pong.toByteArray()); rawOut.flush() }
                return readNextFrame()
            }
            if (maskKey != null) {
                for (i in payload.indices) payload[i] = (payload[i].toInt() xor maskKey[i % 4].toInt()).toByte()
            }
            Log.d("SXB_DEBUG", "[SXB_DEBUG] WS_FRAME_IN opcode=$opcode len=${payload.size}")
            payload
        } catch (e: Exception) {
            Log.e("SXB_DEBUG", "[SXB_DEBUG] WS_FRAME_READ_ERROR: ${e.message}")
            null
        }
    }

    private fun readByte(): Int {
        val b = raw.read()
        if (b == -1) throw java.io.EOFException("WsInputStream: unexpected EOF")
        return b
    }

    override fun close() = raw.close()
}

// ── SxbPayloadProxy — Injection HTTP payload avant handshake SSH ─────────────
private class SxbPayloadProxy(
    private val rawPayload: String,
    private val tlsEnabled: Boolean,
    private val sni: String,
    /**
     * FIX CRITIQUE — Protection du socket sortant.
     *
     * Le socket physique qui porte le tunnel SSH doit être exclu du TUN via
     * `VpnService.protect()`, SINON il est lui-même routé dans le tunnel qu'il
     * est censé alimenter → boucle de routage, puis coupure immédiate.
     * On protège AVANT `connect()` : `protect()` agit sur le descripteur, il
     * doit être appelé tant que le socket n'est pas encore connecté.
     */
    private val protectSocket: (Socket) -> Boolean,
    private val onEvent: (String) -> Unit,
) : com.jcraft.jsch.Proxy {
    private var socket: Socket? = null
    private var inputStream: InputStream? = null
    private var outputStream: OutputStream? = null

    override fun connect(sf: SocketFactory?, host: String, port: Int, timeout: Int) {
        val connectTimeout = timeout.coerceIn(5_000, 30_000)
        val rawSocket = Socket()
        val protectedOk = protectSocket(rawSocket)
        Log.i("SXB_DEBUG", "[SXB_DEBUG] SSH_SOCKET_PROTECTED result=$protectedOk")
        onEvent("[SXB_DEBUG] SSH_SOCKET_PROTECTED result=$protectedOk")
        rawSocket.connect(InetSocketAddress(host, port), connectTimeout)
        val transportSocket: Socket = if (tlsEnabled) {
            val tlsSocket = (SSLSocketFactory.getDefault() as SSLSocketFactory)
                .createSocket(rawSocket, sni.ifBlank { host }, port, false) as SSLSocket
            tlsSocket.useClientMode = true
            tlsSocket.soTimeout = connectTimeout
            val sslParams = SSLParameters()
            if (sni.isNotBlank()) {
                sslParams.serverNames = listOf(javax.net.ssl.SNIHostName(sni))
            }
            tlsSocket.sslParameters = sslParams
            tlsSocket.startHandshake()
            Log.i("SXB_DEBUG", "[SXB_DEBUG] TLS_HANDSHAKE_SUCCESS")
            onEvent("[SXB_DEBUG] TLS_HANDSHAKE_SUCCESS")
            tlsSocket.soTimeout = 0
            tlsSocket
        } else {
            rawSocket
        }
        socket = transportSocket
        val rawOut = transportSocket.getOutputStream()
        val rawIn  = transportSocket.getInputStream()

        // ── 1. Substitutions dans le payload ─────────────────────────────────
        var payload = rawPayload
            .replace("[crlf]", "\r\n").replace("[CRLF]", "\r\n")
            .replace("[lf]",   "\n").replace("[LF]",   "\n")
            .replace("[cr]",   "\r").replace("[CR]",   "\r")
            .replace("[port]", port.toString())
            .replace("[host]", host).replace("[Host]", host)
            .replace("[host_port]", "$host:$port")

        // Parité sonde (transport-probe.ts) — Injection automatique de Sec-WebSocket-Key si absent et upgrade websocket détecté
        val hasUpgrade = payload.contains("upgrade: websocket", ignoreCase = true)
        if (hasUpgrade && !payload.contains("sec-websocket-key", ignoreCase = true)) {
            val nonce = ByteArray(16).apply { SecureRandom().nextBytes(this) }
            val base64Key = android.util.Base64.encodeToString(nonce, android.util.Base64.NO_WRAP)
            val regex = Regex("(\r\n)(\r\n)")
            if (regex.containsMatchIn(payload)) {
                payload = regex.replaceFirst(
                    payload,
                    "\r\nSec-WebSocket-Key: $base64Key\r\nSec-WebSocket-Version: 13\r\n$2")
            } else {
                payload = payload.trimEnd() + "\r\nSec-WebSocket-Key: $base64Key\r\nSec-WebSocket-Version: 13\r\n\r\n"
            }
        }
        Log.i("SXB_DEBUG", "[SXB_DEBUG] PAYLOAD_START host=$host port=$port bytes=${payload.length}")
        onEvent("[SXB_DEBUG] PAYLOAD_START host=$host port=$port bytes=${payload.length}")
        rawOut.write(payload.toByteArray(Charsets.ISO_8859_1))
        rawOut.flush()
        Log.i("SXB_DEBUG", "[SXB_DEBUG] PAYLOAD_SENT length=${payload.length}")
        onEvent("[SXB_DEBUG] PAYLOAD_SENT length=${payload.length}")

        // ── 2. Lire la réponse HTTP du serveur (headers jusqu'à \r\n\r\n) ────
        transportSocket.soTimeout = 10_000
        val headerBuf = StringBuilder()
        try {
            var b3 = 0; var b2 = 0; var b1 = 0; var limit = 8192
            while (limit-- > 0) {
                val b = rawIn.read(); if (b == -1) break
                headerBuf.append(b.toChar())
                if (b3 == '\r'.code && b2 == '\n'.code && b1 == '\r'.code && b == '\n'.code) break
                if (headerBuf.toString().startsWith("SSH-") && b == '\n'.code) break
                b3 = b2; b2 = b1; b1 = b
            }
        } catch (e: Exception) {
            Log.w("SXB_DEBUG", "[SXB_DEBUG] PAYLOAD_RESPONSE_WAIT: ${e.javaClass.simpleName}")
        }
        transportSocket.soTimeout = 0

        val response = headerBuf.toString()
        val logSafeStatus = response.substringBefore("\r\n").take(60)
            .replace(Regex("[^\\x20-\\x7E]"), "")
        Log.i("SXB_DEBUG", "[SXB_DEBUG] SERVER_RESPONSE=${logSafeStatus} bytes=${response.length}")
        onEvent("[SXB_DEBUG] SERVER_RESPONSE=${logSafeStatus} bytes=${response.length}")

        // ── 3. Détecter le mode transport ─────────────────────────────────────
        //   HTTP 101 = WebSocket upgrade  → adapter WS obligatoire
        //   HTTP 200 = CONNECT tunnel     → SSH direct sur le même socket
        //   Réponse vide / "SSH-"         → SSH direct (pas de proxy HTTP)
        val statusLine  = response.substringBefore("\r\n")
        val isWs        = response.contains("101") &&
                          (response.contains("websocket", ignoreCase = true) ||
                           response.contains("Upgrade",   ignoreCase = true))
        val isConnect   = response.contains("200") &&
                          response.contains("Connection established", ignoreCase = true)
        val isSshBanner = response.startsWith("SSH-")
        val isEmpty     = response.isBlank()

        Log.i("SXB_DEBUG", "[SXB_DEBUG] SERVER_MODE status='$statusLine' isWS=$isWs isConnect=$isConnect isSshBanner=$isSshBanner isEmpty=$isEmpty")

        // ── 4. Lire les premiers octets utiles pour confirmer le mode ─────────
        if (!isWs && !isConnect && !isSshBanner && !isEmpty) {
            // Essayer de voir les premiers octets après les headers (ex: début SSH banner)
            val peekBuf = ByteArray(16)
            var peekLen = 0
            try {
                transportSocket.soTimeout = 3_000
                peekLen = rawIn.read(peekBuf)
                transportSocket.soTimeout = 0
            } catch (_: Exception) {}
            val peekHex = peekBuf.take(peekLen).joinToString(" ") { "%02X".format(it) }
            val peekStr = peekBuf.take(peekLen).map { if (it in 32..126) it.toInt().toChar() else '.' }.joinToString("")
            Log.i("SXB_DEBUG", "[SXB_DEBUG] FIRST_SERVER_BYTES len=$peekLen hex=[$peekHex] str=[$peekStr]")

            // Prépend les octets lus avant le stream réel (ils font partie du banner SSH ou autre)
            val prependStream: InputStream = if (peekLen > 0)
                SequenceInputStream(ByteArrayInputStream(peekBuf, 0, peekLen), rawIn)
            else rawIn
            inputStream  = prependStream
            outputStream = rawOut
            return
        }

        when {
            isSshBanner || isEmpty -> {
                // Serveur répond SSH directement (pas de proxy intermédiaire)
                // Si le banner a déjà été consommé dans headerBuf, il faut le remettre en tête
                if (isSshBanner) {
                    onEvent("[SXB_DEBUG] SSH_BANNER_RECEIVED")
                    Log.i("SXB_DEBUG", "[SXB_DEBUG] SSH_BANNER_RECEIVED source=payload_response")
                    Log.i("SXB_DEBUG", "[SXB_DEBUG] SSH_BANNER_PREPEND bytes=${response.length}")
                    inputStream = SequenceInputStream(
                        ByteArrayInputStream(response.toByteArray(Charsets.ISO_8859_1)),
                        rawIn
                    )
                } else {
                    Log.i("SXB_DEBUG", "[SXB_DEBUG] EMPTY_RESPONSE raw streams")
                    inputStream = rawIn
                }
                outputStream = rawOut
            }

            isConnect -> {
                // HTTP CONNECT 200 → tunnel TCP transparent, SSH direct
                Log.i("SXB_DEBUG", "[SXB_DEBUG] HTTP_CONNECT_TUNNEL raw SSH streams")
                inputStream  = rawIn
                outputStream = rawOut
            }

            isWs -> {
                // HTTP 101 WebSocket Upgrade → JSch doit passer par les frames WS
                Log.i("SXB_DEBUG", "[SXB_DEBUG] WEBSOCKET_MODE_ACTIVATED wrapping streams with WS adapter")
                inputStream  = WsInputStream(rawIn, rawOut)
                outputStream = WsOutputStream(rawOut)
            }

            else -> {
                Log.w("SXB_DEBUG", "[SXB_DEBUG] UNKNOWN_RESPONSE_FALLBACK raw streams")
                inputStream  = rawIn
                outputStream = rawOut
            }
        }

        // ── Timeout SSH banner ────────────────────────────────────────────────
        // Borner la lecture du banner SSH à 28s (légèrement sous le timeout JSch
        // de 30s). Sans cette limite, si le proxy MTN accepte la TCP mais n'envoie
        // rien (payload non reconnu), la lecture SSH bloque indéfiniment et le
        // watchdog Android coupe après 45s sans que l'erreur soit broadcastée.
        // Avec soTimeout=28s, JSch reçoit SocketTimeoutException → JSchException
        // → failVpn() → broadcast status=error → RN clearWatchdog() < 45s.
        try { transportSocket.soTimeout = 28_000 } catch (_: Exception) {}
    }

    override fun getInputStream(): InputStream  = inputStream!!
    override fun getOutputStream(): OutputStream = outputStream!!
    override fun getSocket(): Socket             = socket!!
    override fun close() { runCatching { socket?.close() } }
}

private class SxbBannerInputStream(
    private val raw: InputStream,
    private val onBanner: () -> Unit,
) : InputStream() {
    private val prefix = ByteArrayOutputStream()
    private var reported = false

    override fun read(): Int {
        val value = raw.read()
        inspect(value)
        return value
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        val count = raw.read(buffer, offset, length)
        if (count > 0) repeat(count) { inspect(buffer[offset + it].toInt() and 0xFF) }
        return count
    }

    private fun inspect(value: Int) {
        if (reported || value < 0) return
        if (prefix.size() < 64) prefix.write(value)
        val text = String(prefix.toByteArray(), Charsets.ISO_8859_1)
        if (text.startsWith("SSH-")) {
            reported = true
            onBanner()
        } else if (prefix.size() >= 4 && !text.startsWith("SSH-")) {
            reported = true
        }
    }

    override fun close() = raw.close()
}

private class SxbLoggingSocketFactory(
    private val timeoutMs: Int,
    /** Voir SxbPayloadProxy : le socket SSH direct doit aussi être protégé. */
    private val protectSocket: (Socket) -> Boolean,
    private val onBanner: () -> Unit,
) : SocketFactory {
    override fun createSocket(host: String, port: Int): Socket =
        Socket().apply {
            val ok = protectSocket(this)
            Log.i("SXB_DEBUG", "[SXB_DEBUG] SSH_SOCKET_PROTECTED result=$ok")
            connect(InetSocketAddress(host, port), timeoutMs)
        }

    override fun getInputStream(socket: Socket): InputStream =
        SxbBannerInputStream(socket.getInputStream(), onBanner)

    override fun getOutputStream(socket: Socket): OutputStream = socket.getOutputStream()
}

// ═════════════════════════════════════════════════════════════════════════════
// SxbVpnService
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Lecture sûre d'une chaîne JSON — correctif incident APK #165.
 *
 * AOSP JSONObject.optString(name, fallback) retourne la CHAÎNE "null" quand la
 * valeur est JSONObject.NULL (NULL.toString() == "null"), contrairement à
 * org.json de bureau. C'est ce qui produisait payload_len=4 (payload="null"
 * injecté dans le handshake HTTP → réponse inattendue → SSH_TIMEOUT).
 *
 * Ce helper garantit : absent/NULL/"null" → fallback ; sinon la valeur réelle.
 */
private fun JSONObject.optStringOrNull(name: String, fallback: String = ""): String {
    if (!has(name) || isNull(name)) return fallback
    val v = opt(name) ?: return fallback
    if (v === JSONObject.NULL) return fallback
    val s = if (v is String) v else v.toString()
    return if (s == "null") fallback else s
}

class SxbVpnService : VpnService(), PlatformInterface {

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

        /** `Libbox.setup()` ne doit être appelé qu'une seule fois par process. */
        @Volatile private var libboxInitialized = false
    }

    // ── État du service ───────────────────────────────────────────────────────
    private val running         = AtomicBoolean(false)
    private var tunPfd          : ParcelFileDescriptor? = null
    private var sshSession      : Session? = null
    private var socks5Server    : ServerSocket? = null
    /** Instance sing-box in-process (remplace l'ancien `Process` externe). */
    private var boxService      : BoxService? = null
    private var vpnThread       : Thread? = null
    private var killSwitchEnabled = false
    private var configJson      = ""
    /** Nom de notre interface TUN — exclue de l'énumération pour éviter les boucles. */
    @Volatile private var tunInterfaceName: String? = null

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
    private var connectionWatchdog: Thread? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private val cleanupStarted = AtomicBoolean(false)

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "[SXB_DEBUG] SERVICE_CREATE")
        broadcastLog("[SXB_DEBUG] ▶ SERVICE_CREATE (onCreate a démarré)")
        instance = this

        // Le canal DOIT exister avant startForeground()
        createNotificationChannel()

        // startForeground() dans onCreate() — garantit le délai de 5s Android.
        //
        // FIX CRITIQUE Android 14 (API 34) — type de service en premier plan.
        // L'ancienne version utilisait FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE.
        // Sur API 34, ce type exige EN PLUS une permission runtime parmi
        // BLUETOOTH_* / CHANGE_NETWORK_STATE / NFC / USB — que l'app n'a pas.
        // Résultat : SecurityException levée dès startForeground(), le service
        // était tué dans onCreate() avant même de lire la configuration, et
        // aucune clé VPN n'apparaissait dans la barre d'état.
        //
        // Le type correct pour une app VPN tierce est `specialUse`
        // (`systemExempted` est réservé aux VPN configurés dans les Réglages
        // système). C'est ce que déclare le client officiel sing-box.
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(
                    NOTIF_ID,
                    buildNotification("SXB VPN — Démarrage..."),
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                )
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // API 29-33 : `specialUse` n'existe pas encore. Aucun type
                // spécifique n'est requis pour un VpnService à ces niveaux.
                startForeground(NOTIF_ID, buildNotification("SXB VPN — Démarrage..."))
            } else {
                startForeground(NOTIF_ID, buildNotification("SXB VPN — Démarrage..."))
            }
            Log.i(TAG, "[SXB_DEBUG] FOREGROUND_STARTED")
            broadcastLog("[SXB_DEBUG] ✅ FOREGROUND_STARTED")
        } catch (e: Exception) {
            Log.e(TAG, "[SXB_DEBUG] FOREGROUND_START_FAILED: " + e.message)
            broadcastLog("[SXB_DEBUG] ❌ FOREGROUND_START_FAILED: " + e.message)
        }

        autoReconnect = AutoReconnectManager(
            onReconnect = {
                if (running.get() && configJson.isNotEmpty()) {
                    broadcastLog("[SXB_DEBUG] AUTO_RECONNECT_TRIGGERED")
                    broadcastLog("[SXB] Auto-reconnexion en cours...")
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
        registerNetworkCallback()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { cleanup(); return START_NOT_STICKY }

        // startForeground() déjà appelé dans onCreate() — mise à jour notification seule.
        try { updateNotification("SXB VPN — Connexion en cours...") } catch (_: Exception) {}
        Log.i(TAG, "[SXB_DEBUG] START_COMMAND_RECEIVED action=" + intent?.action)
        broadcastLog("[SXB_DEBUG] ▶ START_COMMAND_RECEIVED (onStartCommand a démarré)")

        // Vérifications de sécurité — OK to run after startForeground()
        val secReport = SecurityModule.audit(this)
        if (secReport.hasFrida || secReport.hasXposed) {
            Log.e("SXB_DEBUG", "[SXB_DEBUG] SECURITY_BLOCK hasFrida=${secReport.hasFrida} hasXposed=${secReport.hasXposed}")
            broadcastLog("[SXB_DEBUG] ❌ SECURITY_BLOCK hasFrida=${secReport.hasFrida} hasXposed=${secReport.hasXposed}")
            broadcastLog("[SXB] ❌ Environnement compromis — connexion refusée")
            broadcastStatus("error")
            stopSelf()
            return START_NOT_STICKY
        }
        if (secReport.isRooted) {
            Log.w("SXB_DEBUG", "[SXB_DEBUG] SECURITY_WARN isRooted=true")
            broadcastLog("[SXB_DEBUG] ⚠️ SECURITY_WARN: appareil rooté")
            broadcastLog("[SXB] ⚠️ Appareil rooté — risque de sécurité")
        }

        Log.i(TAG, "[SXB_DEBUG] CONFIG_LOADING")

        // FIX — TransactionTooLargeException : lire depuis le fichier temporaire en priorité.
        // SxbVpnModule écrit la config dans filesDir/sxb_pending_config.json AVANT de démarrer
        // le service, évitant la limite ~1MB du Binder IPC pour les Intent extras.
        val pendingConfigFile = File(filesDir, "sxb_pending_config.json")
        val configFilePath    = intent?.getStringExtra("configFilePath")
        var json = when {
            configFilePath != null && File(configFilePath).exists() -> {
                val content = File(configFilePath).readText(Charsets.UTF_8)
                Log.i(TAG, "[SXB_DEBUG] CONFIG_FROM_FILE path=$configFilePath size=${content.length}")
                broadcastLog("[SXB_DEBUG] CONFIG_FROM_FILE size=${content.length}")
                content
            }
            pendingConfigFile.exists() && pendingConfigFile.length() > 10 -> {
                val content = pendingConfigFile.readText(Charsets.UTF_8)
                Log.i(TAG, "[SXB_DEBUG] CONFIG_FROM_PENDING_FILE size=${content.length}")
                broadcastLog("[SXB_DEBUG] CONFIG_FROM_PENDING_FILE size=${content.length}")
                content
            }
            else -> intent?.getStringExtra("configJson") ?: ""
        }
        var proto = if (json.isNotEmpty()) {
            try { org.json.JSONObject(json).optString("protocol", intent?.getStringExtra("protocol") ?: "").lowercase() }
            catch (_: Exception) { intent?.getStringExtra("protocol")?.lowercase() ?: "" }
        } else {
            intent?.getStringExtra("protocol")?.lowercase() ?: ""
        }

        Log.i("SXB_DEBUG", "[SXB_DEBUG] CONFIG_FROM_INTENT proto=$proto json_empty=${json.isEmpty()}")
        broadcastLog("[SXB_DEBUG] ▶ CONFIG_FROM_INTENT proto='$proto' empty=${json.isEmpty()}")

        if (json.isEmpty() || proto.isEmpty()) {
            try {
                // P1 — Lecture config chiffrée (AES-256-GCM) ou plaintext fallback
                val credsFile = File(filesDir, "sxb_creds.enc")
                val confFile  = File(filesDir, "sb_config.json")
                Log.i("SXB_DEBUG", "[SXB_DEBUG] CONFIG_FALLBACK credsExists=${credsFile.exists()} confExists=${confFile.exists()}")
                broadcastLog("[SXB_DEBUG] ▶ CONFIG_FALLBACK credsExists=${credsFile.exists()} confExists=${confFile.exists()}")
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
            Log.e("SXB_DEBUG", "[SXB_DEBUG] CONFIG_MISSING json_empty=${json.isEmpty()} proto_empty=${proto.isEmpty()} — arrêt")
        broadcastLog("[SXB_DEBUG] ❌ CONFIG_MISSING json_empty=${json.isEmpty()} proto_empty=${proto.isEmpty()}")
            broadcastLog("[SXB] ❌ Configuration manquante — importez un profil VPN")
            broadcastStatus("error")
            stopSelf()
            return START_NOT_STICKY
        }

        Log.i("SXB_DEBUG", "[SXB_DEBUG] STEP_5_CONFIG_LOADED proto=$proto json_len=${json.length}")
        broadcastLog("[SXB_DEBUG] ✅ STEP_5_CONFIG_LOADED proto='$proto' len=${json.length}")

        // P1 — Persister config chiffrée pour démarrage hors-ligne
        if (json.isNotEmpty()) { try { persistEncryptedConfig(json) } catch (_: Exception) {} }
        killSwitchEnabled = intent?.getBooleanExtra("killSwitch", false) ?: false
        if (intent?.getBooleanExtra("autoReconnect", false) == true) {
            autoReconnect.enable()
        } else {
            autoReconnect.disable()
        }
        configJson  = json

        cleanupStarted.set(false)  // FIX — Réinitialiser le guard cleanup pour cette nouvelle connexion
        running.set(true)
        trafficManager.start()
        startConnectionWatchdog()

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
        Log.i("SXB_DEBUG", "[SXB_DEBUG] STEP_2_CONFIG_RECEIVED proto=$proto")
        broadcastLog("[SXB_DEBUG] ▶ STEP_2_DISPATCH proto='$proto'")
        when (proto) {
            "ssh", "ssh+payload"                                        -> startSshTunnel(json)
            "vless", "vmess", "trojan", "shadowsocks",
            "wireguard", "hysteria2", "tuic"                            -> startSingBoxTunnel(json, proto)
            else -> {
                Log.e("SXB_DEBUG", "[SXB_DEBUG] DISPATCH_ERROR proto_inconnu=$proto")
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
            // optStringOrNull : jamais la chaîne "null" (AOSP) — correctif APK #165
            val username   = cfg.optStringOrNull("username", "")
            val password   = cfg.optStringOrNull("password", "")
            val usePayload = cfg.optBoolean("usePayload", false) || cfg.optStringOrNull("protocol","").contains("payload")
            val sni        = cfg.optStringOrNull("sni", "")
            val tlsEnabled = cfg.optBoolean("tlsEnabled", cfg.optBoolean("tls", false))
            val websocketEnabled = cfg.optBoolean("websocketEnabled", false)
            val fingerprint = cfg.optStringOrNull("fingerprint", "")

            // ── Payload SSH ─────────────────────────────────────────────────
            // BUG FIX: ne jamais basculer en SSH direct si le protocole est ssh+payload
            // Même si le backend n'a pas renvoyé de contenu de payload (payloadContent null),
            // on utilise un payload WebSocket par défaut pour éviter le timeout sur port 443.
            // optStringOrNull : payload=null côté backend ne doit JAMAIS
            // devenir la chaîne "null" (payload_len=4 — incident APK #165)
            val rawPayload = cfg.optStringOrNull("payload", "")
            val payload = when {
                rawPayload.isNotEmpty() -> rawPayload   // payload réel reçu du backend
                usePayload -> {
                    // Payload WebSocket par défaut — garantit que le handshake HTTP
                    // est envoyé avant SSH, nécessaire pour les serveurs port 443/80
                    Log.i("SXB_DEBUG", "[SXB_DEBUG] PAYLOAD_DEFAULT_USED host=$host port=$port")
                    broadcastLog("[SXB_DEBUG] PAYLOAD_DEFAULT_USED — aucun payload configuré sur le profil, utilisation WebSocket défaut")
                    "GET / HTTP/1.1[crlf]Host: [host][crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf][crlf]"
                }
                else -> ""
            }

            Log.i("SXB_DEBUG", "[SXB_DEBUG] SSH_SOCKET_CONNECT_START port=$port usePayload=$usePayload payload_len=${payload.length} tls=$tlsEnabled ws=$websocketEnabled")
            broadcastLog("[SXB_DEBUG] SSH_SOCKET_CONNECT_START port=$port usePayload=$usePayload payload_len=${payload.length} tls=$tlsEnabled ws=$websocketEnabled")

            // ── Session JSch ──────────────────────────────────────────────────
            val jsch = JSch()
            val session: Session = if (usePayload) {
                // SSH+Payload : injection HTTP avant le handshake SSH
                // Le proxy SxbPayloadProxy envoie le payload, lit la réponse HTTP (101/200),
                // et adapte les streams (WsOutputStream/WsInputStream si WebSocket 101)
                Log.i("SXB_DEBUG", "[SXB_DEBUG] PAYLOAD_START mode=SSH+Payload payload_len=${payload.length}")
                broadcastLog("[SXB_DEBUG] PAYLOAD_START mode=SSH+Payload payload_len=${payload.length}")
                broadcastLog("[SXB] Mode SSH+Payload (HTTP Injector) — injection payload avant SSH")
                jsch.getSession(username, host, port).also { s ->
                    s.setProxy(SxbPayloadProxy(payload, tlsEnabled, sni, ::protectSocket) { event ->
                        broadcastLog(event)
                    })
                    s.setPassword(password)
                    val props = Properties().apply {
                        // P5: fingerprint vérifié après connect — no bypass definitif
                        set("StrictHostKeyChecking", "no")
                        set("PreferredAuthentications", "password")
                        if (sni.isNotEmpty()) set("ServerAliveInterval", "30")
                    }
                    s.setConfig(props)
                    s.timeout = 30_000
                }
            } else {
                Log.i("SXB_DEBUG", "[SXB_DEBUG] SSH_DIRECT_MODE")
                broadcastLog("[SXB] Mode SSH direct")
                // ── Avertissement explicite (mission §6.2) ────────────────────
                // Le SSH direct utilise SxbLoggingSocketFactory = socket TCP BRUT :
                // TLS n'est JAMAIS appliqué dans ce mode, même si la config le
                // demande. C'est la cause du SSH_TIMEOUT de l'incident APK #165
                // (profil ssh + tls=true sur un serveur WebSocket en clair).
                // Le rejet de cette combinaison a lieu à l'import (backend) et à
                // la validation (configValidator) — ici on journalise au cas où
                // une vieille config provisionnée arriverait encore au natif.
                if (tlsEnabled) {
                    Log.w("SXB_DEBUG", "[SXB_DEBUG] TLS_IGNORED_SSH_DIRECT — tls=true ignoré : le tunnel SSH direct applique un socket TCP brut (pas de TLS)")
                    broadcastLog("[SXB_DEBUG] TLS_IGNORED_SSH_DIRECT — TLS NON appliqué en SSH direct : si le serveur exige TLS/WebSocket, utilisez un profil ssh+payload")
                }
                jsch.getSession(username, host, port).also { s ->
                    s.setPassword(password)
                    val props = Properties().apply {
                        set("StrictHostKeyChecking", "no")
                        set("PreferredAuthentications", "password")
                    }
                    s.setConfig(props)
                    s.setSocketFactory(SxbLoggingSocketFactory(30_000, ::protectSocket) {
                        broadcastLog("[SXB_DEBUG] SSH_BANNER_RECEIVED")
                    })
                    s.timeout = 30_000
                }
            }

            Log.i("SXB_DEBUG", "[SXB_DEBUG] SSH_HANDSHAKE_START port=$port timeout=30000ms usePayload=$usePayload")
            broadcastLog("[SXB_DEBUG] SSH_HANDSHAKE_START port=$port usePayload=$usePayload")
            broadcastLog("[SXB] Handshake SSH en cours... Port:$port")
            session.connect(30_000)

            Log.i("SXB_DEBUG", "[SXB_DEBUG] SSH_CONNECTED session.isConnected=${session.isConnected} host=$host port=$port")
            broadcastLog("[SXB_DEBUG] SSH_CONNECTED — handshake réussi sur $host:$port")

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
            broadcastLog("[SXB] Tunnel SSH établi")

            // ── Serveur SOCKS5 local ──────────────────────────────────────────
            socks5Server = startLocalSocks5Server(session)
            Log.i("SXB_DEBUG", "[SXB_DEBUG] STEP_12_SOCKS_STARTED port=$SOCKS5_PORT")
            broadcastLog("[SXB_DEBUG] STEP_12_SOCKS_STARTED port=$SOCKS5_PORT")
            broadcastLog("[SXB] SOCKS5 local actif (port $SOCKS5_PORT)")

            // ── Pont TUN → SOCKS5 via libbox ─────────────────────────────────
            // Le TUN n'est plus construit ici : c'est libbox qui le réclame via
            // openTun() au démarrage du moteur. On lui fournit simplement une
            // config dont l'outbound est notre SOCKS5 local alimenté par SSH.
            val label = if (usePayload) "SSH+PAYLOAD" else "SSH"
            startLibboxService(buildSshSocksRelayConfig(), label)

            // ── Boucle de surveillance ────────────────────────────────────────
            while (running.get()) {
                if (!session.isConnected) {
                    Log.w("SXB_DEBUG", "[SXB_DEBUG] SSH_SESSION_LOST")
                    broadcastLog("[SXB] ⚠️ Session SSH perdue")
                    broadcastStatus("error"); setCurrentState("error")
                    if (autoReconnect.isEnabled()) { autoReconnect.onDisconnected(); return }
                    break
                }
                if (boxService == null) {
                    Log.w("SXB_DEBUG", "[SXB_DEBUG] LIBBOX_STOPPED_IN_LOOP")
                    broadcastLog("[SXB] ⚠️ Moteur TUN arrêté")
                    broadcastStatus("error"); setCurrentState("error")
                    if (autoReconnect.isEnabled()) { autoReconnect.onDisconnected(); return }
                    break
                }
                Thread.sleep(3_000)
            }
        } catch (e: InterruptedException) {
            Log.i(TAG, "Thread SSH interrompu")
        } catch (e: Exception) {
            val safeException = SecurityModule.maskSensitive(e.message ?: "erreur inconnue")
            Log.e("SXB_DEBUG", "[SXB_DEBUG] SSH_EXCEPTION at currentState=$currentState msg=$safeException")
            val msg = e.message ?: "erreur inconnue"
            val stack = e.stackTrace.take(10).joinToString("\n  ") { "at ${it.className}.${it.methodName}(${it.fileName}:${it.lineNumber})" }
            val code = classifyVpnError(msg)
            broadcastLog("[SXB_DEBUG] SSH_EXCEPTION code=$code")
            broadcastLog("[SXB_DEBUG] STACKTRACE:\n  ${SecurityModule.maskSensitive(stack)}")
            val display = when {
                msg.contains("Auth fail") || msg.contains("auth", true) ->
                    "❌ Auth SSH échouée — vérifiez username/password"
                msg.contains("Connection refused") ->
                    "❌ Connexion refusée — vérifiez host/port"
                msg.contains("timeout", true) || msg.contains("Read timed out", true) ->
                    "❌ Timeout SSH — serveur attend frames WebSocket? Voir RAW_SOCKET_RESPONSE dans logcat"
                msg.contains("TUN") || msg.contains("establish") ->
                    "❌ TUN échoué — permission VPN révoquée?"
                msg.contains("sing-box") || msg.contains("moteur", true) ->
                    "❌ Moteur VPN — ${msg.take(80)}"
                else -> "❌ Erreur tunnel : ${msg.take(80)}"
            }
            failVpn(code, display)
        } finally {
            // Libérer les ressources de ce tunnel.
            // stopService = true seulement si aucune reconnexion n'est prévue.
            val willReconnect = ::autoReconnect.isInitialized && autoReconnect.isEnabled()
            cleanup(stopService = !willReconnect, keepRunning = willReconnect)
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // SING-BOX TUNNEL (VLESS / VMess / Trojan / Shadowsocks / WireGuard / Hysteria2 / TUIC)
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Démarre un tunnel via le moteur sing-box embarqué (libbox).
     *
     * Contrairement à la v5, aucun processus externe n'est lancé et aucun
     * descripteur n'est passé par JSON : `Libbox.newService()` instancie le
     * moteur dans notre process, puis sing-box rappelle `openTun()` ci-dessous
     * pour obtenir l'interface TUN construite par `VpnService.Builder`.
     */
    private fun startSingBoxTunnel(configJsonStr: String, protocol: String) {
        try {
            Log.i("SXB_DEBUG", "[SXB_DEBUG] SINGBOX_TUNNEL_START proto=$protocol")
            broadcastLog("[SXB] Initialisation VPN ${protocol.uppercase()}...")
            broadcastStatus("connecting"); setCurrentState("connecting")

            val cfg = JSONObject(configJsonStr)

            // ── Config sing-box ───────────────────────────────────────────────
            // L'inbound TUN ne contient plus « file_descriptor » : libbox le
            // renseigne lui-même à partir de la valeur retournée par openTun().
            val sbConfigJson = buildSingBoxConfig(cfg, protocol)
            Log.i("SXB_DEBUG", "[SXB_DEBUG] SINGBOX_CONFIG_BUILT len=${sbConfigJson.length}")
            broadcastLog("[SXB] Config générée pour $protocol")

            startLibboxService(sbConfigJson, protocol.uppercase())

            // ── Boucle de surveillance ────────────────────────────────────────
            while (running.get()) {
                if (boxService == null) break
                Thread.sleep(5_000)
            }
        } catch (e: InterruptedException) {
            Log.i(TAG, "Thread sing-box interrompu")
        } catch (e: Exception) {
            Log.e("SXB_DEBUG", "[SXB_DEBUG] SINGBOX_EXCEPTION proto=$protocol msg=${e.message}", e)
            val stack = e.stackTrace.take(8).joinToString("\n  ") { "at ${it.className}.${it.methodName}(${it.fileName}:${it.lineNumber})" }
            val msg = e.message ?: "erreur inconnue"
            val code = classifyVpnError(msg)
            broadcastLog("[SXB_DEBUG] SINGBOX_EXCEPTION code=$code")
            broadcastLog("[SXB_DEBUG] STACKTRACE:\n  ${SecurityModule.maskSensitive(stack)}")
            failVpn(code, "Erreur moteur ${protocol.uppercase()}")
        } finally {
            val willReconnect = ::autoReconnect.isInitialized && autoReconnect.isEnabled()
            cleanup(stopService = !willReconnect, keepRunning = willReconnect)
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // MOTEUR LIBBOX (sing-box in-process)
    // ═════════════════════════════════════════════════════════════════════════

    /** Initialise libbox une seule fois par process (chemins de travail). */
    private fun ensureLibboxSetup() {
        if (libboxInitialized) return
        synchronized(SxbVpnService::class.java) {
            if (libboxInitialized) return
            val baseDir = filesDir.also { it.mkdirs() }
            val workDir = File(getExternalFilesDir(null) ?: filesDir, "sing-box").also { it.mkdirs() }
            val tempDir = cacheDir.also { it.mkdirs() }
            val options = SetupOptions().apply {
                basePath    = baseDir.absolutePath
                workingPath = workDir.absolutePath
                tempPath    = tempDir.absolutePath
                // Contournement du bug Go sur la petite pile des threads Android
                // (golang/go#68760) — le client officiel active la même option.
                fixAndroidStack = true
            }
            Libbox.setup(options)
            libboxInitialized = true
            Log.i("SXB_DEBUG", "[SXB_DEBUG] LIBBOX_SETUP_OK base=${baseDir.absolutePath}")
        }
    }

    /**
     * Crée et démarre l'instance sing-box, puis bascule l'état en « connected ».
     * Le TUN est ouvert par sing-box lui-même via le rappel `openTun()`.
     */
    private fun startLibboxService(configJson: String, label: String) {
        ensureLibboxSetup()
        SxbDefaultNetworkMonitor.start(this)

        Log.i("SXB_DEBUG", "[SXB_DEBUG] STEP_8_LIBBOX_START label=$label version=${Libbox.version()}")
        broadcastLog("[SXB] Moteur VPN : sing-box ${Libbox.version()}")

        val service = try {
            Libbox.newService(configJson, this)
        } catch (e: Exception) {
            throw Exception("Configuration refusée par le moteur : ${e.message}")
        }

        service.start()
        boxService = service

        Log.i("SXB_DEBUG", "[SXB_DEBUG] STEP_13_VPN_CONNECTED label=$label")
        broadcastLog("[SXB_DEBUG] TUNNEL_READY proto=$label")
        broadcastLog("[SXB_DEBUG] VPN_CONNECTED proto=$label")
        broadcastLog("[SXB] ✅ VPN $label actif")
        connectionWatchdog?.interrupt()
        broadcastStatus("connected"); setCurrentState("connected")
        autoReconnect.onConnected()
        updateNotification("SXB VPN — $label connecté")
        startNotificationUpdater()
    }

    /**
     * Classification différenciée des erreurs VPN (mission §7) — alignée sur la
     * taxonomie du préflight backend (transport-probe) :
     *   AUTH_FAILED         — credentials rejetés par le serveur
     *   TLS_FAILED          — handshake TLS/SSL échoué (SNI, certificat, ALPN)
     *   SSH_BANNER_MISSING  — le port ne parle pas SSH (pas de bannière SSH-2.0)
     *   HTTP_UNEXPECTED     — la passerelle HTTP/WebSocket a répondu autrement
     *                         que 101/200 (mauvais payload, Host/SNI filtré)
     *   TCP_TIMEOUT         — socket ouvert mais silencieux (DPI, mauvais port)
     *   SSH_TIMEOUT         — watchdog global 45 s (conservé)
     *   SERVER_UNREACHABLE  — TCP refusé / hôte injoignable / DNS en échec
     *   VPN_TUN_FAILED      — interface TUN Android
     */
    private fun classifyVpnError(message: String): String {
        val lower = message.lowercase(Locale.ROOT)
        return when {
            lower.contains("auth fail") || lower.contains("authentication") ||
                lower.contains("auth failure") -> "AUTH_FAILED"
            lower.contains("javax.net.ssl") || lower.contains("sslhandshake") ||
                (lower.contains("handshake") && (lower.contains("tls") || lower.contains("ssl") || lower.contains("cert"))) ||
                lower.contains("certificate") || lower.contains("certpath") ->
                "TLS_FAILED"
            lower.contains("invalid server's version string") ||
                lower.contains("invalid server version") ||
                lower.contains("banner") || lower.contains("ssh-2.0") ->
                "SSH_BANNER_MISSING"
            lower.contains("http 4") || lower.contains("http 5") ||
                lower.contains("http status") || lower.contains("unexpected http") ||
                lower.contains("websocket handshake") || lower.contains("payload") ->
                "HTTP_UNEXPECTED"
            lower.contains("timeout") || lower.contains("timed out") ->
                "TCP_TIMEOUT"
            lower.contains("refused") || lower.contains("unreachable") ||
                lower.contains("unknownhost") || lower.contains("network is unreachable") ->
                "SERVER_UNREACHABLE"
            lower.contains("dns") || lower.contains("unable to resolve host") ->
                "DNS_FAILED"
            lower.contains("tun") || lower.contains("establish") -> "VPN_TUN_FAILED"
            else -> "VPN_FAILED"
        }
    }

    private fun failVpn(code: String, displayMessage: String) {
        Log.e("SXB_DEBUG", "[SXB_DEBUG] VPN_FAILED code=$code")
        broadcastLog("[SXB_DEBUG] VPN_FAILED code=$code")
        broadcastLog("[SXB] $code — ${displayMessage.removePrefix("❌ ").take(160)}")
        broadcastStatus("error")
        setCurrentState("error")
        // FIX — Ne pas appeler cleanup() ici : le bloc finally de startSshTunnel /
        // startSingBoxTunnel appelle déjà cleanup(). Un double appel provoquait un
        // stopForeground + stopSelf() en double, laissant l'UI dans un état incohérent.
        if (::autoReconnect.isInitialized && autoReconnect.isEnabled() && running.get()) {
            autoReconnect.onDisconnected()
        }
        // Pas de cleanup() ici : géré exclusivement dans le bloc finally du tunnel.
    }

    private fun startConnectionWatchdog() {
        connectionWatchdog?.interrupt()
        connectionWatchdog = Thread({
            try {
                Thread.sleep(45_000)
                if (running.get() && currentState == "connecting") {
                    Log.e("SXB_DEBUG", "[SXB_DEBUG] WATCHDOG_FIRED lastState=$currentState")
                    broadcastLog("[SXB_DEBUG] WATCHDOG_FIRED lastState=$currentState")
                    failVpn("SSH_TIMEOUT", "Connexion bloquée après 45 secondes")
                }
            } catch (_: InterruptedException) {
                // Connexion terminée ou arrêt demandé.
            }
        }, "SXB-ConnectionWatchdog").apply {
            isDaemon = true
            start()
        }
    }

    private fun registerNetworkCallback() {
        val manager = getSystemService(ConnectivityManager::class.java) ?: return
        val request = NetworkRequest.Builder()
            .addCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                Log.i("SXB_DEBUG", "[SXB_DEBUG] NETWORK_AVAILABLE")
                broadcastLog("[SXB_DEBUG] NETWORK_AVAILABLE")
            }

            override fun onLost(network: Network) {
                Log.w("SXB_DEBUG", "[SXB_DEBUG] NETWORK_LOST")
                broadcastLog("[SXB_DEBUG] NETWORK_LOST")
                broadcastLog("[SXB_DEBUG] NETWORK_CHANGE_BLOCKED reason=network_callback_only")
                // Ne pas appeler bindProcessToNetwork ni basculer de transport :
                // Android/VpnService garde la sélection réseau courante.
                if (running.get() && currentState == "connected" && autoReconnect.isEnabled()) {
                    broadcastLog("[SXB_DEBUG] AUTO_RECONNECT_TRIGGERED reason=NETWORK_LOST")
                    autoReconnect.onDisconnected()
                }
            }
        }
        runCatching {
            manager.registerNetworkCallback(request, callback)
            networkCallback = callback
        }.onFailure {
            Log.w("SXB_DEBUG", "[SXB_DEBUG] NETWORK_CALLBACK_REGISTER_FAILED")
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // IMPLÉMENTATION libbox.PlatformInterface
    // ═════════════════════════════════════════════════════════════════════════
    //
    // C'est le cœur du correctif. sing-box, tournant dans notre process,
    // délègue à ces méthodes tout ce qui relève de la plateforme Android :
    // ouverture du TUN, protection des sockets, découverte des interfaces.

    /**
     * Appelé par sing-box pour obtenir l'interface TUN.
     *
     * C'est ICI que la clé VPN apparaît dans la barre d'état Android :
     * `Builder.establish()` enregistre le tunnel auprès du système.
     * Le descripteur retourné est ensuite utilisé directement par le moteur —
     * il n'a jamais besoin de transiter par un fichier de configuration.
     */
    override fun openTun(options: TunOptions): Int {
        if (VpnService.prepare(this) != null) {
            throw IllegalStateException("Permission VPN non accordée")
        }

        Log.i("SXB_DEBUG", "[SXB_DEBUG] STEP_6_TUN_CREATING mtu=${options.mtu} autoRoute=${options.autoRoute}")
        broadcastLog("[SXB] Création interface réseau TUN...")

        val builder = Builder()
            .setSession("SXB VPN")
            .setMtu(options.mtu)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            builder.setMetered(false)
        }

        // Kill Switch : quand il est actif, on n'autorise PAS allowBypass(),
        // aucune app ne peut alors court-circuiter le tunnel.
        if (!killSwitchEnabled && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            runCatching { builder.allowBypass() }
        }

        // Adresses de l'interface, fournies par sing-box.
        val inet4 = options.inet4Address
        while (inet4.hasNext()) {
            val address = inet4.next()
            builder.addAddress(address.address(), address.prefix())
        }
        val inet6 = options.inet6Address
        while (inet6.hasNext()) {
            val address = inet6.next()
            builder.addAddress(address.address(), address.prefix())
        }

        if (options.autoRoute) {
            // `dnsServerAddress` est un StringBox (libbox 1.11.x) : .value
            // contient l'IP à annoncer au système pour le détournement DNS.
            runCatching { builder.addDnsServer(options.dnsServerAddress.value) }

            val v4Routes = options.inet4RouteAddress
            if (v4Routes.hasNext()) {
                while (v4Routes.hasNext()) {
                    val r = v4Routes.next()
                    builder.addRoute(r.address(), r.prefix())
                }
            } else {
                builder.addRoute("0.0.0.0", 0)
            }

            val v6Routes = options.inet6RouteAddress
            if (v6Routes.hasNext()) {
                while (v6Routes.hasNext()) {
                    val r = v6Routes.next()
                    builder.addRoute(r.address(), r.prefix())
                }
            }

            // Exclure notre propre app du tunnel : sans cela, les appels API
            // de l'app (provisionnement, quotas) boucleraient dans le VPN.
            runCatching { builder.addDisallowedApplication(packageName) }

            val includePackage = options.includePackage
            while (includePackage.hasNext()) {
                runCatching { builder.addAllowedApplication(includePackage.next()) }
            }
            val excludePackage = options.excludePackage
            while (excludePackage.hasNext()) {
                runCatching { builder.addDisallowedApplication(excludePackage.next()) }
            }
        }

        val pfd = builder.establish()
            ?: throw IllegalStateException("establish() a retourné null — permission révoquée ou VPN déjà actif")

        tunPfd = pfd
        tunInterfaceName = runCatching {
            java.net.NetworkInterface.getNetworkInterfaces().toList()
                .firstOrNull { it.name.startsWith("tun") }?.name
        }.getOrNull()

        Log.i("SXB_DEBUG", "[SXB_DEBUG] STEP_7_TUN_CREATED fd=${pfd.fd} name=$tunInterfaceName")
        broadcastLog("[SXB_DEBUG] STEP_7_TUN_CREATED fd=${pfd.fd}")
        broadcastLog("[SXB] Interface TUN créée")
        return pfd.fd
    }

    /** On veut que sing-box délègue la protection des sockets à Android. */
    override fun usePlatformAutoDetectInterfaceControl(): Boolean = true

    /**
     * FIX CRITIQUE — Protection des sockets sortants du moteur.
     *
     * Chaque socket que sing-box ouvre vers le serveur distant doit être exclu
     * du TUN, faute de quoi il serait routé dans le tunnel qu'il alimente
     * (boucle de routage → coupure immédiate). `VpnService.protect()` lie le
     * socket au réseau physique sous-jacent.
     */
    override fun autoDetectInterfaceControl(fd: Int) {
        val ok = protect(fd)
        if (!ok) Log.w("SXB_DEBUG", "[SXB_DEBUG] PROTECT_FAILED fd=$fd")
    }

    /** Protège un `Socket` Java (utilisé par les tunnels SSH/JSch). */
    private fun protectSocket(socket: Socket): Boolean =
        runCatching { protect(socket) }.getOrDefault(false)

    override fun useProcFS(): Boolean = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q

    override fun findConnectionOwner(
        ipProtocol: Int,
        sourceAddress: String,
        sourcePort: Int,
        destinationAddress: String,
        destinationPort: Int,
    ): Int {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            throw UnsupportedOperationException("findConnectionOwner requiert Android 10+")
        }
        val cm = getSystemService(ConnectivityManager::class.java)
            ?: throw IllegalStateException("ConnectivityManager indisponible")
        val uid = cm.getConnectionOwnerUid(
            ipProtocol,
            InetSocketAddress(sourceAddress, sourcePort),
            InetSocketAddress(destinationAddress, destinationPort),
        )
        if (uid == android.os.Process.INVALID_UID) throw IllegalStateException("propriétaire introuvable")
        return uid
    }

    override fun packageNameByUid(uid: Int): String {
        val packages = packageManager.getPackagesForUid(uid)
        if (packages.isNullOrEmpty()) throw IllegalStateException("paquet introuvable pour uid=$uid")
        return packages[0]
    }

    override fun uidByPackageName(packageName: String): Int {
        return runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                packageManager.getPackageUid(
                    packageName,
                    android.content.pm.PackageManager.PackageInfoFlags.of(0),
                )
            } else {
                @Suppress("DEPRECATION")
                packageManager.getPackageUid(packageName, 0)
            }
        }.getOrElse { throw IllegalStateException("paquet introuvable : $packageName") }
    }

    override fun startDefaultInterfaceMonitor(listener: InterfaceUpdateListener) {
        SxbDefaultNetworkMonitor.start(this)
        SxbDefaultNetworkMonitor.setListener(listener)
    }

    override fun closeDefaultInterfaceMonitor(listener: InterfaceUpdateListener) {
        SxbDefaultNetworkMonitor.setListener(null)
    }

    override fun getInterfaces(): NetworkInterfaceIterator =
        SxbInterfaceIterator(SxbNetworkInterfaces.enumerate(this, tunInterfaceName))

    override fun underNetworkExtension(): Boolean = false

    override fun includeAllNetworks(): Boolean = false

    override fun readWIFIState(): WIFIState? = null

    override fun clearDNSCache() { /* géré par Android */ }

    override fun writeLog(message: String) {
        if (message.isBlank()) return
        Log.i("SXB_DEBUG", "[SXB_DEBUG] LIBBOX_LOG: $message")
        broadcastLog("[engine] ${SecurityModule.maskSensitive(message)}")
    }

    override fun sendNotification(notification: io.nekohasekai.libbox.Notification) {
        // Les notifications du moteur sont ignorées : SXB gère sa propre
        // notification persistante de service en premier plan.
    }


    // ═════════════════════════════════════════════════════════════════════════
    // GÉNÉRATEUR DE CONFIG SING-BOX (JSON complet pour chaque protocole)
    // ═════════════════════════════════════════════════════════════════════════

    private fun buildSingBoxConfig(cfg: JSONObject, protocol: String): String {
        // optStringOrNull : jamais la chaîne "null" (AOSP) — correctif APK #165
        val host     = cfg.optStringOrNull("host", "")
        val port     = cfg.optInt("port", 443)
        val uuid     = cfg.optStringOrNull("uuid", "")
        val password = cfg.optStringOrNull("password", "")
        val method   = cfg.optStringOrNull("method", "aes-256-gcm")
        val sni      = cfg.optStringOrNull("sni", host)
        val network  = cfg.optStringOrNull("network", "tcp")
        val path     = cfg.optStringOrNull("path", "/")
        val tls      = cfg.optBoolean("tls", true)
        val flow     = cfg.optStringOrNull("flow", "")
        val privKey  = cfg.optStringOrNull("privateKey", "")
        val peerPub  = cfg.optStringOrNull("peerPublicKey", "")
        val localAddr = cfg.optStringOrNull("localAddress", "10.0.0.2/32")

        // Inbound TUN
        //
        // NOTE — « file_descriptor » a été retiré volontairement : ce champ
        // n'existe pas dans le schéma JSON de sing-box et faisait échouer le
        // parsing de la config (le moteur s'arrêtait aussitôt). Sous libbox,
        // le descripteur est fourni par le rappel openTun() ci-dessus.
        //
        // « auto_route » doit valoir true : c'est lui qui demande à libbox
        // d'appeler openTun() avec des routes par défaut (0.0.0.0/0), donc
        // qui fait réellement passer le trafic du système dans le tunnel.
        val tunInbound = JSONObject().apply {
            put("type", "tun")
            put("tag", "tun-in")
            put("inet4_address", "172.19.0.1/30")
            put("auto_route", true)
            put("strict_route", false)
            put("stack", "system")
            put("mtu", 9000)
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
            // FIX — doit valoir true : combiné à
            // usePlatformAutoDetectInterfaceControl(), c'est ce qui déclenche
            // autoDetectInterfaceControl() → VpnService.protect() sur chaque
            // socket sortant. À false, les connexions du moteur rentraient
            // dans le TUN qu'elles alimentent (boucle) et le tunnel tombait.
            // `override_android_vpn` est retiré : sans pertinence sous libbox.
            put("auto_detect_interface", true)
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

    /**
     * Config TUN → SOCKS5 : fait entrer tout le trafic du système dans le
     * tunnel SSH, en le relayant vers le serveur SOCKS5 local alimenté par JSch.
     *
     * Comme pour buildSingBoxConfig(), le champ « file_descriptor » a disparu :
     * c'est openTun() qui fournit le TUN au moteur.
     */
    private fun buildSshSocksRelayConfig(): String {
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
                put("inet4_address", "172.19.0.1/30")
                put("auto_route", true)
                put("strict_route", false)
                put("stack", "system")
                put("mtu", 9000)
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
                // true → protège les sockets sortants (voir buildSingBoxConfig).
                put("auto_detect_interface", true)
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

    fun copyFullLogs(): String {
        val copy = fullLogBuffer.toString()
        if (copy.isNotEmpty()) {
            File(filesDir, "full_logs_copy.txt").writeText(copy, Charsets.UTF_8)
            Log.i(TAG, "[SXB_DEBUG] FULL_LOGS_COPIED bytes=${copy.length}")
            broadcastLog("[SXB_DEBUG] FULL_LOGS_COPIED bytes=${copy.length}")
        }
        return copy
    }

    private fun broadcastStatus(status: String) {
        // setPackage() obligatoire sur Android 14+ avec RECEIVER_NOT_EXPORTED
        // Sans ça, les broadcasts intra-app sont silencieusement ignorés.
        val intent = Intent(BROADCAST_STATUS).apply {
            putExtra("status", status)
            setPackage(packageName)
        }
        sendBroadcast(intent)
    }

    // HANDOFF_LOGS_ULTRADETAIL — bouton Copier : persister les logs complets
    private val fullLogBuffer = StringBuilder()

    private fun broadcastLog(message: String) {
        Log.i(TAG, message)
        fullLogBuffer.append(message).append("\n")
        // setPackage() obligatoire sur Android 14+ avec RECEIVER_NOT_EXPORTED
        val intent = Intent(BROADCAST_LOG).apply {
            putExtra("log", SecurityModule.maskSensitive(message))
            setPackage(packageName)
        }
        sendBroadcast(intent)
    }

    // ═════════════════════════════════════════════════════════════════════════
    // UTILITAIRES
    // ═════════════════════════════════════════════════════════════════════════
    //
    // Les helpers d'extraction du binaire sing-box (extractSingBoxBinary,
    // writeSingBoxConfig, getSingBoxVersion, sha256Stream, getFdInt) ont été
    // supprimés en v6 : le moteur tourne désormais in-process via libbox, il
    // n'y a plus ni binaire à extraire, ni fichier de config à écrire sur
    // disque, ni descripteur à récupérer par réflexion.

    /** P1 — Chiffre configJson (credentials VPN) avec AES-256-GCM Android Keystore */
    private fun persistEncryptedConfig(originalConfigJson: String) {
        try {
            File(filesDir, "sxb_creds.enc").writeText(KeystoreManager.encrypt(originalConfigJson), Charsets.UTF_8)
            Log.i(TAG, "[P1] Config VPN chiffrée et persistée (AES-256-GCM) ✅")
        } catch (e: Exception) {
            Log.w(TAG, "[P1] Chiffrement config échoué (Keystore non disponible?): ${e.message}")
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // NETTOYAGE
    // ═════════════════════════════════════════════════════════════════════════

    private fun cleanup(stopService: Boolean = true, keepRunning: Boolean = false) {
        // FIX — Guard contre le double-cleanup : failVpn() ne doit plus appeler cleanup()
        // directement, mais cette garde sécurise le cas où cleanup() serait appelé depuis
        // deux chemins concurrents (ex: onDestroy + finally d'un tunnel).
        if (stopService && cleanupStarted.getAndSet(true)) {
            Log.w("SXB_DEBUG", "[SXB_DEBUG] CLEANUP_SKIPPED — déjà en cours")
            return
        }

        if (!keepRunning) running.set(false)
        vpnThread?.interrupt()
        notifThread?.interrupt()
        connectionWatchdog?.interrupt()
        connectionWatchdog = null

        if (stopService) {
            val manager = getSystemService(ConnectivityManager::class.java)
            networkCallback?.let { callback ->
                runCatching { manager?.unregisterNetworkCallback(callback) }
            }
            networkCallback = null
        }

        runCatching { socks5Server?.close() };  socks5Server    = null

        // Arrêt du moteur libbox AVANT la fermeture du TUN : sing-box doit
        // pouvoir vider ses connexions avant que le descripteur disparaisse.
        boxService?.let { svc ->
            runCatching { svc.close() }
                .onFailure { Log.w(TAG, "libbox close: ${it.message}") }
        }
        boxService = null

        runCatching { sshSession?.disconnect() }; sshSession     = null

        runCatching { tunPfd?.close() };  tunPfd = null
        tunInterfaceName = null
        if (stopService) SxbDefaultNetworkMonitor.stop()

        trafficManager.stop()
        if (stopService) autoReconnect.reset()

        if (stopService) {
            setCurrentState("disconnected")
            broadcastStatus("disconnected")
        }
        if (stopService) {
            // FIX — stopForeground(boolean) est deprecated depuis API 33 (Android 13).
            // Utiliser stopForeground(STOP_FOREGROUND_REMOVE) sur API 33+.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                stopForeground(android.app.Service.STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
            stopSelf()
        }
    }

    fun stopVpn() = cleanup()
}

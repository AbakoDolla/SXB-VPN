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
 *  Sing-box (natif) → libbox (config importée fusionnée avec le TUN de l'app)
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
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.VpnService
import android.os.Build
import android.os.SystemClock
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
import java.net.SocketTimeoutException
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom
import java.util.HashSet
import java.util.Properties
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.Locale
import javax.net.ssl.SSLParameters
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

// ── WsOutputStream — Encode chaque write() en frame WebSocket binaire (client→server, masqué) ──
private class WsOutputStream(
    private val raw: OutputStream,
    private val onEvent: (String) -> Unit = {},
) : OutputStream() {
    private val rng = SecureRandom()

    override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)
    override fun write(b: ByteArray) = write(b, 0, b.size)
    override fun write(b: ByteArray, off: Int, len: Int) {
        if (len == 0) return
        val mask = ByteArray(4).also { rng.nextBytes(it) }
        val masked = ByteArray(len) { i -> (b[off + i].toInt() xor mask[i % 4].toInt()).toByte() }
        // Diagnostic sans contenu : un payload ou une bannière peut contenir des secrets.
        onEvent("[SXB_TRACE] stage=WS_FRAME_OUT fin=true opcode=2 masked=true payload_bytes=$len")
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
    private val onEvent: (String) -> Unit = {},
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
            val b0 = raw.read()
            if (b0 == -1) {
                onEvent("[SXB_DEBUG] WS_EOF — serveur a coupé le flux TCP (avant/pendant les trames)")
                return null
            }
            val b1 = raw.read(); if (b1 == -1) return null
            val fin = (b0 and 0x80) != 0
            val opcode = b0 and 0x0F
            val masked = (b1 and 0x80) != 0
            // Répondre aux ping est nécessaire pour les serveurs WebSocket mobiles
            // qui ferment la connexion si aucun pong n'est reçu.
            var payloadLen = (b1 and 0x7F).toLong()
            payloadLen = when (payloadLen) {
                126L -> ((readByte() shl 8) or readByte()).toLong()
                127L -> (0 until 8).fold(0L) { acc, _ -> (acc shl 8) or readByte().toLong() }
                else -> payloadLen
            }
            onEvent("[SXB_TRACE] stage=WS_FRAME_IN fin=$fin opcode=$opcode masked=$masked payload_bytes=$payloadLen")
            val maskKey = if (masked) ByteArray(4) { readByte().toByte() } else null
            val payload = ByteArray(payloadLen.toInt())
            var total = 0
            while (total < payload.size) {
                val n = raw.read(payload, total, payload.size - total)
                if (n == -1) break
                total += n
            }
            if (opcode == 0x08) {
                val closeCode = if (payload.size >= 2) ((payload[0].toInt() and 0xFF) shl 8) or (payload[1].toInt() and 0xFF) else -1
                onEvent("[SXB_TRACE] stage=WS_CLOSE code=$closeCode payload_bytes=${payload.size}")
                Log.w("SXB_DEBUG", "[SXB_DEBUG] WS_CLOSE_FRAME received")
                return null
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
                onEvent("[SXB_TRACE] stage=WS_PONG_SENT payload_bytes=${payload.size} masked=true")
                return readNextFrame()
            }
            if (maskKey != null) {
                for (i in payload.indices) payload[i] = (payload[i].toInt() xor maskKey[i % 4].toInt()).toByte()
            }
            onEvent("[SXB_DEBUG] WS_IN opcode=$opcode bytes=${payload.size}")
            SxbSecureLogger.debug("WS_FRAME_IN opcode=$opcode bytes=${payload.size}")
            payload
        } catch (e: SocketTimeoutException) {
            onEvent("[SXB_TRACE] stage=WS_FRAME_TIMEOUT timeout_propagated=true")
            throw e
        } catch (e: Exception) {
            onEvent("[SXB_DEBUG] WS_FRAME_READ_ERROR type=${e.javaClass.simpleName}")
            SxbSecureLogger.warn("WS_FRAME_READ_ERROR")
            throw e
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
        onEvent("[SXB_TRACE] stage=SOCKET_CREATED timeout_ms=$connectTimeout tls=$tlsEnabled sni_present=${sni.isNotBlank()}")
        // Socket() seul n'a pas forcément de descripteur natif. Créer le socket
        // local avant protect() est indispensable : sinon VpnService.protect()
        // retourne false sur certains appareils et le futur tunnel risquerait une
        // boucle dès que l'interface TUN est établie.
        val fdReady = runCatching {
            rawSocket.bind(null)
            rawSocket.isBound
        }.getOrDefault(false)
        val protectedOk = protectSocket(rawSocket)
        Log.i("SXB_DEBUG", "[SXB_DEBUG] SSH_SOCKET_PROTECTED result=$protectedOk fd_ready=$fdReady")
        onEvent("[SXB_TRACE] stage=SOCKET_PROTECT result=$protectedOk fd_ready=$fdReady")
        // Résolution DNS visible (diagnostic données cellulaires / split-DNS)
        val dnsT0 = System.currentTimeMillis()
        val dnsResolved = runCatching {
            java.net.InetAddress.getAllByName(host).isNotEmpty()
        }.getOrDefault(false)
        onEvent("[SXB_TRACE] stage=DNS_RESOLVE success=$dnsResolved elapsed_ms=${System.currentTimeMillis() - dnsT0}")
        val t0 = System.currentTimeMillis()
        rawSocket.connect(InetSocketAddress(host, port), connectTimeout)
        onEvent("[SXB_TRACE] stage=TCP_CONNECTED elapsed_ms=${System.currentTimeMillis() - t0} local_bound=${rawSocket.localPort > 0}")
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
            onEvent("[SXB_TRACE] stage=TLS_HANDSHAKE_SUCCESS protocol=${tlsSocket.session.protocol} cipher_present=${tlsSocket.session.cipherSuite.isNotBlank()}")
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

        onEvent("[SXB_TRACE] stage=PAYLOAD_NORMALIZED bytes=${payload.length} has_connect=${payload.trimStart().startsWith("CONNECT ", ignoreCase = true)} has_upgrade=${payload.contains("upgrade", ignoreCase = true)} crlf_count=${payload.windowed(2).count { it == "\r\n" }} placeholder_removed=${rawPayload.contains("…") || rawPayload.contains("...")}")
        if (SxbSecureLogger.isDiagnosticEnabled()) {
            onEvent("[SXB_DIAGNOSTIC] CONNECT_TARGET host=$host port=$port tls=$tlsEnabled sni=${sni.ifBlank { "<none>" }}")
            onEvent("[SXB_DIAGNOSTIC] PAYLOAD_FULL_BEGIN\n$payload\n[SXB_DIAGNOSTIC] PAYLOAD_FULL_END")
        }

        val connectPayload = payload.trimStart().startsWith("CONNECT ", ignoreCase = true)

        // ── 1b. Compléter uniquement un vrai handshake WS — PARITÉ sonde backend ────
        // RFC 6455 §4.1 : Sec-WebSocket-Key + Version sont OBLIGATOIRES. Sans eux,
        // ce serveur (Accept valide = endpoint strict) répond 101 en façade mais le
        // backend WS ne livre jamais le flux SSH → JSch attend la bannière ~30 s →
        // « connection is closed by foreign host » (incident réel du 2026-07-31).
        // Preuve positive : la sonde (transport-probe.ts) injecte la clé et reçoit
        // immédiatement « SSH-2.0-BugSleuth_0.1.9 » derrière le même tunnel.
        // v2 — détection par REGEX tolérante aux espaces (parité exacte sonde
        // /upgrade:\s*websocket/i) : le test v1 par chaîne exacte (1 seul espace)
        // laissait passer des payloads réels — jamais déclenchée (bytes inchangés,
        // pas de WS_KEY_INJECTED dans les logs terrain du 2026-07-31 03:26).
        val keyPresent = Regex("sec-websocket-key\\s*:", RegexOption.IGNORE_CASE).containsMatchIn(payload)
        if (!connectPayload && payload.contains("websocket", ignoreCase = true) && !keyPresent) {
            val wsKey = android.util.Base64.encodeToString(
                ByteArray(16).also { java.security.SecureRandom().nextBytes(it) },
                android.util.Base64.NO_WRAP)
            val wsHeaders = "\r\nSec-WebSocket-Key: $wsKey" +
                            "\r\nSec-WebSocket-Version: 13" +
                            "\r\nSec-WebSocket-Protocol: binary"
            payload = if (payload.endsWith("\r\n\r\n"))
                payload.dropLast(4) + wsHeaders + "\r\n\r\n"
            else
                payload + wsHeaders + "\r\n\r\n"
            Log.i("SXB_DEBUG", "[SXB_DEBUG] WS_KEY_INJECTED — handshake RFC 6455 complété (parité sonde)")
            onEvent("[SXB_DEBUG] WS_KEY_INJECTED — handshake RFC 6455 complété")
        }
        // Le contenu d’un payload peut porter des en-têtes et des paramètres privés.
        // Ne conserver que des métriques non identifiantes pour le diagnostic.
        SxbSecureLogger.debug("PAYLOAD_READY bytes=${payload.length}")
        onEvent("[SXB_DEBUG] PAYLOAD_READY bytes=${payload.length}")
        rawOut.write(payload.toByteArray(Charsets.ISO_8859_1))
        rawOut.flush()
        Log.i("SXB_DEBUG", "[SXB_DEBUG] PAYLOAD_SENT length=${payload.length}")
        onEvent("[SXB_TRACE] stage=PAYLOAD_SENT bytes=${payload.length} flush=true")

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
        val headerNames = response.split("\r\n")
            .drop(1)
            .filter { it.contains(":") }
            .map { it.substringBefore(":").trim().lowercase(Locale.ROOT) }
            .distinct()
            .joinToString(",")
        Log.i("SXB_DEBUG", "[SXB_DEBUG] SERVER_RESPONSE=${logSafeStatus} bytes=${response.length}")
        onEvent("[SXB_TRACE] stage=HTTP_RESPONSE status=${SecurityModule.maskSensitive(logSafeStatus)} header_count=${headerNames.split(',').count { it.isNotBlank() }} body_bytes=unknown")
        if (SxbSecureLogger.isDiagnosticEnabled()) {
            onEvent("[SXB_DIAGNOSTIC] SERVER_RESPONSE_FULL_BEGIN\n$response\n[SXB_DIAGNOSTIC] SERVER_RESPONSE_FULL_END")
        }
        onEvent("[SXB_TRACE] stage=HTTP_HEADERS names=$headerNames raw_bytes=${response.length} terminator=${response.endsWith("\r\n\r\n")}")

        // ── 3. Détecter le mode transport ─────────────────────────────────────
        //   HTTP 101 = WebSocket upgrade  → adapter WS obligatoire
        //   HTTP 200 = CONNECT tunnel     → SSH direct sur le même socket
        //   Réponse vide / "SSH-"         → SSH direct (pas de proxy HTTP)
        val statusLine  = response.substringBefore("\r\n")
        val hasWsUpgradeHeader = Regex("(?im)^Upgrade\\s*:\\s*websocket\\s*$").containsMatchIn(payload)
        val hasWsKey = Regex("(?im)^Sec-WebSocket-Key\\s*:").containsMatchIn(payload)
        val isWs        = response.contains("101") &&
                          (response.contains("websocket", ignoreCase = true) ||
                           response.contains("Upgrade",   ignoreCase = true)) &&
                          hasWsUpgradeHeader && hasWsKey && !connectPayload
        val isConnect   = response.contains("200") &&
                          response.contains("Connection established", ignoreCase = true)
        val isSshBanner = response.startsWith("SSH-")
        val isEmpty     = response.isBlank()
        // Charge « CONNECT <cible> » (mode eProxy/SocksIP) = tunnel TCP transparent,
        // quelle que soit la réponse (101 cosmétique ignoré — voir branche when).
        val isConnectPayload = connectPayload

        Log.i("SXB_DEBUG", "[SXB_DEBUG] SERVER_MODE status='$statusLine' isWS=$isWs isConnect=$isConnect isSshBanner=$isSshBanner isEmpty=$isEmpty")
        onEvent("[SXB_TRACE] stage=MODE_CLASSIFIED status=${SecurityModule.maskSensitive(statusLine)} ws=$isWs connect200=$isConnect ssh_banner=$isSshBanner empty=$isEmpty connect_payload=$isConnectPayload")

        // ── 4. Lire les premiers octets utiles pour confirmer le mode ─────────
        val httpTunnelCompatible = response.contains("101") || isConnect
        if (!isWs && !isConnect && !isSshBanner && !isEmpty) {
            // Un CONNECT avec réponse 101 est compatible avec le tunnel brut : le
            // classifieur doit atteindre le when et ne doit pas fabriquer un portail.
            // Les réponses 301/302 ou les pages HTML de portail restent toujours
            // bloquantes, y compris pour un payload CONNECT.
            val statusForFail = response.substringBefore("\r\n")
            if (statusForFail.startsWith("HTTP/") && !(isConnectPayload && httpTunnelCompatible)) {
                val loc = Regex("(?i)location:\\s*(\\S+)").find(response)?.groupValues?.getOrNull(1) ?: ""
                val statusCode = Regex("^HTTP/\\S+\\s+(\\d{3})").find(statusForFail)?.groupValues?.getOrNull(1)?.toIntOrNull()
                val body = response.substringAfter("\r\n\r\n", "")
                val bodyLooksPortal = body.contains("<html", true) &&
                    (body.contains("captive", true) || body.contains("nointernet", true) || body.contains("portal", true))
                                val portal = bodyLooksPortal ||
                    loc.contains("nointernet", true) ||
                    loc.contains("captive", true) ||
                    loc.contains("portal", true)
                val hint = if (portal)
                    " — portail captif détecté avec preuve HTTP/HTML : rechargez la ligne ou utilisez le Host zéro-rated"
                else
                    " — pas de tunnel sur cette réponse : vérifiez le Host zéro-rated et le payload"
                val errorCode = if (portal) "CAPTIVE_PORTAL" else "TUNNEL_REFUSED"
                onEvent("[SXB_DEBUG] NON_TUNNEL_HTTP code=$errorCode status='$statusForFail' location='$loc' proof=$portal")
                Log.w("SXB_DEBUG", "[SXB_DEBUG] NON_TUNNEL_HTTP code=$errorCode status='$statusForFail' location='$loc' proof=$portal")
                throw java.io.IOException("$errorCode $statusForFail$hint")
            }
            // Essayer de voir les premiers octets après les headers (ex: début SSH banner)
            val peekBuf = ByteArray(16)
            var peekLen = 0
            try {
                transportSocket.soTimeout = 3_000
                peekLen = rawIn.read(peekBuf)
                transportSocket.soTimeout = 0
            } catch (_: Exception) {}
            // Garde-fou EOF : read() renvoie -1 quand le pair referme juste après les
            // headers — take(-1) jetait IllegalArgumentException (crash réel du
            // 2026-07-31 sur portail captif MTN, SxbPayloadProxy.connect:403).
            if (peekLen < 0) {
                onEvent("[SXB_DEBUG] FIRST_SERVER_BYTES_EOF — le pair a refermé après les headers")
                peekLen = 0
            }
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

        // ── 4. Lever l'ambiguïté du mode de transport (Peeking) ──────────────
        // On lit le premier octet après les headers pour savoir si c'est du binaire WS (0x82)
        // ou du texte SSH ('S'). Indispensable pour les serveurs qui répondent 101
        // mais envoient du SSH brut (cosmétique) vs les vrais serveurs WebSocket.
        val peekBuf = ByteArray(1)
        var peekLen = 0
        try {
            transportSocket.soTimeout = 2000
            peekLen = rawIn.read(peekBuf)
            transportSocket.soTimeout = 0
        } catch (_: Exception) {}
        val firstByte = if (peekLen > 0) peekBuf[0].toInt() and 0xFF else -1
        val firstHex = if (firstByte >= 0) "%02X".format(firstByte) else "NONE"
        onEvent("[SXB_TRACE] stage=POST_HEADER_PEEK bytes=$peekLen first_byte_hex=$firstHex first_byte_ascii=${if (firstByte in 32..126) firstByte.toChar() else "NON_PRINTABLE"}")

        when {
            isSshBanner || isEmpty -> {
                // Serveur répond SSH directement (pas de proxy intermédiaire)
                if (isSshBanner) {
                    onEvent("[SXB_TRACE] stage=TRANSPORT_SELECTED mode=SSH_RAW reason=SSH_BANNER")
                    inputStream = SequenceInputStream(
                        ByteArrayInputStream(response.toByteArray(Charsets.ISO_8859_1)),
                        rawIn
                    )
                } else {
                    inputStream = rawIn
                }
                outputStream = rawOut
            }

            isConnect -> {
                // HTTP CONNECT 200 → tunnel TCP transparent, SSH direct
                Log.i("SXB_DEBUG", "[SXB_DEBUG] HTTP_CONNECT_TUNNEL raw SSH streams")
                onEvent("[SXB_TRACE] stage=TRANSPORT_SELECTED mode=CONNECT_RAW reason=http_200")
                inputStream  = if (peekLen > 0) SequenceInputStream(ByteArrayInputStream(peekBuf, 0, peekLen), rawIn) else rawIn
                outputStream = rawOut
            }

            isConnectPayload -> {
                // CONNECT n'est jamais interprété comme RFC6455 : le 101 renvoyé
                // par certains eProxy/SocksIP est cosmétique pour ce type de payload.
                onEvent("[SXB_DEBUG] CONNECT_PAYLOAD_RAW_TUNNEL — flux SSH brut")
                onEvent("[SXB_TRACE] stage=TRANSPORT_SELECTED mode=CONNECT_RAW reason=connect_payload")
                inputStream  = if (peekLen > 0) SequenceInputStream(ByteArrayInputStream(peekBuf, 0, peekLen), rawIn) else rawIn
                outputStream = rawOut
            }

            isWs -> {
                // RFC6455 est réservé à un payload GET/Upgrade contenant une clé.
                // Certains serveurs répondent 101 puis exposent SSH en clair : le
                // premier octet 'S' conserve le repli cosmétique.
                if (firstByte == 'S'.code) {
                    onEvent("[SXB_DEBUG] COSMETIC_101_DETECTED — SSH brut détecté après 101")
                    onEvent("[SXB_TRACE] stage=TRANSPORT_SELECTED mode=SSH_RAW reason=101_then_ssh_banner")
                    inputStream  = if (peekLen > 0) SequenceInputStream(ByteArrayInputStream(peekBuf, 0, peekLen), rawIn) else rawIn
                    outputStream = rawOut
                } else {
                    onEvent("[SXB_DEBUG] WEBSOCKET_MODE_ACTIVATED — trames RFC 6455")
                    onEvent("[SXB_TRACE] stage=TRANSPORT_SELECTED mode=WEBSOCKET_RFC6455 reason=http_101_upgrade")
                    val baseIn = if (peekLen > 0) SequenceInputStream(ByteArrayInputStream(peekBuf, 0, peekLen), rawIn) else rawIn
                    inputStream  = WsInputStream(baseIn, rawOut, onEvent)
                    outputStream = WsOutputStream(rawOut, onEvent)
                }
            }

            else -> {
                Log.w("SXB_DEBUG", "[SXB_DEBUG] UNKNOWN_RESPONSE_FALLBACK raw streams")
                onEvent("[SXB_TRACE] stage=TRANSPORT_SELECTED mode=RAW_FALLBACK reason=unknown_response")
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
        onEvent("[SXB_TRACE] stage=SSH_BANNER_WAIT timeout_ms=28000")
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
            // Garantit un FD exploitable par VpnService.protect() avant connect().
            // La liaison éphémère n'impose aucune adresse distante et évite qu'un
            // socket SSH direct soit inclus dans le TUN qu'il doit alimenter.
            val fdReady = runCatching {
                bind(null)
                isBound
            }.getOrDefault(false)
            val ok = protectSocket(this)
            Log.i("SXB_DEBUG", "[SXB_DEBUG] SSH_SOCKET_PROTECTED result=$ok fd_ready=$fdReady")
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

        /** B10 — Adresses de l'interface de blocage du kill switch. */
        private const val KILL_SWITCH_ADDR_V4 = "10.63.63.1"
        private const val KILL_SWITCH_ADDR_V6 = "fd63:5842:5850::1"

        /** B8 — Plafond du tampon de logs de diagnostic (fenêtre glissante). */
        private const val MAX_LOG_BUFFER_CHARS  = 512 * 1024
        private const val LOG_BUFFER_KEEP_CHARS = 384 * 1024

        /**
         * §4 — Marqueurs de journal sing-box. Les outbounds locaux ne prouvent
         * jamais qu'un tunnel est monté ; seuls ceux du proxy le font.
         */
        private val LOCAL_OUTBOUND_MARKERS = listOf(
            "outbound/direct", "outbound/dns", "outbound/block",
            "[direct]", "[dns-out]", "[block]",
        )
        private val PROXY_OUTBOUND_MARKERS = listOf(
            "[proxy]", "outbound/vless", "outbound/vmess", "outbound/trojan",
            "outbound/shadowsocks", "outbound/hysteria", "outbound/tuic",
            "outbound/wireguard", "outbound/ssh", "reality",
        )

        /**
         * §30 — Erreurs définitives pour la configuration courante : réessayer
         * ne peut pas les corriger et noierait la cause réelle dans les logs.
         */
        private val PERMANENT_ERROR_CODES = setOf("CONFIG_INVALID", "CONFIG_UNSUPPORTED")

        /** ⚡ Plafond de diffusion des journaux vers l'interface (voir broadcastLog). */
        private const val LOG_RATE_WINDOW_MS = 1_000L
        private const val LOG_RATE_MAX_PER_WINDOW = 12
        /** Seuils du diagnostic « tunnel connecté mais sans trafic ». */
        private const val OUTBOUND_FAILURE_WINDOW_MS = 15_000L
        private const val OUTBOUND_FAILURE_THRESHOLD = 5
        private const val OUTBOUND_DIAGNOSIS_COOLDOWN_MS = 60_000L

        @Volatile var instance: SxbVpnService? = null
        @Volatile private var currentState: String = "disconnected"

        fun getCurrentState() = currentState
        private fun setCurrentState(s: String) { currentState = s }

        /** `Libbox.setup()` ne doit être appelé qu'une seule fois par process. */
        @Volatile private var libboxInitialized = false
    }

    // ── État du service ───────────────────────────────────────────────────────
    private val running         = AtomicBoolean(false)
    /** Vrai uniquement après un startForeground réussi — évite de continuer en arrière-plan sans notification. */
    private val foregroundStarted = AtomicBoolean(false)
    private var tunPfd          : ParcelFileDescriptor? = null
    private var sshSession      : Session? = null
    private var socks5Server    : ServerSocket? = null
    /** Instance sing-box in-process (remplace l'ancien `Process` externe). */
    private var boxService      : BoxService? = null
    private var vpnThread       : Thread? = null
    private var killSwitchEnabled = false
    /** B10 — Interface de blocage maintenue quand le tunnel réel est indisponible. */
    @Volatile private var killSwitchPfd: ParcelFileDescriptor? = null
    @Volatile private var killSwitchThread: Thread? = null
    private var configJson      = ""
    /** Nom de notre interface TUN — exclue de l'énumération pour éviter les boucles. */
    @Volatile private var tunInterfaceName: String? = null
    private var isSshRelay: Boolean = false

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
    /** ⚡ Fenêtre glissante de limitation des journaux diffusés (voir broadcastLog). */
    private val logRateWindowStart = AtomicLong(0L)
    private val logRateCount = java.util.concurrent.atomic.AtomicInteger(0)
    private val traceSequence = AtomicLong(0)

    /**
     * Détection d'un tunnel « connecté » qui ne transporte rien
     * (voir noteOutboundFailure). Écrits depuis writeLog(), appelé par le moteur
     * sur un seul fil : @Volatile suffit, aucun verrou nécessaire.
     */
    @Volatile private var outboundFailureCount = 0
    @Volatile private var outboundFailureWindowStart = 0L
    @Volatile private var lastOutboundDiagnosisAt = 0L
    @Volatile private var dnsFailureSeen = false
    /** Compteur de trafic au début de la fenêtre : preuve qu'un octet a circulé. */
    @Volatile private var trafficAtWindowStart = 0L

    private data class SshTransportStrategy(
        val mode: String,
        val tls: Boolean,
        val payload: String,
        val sni: String,
    )

    private fun transportPreferences() = getSharedPreferences("sxb_transport_modes", MODE_PRIVATE)

    private fun transportCacheKey(cfg: JSONObject): String {
        val configId = cfg.optStringOrNull("configId", "").ifBlank {
            cfg.optStringOrNull("id", "").ifBlank { "default" }
        }
        return "@sxb_transport_mode_${configId.take(96)}"
    }

    private fun extractPayloadHost(payload: String): String {
        val normalized = payload
            .replace("[crlf]", "\r\n", ignoreCase = true)
            .replace("[lf]", "\n", ignoreCase = true)
        return Regex("(?im)^Host\\s*:\\s*([^\\s\\r\\n]+)")
            .find(normalized)?.groupValues?.getOrNull(1)?.trim().orEmpty()
            .removePrefix("http://").removePrefix("https://")
            .substringBefore(":")
    }

    private fun normalizePayload(payload: String, host: String, port: Int): String {
        val normalized = payload
            .replace("[crlf]", "\r\n", ignoreCase = true)
            .replace("[lf]", "\n", ignoreCase = true)
            .replace("[cr]", "\r", ignoreCase = true)
            .replace("[port]", port.toString())
            .replace("[host_port]", "$host:$port", ignoreCase = true)
            .replace("[host]", host, ignoreCase = true)
        // Les caractères « … » ou « ... » sont fréquemment ajoutés par une
        // interface de partage pour signifier « en-têtes omis ». Ils ne sont
        // pas une ligne HTTP valide. Supprimer uniquement une ligne composée
        // de ce marqueur, sans toucher aux autres en-têtes du fournisseur.
        val withoutPlaceholders = normalized
            .replace("…", "")
            .replace(Regex("\\.{3,}"), "")
        return withoutPlaceholders.split(Regex("\\r?\\n"))
            .filterNot { it.trim().isEmpty() }
            .joinToString("\r\n") + "\r\n\r\n"
    }

    private fun websocketPayload(payload: String, host: String, port: Int): String {
        val normalized = normalizePayload(payload, host, port)
        val lines = normalized.replace("\r\n", "\n").split("\n")
        val first = lines.firstOrNull().orEmpty().trim()
        if (!first.startsWith("CONNECT ", ignoreCase = true)) return normalized

        val targetHost = extractPayloadHost(normalized).ifBlank { host }
        val headers = lines.drop(1)
            .map { it.trimEnd('\r') }
            .filter { it.isNotBlank() }
            .filterNot {
                val name = it.substringBefore(":").trim().lowercase(Locale.ROOT)
                name in setOf("upgrade", "connection", "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "content-length")
            }
            .toMutableList()
        if (headers.none { it.startsWith("Host:", ignoreCase = true) }) headers += "Host: $targetHost"
        val keyBytes = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val key = android.util.Base64.encodeToString(keyBytes, android.util.Base64.NO_WRAP)
        headers += "Upgrade: websocket"
        headers += "Connection: Upgrade"
        headers += "Sec-WebSocket-Key: $key"
        headers += "Sec-WebSocket-Version: 13"
        headers += "Sec-WebSocket-Protocol: binary"
        return (listOf("GET / HTTP/1.1") + headers).joinToString("\r\n") + "\r\n\r\n"
    }

    private fun sshTransportStrategies(
        cfg: JSONObject,
        rawPayload: String,
        host: String,
        port: Int,
        tlsEnabled: Boolean,
        configuredSni: String,
    ): List<SshTransportStrategy> {
        val normalized = normalizePayload(rawPayload, host, port)
        val isConnect = normalized.trimStart().startsWith("CONNECT ", ignoreCase = true)
        val sni = configuredSni.ifBlank { extractPayloadHost(normalized).ifBlank { host } }
        val exactMode = if (tlsEnabled) "tls_raw" else "raw"
        val exact = SshTransportStrategy(exactMode, tlsEnabled, normalized, sni)
        if (!isConnect) return listOf(exact)
        return listOf(
            exact,
            SshTransportStrategy("tls_raw", true, normalized, sni),
            SshTransportStrategy("tls_ws", true, websocketPayload(normalized, host, port), sni),
            SshTransportStrategy("ws", false, websocketPayload(normalized, host, port), sni),
        ).distinctBy { "${it.mode}|${it.tls}|${it.payload}" }
    }

    private fun attemptResult(error: Throwable): String {
        val message = generateSequence(error) { it.cause }
            .joinToString(" ") { it.message.orEmpty() }
            .lowercase(Locale.ROOT)
        val httpCode = Regex("\\bhttp(?:/\\d(?:\\.\\d)?)?\\s+(\\d{3})\\b")
            .find(message)?.groupValues?.getOrNull(1)
        return when {
            httpCode != null -> "http_$httpCode"
            error is SocketTimeoutException || message.contains("timeout") || message.contains("timed out") -> "timeout"
            error is javax.net.ssl.SSLException || message.contains("ssl") || message.contains("tls") -> "tls_error"
            message.contains("closed") || message.contains("eof") || message.contains("end of stream") -> "closed"
            else -> "closed"
        }
    }

    private fun isAuthFailure(error: Throwable): Boolean {
        val message = generateSequence(error) { it.cause }
            .joinToString(" ") { it.message.orEmpty() }
            .lowercase(Locale.ROOT)
        return message.contains("auth fail") || message.contains("authentication") || message.contains("userauth")
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        SxbSecureLogger.initialize(this)
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
            foregroundStarted.set(true)
            Log.i(TAG, "[SXB_DEBUG] FOREGROUND_STARTED")
            broadcastLog("[SXB_DEBUG] ✅ FOREGROUND_STARTED")
        } catch (e: Exception) {
            foregroundStarted.set(false)
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
                if (killSwitchEnabled) {
                    // B10 — L'abandon des reconnexions ne doit pas rendre le réseau
                    // en clair : on maintient le service et l'interface de blocage
                    // jusqu'à une déconnexion explicite de l'utilisateur.
                    broadcastLog("[SXB] ⛔ Reconnexion impossible — Kill Switch : trafic maintenu bloqué")
                    broadcastStatus("error")
                    setCurrentState("error")
                    installKillSwitchBlackhole("reconnexions épuisées")
                } else {
                    broadcastLog("[SXB] ❌ Auto-reconnect échoué — arrêt")
                    broadcastStatus("error")
                    setCurrentState("error")
                    stopSelf()
                }
            },
            onLog = { broadcastLog(it) },
        )
        registerNetworkCallback()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { cleanup(); return START_NOT_STICKY }

        // startForeground() doit avoir réussi avant de traiter une commande VPN.
        // Continuer malgré une SecurityException laisserait un service « fantôme »
        // susceptible d’être tué par Android et de désynchroniser l’interface.
        if (!foregroundStarted.get()) {
            broadcastLog("[SXB_DEBUG] ❌ FOREGROUND_REQUIRED — commande ignorée")
            stopSelf(startId)
            return START_NOT_STICKY
        }
        // startForeground() déjà appelé dans onCreate() — mise à jour notification seule.
        try { updateNotification("SXB VPN — Connexion en cours...") } catch (_: Exception) {}
        Log.i(TAG, "[SXB_DEBUG] START_COMMAND_RECEIVED action=" + intent?.action)
        broadcastLog("[SXB_DEBUG] ▶ START_COMMAND_RECEIVED (onStartCommand a démarré)")

        // Vérifications de sécurité — OK to run after startForeground()
        val secReport = SecurityModule.audit(this)
        if (SecurityModule.shouldBlock(secReport)) {
            Log.e("SXB_DEBUG", "[SXB_DEBUG] SECURITY_BLOCK hasFrida=${secReport.hasFrida} hasXposed=${secReport.hasXposed} isHooked=${secReport.isHooked}")
            broadcastLog("[SXB_DEBUG] ❌ SECURITY_BLOCK hasFrida=${secReport.hasFrida} hasXposed=${secReport.hasXposed} isHooked=${secReport.isHooked}")
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
        // C8 — Contrôle d'intégrité de la signature APK. Informatif tant que
        // l'empreinte attendue n'est pas injectée dans le manifeste de release :
        // une signature invalide ne coupe pas le service pour ne pas rendre
        // l'application inutilisable sur une variante de build légitime.
        when (SecurityModule.checkSignature(this)) {
            SecurityModule.SignatureStatus.INVALID ->
                broadcastLog("[SXB] ⚠️ Signature de l'application non reconnue — build non officiel")
            SecurityModule.SignatureStatus.NOT_CONFIGURED ->
                Log.i(TAG, "[SXB_DEBUG] SIGNATURE_CHECK_NOT_CONFIGURED")
            SecurityModule.SignatureStatus.UNAVAILABLE ->
                Log.w(TAG, "[SXB_DEBUG] SIGNATURE_CHECK_UNAVAILABLE")
            SecurityModule.SignatureStatus.VALID ->
                Log.i(TAG, "[SXB_DEBUG] SIGNATURE_CHECK_OK")
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
        // S1 — puis purger immédiatement les copies en clair (voir purgePlaintextConfigArtifacts).
        if (json.isNotEmpty()) {
            val vaulted = try { persistEncryptedConfig(json) } catch (_: Exception) { false }
            if (vaulted) {
                try { purgePlaintextConfigArtifacts(configFilePath) } catch (_: Exception) {}
            }
        }
        killSwitchEnabled = intent?.getBooleanExtra("killSwitch", false) ?: false
        if (intent?.getBooleanExtra("autoReconnect", false) == true) {
            autoReconnect.enable()
        } else {
            autoReconnect.disable()
        }
        configJson  = json

        cleanupStarted.set(false)  // FIX — Réinitialiser le guard cleanup pour cette nouvelle connexion
        running.set(true)
        trafficManager.start(this)
        startConnectionWatchdog()

        vpnThread = Thread({ dispatchProtocol(json, proto) }, "SXB-VpnMain")
            .apply { isDaemon = false; start() }

        // Le service doit être recréé si Android termine le process en arrière-plan.
        // La configuration est relue depuis le fichier sécurisé/persisté au redémarrage.
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Ne pas arrêter le VPN lorsque l’utilisateur balaie simplement la tâche UI.
        // L’arrêt explicite passe par ACTION_STOP et cleanup().
        Log.i(TAG, "[SXB_DEBUG] TASK_REMOVED — service Foreground conservé")
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        cleanup()
        // B10 — Filet de sécurité : `cleanup()` peut être court-circuité par la
        // garde anti-double-appel. Le descripteur de l'interface de blocage doit
        // impérativement être fermé ici, sinon il survivrait à la destruction du
        // service et laisserait l'appareil sans réseau, sans notification ni
        // moyen de le débloquer autrement qu'en tuant le processus.
        removeKillSwitchBlackhole()
        foregroundStarted.set(false); instance = null; super.onDestroy()
    }
    override fun onRevoke()  {
        broadcastLog("[SXB] ⚠️ VPN révoqué par le système")
        broadcastStatus("disconnected")
        cleanup()
        // Le système a repris la main sur l'interface VPN : ne pas la réinstaller.
        removeKillSwitchBlackhole()
        super.onRevoke()
    }

    // ── Dispatch protocole ────────────────────────────────────────────────────

    private fun dispatchProtocol(json: String, proto: String) {
        // Compteurs de diagnostic remis à zéro : un échec de la session
        // précédente ne doit pas déclencher un verdict sur celle qui démarre.
        outboundFailureCount = 0
        outboundFailureWindowStart = 0L
        lastOutboundDiagnosisAt = 0L
        dnsFailureSeen = false
        trafficAtWindowStart = 0L
        Log.i("SXB_DEBUG", "[SXB_DEBUG] STEP_2_CONFIG_RECEIVED proto=$proto")
        broadcastLog("[SXB_DEBUG] ▶ STEP_2_DISPATCH proto='$proto'")
        when (proto) {
            "ssh", "ssh+payload"                                        -> startSshTunnel(json)
            "vless", "vmess", "trojan", "shadowsocks",
            "wireguard", "hysteria2", "tuic"                            -> startSingBoxTunnel(json, proto)
            "singbox"                                                   -> startSingBoxTunnelRaw(json)
            else -> {
                Log.e("SXB_DEBUG", "[SXB_DEBUG] DISPATCH_ERROR proto_inconnu=$proto")
                // §30 — Erreur structurée : le dashboard doit pouvoir distinguer
                // « profil non supporté par le moteur » d'une panne réseau.
                failVpn("CONFIG_UNSUPPORTED", "Protocole non supporté par le moteur")
                stopSelf()
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // SSH TUNNEL (JSch + SOCKS5 local + sing-box TUN relay)
    // ═════════════════════════════════════════════════════════════════════════

    private fun startSshTunnel(configJsonStr: String) {
        try {
            isSshRelay = true
            broadcastLog("[SXB] Initialisation tunnel SSH...")
            broadcastLog("[SXB] Préparation de la connexion...")
            broadcastStatus("connecting"); setCurrentState("connecting")
            trace("SSH_TUNNEL_START", "state=$currentState")
            val cfg = JSONObject(configJsonStr)

            val host       = cfg.optStringOrNull("host", "")
            val port       = cfg.optInt("port", 22)
            // optStringOrNull : jamais la chaîne "null" (AOSP) — correctif APK #165
            val username   = cfg.optStringOrNull("username", "")
            val password   = cfg.optStringOrNull("password", "")
            val uuid       = cfg.optStringOrNull("uuid", "")
            val usePayload = cfg.optBoolean("usePayload", false) || cfg.optStringOrNull("protocol","").contains("payload")
            val sni        = cfg.optStringOrNull("sni", "")
            val network    = cfg.optStringOrNull("network", "tcp")
            val path       = cfg.optStringOrNull("path", "/")
            val method     = cfg.optStringOrNull("method", "")
            val privateKey = cfg.optStringOrNull("privateKey", "")
            val peerPublicKey = cfg.optStringOrNull("peerPublicKey", "")
            val localAddress = cfg.optStringOrNull("localAddress", "")
            val flow       = cfg.optStringOrNull("flow", "")
            val tlsEnabled = cfg.optBoolean("tlsEnabled", cfg.optBoolean("tls", false))
            val websocketEnabled = cfg.optBoolean("websocketEnabled", false)
            val fingerprint = cfg.optStringOrNull("fingerprint", "")

            // Guard : host vide = config invalide, arrêter proprement
            if (host.isEmpty()) {
                broadcastLog("[SXB] ERREUR : champ \"host\" vide — configuration invalide")
                broadcastStatus("error"); setCurrentState("error")
                cleanup()
                return
            }

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
                    SxbSecureLogger.debug("PAYLOAD_DEFAULT_USED")
                    broadcastLog("[SXB_DEBUG] PAYLOAD_DEFAULT_USED — utilisation du transport par défaut")
                    "GET / HTTP/1.1[crlf]Host: [host][crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf][crlf]"
                }
                else -> ""
            }

            SxbSecureLogger.debug("SSH_SOCKET_CONNECT_START payload=$usePayload tls=$tlsEnabled ws=$websocketEnabled bytes=${payload.length}")
            broadcastLog("[SXB_DEBUG] SSH_SOCKET_CONNECT_START payload=$usePayload tls=$tlsEnabled ws=$websocketEnabled")

            // ── Télémétrie JSch (kex/auth visible) — SANS secrets : JSch consigne
            // les méthodes, drapeaux et paquets, jamais le mot de passe.
            JSch.setLogger(object : com.jcraft.jsch.Logger {
                override fun isEnabled(level: Int): Boolean = true
                override fun log(level: Int, message: String?) {
                    val tag = when (level) {
                        com.jcraft.jsch.Logger.DEBUG -> "DBG"
                        com.jcraft.jsch.Logger.INFO  -> "INF"
                        com.jcraft.jsch.Logger.WARN  -> "WRN"
                        com.jcraft.jsch.Logger.ERROR -> "ERR"
                        else -> "FTL"
                    }
                    // Les messages de bibliothèques peuvent contenir des hôtes ou des identifiants.
                    broadcastLog("[JSch:$tag] événement SSH")
                }
            })

            // ── Session JSch et ladder de transport ───────────────────────────
            val jsch = JSch()

            // C5 — La clé d'hôte est contrôlée pendant l'échange de clés, donc avant
            // que JSch ne transmette le mot de passe. `StrictHostKeyChecking=yes` n'est
            // activé que si le backend a fourni une empreinte : sans empreinte le
            // comportement historique est conservé pour ne pas rompre les connexions
            // existantes (voir SxbHostKeyVerifier).
            val hostKeyVerifier = SxbHostKeyVerifier(this, fingerprint) { event -> broadcastLog(event) }
            jsch.hostKeyRepository = hostKeyVerifier
            if (hostKeyVerifier.ignoredFingerprint) {
                // Le champ `fingerprint` sert aussi de profil uTLS pour sing-box
                // (« chrome », « firefox »…) : une telle valeur n'est pas une
                // empreinte de clé et ne doit pas bloquer la connexion SSH.
                broadcastLog("[SXB] ⚠️ Valeur 'fingerprint' non exploitable comme empreinte SSH — hôte non vérifié")
            } else if (!hostKeyVerifier.strict) {
                broadcastLog("[SXB] ⚠️ Aucun fingerprint configuré — hôte non vérifié")
            }

            val commonProps = Properties().apply {
                set("StrictHostKeyChecking", if (hostKeyVerifier.strict) "yes" else "no")
                set("PreferredAuthentications", "password")
                set("ServerAliveInterval", "10")
                set("ServerAliveCountMax", "3")
            }

            fun newSession(strategy: SshTransportStrategy? = null): Session =
                jsch.getSession(username, host, port).also { s ->
                    s.setPassword(password)
                    s.setConfig(commonProps)
                    if (strategy != null) {
                        s.setProxy(SxbPayloadProxy(strategy.payload, strategy.tls, strategy.sni, ::protectSocket) { event ->
                            broadcastLog(event)
                        })
                    } else {
                        s.setSocketFactory(SxbLoggingSocketFactory(30_000, ::protectSocket) {
                            broadcastLog("[SXB_DEBUG] SSH_BANNER_RECEIVED")
                        })
                    }
                    s.timeout = if (strategy == null) 30_000 else 12_000
                }

            lateinit var session: Session
            if (usePayload) {
                Log.i("SXB_DEBUG", "[SXB_DEBUG] PAYLOAD_START mode=SSH+Payload payload_len=${payload.length}")
                broadcastLog("[SXB_DEBUG] PAYLOAD_START mode=SSH+Payload payload_len=${payload.length}")
                broadcastLog("[SXB] Mode SSH+Payload — négociation du transport sécurisé")

                val cacheKey = transportCacheKey(cfg)
                val preferences = transportPreferences()
                val cacheFingerprint = listOf(
                    cfg.optStringOrNull("configVersion", ""),
                    cfg.optStringOrNull("configHash", ""),
                    payload.hashCode().toString(),
                    tlsEnabled.toString(),
                    sni,
                ).joinToString("|")
                val fingerprintKey = "${cacheKey}_fingerprint"
                val previousFingerprint = preferences.getString(fingerprintKey, null)
                if (previousFingerprint != null && previousFingerprint != cacheFingerprint) {
                    preferences.edit().remove(cacheKey).remove(fingerprintKey).apply()
                    broadcastLog("[SXB_TRACE] TRANSPORT_MODE_CACHE_PURGED reason=config_changed")
                }
                val cachedMode = preferences.getString(cacheKey, null)
                val allStrategies = sshTransportStrategies(cfg, payload, host, port, tlsEnabled, sni)
                val cachedStrategy = cachedMode?.let { mode -> allStrategies.firstOrNull { it.mode == mode } }
                if (cachedStrategy != null) {
                    broadcastLog("[SXB_TRACE] TRANSPORT_MODE_CACHED mode=${cachedStrategy.mode}")
                }
                val strategies = if (cachedStrategy != null) listOf(cachedStrategy) else allStrategies
                val results = linkedMapOf<String, String>()
                var selectedStrategy: SshTransportStrategy? = null

                for ((index, strategy) in strategies.withIndex()) {
                    if (!running.get()) throw InterruptedException("VPN arrêté")
                    val attemptNumber = index + 1
                    var candidate: Session? = null
                    try {
                        broadcastLog("[SXB_TRACE] ATTEMPT_STRATEGY n=$attemptNumber transport=${strategy.mode} result=started")
                        trace("SSH_ATTEMPT_START", "n=$attemptNumber transport=${strategy.mode} tls=${strategy.tls}")
                        candidate = newSession(strategy)
                        sshSession = candidate
                        trace("SSH_HANDSHAKE_START", "n=$attemptNumber transport=${strategy.mode} timeout_ms=12000")
                        broadcastLog("[SXB_DEBUG] SSH_HANDSHAKE_START n=$attemptNumber transport=${strategy.mode}")
                        candidate.connect(12_000)
                        if (!candidate.isConnected) throw java.io.IOException("SSH session not connected")
                        results[strategy.mode] = "banner_ok"
                        selectedStrategy = strategy
                        session = candidate
                        preferences.edit()
                            .putString(cacheKey, strategy.mode)
                            .putString(fingerprintKey, cacheFingerprint)
                            .apply()
                        broadcastLog("[SXB_TRACE] ATTEMPT_STRATEGY n=$attemptNumber transport=${strategy.mode} result=banner_ok")
                        broadcastLog("[SXB_TRACE] TRANSPORT_SELECTED mode=${strategy.mode} reason=ssh_banner")
                        break
                    } catch (attemptError: Throwable) {
                        if (attemptError is InterruptedException || !running.get()) throw attemptError
                        if (isAuthFailure(attemptError)) throw attemptError
                        val result = attemptResult(attemptError)
                        results[strategy.mode] = result
                        broadcastLog("[SXB_TRACE] ATTEMPT_STRATEGY n=$attemptNumber transport=${strategy.mode} result=$result")
                        runCatching { candidate?.disconnect() }
                        if (sshSession === candidate) sshSession = null
                    }
                }

                if (selectedStrategy == null) {
                    val aggregate = allStrategies.joinToString(" · ") { strategy ->
                        "${strategy.mode}:${results[strategy.mode] ?: "not_run"}"
                    }
                    throw java.io.IOException("SSH_MODE_UNKNOWN $aggregate — le fournisseur doit confirmer le mode attendu")
                }
            } else {
                Log.i("SXB_DEBUG", "[SXB_DEBUG] SSH_DIRECT_MODE")
                broadcastLog("[SXB] Mode SSH direct")
                if (tlsEnabled) {
                    Log.w("SXB_DEBUG", "[SXB_DEBUG] TLS_IGNORED_SSH_DIRECT — tls=true ignoré en SSH direct")
                    broadcastLog("[SXB_DEBUG] TLS NON appliqué en SSH direct : utilisez ssh+payload si le serveur exige TLS/WebSocket")
                }
                session = newSession()
                sshSession = session
                trace("SSH_HANDSHAKE_START", "payload=false timeout_ms=30000")
                broadcastLog("[SXB_DEBUG] SSH_HANDSHAKE_START payload=false")
                broadcastLog("[SXB] Handshake SSH en cours...")
                session.connect(30_000)
            }

            // Un stopVpn() peut avoir fermé la session pendant connect(). Ne jamais
            // ressusciter une tentative annulée ni créer un TUN après l'arrêt.
            if (!running.get() || currentState != "connecting" || !session.isConnected) {
                broadcastLog("[SXB_DEBUG] SSH_CONNECT_IGNORED — tentative annulée avant validation")
                runCatching { session.disconnect() }
                return
            }

            trace("SSH_HANDSHAKE_SUCCESS", "session_connected=${session.isConnected}")
            SxbSecureLogger.vpn(SxbSecureLogger.VpnEvent.TUNNEL_CONNECTED)
            broadcastLog("[SXB_DEBUG] SSH_CONNECTED — handshake réussi")

            // C5 — Défense en profondeur : l'empreinte a déjà été validée avant
            // l'authentification par SxbHostKeyVerifier. On confirme ici que la clé
            // effectivement négociée est bien celle attendue, au cas où une couche
            // de transport intermédiaire aurait rejoué la session.
            if (hostKeyVerifier.strict) {
                val negotiated = session.hostKey
                val negotiatedKey = runCatching {
                    android.util.Base64.decode(negotiated?.key, android.util.Base64.DEFAULT)
                }.getOrNull()
                val matches = negotiatedKey != null &&
                    SxbHostKeyVerifier.fingerprints(negotiatedKey)
                        .contains(SxbHostKeyVerifier.normalize(fingerprint))
                if (!matches) {
                    session.disconnect()
                    throw SecurityException("[SXB] ❌ Empreinte SSH invalide — connexion interrompue")
                }
                broadcastLog("[SXB] ✅ Empreinte SSH confirmée après handshake")
            }
            sshSession = session
            if (!running.get() || currentState != "connecting") {
                broadcastLog("[SXB_DEBUG] SSH_TUNNEL_IGNORED — service arrêté avant création du relais")
                return
            }
            broadcastLog("[SXB] Tunnel SSH établi")

            // ── Serveur SOCKS5 local ──────────────────────────────────────────
            socks5Server = startLocalSocks5Server(session)
            Log.i("SXB_DEBUG", "[SXB_DEBUG] STEP_12_SOCKS_STARTED port=$SOCKS5_PORT")
            broadcastLog("[SXB_DEBUG] STEP_12_SOCKS_STARTED port=$SOCKS5_PORT")
            broadcastLog("[SXB] SOCKS5 local actif (port $SOCKS5_PORT)")
            trace("SOCKS5_READY", "listen_loopback=true port=$SOCKS5_PORT")

            // ── Pont TUN → SOCKS5 via libbox ─────────────────────────────────
            // Le TUN n'est plus construit ici : c'est libbox qui le réclame via
            // openTun() au démarrage du moteur. On lui fournit simplement une
            // config dont l'outbound est notre SOCKS5 local alimenté par SSH.
            val label = if (usePayload) "SSH+PAYLOAD" else "SSH"
            startLibboxService(buildSshSocksRelayConfig(host), label)

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
            // Une fermeture provoquée par stopVpn()/watchdog n'est pas une nouvelle
            // panne réseau : ne pas republier error depuis l'ancien thread.
            if (!running.get()) {
                broadcastLog("[SXB_DEBUG] SSH_ATTEMPT_CANCELLED — erreur tardive ignorée")
                return
            }
            val safeException = SecurityModule.maskSensitive(e.message ?: "erreur inconnue")
            Log.e("SXB_DEBUG", "[SXB_DEBUG] SSH_EXCEPTION at currentState=$currentState msg=$safeException")
            val msg = e.message ?: "erreur inconnue"
            val stack = e.stackTrace.take(10).joinToString("\n  ") { "at ${it.className}.${it.methodName}(${it.fileName}:${it.lineNumber})" }
            val code = classifyVpnError(msg)
            broadcastLog("[SXB_DEBUG] SSH_EXCEPTION code=$code")
            broadcastLog("[SXB_DEBUG] STACKTRACE:\n  ${SecurityModule.maskSensitive(stack)}")
            // Chaîne de causes complète — c'est elle qui nomme le blocage exact
            var cause: Throwable? = e; var depth = 0
            val chain = StringBuilder()
            while (cause != null && depth < 4) {
                if (depth > 0) chain.append("  ←  ")
                chain.append(cause.javaClass.simpleName).append(": ")
                    .append((cause.message ?: "").take(140))
                cause = cause.cause; depth++
            }
            broadcastLog("[SXB_DEBUG] SSH_CAUSE_CHAIN ${SecurityModule.maskSensitive(chain.toString())}")
            val display = when {
                msg.contains("SSH_MODE_UNKNOWN") ->
                    "⚠️ Aucun des transports autorisés n'a établi SSH — ${msg.removePrefix("SSH_MODE_UNKNOWN ").take(220)}"
                msg.contains("CAPTIVE_PORTAL") ->
                    "🚫 Portail captif confirmé par la réponse HTTP/HTML — rechargez la ligne ou utilisez le Host zéro-rated."
                msg.contains("TUNNEL_REFUSED") ->
                    "⚠️ Le serveur n'a pas ouvert de tunnel sur cette réponse — vérifiez le Host zéro-rated et le payload."
                msg.contains("NON_TUNNEL_HTTP") ->
                    "⚠️ Réponse HTTP inattendue — aucun portail confirmé; vérifiez le Host zéro-rated et le payload."
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
            isSshRelay = false
            Log.i("SXB_DEBUG", "[SXB_DEBUG] SINGBOX_TUNNEL_START proto=$protocol")
            broadcastLog("[SXB] Initialisation VPN ${protocol.uppercase()}...")
            broadcastLog("[SXB] Préparation de la connexion...")
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
            if (!running.get()) {
                broadcastLog("[SXB_DEBUG] SINGBOX_ATTEMPT_CANCELLED — erreur tardive ignorée")
                return
            }
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
    // SING-BOX TUNNEL RAW (JSON sing-box importé / traduit depuis Xray/v2ray)
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Démarre un tunnel à partir d'un JSON sing-box COMPLET stocké sur le
     * profil (import sing-box natif ou config Xray/v2ray déjà traduite par le
     * backend). Le JSON stocké n'est PAS utilisé tel quel : il est fusionné
     * avec le gabarit de l'app (TUN de l'app, règles DNS/ip_cidr, final).
     *
     * Validation au démarrage (buildRawSingBoxConfig) : type connu pour chaque
     * outbound, detours existants, au moins un outbound non spécial. Échec →
     * log clair + état error (pas de crash muet).
     */
    private fun startSingBoxTunnelRaw(configJsonStr: String) {
        try {
            isSshRelay = false
            Log.i("SXB_DEBUG", "[SXB_DEBUG] SINGBOX_RAW_TUNNEL_START")
            broadcastLog("[SXB] Initialisation VPN SINGBOX (config importée)...")
            broadcastLog("[SXB] Préparation de la connexion...")
            broadcastStatus("connecting"); setCurrentState("connecting")

            val cfg = JSONObject(configJsonStr)
            val sbConfigJson = buildRawSingBoxConfig(cfg)
            Log.i("SXB_DEBUG", "[SXB_DEBUG] SINGBOX_RAW_CONFIG_BUILT len=${sbConfigJson.length}")
            broadcastLog("[SXB] Config générée pour SINGBOX (importé)")

            startLibboxService(sbConfigJson, "SINGBOX")

            // ── Boucle de surveillance ────────────────────────────────────────
            while (running.get()) {
                if (boxService == null) break
                Thread.sleep(5_000)
            }
        } catch (e: InterruptedException) {
            Log.i(TAG, "Thread sing-box interrompu")
        } catch (e: Exception) {
            if (!running.get()) {
                broadcastLog("[SXB_DEBUG] SINGBOX_RAW_ATTEMPT_CANCELLED — erreur tardive ignorée")
                return
            }
            Log.e("SXB_DEBUG", "[SXB_DEBUG] SINGBOX_RAW_EXCEPTION msg=${SecurityModule.maskSensitive(e.message ?: "")}", e)
            val stack = e.stackTrace.take(8).joinToString("\n  ") { "at ${it.className}.${it.methodName}(${it.fileName}:${it.lineNumber})" }
            val code = classifyVpnError(e.message ?: "")
            broadcastLog("[SXB_DEBUG] SINGBOX_RAW_EXCEPTION code=$code")
            broadcastLog("[SXB_DEBUG] STACKTRACE:\n  ${SecurityModule.maskSensitive(stack)}")
            failVpn(code, "Erreur moteur SINGBOX — ${SecurityModule.maskSensitive(e.message ?: "configuration invalide").take(120)}")
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

        boxService = service
        service.start()

        // Le démarrage libbox peut être concurrent avec stopVpn(). Le TUN et le
        // SOCKS ne doivent être annoncés que si la session est encore active.
        // FIX — On autorise l'état "connected" ici car pour VLESS/Xray, openTun()
        // a pu déjà faire basculer l'état en "connected" dès l'ouverture du TUN.
        // openTun() peut publier handshaking avant le retour de service.start().
        // Cet état est une étape normale du même démarrage sing-box : ne pas fermer
        // le service ni annuler la tentative, sinon le TUN reste ouvert mais aucun
        // outbound ne peut transporter les données.
        if (!running.get() || (currentState != "connecting" && currentState != "handshaking" && currentState != "connected")) {
            broadcastLog("[SXB_DEBUG] LIBBOX_START_IGNORED — tentative annulée (état=$currentState)")
            runCatching { service.close() }
            if (boxService === service) boxService = null
            return
        }

        trace("LIBBOX_STARTED", "label=$label service_ready=${boxService != null}")
        Log.i("SXB_DEBUG", "[SXB_DEBUG] STEP_13_VPN_CONNECTED label=$label")
        broadcastLog("[SXB_DEBUG] TUNNEL_READY proto=$label")
        broadcastLog("[SXB] Tunnel sécurisé prêt")
        broadcastLog("[SXB] ✅ Moteur $label démarré")
        connectionWatchdog?.interrupt()
        
        // On s'assure que l'état est bien "connected" (déjà fait normalement dans openTun)
        if (currentState != "connected") {
            broadcastStatus("connected"); setCurrentState("connected")
            autoReconnect.onConnected()
            updateNotification("SXB VPN — $label connecté")
            startNotificationUpdater()
        }
    }

    /**
     * Classification différenciée des erreurs VPN. CAPTIVE_PORTAL n'est utilisé
     * que lorsqu'un token explicite a été produit après une preuve HTTP/HTML;
     * une réponse 101/4xx sans preuve est classée TUNNEL_REFUSED/HTTP_UNEXPECTED.
     *
     * Alignée sur la taxonomie du préflight backend :
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
            lower.contains("ssh_mode_unknown") -> "SSH_MODE_UNKNOWN"
            // §30 — Le profil est valide mais demande une capacité que le moteur
            // embarqué ne sait pas exécuter. À distinguer d'une config malformée :
            // seul ce code indique au dashboard qu'il faut changer de profil.
            lower.contains("non supporté") || lower.contains("non supporte") ||
                lower.contains("unsupported") || lower.contains("not supported") ||
                lower.contains("unknown outbound") || lower.contains("outbound inconnu") ->
                "CONFIG_UNSUPPORTED"
            lower.contains("configuration refusée") || lower.contains("decode config") ||
                lower.contains("unknown field") || lower.contains("cannot unmarshal") ||
                lower.contains("duplicate outbound") || lower.contains("outbound/endpoint tag") ->
                "CONFIG_INVALID"
            lower.contains("captive_portal") -> "CAPTIVE_PORTAL"
            lower.contains("tunnel_refused") -> "TUNNEL_REFUSED"
            lower.contains("auth fail") || lower.contains("authentication") ||
                lower.contains("auth failure") -> "AUTH_FAILED"
            lower.contains("javax.net.ssl") || lower.contains("sslhandshake") ||
                (lower.contains("handshake") && (lower.contains("tls") || lower.contains("ssl") || lower.contains("cert"))) ||
                lower.contains("certificate") || lower.contains("certpath") ->
                "TLS_FAILED"
            lower.contains("invalid server's version string") ||
                lower.contains("invalid server version") ||
                lower.contains("banner") ||             lower.contains("ssh-2.0") ->
                "SSH_BANNER_MISSING"
            lower.contains("http 4") || lower.contains("http 5") ||
                lower.contains("http status") || lower.contains("unexpected http") ||
                lower.contains("websocket handshake") || lower.contains("payload") ->
                "HTTP_UNEXPECTED"
            // §30 — La couche de transport (ws/grpc/http) a échoué alors que TCP
            // et TLS étaient établis : typiquement un `path` ou un `service_name`
            // qui ne correspond pas à celui du serveur.
            lower.contains("grpc") || lower.contains("service_name") ||
                lower.contains("websocket") || lower.contains("transport") ->
                "TRANSPORT_ERROR"
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
        trace("VPN_FAILED", "code=$code state=$currentState")
        broadcastLog("[SXB_DEBUG] VPN_FAILED code=$code")
        broadcastLog("[SXB] $code — ${displayMessage.removePrefix("❌ ").take(160)}")
        broadcastStatus("error")
        setCurrentState("error")
        // FIX — Ne pas appeler cleanup() ici : le bloc finally de startSshTunnel /
        // startSingBoxTunnel appelle déjà cleanup(). Un double appel provoquait un
        // stopForeground + stopSelf() en double, laissant l'UI dans un état incohérent.
        // Une erreur de schéma est permanente pour cette configuration :
        // relancer automatiquement trois fois ne peut pas la corriger et masque
        // la cause dans les logs. Les erreurs réseau/auth restent éligibles.
        if (code !in PERMANENT_ERROR_CODES && ::autoReconnect.isInitialized && autoReconnect.isEnabled() && running.get()) {
            autoReconnect.onDisconnected()
        }
        // Pas de cleanup() ici : géré exclusivement dans le bloc finally du tunnel.
    }

    private fun startConnectionWatchdog() {
        connectionWatchdog?.interrupt()
        connectionWatchdog = Thread({
            try {
                Thread.sleep(90_000)
                if (running.get() && currentState == "connecting") {
                    Log.e("SXB_DEBUG", "[SXB_DEBUG] WATCHDOG_FIRED lastState=$currentState")
                    broadcastLog("[SXB_DEBUG] WATCHDOG_FIRED lastState=$currentState timeout_ms=90000")
                    // Invalider la session avant d'émettre l'erreur. Le bloc finally
                    // fermera ensuite JSch/libbox et empêchera tout connected tardif.
                    running.set(false)
                    failVpn("SSH_TIMEOUT", "Connexion bloquée après 90 secondes")
                    cleanup()
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

        // B10 — Le tunnel réel remplace l'interface de blocage : libérer le
        // descripteur et son lecteur avant d'appeler establish().
        removeKillSwitchBlackhole()

        trace("TUN_CREATE_START", "mtu=${options.mtu} auto_route=${options.autoRoute} strict_route=${options.strictRoute}")
        Log.i("SXB_DEBUG", "[SXB_DEBUG] STEP_6_TUN_CREATING mtu=${options.mtu} autoRoute=${options.autoRoute}")
        broadcastLog("[SXB] Création interface réseau TUN...")
        broadcastLog("[SXB] Établissement du tunnel sécurisé...")

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

            // ── F5 — L'APP DANS LE TUNNEL ────────────────────────────────────
            // Par défaut, l'app EST incluse dans le tunnel : son trafic
            // (API, provisionnement, quotas) passe par le VPN — c'est le
            // comportement attendu (« l'app ne voit plus rien quand elle est
            // connectée » = l'app n'était pas routée dans le TUN). On ne
            // l'exclut (addDisallowedApplication) QUE si la config JSON reçue
            // le demande explicitement : includeOwnApp === false.
            // SÉCURITÉ — aucune boucle possible : le porteur SSH reste protégé
            // par VpnService.protect(socket) + la règle route ip_cidr→direct
            // (PR #34) → le trafic du tunnel sort par le réseau physique,
            // jamais réinjecté dans le TUN.
            val includeOwnApp = runCatching {
                JSONObject(configJson).optBoolean("includeOwnApp", true)
            }.getOrDefault(true)
            if (!includeOwnApp) {
                // Mode hérité / diagnostic : exclure l'app du tunnel
                runCatching { builder.addDisallowedApplication(packageName) }
            }

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
            repeat(20) {
                val found = java.net.NetworkInterface.getNetworkInterfaces().toList()
                    .firstOrNull { it.name.startsWith("tun") }?.name
                if (!found.isNullOrBlank()) return@runCatching found
                Thread.sleep(50)
            }
            null
        }.getOrNull()
        trafficManager.attachTunInterface(tunInterfaceName)

        trace("TUN_CREATED", "fd_ready=${pfd.fd >= 0} interface_name=$tunInterfaceName tun_counters=${trafficManager.hasTunCounters()}")
        Log.i("SXB_DEBUG", "[SXB_DEBUG] STEP_7_TUN_CREATED fd=${pfd.fd} name=$tunInterfaceName")
        broadcastLog("[SXB_DEBUG] STEP_7_TUN_CREATED fd=${pfd.fd}")
        broadcastLog("[SXB] Interface TUN créée")

        // FIX — Pour V2Ray/Xray, on passe en état "handshaking" au lieu de "connected".
        // On attendra que le moteur sing-box confirme le flux réel dans writeLog()
        // ou que les compteurs de trafic décollent.
        if (currentState == "connecting" && !isSshRelay) {
            setCurrentState("handshaking")
            broadcastStatus("handshaking")
            broadcastLog("[SXB] ⏳ Tunnel établi — Négociation du flux en cours...")
            updateNotification("SXB VPN — Handshake...")
        }

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
    private fun protectSocket(socket: Socket): Boolean {
        // protect() peut renvoyer false/échouer quand le TUN n'est pas encore créé
        // (ROMs strictes) : 3 tentatives espacées. Non bloquant à ce stade — avant
        // l'établissement du TUN, un socket non protégé ne peut pas boucler.
        var ok = false
        var attempt = 0
        while (!ok && attempt < 3) {
            ok = runCatching { protect(socket) }.getOrDefault(false)
            if (!ok && attempt < 2) {
                try { Thread.sleep(150) } catch (_: InterruptedException) {}
            }
            attempt++
        }
        return ok
    }

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
        SxbSecureLogger.debug("LIBBOX_LOG: $message")
        val safeMessage = SecurityModule.maskSensitive(message)
        broadcastLog("[engine] $safeMessage")

        val lower = message.lowercase(Locale.ROOT)

        // DÉTECTION DU HANDSHAKE RÉELLEMENT ÉTABLI (§4 — ne jamais simuler).
        //
        // La condition précédente acceptait n'importe quelle ligne contenant
        // « established ». Or sing-box journalise exactement le même message pour
        // les outbounds `direct`, `dns` et `block` : une simple résolution DNS
        // locale, qui ne traverse pas le tunnel, suffisait à publier l'état
        // « connected ». L'application déclarait donc une connexion établie alors
        // qu'aucun octet n'était passé par le proxy.
        //
        // On exige désormais une preuve provenant de l'outbound proxy lui-même et
        // on écarte explicitement les outbounds locaux.
        if (currentState == "handshaking" && isProxyHandshakeProof(lower)) {
            Log.i("SXB_DEBUG", "[SXB_DEBUG] HANDSHAKE_VERIFIED via log")
            broadcastLog("[SXB] ✅ Handshake réussi — Données en transit")
            setCurrentState("connected")
            broadcastStatus("connected")
            updateNotification("SXB VPN — Connecté")
            startNotificationUpdater()
            autoReconnect.onConnected()
        }

        when {
            lower.contains("unexpected status: 429") ->
                broadcastLog("[SXB] HTTP_429_RATE_LIMIT — le proxy HTTP amont limite ou refuse les requêtes.")
            lower.contains("unexpected http response status: 404") ->
                broadcastLog("[SXB] HTTP_404_UPSTREAM — le proxy HTTP amont ne reconnaît pas la destination.")
            // Volontairement AUCUN message ici sur « connection refused ».
            // L'état « handshaking » dure tant que le moteur n'a pas produit de
            // preuve de flux, et le moteur ouvre en permanence des connexions
            // parallèles : une seule d'entre elles refusée faisait conclure « le
            // serveur a refusé » alors que le tunnel transportait des données.
            // Le verdict est désormais rendu par noteOutboundFailure(), qui exige
            // une accumulation d'échecs ET l'absence de trafic réel.
        }

        noteOutboundFailure(lower)
    }

    /**
     * Un tunnel « connecté » qui ne transporte rien.
     *
     * Le moteur journalise en niveau `warn` : il n'émet donc jamais la ligne
     * « connection established » qui prouverait le handshake, mais il émet bien
     * TOUTES les erreurs de sortie. On surveille donc l'échec plutôt que le
     * succès — sinon l'application affiche un état sain pendant que chaque
     * connexion échoue, ce qui était impossible à diagnostiquer pour l'utilisateur.
     *
     * Un échec isolé ne prouve toutefois RIEN : le moteur ouvre des dizaines de
     * connexions en parallèle et il est normal qu'une partie échoue pendant que
     * le tunnel fonctionne. Le verdict exige donc deux conditions cumulées :
     * une accumulation d'échecs ET des compteurs de trafic restés immobiles.
     *
     * Aucun changement d'état n'est provoqué ici : couper ou relancer sur un pic
     * d'erreurs déclencherait des reconnexions en boucle sur un réseau lent. On
     * NOMME la panne, une seule fois, dans le journal unifié.
     */
    private fun noteOutboundFailure(lowerMessage: String) {
        val isDnsFailure = lowerMessage.contains("dns: exchange failed") ||
            (lowerMessage.contains("lookup ") && lowerMessage.contains("i/o timeout"))
        val isOutboundFailure = lowerMessage.contains("open outbound connection") ||
            lowerMessage.contains("listen outbound packet connection")
        if (!isDnsFailure && !isOutboundFailure) return

        val now = SystemClock.elapsedRealtime()
        val bytes = runCatching {
            val s = trafficManager.getStats()
            s.uploadBytes + s.downloadBytes
        }.getOrDefault(0L)

        if (now - outboundFailureWindowStart > OUTBOUND_FAILURE_WINDOW_MS) {
            outboundFailureWindowStart = now
            outboundFailureCount = 0
            dnsFailureSeen = false
            trafficAtWindowStart = bytes
        }
        if (isDnsFailure) dnsFailureSeen = true
        if (++outboundFailureCount < OUTBOUND_FAILURE_THRESHOLD) return
        if (now - lastOutboundDiagnosisAt < OUTBOUND_DIAGNOSIS_COOLDOWN_MS) return

        // Des octets ont circulé pendant la fenêtre : le tunnel fonctionne, les
        // échecs sont ceux de connexions annexes. Aucun verdict d'échec.
        if (bytes > trafficAtWindowStart) return

        lastOutboundDiagnosisAt = now
        if (dnsFailureSeen) {
            broadcastLog(
                "[SXB] ⛔ TUNNEL_SANS_TRAFIC — la résolution DNS échoue : aucune adresse " +
                "n'est obtenue, donc aucune connexion ne peut s'ouvrir. Vérifiez que le " +
                "réseau mobile fournit bien un résolveur (mode avion/APN), puis reconnectez."
            )
        } else {
            // Sans preuve TCP/TLS, on ne peut PAS affirmer que le serveur est
            // joignable : « connection refused » peut survenir bien avant que
            // VLESS, TLS ou WebSocket n'entrent en jeu. On décrit le fait
            // observé — aucun octet ne circule — sans en inventer la cause.
            broadcastLog(
                "[SXB] ⛔ TUNNEL_SANS_TRAFIC — les connexions sortantes échouent et aucun octet " +
                "ne circule. Le serveur peut être injoignable depuis ce réseau, ou refuser le " +
                "profil (UUID, chemin WebSocket, en-tête Host)."
            )
        }
    }

    /**
     * §4 — Une ligne de journal ne prouve un tunnel établi que si elle provient
     * de l'outbound proxy. Les outbounds locaux (`direct`, `dns`, `block`)
     * produisent des messages identiques sans qu'aucune donnée n'ait transité par
     * le serveur : les accepter revenait à simuler la connexion.
     */
    private fun isProxyHandshakeProof(lowerMessage: String): Boolean {
        val successMarker = lowerMessage.contains("established") ||
            lowerMessage.contains("handshake success") ||
            lowerMessage.contains("reality success")
        if (!successMarker) return false
        // Outbounds locaux : jamais une preuve de tunnel.
        val localOutbound = LOCAL_OUTBOUND_MARKERS.any { lowerMessage.contains(it) }
        if (localOutbound) return false
        // Preuve positive : le message cite l'outbound proxy ou un protocole distant.
        return PROXY_OUTBOUND_MARKERS.any { lowerMessage.contains(it) }
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
        // `host` dans une URI VLESS peut désigner l’en-tête WebSocket, tandis
        // que l’autorité après @ reste l’adresse TCP. Ne jamais confondre les deux.
        val wsHost   = cfg.optStringOrNull("wsHost", sni)
        val network  = cfg.optStringOrNull("network", "tcp")
        val path     = cfg.optStringOrNull("path", "/")
        val tls      = cfg.optBoolean("tls", true)
        val insecure = cfg.optBoolean("insecure", cfg.optBoolean("allowInsecure", false))
        val flow     = cfg.optStringOrNull("flow", "")
        val privKey  = cfg.optStringOrNull("privateKey", "")
        val peerPub  = cfg.optStringOrNull("peerPublicKey", "")
        val localAddr = cfg.optStringOrNull("localAddress", "10.0.0.2/32")
        val fingerprint = cfg.optStringOrNull("fingerprint", "")

        // Champs produits par le dashboard (parseurs d'URI du backend) qui
        // n'étaient jamais transmis au moteur — un profil Reality ou gRPC était
        // donc traduit en TLS/WebSocket générique, que le serveur refuse.
        val alpn            = cfg.optStringOrNull("alpn", "")
        val grpcServiceName = cfg.optStringOrNull("grpcServiceName", "")
        val headerType      = cfg.optStringOrNull("headerType", "")
        val realityPubKey   = cfg.optStringOrNull("publicKey", "")
        val realityShortId  = cfg.optStringOrNull("shortId", "")
        val packetEncoding  = cfg.optStringOrNull("packetEncoding", "")
        val vmessSecurity   = cfg.optStringOrNull("security", "")
        val vmessAlterId    = cfg.optInt("alterId", 0)

        val transport = EngineTransport(
            sni = sni, wsHost = wsHost, network = network, path = path,
            tls = tls, insecure = insecure, fingerprint = fingerprint, alpn = alpn,
            grpcServiceName = grpcServiceName, headerType = headerType,
            // WireGuard réutilise `publicKey` pour la clé du pair : ne jamais
            // l'interpréter comme une clé Reality.
            realityPublicKey = if (protocol == "wireguard") "" else realityPubKey,
            realityShortId = realityShortId,
        )

        broadcastLog(
            "[CONFIG] proto=$protocol transport=${network.lowercase()} " +
            "tls=$tls reality=${transport.realityPublicKey.isNotBlank()} " +
            "alpn=${alpn.isNotBlank()} sni_set=${sni.isNotBlank()} host_hdr_set=${wsHost.isNotBlank()}"
        )

        // Preuve de séparation des rôles. Les noms d'hôte sont masqués dans les
        // journaux (politique de confidentialité) : on publie donc la RELATION
        // entre les trois valeurs, seule information utile au diagnostic.
        // `server` = adresse TCP jointe, `sni` = nom présenté en TLS,
        // `wsHost` = en-tête Host WebSocket. Les confondre est la panne classique
        // d'un profil « importé mais qui ne connecte pas ».
        broadcastLog(
            "[CONFIG] rôles: adresse_tcp_differe_du_sni=${!sni.equals(host, true)} " +
            "sni_egale_entete_ws=${sni.equals(wsHost, true)} " +
            "entete_ws_renseigne=${wsHost.isNotBlank()} " +
            "adresse_tcp_est_une_ip=${isLiteralIp(host)} chemin_ws=${if (path.isBlank()) "/" else path}"
        )

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
        val tunInbound = tunInbound()

        // DNS — le serveur défini sur le profil prime sur celui de l'application (§21).
        // Le domaine du serveur doit être résolu HORS tunnel, sinon sing-box
        // boucle : joindre le proxy exige sa résolution, qui exige le proxy.
        val dnsObj = applyDnsLoopGuard(
            profileDnsObject(cfg.optStringOrNull("dns", "")) ?: defaultDnsObject(),
            listOf(host),
        )

        // Outbound proxy selon protocole
        val proxyOutbound = when (protocol) {
            "vless" -> buildVlessOutbound(host, port, uuid, flow, packetEncoding, transport)
            "vmess" -> buildVmessOutbound(host, port, uuid, vmessSecurity, vmessAlterId, transport)
            "trojan" -> buildTrojanOutbound(host, port, password, transport)
            "shadowsocks" -> buildShadowsocksOutbound(host, port, password, method)
            "wireguard" -> buildWireGuardOutbound(host, port, privKey, peerPub, localAddr)
            "hysteria2" -> buildHysteria2Outbound(host, port, password, sni, tls)
            "tuic" -> buildTuicOutbound(host, port, uuid, password, sni, tls)
            else -> JSONObject().put("type", "direct").put("tag", "proxy")
        }

        // Route — D3: carrier exclusion FIRST (if host resolves)
        val exclusion = carrierExclusionRule(host)
        val routeRules = JSONArray()
        exclusion?.let { routeRules.put(it) }
        routeRules
            .put(JSONObject().put("protocol", "dns").put("outbound", "dns-out"))
            .put(JSONObject().put("ip_is_private", true).put("outbound", "direct"))

        val routeObj = JSONObject().apply {
            put("rules", routeRules)
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

    /**
     * Gabarit TUN de l'app — partagé entre buildSingBoxConfig (protocoles SXB
     * canoniques) et buildRawSingBoxConfig (sing-box importé / traduit).
     * JAMAIS de inbounds provenant du JSON stocké : le TUN est toujours celui-ci.
     */
    private fun tunInbound(): JSONObject = JSONObject().apply {
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

    /** DNS par défaut de l'app (utilisé quand le JSON stocké n'en fournit pas). */
    /**
     * §21 — DNS défini sur le profil du dashboard. Le champ `dns` était lu par le
     * backend et transmis jusqu'au mobile, mais le moteur imposait toujours son
     * DNS par défaut : un profil exigeant un résolveur interne ne résolvait rien.
     *
     * Accepte une IP (`1.1.1.1`), une URL (`https://…/dns-query`, `tls://…`) ou
     * `local`. Retourne null si la valeur est vide ou inexploitable, auquel cas
     * l'appelant conserve le DNS par défaut de l'application.
     */
    private fun profileDnsObject(raw: String): JSONObject? {
        val value = raw.trim()
        if (value.isEmpty()) return null
        val address = when {
            value.equals("local", ignoreCase = true) -> "local"
            value.contains("://") -> value
            // Une IP nue est utilisée telle quelle par sing-box (DNS classique).
            else -> value
        }
        return JSONObject().apply {
            put("servers", JSONArray()
                .put(JSONObject().put("tag", "dns-remote").put("address", address)
                    .put("strategy", dnsStrategy()).put("detour", "proxy"))
                // `local` déléguerait au résolveur Go, sans /etc/resolv.conf
                // sous Android : ce serveur ne résolvait donc jamais rien.
                .put(JSONObject().put("tag", "dns-local").put("address", bootstrapDnsAddress())
                    .put("strategy", dnsStrategy()).put("detour", "direct"))
                .put(JSONObject().put("tag", "dns-fake").put("address", "fakeip").put("detour", "direct"))
            )
            put("fakeip", JSONObject().put("enabled", true).put("inet4_range", "198.18.0.0/15"))
            put("rules", JSONArray()
                .put(JSONObject().put("query_type", JSONArray().put("A").put("AAAA")).put("server", "dns-fake"))
            )
            put("final", "dns-remote")
            put("independent_cache", true)
        }
    }

    private fun defaultDnsObject(detourTag: String = "proxy"): JSONObject = JSONObject().apply {
        put("servers", JSONArray()
            .put(JSONObject().put("tag", "dns-remote").put("address", "https://1.1.1.1/dns-query").put("strategy", dnsStrategy()).put("detour", detourTag))
            // Résolveur du réseau plutôt que `local` : voir systemDnsServers().
            .put(JSONObject().put("tag", "dns-local").put("address", bootstrapDnsAddress())
                .put("strategy", dnsStrategy()).put("detour", "direct"))
            .put(JSONObject().put("tag", "dns-fake").put("address", "fakeip").put("detour", "direct"))
        )
        put("fakeip", JSONObject()
            .put("enabled", true)
            .put("inet4_range", "198.18.0.0/15")
        )
        // D4 — DNS via tunnel : supprimer règle outbound=any → dns-local (garder fakeip + final dns-remote)
        put("rules", JSONArray()
            .put(JSONObject().put("query_type", JSONArray().put("A").put("AAAA")).put("server", "dns-fake"))
        )
        put("final", "dns-remote")
        put("independent_cache", true)
    }

    // ── Garde anti-boucle DNS ────────────────────────────────────────────────
    //
    // Symptôme corrigé ici : le tunnel monte, l'interface affiche « connecté »,
    // mais AUCUNE donnée ne passe et le moteur répète
    //   « DNS query loopback in transport[dns-remote] ».
    //
    // Cause : pour ouvrir la connexion vers un serveur désigné par un NOM DE
    // DOMAINE (`cdn.exemple.com`), sing-box doit d'abord le résoudre. Cette
    // résolution suit `dns.final` → `dns-remote`, qui porte `detour: proxy`.
    // Interroger ce DNS exige donc le proxy, dont l'ouverture exige la
    // résolution : sing-box détecte la récursion et casse toutes les
    // connexions. L'exclusion de route existante ne corrige pas ce cas — elle
    // agit sur des IP déjà résolues, jamais sur la résolution elle-même.
    //
    // Correctif : le domaine des serveurs de sortie est résolu par un serveur
    // joignable SANS le proxy, et tout DNS distant désigné par un nom d'hôte
    // reçoit un `address_resolver`.

    /** Vrai si la valeur est une IP littérale (aucune résolution nécessaire). */
    private fun isLiteralIp(value: String): Boolean {
        val v = value.trim().removePrefix("[").removeSuffix("]")
        if (v.isEmpty()) return false
        if (v.contains(':')) return true                       // IPv6
        if (!v.matches(Regex("^\\d{1,3}(\\.\\d{1,3}){3}$"))) return false
        return v.split('.').all { (it.toIntOrNull() ?: 256) <= 255 }
    }

    /** Nom d'hôte d'une adresse DNS ; vide pour `local`, `fakeip`, `dhcp://…`. */
    private fun dnsAddressHost(address: String): String {
        val a = address.trim()
        if (a.isEmpty()) return ""
        if (a.equals("local", ignoreCase = true) || a.equals("fakeip", ignoreCase = true)) return ""
        // `rcode://` ne désigne aucun serveur : la réponse est fabriquée sur
        // place. Sans cette exclusion, « rcode://success » passait pour l'hôte
        // « success » et se voyait attribuer un address_resolver inutile — cas
        // atteignable dès qu'une configuration sing-box importée en déclare un.
        if (a.startsWith("local://", ignoreCase = true) ||
            a.startsWith("dhcp://", ignoreCase = true) ||
            a.startsWith("rcode://", ignoreCase = true)) return ""
        val afterScheme = if (a.contains("://")) a.substringAfter("://") else a
        val hostPort = afterScheme.substringBefore('/')
        if (hostPort.startsWith("[")) return hostPort.substringAfter('[').substringBefore(']')
        return hostPort.substringBefore(':')
    }

    /**
     * Serveurs DNS du réseau courant (données mobiles ou Wi-Fi), lus auprès
     * d'Android.
     *
     * Indispensable : le transport `local` de sing-box délègue au résolveur Go,
     * qui cherche `/etc/resolv.conf`. Ce fichier n'existe pas sous Android, donc
     * Go retombe sur 127.0.0.1:53 et échoue — d'où les
     * « lookup … i/o timeout » (format d'erreur propre au résolveur Go) et le
     * « dial … connect: connection refused » observés en production.
     *
     * Ces adresses sont aussi les seules à emprunter le chemin décompté par
     * l'opérateur : sur un forfait zéro-rated, un DNS public serait facturé ou
     * filtré, alors que le résolveur de l'APN reste joignable.
     */
    private fun systemDnsServers(): List<String> = runCatching {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return@runCatching emptyList()
        // Le réseau physique, jamais notre propre TUN : sinon les requêtes DNS
        // rentreraient dans le tunnel qu'elles doivent précisément amorcer.
        val networks = cm.allNetworks.filter { network ->
            val caps = cm.getNetworkCapabilities(network) ?: return@filter false
            !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) &&
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        }
        val ordered = (listOfNotNull(cm.activeNetwork).filter { it in networks } + networks).distinct()
        ordered.asSequence()
            .mapNotNull { cm.getLinkProperties(it)?.dnsServers }
            .flatten()
            .mapNotNull { it.hostAddress }
            .filter { it.isNotBlank() && !it.startsWith("127.") && it != "::1" }
            .distinct()
            .toList()
    }.getOrDefault(emptyList())

    /** Adresse du serveur DNS d'amorçage : réseau courant, sinon repli public. */
    private fun bootstrapDnsAddress(): String {
        val system = systemDnsServers()
        if (system.isNotEmpty()) return system.first()
        // Repli seulement si Android ne publie aucun résolveur (cas rare, ex.
        // réseau en cours de bascule) : une IP littérale, donc sans résolution.
        broadcastLog("[DNS] aucun résolveur système exposé — repli sur 1.1.1.1")
        return "1.1.1.1"
    }

    /**
     * Vrai si le réseau physique porte une adresse IPv6 routable.
     *
     * Sur un réseau mobile IPv4 seul — le cas courant chez les opérateurs
     * africains — chaque requête AAAA reste sans réponse et occupe le résolveur
     * jusqu'à expiration (les 10 s visibles dans les journaux). Interroger
     * uniquement l'IPv4 supprime cette moitié perdue. La détection évite de
     * casser un réseau réellement IPv6.
     */
    private fun networkHasIpv6(): Boolean = runCatching {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return@runCatching false
        cm.allNetworks.any { network ->
            val caps = cm.getNetworkCapabilities(network) ?: return@any false
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return@any false
            if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return@any false
            cm.getLinkProperties(network)?.linkAddresses.orEmpty().any { linkAddress ->
                val addr = linkAddress.address
                addr is java.net.Inet6Address && !addr.isLinkLocalAddress && !addr.isLoopbackAddress
            }
        }
    }.getOrDefault(false)

    /** Stratégie de résolution adaptée à la pile IP réellement disponible. */
    private fun dnsStrategy(): String = if (networkHasIpv6()) "prefer_ipv4" else "ipv4_only"

    /**
     * Insère l'exclusion anti-boucle dans un bloc `dns` déjà construit.
     * `serverHosts` = adresses des serveurs de sortie (outbounds) ; seules les
     * valeurs non littérales exigent une résolution, donc un traitement.
     */
    private fun applyDnsLoopGuard(dns: JSONObject, serverHosts: Collection<String>): JSONObject {
        val servers = dns.optJSONArray("servers") ?: return dns

        // 1. Un serveur d'amorçage utilisable exige DEUX propriétés : sortir
        //    hors du proxy (`detour: direct`) ET être désigné par une IP
        //    littérale. Un `address: "local"` ne convient pas — il délègue au
        //    résolveur Go, inopérant sous Android (voir systemDnsServers()).
        var directTag = ""
        for (i in 0 until servers.length()) {
            val s = servers.optJSONObject(i) ?: continue
            val tag = s.optString("tag", "")
            if (tag.isEmpty() || s.optString("detour", "") != "direct") continue
            val addr = s.optString("address", "")
            if (addr.equals("fakeip", ignoreCase = true)) continue
            val host = dnsAddressHost(addr)
            if (host.isNotEmpty() && isLiteralIp(host)) { directTag = tag; break }
        }
        if (directTag.isEmpty()) {
            directTag = "dns-bootstrap"
            val bootstrap = bootstrapDnsAddress()
            val strategy = dnsStrategy()
            servers.put(JSONObject().put("tag", directTag).put("address", bootstrap)
                .put("strategy", strategy).put("detour", "direct"))
            broadcastLog("[DNS] amorçage via le résolveur du réseau ($bootstrap, $strategy)")
        }

        // 2. Un DNS distant nommé (ex. https://dns.google/…) doit indiquer par
        //    quel serveur résoudre son PROPRE nom, sinon il boucle sur lui-même.
        for (i in 0 until servers.length()) {
            val s = servers.optJSONObject(i) ?: continue
            if (s.optString("tag", "") == directTag || s.has("address_resolver")) continue
            val host = dnsAddressHost(s.optString("address", ""))
            if (host.isNotEmpty() && !isLiteralIp(host)) s.put("address_resolver", directTag)
        }

        // 3. Requêtes HTTPS/SVCB (RFC 9460) — cause directe des pages qui mettent
        //    dix secondes à démarrer. Navigateurs et applications Android les
        //    émettent avant chaque navigation. Aucune règle ne les capturait :
        //    elles partaient donc sur `final` → DoH À TRAVERS LE TUNNEL, et
        //    expiraient au bout de 10 s (« IN HTTPS: context deadline exceeded »)
        //    avant le repli sur A/AAAA.
        //
        //    `rcode://success` répond immédiatement NOERROR sans réponse : le
        //    client conclut « pas d'enregistrement HTTPS » et bascule aussitôt sur
        //    A/AAAA, qui sont servis par fakeip. Rien n'est émis sur le réseau,
        //    donc aucun domaine n'est exposé au résolveur de l'opérateur.
        //    (Adresse `rcode://` : syntaxe historique, valide en 1.11.)
        val blockTag = "dns-block"
        var hasBlockServer = false
        for (i in 0 until servers.length()) {
            if (servers.optJSONObject(i)?.optString("tag", "") == blockTag) { hasBlockServer = true; break }
        }
        if (!hasBlockServer) {
            servers.put(JSONObject().put("tag", blockTag).put("address", "rcode://success"))
        }

        // 4. Les domaines des serveurs de sortie se résolvent hors tunnel. Cette
        //    règle passe EN TÊTE : la règle fakeip capture sinon tout A/AAAA et
        //    renverrait une adresse fictive pour le serveur à joindre.
        val domains = serverHosts
            .map { it.trim() }
            .filter { it.isNotEmpty() && !isLiteralIp(it) }
            .distinct()

        val previous = dns.optJSONArray("rules") ?: JSONArray()
        val rules = JSONArray()
        rules.put(JSONObject()
            .put("query_type", JSONArray().put("HTTPS").put("SVCB"))
            .put("server", blockTag))
        if (domains.isNotEmpty()) {
            rules.put(JSONObject().put("domain", JSONArray(domains)).put("server", directTag))
        }
        for (i in 0 until previous.length()) rules.put(previous.opt(i))
        dns.put("rules", rules)

        if (domains.isNotEmpty()) {
            broadcastLog("[DNS] résolution hors tunnel pour ${domains.joinToString(", ")} (anti-boucle)")
        }
        broadcastLog("[DNS] requêtes HTTPS/SVCB court-circuitées (fin des attentes de 10 s)")
        return dns
    }

    /**
     * Construit la config libbox complète à partir d'un JSON sing-box stocké
     * (importé natif ou traduit depuis Xray/v2ray par le backend).
     *
     * RÈGLES (PARTIE 3) :
     *  - inbounds = TOUJOURS le TUN de l'app (jamais celui du JSON stocké).
     *  - dns = celui du JSON traduit sinon celui de l'app.
     *  - route.rules = règles DNS hijack + ip_cidr→direct (F3) PUIS les règles
     *    du JSON stocké ; route.final = celui du JSON stocké sinon tag du
     *    premier outbound non spécial ; auto_detect_interface = true.
     *  - log.level = warn.
     *  - Validation au démarrage : chaque outbound a un type connu ; tout
     *    detour référencé existe ; au moins un outbound non spécial.
     *    Échec → Exception claire (état error, pas de crash muet).
     */
    private fun stripUnsupportedSingBoxVlessFields(cfg: JSONObject): JSONObject {
        val outbounds = cfg.optJSONArray("outbounds") ?: return cfg
        for (i in 0 until outbounds.length()) {
            val outbound = outbounds.optJSONObject(i) ?: continue
            if (outbound.optString("type", "").equals("vless", ignoreCase = true) && outbound.has("encryption")) {
                outbound.remove("encryption")
                SxbSecureLogger.warn("SINGBOX_VLESS_ENCRYPTION_REMOVED")
            }
        }
        return cfg
    }

    private fun convertXrayToSingBoxIfNeeded(cfg: JSONObject): JSONObject {
        val rawOutbounds = cfg.optJSONArray("outbounds") ?: return cfg
        var isXray = false
        for (i in 0 until rawOutbounds.length()) {
            val o = rawOutbounds.optJSONObject(i) ?: continue
            if (o.has("protocol") || (o.has("settings") && o.optJSONObject("settings")?.has("vnext") == true)) {
                isXray = true
                break
            }
        }
        if (!isXray) return stripUnsupportedSingBoxVlessFields(cfg)
        val newOutbounds = JSONArray()
        for (i in 0 until rawOutbounds.length()) {
            val o = rawOutbounds.optJSONObject(i) ?: continue
            val proto = o.optString("protocol", "").lowercase()
            val tag = o.optString("tag", "proxy")
            val settings = o.optJSONObject("settings")
            val stream = o.optJSONObject("streamSettings")
            val proxySettings = o.optJSONObject("proxySettings")

            // Xray proxySettings.tag devient un detour sing-box. Toute conversion
            // doit conserver ce chaînage, sinon le transport en amont disparaît.
            fun preserveXrayDetour(outbound: JSONObject) {
                val proxyTag = proxySettings?.optString("tag", "") ?: ""
                if (proxyTag.isNotEmpty()) outbound.put("detour", proxyTag)
                
                // Support sockopt (TCP Fast Open)
                val sockopt = o.optJSONObject("sockopt")
                if (sockopt?.optBoolean("tcpFastOpen", false) == true) {
                    outbound.put("tcp_fast_open", true)
                }

                // Conserver uniquement le multiplexage TCP Xray pertinent pour
                // le transport VLESS/VMess. `xudpConcurrency` et
                // `xudpProxyUDP443` sont des réglages XUDP spécifiques à Xray :
                // sing-box 1.11 ne les traduit pas dans `multiplex`, et
                // `max_connections` est mutuellement exclusif avec `max_streams`.
                // Les copier mécaniquement peut donc faire rejeter la config ou
                // empoisonner le chemin TCP WS alors que le profil NPV ne fait
                // que rejeter son trafic UDP/443.
                val mux = o.optJSONObject("mux")
                if (mux?.optBoolean("enabled", false) == true) {
                    val concurrency = mux.optInt("concurrency", 0)
                    outbound.put("multiplex", JSONObject().apply {
                        put("enabled", true)
                        mux.optString("protocol", "smux").takeIf { it.isNotBlank() }?.let { put("protocol", it) }
                        if (concurrency > 0) put("max_streams", concurrency)
                    })
                    if (mux.has("xudpConcurrency") || mux.has("xudpProxyUDP443")) {
                        SxbSecureLogger.warn("XRAY_XUDP_OPTIONS_IGNORED_FOR_TCP_TRANSPORT")
                    }
                }
            }

            when (proto) {
                "vless", "vmess" -> {
                    val vnext = settings?.optJSONArray("vnext")?.optJSONObject(0)
                    val address = vnext?.optString("address", "") ?: ""
                    val port = vnext?.optInt("port", 443) ?: 443
                    val user = vnext?.optJSONArray("users")?.optJSONObject(0)
                    val uuid = user?.optString("id", "") ?: ""
                    val flow = user?.optString("flow", "") ?: ""
                    val xrayEncryption = user?.optString("encryption", "none") ?: "none"
                    // Xray place souvent `encryption: none` dans users[]. Sing-box
                    // VLESS 1.11.x ne possède pas ce champ dans l’outbound : le
                    // recopier produit `outbounds[0].encryption: unknown field`.
                    if (proto == "vless" && xrayEncryption.isNotBlank() && xrayEncryption != "none") {
                        SxbSecureLogger.warn("XRAY_VLESS_ENCRYPTION_UNSUPPORTED value=$xrayEncryption")
                    }

                    val sbOut = JSONObject().apply {
                        put("type", proto)
                        put("tag", tag)
                        put("server", address)
                        put("server_port", port)
                        put("uuid", uuid)
                        // Ne jamais mettre `encryption` dans l’outbound VLESS sing-box.
                        if (flow.isNotEmpty() && proto == "vless") put("flow", flow)
                        if (proto == "vmess") {
                            val alterId = user?.optInt("alterId", -1) ?: -1
                            if (alterId >= 0) put("alter_id", alterId)
                            user?.optString("security", "")
                                ?.takeIf { it.isNotBlank() && it != "auto" }
                                ?.let { put("security", it) }
                        }

                        if (stream != null) {
                            val security = stream.optString("security", "none")
                            if (security == "tls" || security == "reality") {
                                val tlsObj = stream.optJSONObject("tlsSettings") ?: stream.optJSONObject("realitySettings")
                                val fp = tlsObj?.optString("fingerprint", "") ?: ""
                                put("tls", JSONObject().apply {
                                    put("enabled", true)
                                    put("server_name", tlsObj?.optString("serverName", address) ?: address)
                                    put("insecure", tlsObj?.optBoolean("allowInsecure", true) ?: true)
                                    if (fp.isNotEmpty()) {
                                        put("utls", JSONObject().apply {
                                            put("enabled", true)
                                            put("fingerprint", fp)
                                        })
                                    }
                                    if (security == "reality") {
                                        put("reality", JSONObject().apply {
                                            put("enabled", true)
                                            put("public_key", tlsObj?.optString("publicKey", ""))
                                            put("short_id", tlsObj?.optString("shortId", ""))
                                        })
                                    }
                                })
                            }
                            val network = stream.optString("network", "tcp")
                            if (network == "ws" || network == "websocket") {
                                val ws = stream.optJSONObject("wsSettings")
                                put("transport", JSONObject().apply {
                                    put("type", "ws")
                                    put("path", ws?.optString("path", "/") ?: "/")
                                    val headers = ws?.optJSONObject("headers")
                                    if (headers != null) put("headers", headers)
                                })
                            } else if (network == "grpc") {
                                val grpc = stream.optJSONObject("grpcSettings")
                                put("transport", JSONObject().apply {
                                    put("type", "grpc")
                                    put("service_name", grpc?.optString("serviceName", "GunService") ?: "GunService")
                                })
                            }
                        }

                    }
                    preserveXrayDetour(sbOut)
                    newOutbounds.put(sbOut)
                }
                "trojan" -> {
                    val server = settings?.optJSONArray("servers")?.optJSONObject(0)
                    val address = server?.optString("address", "") ?: ""
                    val port = server?.optInt("port", 443) ?: 443
                    val password = server?.optString("password", "") ?: ""
                    if (address.isBlank() || password.isBlank()) {
                        throw Exception("outbound Xray Trojan \"$tag\" incomplet : serveur ou mot de passe absent")
                    }
                    val sbOut = JSONObject().apply {
                        put("type", "trojan")
                        put("tag", tag)
                        put("server", address)
                        put("server_port", port)
                        put("password", password)
                        val tlsSettings = stream?.optJSONObject("tlsSettings")
                        put("tls", JSONObject().apply {
                            put("enabled", true)
                            put("server_name", tlsSettings?.optString("serverName", address) ?: address)
                            put("insecure", tlsSettings?.optBoolean("allowInsecure", true) ?: true)
                        })
                        when (stream?.optString("network", "tcp")) {
                            "ws", "websocket" -> {
                                val ws = stream.optJSONObject("wsSettings")
                                put("transport", JSONObject().apply {
                                    put("type", "ws")
                                    put("path", ws?.optString("path", "/") ?: "/")
                                    ws?.optJSONObject("headers")?.let { put("headers", it) }
                                })
                            }
                            "grpc" -> {
                                val grpc = stream.optJSONObject("grpcSettings")
                                put("transport", JSONObject().apply {
                                    put("type", "grpc")
                                    put("service_name", grpc?.optString("serviceName", "GunService") ?: "GunService")
                                })
                            }
                        }
                    }
                    preserveXrayDetour(sbOut)
                    newOutbounds.put(sbOut)
                }
                "shadowsocks" -> {
                    val server = settings?.optJSONArray("servers")?.optJSONObject(0)
                    val address = server?.optString("address", "") ?: ""
                    val port = server?.optInt("port", 8388) ?: 8388
                    val method = server?.optString("method", "") ?: ""
                    val password = server?.optString("password", "") ?: ""
                    if (address.isBlank() || method.isBlank() || password.isBlank()) {
                        throw Exception("outbound Xray Shadowsocks \"$tag\" incomplet : serveur, méthode ou mot de passe absent")
                    }
                    val sbOut = JSONObject().apply {
                        put("type", "shadowsocks")
                        put("tag", tag)
                        put("server", address)
                        put("server_port", port)
                        put("method", method)
                        put("password", password)
                    }
                    preserveXrayDetour(sbOut)
                    newOutbounds.put(sbOut)
                }
                "socks" -> {
                    val srvs = settings?.optJSONArray("servers")?.optJSONObject(0)
                    val addr = srvs?.optString("address", "") ?: ""
                    val port = srvs?.optInt("port", 1080) ?: 1080
                    if (addr.isBlank()) throw Exception("outbound Xray SOCKS \"$tag\" sans serveur")
                    val sbOut = JSONObject().apply {
                        put("type", "socks")
                        put("tag", tag)
                        put("server", addr)
                        put("server_port", port)
                        val user = srvs?.optJSONArray("users")?.optJSONObject(0)
                        user?.optString("user", "")?.takeIf { it.isNotBlank() }?.let { put("username", it) }
                        user?.optString("pass", "")?.takeIf { it.isNotBlank() }?.let { put("password", it) }
                    }
                    preserveXrayDetour(sbOut)
                    newOutbounds.put(sbOut)
                }
                "http" -> {
                    val srvs = settings?.optJSONArray("servers")?.optJSONObject(0)
                    val addr = srvs?.optString("address", "") ?: ""
                    val port = srvs?.optInt("port", 8080) ?: 8080
                    val headers = settings?.optJSONObject("headers") ?: o.optJSONObject("headers")

                    val sbOut = JSONObject().apply {
                        put("type", "http")
                        put("tag", tag)
                        put("server", addr)
                        put("server_port", port)
                        // P7 — Fix headers http-upstream (MTN/Orange)
                        if (headers != null) {
                            // S'assurer que les headers sont bien propagés au CONNECT
                            put("headers", headers)
                            if (!headers.has("Host") && !headers.has("host")) {
                                // Fallback Host header si manquant
                                headers.put("Host", addr)
                            }
                        }
                    }
                    preserveXrayDetour(sbOut)
                    newOutbounds.put(sbOut)
                }
                "freedom" -> {
                    newOutbounds.put(JSONObject().put("type", "direct").put("tag", tag))
                }
                "blackhole" -> {
                    newOutbounds.put(JSONObject().put("type", "block").put("tag", tag))
                }
                "dns" -> {
                    newOutbounds.put(JSONObject().put("type", "dns").put("tag", tag))
                }
                else -> {
                    // Ne jamais ignorer un outbound Xray : une chaîne incomplète donnerait
                    // un tunnel déclaré connecté mais incapable de transporter le trafic.
                    throw Exception("outbound Xray non supporté par le moteur : \"$proto\"")
                }
            }
        }

        return JSONObject(cfg.toString()).apply {
            put("outbounds", newOutbounds)

            // Le serveur VLESS est protégé par la règle carrier exclusion ;
            // le DNS distant doit ensuite suivre ce proxy. Un detour direct
            // peut être bloqué par l’opérateur et produit un tunnel connecté
            // sans accès Internet.
            var dnsDetour = "direct"
            for (j in 0 until newOutbounds.length()) {
                val candidate = newOutbounds.optJSONObject(j) ?: continue
                val candidateType = candidate.optString("type", "")
                if (candidateType !in setOf("direct", "dns", "block")) {
                    val candidateTag = candidate.optString("tag", "")
                    if (candidateTag.isNotBlank()) {
                        dnsDetour = candidateTag
                        break
                    }
                }
            }

            // Les règles Xray utilisent outboundTag/inboundTag/ip alors que
            // sing-box attend outbound/inbound/ip_cidr.
            val xrayRouting = optJSONObject("routing")
            if (xrayRouting != null && !has("route")) {
                val convertedRules = JSONArray()
                val sourceRules = xrayRouting.optJSONArray("rules") ?: JSONArray()
                for (i in 0 until sourceRules.length()) {
                    val source = sourceRules.optJSONObject(i) ?: continue
                    val rule = JSONObject()
                    source.optString("outboundTag", "").takeIf { it.isNotBlank() }?.let { rule.put("outbound", it) }
                    
                    val inbounds = source.optJSONArray("inboundTag")
                    if (inbounds != null) {
                        val newInbounds = JSONArray()
                        for (j in 0 until inbounds.length()) {
                            val ib = inbounds.optString(j)
                            // Le JSON Xray utilise "tun" ou "tun-inbound" ;
                            // l'inbound Android réel créé par openTun() est "tun-in".
                            if (ib == "tun" || ib == "tun-inbound" || ib == "tun-in") newInbounds.put("tun-in") else newInbounds.put(ib)
                        }
                        rule.put("inbound", newInbounds)
                    }
                    
                    source.optJSONArray("ip")?.let { rule.put("ip_cidr", it) }
                    source.optJSONArray("domain")?.let { rule.put("domain", it) }
                    // Xray exporte parfois le port DNS sous forme de chaîne.
                    // Ne jamais router 1.1.1.1:53 via l’outbound VLESS : cela
                    // crée une boucle DNS (`DNS query loopback`) avant que le
                    // proxy puisse lui-même résoudre son serveur.
                    val sourcePort = source.opt("port")
                    val isDnsPort = when (sourcePort) {
                        is Number -> sourcePort.toInt() == 53
                        is String -> sourcePort.split(',', '-', ' ').any { it.trim().toIntOrNull() == 53 }
                        is JSONArray -> (0 until sourcePort.length()).any { sourcePort.optInt(it, -1) == 53 }
                        else -> false
                    }
                    if (isDnsPort) {
                        SxbSecureLogger.warn("XRAY_DNS_ROUTE_IGNORED port=53")
                        continue
                    }
                    if (source.has("port")) rule.put("port", source.opt("port"))
                    val networks = source.optString("network", "")
                    if (networks.isNotBlank()) {
                        rule.put("network", JSONArray(networks.split(',').map { it.trim() }.filter { it.isNotBlank() }))
                    }
                    if (rule.length() > 0) convertedRules.put(rule)
                }
                put("route", JSONObject().put("rules", convertedRules))
            }

            // Conversion DNS Xray vers le schéma sing-box. Les champs Xray
            // queryStrategy/serveStale/tag ne sont pas des champs DNS sing-box
            // modernes et peuvent faire refuser toute la configuration.
            val xrayDns = optJSONObject("dns")
            if (xrayDns != null) {
                val sourceServers = xrayDns.optJSONArray("servers") ?: JSONArray()
                val newServers = JSONArray()
                for (i in 0 until sourceServers.length()) {
                    val source = sourceServers.opt(i)
                    val server = when (source) {
                        is String -> JSONObject().apply {
                            val clean = source
                                .replace("tcp+local://", "tcp://")
                                .replace("udp+local://", "udp://")
                            put("address", clean)
                            put("detour", if (clean.equals("local", ignoreCase = true) || clean.startsWith("local://", ignoreCase = true)) "direct" else dnsDetour)
                        }
                        is JSONObject -> JSONObject(source.toString()).apply {
                            // Les DNS distants suivent le proxy VLESS ; `local`
                            // reste le seul resolver explicitement direct.
                            if (!has("detour")) {
                                val address = optString("address", "")
                                put("detour", if (address.equals("local", ignoreCase = true) || address.startsWith("local://", ignoreCase = true)) "direct" else dnsDetour)
                            }
                        }
                        else -> null
                    }
                    server?.let { newServers.put(it) }
                }

                val normalizedDns = JSONObject().apply {
                    put("servers", newServers)
                    val queryStrategy = xrayDns.optString("queryStrategy", "")
                    when (queryStrategy.lowercase(Locale.ROOT)) {
                        // « UseIPv4 » signifie IPv4 SEULE. La traduire en
                        // `prefer_ipv4` laissait partir une requête AAAA par
                        // résolution ; sans réponse sur un réseau IPv4, elle
                        // occupait le résolveur jusqu'à expiration (10 s).
                        "useipv4", "ipv4_only" -> put("strategy", "ipv4_only")
                        "useipv6", "ipv6_only" -> put("strategy", "ipv6_only")
                    }
                    xrayDns.optJSONArray("rules")?.let { put("rules", it) }
                    xrayDns.optString("final", "").takeIf { it.isNotBlank() }?.let { put("final", it) }
                    if (xrayDns.optBoolean("independent_cache", false)) put("independent_cache", true)
                }
                put("dns", normalizedDns)
            }
        }
    }

    /**
     * Normalise les profils importés plus anciens que le correctif du backend.
     * Ces profils peuvent rester chiffrés hors ligne après une mise à jour et
     * doivent donc être réparés côté mobile avant l'appel à libbox.
     */
    private fun normalizeRawSingBoxCompatibility(cfg: JSONObject): JSONObject {
        cfg.remove("protocol")

        var dnsDetour = "proxy"
        cfg.optJSONArray("outbounds")?.let { existingOutbounds ->
            for (i in 0 until existingOutbounds.length()) {
                val outbound = existingOutbounds.optJSONObject(i) ?: continue
                val type = outbound.optString("type", "")
                if (type !in setOf("direct", "dns", "block")) {
                    val outboundTag = outbound.optString("tag", "")
                    if (outboundTag.isNotBlank()) {
                        dnsDetour = outboundTag
                        break
                    }
                }
            }
        }

        // Les anciens imports acceptaient `dns.servers: ["8.8.8.8"]`.
        // sing-box 1.11 attend des objets DNSServerOptions.
        cfg.optJSONObject("dns")?.let { dns ->
            val servers = dns.optJSONArray("servers")
            if (servers != null) {
                val normalizedDnsServers = JSONArray()
                for (i in 0 until servers.length()) {
                    when (val source = servers.opt(i)) {
                        is String -> normalizedDnsServers.put(JSONObject().apply {
                            val address = source
                                .replace("tcp+local://", "tcp://", ignoreCase = true)
                                .replace("udp+local://", "udp://", ignoreCase = true)
                            put("address", address)
                            put("detour", if (address.equals("local", ignoreCase = true) || address.startsWith("local://", ignoreCase = true)) "direct" else dnsDetour)
                        })
                        is JSONObject -> normalizedDnsServers.put(JSONObject(source.toString()).apply {
                            if (!has("detour")) {
                                val address = optString("address", "")
                                put("detour", if (address.equals("local", ignoreCase = true) || address.startsWith("local://", ignoreCase = true)) "direct" else dnsDetour)
                            }
                        })
                    }
                }
                dns.put("servers", normalizedDnsServers)
            }
            // `dns.hosts` appartient aux anciens imports/Xray et n’existe pas
            // dans le schéma sing-box 1.11. La retirer évite un rejet global.
            if (dns.has("hosts")) {
                dns.remove("hosts")
                SxbSecureLogger.warn("SINGBOX_DNS_HOSTS_IGNORED_VERSION")
            }
        }

        // Les profils sing-box traduits avant le correctif DNS peuvent déjà
        // contenir une règle `route.rules[].port = 53` et ne repassent donc pas
        // par la branche Xray ci-dessus. La conserver envoie les requêtes DNS
        // vers l’outbound final (souvent VLESS) et recrée la dépendance
        // circulaire observée dans les logs. Le TUN de l’application fournit
        // déjà le hijack DNS : retirer uniquement ces règles historiques est
        // donc sûr et ne modifie pas les autres ports.
        cfg.optJSONObject("route")?.optJSONArray("rules")?.let { rules ->
            val retained = JSONArray()
            for (i in 0 until rules.length()) {
                val rule = rules.optJSONObject(i) ?: continue
                val sourcePort = rule.opt("port")
                val isDnsPort = when (sourcePort) {
                    is Number -> sourcePort.toInt() == 53
                    is String -> sourcePort.split(',', '-', ' ').any { it.trim().toIntOrNull() == 53 }
                    is JSONArray -> (0 until sourcePort.length()).any {
                        when (val item = sourcePort.opt(it)) {
                            is Number -> item.toInt() == 53
                            is String -> item.trim().toIntOrNull() == 53
                            else -> false
                        }
                    }
                    else -> false
                }
                if (isDnsPort) {
                    SxbSecureLogger.warn("SINGBOX_DNS_PORT_RULE_IGNORED port=53")
                } else {
                    retained.put(rule)
                }
            }
            cfg.optJSONObject("route")?.put("rules", retained)
        }

        val raw = cfg.optJSONArray("outbounds") ?: return cfg
        val normalized = JSONArray()
        val byTag = HashMap<String, JSONObject>()
        for (i in 0 until raw.length()) {
            val outbound = raw.optJSONObject(i) ?: continue
            val tag = outbound.optString("tag", "")
            val existing = if (tag.isNotBlank()) byTag[tag] else null
            if (existing != null) {
                // Les anciennes traductions pouvaient matérialiser le même
                // http-upstream deux fois. Fusionner uniquement les champs
                // absents, puis ne garder qu’un tag pour sing-box.
                if (existing.optString("type", "") != outbound.optString("type", "")) {
                    throw Exception("outbound tag dupliqué avec types différents : $tag")
                }
                val keys = outbound.keys()
                while (keys.hasNext()) {
                    val key = keys.next()
                    if (!existing.has(key) || existing.isNull(key)) existing.put(key, outbound.opt(key))
                }
                continue
            }

            val transport = outbound.optJSONObject("transport")
            if (transport != null && transport.optString("type", "").equals("ws", ignoreCase = true) && transport.has("host")) {
                val legacyHost = transport.opt("host")
                val headers = transport.optJSONObject("headers") ?: JSONObject()
                if (!headers.has("Host")) {
                    when (legacyHost) {
                        is String -> if (legacyHost.isNotBlank()) headers.put("Host", legacyHost)
                        is JSONArray -> if (legacyHost.length() > 0) headers.put("Host", legacyHost.optString(0))
                    }
                }
                transport.put("headers", headers)
                transport.remove("host")
                SxbSecureLogger.warn("SINGBOX_WS_HOST_NORMALIZED")
            }

            normalized.put(outbound)
            if (tag.isNotBlank()) byTag[tag] = outbound
        }
        cfg.put("outbounds", normalized)
        return cfg
    }

    private fun buildRawSingBoxConfig(rawCfg: JSONObject): String {
        val cfg = normalizeRawSingBoxCompatibility(convertXrayToSingBoxIfNeeded(rawCfg))
        val knownTypes = setOf(
            "vless", "vmess", "trojan", "shadowsocks", "wireguard", "hysteria2",
            "tuic", "hysteria", "ssh", "http", "socks", "direct", "dns", "block",
            "selector", "urltest",
        )
        val specialTypes = setOf("direct", "dns", "block")

        val rawOutbounds = cfg.optJSONArray("outbounds")
            ?: throw Exception("Configuration sing-box vide : champ \"outbounds\" manquant")
        if (rawOutbounds.length() == 0) throw Exception("Configuration sing-box vide : aucun outbound")

        val outbounds = JSONArray()
        val tags = HashSet<String>()
        val byTag = HashMap<String, JSONObject>()
        var mainTag: String? = null
        var mainServer = ""
        // Adresses de TOUS les maillons de sortie : sur une chaîne
        // (`detour`/`proxySettings`), chaque maillon désigné par un domaine doit
        // être résolu hors tunnel, pas seulement le premier.
        val outboundServerHosts = LinkedHashSet<String>()

        for (i in 0 until rawOutbounds.length()) {
            val o = rawOutbounds.optJSONObject(i) ?: continue
            val type = o.optString("type", "")
            if (type.isEmpty() || type !in knownTypes) {
                throw Exception("outbound inconnu : \"$type\" (type manquant ou non supporté par le moteur)")
            }
            val tag = o.optString("tag", "")
            tags.add(tag)
            if (tag.isNotEmpty()) byTag[tag] = o
            if (type !in specialTypes) {
                o.optString("server", "").takeIf { it.isNotBlank() }?.let { outboundServerHosts.add(it) }
            }
            if (mainTag == null && type !in specialTypes) {
                mainTag = tag
                mainServer = o.optString("server", "")
            }
            outbounds.put(o)
        }

        // Au moins un outbound non spécial (≠ direct/block/dns)
        if (mainTag.isNullOrEmpty()) {
            throw Exception("aucun outbound de transport (proxy) dans la configuration sing-box")
        }

        // Tout detour référencé doit exister
        for (i in 0 until outbounds.length()) {
            val o = outbounds.optJSONObject(i) ?: continue
            val detour = o.optString("detour", "")
            if (detour.isNotEmpty() && !tags.contains(detour)) {
                throw Exception("detour \"$detour\" référence un outbound inexistant")
            }
        }

        // Exclusion anti-boucle : c'est le serveur réellement contacté par le
        // socket sortant qui doit être exclu du TUN. Sur une configuration
        // chaînée (`proxySettings` Xray → `detour` sing-box), ce serveur est
        // celui du BOUT de la chaîne — l'amont HTTP — et non celui de l'outbound
        // principal. Exclure la mauvaise adresse laissait le socket physique
        // repasser par le tunnel qu'il alimente : boucle de routage immédiate.
        //
        // On repère d'abord la TÊTE de chaîne : un outbound cité en `detour` par
        // un autre est un maillon intermédiaire, jamais le point d'entrée du
        // trafic. Ce repli n'est utilisé que si `route.final` est absent.
        val detourTargets = HashSet<String>()
        for (i in 0 until outbounds.length()) {
            val o = outbounds.optJSONObject(i) ?: continue
            val detour = o.optString("detour", "")
            if (detour.isNotEmpty()) detourTargets.add(detour)
        }
        for (i in 0 until outbounds.length()) {
            val o = outbounds.optJSONObject(i) ?: continue
            val tag = o.optString("tag", "")
            if (tag.isEmpty() || tag in detourTargets) continue
            if (o.optString("type", "") in specialTypes) continue
            mainTag = tag
            break
        }

        mainTag?.let { start ->
            var current = byTag[start]
            val seen = HashSet<String>()
            var guard = 0
            while (current != null && guard++ < 8) {
                val detour = current.optString("detour", "")
                if (detour.isEmpty() || !seen.add(detour)) break
                current = byTag[detour] ?: break
            }
            val chainEndServer = current?.optString("server", "").orEmpty()
            if (chainEndServer.isNotBlank()) mainServer = chainEndServer
        }

        // Compléter avec les outbounds système de l'app si absents
        val appOutbounds = listOf("direct" to "direct", "dns" to "dns-out", "block" to "block")
        for ((type, tag) in appOutbounds) {
            if (!tags.contains(tag)) outbounds.put(JSONObject().put("type", type).put("tag", tag))
        }

        // Route : exclusion anti-boucle + DNS hijack + ip_is_private (F3) puis règles stockées
        val routeObj = cfg.optJSONObject("route")
        val storedRules = routeObj?.optJSONArray("rules") ?: JSONArray()

        // L'outbound qui porte réellement le trafic est celui désigné par
        // `route.final`. `mainTag` n'est qu'un repli : c'est le PREMIER outbound
        // non spécial du tableau, ce qui, sur une configuration chaînée
        // (`proxySettings` Xray → `detour`), désigne l'amont HTTP en clair et non
        // le tunnel chiffré.
        var finalTag = routeObj?.optString("final", "") ?: ""
        if (finalTag.isEmpty() || !tags.contains(finalTag)) finalTag = mainTag ?: "proxy"

        // DNS : celui du JSON stocké sinon celui de l'app
        // Les traductions Xray peuvent supprimer les DNS `tcp+local://` non
        // représentables dans sing-box. Le DNS DoH de secours doit alors sortir
        // par l'outbound qui transporte réellement les données.
        //
        // Il utilisait `mainTag` : sur une configuration à amont HTTP, les
        // requêtes DNS sortaient donc par le proxy en clair au lieu du tunnel,
        // exposant les domaines visités à l'opérateur de cet amont alors même que
        // l'utilisateur se croyait protégé. On suit désormais `route.final`.
        val configuredDns = cfg.optJSONObject("dns")
        val hasConfiguredDnsServers = configuredDns?.optJSONArray("servers")?.let { it.length() > 0 } == true
        // Le garde s'applique aussi au DNS venu du profil : un JSON fournisseur
        // qui route son DNS par le proxy produit exactement la même récursion.
        val dnsObj = applyDnsLoopGuard(
            if (hasConfiguredDnsServers) configuredDns!! else defaultDnsObject(finalTag),
            outboundServerHosts,
        )

        val exclusion = if (mainServer.isNotBlank()) carrierExclusionRule(mainServer) else null
        val routeRules = JSONArray()
        exclusion?.let { routeRules.put(it) }
        routeRules
            .put(JSONObject().put("protocol", "dns").put("outbound", "dns-out"))
            .put(JSONObject().put("ip_is_private", true).put("outbound", "direct"))
        for (i in 0 until storedRules.length()) {
            val r = storedRules.optJSONObject(i) ?: continue
            routeRules.put(r)
        }

        broadcastLog(
            "[CONFIG] singbox importé — outbounds=${outbounds.length()} final=$finalTag " +
            "chaînage=${finalTag != mainTag} dns=${if (hasConfiguredDnsServers) "profil" else "moteur→$finalTag"}"
        )

        return JSONObject().apply {
            put("log", JSONObject().put("level", "warn").put("timestamp", true))
            put("dns", dnsObj)
            put("inbounds", JSONArray().put(tunInbound()))
            put("outbounds", outbounds)
            put("route", JSONObject().apply {
                put("rules", routeRules)
                put("final", finalTag)
                // true → autoDetectInterfaceControl() → VpnService.protect() (anti-boucle)
                put("auto_detect_interface", true)
            })
        }.toString(2)
    }

    // ── Outbounds par protocole ───────────────────────────────────────────────

    /**
     * Paramètres de transport/sécurité d'un profil, extraits une seule fois puis
     * passés tels quels aux constructeurs d'outbound. Regrouper ces valeurs évite
     * qu'un champ du dashboard soit oublié au passage — cause principale des
     * profils « importés mais non fonctionnels ».
     */
    private data class EngineTransport(
        val sni: String,
        val wsHost: String,
        val network: String,
        val path: String,
        val tls: Boolean,
        val insecure: Boolean,
        val fingerprint: String,
        val alpn: String,
        val grpcServiceName: String,
        val headerType: String,
        val realityPublicKey: String,
        val realityShortId: String,
    )

    /** Applique la sécurité TLS et le transport d'un profil à un outbound. */
    private fun applyTransport(outbound: JSONObject, t: EngineTransport): JSONObject {
        outbound.put(
            "tls",
            buildTlsObj(t.sni, t.tls, t.insecure, t.fingerprint, t.alpn, t.realityPublicKey, t.realityShortId),
        )
        buildTransportObj(t.network, t.path, t.wsHost, t.grpcServiceName, t.headerType)
            ?.let { outbound.put("transport", it) }
        return outbound
    }

    private fun buildVlessOutbound(host: String, port: Int, uuid: String, flow: String,
                                    packetEncoding: String, t: EngineTransport): JSONObject {
        val outbound = JSONObject().apply {
            put("type", "vless")
            put("tag", "proxy")
            put("server", host)
            put("server_port", port)
            put("uuid", uuid)
            if (flow.isNotEmpty()) put("flow", flow)
            // §16/§23 — `packet_encoding` n'est posé que si le profil le demande.
            // L'imposer casserait le relais UDP sur les serveurs qui ne
            // l'implémentent pas, et reviendrait à codifier une valeur qui doit
            // venir du dashboard.
            if (packetEncoding.isNotEmpty()) put("packet_encoding", packetEncoding)
        }
        return applyTransport(outbound, t)
    }

    private fun buildVmessOutbound(host: String, port: Int, uuid: String, security: String,
                                    alterId: Int, t: EngineTransport): JSONObject {
        val outbound = JSONObject().apply {
            put("type", "vmess")
            put("tag", "proxy")
            put("server", host)
            put("server_port", port)
            put("uuid", uuid)
            // `security` et `alter_id` étaient figés à "auto"/0 : un profil VMess
            // exigeant aes-128-gcm ou un alterId non nul échouait à l'authentification.
            put("security", security.ifEmpty { "auto" })
            put("alter_id", alterId)
        }
        return applyTransport(outbound, t)
    }

    private fun buildTrojanOutbound(host: String, port: Int, password: String,
                                     t: EngineTransport): JSONObject {
        val outbound = JSONObject().apply {
            put("type", "trojan")
            put("tag", "proxy")
            put("server", host)
            put("server_port", port)
            put("password", password)
        }
        return applyTransport(outbound, t)
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

    private fun buildTlsObj(
        sni: String,
        enabled: Boolean,
        insecure: Boolean = false,
        fingerprint: String = "",
        alpn: String = "",
        realityPublicKey: String = "",
        realityShortId: String = "",
    ): JSONObject {
        return JSONObject().apply {
            put("enabled", enabled)
            if (sni.isNotEmpty()) put("server_name", sni)
            put("insecure", insecure)
            put("disable_sni", false)
            // L'ALPN provient du profil (`alpn=h2,http/1.1`). Il était ignoré :
            // un serveur qui impose h2 rejetait donc le handshake.
            csvToJsonArray(alpn)?.let { put("alpn", it) }
            // Reality — `pbk`/`sid` sont produits par le parseur d'URI du backend
            // mais n'étaient jamais transmis au moteur : la couche Reality était
            // silencieusement remplacée par du TLS classique, que le serveur
            // rejette systématiquement.
            if (realityPublicKey.isNotBlank()) {
                put("reality", JSONObject().apply {
                    put("enabled", true)
                    put("public_key", realityPublicKey)
                    if (realityShortId.isNotBlank()) put("short_id", realityShortId)
                })
            }
            // uTLS — empreinte du ClientHello TLS.
            //
            // Sans lui, sing-box émet le ClientHello de la bibliothèque Go :
            // une signature atypique, que les équipements d'inspection des
            // opérateurs mobiles reconnaissent et brident volontiers. C'est ce
            // qui distinguait SXB d'un client comme HTTP Custom sur le même
            // profil — ce dernier présente « chrome » par défaut et passe donc
            // pour un navigateur ordinaire.
            //
            // On aligne ce comportement : « chrome » dès que TLS est actif, sauf
            // empreinte explicitement demandée par le profil. uTLS reste par
            // ailleurs obligatoire pour Reality.
            val effectiveFingerprint = when {
                fingerprint.isNotBlank() -> fingerprint
                realityPublicKey.isNotBlank() -> "chrome"
                enabled -> "chrome"
                else -> ""
            }
            if (effectiveFingerprint.isNotBlank()) {
                put("utls", JSONObject().apply {
                    put("enabled", true)
                    put("fingerprint", effectiveFingerprint)
                })
            }
        }
    }

    /** `h2,http/1.1` → ["h2","http/1.1"]. Retourne null si rien d'exploitable. */
    private fun csvToJsonArray(csv: String): JSONArray? {
        val items = csv.split(',').map { it.trim() }.filter { it.isNotEmpty() }
        if (items.isEmpty()) return null
        return JSONArray().apply { items.forEach { put(it) } }
    }

    /**
     * Couche de transport unifiée (§9) : un profil ne doit jamais recevoir le
     * transport d'un autre. `null` signifie TCP nu — sing-box n'accepte pas de
     * `transport.type = "tcp"`, il faut alors omettre complètement le champ.
     *
     * `wsHost` (en-tête Host HTTP) est volontairement distinct de `sni` et de
     * `server` : ces trois valeurs peuvent différer et ne doivent jamais être
     * confondues (§11).
     */
    private fun buildTransportObj(
        network: String,
        path: String,
        wsHost: String,
        grpcServiceName: String,
        headerType: String,
    ): JSONObject? = when (network.lowercase()) {
        "ws", "websocket" -> buildWsTransport(path, wsHost)
        "grpc" -> buildGrpcTransport(grpcServiceName.ifEmpty { path.trim('/') })
        "http", "h2", "http2" -> JSONObject().apply {
            put("type", "http")
            if (path.isNotEmpty()) put("path", path)
            csvToJsonArray(wsHost)?.let { put("host", it) }
        }
        "httpupgrade" -> JSONObject().apply {
            put("type", "httpupgrade")
            if (path.isNotEmpty()) put("path", path)
            if (wsHost.isNotEmpty()) put("host", wsHost)
        }
        "quic" -> JSONObject().put("type", "quic")
        // TCP : seul `headerType=http` correspond à un transport sing-box.
        else -> if (headerType.equals("http", ignoreCase = true)) {
            JSONObject().apply {
                put("type", "http")
                if (path.isNotEmpty()) put("path", path)
                csvToJsonArray(wsHost)?.let { put("host", it) }
            }
        } else null
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
     * Anti-boucle porteur : exclusion explicite des IPs du serveur de transport
     * (SSH, VLESS, etc.) dans les règles de route TUN. Insérée EN PREMIÈRE.
     * Résout une fois (IPv4) et retourne la règle ip_cidr ou null.
     */
    private fun carrierExclusionRule(host: String): JSONObject? {
        val ips = runCatching {
            InetAddress.getAllByName(host)
                .filterIsInstance<java.net.Inet4Address>()
                .mapNotNull { it.hostAddress }
                .map { "$it/32" }
        }.getOrDefault(emptyList())
        if (ips.isEmpty()) return null
        return JSONObject().put("ip_cidr", JSONArray(ips)).put("outbound", "direct")
    }

    /**
     * Config TUN → SOCKS5 : fait entrer tout le trafic du système dans le
     * tunnel SSH, en le relayant vers le serveur SOCKS5 local alimenté par JSch.
     *
     * Comme pour buildSingBoxConfig(), le champ « file_descriptor » a disparu :
     * c'est openTun() qui fournit le TUN au moteur.
     */
    private fun buildSshSocksRelayConfig(host: String = ""): String {
        val exclusion = if (host.isNotBlank()) carrierExclusionRule(host) else null

        // Build rules manually: exclusion FIRST (if any), then protocol-dns, ip_is_private
        val routeRules = JSONArray()
        exclusion?.let { routeRules.put(it) }
        routeRules
            .put(JSONObject().put("protocol", "dns").put("outbound", "dns-out"))
            .put(JSONObject().put("ip_is_private", true).put("outbound", "direct"))

        return JSONObject().apply {
            put("log", JSONObject().put("level", "warn").put("timestamp", true))
            put("dns", applyDnsLoopGuard(JSONObject().apply {
                put("servers", JSONArray()
                    // Le DoH sort par `proxy` (le SOCKS local alimenté par SSH) ;
                    // `dns-l` utilisait `local`, inopérant sous Android — même
                    // panne que sur le chemin sing-box (voir systemDnsServers()).
                    .put(JSONObject().put("tag", "dns-r").put("address", "https://1.1.1.1/dns-query").put("strategy", dnsStrategy()))
                    .put(JSONObject().put("tag", "dns-l").put("address", bootstrapDnsAddress())
                        .put("strategy", dnsStrategy()).put("detour", "direct"))
                )
                // D4 — DNS via tunnel : supprimer règle outbound=any → dns-l
                put("final", "dns-r")
            }, listOfNotNull(host.takeIf { it.isNotBlank() })))
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
                    put("bind_interface", "lo")
                })
                .put(JSONObject().put("type", "direct").put("tag", "direct"))
                .put(JSONObject().put("type", "dns").put("tag", "dns-out"))
            )
            put("route", JSONObject().apply {
                put("rules", routeRules)
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
        val server = ServerSocket(SOCKS5_PORT, 50, InetAddress.getByName("127.0.0.1"))
        Log.i(TAG, "[SXB_DEBUG] SOCKS5_SERVER_BOUND address=${server.inetAddress.hostAddress} port=$SOCKS5_PORT")
        Thread({
            while (!server.isClosed && session.isConnected && running.get()) {
                try {
                    val client = server.accept()
                    broadcastLog("[SXB_TRACE] stage=SOCKS5_CLIENT_ACCEPT local_port=${client.localPort} remote_port=${client.port}")
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

            // Requête CONNECT (1=Connect, 2=Bind, 3=UDP Associate)
            val cmd = ByteArray(4); din.readFully(cmd)
            val command = cmd[1].toInt()
            broadcastLog("[SXB_TRACE] stage=SOCKS5_REQUEST command=$command address_type=${cmd[3].toInt()}")
            if (command != 1) {
                Log.w(TAG, "[SXB_DEBUG] SOCKS5_COMMAND_NOT_SUPPORTED cmd=$command (only CONNECT=1 supported over SSH)")
                dout.write(byteArrayOf(5, 7, 0, 1, 0, 0, 0, 0, 0, 0)); client.close(); return
            }

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
            broadcastLog("[SXB_TRACE] stage=SOCKS5_TARGET_RESOLVED port=$destPort host_present=${destHost.isNotBlank()}")

            // Ouvrir canal SSH direct-tcpip
            val channel = session.openChannel("direct-tcpip") as ChannelDirectTCPIP
            channel.setHost(destHost)
            channel.setPort(destPort)
            channel.setOrgIPAddress("127.0.0.1")
            channel.setOrgPort(SOCKS5_PORT)

            dout.write(byteArrayOf(5, 0, 0, 1, 0, 0, 0, 0, 0, 0)); dout.flush()
            channel.connect(15_000)
            broadcastLog("[SXB_TRACE] stage=SSH_DIRECT_TCPIP_CONNECTED port=$destPort")

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
            broadcastLog("[SXB_TRACE] stage=SOCKS5_RELAY_CLOSED upload_bytes=${uploadBytes.get()} download_bytes=${downloadBytes.get()}")
        } catch (e: Exception) {
            broadcastLog("[SXB_TRACE] stage=SOCKS5_ERROR type=${e.javaClass.simpleName}")
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
        // Les compteurs du relais SSH mesurent le contrôle/relayage et doublonnent
        // les octets des applications déjà comptés sur le TUN. Ils ne servent pas
        // de preuve de quota et ne sont jamais ajoutés aux statistiques exposées.
        return mapOf(
            "uploadBytes"   to stats.uploadBytes,
            "downloadBytes" to stats.downloadBytes,
            "uploadSpeed"   to stats.uploadSpeed,
            "downloadSpeed" to stats.downloadSpeed,
            "tunAttached"   to if (trafficManager.hasTunCounters()) 1L else 0L,
        )
    }

    fun getPerAppStats(): List<Map<String, Any>> {
        return trafficManager.getPerAppStats(this).map { info ->
            mapOf(
                "packageName"   to info.packageName,
                "appName"       to info.appName,
                "uploadBytes"   to info.uploadBytes,
                "downloadBytes" to info.downloadBytes,
                "totalBytes"    to info.totalBytes
            )
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // KILL SWITCH
    // ═════════════════════════════════════════════════════════════════════════

    fun setKillSwitch(enabled: Boolean) {
        killSwitchEnabled = enabled
        // Le kill switch est appliqué à la prochaine connexion (reconstruit le TUN)
        broadcastLog("[SXB] Kill Switch : ${if (enabled) "activé" else "désactivé"}")
        if (!enabled) removeKillSwitchBlackhole()
    }

    /**
     * B10 — Interface « trou noir » du kill switch.
     *
     * Sans elle, le kill switch se résumait à ne pas appeler `allowBypass()` sur le
     * TUN applicatif : dès que le tunnel tombait (fenêtre de reconnexion, ou abandon
     * après trois tentatives suivi d'un `stopSelf()`), l'interface disparaissait et
     * tout le trafic repartait en clair par le réseau sous-jacent — exactement ce que
     * l'option est censée empêcher.
     *
     * On installe donc une interface VPN sans route de sortie qui capte l'intégralité
     * du trafic IPv4 et IPv6 et le laisse mourir. Elle n'est créée que lorsque
     * l'utilisateur a explicitement activé le kill switch et qu'aucun tunnel réel
     * n'est actif : le comportement est inchangé pour tous les autres utilisateurs.
     */
    private fun installKillSwitchBlackhole(reason: String) {
        if (!killSwitchEnabled) return
        // Un arrêt définitif est en cours : ne pas créer une interface que
        // personne ne pourra plus retirer.
        if (cleanupStarted.get()) return
        if (killSwitchPfd != null) return
        if (tunPfd != null || boxService != null) return
        if (VpnService.prepare(this) != null) return

        val pfd = runCatching {
            val builder = Builder()
                .setSession("SXB VPN — Kill Switch")
                .setMtu(1500)
                .addAddress(KILL_SWITCH_ADDR_V4, 32)
                .addRoute("0.0.0.0", 0)
            runCatching { builder.addAddress(KILL_SWITCH_ADDR_V6, 128).addRoute("::", 0) }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) builder.setMetered(false)
            // Aucun allowBypass() : aucune application ne peut contourner l'interface.
            builder.establish()
        }.getOrNull()

        if (pfd == null) {
            Log.w(TAG, "[SXB_DEBUG] KILL_SWITCH_BLACKHOLE_FAILED reason=$reason")
            broadcastLog("[SXB] ⚠️ Kill Switch : blocage du trafic impossible")
            return
        }

        killSwitchPfd = pfd
        broadcastLog("[SXB] ⛔ Kill Switch actif — trafic bloqué ($reason)")
        runCatching { updateNotification("SXB VPN — Kill Switch : trafic bloqué") }

        // Purge du tampon d'entrée : sans lecteur, la file du TUN sature et
        // certaines versions d'Android journalisent des erreurs en boucle.
        killSwitchThread = Thread({
            val buffer = ByteArray(32 * 1024)
            runCatching {
                java.io.FileInputStream(pfd.fileDescriptor).use { input ->
                    while (killSwitchPfd === pfd && input.read(buffer) >= 0) { /* rejeté */ }
                }
            }
        }, "SXB-KillSwitch").apply { isDaemon = true; start() }
    }

    private fun removeKillSwitchBlackhole() {
        val pfd = killSwitchPfd ?: return
        killSwitchPfd = null
        killSwitchThread?.interrupt()
        killSwitchThread = null
        runCatching { pfd.close() }
        Log.i(TAG, "[SXB_DEBUG] KILL_SWITCH_BLACKHOLE_RELEASED")
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

    fun updateNotification(text: String) {
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
        val copy = synchronized(fullLogBuffer) { fullLogBuffer.toString() }
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

    /**
     * B8 — Plafond du tampon de logs.
     *
     * `broadcastLog()` est appelé plusieurs fois par seconde pendant une session
     * (statistiques de trafic, sondes réseau, traces libbox). Sans plafond, le
     * StringBuilder n'était jamais purgé et croissait indéfiniment jusqu'à
     * l'OutOfMemory sur les sessions longues. On conserve une fenêtre glissante
     * suffisante pour le diagnostic (~512 Ko ≈ dernières dizaines de milliers de
     * lignes) en découpant sur une fin de ligne pour ne pas tronquer au milieu.
     */
    private fun trimLogBufferLocked() {
        if (fullLogBuffer.length <= MAX_LOG_BUFFER_CHARS) return
        val target = fullLogBuffer.length - LOG_BUFFER_KEEP_CHARS
        val newlineAfterTarget = fullLogBuffer.indexOf("\n", target)
        val cutAt = if (newlineAfterTarget >= 0) newlineAfterTarget + 1 else target
        fullLogBuffer.delete(0, cutAt)
        fullLogBuffer.insert(0, "[SXB] … logs plus anciens tronqués (limite ${MAX_LOG_BUFFER_CHARS / 1024} Ko)\n")
    }

    /** Trace réseau détaillée, séquencée et systématiquement dépourvue de secrets. */
    private fun trace(stage: String, detail: String = "") {
        val seq = traceSequence.incrementAndGet()
        val elapsed = SystemClock.elapsedRealtime()
        val suffix = if (detail.isBlank()) "" else " $detail"
        broadcastLog("[SXB_TRACE] seq=$seq elapsed_ms=$elapsed stage=$stage$suffix")
    }

    private fun broadcastLog(message: String) {
        val safeMessage = if (SxbSecureLogger.isDiagnosticEnabled()) {
            SecurityModule.maskCredentialsOnly(message)
        } else {
            SecurityModule.maskSensitive(message)
        }
        Log.i(TAG, safeMessage)
        synchronized(fullLogBuffer) {
            fullLogBuffer.append(safeMessage).append("\n")
            trimLogBufferLocked()
        }

        // ⚡ Limitation de débit vers l'interface.
        //
        // Chaque diffusion traverse le pont React Native et provoque un rendu.
        // Le moteur peut émettre des rafales de plusieurs centaines de lignes par
        // seconde : sans plafond, le thread JS était saturé et l'application se
        // figeait. Le tampon complet, lui, conserve TOUTES les lignes et reste
        // accessible via le bouton « copier les journaux » — le diagnostic n'est
        // donc jamais amputé, seul l'affichage temps réel est allégé.
        val now = SystemClock.elapsedRealtime()
        val windowStart = logRateWindowStart.get()
        if (now - windowStart >= LOG_RATE_WINDOW_MS) {
            logRateWindowStart.set(now)
            logRateCount.set(0)
        }
        if (logRateCount.incrementAndGet() > LOG_RATE_MAX_PER_WINDOW) {
            if (logRateCount.get() == LOG_RATE_MAX_PER_WINDOW + 1) {
                sendLogBroadcast("[SXB] … journaux abondants — affichage allégé (tout est conservé)")
            }
            return
        }
        sendLogBroadcast(safeMessage)
    }

    private fun sendLogBroadcast(text: String) {
        // setPackage() obligatoire sur Android 14+ avec RECEIVER_NOT_EXPORTED
        val intent = Intent(BROADCAST_LOG).apply {
            putExtra("log", text)
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

    /**
     * P1 — Chiffre configJson (credentials VPN) avec AES-256-GCM Android Keystore.
     * @return true si le coffre chiffré `sxb_creds.enc` contient bien la configuration.
     *         Le résultat conditionne la purge des copies en clair : on ne supprime
     *         jamais la seule source de configuration encore lisible.
     */
    private fun persistEncryptedConfig(originalConfigJson: String): Boolean {
        return try {
            File(filesDir, "sxb_creds.enc").writeText(KeystoreManager.encrypt(originalConfigJson), Charsets.UTF_8)
            Log.i(TAG, "[P1] Config VPN chiffrée et persistée (AES-256-GCM) ✅")
            true
        } catch (e: Exception) {
            Log.w(TAG, "[P1] Chiffrement config échoué (Keystore non disponible?): ${e.message}")
            false
        }
    }

    /**
     * S1 — Purge des copies en clair des identifiants VPN.
     *
     * `SxbVpnModule.startVpn()` doit écrire la configuration complète (host, port,
     * username, password, uuid, clés privées) dans `sxb_pending_config.json` pour
     * contourner la limite ~1 Mo du Binder IPC. Ce fichier — ainsi que l'ancien
     * `sb_config.json` — restait ensuite indéfiniment en clair dans le stockage
     * privé de l'application, ce qui annulait le chiffrement AES-GCM ci-dessus.
     *
     * La purge n'est déclenchée qu'une fois `sxb_creds.enc` écrit et non vide :
     * un redémarrage START_STICKY dispose ainsi toujours d'une source de config.
     */
    private fun purgePlaintextConfigArtifacts(vararg extraPaths: String?) {
        val vault = File(filesDir, "sxb_creds.enc")
        if (!vault.exists() || vault.length() <= 0L) {
            Log.w(TAG, "[S1] Purge des copies en clair ignorée — coffre chiffré indisponible")
            return
        }
        val targets = mutableListOf(
            File(filesDir, "sxb_pending_config.json"),
            File(filesDir, "sb_config.json"),
        )
        extraPaths.filterNotNull().filter { it.isNotBlank() }.forEach { targets.add(File(it)) }

        targets.distinctBy { it.absolutePath }
            .filter { it.exists() && it.absolutePath != vault.absolutePath }
            .forEach { file ->
                val erased = runCatching {
                    // Écraser avant suppression : sur certains systèmes de fichiers un
                    // simple delete() laisse le contenu récupérable.
                    file.writeText("", Charsets.UTF_8)
                    file.delete()
                }.getOrDefault(false)
                Log.i(TAG, "[S1] Copie en clair purgée=${erased} name=${file.name}")
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

        trace("CLEANUP_START", "stop_service=$stopService keep_running=$keepRunning state=$currentState")
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

        // S1 — Ne jamais laisser une copie en clair des identifiants survivre à la session.
        if (stopService) runCatching { purgePlaintextConfigArtifacts() }

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
        // B10 — Fenêtre de reconnexion : sans interface de blocage le trafic
        // repartirait en clair entre deux tentatives.
        if (stopService) removeKillSwitchBlackhole()
        else if (keepRunning) runCatching { installKillSwitchBlackhole("reconnexion en cours") }
        if (stopService) SxbDefaultNetworkMonitor.stop()

        trafficManager.stop()
        if (stopService) autoReconnect.reset()

        if (stopService) {
            setCurrentState("disconnected")
            trace("CLEANUP_COMPLETE", "state=$currentState")
            broadcastStatus("disconnected")
        } else if (keepRunning) {
            // Cas Auto-reconnect : garder l'UI en "connecting" ou "retrying"
            // au lieu de retomber en "disconnected"
            setCurrentState("connecting")
            broadcastStatus("connecting")
            broadcastLog("🔄 Reconnexion automatique en cours...")
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

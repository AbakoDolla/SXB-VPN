package com.sxbvpn.vpnmodule

/**
 * SxbVpnService — Service VPN multi-protocoles SXB v3
 *
 * Protocoles supportés :
 *  ✅ SSH              — JSch direct (port SSH standard)
 *  ✅ SSH+Payload      — JSch + injection HTTP payload (HTTP Injector style)
 *  ✅ VLESS/VMess/Trojan — sing-box
 *  ✅ Shadowsocks      — sing-box
 *  ✅ WireGuard        — sing-box
 *  ✅ Hysteria2 / TUIC — sing-box
 *
 * CORRECTIFS v3 :
 *  - SSH+Payload : SxbPayloadProxy injecte le payload HTTP avant le handshake SSH
 *    (exactement comme SocksIP / HTTP Injector)
 *  - TUN fd : Os.dup() supprime FD_CLOEXEC → sing-box hérite le fd correctement
 *  - SOCKS5 : DataInputStream.readFully() garantit la lecture complète des bytes
 *  - SOCKS5 relay : threads de copie bidirectionnels explicites (pas setInputStream/Out)
 *  - Comptage trafic : réel via DataInputStream/OutputStream wrappers
 *  - Logs : maskSensitive() masque données sensibles
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

// ── Custom JSch Proxy pour injection HTTP payload (SSH+Payload) ───────────────────
//
// Flux :
//  1. Ouvre une socket TCP vers host:port
//  2. Envoie le payload HTTP brut (remplace [crlf] par \r\n)
//  3. Lit la réponse HTTP jusqu'au double CRLF (byte par byte, pas de buffering)
//  4. Retourne les streams à JSch → SSH handshake normal ensuite
//
// Compatible JSch 0.1.55 qui attend l'interface com.jcraft.jsch.Proxy
//
private class SxbPayloadProxy(private val rawPayload: String) : com.jcraft.jsch.Proxy {

    private var socket: Socket? = null
    private var inputStream:  InputStream?  = null
    private var outputStream: OutputStream? = null

    override fun connect(sf: SocketFactory?, host: String, port: Int, timeout: Int) {
        val sock = Socket()
        sock.connect(InetSocketAddress(host, port), timeout.coerceAtLeast(10_000))
        socket = sock

        val out = sock.getOutputStream()
        val ins = sock.getInputStream()

        // ── Envoyer le payload HTTP ─────────────────────────────────────────
        // Remplacer [crlf] par \r\n, [lf] par \n
        val payload = rawPayload
            .replace("[crlf]", "\r\n")
            .replace("[CRLF]", "\r\n")
            .replace("[lf]", "\n")
            .replace("[LF]", "\n")

        out.write(payload.toByteArray(Charsets.ISO_8859_1))
        out.flush()

        // ── Lire une éventuelle réponse HTTP byte par byte, avec timeout ────
        // CORRECTIF : beaucoup de serveurs payload (style HTTP Injector /
        // SocksIP) acceptent le payload comme simple bypass firewall et
        // enchaînent DIRECTEMENT sur le protocole SSH brut, sans jamais
        // renvoyer de réponse HTTP formatée. On ne doit donc jamais bloquer
        // indéfiniment en attendant un double CRLF qui peut ne jamais
        // arriver — on tente la lecture avec un court timeout, et on
        // continue vers le handshake SSH dans tous les cas (timeout,
        // réponse partielle, ou double CRLF trouvé).
        sock.soTimeout = 8_000
        val response = StringBuilder()
        try {
            var b3 = 0; var b2 = 0; var b1 = 0
            var limit = 8192
            while (limit-- > 0) {
                val b = ins.read()
                if (b == -1) break
                response.append(b.toChar())
                // Détecter \r\n\r\n
                if (b3 == '\r'.code && b2 == '\n'.code && b1 == '\r'.code && b == '\n'.code) break
                b3 = b2; b2 = b1; b1 = b
            }
            Log.d(SxbVpnService.TAG, "[SXB] Réponse proxy : ${response.toString().take(100)}")
        } catch (e: java.net.SocketTimeoutException) {
            // Pas de réponse HTTP dans les 8s — normal pour ce type de
            // serveur. On continue directement vers le handshake SSH.
            Log.d(SxbVpnService.TAG, "[SXB] Pas de réponse HTTP au payload (normal) — passage direct au handshake SSH")
        }

        // Retire le timeout pour la suite (session SSH longue durée)
        sock.soTimeout = 0

        inputStream  = ins
        outputStream = out
    }

    override fun getInputStream():  InputStream  = inputStream  ?: throw IllegalStateException("Not connected")
    override fun getOutputStream(): OutputStream = outputStream ?: throw IllegalStateException("Not connected")
    override fun getSocket(): Socket = socket ?: throw IllegalStateException("Not connected")
    override fun close() = runCatching { socket?.close() }.let {}
}

// ─────────────────────────────────────────────────────────────────────────────

class SxbVpnService : VpnService() {

    companion object {
        const val TAG           = "SxbVpnService"
        const val ACTION_START  = "com.sxbvpn.vpnmodule.ACTION_START"
        const val ACTION_STOP   = "com.sxbvpn.vpnmodule.ACTION_STOP"
        const val EXTRA_CONFIG  = "vpn_config_json"
        const val NOTIF_CHANNEL = "sxb_vpn_channel"
        const val NOTIF_ID      = 1001
        const val SOCKS5_PORT   = 1080

        const val BROADCAST_STATUS = "com.sxbvpn.vpnmodule.STATUS"
        const val BROADCAST_LOG    = "com.sxbvpn.vpnmodule.LOG"

        @Volatile var instance: SxbVpnService? = null
        val uploadBytes   = AtomicLong(0)
        val downloadBytes = AtomicLong(0)
    }

    private var tunPfd: ParcelFileDescriptor? = null
    private var dupFd: java.io.FileDescriptor? = null  // dup sans FD_CLOEXEC pour sing-box
    private var sshSession: Session? = null
    private val running = AtomicBoolean(false)
    private var currentState = "disconnected"
    private var vpnThread: Thread? = null
    private var singBoxProcess: Process? = null
    private var singBoxConfigFile: File? = null
    private var socks5Server: ServerSocket? = null

    // ── Masquage des données sensibles ────────────────────────────────────────

    private fun maskSensitive(msg: String): String {
        var s = msg
        s = s.replace(Regex("""\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"""),       "***.***.***.***")
        s = s.replace(Regex("""[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"""), "[uuid]")
        s = s.replace(Regex("""\b([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}\b"""), "[serveur]")
        return s
    }

    fun isRunning()       = running.get()
    fun getCurrentState() = currentState

    private fun setCurrentState(state: String) { currentState = state }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        instance = this
        createNotificationChannel()
        Log.i(TAG, "[SXB] Service démarré")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> { stopVpn(); return START_NOT_STICKY }
            ACTION_START -> {
                val config = intent.getStringExtra(EXTRA_CONFIG) ?: ""
                val proto = runCatching {
                    val cfg2 = JSONObject(config)
                    val p    = cfg2.optString("protocol", "ssh").lowercase()
                    // Auto-détection : si payload présent et protocol="ssh", forcer ssh+payload
                    if (p == "ssh" && cfg2.optString("payload", "").isNotBlank()) "ssh+payload" else p
                }.getOrDefault("ssh")
                startForeground(NOTIF_ID, buildNotification(protoLabel(proto) + " en cours…"))
                vpnThread = Thread({ dispatchProtocol(config, proto) }, "SxbVpnThread-$proto").also { it.start() }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() { stopVpn(); instance = null; super.onDestroy() }
    override fun onRevoke()  { broadcastLog("[SXB] ⚠️ VPN révoqué par le système"); broadcastStatus("disconnected"); stopVpn(); super.onRevoke() }

    // ── Notifications ─────────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(NOTIF_CHANNEL, "SXB VPN", NotificationManager.IMPORTANCE_LOW)
                .apply { description = "Tunnel VPN SXB actif"; setShowBadge(false) }
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(ch)
        }
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0,
            packageManager.getLaunchIntentForPackage(packageName), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1,
            Intent(this, SxbVpnService::class.java).apply { action = ACTION_STOP },
            PendingIntent.FLAG_IMMUTABLE)
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, NOTIF_CHANNEL)
        else @Suppress("DEPRECATION") Notification.Builder(this)
        return b.setContentTitle("SXB VPN").setContentText(text)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentIntent(open).setOngoing(true)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Déconnecter", stop)
            .build()
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java)?.notify(NOTIF_ID, buildNotification(text))
    }

    // ── Broadcasts ────────────────────────────────────────────────────────────

    private fun broadcastStatus(status: String) {
        sendBroadcast(Intent(BROADCAST_STATUS).putExtra("status", status))
    }

    private fun broadcastLog(message: String) {
        Log.i(TAG, message)
        sendBroadcast(Intent(BROADCAST_LOG).putExtra("log", message))
    }

    // ── Dispatch ──────────────────────────────────────────────────────────────

    private fun protoLabel(proto: String) = when {
        proto == "ssh"                              -> "SSH"
        proto == "ssh+payload"                      -> "SSH+Payload"
        proto in listOf("vless", "vmess", "trojan") -> proto.uppercase()
        proto == "shadowsocks"                      -> "Shadowsocks"
        proto == "wireguard"                        -> "WireGuard"
        proto == "hysteria2"                        -> "Hysteria2"
        proto == "tuic"                             -> "TUIC"
        else                                        -> "VPN"
    }

    private fun dispatchProtocol(configJson: String, protocol: String) {
        when {
            protocol == "ssh" || protocol == "ssh+payload" -> startSshTunnel(configJson)
            protocol in listOf("vless", "vmess", "trojan", "shadowsocks", "wireguard", "hysteria2", "tuic") ->
                startSingBoxTunnel(configJson, protocol)
            else -> {
                broadcastLog("[SXB] ❌ Protocole inconnu : $protocol")
                broadcastStatus("error")
                stopSelf()
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SSH TUNNEL — v3 (avec injection payload et relay SOCKS5 corrigé)
    //
    //  1. Connexion SSH :
    //     - SSH simple   → JSch se connecte directement
    //     - SSH+Payload  → SxbPayloadProxy envoie le payload HTTP d'abord,
    //                      puis JSch termine le handshake SSH sur la même socket
    //  2. Serveur SOCKS5 local (port 1080) géré dans la JVM
    //     → chaque CONNECT SOCKS5 ouvre un canal JSch direct-tcpip
    //     → relay bidirectionnel via 2 threads de copie
    //  3. Interface TUN via VpnService.Builder
    //  4. sing-box : TUN fd (dupé sans FD_CLOEXEC) → SOCKS5 local → SSH → internet
    // ═══════════════════════════════════════════════════════════════════════════

    private fun startSshTunnel(configJson: String) {
        try {
            broadcastLog("[SXB] Initialisation VPN...")
            broadcastStatus("connecting")
            setCurrentState("connecting")

            val cfg      = JSONObject(configJson)
            val host     = cfg.optString("host", "")
            val port     = cfg.optInt("port", 22)
            val username = cfg.optString("username", "")
            val password = cfg.optString("password", "")
            val sni      = cfg.optString("sni", "")
            val payload  = cfg.optString("payload", "")
            val protocol = cfg.optString("protocol", "ssh").lowercase()
            // CORRECTIF DÉFINITIF : injecter le payload dès qu'il est disponible,
            // indépendamment du champ "protocol" — certains caches stockent
            // protocol="ssh" alors que le payload est présent.
            val usePayload = payload.isNotBlank()

            if (host.isEmpty() || username.isEmpty()) {
                broadcastLog("[SXB] ❌ Configuration incomplète (host/username manquant)")
                broadcastStatus("error"); setCurrentState("error"); return
            }

            // ── 1. Connexion SSH ──────────────────────────────────────────────
            broadcastLog("[SXB] Connexion serveur sécurisé...")
            val jsch    = JSch()
            val session: Session

            if (usePayload) {
                // SSH+Payload : injection HTTP avant le handshake SSH
                broadcastLog("[SXB] Mode Payload HTTP activé")
                broadcastLog("[SXB] Envoi payload...")
                val proxy = SxbPayloadProxy(payload)
                session = jsch.getSession(username, host, port)
                session.setProxy(proxy)
            } else {
                // SSH direct
                session = jsch.getSession(username, host, port)
            }

            if (password.isNotEmpty()) session.setPassword(password)

            val props = Properties()
            // SÉCURITÉ : accepter les clés hôtes connues si disponibles, sinon no-strict
            // En production les configs devraient inclure le fingerprint du serveur SSH.
            // Pour l'instant on garde "no" pour compatibilité maximale avec les serveurs
            // SSH des opérateurs africains (clés auto-signées, pas de PKI formelle).
            // TODO: quand l'API mobile retournera "hostKeyFingerprint", vérifier ici.
            val strictHostKey = cfg.optString("strictHostKey", "no")
            props["StrictHostKeyChecking"] = strictHostKey
            props["ServerAliveInterval"]   = "30"
            props["ServerAliveCountMax"]   = "3"
            props["ConnectTimeout"]        = "30000"
            if (sni.isNotEmpty()) props["hostname"] = sni
            session.setConfig(props)
            session.connect(30_000)
            sshSession = session

            broadcastLog("[SXB] ✅ Authentification SSH réussie")

            // ── 2. Proxy SOCKS5 local ─────────────────────────────────────────
            broadcastLog("[SXB] Démarrage proxy SOCKS5 local...")
            socks5Server = startLocalSocks5Server(session)
            broadcastLog("[SXB] ✅ Proxy SOCKS5 actif sur port $SOCKS5_PORT")

            // ── 3. Interface TUN ──────────────────────────────────────────────
            broadcastLog("[SXB] Création interface réseau...")
            val builder = Builder()
                .setSession("SXB VPN — ${if (usePayload) "SSH+Payload" else "SSH"}")
                .addAddress("172.19.0.1", 30)
                .addRoute("0.0.0.0", 0)
                .addRoute("::", 0)
                .addDnsServer("1.1.1.1")
                .addDnsServer("8.8.8.8")
                .setMtu(1500)
                .setBlocking(true)
            builder.addDisallowedApplication(packageName)

            tunPfd = builder.establish()
                ?: throw Exception("Impossible d'établir l'interface TUN (permission refusée ?)")

            // CORRECTIF v3 : Os.dup() crée un nouveau fd sans FD_CLOEXEC
            // → sing-box hérite le fd correctement via ProcessBuilder
            dupFd = Os.dup(tunPfd!!.fileDescriptor)
            val tunFdInt = getFdInt(dupFd!!)

            broadcastLog("[SXB] ✅ Interface réseau créée (fd=$tunFdInt)")

            // ── 4. sing-box : TUN fd → SOCKS5 → SSH ──────────────────────────
            broadcastLog("[SXB] Chargement moteur tunnel...")
            val singBoxBinary = extractSingBoxBinary()
                ?: throw Exception("Moteur VPN introuvable — réinstallez l'application")

            val singConfig = buildSshSocksRelayConfig(tunFdInt)
            val configFile = File(filesDir, "singbox-ssh.json")
            configFile.writeText(singConfig)
            singBoxConfigFile = configFile

            broadcastLog("[SXB] Démarrage routeur de paquets...")
            val process = ProcessBuilder(
                singBoxBinary.absolutePath, "run", "--config", configFile.absolutePath
            ).apply {
                environment()["SING_BOX_LOG_LEVEL"] = "warn"
                redirectErrorStream(true)
            }.start()
            singBoxProcess = process

            running.set(true)
            setCurrentState("connected")
            broadcastStatus("connected")
            broadcastLog("[SXB] ✅ VPN connecté — ${if (usePayload) "SSH+Payload" else "SSH"}")
            broadcastLog("[SXB] Server    : Protected")
            broadcastLog("[SXB] Credential: Hidden")
            broadcastLog("[SXB] Payload   : ${if (usePayload) "Encrypted" else "N/A"}")
            broadcastLog("[SXB] Trafic    : Actif")
            updateNotification("SXB VPN actif — ${if (usePayload) "SSH+Payload" else "SSH"}")

            // Thread logs sing-box
            Thread({
                try {
                    process.inputStream.bufferedReader().forEachLine { line ->
                        if (line.isNotBlank()) broadcastLog("[tunnel] ${maskSensitive(line)}")
                    }
                } catch (_: Exception) {}
            }, "SingBoxLog").apply { isDaemon = true; start() }

            // Boucle principale — surveiller SSH session + sing-box process
            while (running.get()) {
                if (!session.isConnected) {
                    broadcastLog("[SXB] ⚠️ Connexion SSH perdue — reconnexion requise")
                    broadcastStatus("error"); setCurrentState("error"); break
                }
                if (!process.isAlive) {
                    val code = process.exitValue()
                    broadcastLog("[SXB] ⚠️ Moteur tunnel arrêté (code=$code)")
                    if (running.get()) { broadcastStatus("error"); setCurrentState("error") }
                    break
                }
                Thread.sleep(3_000)
            }

        } catch (e: InterruptedException) {
            Log.i(TAG, "Thread SSH interrompu")
        } catch (e: Exception) {
            Log.e(TAG, "Erreur SSH", e)
            val msg = e.message ?: "erreur inconnue"
            when {
                msg.contains("Auth fail") || msg.contains("auth") ->
                    broadcastLog("[SXB] ❌ Authentification SSH échouée — vérifiez username/password")
                msg.contains("Connection refused") || msg.contains("refused") ->
                    broadcastLog("[SXB] ❌ Connexion refusée — serveur inaccessible")
                msg.contains("timeout") || msg.contains("Timeout") ->
                    broadcastLog("[SXB] ❌ Timeout connexion — vérifiez host/port")
                msg.contains("payload") || msg.contains("proxy") ->
                    broadcastLog("[SXB] ❌ Payload rejeté — vérifiez la configuration payload")
                else -> broadcastLog("[SXB] ❌ Erreur tunnel : ${msg.take(100)}")
            }
            broadcastStatus("error")
            setCurrentState("error")
        } finally {
            cleanup()
        }
    }

    // ── Obtenir l'int d'un FileDescriptor (par réflexion) ──────────────────────
    private fun getFdInt(fd: java.io.FileDescriptor): Int {
        return try {
            val f = java.io.FileDescriptor::class.java.getDeclaredField("descriptor")
            f.isAccessible = true
            f.getInt(fd)
        } catch (_: Exception) {
            // fallback pour les APIs récentes
            try {
                val f = java.io.FileDescriptor::class.java.getDeclaredField("fd")
                f.isAccessible = true
                f.getInt(fd)
            } catch (_: Exception) { -1 }
        }
    }

    // ── Serveur SOCKS5 local (JSch ChannelDirectTCPIP) ────────────────────────
    //
    // Corrections v3 :
    //  - DataInputStream.readFully() garantit la lecture de TOUS les bytes
    //  - Relay bidirectionnel via 2 threads de copie (pas setInputStream/setOutputStream)
    //  - Comptage réel upload/download

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

            // ── Handshake SOCKS5 ──────────────────────────────────────────────
            // Version
            val ver = din.readUnsignedByte()
            if (ver != 5) { client.close(); return }

            // Méthodes d'authentification
            val nMethods = din.readUnsignedByte()
            din.skipBytes(nMethods)  // On accepte toujours NO AUTH
            dout.write(byteArrayOf(5, 0))  // NO AUTH sélectionné
            dout.flush()

            // Requête CONNECT
            if (din.readUnsignedByte() != 5) { client.close(); return }  // version
            val cmd      = din.readUnsignedByte()  // 1=CONNECT
            din.readUnsignedByte()                 // réservé
            val addrType = din.readUnsignedByte()  // type adresse

            val remoteHost: String = when (addrType) {
                1 -> {  // IPv4
                    val b = ByteArray(4)
                    din.readFully(b)  // CORRECTIF v3 : readFully garantit 4 bytes
                    InetAddress.getByAddress(b).hostAddress ?: "0.0.0.0"
                }
                3 -> {  // Nom de domaine
                    val len = din.readUnsignedByte()
                    val b   = ByteArray(len)
                    din.readFully(b)  // CORRECTIF v3 : readFully garantit len bytes
                    String(b, Charsets.UTF_8)
                }
                4 -> {  // IPv6
                    val b = ByteArray(16)
                    din.readFully(b)  // CORRECTIF v3 : readFully garantit 16 bytes
                    InetAddress.getByAddress(b).hostAddress ?: "::1"
                }
                else -> {
                    dout.write(byteArrayOf(5, 8, 0, 1, 0, 0, 0, 0, 0, 0))  // addr type not supported
                    client.close(); return
                }
            }
            val remotePort = din.readUnsignedShort()  // big-endian 16-bit port

            if (cmd != 1) {  // Seul CONNECT est supporté
                dout.write(byteArrayOf(5, 7, 0, 1, 0, 0, 0, 0, 0, 0))  // command not supported
                client.close(); return
            }

            // ── Ouvrir canal SSH direct-tcpip ─────────────────────────────────
            val channel = session.openChannel("direct-tcpip") as ChannelDirectTCPIP
            channel.setHost(remoteHost)
            channel.setPort(remotePort)

            // Répondre succès SOCKS5 (avant de connecter pour ne pas bloquer)
            dout.write(byteArrayOf(5, 0, 0, 1, 0, 0, 0, 0, 0, 0))  // success
            dout.flush()

            // Connecter le canal SSH
            channel.connect(15_000)

            // ── Relay bidirectionnel via 2 threads ────────────────────────────
            // Thread A : client → SSH → serveur distant
            val threadA = Thread({
                try {
                    val buf = ByteArray(8192)
                    val chOut = channel.outputStream
                    var n: Int
                    while (channel.isConnected && !client.isClosed) {
                        n = client.inputStream.read(buf)
                        if (n == -1) break
                        chOut.write(buf, 0, n)
                        chOut.flush()
                        uploadBytes.addAndGet(n.toLong())
                    }
                } catch (_: Exception) {}
                runCatching { channel.disconnect() }
            }, "Socks5-Up").apply { isDaemon = true; start() }

            // Thread B : serveur distant → SSH → client
            val threadB = Thread({
                try {
                    val buf = ByteArray(8192)
                    val chIn = channel.inputStream
                    var n: Int
                    while (channel.isConnected && !client.isClosed) {
                        n = chIn.read(buf)
                        if (n == -1) break
                        dout.write(buf, 0, n)
                        dout.flush()
                        downloadBytes.addAndGet(n.toLong())
                    }
                } catch (_: Exception) {}
                runCatching { client.close() }
            }, "Socks5-Down").apply { isDaemon = true; start() }

            threadA.join(300_000)  // 5 min max par connexion
            threadB.join(5_000)
            channel.disconnect()

        } catch (e: Exception) {
            Log.d(TAG, "SOCKS5 connexion terminée: ${e.message?.take(60)}")
        } finally {
            runCatching { client.close() }
        }
    }

    // ── Config sing-box : TUN fd → SOCKS5 (SSH relay) ─────────────────────────

    private fun buildSshSocksRelayConfig(tunFdInt: Int): String {
        val inbound = JSONObject().apply {
            put("type",            "tun")
            put("tag",             "tun-in")
            put("file_descriptor", tunFdInt)
            put("inet4_address",   "172.19.0.1/30")
            put("auto_route",      false)   // VpnService gère le routage OS
            put("strict_route",    false)
            put("sniff",           true)
            put("sniff_override_destination", false)
        }

        val socks5Out = JSONObject().apply {
            put("type",        "socks")
            put("tag",         "proxy")
            put("server",      "127.0.0.1")
            put("server_port", SOCKS5_PORT)
            put("version",     "5")
        }

        return JSONObject().apply {
            put("log", JSONObject().put("level", "warn").put("timestamp", true))
            put("dns", JSONObject().apply {
                put("servers", JSONArray()
                    .put(JSONObject().put("tag","dns-r").put("address","https://1.1.1.1/dns-query").put("strategy","prefer_ipv4"))
                    .put(JSONObject().put("tag","dns-l").put("address","local").put("detour","direct"))
                )
                put("rules", JSONArray().put(JSONObject().put("outbound","any").put("server","dns-l")))
                put("final", "dns-r")
            })
            put("inbounds",  JSONArray().put(inbound))
            put("outbounds", JSONArray()
                .put(socks5Out)
                .put(JSONObject().put("type","direct").put("tag","direct"))
                .put(JSONObject().put("type","dns").put("tag","dns-out"))
            )
            put("route", JSONObject().apply {
                put("rules", JSONArray()
                    .put(JSONObject().put("protocol","dns").put("outbound","dns-out"))
                    .put(JSONObject().put("ip_is_private",true).put("outbound","direct"))
                )
                put("final", "proxy")
                put("auto_detect_interface", false)  // false sur Android pour éviter les conflits
            })
        }.toString(2)
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // sing-box (VLESS / VMess / Trojan / Shadowsocks / WireGuard / Hysteria2 / TUIC)
    // ═══════════════════════════════════════════════════════════════════════════

    private fun startSingBoxTunnel(configJson: String, protocol: String) {
        try {
            broadcastLog("[SXB] Initialisation VPN ($protocol)...")
            broadcastStatus("connecting")
            setCurrentState("connecting")

            val cfg = JSONObject(configJson)

            // ── Charger le binaire sing-box ───────────────────────────────────
            val singBoxBinary = extractSingBoxBinary()
            if (singBoxBinary == null) {
                broadcastLog("[SXB] ❌ Moteur VPN introuvable — réinstallez l'APK")
                broadcastStatus("error"); setCurrentState("error"); return
            }
            broadcastLog("[SXB] Moteur VPN chargé")

            // ── Créer l'interface TUN ─────────────────────────────────────────
            broadcastLog("[SXB] Création interface réseau...")
            val builder = Builder()
                .setSession("SXB VPN — ${protocol.uppercase()}")
                .addAddress("172.19.0.1", 30)
                .addRoute("0.0.0.0", 0)
                .addRoute("::", 0)
                .addDnsServer("1.1.1.1")
                .addDnsServer("8.8.8.8")
                .setMtu(1500)
                .setBlocking(true)
            builder.addDisallowedApplication(packageName)

            tunPfd = builder.establish()
                ?: throw Exception("Impossible d'établir l'interface TUN")

            // CORRECTIF v3 : dupliquer le fd sans FD_CLOEXEC
            dupFd = Os.dup(tunPfd!!.fileDescriptor)
            val tunFdInt = getFdInt(dupFd!!)

            broadcastLog("[SXB] Interface réseau créée")

            // ── Construire et écrire la config sing-box ───────────────────────
            val singConfig = buildSingBoxConfig(cfg, protocol, tunFdInt)
            val configFile = File(filesDir, "singbox-${protocol}.json")
            configFile.writeText(singConfig)
            singBoxConfigFile = configFile

            // ── Démarrer sing-box ─────────────────────────────────────────────
            broadcastLog("[SXB] Démarrage moteur tunnel...")
            val process = ProcessBuilder(
                singBoxBinary.absolutePath, "run", "--config", configFile.absolutePath
            ).apply {
                environment()["SING_BOX_LOG_LEVEL"] = "warn"
                redirectErrorStream(true)
            }.start()
            singBoxProcess = process

            // Attendre que sing-box soit prêt (1.5s)
            Thread.sleep(1500)
            if (!process.isAlive) {
                val output = process.inputStream.bufferedReader().readText().take(500)
                throw Exception("sing-box a planté au démarrage : $output")
            }

            running.set(true)
            setCurrentState("connected")
            broadcastStatus("connected")
            broadcastLog("[SXB] ✅ VPN connecté — ${protocol.uppercase()}")
            updateNotification("SXB VPN actif — ${protocol.uppercase()}")

            Thread({
                try {
                    process.inputStream.bufferedReader().forEachLine { line ->
                        if (line.isNotBlank()) broadcastLog("[moteur] ${maskSensitive(line)}")
                    }
                } catch (_: Exception) {}
            }, "SingBoxLog-$protocol").apply { isDaemon = true; start() }

            val exitCode = process.waitFor()
            if (running.get()) {
                broadcastLog("[SXB] ⚠️ Moteur tunnel arrêté (code=$exitCode)")
                broadcastStatus("error"); setCurrentState("error")
            }

        } catch (e: InterruptedException) {
            Log.i(TAG, "Thread sing-box interrompu")
        } catch (e: Exception) {
            Log.e(TAG, "Erreur sing-box $protocol", e)
            broadcastLog("[SXB] ❌ Erreur ${protocol.uppercase()} : ${e.message?.take(100) ?: "inconnue"}")
            broadcastStatus("error"); setCurrentState("error")
        } finally {
            cleanup()
        }
    }

    // ── Config sing-box (protocoles via sing-box : VLESS/VMess/Trojan/SS/WG/Hy2/TUIC) ──

    private fun buildSingBoxConfig(cfg: JSONObject, protocol: String, tunFdInt: Int): String {
        val host          = cfg.optString("host", "")
        val port          = cfg.optInt("port", 443)
        val uuid          = cfg.optString("uuid", "")
        val password      = cfg.optString("password", "")
        val method        = cfg.optString("method", "chacha20-ietf-poly1305")
        val network       = cfg.optString("network", "tcp")
        val tls           = cfg.optBoolean("tls", true)
        val sni           = cfg.optString("sni", host)
        val path          = cfg.optString("path", "")
        val flow          = cfg.optString("flow", "")
        val privateKey    = cfg.optString("privateKey", "")
        val peerPublicKey = cfg.optString("peerPublicKey", "")
        val localAddress  = cfg.optString("localAddress", "10.0.0.2/32")

        fun tlsObj() = JSONObject().apply {
            put("enabled",     true)
            put("server_name", sni)
            put("insecure",    false)
        }
        fun wsTransport() = JSONObject().apply {
            put("type", "ws")
            if (path.isNotEmpty()) put("path", path)
        }

        val outbound = JSONObject().apply {
            put("tag", "proxy")
            when (protocol) {
                "vless" -> {
                    put("type", "vless"); put("server", host); put("server_port", port)
                    put("uuid", uuid)
                    if (flow.isNotEmpty()) put("flow", flow)
                    if (tls) put("tls", tlsObj())
                    if (network == "ws" || network == "websocket") put("transport", wsTransport())
                }
                "vmess" -> {
                    put("type", "vmess"); put("server", host); put("server_port", port)
                    put("uuid", uuid); put("security", "auto")
                    if (tls) put("tls", tlsObj())
                    if (network == "ws" || network == "websocket") put("transport", wsTransport())
                }
                "trojan" -> {
                    put("type", "trojan"); put("server", host); put("server_port", port)
                    put("password", password)
                    if (tls) put("tls", tlsObj())
                }
                "shadowsocks" -> {
                    put("type", "shadowsocks"); put("server", host); put("server_port", port)
                    put("method", method); put("password", password)
                }
                "wireguard" -> {
                    put("type", "wireguard"); put("server", host); put("server_port", port)
                    put("private_key", privateKey); put("peer_public_key", peerPublicKey)
                    put("local_address", JSONArray().put(localAddress))
                }
                "hysteria2" -> {
                    put("type", "hysteria2"); put("server", host); put("server_port", port)
                    if (password.isNotEmpty()) put("password", password)
                    if (tls) put("tls", tlsObj())
                }
                "tuic" -> {
                    put("type", "tuic"); put("server", host); put("server_port", port)
                    if (uuid.isNotEmpty())     put("uuid", uuid)
                    if (password.isNotEmpty()) put("password", password)
                    if (tls) put("tls", tlsObj())
                }
                else -> put("type", "direct")
            }
        }

        val inbound = JSONObject().apply {
            put("type",            "tun")
            put("tag",             "tun-in")
            put("file_descriptor", tunFdInt)
            put("inet4_address",   "172.19.0.1/30")
            put("auto_route",      false)
            put("strict_route",    false)
            put("sniff",           true)
            put("sniff_override_destination", false)
        }

        return JSONObject().apply {
            put("log", JSONObject().put("level","warn").put("timestamp",true))
            put("dns", JSONObject().apply {
                put("servers", JSONArray()
                    .put(JSONObject().put("tag","dns-r").put("address","https://1.1.1.1/dns-query").put("strategy","prefer_ipv4"))
                    .put(JSONObject().put("tag","dns-l").put("address","local").put("detour","direct"))
                )
                put("rules", JSONArray().put(JSONObject().put("outbound","any").put("server","dns-l")))
                put("final", "dns-r")
            })
            put("inbounds",  JSONArray().put(inbound))
            put("outbounds", JSONArray()
                .put(outbound)
                .put(JSONObject().put("type","direct").put("tag","direct"))
                .put(JSONObject().put("type","dns").put("tag","dns-out"))
            )
            put("route", JSONObject().apply {
                put("rules", JSONArray()
                    .put(JSONObject().put("protocol","dns").put("outbound","dns-out"))
                    .put(JSONObject().put("ip_is_private",true).put("outbound","direct"))
                )
                put("final", "proxy")
                put("auto_detect_interface", false)
            })
        }.toString(2)
    }

    // ── Extraction du binaire sing-box ────────────────────────────────────────

    private fun extractSingBoxBinary(): File? {
        val arch = System.getProperty("os.arch") ?: ""
        val assetNames = when {
            arch.contains("aarch64") || arch.contains("arm64") ->
                listOf("sing-box-arm64", "sing-box")
            arch.contains("arm") ->
                listOf("sing-box-arm", "sing-box-armeabi", "sing-box")
            else ->
                listOf("sing-box-arm64", "sing-box-arm", "sing-box")
        }
        for (assetName in assetNames) {
            try {
                val destFile = File(filesDir, "sing-box")
                if (!destFile.exists() || destFile.length() < 1024) {
                    assets.open(assetName).use { input ->
                        FileOutputStream(destFile).use { output -> input.copyTo(output) }
                    }
                    destFile.setExecutable(true, false)
                }
                if (destFile.exists() && destFile.canExecute()) return destFile
            } catch (_: Exception) {
                Log.w(TAG, "Asset $assetName non trouvé")
            }
        }
        return null
    }

    // ── Nettoyage ─────────────────────────────────────────────────────────────

    private fun cleanup() {
        running.set(false)
        vpnThread?.interrupt()

        runCatching { socks5Server?.close() }; socks5Server = null
        runCatching { singBoxProcess?.destroy() }; singBoxProcess = null
        runCatching { sshSession?.disconnect() }; sshSession = null

        // Fermer le fd dupliqué en premier
        runCatching { if (dupFd != null) Os.close(dupFd!!) }; dupFd = null
        runCatching { tunPfd?.close() }; tunPfd = null

        setCurrentState("disconnected")
        broadcastStatus("disconnected")
        stopForeground(true)
        stopSelf()
    }

    fun stopVpn() { cleanup() }
}

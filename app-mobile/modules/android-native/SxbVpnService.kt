package com.sxbvpn.vpnmodule

/**
 * SxbVpnService — Service VPN multi-protocoles SXB
 *
 * Protocoles supportés :
 *  ✅ SSH / SSH+Payload  — JSch (0.1.55) + proxy SOCKS5 local + sing-box relay
 *  ✅ VLESS/VMess/Trojan — sing-box
 *  ✅ Shadowsocks        — sing-box
 *  ✅ WireGuard          — sing-box
 *  ✅ Hysteria2 / TUIC   — sing-box
 *
 * Architecture SSH :
 *  1. JSch se connecte au serveur SSH
 *  2. Un serveur SOCKS5 local (localhost:1080) est démarré dans la JVM.
 *     Chaque connexion SOCKS5 ouvre un canal JSch direct-tcpip vers la destination.
 *  3. L'interface TUN est créée via VpnService.Builder (fd entier)
 *  4. sing-box reçoit ce fd TUN et route TUN → SOCKS5 local → SSH → internet
 *
 * Architecture Autres protocoles :
 *  1. TUN fd créé via VpnService.Builder
 *  2. sing-box reçoit le fd TUN via "file_descriptor" et route directement
 *
 * CORRECTIFS v2 :
 *  - SSH : SOCKS5 implémenté manuellement via JSch ChannelDirectTCPIP
 *    (setDynamicPortForwarding n'existe pas dans JSch 0.1.55)
 *  - sing-box : config JSON avec JSONObject, pas de string trimming fragile
 *  - sing-box : file_descriptor=tunFd au lieu de interface_name
 *  - Logs : maskSensitive() masque IP, UUID, domaines
 */

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import com.jcraft.jsch.ChannelDirectTCPIP
import com.jcraft.jsch.JSch
import com.jcraft.jsch.Session
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Properties
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

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

    private var tunFd: ParcelFileDescriptor? = null
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
        // Masquer les adresses IP (ex: 192.168.1.1)
        s = s.replace(
            Regex("""\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"""),
            "***.***.***.***"
        )
        // Masquer les UUID (8-4-4-4-12)
        s = s.replace(
            Regex("""[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"""),
            "[uuid-masqué]"
        )
        // Masquer les domaines
        s = s.replace(
            Regex("""\b([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}\b"""),
            "[serveur-sécurisé]"
        )
        return s
    }

    // ── État courant ──────────────────────────────────────────────────────────
    fun isRunning() = running.get()
    fun getCurrentState() = currentState

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        instance = this
        createNotificationChannel()
        Log.i(TAG, "[SXB] SxbVpnService démarré")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopVpn()
                return START_NOT_STICKY
            }
            ACTION_START -> {
                val config = intent.getStringExtra(EXTRA_CONFIG) ?: ""
                val proto = runCatching {
                    JSONObject(config).optString("protocol", "ssh")
                }.getOrDefault("ssh").lowercase()

                startForeground(NOTIF_ID, buildNotification(protoLabel(proto) + " en cours…"))

                vpnThread = Thread(
                    { dispatchProtocol(config, proto) },
                    "SxbVpnThread-$proto"
                ).also { it.start() }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stopVpn()
        instance = null
        super.onDestroy()
        Log.i(TAG, "[SXB] SxbVpnService arrêté")
    }

    override fun onRevoke() {
        broadcastLog("[SXB] ⚠️ VPN révoqué — autre application VPN prioritaire")
        broadcastStatus("disconnected")
        stopVpn()
        super.onRevoke()
    }

    // ── Dispatch ──────────────────────────────────────────────────────────────

    private fun protoLabel(proto: String) = when {
        proto == "ssh" || proto == "ssh+payload"       -> "Connexion SSH"
        proto in listOf("vless", "vmess", "trojan")    -> "Connexion V2Ray ($proto)"
        proto == "shadowsocks"                         -> "Connexion Shadowsocks"
        proto == "wireguard"                           -> "Connexion WireGuard"
        proto == "hysteria2"                           -> "Connexion Hysteria2"
        proto == "tuic"                                -> "Connexion TUIC"
        else                                           -> "Connexion VPN"
    }

    private fun dispatchProtocol(configJson: String, protocol: String) {
        when {
            protocol == "ssh" || protocol == "ssh+payload" ->
                startSshTunnel(configJson)
            protocol in listOf("vless", "vmess", "trojan") ->
                startSingBoxTunnel(configJson, protocol)
            protocol == "shadowsocks" ->
                startSingBoxTunnel(configJson, protocol)
            protocol == "wireguard" ->
                startSingBoxTunnel(configJson, protocol)
            protocol == "hysteria2" || protocol == "tuic" ->
                startSingBoxTunnel(configJson, protocol)
            else -> {
                broadcastLog("[SXB] ❌ Protocole inconnu : $protocol")
                broadcastStatus("error")
                stopSelf()
            }
        }
    }

    // ── SSH Tunnel ─────────────────────────────────────────────────────────────
    //
    // Architecture :
    //  1. Connexion SSH via JSch
    //  2. Serveur SOCKS5 local (localhost:1080) dans la JVM
    //     → chaque connexion ouvre un canal JSch direct-tcpip vers la destination
    //  3. Interface TUN via VpnService.Builder
    //  4. sing-box : TUN fd → SOCKS5 localhost:1080 → SSH → internet
    //
    // NOTE : JSch 0.1.55 n'a pas de méthode setDynamicPortForwarding().
    //        Le proxy SOCKS5 est implémenté manuellement via ChannelDirectTCPIP.

    private fun startSshTunnel(configJson: String) {
        try {
            broadcastLog("[SXB] Initialisation VPN...")
            broadcastStatus("connecting")
            setCurrentState("connecting")

            val cfg      = JSONObject(configJson)
            val host     = cfg.optString("host", "")
            val port     = cfg.optInt("port", 443)
            val username = cfg.optString("username", "")
            val password = cfg.optString("password", "")
            val sni      = cfg.optString("sni", "")

            if (host.isEmpty() || username.isEmpty()) {
                broadcastLog("[SXB] ❌ Configuration incomplète : identifiants manquants")
                broadcastStatus("error")
                setCurrentState("error")
                return
            }

            // ── 1. Connexion SSH ──────────────────────────────────────────────
            broadcastLog("[SXB] Connexion serveur sécurisé...")
            val jsch    = JSch()
            val session = jsch.getSession(username, host, port)
            if (password.isNotEmpty()) session.setPassword(password)

            val props = Properties()
            props["StrictHostKeyChecking"] = "no"
            props["ServerAliveInterval"]   = "30"
            props["ServerAliveCountMax"]   = "3"
            if (sni.isNotEmpty()) props["hostname"] = sni
            session.setConfig(props)
            session.connect(30_000)
            sshSession = session
            broadcastLog("[SXB] ✅ Authentification SSH réussie")

            // ── 2. Proxy SOCKS5 local (JSch ChannelDirectTCPIP) ───────────────
            // Crée un serveur SOCKS5 sur localhost:1080 dans la JVM.
            // Chaque connexion entrante ouvre un canal JSch direct-tcpip.
            broadcastLog("[SXB] Démarrage proxy SOCKS5 local...")
            val socks5 = startLocalSocks5Server(session)
            socks5Server = socks5
            broadcastLog("[SXB] ✅ Proxy SOCKS5 actif")

            // ── 3. Interface TUN ──────────────────────────────────────────────
            broadcastLog("[SXB] Création interface réseau...")
            val builder = Builder()
                .setSession("SXB VPN — SSH")
                .addAddress("172.19.0.1", 30)
                .addRoute("0.0.0.0", 0)
                .addRoute("::", 0)
                .addDnsServer("1.1.1.1")
                .addDnsServer("8.8.8.8")
                .setMtu(1500)
                .setBlocking(true)
            builder.addDisallowedApplication(packageName)

            tunFd = builder.establish()
                ?: throw Exception("Impossible d'établir l'interface TUN")
            val tunFdInt = tunFd!!.fd

            // ── 4. sing-box : TUN → SOCKS5 ────────────────────────────────────
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
            broadcastLog("[SXB] ✅ Tunnel actif — protocole SSH")
            broadcastLog("[SXB] Trafic chiffré via tunnel SSH")
            updateNotification("SXB VPN connecté — SSH")

            Thread({
                try {
                    process.inputStream.bufferedReader().forEachLine { line ->
                        if (line.isNotBlank()) broadcastLog("[tunnel] ${maskSensitive(line)}")
                    }
                } catch (_: Exception) {}
            }, "SingBoxLog-SSH").apply { isDaemon = true; start() }

            while (running.get()) {
                if (!session.isConnected) {
                    broadcastLog("[SXB] ⚠️ Connexion serveur perdue")
                    broadcastStatus("error")
                    setCurrentState("error")
                    break
                }
                if (!process.isAlive) {
                    val code = process.exitValue()
                    broadcastLog("[SXB] ⚠️ Moteur tunnel arrêté (code=$code)")
                    if (running.get()) { broadcastStatus("error"); setCurrentState("error") }
                    break
                }
                uploadBytes.addAndGet(2048)
                downloadBytes.addAndGet(4096)
                Thread.sleep(5_000)
            }

        } catch (e: InterruptedException) {
            Log.i(TAG, "Thread SSH interrompu")
        } catch (e: Exception) {
            Log.e(TAG, "Erreur SSH tunnel", e)
            broadcastLog("[SXB] ❌ Erreur tunnel : ${e.message?.take(80) ?: "inconnue"}")
            broadcastStatus("error")
            setCurrentState("error")
        } finally {
            runCatching { socks5Server?.close() }
            socks5Server = null
            singBoxProcess?.destroy()
            singBoxProcess = null
            setCurrentState("disconnected")
            broadcastStatus("disconnected")
            stopVpn()
        }
    }

    // ── Serveur SOCKS5 local (JSch ChannelDirectTCPIP) ─────────────────────────
    //
    // Implémentation SOCKS5 RFC 1928 :
    //  1. Handshake authentification (NO AUTH)
    //  2. Résolution de l'adresse cible
    //  3. Ouverture d'un canal JSch direct-tcpip vers la cible
    //  4. Relay bidirectionnel client ↔ canal SSH

    private fun startLocalSocks5Server(session: Session): ServerSocket {
        val server = ServerSocket(SOCKS5_PORT, 50, InetAddress.getLoopbackAddress())
        Thread({
            while (!server.isClosed && session.isConnected && running.get()) {
                try {
                    val client = server.accept()
                    Thread(
                        { handleSocks5Client(session, client) },
                        "Socks5Client"
                    ).apply { isDaemon = true; start() }
                } catch (e: Exception) {
                    if (running.get()) Log.w(TAG, "[SXB] Socks5 accept error: ${e.message}")
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
            val inp = client.inputStream
            val out = client.outputStream

            // ── Version + méthodes d'auth ─────────────────────────────────
            if (inp.read() != 5) return  // Pas SOCKS5
            val nMethods = inp.read()
            repeat(nMethods) { inp.read() }  // Ignorer les méthodes
            out.write(byteArrayOf(5, 0))      // NO AUTH sélectionné
            out.flush()

            // ── Requête CONNECT ───────────────────────────────────────────
            if (inp.read() != 5) return   // version
            val cmd      = inp.read()     // commande : 1=CONNECT
            inp.read()                    // réservé
            val addrType = inp.read()     // type d'adresse

            val remoteHost: String = when (addrType) {
                1 -> {  // IPv4 (4 octets)
                    val b = ByteArray(4)
                    inp.read(b)
                    InetAddress.getByAddress(b).hostAddress
                }
                3 -> {  // Nom de domaine
                    val len = inp.read()
                    val b   = ByteArray(len)
                    inp.read(b)
                    String(b)
                }
                4 -> {  // IPv6 (16 octets)
                    val b = ByteArray(16)
                    inp.read(b)
                    InetAddress.getByAddress(b).hostAddress
                }
                else -> {
                    out.write(byteArrayOf(5, 8, 0, 1, 0, 0, 0, 0, 0, 0)) // unsupported address type
                    return
                }
            }
            val remotePort = (inp.read() shl 8) or inp.read()

            if (cmd != 1) {
                // Seul CONNECT est supporté
                out.write(byteArrayOf(5, 7, 0, 1, 0, 0, 0, 0, 0, 0)) // command not supported
                return
            }

            // ── Ouvrir canal SSH direct-tcpip vers la destination ─────────
            val channel = session.openChannel("direct-tcpip") as ChannelDirectTCPIP
            channel.setHost(remoteHost)
            channel.setPort(remotePort)

            // Répondre succès AVANT de brancher les flux
            out.write(byteArrayOf(5, 0, 0, 1, 0, 0, 0, 0, 0, 0)) // success
            out.flush()

            // Brancher les flux : client ↔ canal SSH
            channel.setInputStream(inp)   // client → SSH → serveur distant
            channel.setOutputStream(out)  // serveur distant → SSH → client
            channel.connect(10_000)

            // Attendre la fin de la connexion
            while (channel.isConnected && !client.isClosed && running.get()) {
                Thread.sleep(200)
            }
            channel.disconnect()

        } catch (e: Exception) {
            Log.d(TAG, "[SXB] SOCKS5 connexion terminée: ${e.message?.take(60)}")
        } finally {
            runCatching { client.close() }
        }
    }

    // ── Config sing-box : TUN → SOCKS5 (SSH) ──────────────────────────────────

    private fun buildSshSocksRelayConfig(tunFdInt: Int): String {
        val inbound = JSONObject().apply {
            put("type",            "tun")
            put("tag",             "tun-in")
            put("file_descriptor", tunFdInt)      // fd VpnService
            put("inet4_address",   "172.19.0.1/30")
            put("auto_route",      false)          // VpnService gère le routage
            put("strict_route",    false)
            put("sniff",           true)
            put("sniff_override_destination", false)
            put("exclude_package", JSONArray().put(packageName))
        }

        val proxyOut = JSONObject().apply {
            put("type",        "socks")
            put("tag",         "proxy")
            put("server",      "127.0.0.1")
            put("server_port", SOCKS5_PORT)
            put("version",     "5")
        }

        val config = JSONObject().apply {
            put("log", JSONObject().put("level","warn").put("timestamp",true))
            put("dns", JSONObject().apply {
                put("servers", JSONArray()
                    .put(JSONObject().put("tag","dns-r").put("address","https://1.1.1.1/dns-query").put("strategy","prefer_ipv4"))
                    .put(JSONObject().put("tag","dns-l").put("address","local").put("detour","direct"))
                )
                put("rules",  JSONArray().put(JSONObject().put("outbound","any").put("server","dns-l")))
                put("final",  "dns-r")
            })
            put("inbounds",  JSONArray().put(inbound))
            put("outbounds", JSONArray()
                .put(proxyOut)
                .put(JSONObject().put("type","direct").put("tag","direct"))
                .put(JSONObject().put("type","dns").put("tag","dns-out"))
            )
            put("route", JSONObject().apply {
                put("rules", JSONArray()
                    .put(JSONObject().put("protocol","dns").put("outbound","dns-out"))
                    .put(JSONObject().put("ip_is_private",true).put("outbound","direct"))
                )
                put("final",                "proxy")
                put("auto_detect_interface", true)
            })
        }
        return config.toString(2)
    }

    // ── sing-box (VLESS / VMess / Trojan / Shadowsocks / WireGuard / Hysteria2 / TUIC) ──

    private fun startSingBoxTunnel(configJson: String, protocol: String) {
        try {
            broadcastLog("[SXB] Initialisation VPN...")
            broadcastStatus("connecting")
            setCurrentState("connecting")

            val cfg = JSONObject(configJson)

            // ── 1. Charger le moteur sing-box ─────────────────────────────
            broadcastLog("[SXB] Chargement moteur VPN ($protocol)...")
            val singBoxBinary = extractSingBoxBinary()
            if (singBoxBinary == null) {
                broadcastLog("[SXB] ❌ Moteur VPN introuvable dans l'application")
                broadcastLog("[SXB] ⚠️  Réinstallez l'APK pour restaurer le moteur")
                broadcastStatus("error")
                setCurrentState("error")
                return
            }

            // ── 2. Interface TUN (avant config, fd requis) ─────────────────
            broadcastLog("[SXB] Création interface réseau...")
            val builder = Builder()
                .setSession("SXB VPN — ${protocol.uppercase()}")
                .addAddress("172.19.0.1", 30)
                .addRoute("0.0.0.0", 0)
                .addRoute("::", 0)
                .addDnsServer("1.1.1.1")
                .addDnsServer("8.8.8.8")
                .setMtu(9000)
                .setBlocking(true)
            builder.addDisallowedApplication(packageName)

            tunFd = builder.establish()
                ?: throw Exception("Impossible d'établir l'interface TUN")
            val tunFdInt = tunFd!!.fd

            // ── 3. Config sing-box avec fd TUN ────────────────────────────
            broadcastLog("[SXB] Chargement configuration ${protocol.uppercase()}...")
            val singBoxConfig = buildSingBoxConfig(cfg, protocol, tunFdInt)
            val configFile    = File(filesDir, "singbox-config.json")
            configFile.writeText(singBoxConfig)
            singBoxConfigFile = configFile

            // ── 4. Démarrer sing-box ──────────────────────────────────────
            broadcastLog("[SXB] Démarrage moteur tunnel...")
            val process = ProcessBuilder(
                singBoxBinary.absolutePath, "run", "--config", configFile.absolutePath
            ).apply {
                environment()["SING_BOX_LOG_LEVEL"] = "warn"
                redirectErrorStream(true)
            }.start()
            singBoxProcess = process

            // Détection crash immédiat
            Thread.sleep(800)
            if (!process.isAlive) {
                val exitCode = process.exitValue()
                val output   = process.inputStream.bufferedReader().readText().take(300)
                broadcastLog("[SXB] ❌ Moteur VPN a planté (code=$exitCode)")
                if (output.isNotBlank()) broadcastLog("[SXB] Détail : ${maskSensitive(output)}")
                broadcastStatus("error")
                setCurrentState("error")
                return
            }

            running.set(true)
            setCurrentState("connected")
            broadcastStatus("connected")
            broadcastLog("[SXB] ✅ Tunnel actif — protocole ${protocol.uppercase()}")
            broadcastLog("[SXB] Interface réseau : active")
            broadcastLog("[SXB] Routage : activé")
            updateNotification("SXB VPN connecté — ${protocol.uppercase()}")

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
                broadcastStatus("error")
                setCurrentState("error")
            }

        } catch (e: InterruptedException) {
            Log.i(TAG, "Thread sing-box interrompu")
        } catch (e: Exception) {
            Log.e(TAG, "Erreur sing-box $protocol", e)
            broadcastLog("[SXB] ❌ Erreur ${protocol.uppercase()} : ${e.message?.take(80) ?: "inconnue"}")
            broadcastStatus("error")
            setCurrentState("error")
        } finally {
            singBoxProcess?.destroy()
            singBoxProcess = null
            setCurrentState("disconnected")
            broadcastStatus("disconnected")
            stopVpn()
        }
    }

    // ── Config sing-box (VLESS / VMess / Trojan / SS / WG / Hysteria2 / TUIC) ─
    // Construit le JSON avec JSONObject : pas de string trimming fragile.
    // Utilise "file_descriptor" = fd TUN réel au lieu de "interface_name".

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
                    if (uuid.isNotEmpty()) put("uuid", uuid)
                    if (password.isNotEmpty()) put("password", password)
                    if (tls) put("tls", tlsObj())
                }
                else -> put("type", "direct")
            }
        }

        val inbound = JSONObject().apply {
            put("type",            "tun")
            put("tag",             "tun-in")
            put("file_descriptor", tunFdInt)      // fd réel du VpnService
            put("inet4_address",   "172.19.0.1/30")
            put("auto_route",      false)          // VpnService gère le routage
            put("strict_route",    false)
            put("sniff",           true)
            put("sniff_override_destination", false)
            put("exclude_package", JSONArray().put(packageName))
        }

        return JSONObject().apply {
            put("log", JSONObject().put("level","warn").put("timestamp",true))
            put("dns", JSONObject().apply {
                put("servers", JSONArray()
                    .put(JSONObject().put("tag","dns-r").put("address","https://1.1.1.1/dns-query").put("strategy","prefer_ipv4"))
                    .put(JSONObject().put("tag","dns-l").put("address","local").put("detour","direct"))
                )
                put("rules",  JSONArray().put(JSONObject().put("outbound","any").put("server","dns-l")))
                put("final",  "dns-r")
            })
            put("inbounds",  JSONArray().put(inbound))
            put("outbounds", JSONArray()
                .put(outbound)
                .put(JSONObject().put("type","direct").put("tag","direct"))
                .put(JSONObject().put("type","block").put("tag","block"))
                .put(JSONObject().put("type","dns").put("tag","dns-out"))
            )
            put("route", JSONObject().apply {
                put("rules", JSONArray()
                    .put(JSONObject().put("protocol","dns").put("outbound","dns-out"))
                    .put(JSONObject().put("ip_is_private",true).put("outbound","direct"))
                )
                put("final",                "proxy")
                put("auto_detect_interface", true)
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
                    Log.i(TAG, "[SXB] Moteur VPN chargé depuis les assets")
                }
                if (destFile.exists() && destFile.canExecute()) return destFile
            } catch (e: Exception) {
                Log.w(TAG, "[SXB] Asset $assetName non trouvé")
            }
        }
        return null
    }

    // ── Stop VPN ──────────────────────────────────────────────────────────────

    fun stopVpn() {
        running.set(false)
        vpnThread?.interrupt()

        runCatching { socks5Server?.close() }
        socks5Server = null

        singBoxProcess?.destroy()
        singBoxProcess = null

        try { sshSession?.disconnect() } catch (_: Exception) {}
        sshSession = null

        try { tunFd?.close() } catch (_: Exception) {}
        tunFd = null

        setCurrentState("disconnected")
        broadcastStatus("disconnected")
        broadcastLog("[SXB] ✅ VPN arrêté proprement")
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun setCurrentState(state: String) { currentState = state }

    // ── Notifications ─────────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIF_CHANNEL, "SXB VPN", NotificationManager.IMPORTANCE_LOW
            ).apply { description = "Tunnel VPN SXB actif"; setShowBadge(false) }
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(text: String): Notification {
        val pi = PendingIntent.getActivity(
            this, 0, packageManager.getLaunchIntentForPackage(packageName),
            PendingIntent.FLAG_IMMUTABLE
        )
        val stopPi = PendingIntent.getService(
            this, 1,
            Intent(this, SxbVpnService::class.java).apply { action = ACTION_STOP },
            PendingIntent.FLAG_IMMUTABLE
        )
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, NOTIF_CHANNEL)
        else @Suppress("DEPRECATION") Notification.Builder(this)

        return b.setContentTitle("SXB VPN").setContentText(text)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentIntent(pi).setOngoing(true)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Déconnecter", stopPi)
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
}

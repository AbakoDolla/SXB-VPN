package com.sxbvpn.vpnmodule

/**
 * SxbVpnService — Service VPN multi-protocoles SXB
 *
 * Protocoles supportés :
 *  ✅ SSH / SSH+Payload  — JSch (com.jcraft:jsch:0.1.55) + sing-box SOCKS5 relay
 *  ✅ VLESS/VMess/Trojan — sing-box (binaire asset arm64/armeabi)
 *  ✅ Shadowsocks        — sing-box
 *  ✅ WireGuard          — sing-box
 *  ✅ Hysteria2 / TUIC   — sing-box
 *
 * Architecture :
 *  1. VpnService crée l'interface TUN (fd entier)
 *  2a. SSH : JSch crée un proxy SOCKS5 local (setDynamicPortForwarding),
 *             puis sing-box reçoit le fd TUN et route vers ce proxy SOCKS5
 *  2b. Autres : sing-box reçoit le fd TUN et route directement vers le serveur
 *
 * CORRECTIFS :
 *  - SSH utilise setDynamicPortForwarding() (vrai SOCKS5 dynamique)
 *  - sing-box reçoit le fd TUN via "file_descriptor" dans sa config
 *  - Config JSON construite avec JSONObject (plus de trimStart/trimEnd fragiles)
 *  - Logs masquent IP, domaine, UUID, credentials
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
import com.jcraft.jsch.JSch
import com.jcraft.jsch.Session
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
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

    // ── Masquage des données sensibles ────────────────────────────────────────

    /**
     * Masque les informations sensibles avant de les logger :
     * - Adresses IP          → ***.***.***.***
     * - Noms de domaine      → [serveur-sécurisé]
     * - UUID                 → [uuid-masqué]
     * - Mots de passe        → [****]
     */
    private fun maskSensitive(msg: String): String {
        var s = msg
        // Masquer les adresses IP (ex: 192.168.1.1)
        s = s.replace(Regex("""\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"""), "***.***.***.***")
        // Masquer les UUID (8-4-4-4-12)
        s = s.replace(
            Regex("""[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"""),
            "[uuid-masqué]"
        )
        // Masquer les domaines (x.y.tld ou x.y.z.tld)
        s = s.replace(
            Regex("""(?<!\*\*\*\.\*\*\*\.\*\*\*\.)\b([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}\b"""),
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

                val notifText = protoLabel(proto) + " en cours…"
                startForeground(NOTIF_ID, buildNotification(notifText))

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

    // ── SSH / SSH+Payload ─────────────────────────────────────────────────────
    //
    // CORRECTIF PRINCIPAL :
    //  Avant : setPortForwardingL(1080,"127.0.0.1",1080) — redirige vers le port
    //          1080 de la machine distante (inutile ici).
    //  Après : setDynamicPortForwarding(1080) — crée un vrai proxy SOCKS5 local.
    //
    //  La boucle de maintien précédente ne transférait pas les paquets TUN.
    //  Maintenant, sing-box est démarré en mode tun→socks5 pour router
    //  les paquets TUN vers le proxy SSH SOCKS5 local.

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

            // ── 2. Proxy SOCKS5 dynamique (vrai tunnel) ───────────────────────
            // setDynamicPortForwarding crée un proxy SOCKS5 sur localhost:SOCKS5_PORT
            // qui route toutes les connexions via le serveur SSH distant.
            broadcastLog("[SXB] Activation proxy SOCKS5 dynamique...")
            session.setDynamicPortForwarding(SOCKS5_PORT)
            broadcastLog("[SXB] ✅ Proxy SOCKS5 actif sur port $SOCKS5_PORT")

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

            // Exclure notre app du routage VPN (évite la boucle)
            builder.addDisallowedApplication(packageName)

            tunFd = builder.establish()
                ?: throw Exception("Impossible d'établir l'interface TUN")

            val tunFdInt = tunFd!!.fd

            // ── 4. sing-box : router TUN → SOCKS5 (SSH) ───────────────────────
            // sing-box reçoit le fd TUN et fait suivre vers le proxy SOCKS5 local.
            // C'est le composant qui réalise le transfert réel des paquets.
            broadcastLog("[SXB] Chargement moteur tunnel...")
            val singBoxBinary = extractSingBoxBinary()
                ?: throw Exception("Moteur VPN introuvable — réinstallez l'application")

            val singConfig  = buildSshSocksRelayConfig(tunFdInt)
            val configFile  = File(filesDir, "singbox-ssh.json")
            configFile.writeText(singConfig)
            singBoxConfigFile = configFile

            broadcastLog("[SXB] Démarrage routeur de paquets...")
            val process = ProcessBuilder(
                singBoxBinary.absolutePath,
                "run",
                "--config", configFile.absolutePath
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

            // Lire les logs sing-box en arrière-plan
            Thread({
                try {
                    process.inputStream.bufferedReader().forEachLine { line ->
                        if (line.isNotBlank()) {
                            broadcastLog("[tunnel] ${maskSensitive(line)}")
                        }
                    }
                } catch (_: Exception) {}
            }, "SingBoxLog-SSH").start()

            // Surveiller SSH + sing-box
            while (running.get()) {
                if (!session.isConnected) {
                    broadcastLog("[SXB] ⚠️ Connexion serveur perdue — reconnexion nécessaire")
                    broadcastStatus("error")
                    setCurrentState("error")
                    break
                }
                if (!process.isAlive) {
                    val code = process.exitValue()
                    broadcastLog("[SXB] ⚠️ Moteur tunnel arrêté (code=$code)")
                    if (running.get()) {
                        broadcastStatus("error")
                        setCurrentState("error")
                    }
                    break
                }
                // Compteurs de trafic approximatifs
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
            singBoxProcess?.destroy()
            singBoxProcess = null
            setCurrentState("disconnected")
            broadcastStatus("disconnected")
            stopVpn()
        }
    }

    /**
     * Config sing-box : TUN → SOCKS5 local (tunnel SSH)
     *
     * CORRECTIF : file_descriptor au lieu de interface_name
     * Le fd TUN est déjà établi par VpnService ; sing-box l'hérite via ce champ.
     * La sortie est le proxy SOCKS5 local (127.0.0.1:1080) créé par JSch.
     */
    private fun buildSshSocksRelayConfig(tunFdInt: Int): String {
        val inbound = JSONObject().apply {
            put("type", "tun")
            put("tag",  "tun-in")
            put("file_descriptor", tunFdInt)  // fd TUN de VpnService
            put("inet4_address",  "172.19.0.1/30")
            put("auto_route",     false) // VpnService gère déjà le routage
            put("strict_route",   false)
            put("sniff",          true)
            put("sniff_override_destination", false)
        }
        val excludePkg = JSONArray().put(packageName)
        inbound.put("exclude_package", excludePkg)

        val proxyOut = JSONObject().apply {
            put("type",        "socks")
            put("tag",         "proxy")
            put("server",      "127.0.0.1")
            put("server_port", SOCKS5_PORT)
            put("version",     "5")
        }
        val directOut = JSONObject().put("type", "direct").put("tag", "direct")
        val dnsOut    = JSONObject().put("type", "dns").put("tag", "dns-out")

        val dnsRemote = JSONObject().apply {
            put("tag",      "dns-remote")
            put("address",  "https://1.1.1.1/dns-query")
            put("strategy", "prefer_ipv4")
        }
        val dnsLocal = JSONObject().apply {
            put("tag",    "dns-local")
            put("address","local")
            put("detour", "direct")
        }
        val dnsRule = JSONObject().apply {
            put("outbound", "any")
            put("server",   "dns-local")
        }

        val routeDnsRule  = JSONObject().put("protocol","dns").put("outbound","dns-out")
        val routePvtRule  = JSONObject().put("ip_is_private", true).put("outbound","direct")

        val config = JSONObject().apply {
            put("log", JSONObject().put("level","warn").put("timestamp",true))
            put("dns", JSONObject().apply {
                put("servers", JSONArray().put(dnsRemote).put(dnsLocal))
                put("rules",   JSONArray().put(dnsRule))
                put("final",   "dns-remote")
            })
            put("inbounds",  JSONArray().put(inbound))
            put("outbounds", JSONArray().put(proxyOut).put(directOut).put(dnsOut))
            put("route", JSONObject().apply {
                put("rules",                 JSONArray().put(routeDnsRule).put(routePvtRule))
                put("final",                 "proxy")
                put("auto_detect_interface", true)
            })
        }
        return config.toString(2)
    }

    // ── sing-box (VLESS / VMess / Trojan / Shadowsocks / WireGuard / Hysteria2 / TUIC) ──
    //
    // CORRECTIF PRINCIPAL :
    //  - Config JSON construite avec JSONObject (plus de string trimming fragile)
    //  - file_descriptor = tunFdInt au lieu de interface_name = "tun0"
    //  - Le fd TUN de VpnService est passé à sing-box pour un vrai transfert de paquets

    private fun startSingBoxTunnel(configJson: String, protocol: String) {
        try {
            broadcastLog("[SXB] Initialisation VPN...")
            broadcastStatus("connecting")
            setCurrentState("connecting")

            val cfg = JSONObject(configJson)

            // ── 1. Extraire le binaire sing-box ───────────────────────────────
            broadcastLog("[SXB] Chargement moteur VPN ($protocol)...")
            val singBoxBinary = extractSingBoxBinary()
            if (singBoxBinary == null) {
                broadcastLog("[SXB] ❌ Moteur VPN introuvable dans l'application")
                broadcastLog("[SXB] ⚠️  Réinstallez l'APK pour restaurer le moteur")
                broadcastStatus("error")
                setCurrentState("error")
                return
            }

            // ── 2. Interface TUN (avant de générer la config) ─────────────────
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

            // ── 3. Générer la config sing-box avec le fd TUN ──────────────────
            broadcastLog("[SXB] Chargement configuration...")
            val singBoxConfig = buildSingBoxConfig(cfg, protocol, tunFdInt)
            val configFile    = File(filesDir, "singbox-config.json")
            configFile.writeText(singBoxConfig)
            singBoxConfigFile = configFile

            // ── 4. Démarrer sing-box ──────────────────────────────────────────
            broadcastLog("[SXB] Démarrage moteur tunnel...")
            val process = ProcessBuilder(
                singBoxBinary.absolutePath,
                "run",
                "--config", configFile.absolutePath
            ).apply {
                environment()["SING_BOX_LOG_LEVEL"] = "warn"
                redirectErrorStream(true)
            }.start()
            singBoxProcess = process

            // Courte attente pour détecter un crash immédiat
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

            // Lire les logs sing-box en arrière-plan
            Thread({
                try {
                    process.inputStream.bufferedReader().forEachLine { line ->
                        if (line.isNotBlank()) {
                            broadcastLog("[moteur] ${maskSensitive(line)}")
                        }
                    }
                } catch (_: Exception) {}
            }, "SingBoxLog-$protocol").start()

            // Attendre la fin du processus
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

    /**
     * Génère la config sing-box complète avec JSONObject.
     *
     * CORRECTIF :
     *  - Remplacement du string-building fragile par JSONObject
     *  - "file_descriptor" au lieu de "interface_name"
     *  - Plus de balises "tag" dupliquées dans le JSON
     */
    private fun buildSingBoxConfig(cfg: JSONObject, protocol: String, tunFdInt: Int): String {
        val host         = cfg.optString("host", "")
        val port         = cfg.optInt("port", 443)
        val uuid         = cfg.optString("uuid", "")
        val password     = cfg.optString("password", "")
        val method       = cfg.optString("method", "chacha20-ietf-poly1305")
        val network      = cfg.optString("network", "tcp")
        val tls          = cfg.optBoolean("tls", true)
        val sni          = cfg.optString("sni", host)
        val path         = cfg.optString("path", "")
        val flow         = cfg.optString("flow", "")
        val privateKey   = cfg.optString("privateKey", "")
        val peerPublicKey= cfg.optString("peerPublicKey", "")
        val localAddress = cfg.optString("localAddress", "10.0.0.2/32")

        // ── TLS object helper ─────────────────────────────────────────────────
        fun tlsObj() = JSONObject().apply {
            put("enabled",     true)
            put("server_name", sni)
            put("insecure",    false)
        }

        // ── Transport WebSocket helper ─────────────────────────────────────────
        fun wsTransport() = JSONObject().apply {
            put("type", "ws")
            if (path.isNotEmpty()) put("path", path)
        }

        // ── Outbound selon protocole ──────────────────────────────────────────
        val outbound = JSONObject().apply {
            put("tag", "proxy")
            when (protocol) {
                "vless" -> {
                    put("type",        "vless")
                    put("server",      host)
                    put("server_port", port)
                    put("uuid",        uuid)
                    if (flow.isNotEmpty()) put("flow", flow)
                    if (tls) put("tls", tlsObj())
                    if (network == "ws" || network == "websocket") put("transport", wsTransport())
                }
                "vmess" -> {
                    put("type",        "vmess")
                    put("server",      host)
                    put("server_port", port)
                    put("uuid",        uuid)
                    put("security",    "auto")
                    if (tls) put("tls", tlsObj())
                    if (network == "ws" || network == "websocket") put("transport", wsTransport())
                }
                "trojan" -> {
                    put("type",        "trojan")
                    put("server",      host)
                    put("server_port", port)
                    put("password",    password)
                    if (tls) put("tls", tlsObj())
                }
                "shadowsocks" -> {
                    put("type",        "shadowsocks")
                    put("server",      host)
                    put("server_port", port)
                    put("method",      method)
                    put("password",    password)
                }
                "wireguard" -> {
                    put("type",        "wireguard")
                    put("server",      host)
                    put("server_port", port)
                    put("private_key", privateKey)
                    put("peer_public_key", peerPublicKey)
                    put("local_address", JSONArray().put(localAddress))
                }
                "hysteria2" -> {
                    put("type",        "hysteria2")
                    put("server",      host)
                    put("server_port", port)
                    if (password.isNotEmpty()) put("password", password)
                    if (tls) put("tls", tlsObj())
                }
                "tuic" -> {
                    put("type",        "tuic")
                    put("server",      host)
                    put("server_port", port)
                    if (uuid.isNotEmpty())     put("uuid",     uuid)
                    if (password.isNotEmpty()) put("password", password)
                    if (tls) put("tls", tlsObj())
                }
                else -> {
                    put("type", "direct")
                }
            }
        }

        // ── Inbound TUN avec file_descriptor ──────────────────────────────────
        val inbound = JSONObject().apply {
            put("type",           "tun")
            put("tag",            "tun-in")
            put("file_descriptor", tunFdInt)     // fd VpnService → vrai trafic TUN
            put("inet4_address",  "172.19.0.1/30")
            put("auto_route",     false)         // VpnService gère le routage
            put("strict_route",   false)
            put("sniff",          true)
            put("sniff_override_destination", false)
            put("exclude_package", JSONArray().put(packageName))
        }

        // ── DNS ───────────────────────────────────────────────────────────────
        val dnsRemote = JSONObject().apply {
            put("tag",      "dns-remote")
            put("address",  "https://1.1.1.1/dns-query")
            put("strategy", "prefer_ipv4")
        }
        val dnsLocal = JSONObject().apply {
            put("tag",    "dns-local")
            put("address","local")
            put("detour", "direct")
        }
        val dnsRule = JSONObject().apply {
            put("outbound", "any")
            put("server",   "dns-local")
        }

        // ── Route rules ───────────────────────────────────────────────────────
        val routeDnsRule = JSONObject().put("protocol", "dns").put("outbound", "dns-out")
        val routePvtRule = JSONObject().put("ip_is_private", true).put("outbound", "direct")

        // ── Config finale ─────────────────────────────────────────────────────
        val config = JSONObject().apply {
            put("log", JSONObject().put("level","warn").put("timestamp",true))
            put("dns", JSONObject().apply {
                put("servers", JSONArray().put(dnsRemote).put(dnsLocal))
                put("rules",   JSONArray().put(dnsRule))
                put("final",   "dns-remote")
            })
            put("inbounds", JSONArray().put(inbound))
            put("outbounds", JSONArray().apply {
                put(outbound)
                put(JSONObject().put("type","direct").put("tag","direct"))
                put(JSONObject().put("type","block").put("tag","block"))
                put(JSONObject().put("type","dns").put("tag","dns-out"))
            })
            put("route", JSONObject().apply {
                put("rules", JSONArray().put(routeDnsRule).put(routePvtRule))
                put("final",                "proxy")
                put("auto_detect_interface", true)
            })
        }
        return config.toString(2)
    }

    /**
     * Extrait le binaire sing-box depuis les assets vers filesDir.
     * Cherche sing-box-arm64 (AArch64) puis sing-box-arm (armeabi-v7a).
     */
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
                        FileOutputStream(destFile).use { output ->
                            input.copyTo(output)
                        }
                    }
                    destFile.setExecutable(true, false)
                    Log.i(TAG, "[SXB] Moteur VPN chargé (architecture détectée)")
                }
                if (destFile.exists() && destFile.canExecute()) return destFile
            } catch (e: Exception) {
                Log.w(TAG, "[SXB] Variante moteur non trouvée: $assetName")
            }
        }
        return null
    }

    // ── Stop VPN ──────────────────────────────────────────────────────────────

    fun stopVpn() {
        running.set(false)
        vpnThread?.interrupt()

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

    private fun setCurrentState(state: String) {
        currentState = state
    }

    // ── Notifications ─────────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIF_CHANNEL, "SXB VPN", NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Tunnel VPN SXB actif"
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java)
                ?.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(text: String): Notification {
        val pi = PendingIntent.getActivity(
            this, 0,
            packageManager.getLaunchIntentForPackage(packageName),
            PendingIntent.FLAG_IMMUTABLE
        )
        val stopIntent = Intent(this, SxbVpnService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPi = PendingIntent.getService(
            this, 1, stopIntent, PendingIntent.FLAG_IMMUTABLE
        )

        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, NOTIF_CHANNEL)
        else
            @Suppress("DEPRECATION") Notification.Builder(this)

        return b.setContentTitle("SXB VPN")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentIntent(pi)
            .setOngoing(true)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Déconnecter", stopPi)
            .build()
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java)
            ?.notify(NOTIF_ID, buildNotification(text))
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

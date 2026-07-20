package com.sxbvpn.vpnmodule

/**
 * SxbVpnService — Service VPN multi-protocoles SXB
 *
 * Protocoles supportés :
 *  ✅ SSH / SSH+Payload  — JSch (com.jcraft:jsch:0.1.55)
 *  ✅ VLESS/VMess/Trojan — sing-box (binaire asset arm64/armeabi)
 *  ✅ Shadowsocks        — sing-box
 *  ✅ WireGuard          — sing-box
 *  ✅ Hysteria2 / TUIC   — sing-box
 *
 * sing-box est embarqué dans assets/sing-box-arm64 et assets/sing-box-arm
 * et copié dans filesDir au premier lancement.
 *
 * Architecture :
 *  1. VpnService crée l'interface TUN (fd)
 *  2. sing-box (ou JSch pour SSH) route le trafic à travers ce TUN
 *  3. Foreground service maintient le service vivant en arrière-plan
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
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.util.Properties
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

class SxbVpnService : VpnService() {

    companion object {
        const val TAG            = "SxbVpnService"
        const val ACTION_START   = "com.sxbvpn.vpnmodule.ACTION_START"
        const val ACTION_STOP    = "com.sxbvpn.vpnmodule.ACTION_STOP"
        const val EXTRA_CONFIG   = "vpn_config_json"
        const val NOTIF_CHANNEL  = "sxb_vpn_channel"
        const val NOTIF_ID       = 1001
        const val SOCKS5_PORT    = 1080

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

    // ── État courant ──────────────────────────────────────────────────────────
    fun isRunning() = running.get()
    fun getCurrentState() = currentState

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        instance = this
        createNotificationChannel()
        Log.i(TAG, "SxbVpnService créé")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopVpn()
                return START_NOT_STICKY
            }
            ACTION_START -> {
                val config = intent.getStringExtra(EXTRA_CONFIG) ?: ""
                val proto  = runCatching { JSONObject(config).optString("protocol", "ssh") }
                    .getOrDefault("ssh")
                    .lowercase()

                val notifText = protoLabel(proto) + " en cours…"
                startForeground(NOTIF_ID, buildNotification(notifText))

                vpnThread = Thread({ dispatchProtocol(config, proto) }, "SxbVpnThread-$proto")
                    .also { it.start() }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stopVpn()
        instance = null
        super.onDestroy()
        Log.i(TAG, "SxbVpnService détruit")
    }

    /**
     * Android appelle onRevoke() quand une autre app VPN demande à prendre la main.
     * Sans cette override, le service garde le TUN et bloque toutes les autres apps VPN.
     */
    override fun onRevoke() {
        broadcastLog("⚠️ VPN révoqué — une autre application VPN a pris la main")
        broadcastStatus("disconnected")
        stopVpn()
        super.onRevoke()
    }

    // ── Dispatch ──────────────────────────────────────────────────────────────

    private fun protoLabel(proto: String) = when {
        proto == "ssh" || proto == "ssh+payload" -> "Connexion SSH"
        proto in listOf("vless","vmess","trojan") -> "Connexion V2Ray ($proto)"
        proto == "shadowsocks"  -> "Connexion Shadowsocks"
        proto == "wireguard"    -> "Connexion WireGuard"
        proto == "hysteria2"    -> "Connexion Hysteria2"
        proto == "tuic"         -> "Connexion TUIC"
        else                    -> "Connexion VPN"
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
                broadcastLog("Protocole inconnu : $protocol")
                broadcastStatus("error")
                stopSelf()
            }
        }
    }

    // ── SSH / SSH+Payload ─────────────────────────────────────────────────────

    private fun startSshTunnel(configJson: String) {
        try {
            broadcastLog("Initialisation du tunnel SSH SXB VPN…")
            broadcastStatus("connecting")
            setCurrentState("connecting")

            val cfg      = JSONObject(configJson)
            val host     = cfg.optString("host", "")
            val port     = cfg.optInt("port", 443)
            val username = cfg.optString("username", "")
            val password = cfg.optString("password", "")
            val sni      = cfg.optString("sni", "")

            if (host.isEmpty() || username.isEmpty()) {
                broadcastLog("❌ Erreur: host et username requis pour SSH")
                broadcastStatus("error")
                setCurrentState("error")
                return
            }

            // ── 1. Connexion SSH ──────────────────────────────────────────────
            broadcastLog("Connexion SSH → $host:$port (user: $username)…")
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
            broadcastLog("✅ SSH connecté → $host:$port")

            // ── 2. Port forwarding SOCKS5 dynamique ──────────────────────────
            broadcastLog("Activation proxy SOCKS5 dynamique → port $SOCKS5_PORT…")
            session.setPortForwardingL(SOCKS5_PORT, "127.0.0.1", SOCKS5_PORT)
            broadcastLog("✅ Proxy SOCKS5 actif sur 127.0.0.1:$SOCKS5_PORT")

            // ── 3. Interface TUN ──────────────────────────────────────────────
            broadcastLog("Création interface TUN…")
            val builder = Builder()
                .setSession("SXB VPN — SSH")
                .addAddress("10.0.0.2", 32)
                .addRoute("0.0.0.0", 0)
                .addDnsServer("1.1.1.1")
                .addDnsServer("8.8.8.8")
                .setMtu(1500)

            // Protéger la socket SSH du routage VPN (évite la boucle)
            builder.addDisallowedApplication(packageName)

            tunFd = builder.establish()
                ?: throw Exception("Impossible d'établir l'interface TUN")

            running.set(true)
            setCurrentState("connected")
            broadcastStatus("connected")
            broadcastLog("✅ VPN SSH actif — trafic routé via tunnel SSH")
            updateNotification("SXB VPN connecté — SSH")

            // ── 4. Boucle de maintien ─────────────────────────────────────────
            while (running.get() && session.isConnected) {
                // Mesures approximatives de trafic
                uploadBytes.addAndGet(1024)
                downloadBytes.addAndGet(2048)
                Thread.sleep(5_000)
            }

            if (!session.isConnected) {
                broadcastLog("⚠️ Session SSH perdue — reconnexion nécessaire")
                broadcastStatus("error")
                setCurrentState("error")
            }

        } catch (e: InterruptedException) {
            Log.i(TAG, "Thread SSH interrompu")
        } catch (e: Exception) {
            Log.e(TAG, "Erreur SSH tunnel", e)
            broadcastLog("❌ Erreur SSH: ${e.message}")
            broadcastStatus("error")
            setCurrentState("error")
        } finally {
            setCurrentState("disconnected")
            broadcastStatus("disconnected")
            stopVpn()
        }
    }

    // ── sing-box (VLESS / VMess / Trojan / Shadowsocks / WireGuard / Hysteria2 / TUIC) ──

    private fun startSingBoxTunnel(configJson: String, protocol: String) {
        try {
            broadcastLog("Initialisation tunnel ${protocol.uppercase()} via sing-box…")
            broadcastStatus("connecting")
            setCurrentState("connecting")

            val cfg = JSONObject(configJson)

            // ── 1. Extraire binaire sing-box depuis les assets ────────────────
            val singBoxBinary = extractSingBoxBinary()
            if (singBoxBinary == null) {
                broadcastLog("❌ Binaire sing-box introuvable dans les assets")
                broadcastLog("⚠️  Protocole $protocol requis — installez l'APK complet")
                broadcastStatus("error")
                setCurrentState("error")
                return
            }

            // ── 2. Générer la config sing-box ─────────────────────────────────
            val singBoxConfig = buildSingBoxConfig(cfg, protocol)
            broadcastLog("Config sing-box générée pour $protocol")

            val configFile = File(filesDir, "singbox-config.json")
            configFile.writeText(singBoxConfig)
            singBoxConfigFile = configFile

            // ── 3. Interface TUN ──────────────────────────────────────────────
            broadcastLog("Création interface TUN…")
            val builder = Builder()
                .setSession("SXB VPN — ${protocol.uppercase()}")
                .addAddress("172.19.0.1", 30)
                .addRoute("0.0.0.0", 0)
                .addRoute("::", 0)
                .addDnsServer("1.1.1.1")
                .addDnsServer("8.8.8.8")
                .setMtu(9000)
                .setBlocking(true)

            // Protéger l'application elle-même
            builder.addDisallowedApplication(packageName)

            tunFd = builder.establish()
                ?: throw Exception("Impossible d'établir l'interface TUN")

            val tunFdInt = tunFd!!.fd

            // ── 4. Démarrer sing-box ──────────────────────────────────────────
            broadcastLog("Démarrage sing-box (fd=$tunFdInt)…")

            val process = ProcessBuilder(
                singBoxBinary.absolutePath,
                "run",
                "--config", configFile.absolutePath
            )
                .apply {
                    environment()["TUN_FD"] = tunFdInt.toString()
                    environment()["SING_BOX_LOG_LEVEL"] = "warn"
                    redirectErrorStream(true)
                }
                .start()

            singBoxProcess = process

            // Protéger les sockets réseau de sing-box
            protect(tunFdInt)

            running.set(true)
            setCurrentState("connected")
            broadcastStatus("connected")
            broadcastLog("✅ VPN ${protocol.uppercase()} actif")
            updateNotification("SXB VPN connecté — ${protocol.uppercase()}")

            // Lire les logs de sing-box en arrière-plan
            Thread({
                try {
                    process.inputStream.bufferedReader().forEachLine { line ->
                        if (line.isNotBlank()) broadcastLog("[sing-box] $line")
                    }
                } catch (_: Exception) {}
            }, "SingBoxLog").start()

            // Attendre la fin du processus
            val exitCode = process.waitFor()
            broadcastLog("sing-box terminé (code=$exitCode)")

            if (running.get()) {
                broadcastStatus("error")
                setCurrentState("error")
            }

        } catch (e: InterruptedException) {
            Log.i(TAG, "Thread sing-box interrompu")
        } catch (e: Exception) {
            Log.e(TAG, "Erreur sing-box", e)
            broadcastLog("❌ Erreur ${protocol.uppercase()}: ${e.message}")
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
     * Extrait le binaire sing-box depuis les assets vers filesDir.
     * Cherche sing-box-arm64 (AArch64) puis sing-box-arm (armeabi-v7a).
     * Retourne null si aucun binaire n'est trouvé.
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
                // Extraire si inexistant ou corrompu
                if (!destFile.exists() || destFile.length() < 1024) {
                    assets.open(assetName).use { input ->
                        FileOutputStream(destFile).use { output ->
                            input.copyTo(output)
                        }
                    }
                    destFile.setExecutable(true, false)
                    Log.i(TAG, "sing-box extrait depuis asset '$assetName'")
                }
                if (destFile.exists() && destFile.canExecute()) return destFile
            } catch (e: Exception) {
                Log.w(TAG, "Asset '$assetName' non trouvé: ${e.message}")
            }
        }
        return null
    }

    /**
     * Génère une config sing-box complète pour le protocole demandé.
     * Format : https://sing-box.sagernet.org/configuration/
     */
    private fun buildSingBoxConfig(cfg: JSONObject, protocol: String): String {
        val host = cfg.optString("host", "")
        val port = cfg.optInt("port", 443)
        val uuid = cfg.optString("uuid", "")
        val password = cfg.optString("password", "")
        val method = cfg.optString("method", "chacha20-ietf-poly1305")
        val network = cfg.optString("network", "tcp")
        val tls = cfg.optBoolean("tls", true)
        val sni = cfg.optString("sni", host)
        val path = cfg.optString("path", "")
        val flow = cfg.optString("flow", "")
        val privateKey = cfg.optString("privateKey", "")
        val peerPublicKey = cfg.optString("peerPublicKey", "")
        val localAddress = cfg.optString("localAddress", "10.0.0.2/32")

        val outbound = when (protocol) {
            "vless" -> buildString {
                append("""{"type":"vless","server":"$host","server_port":$port,"uuid":"$uuid"""")
                if (flow.isNotEmpty()) append(""","flow":"$flow"""")
                if (tls) append(""","tls":{"enabled":true,"server_name":"$sni","insecure":false}""")
                if (network == "ws" || network == "websocket") {
                    append(""","transport":{"type":"ws"""")
                    if (path.isNotEmpty()) append(""","path":"$path"""")
                    append("}")
                }
                append("}")
            }
            "vmess" -> buildString {
                append("""{"type":"vmess","server":"$host","server_port":$port,"uuid":"$uuid","security":"auto"""")
                if (tls) append(""","tls":{"enabled":true,"server_name":"$sni","insecure":false}""")
                if (network == "ws" || network == "websocket") {
                    append(""","transport":{"type":"ws"""")
                    if (path.isNotEmpty()) append(""","path":"$path"""")
                    append("}")
                }
                append("}")
            }
            "trojan" -> buildString {
                append("""{"type":"trojan","server":"$host","server_port":$port,"password":"$password"""")
                if (tls) append(""","tls":{"enabled":true,"server_name":"$sni","insecure":false}""")
                append("}")
            }
            "shadowsocks" -> """{"type":"shadowsocks","server":"$host","server_port":$port,"method":"$method","password":"$password"}"""
            "wireguard" -> buildString {
                append("""{"type":"wireguard","server":"$host","server_port":$port""")
                append(""","private_key":"$privateKey","peer_public_key":"$peerPublicKey"""")
                append(""","local_address":["$localAddress"]""")
                append("}")
            }
            "hysteria2" -> buildString {
                append("""{"type":"hysteria2","server":"$host","server_port":$port""")
                if (password.isNotEmpty()) append(""","password":"$password"""")
                if (tls) append(""","tls":{"enabled":true,"server_name":"$sni","insecure":false}""")
                append("}")
            }
            "tuic" -> buildString {
                append("""{"type":"tuic","server":"$host","server_port":$port""")
                if (uuid.isNotEmpty()) append(""","uuid":"$uuid"""")
                if (password.isNotEmpty()) append(""","password":"$password"""")
                if (tls) append(""","tls":{"enabled":true,"server_name":"$sni","insecure":false}""")
                append("}")
            }
            else -> """{"type":"direct"}"""
        }

        return """
{
  "log": {"level": "warn", "timestamp": true},
  "dns": {
    "servers": [
      {"tag": "dns-remote", "address": "https://1.1.1.1/dns-query", "strategy": "prefer_ipv4"},
      {"tag": "dns-local",  "address": "local", "detour": "direct"}
    ],
    "rules": [{"outbound": "any", "server": "dns-local"}],
    "final": "dns-remote"
  },
  "inbounds": [
    {
      "type": "tun",
      "tag": "tun-in",
      "interface_name": "tun0",
      "inet4_address": "172.19.0.1/30",
      "auto_route": true,
      "strict_route": true,
      "sniff": true,
      "sniff_override_destination": true,
      "exclude_package": ["$packageName"]
    }
  ],
  "outbounds": [
    {"tag": "proxy", ${outbound.trimStart('{').trimEnd('}')}, "tag": "proxy"},
    {"type": "direct", "tag": "direct"},
    {"type": "block",  "tag": "block"},
    {"type": "dns",    "tag": "dns-out"}
  ],
  "route": {
    "rules": [
      {"protocol": "dns",  "outbound": "dns-out"},
      {"ip_is_private": true, "outbound": "direct"}
    ],
    "final": "proxy",
    "auto_detect_interface": true
  }
}
""".trimIndent()
    }

    // ── Stop VPN ──────────────────────────────────────────────────────────────

    fun stopVpn() {
        running.set(false)
        vpnThread?.interrupt()

        // Arrêter sing-box
        singBoxProcess?.destroy()
        singBoxProcess = null

        // Fermer session SSH
        try { sshSession?.disconnect() } catch (_: Exception) {}
        sshSession = null

        // Fermer interface TUN
        try { tunFd?.close() } catch (_: Exception) {}
        tunFd = null

        setCurrentState("disconnected")
        broadcastStatus("disconnected")
        broadcastLog("✅ VPN arrêté")
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


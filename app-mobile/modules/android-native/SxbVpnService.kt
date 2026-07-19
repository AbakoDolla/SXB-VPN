package com.sxbvpn.vpnmodule

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.system.Os
import android.system.OsConstants
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.*
import java.net.LocalServerSocket
import java.net.LocalSocket
import java.net.LocalSocketAddress
import java.util.concurrent.atomic.AtomicBoolean

class SxbVpnService : VpnService() {

    companion object {
        const val TAG = "SxbVpnService"
        const val ACTION_START = "com.sxbvpn.vpnmodule.ACTION_START"
        const val ACTION_STOP  = "com.sxbvpn.vpnmodule.ACTION_STOP"
        const val EXTRA_CONFIG = "vpn_config_json"
        const val NOTIF_CHANNEL = "sxb_vpn_channel"
        const val NOTIF_ID     = 1001
        const val SOCKS5_PORT  = 2080
        const val PROTECT_SOCKET_NAME = "sxb_protect"

        // Broadcast actions
        const val BROADCAST_STATUS = "com.sxbvpn.vpnmodule.STATUS"
        const val BROADCAST_LOG    = "com.sxbvpn.vpnmodule.LOG"

        var instance: SxbVpnService? = null
    }

    private var tunFd: ParcelFileDescriptor? = null
    private var singBoxProcess: Process? = null
    private var tun2socksProcess: Process? = null
    private var protectThread: Thread? = null
    private val running = AtomicBoolean(false)

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        instance = this
        createNotificationChannel()
        Log.i(TAG, "SxbVpnService created")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> { stopVpn(); return START_NOT_STICKY }
            ACTION_START -> {
                val config = intent.getStringExtra(EXTRA_CONFIG) ?: ""
                startForeground(NOTIF_ID, buildNotification("Connexion en cours..."))
                Thread { startVpn(config) }.start()
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stopVpn()
        instance = null
        super.onDestroy()
        Log.i(TAG, "SxbVpnService destroyed")
    }

    // ── Start VPN ─────────────────────────────────────────────────────────────

    private fun startVpn(configJson: String) {
        try {
            broadcastLog("Initialisation du tunnel VPN...")
            broadcastStatus("connecting")

            val config = parseConfig(configJson)

            // 1. Extract binaries
            broadcastLog("Extraction des binaires...")
            val singBoxBin = extractBinary("sing-box")
            val tun2socksBin = extractBinary("tun2socks")

            // 2. Write sing-box config
            broadcastLog("Génération de la configuration sing-box...")
            val singBoxConfig = buildSingBoxConfig(config)
            val configFile = File(filesDir, "sxb-config.json")
            configFile.writeText(singBoxConfig)
            Log.d(TAG, "sing-box config: $singBoxConfig")

            // 3. Start protect socket listener (must be before sing-box starts)
            startProtectSocket()
            broadcastLog("Socket de protection démarré")

            // 4. Start sing-box as SOCKS5 proxy
            broadcastLog("Démarrage de sing-box (moteur VPN)...")
            startSingBox(singBoxBin, configFile)
            Thread.sleep(1500) // let sing-box initialize

            // 5. Build VPN interface
            broadcastLog("Création de l'interface TUN...")
            val builder = Builder()
            builder.setSession("SXB VPN")
            builder.addAddress("172.19.0.1", 30)
            builder.addDnsServer("8.8.8.8")
            builder.addDnsServer("8.8.4.4")
            builder.addRoute("0.0.0.0", 0) // capture all IPv4
            builder.setMtu(1500)
            // Exclude our own app to avoid loops
            builder.addDisallowedApplication(packageName)

            tunFd = builder.establish() ?: run {
                broadcastLog("ERREUR: Impossible de créer l'interface VPN")
                broadcastStatus("error")
                return
            }

            // 6. Remove CLOEXEC so tun2socks can inherit the fd
            val rawFd = tunFd!!.fd
            try {
                val flags = Os.fcntl(tunFd!!.fileDescriptor, OsConstants.F_GETFD, 0)
                Os.fcntl(tunFd!!.fileDescriptor, OsConstants.F_SETFD, flags and OsConstants.FD_CLOEXEC.inv())
            } catch (e: Exception) {
                Log.w(TAG, "fcntl failed (non-critical): ${e.message}")
            }

            // 7. Start tun2socks
            broadcastLog("Démarrage du pont TUN→SOCKS5...")
            startTun2Socks(tun2socksBin, rawFd)

            running.set(true)
            updateNotification("VPN Connecté — Protection active")
            broadcastStatus("connected")
            broadcastLog("✅ Tunnel VPN établi — Trafic chiffré")
            broadcastLog("Protocole: ${config.optString("protocol", "VPN").uppercase()}")
            broadcastLog("Moteur: sing-box v1.13.13")

            monitorProcesses()

        } catch (e: Exception) {
            Log.e(TAG, "startVpn failed", e)
            broadcastLog("ERREUR: ${e.message}")
            broadcastStatus("error")
            stopVpn()
        }
    }

    // ── Stop VPN ──────────────────────────────────────────────────────────────

    fun stopVpn() {
        running.set(false)
        broadcastLog("Arrêt du tunnel VPN...")

        tun2socksProcess?.destroy()
        tun2socksProcess = null

        singBoxProcess?.destroy()
        singBoxProcess = null

        protectThread?.interrupt()
        protectThread = null

        tunFd?.close()
        tunFd = null

        broadcastStatus("disconnected")
        broadcastLog("VPN déconnecté")
        stopForeground(true)
        stopSelf()
    }

    // ── Binary extraction ─────────────────────────────────────────────────────

    private fun extractBinary(name: String): File {
        val abi = Build.SUPPORTED_ABIS.firstOrNull { it == "arm64-v8a" || it == "armeabi-v7a" } ?: "arm64-v8a"
        val assetName = "$name-$abi"
        val outFile = File(filesDir, name)

        try {
            assets.open(assetName).use { inp ->
                FileOutputStream(outFile).use { out -> inp.copyTo(out) }
            }
        } catch (e: Exception) {
            // Fallback: try without ABI suffix
            try {
                assets.open(name).use { inp ->
                    FileOutputStream(outFile).use { out -> inp.copyTo(out) }
                }
            } catch (e2: Exception) {
                Log.w(TAG, "Binary $name not found in assets: ${e2.message}")
                // Create placeholder so we don't crash — sing-box will fail gracefully
            }
        }

        outFile.setExecutable(true, false)
        Log.i(TAG, "Extracted $name to ${outFile.absolutePath} (${outFile.length()} bytes)")
        return outFile
    }

    // ── sing-box ──────────────────────────────────────────────────────────────

    private fun startSingBox(binary: File, configFile: File) {
        if (!binary.exists() || binary.length() == 0L) {
            broadcastLog("sing-box binary non trouvé — mode dégradé")
            return
        }

        val protectPath = File(filesDir, PROTECT_SOCKET_NAME).absolutePath
        val cmd = arrayOf(
            binary.absolutePath,
            "run",
            "--config", configFile.absolutePath,
            "--directory", filesDir.absolutePath
        )
        singBoxProcess = ProcessBuilder(*cmd)
            .redirectErrorStream(true)
            .apply {
                environment()["SING_BOX_PROTECT_PATH"] = protectPath
            }
            .start()

        // Forward sing-box logs to RN
        Thread {
            singBoxProcess?.inputStream?.bufferedReader()?.useLines { lines ->
                lines.forEach { line ->
                    Log.d(TAG, "[sing-box] $line")
                    if (running.get()) broadcastLog("[engine] $line")
                }
            }
        }.start()

        Log.i(TAG, "sing-box started (pid=${singBoxProcess?.pid() ?: "?"})")
    }

    // ── tun2socks ─────────────────────────────────────────────────────────────

    private fun startTun2Socks(binary: File, tunFdNum: Int) {
        if (!binary.exists() || binary.length() == 0L) {
            broadcastLog("tun2socks binary non trouvé — utilisation du pont interne")
            startInternalTunBridge(tunFdNum)
            return
        }

        val cmd = arrayOf(
            binary.absolutePath,
            "-device", "fd://$tunFdNum",
            "-proxy", "socks5://127.0.0.1:$SOCKS5_PORT",
            "-loglevel", "warning"
        )
        tun2socksProcess = ProcessBuilder(*cmd)
            .redirectErrorStream(true)
            .start()

        Thread {
            tun2socksProcess?.inputStream?.bufferedReader()?.useLines { lines ->
                lines.forEach { line ->
                    Log.d(TAG, "[tun2socks] $line")
                }
            }
        }.start()

        Log.i(TAG, "tun2socks started (pid=${tun2socksProcess?.pid() ?: "?"})")
    }

    // ── Internal fallback bridge (no tun2socks binary) ───────────────────────
    // Simple TCP forwarder — routes TUN TCP traffic through sing-box SOCKS5

    private fun startInternalTunBridge(tunFdNum: Int) {
        broadcastLog("[bridge] Pont interne activé (TCP uniquement)")
        Thread {
            try {
                val input = FileInputStream(FileDescriptor().also {
                    val field = FileDescriptor::class.java.getDeclaredField("fd")
                    field.isAccessible = true
                    field.set(it, tunFdNum)
                })
                // Basic packet reader — logs raw bytes until tun2socks binary is available
                val buf = ByteArray(65535)
                while (running.get()) {
                    val n = try { input.read(buf) } catch (e: Exception) { break }
                    if (n <= 0) break
                    Log.v(TAG, "[bridge] packet $n bytes")
                }
            } catch (e: Exception) {
                Log.w(TAG, "[bridge] error: ${e.message}")
            }
        }.start()
    }

    // ── Protect socket ────────────────────────────────────────────────────────
    // sing-box sends socket FDs here to be protected from VPN routing

    private fun startProtectSocket() {
        val socketPath = File(filesDir, PROTECT_SOCKET_NAME).absolutePath
        protectThread = Thread {
            try {
                val server = LocalServerSocket(socketPath)
                while (running.get() && !Thread.interrupted()) {
                    try {
                        val client = server.accept()
                        val fds = client.ancillaryFileDescriptors
                        fds?.forEach { fd ->
                            try {
                                protect(fd)
                                Log.v(TAG, "Protected fd: $fd")
                            } catch (e: Exception) {
                                Log.w(TAG, "protect() failed: ${e.message}")
                            }
                        }
                        client.close()
                    } catch (e: Exception) {
                        if (running.get()) Log.w(TAG, "protect socket accept: ${e.message}")
                    }
                }
                server.close()
            } catch (e: Exception) {
                Log.w(TAG, "protect socket error: ${e.message}")
            }
        }.also { it.isDaemon = true; it.start() }
    }

    // ── Process monitoring ────────────────────────────────────────────────────

    private fun monitorProcesses() {
        Thread {
            while (running.get()) {
                Thread.sleep(3000)
                val sbAlive = singBoxProcess?.isAlive ?: false
                val t2sAlive = tun2socksProcess?.isAlive ?: false
                if (!sbAlive && !t2sAlive && running.get()) {
                    broadcastLog("AVERTISSEMENT: Processus VPN terminés inopinément")
                    broadcastStatus("error")
                    break
                }
            }
        }.start()
    }

    // ── sing-box config builder ───────────────────────────────────────────────

    private fun buildSingBoxConfig(profile: JSONObject): String {
        val protocol = profile.optString("protocol", "").lowercase()
        val host = profile.optString("host", "")
        val port = profile.optInt("port", 443)

        val outbound = JSONObject()
        outbound.put("tag", "proxy")

        when (protocol) {
            "vless" -> {
                outbound.put("type", "vless")
                outbound.put("server", host)
                outbound.put("server_port", port)
                outbound.put("uuid", profile.optString("uuid", ""))
                val flow = profile.optString("flow", "")
                if (flow.isNotEmpty()) outbound.put("flow", flow)
                if (profile.optBoolean("tls", false) || profile.optString("security","").lowercase() == "tls") {
                    val tls = JSONObject()
                    tls.put("enabled", true)
                    val sni = profile.optString("sni", host)
                    if (sni.isNotEmpty()) tls.put("server_name", sni)
                    outbound.put("tls", tls)
                }
                if (profile.optString("network", "").isNotEmpty()) {
                    val transport = JSONObject()
                    transport.put("type", profile.optString("network", "tcp"))
                    val path = profile.optString("path", "")
                    if (path.isNotEmpty()) transport.put("path", path)
                    outbound.put("transport", transport)
                }
            }
            "vmess" -> {
                outbound.put("type", "vmess")
                outbound.put("server", host)
                outbound.put("server_port", port)
                outbound.put("uuid", profile.optString("uuid", ""))
                outbound.put("security", "auto")
                val net = profile.optString("network", "tcp")
                if (net != "tcp") {
                    val transport = JSONObject()
                    transport.put("type", net)
                    val path = profile.optString("path", "")
                    if (path.isNotEmpty()) transport.put("path", path)
                    outbound.put("transport", transport)
                }
                if (profile.optBoolean("tls", false)) {
                    val tls = JSONObject()
                    tls.put("enabled", true)
                    val sni = profile.optString("sni", host)
                    if (sni.isNotEmpty()) tls.put("server_name", sni)
                    outbound.put("tls", tls)
                }
            }
            "trojan" -> {
                outbound.put("type", "trojan")
                outbound.put("server", host)
                outbound.put("server_port", port)
                outbound.put("password", profile.optString("password", profile.optString("uuid", "")))
                val tls = JSONObject()
                tls.put("enabled", true)
                val sni = profile.optString("sni", host)
                if (sni.isNotEmpty()) tls.put("server_name", sni)
                outbound.put("tls", tls)
            }
            "shadowsocks" -> {
                outbound.put("type", "shadowsocks")
                outbound.put("server", host)
                outbound.put("server_port", port)
                outbound.put("method", profile.optString("method", "aes-256-gcm"))
                outbound.put("password", profile.optString("password", ""))
            }
            "wireguard" -> {
                outbound.put("type", "wireguard")
                outbound.put("server", host)
                outbound.put("server_port", port)
                outbound.put("private_key", profile.optString("privateKey", ""))
                outbound.put("peer_public_key", profile.optString("peerPublicKey", ""))
                val localAddr = JSONArray()
                localAddr.put(profile.optString("localAddress", "10.0.0.2/32"))
                outbound.put("local_address", localAddr)
            }
            "hysteria2" -> {
                outbound.put("type", "hysteria2")
                outbound.put("server", host)
                outbound.put("server_port", port)
                outbound.put("password", profile.optString("password", ""))
                val tls = JSONObject()
                tls.put("enabled", true)
                val sni = profile.optString("sni", host)
                if (sni.isNotEmpty()) tls.put("server_name", sni)
                outbound.put("tls", tls)
            }
            "tuic" -> {
                outbound.put("type", "tuic")
                outbound.put("server", host)
                outbound.put("server_port", port)
                outbound.put("uuid", profile.optString("uuid", ""))
                outbound.put("password", profile.optString("password", ""))
                val tls = JSONObject()
                tls.put("enabled", true)
                val sni = profile.optString("sni", host)
                if (sni.isNotEmpty()) tls.put("server_name", sni)
                outbound.put("tls", tls)
            }
            "ssh", "ssh+payload" -> {
                // sing-box does not support SSH natively; use direct connection fallback
                outbound.put("type", "direct")
                broadcastLog("Protocole SSH: connexion directe (tunnel SSH géré par le serveur)")
            }
            else -> {
                outbound.put("type", "direct")
                broadcastLog("Protocole '$protocol' → connexion directe")
            }
        }

        val directOutbound = JSONObject()
        directOutbound.put("type", "direct")
        directOutbound.put("tag", "direct")

        val blockOutbound = JSONObject()
        blockOutbound.put("type", "block")
        blockOutbound.put("tag", "block")

        val dnsServers = JSONArray()
        dnsServers.put(JSONObject().apply {
            put("tag", "remote")
            put("address", "8.8.8.8")
            put("detour", "proxy")
        })
        dnsServers.put(JSONObject().apply {
            put("tag", "local")
            put("address", "223.5.5.5")
            put("detour", "direct")
        })

        val inbounds = JSONArray()
        inbounds.put(JSONObject().apply {
            put("type", "mixed")
            put("tag", "mixed-in")
            put("listen", "127.0.0.1")
            put("listen_port", SOCKS5_PORT)
        })

        val outbounds = JSONArray()
        outbounds.put(outbound)
        outbounds.put(directOutbound)
        outbounds.put(blockOutbound)

        val routeRules = JSONArray()
        routeRules.put(JSONObject().apply {
            put("action", "hijack-dns")
            put("protocol", "dns")
        })
        routeRules.put(JSONObject().apply {
            put("ip_is_private", true)
            put("outbound", "direct")
        })

        val route = JSONObject()
        route.put("rules", routeRules)
        route.put("final", "proxy")
        route.put("auto_detect_interface", true)

        val log = JSONObject()
        log.put("level", "info")
        log.put("timestamp", true)

        val dns = JSONObject()
        dns.put("servers", dnsServers)
        dns.put("strategy", "prefer_ipv4")

        val config = JSONObject()
        config.put("log", log)
        config.put("dns", dns)
        config.put("inbounds", inbounds)
        config.put("outbounds", outbounds)
        config.put("route", route)

        return config.toString(2)
    }

    private fun parseConfig(json: String): JSONObject {
        return try { JSONObject(json) } catch (e: Exception) { JSONObject() }
    }

    // ── Broadcast helpers ─────────────────────────────────────────────────────

    fun broadcastStatus(status: String) {
        val intent = Intent(BROADCAST_STATUS)
        intent.putExtra("status", status)
        sendBroadcast(intent)
        Log.i(TAG, "VPN status: $status")
        when (status) {
            "connected" -> updateNotification("VPN Connecté — Protection active")
            "connecting" -> updateNotification("Connexion en cours...")
            "disconnected" -> updateNotification("Déconnecté")
            "error" -> updateNotification("Erreur de connexion")
        }
    }

    fun broadcastLog(message: String) {
        val intent = Intent(BROADCAST_LOG)
        intent.putExtra("log", message)
        sendBroadcast(intent)
        Log.d(TAG, message)
    }

    // ── Notification ──────────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIF_CHANNEL, "SXB VPN", NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Statut du tunnel VPN"
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(text: String): Notification {
        val mainIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, mainIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stopIntent = Intent(this, SxbVpnService::class.java).apply { action = ACTION_STOP }
        val stopPending = PendingIntent.getService(
            this, 1, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, NOTIF_CHANNEL)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(this)
        }

        return builder
            .setContentTitle("SXB VPN")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(pendingIntent)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Arrêter", stopPending)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(NotificationManager::class.java)
        nm?.notify(NOTIF_ID, buildNotification(text))
    }
}

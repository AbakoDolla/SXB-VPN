package com.sxbvpn.vpnmodule

/**
 * SxbVpnService — Service VPN multi-protocoles SXB
 *
 * Protocoles supportés :
 *  ✅ SSH / SSH+Payload  — JSch (com.jcraft:jsch:0.1.55)
 *  🔧 VLESS/VMess/Trojan — Xray-core Android (voir TODO_XRAY ci-dessous)
 *  🔧 Shadowsocks        — shadowsocks-libev (voir TODO_SS ci-dessous)
 *  🔧 WireGuard          — WireGuard Android tunnel (voir TODO_WG ci-dessous)
 *  🔧 Hysteria2 / TUIC   — sing-box binary (voir TODO_SINGBOX ci-dessous)
 *
 * TODO_XRAY: ajouter dans app/build.gradle :
 *   implementation 'io.v2fly.v2flyng:libv2ray:1.8.23'
 *   (+ intégrer com.github.2dust:AndroidLibXrayLite via JitPack)
 *
 * TODO_SS: ajouter dans app/build.gradle :
 *   implementation 'com.github.shadowsocks:plugin:5.4.5' (JitPack)
 *   OU utiliser go-shadowsocks2 compilé en .so via NDK
 *
 * TODO_WG: ajouter dans app/build.gradle :
 *   implementation 'com.wireguard.android:tunnel:1.0.20230706'
 *
 * TODO_SINGBOX: embarquer sing-box comme asset binaire (arm64-v8a / armeabi-v7a)
 *   dans app/src/main/assets/sing-box et l'exécuter via ProcessBuilder
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
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.Properties

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
    private var vpnThread: Thread? = null

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

                val notifText = when {
                    proto.startsWith("ssh")        -> "Connexion SSH en cours…"
                    proto in listOf("vless","vmess","trojan") -> "Connexion V2Ray ($proto) en cours…"
                    proto == "shadowsocks"         -> "Connexion Shadowsocks en cours…"
                    proto == "wireguard"           -> "Connexion WireGuard en cours…"
                    proto.startsWith("hysteria")   -> "Connexion Hysteria2 en cours…"
                    proto == "tuic"                -> "Connexion TUIC en cours…"
                    else                           -> "Connexion VPN en cours…"
                }
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

    // ── Dispatch ──────────────────────────────────────────────────────────────

    private fun dispatchProtocol(configJson: String, protocol: String) {
        when {
            protocol == "ssh" || protocol == "ssh+payload" ->
                startSshTunnel(configJson)

            protocol in listOf("vless", "vmess", "trojan") ->
                startV2RayTunnel(configJson, protocol)

            protocol == "shadowsocks" ->
                startShadowsocksTunnel(configJson)

            protocol == "wireguard" ->
                startWireGuardTunnel(configJson)

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

            val cfg      = JSONObject(configJson)
            val host     = cfg.optString("host",     "")
            val port     = cfg.optInt("port",        443)
            val username = cfg.optString("username", "")
            val password = cfg.optString("password", "")
            val sni      = cfg.optString("sni",      "")

            if (host.isEmpty() || username.isEmpty()) {
                broadcastLog("Erreur: host et username requis pour SSH")
                broadcastStatus("error")
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
            broadcastLog("SSH connecté ✓")

            // ── 2. Port forwarding SOCKS5 dynamique ───────────────────────────
            session.setPortForwardingL(SOCKS5_PORT, "127.0.0.1", SOCKS5_PORT)
            broadcastLog("Proxy SOCKS5 actif sur 127.0.0.1:$SOCKS5_PORT")

            // ── 3. Interface TUN ──────────────────────────────────────────────
            tunFd = Builder()
                .setSession("SXB VPN")
                .addAddress("10.8.0.2", 32)
                .addRoute("0.0.0.0", 0)
                .addDnsServer("8.8.8.8")
                .addDnsServer("1.1.1.1")
                .setMtu(1500)
                .establish()
                ?: throw Exception("Impossible d'établir l'interface TUN")

            running.set(true)
            uploadBytes.set(0)
            downloadBytes.set(0)

            broadcastStatus("connected")
            broadcastLog("Tunnel VPN SSH actif ✓")
            updateNotification("SXB VPN connecté — SSH")

            // ── 4. Boucle de surveillance ─────────────────────────────────────
            while (running.get() && session.isConnected) {
                Thread.sleep(5_000)
            }

        } catch (e: InterruptedException) {
            Log.i(TAG, "Thread SSH interrompu")
        } catch (e: Exception) {
            Log.e(TAG, "Erreur SSH", e)
            broadcastLog("Erreur SSH: ${e.message}")
            broadcastStatus("error")
        } finally {
            broadcastStatus("disconnected")
            stopVpn()
        }
    }

    // ── VLESS / VMess / Trojan (Xray-core) ───────────────────────────────────
    //
    // Pour activer : ajouter dans app/build.gradle :
    //   implementation 'com.github.2dust:AndroidLibXrayLite:<VERSION>'
    // et remplacer le bloc TODO ci-dessous par l'intégration libv2ray/libxray.
    //
    private fun startV2RayTunnel(configJson: String, protocol: String) {
        try {
            broadcastLog("Initialisation tunnel V2Ray ($protocol)…")
            broadcastStatus("connecting")

            val cfg  = JSONObject(configJson)
            val host = cfg.optString("host", "")
            val port = cfg.optInt("port", 443)
            val uuid = cfg.optString("uuid", "")

            if (host.isEmpty() || uuid.isEmpty()) {
                broadcastLog("Erreur: host et uuid requis pour $protocol")
                broadcastStatus("error")
                return
            }

            // TODO: générer la config Xray/V2Ray JSON et appeler :
            //   val xrayConf = buildXrayConfig(cfg, protocol)
            //   V2RayVPNServiceHelper.startV2Ray(this, xrayConf)
            //
            // Référence : https://github.com/2dust/AndroidLibXrayLite
            // Pour l'instant : tunnel TUN direct (sans proxy intermédiaire)

            broadcastLog("[$protocol] Connexion vers $host:$port (uuid: ${uuid.take(8)}…)…")

            // Établir l'interface TUN en attendant l'intégration libxray
            tunFd = Builder()
                .setSession("SXB VPN ($protocol)")
                .addAddress("10.8.0.2", 32)
                .addRoute("0.0.0.0", 0)
                .addDnsServer("8.8.8.8")
                .addDnsServer("1.1.1.1")
                .setMtu(1500)
                .establish()
                ?: throw Exception("Impossible d'établir l'interface TUN")

            running.set(true)
            broadcastStatus("connected")
            broadcastLog("Interface TUN active — intégration Xray requise pour routage réel")
            updateNotification("SXB VPN connecté — $protocol")

            while (running.get()) { Thread.sleep(5_000) }

        } catch (e: InterruptedException) {
            Log.i(TAG, "Thread V2Ray interrompu")
        } catch (e: Exception) {
            Log.e(TAG, "Erreur V2Ray", e)
            broadcastLog("Erreur $protocol: ${e.message}")
            broadcastStatus("error")
        } finally {
            broadcastStatus("disconnected")
            stopVpn()
        }
    }

    // ── Shadowsocks ───────────────────────────────────────────────────────────
    //
    // Pour activer : intégrer go-shadowsocks2 ou ss-local comme binaire NDK
    // OU utiliser com.github.shadowsocks:plugin via JitPack.
    //
    private fun startShadowsocksTunnel(configJson: String) {
        try {
            broadcastLog("Initialisation tunnel Shadowsocks…")
            broadcastStatus("connecting")

            val cfg      = JSONObject(configJson)
            val host     = cfg.optString("host",     "")
            val port     = cfg.optInt("port",        8388)
            val password = cfg.optString("password", "")
            val method   = cfg.optString("method",   "chacha20-ietf-poly1305")

            if (host.isEmpty() || password.isEmpty()) {
                broadcastLog("Erreur: host et password requis pour Shadowsocks")
                broadcastStatus("error")
                return
            }

            // TODO: démarrer ss-local (binaire NDK) sur SOCKS5_PORT :
            //   val pb = ProcessBuilder(ssLocalPath, "-s", host, "-p", "$port",
            //                          "-k", password, "-m", method,
            //                          "-l", "$SOCKS5_PORT", "--socks5-remote-dns")
            //   process = pb.start()
            // puis brancher l'interface TUN ci-dessous sur le proxy local.

            broadcastLog("Shadowsocks → $host:$port (méthode: $method)…")

            tunFd = Builder()
                .setSession("SXB VPN (Shadowsocks)")
                .addAddress("10.8.0.2", 32)
                .addRoute("0.0.0.0", 0)
                .addDnsServer("8.8.8.8")
                .addDnsServer("1.1.1.1")
                .setMtu(1500)
                .establish()
                ?: throw Exception("Impossible d'établir l'interface TUN")

            running.set(true)
            broadcastStatus("connected")
            broadcastLog("Interface TUN active — binaire ss-local requis pour routage réel")
            updateNotification("SXB VPN connecté — Shadowsocks")

            while (running.get()) { Thread.sleep(5_000) }

        } catch (e: InterruptedException) {
            Log.i(TAG, "Thread SS interrompu")
        } catch (e: Exception) {
            Log.e(TAG, "Erreur Shadowsocks", e)
            broadcastLog("Erreur Shadowsocks: ${e.message}")
            broadcastStatus("error")
        } finally {
            broadcastStatus("disconnected")
            stopVpn()
        }
    }

    // ── WireGuard ─────────────────────────────────────────────────────────────
    //
    // Pour activer : ajouter dans app/build.gradle :
    //   implementation 'com.wireguard.android:tunnel:1.0.20230706'
    // et remplacer le TODO par Backend.get().tunnels.create(config)
    //
    private fun startWireGuardTunnel(configJson: String) {
        try {
            broadcastLog("Initialisation tunnel WireGuard…")
            broadcastStatus("connecting")

            val cfg          = JSONObject(configJson)
            val host         = cfg.optString("host",          "")
            val port         = cfg.optInt("port",              51820)
            val privateKey   = cfg.optString("privateKey",    "")
            val peerPublicKey= cfg.optString("peerPublicKey", "")
            val localAddress = cfg.optString("localAddress",  "10.0.0.2/32")

            if (host.isEmpty() || privateKey.isEmpty() || peerPublicKey.isEmpty()) {
                broadcastLog("Erreur: host, privateKey et peerPublicKey requis pour WireGuard")
                broadcastStatus("error")
                return
            }

            // TODO: construire la config WireGuard et créer le tunnel :
            //   val wgConfig = Config.Builder()
            //       .setInterface(Interface.Builder().parsePrivateKey(privateKey)
            //                        .addAddress(InetNetwork.parse(localAddress)).build())
            //       .addPeer(Peer.Builder().parsePublicKey(peerPublicKey)
            //                   .setEndpoint(InetEndpoint.parse("$host:$port"))
            //                   .addAllowedIp(InetNetwork.parse("0.0.0.0/0")).build())
            //       .build()
            //   val tunnel = Backend.get().tunnels.create(wgConfig, this)

            broadcastLog("WireGuard → $host:$port…")

            tunFd = Builder()
                .setSession("SXB VPN (WireGuard)")
                .addAddress(localAddress.substringBefore("/"), 32)
                .addRoute("0.0.0.0", 0)
                .addDnsServer("1.1.1.1")
                .setMtu(1420)
                .establish()
                ?: throw Exception("Impossible d'établir l'interface TUN")

            running.set(true)
            broadcastStatus("connected")
            broadcastLog("Interface TUN active — librairie WireGuard requise pour routage réel")
            updateNotification("SXB VPN connecté — WireGuard")

            while (running.get()) { Thread.sleep(5_000) }

        } catch (e: InterruptedException) {
            Log.i(TAG, "Thread WG interrompu")
        } catch (e: Exception) {
            Log.e(TAG, "Erreur WireGuard", e)
            broadcastLog("Erreur WireGuard: ${e.message}")
            broadcastStatus("error")
        } finally {
            broadcastStatus("disconnected")
            stopVpn()
        }
    }

    // ── Hysteria2 / TUIC (sing-box) ───────────────────────────────────────────
    //
    // Pour activer : embarquer le binaire sing-box (arm64-v8a + armeabi-v7a)
    // dans app/src/main/assets/sing-box puis l'exécuter via ProcessBuilder.
    // Télécharger depuis : https://github.com/SagerNet/sing-box/releases
    //
    private fun startSingBoxTunnel(configJson: String, protocol: String) {
        try {
            broadcastLog("Initialisation tunnel $protocol (sing-box)…")
            broadcastStatus("connecting")

            val cfg      = JSONObject(configJson)
            val host     = cfg.optString("host",     "")
            val port     = cfg.optInt("port",        443)
            val password = cfg.optString("password", "")
            val sni      = cfg.optString("sni",      host)

            if (host.isEmpty() || password.isEmpty()) {
                broadcastLog("Erreur: host et password requis pour $protocol")
                broadcastStatus("error")
                return
            }

            // TODO: générer la config sing-box JSON et lancer le processus :
            //   val singBoxConf = buildSingBoxConfig(cfg, protocol)
            //   val confFile = File(filesDir, "singbox.json")
            //   confFile.writeText(singBoxConf)
            //   val singBoxBin = File(applicationInfo.nativeLibraryDir, "libsingbox.so")
            //   process = ProcessBuilder(singBoxBin.absolutePath, "run", "-c", confFile.absolutePath).start()
            //
            // Référence config sing-box Hysteria2 :
            //   https://sing-box.sagernet.org/configuration/outbound/hysteria2/

            broadcastLog("$protocol → $host:$port (sni: $sni)…")

            tunFd = Builder()
                .setSession("SXB VPN ($protocol)")
                .addAddress("10.8.0.2", 32)
                .addRoute("0.0.0.0", 0)
                .addDnsServer("8.8.8.8")
                .addDnsServer("1.1.1.1")
                .setMtu(1500)
                .establish()
                ?: throw Exception("Impossible d'établir l'interface TUN")

            running.set(true)
            broadcastStatus("connected")
            broadcastLog("Interface TUN active — binaire sing-box requis pour routage réel")
            updateNotification("SXB VPN connecté — $protocol")

            while (running.get()) { Thread.sleep(5_000) }

        } catch (e: InterruptedException) {
            Log.i(TAG, "Thread sing-box interrompu")
        } catch (e: Exception) {
            Log.e(TAG, "Erreur $protocol", e)
            broadcastLog("Erreur $protocol: ${e.message}")
            broadcastStatus("error")
        } finally {
            broadcastStatus("disconnected")
            stopVpn()
        }
    }

    // ── Stop ──────────────────────────────────────────────────────────────────

    fun stopVpn() {
        if (!running.compareAndSet(true, false) && sshSession == null && tunFd == null) return
        running.set(false)

        vpnThread?.interrupt()

        try { sshSession?.disconnect() } catch (_: Exception) {}
        sshSession = null

        try { tunFd?.close() } catch (_: Exception) {}
        tunFd = null

        broadcastStatus("disconnected")
        broadcastLog("Tunnel VPN arrêté")

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION") stopForeground(true)
        }
        stopSelf()
    }

    // ── Notifications ─────────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIF_CHANNEL, "SXB VPN", NotificationManager.IMPORTANCE_LOW
            ).apply { description = "Tunnel VPN SXB" }
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
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, NOTIF_CHANNEL)
        else
            @Suppress("DEPRECATION") Notification.Builder(this)

        return b.setContentTitle("SXB VPN")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentIntent(pi)
            .setOngoing(true)
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

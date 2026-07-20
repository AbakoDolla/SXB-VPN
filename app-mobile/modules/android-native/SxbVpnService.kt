package com.sxbvpn.vpnmodule

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
                startForeground(NOTIF_ID, buildNotification("Connexion SSH en cours…"))
                vpnThread = Thread({ startVpn(config) }, "SxbVpnThread").also { it.start() }
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

    // ── Start ─────────────────────────────────────────────────────────────────

    private fun startVpn(configJson: String) {
        try {
            broadcastLog("Initialisation du tunnel SSH SXB VPN…")
            broadcastStatus("connecting")

            val cfg      = JSONObject(configJson)
            val host     = cfg.optString("host",     "node05.mikosi.fr.eu.org")
            val port     = cfg.optInt("port",         443)
            val username = cfg.optString("username", "bugsleuth")
            val password = cfg.optString("password", "")
            val sni      = cfg.optString("sni",      "")

            // ── 1. Connexion SSH ──────────────────────────────────────────────
            broadcastLog("Connexion SSH → $host:$port (user: $username)…")
            val jsch = JSch()
            val session: Session = jsch.getSession(username, host, port)
            if (password.isNotEmpty()) session.setPassword(password)

            val props = Properties()
            props["StrictHostKeyChecking"]  = "no"
            props["ServerAliveInterval"]    = "30"
            props["ServerAliveCountMax"]    = "3"
            if (sni.isNotEmpty()) props["hostname"] = sni
            session.setConfig(props)
            session.connect(30_000)
            sshSession = session
            broadcastLog("SSH connecté ✓")

            // ── 2. Port forwarding SOCKS5 dynamique ───────────────────────────
            session.setPortForwardingL(SOCKS5_PORT, "127.0.0.1", SOCKS5_PORT)
            broadcastLog("Proxy SOCKS5 actif sur 127.0.0.1:$SOCKS5_PORT")

            // ── 3. Interface TUN ──────────────────────────────────────────────
            val builder = Builder()
            builder.setSession("SXB VPN")
            builder.addAddress("10.8.0.2", 32)
            builder.addRoute("0.0.0.0", 0)
            builder.addDnsServer("8.8.8.8")
            builder.addDnsServer("1.1.1.1")
            builder.setMtu(1500)
            tunFd = builder.establish() ?: throw Exception("Impossible d'établir l'interface TUN")

            running.set(true)
            uploadBytes.set(0)
            downloadBytes.set(0)

            broadcastStatus("connected")
            broadcastLog("Tunnel VPN SSH actif ✓")
            updateNotification("SXB VPN connecté — tunnel SSH actif")

            // ── 4. Boucle de surveillance ─────────────────────────────────────
            while (running.get() && session.isConnected) {
                Thread.sleep(5_000)
            }

        } catch (e: InterruptedException) {
            Log.i(TAG, "Thread VPN interrompu")
        } catch (e: Exception) {
            Log.e(TAG, "Erreur démarrage VPN", e)
            broadcastLog("Erreur: ${e.message}")
            broadcastStatus("error")
        } finally {
            broadcastStatus("disconnected")
            stopVpn()
        }
    }

    // ── Stop ──────────────────────────────────────────────────────────────────

    private fun stopVpn() {
        if (!running.compareAndSet(true, false) && sshSession == null) return
        running.set(false)

        vpnThread?.interrupt()

        try { sshSession?.disconnect() } catch (_: Exception) {}
        sshSession = null

        try { tunFd?.close() } catch (_: Exception) {}
        tunFd = null

        broadcastStatus("disconnected")
        broadcastLog("Tunnel VPN SSH arrêté")

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
            ).apply { description = "Tunnel VPN SSH SXB" }
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

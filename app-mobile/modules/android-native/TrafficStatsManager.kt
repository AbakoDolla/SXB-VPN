package com.sxbvpn.vpnmodule

/**
 * TrafficStatsManager — Statistiques de trafic réelles via Android TrafficStats
 *
 * Utilise android.net.TrafficStats pour lire les octets réels échangés
 * via l'interface VPN (UID du processus courant).
 *
 * Upload   = octets envoyés par l'UID depuis le démarrage VPN
 * Download = octets reçus par l'UID depuis le démarrage VPN
 * Débit    = delta/seconde calculé sur fenêtre glissante de 1s
 */

import android.content.Context
import android.content.pm.PackageManager
import android.net.TrafficStats
import android.os.Process
import android.util.Log
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

class TrafficStatsManager {

    companion object {
        private const val TAG            = "SXB-TrafficStats"
        private const val POLL_INTERVAL  = 1_000L  // 1 seconde
        private const val UID_REMOVED    = -1L
    }

    private val uid = Process.myUid()

    // Baselines au démarrage VPN
    private var baselineTx = 0L
    private var baselineRx = 0L

    private val uidRxBaseline = HashMap<Int, Long>()
    private val uidTxBaseline = HashMap<Int, Long>()

    // Compteurs cumulatifs depuis le démarrage VPN
    private val totalUpload   = AtomicLong(0L)
    private val totalDownload = AtomicLong(0L)

    // Débits instantanés (octets/seconde)
    private val speedUpload   = AtomicLong(0L)
    private val speedDownload = AtomicLong(0L)

    // Valeurs du dernier poll UID pour calcul du débit de secours
    private var lastTx = 0L
    private var lastRx = 0L
    private var lastPollMs = 0L

    // Compteurs noyau de l’interface TUN. Ils sont préférés aux compteurs UID
    // du service, qui ne représentent pas le trafic des applications routées.
    @Volatile private var tunInterface: String? = null
    @Volatile private var tunAttached = false
    private var lastTunTx = 0L
    private var lastTunRx = 0L

    private val running = AtomicBoolean(false)
    private var pollThread: Thread? = null

    // ── Démarrage ─────────────────────────────────────────────────────────────

    fun start(context: Context? = null) {
        if (running.getAndSet(true)) return

        // Capturer les baselines AVANT de démarrer le poll
        baselineTx = safeGetTx()
        baselineRx = safeGetRx()
        lastTx     = baselineTx
        lastRx     = baselineRx
        lastPollMs = System.currentTimeMillis()
        totalUpload.set(0L)
        totalDownload.set(0L)
        speedUpload.set(0L)
        speedDownload.set(0L)
        tunInterface = null
        tunAttached = false
        lastTunTx = 0L
        lastTunRx = 0L

        uidRxBaseline.clear()
        uidTxBaseline.clear()
        if (context != null) {
            runCatching {
                val pm = context.packageManager
                for (app in pm.getInstalledApplications(0)) {
                    val r = safeGetUidRx(app.uid)
                    val t = safeGetUidTx(app.uid)
                    uidRxBaseline[app.uid] = r
                    uidTxBaseline[app.uid] = t
                }
            }
        }

        Log.i(TAG, "TrafficStats démarré — UID=$uid baseline TX=$baselineTx RX=$baselineRx")

        pollThread = Thread({
            while (running.get()) {
                try {
                    Thread.sleep(POLL_INTERVAL)
                    poll()
                } catch (_: InterruptedException) { break }
            }
        }, "SXB-TrafficPoll").apply { isDaemon = true; start() }
    }

    // ── Arrêt ─────────────────────────────────────────────────────────────────

    fun stop() {
        running.set(false)
        pollThread?.interrupt()
        pollThread = null
        tunAttached = false
        tunInterface = null
        Log.i(TAG, "TrafficStats arrêté — total UP=${totalUpload.get()} DOWN=${totalDownload.get()}")
    }

    // ── Poll périodique ───────────────────────────────────────────────────────

    private fun poll() {
        val nowMs = System.currentTimeMillis()
        val deltaMs = (nowMs - lastPollMs).coerceAtLeast(1L)

        // Dès que le TUN est attaché, ne jamais retomber sur TrafficStats UID :
        // le UID du service mesure surtout le contrôle/handshake et pas WhatsApp,
        // Chrome ou les autres applications acheminées par le VPN.
        if (tunAttached) {
            val tun = readTunCounters()
            if (tun == null) {
                speedUpload.set(0L)
                speedDownload.set(0L)
                lastPollMs = nowMs
                return
            }
            val deltaTx = (tun.first - lastTunTx).coerceAtLeast(0L)
            val deltaRx = (tun.second - lastTunRx).coerceAtLeast(0L)
            totalUpload.addAndGet(deltaTx)
            totalDownload.addAndGet(deltaRx)
            speedUpload.set(deltaTx * 1000L / deltaMs)
            speedDownload.set(deltaRx * 1000L / deltaMs)
            lastTunTx = tun.first
            lastTunRx = tun.second
            lastPollMs = nowMs
            return
        }

        val currentTx = safeGetTx()
        val currentRx = safeGetRx()
        if (currentTx == UID_REMOVED || currentRx == UID_REMOVED) return

        val deltaTx = (currentTx - lastTx).coerceAtLeast(0L)
        val deltaRx = (currentRx - lastRx).coerceAtLeast(0L)
        totalUpload.addAndGet(deltaTx)
        totalDownload.addAndGet(deltaRx)
        speedUpload.set(deltaTx * 1000L / deltaMs)
        speedDownload.set(deltaRx * 1000L / deltaMs)
        lastTx = currentTx
        lastRx = currentRx
        lastPollMs = nowMs
    }

    /** Appelé après Builder.establish(), quand le nom TUN est connu. */
    fun attachTunInterface(name: String?) {
        val clean = name?.trim().orEmpty()
        if (clean.isBlank()) {
            Log.w(TAG, "TUN attaché mais interface introuvable : compteurs TUN indisponibles")
            return
        }
        val counters = readTunCounters(clean)
        if (counters == null) {
            Log.w(TAG, "Interface TUN $clean sans compteurs noyau lisibles")
            return
        }
        tunInterface = clean
        lastTunTx = counters.first
        lastTunRx = counters.second
        // totalUpload.set(0L) // Ne plus réinitialiser lors du rattachement TUN
        // totalDownload.set(0L) // Conserver le cumul de la session globale
        speedUpload.set(0L)
        speedDownload.set(0L)
        tunAttached = true
        lastPollMs = System.currentTimeMillis()
        Log.i(TAG, "Compteurs TUN attachés — interface=$clean baseline_tx=${counters.first} baseline_rx=${counters.second}")
    }

    private fun readTunCounters(): Pair<Long, Long>? = readTunCounters(tunInterface)

    private fun readTunCounters(name: String?): Pair<Long, Long>? {
        val iface = name?.takeIf { it.isNotBlank() } ?: return null
        return runCatching {
            val tx = File("/sys/class/net/$iface/statistics/tx_bytes").readText().trim().toLong()
            val rx = File("/sys/class/net/$iface/statistics/rx_bytes").readText().trim().toLong()
            tx to rx
        }.getOrNull()
    }

    // ── Getters ───────────────────────────────────────────────────────────────

    fun hasTunCounters(): Boolean = tunAttached

    fun getStats(): TrafficSnapshot = TrafficSnapshot(
        uploadBytes   = totalUpload.get(),
        downloadBytes = totalDownload.get(),
        uploadSpeed   = speedUpload.get(),
        downloadSpeed = speedDownload.get(),
    )

    // ── Helpers TrafficStats ──────────────────────────────────────────────────

    private fun safeGetTx(): Long {
        return try {
            val v = TrafficStats.getUidTxBytes(uid)
            if (v == TrafficStats.UNSUPPORTED.toLong()) 0L else v
        } catch (_: Exception) { 0L }
    }

    private fun safeGetRx(): Long {
        return try {
            val v = TrafficStats.getUidRxBytes(uid)
            if (v == TrafficStats.UNSUPPORTED.toLong()) 0L else v
        } catch (_: Exception) { 0L }
    }

    private fun safeGetUidRx(uid: Int): Long {
        return try {
            val v = TrafficStats.getUidRxBytes(uid)
            if (v == TrafficStats.UNSUPPORTED.toLong()) 0L else v
        } catch (_: Exception) { 0L }
    }

    private fun safeGetUidTx(uid: Int): Long {
        return try {
            val v = TrafficStats.getUidTxBytes(uid)
            if (v == TrafficStats.UNSUPPORTED.toLong()) 0L else v
        } catch (_: Exception) { 0L }
    }

    // ── F5 — Consommation par application (Top 10) ────────────────────────────

    fun getPerAppStats(context: Context): List<AppTrafficInfo> {
        val pm = context.packageManager
        val installedApps = runCatching { pm.getInstalledApplications(0) }.getOrDefault(emptyList())
        val uidMap = HashMap<Int, AppTrafficInfo>()

        for (app in installedApps) {
            val uid = app.uid
            if (uidMap.containsKey(uid)) continue
            val rx = safeGetUidRx(uid)
            val tx = safeGetUidTx(uid)
            val baseRx = uidRxBaseline[uid] ?: 0L
            val baseTx = uidTxBaseline[uid] ?: 0L
            val deltaRx = (rx - baseRx).coerceAtLeast(0L)
            val deltaTx = (tx - baseTx).coerceAtLeast(0L)
            val total = deltaRx + deltaTx

            if (total > 0L) {
                val packages = runCatching { pm.getPackagesForUid(uid) }.getOrNull()
                val packageName = packages?.firstOrNull() ?: app.packageName ?: "uid:$uid"
                val appName = runCatching {
                    val ai = pm.getApplicationInfo(packageName, 0)
                    pm.getApplicationLabel(ai).toString()
                }.getOrDefault(packageName)

                uidMap[uid] = AppTrafficInfo(
                    packageName   = packageName,
                    appName       = appName,
                    uploadBytes   = deltaTx,
                    downloadBytes = deltaRx,
                    totalBytes    = total
                )
            }
        }
        return uidMap.values
            .sortedByDescending { it.totalBytes }
            .take(10)
    }

    // ── Data class ────────────────────────────────────────────────────────────

    data class TrafficSnapshot(
        val uploadBytes:   Long,
        val downloadBytes: Long,
        val uploadSpeed:   Long,  // bytes/sec
        val downloadSpeed: Long,  // bytes/sec
    )

    data class AppTrafficInfo(
        val packageName:   String,
        val appName:       String,
        val uploadBytes:   Long,
        val downloadBytes: Long,
        val totalBytes:    Long,
    )
}

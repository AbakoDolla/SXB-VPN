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
 *
 * DEUX COMPTEURS, DEUX RÔLES
 * ──────────────────────────
 * `totalUpload`/`totalDownload` comptent la SESSION en cours : ils repartent
 * de zéro à chaque démarrage du tunnel, et c'est ce qu'affiche « TRAFIC TEMPS
 * RÉEL ».
 *
 * `lifetimeUpload`/`lifetimeDownload` sont le COMPTEUR KILOMÉTRIQUE de
 * l'appareil : ils ne reculent jamais, sont écrits dans les préférences du
 * service et survivent donc à une reconnexion, à l'arrêt du moteur, à la mort
 * de l'application et au redémarrage du téléphone. C'est sur eux, et sur eux
 * seuls, que s'appuie la facturation du quota : tant que le service a mesuré
 * un octet, cet octet reste comptabilisé même si le fil JavaScript qui le
 * remonte a disparu entre-temps.
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
        private const val USAGE_PREFS    = "sxb_usage_odometer"
        private const val KEY_LIFETIME_UP   = "lifetime_upload_bytes"
        private const val KEY_LIFETIME_DOWN = "lifetime_download_bytes"

        /**
         * Compteur kilométrique lisible SANS service en vie.
         *
         * Quand le tunnel est arrêté, `SxbVpnService.instance` est nul. Rendre
         * zéro dans ce cas serait un mensonge dangereux : le livre de comptes
         * JavaScript s'y ancrerait, puis facturerait une seconde fois tout le
         * cumul dès la lecture suivante. La valeur vient donc du disque.
         */
        fun persistedLifetime(context: Context): Pair<Long, Long> = runCatching {
            val store = context.getSharedPreferences(USAGE_PREFS, Context.MODE_PRIVATE)
            store.getLong(KEY_LIFETIME_UP, 0L).coerceAtLeast(0L) to
                store.getLong(KEY_LIFETIME_DOWN, 0L).coerceAtLeast(0L)
        }.getOrDefault(0L to 0L)
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

    // Compteur kilométrique durable — jamais remis à zéro, écrit sur disque.
    private val lifetimeUpload   = AtomicLong(0L)
    private val lifetimeDownload = AtomicLong(0L)
    @Volatile private var usageStore: android.content.SharedPreferences? = null
    private val unsavedBytes = AtomicLong(0L)
    @Volatile private var lastPersistMs = 0L

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
    @Volatile private var tunCountersReadable = false
    private var lastTunTx = 0L
    private var lastTunRx = 0L

    private val running = AtomicBoolean(false)
    private var pollThread: Thread? = null

    // ── Démarrage ─────────────────────────────────────────────────────────────

    fun start(context: Context? = null) {
        if (running.getAndSet(true)) return

        // Le compteur durable est rechargé AVANT toute mesure : une reconnexion
        // reprend exactement là où la session précédente s'est arrêtée.
        if (context != null && usageStore == null) {
            usageStore = runCatching { context.getSharedPreferences(USAGE_PREFS, Context.MODE_PRIVATE) }.getOrNull()
        }
        usageStore?.let { store ->
            lifetimeUpload.set(runCatching { store.getLong(KEY_LIFETIME_UP, 0L) }.getOrDefault(0L).coerceAtLeast(0L))
            lifetimeDownload.set(runCatching { store.getLong(KEY_LIFETIME_DOWN, 0L) }.getOrDefault(0L).coerceAtLeast(0L))
        }
        unsavedBytes.set(0L)
        lastPersistMs = System.currentTimeMillis()

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
        tunCountersReadable = false
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

        Log.i(TAG, "TrafficStats démarré — UID=$uid baseline TX=$baselineTx RX=$baselineRx " +
            "cumul_durable UP=${lifetimeUpload.get()} DOWN=${lifetimeDownload.get()}")

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
        tunCountersReadable = false
        tunInterface = null
        // Dernière écriture avant l'arrêt : une session qui se termine ne doit
        // jamais laisser d'octets mesurés hors du compteur durable.
        persistLifetime(force = true)
        Log.i(TAG, "TrafficStats arrêté — total UP=${totalUpload.get()} DOWN=${totalDownload.get()} " +
            "cumul_durable UP=${lifetimeUpload.get()} DOWN=${lifetimeDownload.get()}")
    }

    // ── Compteur durable ──────────────────────────────────────────────────────

    /** Additionne les octets mesurés à la session ET au compteur durable. */
    private fun accumulate(deltaTx: Long, deltaRx: Long) {
        if (deltaTx <= 0L && deltaRx <= 0L) return
        totalUpload.addAndGet(deltaTx)
        totalDownload.addAndGet(deltaRx)
        lifetimeUpload.addAndGet(deltaTx)
        lifetimeDownload.addAndGet(deltaRx)
        val pending = unsavedBytes.addAndGet(deltaTx + deltaRx)
        if (SxbUsageOdometer.shouldPersist(lastPersistMs, System.currentTimeMillis(), pending)) {
            persistLifetime(force = false)
        }
    }

    private fun persistLifetime(force: Boolean) {
        val store = usageStore ?: return
        if (!force && unsavedBytes.get() <= 0L) return
        runCatching {
            store.edit()
                .putLong(KEY_LIFETIME_UP, lifetimeUpload.get())
                .putLong(KEY_LIFETIME_DOWN, lifetimeDownload.get())
                .apply()
        }
        unsavedBytes.set(0L)
        lastPersistMs = System.currentTimeMillis()
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
                tunCountersReadable = false
                speedUpload.set(0L)
                speedDownload.set(0L)
                lastPollMs = nowMs
                return
            }
            val deltaTx = SxbUsageOdometer.step(lastTunTx, tun.first)
            val deltaRx = SxbUsageOdometer.step(lastTunRx, tun.second)
            accumulate(deltaTx, deltaRx)
            speedUpload.set(deltaTx * 1000L / deltaMs)
            speedDownload.set(deltaRx * 1000L / deltaMs)
            lastTunTx = tun.first
            lastTunRx = tun.second
            lastPollMs = nowMs
            tunCountersReadable = true
            return
        }

        val currentTx = safeGetTx()
        val currentRx = safeGetRx()
        if (currentTx == UID_REMOVED || currentRx == UID_REMOVED) return

        val deltaTx = SxbUsageOdometer.step(lastTx, currentTx)
        val deltaRx = SxbUsageOdometer.step(lastRx, currentRx)
        accumulate(deltaTx, deltaRx)
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
        // Android peut publier le nom de l’interface avant que /sys/class/net/<if>/statistics
        // soit immédiatement lisible. Réessayer brièvement évite de retomber sur les
        // compteurs UID, qui ne représentent pas les applications routées dans le VPN.
        var counters: Pair<Long, Long>? = null
        for (attempt in 0 until 20) {
            counters = readTunCounters(clean)
            if (counters != null) break
            if (attempt < 19) {
                try { Thread.sleep(100L) } catch (_: InterruptedException) { return }
            }
        }
        val baseline = counters ?: run {
            Log.w(TAG, "Interface TUN $clean sans compteurs noyau lisibles après 2s")
            return
        }
        tunInterface = clean
        lastTunTx = baseline.first
        lastTunRx = baseline.second
        // totalUpload.set(0L) // Ne plus réinitialiser lors du rattachement TUN
        // totalDownload.set(0L) // Conserver le cumul de la session globale
        speedUpload.set(0L)
        speedDownload.set(0L)
        tunAttached = true
        tunCountersReadable = true
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

    fun hasTunCounters(): Boolean = tunAttached && tunCountersReadable

    fun getStats(): TrafficSnapshot = TrafficSnapshot(
        uploadBytes   = totalUpload.get(),
        downloadBytes = totalDownload.get(),
        uploadSpeed   = speedUpload.get(),
        downloadSpeed = speedDownload.get(),
        lifetimeUploadBytes   = lifetimeUpload.get(),
        lifetimeDownloadBytes = lifetimeDownload.get(),
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
        // Compteur kilométrique : jamais remis à zéro, jamais décroissant.
        val lifetimeUploadBytes:   Long = 0L,
        val lifetimeDownloadBytes: Long = 0L,
    )

    data class AppTrafficInfo(
        val packageName:   String,
        val appName:       String,
        val uploadBytes:   Long,
        val downloadBytes: Long,
        val totalBytes:    Long,
    )
}

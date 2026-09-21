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
 * seuls, que s'appuie la facturation du quota. Chaque instantané exporté est
 * confirmé sur disque avant de rejoindre JavaScript. Une fin brutale avant
 * le prochain relevé/checkpoint peut encore perdre une fin de trafic privée,
 * mais ne fait jamais reculer un cumul déjà exposé par cette version.
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
        private var checkpoint: SxbUsageCheckpoint? = null

        @Synchronized
        private fun usageCheckpoint(context: Context): SxbUsageCheckpoint {
            checkpoint?.let { return it }
            val store = context.getSharedPreferences(USAGE_PREFS, Context.MODE_PRIVATE)
            return SxbUsageCheckpoint(
                load = {
                    store.getLong(KEY_LIFETIME_UP, 0L) to store.getLong(KEY_LIFETIME_DOWN, 0L)
                },
                commit = { snapshot ->
                    store.edit()
                        .putLong(KEY_LIFETIME_UP, snapshot.first)
                        .putLong(KEY_LIFETIME_DOWN, snapshot.second)
                        .commit()
                },
            ).also { checkpoint = it }
        }

        /**
         * Compteur kilométrique lisible SANS service en vie.
         *
         * Quand le tunnel est arrêté, `SxbVpnService.instance` est nul. Rendre
         * zéro dans ce cas serait un mensonge dangereux : le livre de comptes
         * JavaScript s'y ancrerait, puis facturerait une seconde fois tout le
         * cumul dès la lecture suivante. La valeur vient donc du disque.
         */
        fun persistedLifetime(context: Context): Pair<Long, Long> =
            usageCheckpoint(context).read()
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
    private var usageStore: SxbUsageCheckpoint? = null
    private val unsavedBytes = AtomicLong(0L)
    private var lastPersistMs = 0L
    private var persistenceErrorLogged = false

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

    // Octets REÇUS par les applications depuis que le TUN est attaché.
    //
    // `totalDownload` ne convient pas pour prouver qu'un tunnel achemine : il
    // cumule aussi les octets mesurés sur le UID du service avant l'attache du
    // TUN (négociation, contrôle), et il n'est volontairement pas remis à zéro
    // lors de l'attache afin de préserver le cumul de session.
    //
    // Ce compteur-ci ne retient que `rx_bytes` de l'interface TUN, c'est-à-dire
    // les octets que le moteur a REÉCRITS vers les applications. Il ne peut
    // progresser que si des données de retour ont réellement traversé le
    // tunnel de bout en bout : c'est la preuve recherchée, et non une
    // intention d'émission (`tx_bytes` progresse dès qu'une application tente
    // d'émettre, même vers un tunnel mort).
    private val tunReturnBytes = AtomicLong(0L)

    private val running = AtomicBoolean(false)
    private var pollThread: Thread? = null

    // ── Démarrage ─────────────────────────────────────────────────────────────

    @Synchronized
    fun start(context: Context) {
        if (running.get()) return

        // Le compteur durable est rechargé AVANT toute mesure : une reconnexion
        // reprend exactement là où la session précédente s'est arrêtée.
        initializeUsage(context)
        persistLifetime(force = true)
        running.set(true)
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
        runCatching {
            val pm = context.packageManager
            for (app in pm.getInstalledApplications(0)) {
                val r = safeGetUidRx(app.uid)
                val t = safeGetUidTx(app.uid)
                uidRxBaseline[app.uid] = r
                uidTxBaseline[app.uid] = t
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

    @Synchronized
    fun stop() {
        val wasRunning = running.getAndSet(false)
        pollThread?.interrupt()
        pollThread = null
        try {
            if (wasRunning) sample()
            if (usageStore != null) persistLifetime(force = true)
        } finally {
            tunAttached = false
            tunCountersReadable = false
            tunInterface = null
        }
        Log.i(TAG, "TrafficStats arrêté — total UP=${totalUpload.get()} DOWN=${totalDownload.get()} " +
            "cumul_durable UP=${lifetimeUpload.get()} DOWN=${lifetimeDownload.get()}")
    }

    // ── Compteur durable ──────────────────────────────────────────────────────

    private fun initializeUsage(context: Context) {
        if (usageStore != null) return
        val store = usageCheckpoint(context)
        val persisted = store.read()
        lifetimeUpload.set(persisted.first)
        lifetimeDownload.set(persisted.second)
        usageStore = store
    }

    /** Additionne les octets mesurés à la session ET au compteur durable. */
    private fun accumulate(deltaTx: Long, deltaRx: Long) {
        if (deltaTx <= 0L && deltaRx <= 0L) return
        totalUpload.addAndGet(deltaTx)
        totalDownload.addAndGet(deltaRx)
        lifetimeUpload.addAndGet(deltaTx)
        lifetimeDownload.addAndGet(deltaRx)
        unsavedBytes.addAndGet(deltaTx + deltaRx)
    }

    private fun persistLifetime(force: Boolean, snapshot: TrafficSnapshot = captureSnapshot()) {
        val store = checkNotNull(usageStore) { "USAGE_CHECKPOINT_UNAVAILABLE" }
        val pending = unsavedBytes.get()
        if (!force && !SxbUsageOdometer.shouldPersist(lastPersistMs, System.currentTimeMillis(), pending)) return
        try {
            store.write(snapshot.lifetimeUploadBytes to snapshot.lifetimeDownloadBytes)
        } catch (error: Exception) {
            if (!persistenceErrorLogged) Log.e(TAG, "USAGE_CHECKPOINT_UNAVAILABLE", error)
            persistenceErrorLogged = true
            throw error
        }
        persistenceErrorLogged = false
        unsavedBytes.set(0L)
        lastPersistMs = System.currentTimeMillis()
    }

    // ── Poll périodique ───────────────────────────────────────────────────────

    @Synchronized
    private fun poll() {
        if (!running.get() || Thread.currentThread() !== pollThread) return
        sample()
        try {
            persistLifetime(force = false)
        } catch (_: Exception) {
            // L'erreur est journalisée ; les deltas restent en mémoire et seront
            // retentés. Les baselines ont déjà avancé, sans recompter le poll.
        }
    }

    @Synchronized
    fun sampleBeforeStop() {
        if (running.get()) sample()
    }

    private fun sample() {
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
            if (deltaRx > 0L) tunReturnBytes.addAndGet(deltaRx)
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
    @Synchronized
    fun attachTunInterface(name: String?) {
        if (!running.get()) return
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
        tunReturnBytes.set(0L)
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

    @Synchronized
    fun hasTunCounters(): Boolean = tunAttached && tunCountersReadable

    /**
     * Octets de RETOUR réellement remis aux applications depuis l'attache du TUN.
     *
     * Sert de preuve d'acheminement : tant que cette valeur vaut zéro, aucune
     * donnée n'est revenue par le tunnel et l'état « connecté » ne doit pas
     * être annoncé. La valeur est volontairement brute — c'est à l'appelant de
     * décider du seuil et du délai d'attente.
     */
    fun returnBytesSinceTunAttach(): Long = tunReturnBytes.get()

    @Synchronized
    fun getSessionStats(): SessionSnapshot = SessionSnapshot(
        totalUpload.get(), totalDownload.get(), speedUpload.get(), speedDownload.get(),
    )

    @Synchronized
    fun getStats(context: Context? = null): TrafficSnapshot {
        if (usageStore == null && context != null) initializeUsage(context)
        val captured = captureSnapshot()
        persistLifetime(force = true, snapshot = captured)
        return captured
    }

    private fun captureSnapshot(): TrafficSnapshot = TrafficSnapshot(
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

    data class SessionSnapshot(
        val uploadBytes: Long,
        val downloadBytes: Long,
        val uploadSpeed: Long,
        val downloadSpeed: Long,
    )

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

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

import android.net.TrafficStats
import android.os.Process
import android.util.Log
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

    // Compteurs cumulatifs depuis le démarrage VPN
    private val totalUpload   = AtomicLong(0L)
    private val totalDownload = AtomicLong(0L)

    // Débits instantanés (octets/seconde)
    private val speedUpload   = AtomicLong(0L)
    private val speedDownload = AtomicLong(0L)

    // Valeurs du dernier poll pour calcul du débit
    private var lastTx = 0L
    private var lastRx = 0L
    private var lastPollMs = 0L

    private val running = AtomicBoolean(false)
    private var pollThread: Thread? = null

    // ── Démarrage ─────────────────────────────────────────────────────────────

    fun start() {
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
        Log.i(TAG, "TrafficStats arrêté — total UP=${totalUpload.get()} DOWN=${totalDownload.get()}")
    }

    // ── Poll périodique ───────────────────────────────────────────────────────

    private fun poll() {
        val nowMs = System.currentTimeMillis()
        val currentTx = safeGetTx()
        val currentRx = safeGetRx()

        if (currentTx == UID_REMOVED || currentRx == UID_REMOVED) return

        val deltaTx = (currentTx - lastTx).coerceAtLeast(0L)
        val deltaRx = (currentRx - lastRx).coerceAtLeast(0L)
        val deltaMs = (nowMs - lastPollMs).coerceAtLeast(1L)

        totalUpload.addAndGet(deltaTx)
        totalDownload.addAndGet(deltaRx)

        // Débit en octets/seconde
        speedUpload.set(deltaTx * 1000L / deltaMs)
        speedDownload.set(deltaRx * 1000L / deltaMs)

        lastTx     = currentTx
        lastRx     = currentRx
        lastPollMs = nowMs
    }

    // ── Getters ───────────────────────────────────────────────────────────────

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

    // ── Data class ────────────────────────────────────────────────────────────

    data class TrafficSnapshot(
        val uploadBytes:   Long,
        val downloadBytes: Long,
        val uploadSpeed:   Long,  // bytes/sec
        val downloadSpeed: Long,  // bytes/sec
    )
}

package com.sxbvpn.vpnmodule

/**
 * AutoReconnectManager — Gestion de la reconnexion automatique VPN
 *
 * Stratégie : backoff exponentiel (1s → 2s → 4s → 8s → 16s → max 30s)
 * Max tentatives : 10 avant abandon
 */

import android.util.Log
import kotlinx.coroutines.*
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class AutoReconnectManager(
    private val onReconnect: () -> Unit,
    private val onGiveUp: () -> Unit,
    private val onLog: (String) -> Unit,
) {
    companion object {
        private const val TAG         = "SXB-AutoReconnect"
        private const val MAX_RETRIES = 10
        private const val BASE_DELAY  = 1_000L   // 1 seconde
        private const val MAX_DELAY   = 30_000L  // 30 secondes
    }

    private val enabled    = AtomicBoolean(false)
    private val retryCount = AtomicInteger(0)
    private var job: Job?  = null
    private val scope      = CoroutineScope(Dispatchers.IO + SupervisorJob())

    fun enable()  { enabled.set(true)  }
    fun disable() { enabled.set(false); cancel() }

    fun isEnabled() = enabled.get()

    /** Appelé quand la connexion est établie — réinitialise le compteur */
    fun onConnected() {
        retryCount.set(0)
        cancel()
    }

    /** Appelé quand la connexion est perdue — déclenche la reconnexion si activée */
    fun onDisconnected() {
        if (!enabled.get()) return
        val attempt = retryCount.incrementAndGet()
        if (attempt > MAX_RETRIES) {
            onLog("⚠️ Auto-reconnect : max tentatives atteint ($MAX_RETRIES) — abandon")
            Log.w(TAG, "Max retries reached")
            onGiveUp()
            return
        }
        val delay = (BASE_DELAY * (1L shl minOf(attempt - 1, 4))).coerceAtMost(MAX_DELAY)
        onLog("🔄 Auto-reconnect — tentative $attempt/$MAX_RETRIES dans ${delay / 1000}s...")
        Log.i(TAG, "Scheduling reconnect attempt $attempt in ${delay}ms")

        job = scope.launch {
            delay(delay)
            if (enabled.get()) {
                onLog("🔄 Reconnexion automatique...")
                onReconnect()
            }
        }
    }

    fun cancel() {
        job?.cancel()
        job = null
    }

    fun reset() {
        retryCount.set(0)
        cancel()
    }

    fun destroy() {
        scope.cancel()
    }
}

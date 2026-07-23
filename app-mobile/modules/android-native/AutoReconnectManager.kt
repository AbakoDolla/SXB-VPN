package com.sxbvpn.vpnmodule

/**
 * AutoReconnectManager — Gestion de la reconnexion automatique VPN
 *
 * Stratégie : délais fixes (5s → 15s → 30s) — max 3 tentatives avant abandon
 * Après 3 échecs : arrêt propre, pas de boucle infinie.
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
        private const val DBG         = "SXB_DEBUG"
        private const val MAX_RETRIES = 3

        /** Délais fixes en ms : tentative 1 → 5s, 2 → 15s, 3 → 30s */
        private val RETRY_DELAYS = longArrayOf(5_000L, 15_000L, 30_000L)
    }

    private val enabled    = AtomicBoolean(false)
    private val retryCount = AtomicInteger(0)
    private var job: Job?  = null
    private val scope      = CoroutineScope(Dispatchers.IO + SupervisorJob())

    fun enable()  { enabled.set(true);  Log.i(DBG, "[SXB_DEBUG] AUTO_RECONNECT_ENABLED") }
    fun disable() { enabled.set(false); cancel(); Log.i(DBG, "[SXB_DEBUG] AUTO_RECONNECT_DISABLED") }

    fun isEnabled() = enabled.get()

    /** Appelé quand la connexion est établie — réinitialise le compteur */
    fun onConnected() {
        retryCount.set(0)
        cancel()
        Log.i(DBG, "[SXB_DEBUG] AUTO_RECONNECT_RESET — connexion établie")
    }

    /** Appelé quand la connexion est perdue — déclenche la reconnexion si activée */
    fun onDisconnected() {
        if (!enabled.get()) return
        val attempt = retryCount.incrementAndGet()
        if (attempt > MAX_RETRIES) {
            Log.w(DBG, "[SXB_DEBUG] AUTO_RECONNECT_GIVEUP — max tentatives ($MAX_RETRIES) atteint — arrêt")
            onLog("❌ Auto-reconnect : $MAX_RETRIES tentatives échouées — arrêt propre")
            onGiveUp()
            return
        }
        val delay = RETRY_DELAYS.getOrElse(attempt - 1) { RETRY_DELAYS.last() }
        Log.i(DBG, "[SXB_DEBUG] AUTO_RECONNECT_SCHEDULED attempt=$attempt/$MAX_RETRIES delay=${delay/1000}s")
        onLog("🔄 Auto-reconnect — tentative $attempt/$MAX_RETRIES dans ${delay / 1000}s...")

        job = scope.launch {
            delay(delay)
            if (enabled.get()) {
                Log.i(DBG, "[SXB_DEBUG] AUTO_RECONNECT_FIRING attempt=$attempt")
                onLog("🔄 Reconnexion automatique (tentative $attempt)...")
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

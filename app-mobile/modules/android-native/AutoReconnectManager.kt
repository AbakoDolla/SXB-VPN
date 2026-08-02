package com.sxbvpn.vpnmodule

/**
 * AutoReconnectManager — Gestion de la reconnexion automatique VPN
 *
 * Stratégie : délais fixes (5s → 15s → 30s) — max 3 tentatives avant abandon
 * Après 3 échecs : arrêt propre, pas de boucle infinie.
 */

import com.sxbvpn.vpnmodule.SxbSecureLogger
import com.sxbvpn.vpnmodule.SxbSecureLogger.VpnEvent
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
        private const val MAX_RETRIES = 3

        /** Délais fixes en ms : tentative 1 → 5s, 2 → 15s, 3 → 30s */
        private val RETRY_DELAYS = longArrayOf(5_000L, 15_000L, 30_000L)
    }

    private val enabled    = AtomicBoolean(false)
    private val retryCount = AtomicInteger(0)
    private var job: Job?  = null
    private val scope      = CoroutineScope(Dispatchers.IO + SupervisorJob())

    fun enable()  { enabled.set(true);  SxbSecureLogger.vpn(SxbSecureLogger.VpnEvent.RECONNECT_ENABLED) }
    fun disable() { enabled.set(false); cancel(); SxbSecureLogger.vpn(SxbSecureLogger.VpnEvent.RECONNECT_DISABLED) }

    fun isEnabled() = enabled.get()

    /** Appelé quand la connexion est établie — réinitialise le compteur */
    fun onConnected() {
        retryCount.set(0)
        cancel()
        SxbSecureLogger.vpn(SxbSecureLogger.VpnEvent.RECONNECT_RESET)
    }

    /** Appelé quand la connexion est perdue — déclenche la reconnexion si activée.
     *  Guard contre les appels concurrents : si un job est déjà en cours, on l'ignore. */
    fun onDisconnected() {
        if (!enabled.get()) return
        // Éviter les double-déclenchements si un job est déjà programmé
        if (job?.isActive == true) {
            SxbSecureLogger.vpn(SxbSecureLogger.VpnEvent.RECONNECT_SKIP)
            return
        }
        val attempt = retryCount.incrementAndGet()
        if (attempt > MAX_RETRIES) {
            SxbSecureLogger.vpn(SxbSecureLogger.VpnEvent.RECONNECT_GIVEUP)
            onLog("❌ Auto-reconnect : $MAX_RETRIES tentatives échouées — arrêt propre")
            onGiveUp()
            return
        }
        val delay = RETRY_DELAYS.getOrElse(attempt - 1) { RETRY_DELAYS.last() }
        SxbSecureLogger.vpn(SxbSecureLogger.VpnEvent.RECONNECT_SCHEDULED)
        onLog("🔄 Auto-reconnect — tentative $attempt/$MAX_RETRIES dans ${delay / 1000}s...")

        job = scope.launch {
            delay(delay)
            if (enabled.get()) {
                SxbSecureLogger.vpn(SxbSecureLogger.VpnEvent.RECONNECT_FIRED)
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

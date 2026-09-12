package com.sxbvpn.vpnmodule

/**
 * AutoReconnectManager — Gestion de la reconnexion automatique VPN
 *
 * Ordonnanceur mince : toute la décision (« retenter, attendre, abandonner ? »)
 * vit dans [SxbReconnectPolicy], compilé et testé sans Android par le harnais
 * `tests/run-stability-policy.cjs`. Cette classe se contente d'observer l'état,
 * d'armer une minuterie et d'appeler les rappels du service.
 *
 * Deux garanties portées par cette classe :
 *
 *  • une tentative n'est COMPTÉE qu'au moment où elle démarre réellement, et
 *    seulement si un réseau est présent : un mode avion de dix minutes ne
 *    consomme rien et n'arme aucune minuterie ;
 *  • le retour du réseau relance le tunnel sans intervention de l'utilisateur,
 *    y compris après un abandon, tant que le service est vivant et que la
 *    reconnexion n'a pas été désarmée (arrêt volontaire, erreur permanente).
 */

import com.sxbvpn.vpnmodule.SxbSecureLogger
import com.sxbvpn.vpnmodule.SxbSecureLogger.VpnEvent
import kotlinx.coroutines.*
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

class AutoReconnectManager(
    private val onReconnect: () -> Unit,
    private val onGiveUp: () -> Unit,
    private val onLog: (String) -> Unit,
    /**
     * Y a-t-il un réseau capable d'Internet ?
     *
     * Interrogé à chaque décision plutôt que mémorisé : un booléen mis en cache
     * devient faux dès qu'un rappel système est manqué ou n'a pas pu être
     * enregistré, et une valeur périmée ferait soit attendre indéfiniment, soit
     * brûler des tentatives à vide. Le service répond à partir du décompte des
     * réseaux annoncés, ou d'une interrogation directe d'Android à défaut.
     */
    private val hasNetwork: () -> Boolean = { true },
    /** Le tunnel est-il monté ? Un réseau qui s'ajoute ne doit rien couper. */
    private val isTunnelUp: () -> Boolean = { false },
    /** Une tentative est-elle déjà en cours d'exécution ? */
    private val isDispatchInFlight: () -> Boolean = { false },
    /** Horloge monotone injectable — `elapsedRealtime()` en production. */
    private val elapsedMs: () -> Long = { System.nanoTime() / 1_000_000L },
) {
    private val enabled = AtomicBoolean(false)

    /** Refus définitif pour cette session : arrêt volontaire, erreur PERMANENTE. */
    private val stopped = AtomicBoolean(false)

    /**
     * Une tentative est armée.
     *
     * Ce drapeau ne peut PAS être remplacé par `job?.isActive` : `onReconnect()`
     * est synchrone et occupe la coroutine pendant toute la vie du tunnel. Le
     * job resterait donc actif pendant la tentative, l'échec suivant passerait
     * pour un doublon et plus aucune tentative ne serait jamais programmée.
     */
    private val attemptScheduled = AtomicBoolean(false)

    /**
     * Une reprise est due dès que le réseau revient.
     *
     * Maintenu vrai jusqu'au DÉMARRAGE effectif de la tentative de reprise :
     * si l'unique événement `onAvailable` est absorbé parce qu'une tentative
     * périmée tournait encore, le service peut réévaluer plus tard sans que le
     * retour du réseau soit perdu.
     */
    private val awaitingNetwork = AtomicBoolean(false)

    /** Échecs RÉELS consommés — incrémenté au démarrage effectif d'une tentative. */
    private val failedAttempts = AtomicInteger(0)

    /** Reprises consécutives n'ayant pas abouti à un tunnel monté. */
    private val resumeStreak = AtomicInteger(0)

    private val lastEventAtMs = AtomicLong(Long.MIN_VALUE / 4)

    private var job: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    @Synchronized
    fun enable() {
        // Un nouveau démarrage efface le refus de la session précédente :
        // l'utilisateur a pu corriger la configuration entre-temps.
        stopped.set(false)
        enabled.set(true)
        SxbSecureLogger.vpn(VpnEvent.RECONNECT_ENABLED)
    }

    @Synchronized
    fun disable() {
        enabled.set(false)
        awaitingNetwork.set(false)
        cancel()
        SxbSecureLogger.vpn(VpnEvent.RECONNECT_DISABLED)
    }

    /**
     * Désarme définitivement pour cette session : arrêt volontaire de
     * l'utilisateur, erreur permanente, configuration refusée, appareil révoqué.
     * Un retour du réseau ne doit RIEN relancer après cet appel.
     */
    @Synchronized
    fun markStopped(reason: String) {
        stopped.set(true)
        disable()
        onLog("[SXB_DEBUG] RECONNECT_STOPPED reason=$reason")
    }

    fun isEnabled() = enabled.get() && !stopped.get()

    /** Vrai tant qu'une reprise reste due au retour du réseau. */
    fun isAwaitingNetwork() = awaitingNetwork.get()

    /** Appelé quand la connexion est établie — réinitialise les compteurs. */
    @Synchronized
    fun onConnected() {
        failedAttempts.set(0)
        resumeStreak.set(0)
        awaitingNetwork.set(false)
        cancel()
        SxbSecureLogger.vpn(VpnEvent.RECONNECT_RESET)
    }

    /** Le système annonce un réseau capable d'Internet. */
    fun onNetworkAvailable() = evaluate(SxbReconnectPolicy.Trigger.NETWORK_AVAILABLE)

    /**
     * Réévalue une reprise due qui avait été absorbée, par exemple parce qu'une
     * tentative périmée occupait encore le moteur au moment de l'événement.
     */
    fun reevaluate() = evaluate(SxbReconnectPolicy.Trigger.NETWORK_AVAILABLE)

    /**
     * Un réseau a disparu. [stillAvailable] indique s'il en reste au moins un :
     * une bascule Wi-Fi → données mobiles n'est PAS une perte de connectivité.
     */
    @Synchronized
    fun onNetworkLost(stillAvailable: Boolean) {
        if (stillAvailable || !isEnabled()) return
        // Plus de radio : une tentative déjà armée ne pourrait qu'échouer à
        // vide. On l'annule et on passe en attente pure, sans minuterie.
        if (attemptScheduled.get()) {
            cancel()
            onLog("[SXB_DEBUG] RECONNECT_ATTEMPT_DEFERRED reason=no_network")
        }
        if (awaitingNetwork.compareAndSet(false, true)) {
            SxbSecureLogger.vpn(VpnEvent.RECONNECT_WAIT_NETWORK)
            onLog("📴 Réseau indisponible — reconnexion en attente du retour du réseau")
        }
    }

    /** Le tunnel est tombé — déclenche la reconnexion si elle est armée. */
    fun onDisconnected() = evaluate(SxbReconnectPolicy.Trigger.TUNNEL_LOST)

    private fun networkPresent() = runCatching { hasNetwork() }.getOrDefault(true)

    private fun snapshot() = SxbReconnectPolicy.State(
        enabled = enabled.get(),
        stopped = stopped.get(),
        networkAvailable = networkPresent(),
        attemptScheduled = attemptScheduled.get(),
        dispatchInFlight = runCatching { isDispatchInFlight() }.getOrDefault(false),
        connected = runCatching { isTunnelUp() }.getOrDefault(false),
        awaitingNetwork = awaitingNetwork.get(),
        failedAttempts = failedAttempts.get(),
        sinceLastEventMs = elapsedMs() - lastEventAtMs.get(),
    )

    @Synchronized
    private fun evaluate(trigger: SxbReconnectPolicy.Trigger) {
        val state = snapshot()
        when (SxbReconnectPolicy.decide(trigger, state)) {
            SxbReconnectPolicy.Decision.IGNORE -> Unit

            SxbReconnectPolicy.Decision.DEBOUNCE ->
                SxbSecureLogger.vpn(VpnEvent.RECONNECT_SKIP)

            SxbReconnectPolicy.Decision.WAIT_FOR_NETWORK -> {
                cancel()
                if (awaitingNetwork.compareAndSet(false, true)) {
                    SxbSecureLogger.vpn(VpnEvent.RECONNECT_WAIT_NETWORK)
                    onLog("📴 Aucun réseau — reconnexion suspendue, aucune tentative consommée")
                }
            }

            SxbReconnectPolicy.Decision.RETRY -> {
                val attempt = state.failedAttempts + 1
                schedule(
                    delayMs = SxbReconnectPolicy.retryDelayMs(attempt),
                    label = "tentative $attempt/${SxbReconnectPolicy.MAX_RETRIES}",
                )
            }

            SxbReconnectPolicy.Decision.RESUME -> {
                // Le réseau est revenu : les échecs mesurés sur la ligne
                // disparue ne disent plus rien de celle qui arrive.
                failedAttempts.set(0)
                SxbSecureLogger.vpn(VpnEvent.RECONNECT_NETWORK_BACK)
                schedule(
                    delayMs = SxbReconnectPolicy.resumeDelayMs(resumeStreak.getAndIncrement()),
                    label = "réseau revenu",
                )
            }

            SxbReconnectPolicy.Decision.GIVE_UP -> {
                cancel()
                SxbSecureLogger.vpn(VpnEvent.RECONNECT_GIVEUP)
                onLog("❌ Auto-reconnect : ${SxbReconnectPolicy.MAX_RETRIES} tentatives réelles échouées — arrêt propre")
                onGiveUp()
            }
        }
    }

    private fun schedule(delayMs: Long, label: String) {
        lastEventAtMs.set(elapsedMs())
        attemptScheduled.set(true)
        SxbSecureLogger.vpn(VpnEvent.RECONNECT_SCHEDULED)
        onLog("🔄 Auto-reconnect — $label dans ${delayMs / 1000}s...")
        job = scope.launch {
            delay(delayMs)
            if (!isEnabled()) { attemptScheduled.set(false); return@launch }
            // Dernière vérification : la radio a pu retomber pendant l'attente.
            // Une tentative sans réseau ne prouve rien et ne doit rien coûter.
            if (!networkPresent()) {
                attemptScheduled.set(false)
                awaitingNetwork.set(true)
                SxbSecureLogger.vpn(VpnEvent.RECONNECT_WAIT_NETWORK)
                onLog("📴 Réseau reperdu avant la tentative — compteur intact, attente du retour")
                return@launch
            }
            // La tentative COMMENCE : désarmer avant d'appeler le service, car
            // `onReconnect()` ne rend la main qu'à la mort du tunnel. Sans cela
            // l'échec suivant serait pris pour un doublon et aucune tentative
            // ultérieure ne serait plus jamais programmée.
            attemptScheduled.set(false)
            awaitingNetwork.set(false)
            val attempt = failedAttempts.incrementAndGet()
            SxbSecureLogger.vpn(VpnEvent.RECONNECT_FIRED)
            onLog("🔄 Reconnexion automatique (tentative réelle $attempt/${SxbReconnectPolicy.MAX_RETRIES})...")
            onReconnect()
        }
    }

    @Synchronized
    fun cancel() {
        attemptScheduled.set(false)
        job?.cancel()
        job = null
    }

    @Synchronized
    fun reset() {
        failedAttempts.set(0)
        resumeStreak.set(0)
        awaitingNetwork.set(false)
        cancel()
    }

    fun destroy() {
        scope.cancel()
    }
}

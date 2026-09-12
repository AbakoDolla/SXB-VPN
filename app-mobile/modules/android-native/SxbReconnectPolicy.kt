package com.sxbvpn.vpnmodule

/**
 * SxbReconnectPolicy — décision PURE de reprise du tunnel.
 *
 * Ce fichier ne contient aucune dépendance Android ni coroutine : il est
 * compilé et exécuté tel quel par le harnais `tests/run-stability-policy.cjs`.
 * Toute la logique « faut-il retenter, attendre, ou abandonner ? » vit ici afin
 * d'être prouvable sans appareil ni émulateur ; `AutoReconnectManager` ne garde
 * que l'ordonnancement (coroutine, minuterie) et l'état observable.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI CETTE POLITIQUE
 * ═══════════════════════════════════════════════════════════════════════════
 * L'ancienne politique était « 3 tentatives à 5 s / 15 s / 30 s puis abandon
 * définitif ». Elle confondait deux pannes qui n'ont rien à voir :
 *
 *  • le SERVEUR est injoignable alors que la ligne fonctionne — insister a un
 *    sens, mais pas indéfiniment ;
 *  • la RADIO est coupée (mode avion, tunnel ferroviaire, perte de couverture)
 *    — aucune tentative ne peut aboutir, et les brûler à vide condamnait le
 *    tunnel au bout d'une cinquantaine de secondes, sans retour possible.
 *
 * D'où les deux règles fondatrices :
 *
 *  1. UNE TENTATIVE N'EST CONSOMMÉE QUE SI UN RÉSEAU EXISTE. Sans réseau on
 *     n'arme aucune minuterie du tout : on attend l'événement système
 *     `onAvailable`. Une coupure de dix minutes coûte donc exactement zéro
 *     réveil, zéro octet et zéro tentative.
 *  2. LE RETOUR DU RÉSEAU EST UNE NOUVELLE CHANCE. Il remet le compteur
 *     d'échecs réels à zéro, parce que les échecs précédents ont été mesurés
 *     sur une ligne qui n'existe plus.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * BORNES
 * ═══════════════════════════════════════════════════════════════════════════
 * Deux reculs progressifs bornés, jamais une boucle serrée :
 *
 *  • ÉCHECS RÉELS (réseau présent) : 5 s → 10 s → 20 s → 40 s → 60 s, plafond
 *    à 60 s, cinq tentatives soit ~2 min 15 s de persistance. Un serveur
 *    momentanément saturé revient dans cette fenêtre ; au-delà, l'échec est
 *    structurel et marteler ne ferait que vider la batterie.
 *  • REPRISES (retour du réseau) : 2 s → 4 s → 8 s → 16 s → 30 s, plafond à
 *    30 s. Le premier délai laisse la pile Android finir son association
 *    (DHCP, DNS, validation du portail) : `onAvailable` annonce une interface,
 *    pas encore un Internet joignable. Le recul croissant borne le cas
 *    pathologique d'un réseau qui oscille — au pire une tentative toutes les
 *    30 s — et il est remis à zéro dès que le tunnel remonte.
 */
object SxbReconnectPolicy {

    /** Échecs RÉELS tolérés — jamais consommés en l'absence de réseau. */
    const val MAX_RETRIES = 5

    const val BASE_RETRY_DELAY_MS = 5_000L
    const val MAX_RETRY_DELAY_MS = 60_000L

    const val BASE_RESUME_DELAY_MS = 2_000L
    const val MAX_RESUME_DELAY_MS = 30_000L

    /**
     * Android émet plusieurs événements pour une même bascule (Wi-Fi qui tombe,
     * données mobiles qui montent, capacités qui changent). En dessous de ce
     * délai, un second événement décrit le même changement : on l'absorbe.
     */
    const val MIN_EVENT_INTERVAL_MS = 3_000L

    /** Ce qui vient de se produire. */
    enum class Trigger {
        /** Le tunnel est tombé (perte de lien, erreur moteur, échec de dispatch). */
        TUNNEL_LOST,

        /** Le système annonce qu'un réseau capable d'Internet est disponible. */
        NETWORK_AVAILABLE,
    }

    /** Ce qu'il faut faire. */
    enum class Decision {
        /** Rien à faire : reconnexion désactivée, arrêt volontaire, ou tunnel déjà debout. */
        IGNORE,

        /** Événement redondant d'une même bascule : absorbé, aucune action. */
        DEBOUNCE,

        /** Aucun réseau : attendre `onAvailable`, sans minuterie et sans consommer de tentative. */
        WAIT_FOR_NETWORK,

        /** Réseau présent et échec réel : planifier une tentative (elle consommera le compteur). */
        RETRY,

        /** Le réseau est revenu : reprendre, compteur d'échecs réels remis à zéro. */
        RESUME,

        /** Les échecs réels sont épuisés : arrêt propre. */
        GIVE_UP,
    }

    /**
     * Instantané de l'état observable au moment de l'événement.
     *
     * @param enabled           l'utilisateur a demandé la reconnexion automatique
     * @param stopped           arrêt volontaire, erreur PERMANENTE ou config refusée
     * @param networkAvailable  au moins un réseau capable d'Internet est présent
     * @param attemptScheduled  une tentative est déjà armée
     * @param dispatchInFlight  une tentative est en cours d'exécution
     * @param connected         le tunnel est monté
     * @param awaitingNetwork   une reprise est due dès que le réseau revient
     * @param failedAttempts    échecs RÉELS déjà consommés
     * @param sinceLastEventMs  temps écoulé depuis le dernier événement retenu
     */
    data class State(
        val enabled: Boolean = false,
        val stopped: Boolean = false,
        val networkAvailable: Boolean = false,
        val attemptScheduled: Boolean = false,
        val dispatchInFlight: Boolean = false,
        val connected: Boolean = false,
        val awaitingNetwork: Boolean = false,
        val failedAttempts: Int = 0,
        val sinceLastEventMs: Long = Long.MAX_VALUE,
    )

    fun decide(trigger: Trigger, state: State): Decision = when {
        // Règle 5 du cahier des charges : un refus légitime ne devient jamais
        // une boucle de reconnexion. L'arrêt volontaire, la configuration
        // refusée et les erreurs permanentes désarment la reconnexion en amont.
        !state.enabled || state.stopped -> Decision.IGNORE
        trigger == Trigger.NETWORK_AVAILABLE -> onNetworkAvailable(state)
        else -> onTunnelLost(state)
    }

    private fun onNetworkAvailable(state: State): Decision = when {
        // Une tentative est déjà armée ou en cours : la laisser courir plutôt
        // que d'en empiler une seconde pour la même bascule.
        state.attemptScheduled -> Decision.DEBOUNCE
        state.dispatchInFlight -> Decision.DEBOUNCE
        state.sinceLastEventMs < MIN_EVENT_INTERVAL_MS -> Decision.DEBOUNCE
        // Une reprise explicitement due prime sur l'état du tunnel précédent :
        // celui-ci a été perdu AVEC le réseau, il est périmé par construction.
        // Sans cette priorité, un « connected » obsolète absorberait le seul
        // événement de retour du réseau et le tunnel resterait à terre.
        state.awaitingNetwork -> Decision.RESUME
        // Le tunnel tient : Android a simplement ajouté une interface. On ne
        // bascule pas de transport et on ne coupe rien (règle 6).
        state.connected -> Decision.IGNORE
        else -> Decision.RESUME
    }

    private fun onTunnelLost(state: State): Decision = when {
        state.attemptScheduled -> Decision.DEBOUNCE
        // Cœur du correctif : sans réseau, une tentative ne peut pas aboutir.
        // On attend `onAvailable` au lieu de vider le compteur.
        !state.networkAvailable -> Decision.WAIT_FOR_NETWORK
        state.failedAttempts >= MAX_RETRIES -> Decision.GIVE_UP
        else -> Decision.RETRY
    }

    /**
     * Délai avant la tentative numéro `attempt` (1 = première), en ms.
     * Recul géométrique borné : 5 s, 10 s, 20 s, 40 s, 60 s, 60 s…
     */
    fun retryDelayMs(attempt: Int): Long {
        if (attempt <= 1) return BASE_RETRY_DELAY_MS
        var delay = BASE_RETRY_DELAY_MS
        var step = attempt
        while (step > 1 && delay < MAX_RETRY_DELAY_MS) {
            delay *= 2
            step--
        }
        return if (delay > MAX_RETRY_DELAY_MS) MAX_RETRY_DELAY_MS else delay
    }

    /**
     * Délai de stabilisation avant une reprise, en ms. `streak` compte les
     * reprises consécutives qui n'ont PAS abouti à un tunnel monté ; il repart
     * de zéro dès la connexion établie.
     */
    fun resumeDelayMs(streak: Int): Long {
        if (streak <= 0) return BASE_RESUME_DELAY_MS
        var delay = BASE_RESUME_DELAY_MS
        var step = streak
        while (step > 0 && delay < MAX_RESUME_DELAY_MS) {
            delay *= 2
            step--
        }
        return if (delay > MAX_RESUME_DELAY_MS) MAX_RESUME_DELAY_MS else delay
    }
}

package com.sxbvpn.vpnmodule

/**
 * SxbSshKeepAlive — vitalité du tunnel SSH et décision de reprise.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE FICHIER EXISTE
 * ═══════════════════════════════════════════════════════════════════════════
 * Le transport SSH est le seul de l'application à ne pas passer par le moteur
 * sing-box : il repose sur une session JSch qui alimente un serveur SOCKS5
 * local. Il ne bénéficie donc d'aucune surveillance du moteur, et c'est à nous
 * de répondre à une question que TCP ne pose jamais tout seul :
 *
 *   « le pair est-il encore là ? »
 *
 * Une session SSH inactive est indiscernable d'une session morte tant que
 * personne n'écrit dedans. Quand Google Cloud coupe une session oisive, quand
 * la NAT de l'opérateur oublie l'association, ou quand le lien tombe sans que
 * l'interface Android disparaisse, la socket reste « ouverte » côté client :
 * l'application affiche un tunnel connecté qui ne transporte plus rien, et
 * aucune reconnexion n'est déclenchée puisque rien n'a signalé de panne.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CE QUI NE MARCHAIT PAS
 * ═══════════════════════════════════════════════════════════════════════════
 * 1. Les options `ServerAliveInterval` / `ServerAliveCountMax` étaient passées
 *    à JSch via `Session.setConfig(Properties)`. JSch ne les lit JAMAIS par ce
 *    chemin : `applyConfig()` les cherche dans un `ConfigRepository` (fichier
 *    de configuration façon OpenSSH), jamais dans les `Properties` de session.
 *    Elles étaient donc inertes — du code décoratif qui donnait à lire une
 *    surveillance de 10 s × 3 qui n'existait pas. Pire : l'unique setter réel,
 *    `setServerAliveInterval(int)`, attend des MILLISECONDES ; la valeur « 10 »
 *    aurait signifié dix millisecondes, soit cent sondes par seconde.
 *
 * 2. Le délai de lecture effectif était donc celui de `Session.timeout`, c'est
 *    à dire le DÉLAI DE CONNEXION du profil (`timeoutMs`, 30 s par défaut mais
 *    jusqu'à 120 s). Deux réglages sans rapport étaient ainsi confondus : un
 *    profil tolérant à la lenteur d'un réseau mobile — donc avec un délai de
 *    connexion élevé — achetait cette tolérance au prix d'un tunnel mort non
 *    détecté pendant QUATRE MINUTES.
 *
 * 3. `serverAliveCountMax` restait à sa valeur par défaut, 1. Une seule sonde
 *    sans réponse suffisait à condamner la session.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA RÈGLE RETENUE
 * ═══════════════════════════════════════════════════════════════════════════
 * La vitalité est réglée séparément du délai de connexion, et bornée quelle
 * que soit la configuration du profil. Deux effets, pas un seul :
 *
 *  • DÉTECTION — au pire [detectionWindowMs] avant qu'un pair mort soit
 *    déclaré tel, indépendamment de `timeoutMs` ;
 *  • PRÉVENTION — une sonde toutes les [INTERVAL_MS] sur un tunnel inactif
 *    entretient l'association NAT de l'opérateur. C'est précisément l'absence
 *    de trafic pendant plusieurs dizaines de secondes qui fait oublier la
 *    connexion aux passerelles mobiles ; la sonde évite donc une partie des
 *    coupures au lieu de se contenter de les constater.
 *
 * Ce fichier ne contient ni dépendance Android, ni JSch, ni état : il se
 * compile et s'exécute sur une JVM ordinaire, ce qui permet de prouver la
 * règle en intégration continue (`tests/StabilityPolicyTest.kt`) sans appareil
 * ni émulateur.
 */
object SxbSshKeepAlive {

    /**
     * Intervalle entre deux sondes de vitalité, en MILLISECONDES.
     *
     * C'est l'unité attendue par `Session.setServerAliveInterval(int)` — la
     * confondre avec les secondes du fichier de configuration OpenSSH est
     * l'erreur exacte que ce fichier existe pour empêcher.
     *
     * Dix secondes : assez court pour entretenir une association NAT mobile
     * (souvent oubliée entre 30 s et 60 s d'inactivité), assez long pour que
     * le coût soit négligeable — une sonde ne pèse que quelques dizaines
     * d'octets, et elle n'est émise que si RIEN n'a été lu pendant tout
     * l'intervalle : un tunnel qui travaille n'en envoie aucune.
     */
    const val INTERVAL_MS = 10_000

    /**
     * Sondes consécutives sans réponse tolérées avant de déclarer le pair mort.
     *
     * La valeur par défaut de JSch est 1, ce qui condamne une session sur un
     * unique aller-retour manqué. Trois sondes laissent passer une congestion
     * passagère sans laisser traîner une session réellement morte.
     */
    const val COUNT_MAX = 3

    /** Période d'observation de la session par le service, en millisecondes. */
    const val POLL_INTERVAL_MS = 3_000L

    /**
     * Temps maximal entre la mort réelle du pair et sa constatation.
     *
     * La session tolère [COUNT_MAX] sondes sans réponse : c'est le silence du
     * (COUNT_MAX + 1)-ième intervalle qui la rompt. Le service constate ensuite
     * la rupture à sa prochaine observation, d'où le [POLL_INTERVAL_MS] final.
     */
    fun detectionWindowMs(): Long =
        INTERVAL_MS.toLong() * (COUNT_MAX + 1) + POLL_INTERVAL_MS

    /** État du tunnel SSH tel que l'observe le service. */
    enum class Liveness {
        /** Session vivante et moteur debout : rien à faire. */
        ALIVE,

        /** Le service s'arrête : sortir sans rien signaler. */
        SERVICE_STOPPED,

        /**
         * Cette session n'est plus celle du service.
         *
         * Une reprise démonte délibérément le tunnel précédent avant d'en
         * monter un neuf. L'ancien fil de surveillance voit alors sa session se
         * fermer et croirait à une panne : il signalerait une perte de tunnel
         * en pleine reconnexion, afficherait une erreur à l'utilisateur et
         * consommerait une tentative pour un démontage que nous avons
         * nous-mêmes provoqué. Il doit se retirer en silence.
         */
        SUPERSEDED,

        /** Le pair ne répond plus : reconnexion. */
        SSH_LOST,

        /** Le moteur TUN s'est arrêté sous le tunnel : reconnexion. */
        ENGINE_LOST,
    }

    /**
     * Que faut-il conclure de l'état observé ?
     *
     * L'ordre des questions est porteur de sens : « cette session est-elle
     * encore la nôtre ? » précède « est-elle connectée ? », sans quoi un
     * démontage volontaire serait lu comme une panne.
     *
     * @param serviceRunning  le service VPN est toujours actif
     * @param currentSession  la session observée est celle que détient le service
     * @param sessionConnected la session SSH se déclare connectée
     * @param engineRunning   le moteur qui porte le TUN est toujours instancié
     */
    fun classify(
        serviceRunning: Boolean,
        currentSession: Boolean,
        sessionConnected: Boolean,
        engineRunning: Boolean,
    ): Liveness = when {
        !serviceRunning -> Liveness.SERVICE_STOPPED
        !currentSession -> Liveness.SUPERSEDED
        !sessionConnected -> Liveness.SSH_LOST
        !engineRunning -> Liveness.ENGINE_LOST
        else -> Liveness.ALIVE
    }

    /** La reconnexion automatique doit-elle être déclenchée pour cet état ? */
    fun requiresReconnect(liveness: Liveness): Boolean =
        liveness == Liveness.SSH_LOST || liveness == Liveness.ENGINE_LOST
}

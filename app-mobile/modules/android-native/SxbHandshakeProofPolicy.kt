package com.sxbvpn.vpnmodule

/**
 * QUAND A-T-ON LE DROIT D'ANNONCER « CONNECTÉ » ?
 *
 * Le moteur a longtemps publié « connected » dès que `service.start()` rendait
 * la main. Cela ne prouvait rien : ni que le serveur distant répond, ni que la
 * session est authentifiée, ni qu'un octet circule. L'application annonçait donc
 * une réussite alors que l'utilisateur n'avait aucun accès — le reproche central
 * qui a motivé cette reprise.
 *
 * La décision est isolée ici, sans dépendance Android, pour être réellement
 * vérifiable par des tests (même convention que `SxbAccessPolicy`,
 * `SxbTunnelPolicy` et `SxbEngineLogPolicy`).
 *
 * ── Ce qui compte comme preuve ────────────────────────────────────────────────
 *
 * `tunReturnBytes` — `rx_bytes` de l'interface TUN : les octets que le moteur a
 * REÉCRITS vers les applications. Ils ne progressent que si des données de
 * retour ont traversé le tunnel de bout en bout.
 *
 * `tx_bytes` est délibérément absent de cette classe : il progresse dès qu'une
 * application tente d'émettre, y compris vers un tunnel mort. C'est exactement
 * l'erreur de raisonnement à ne pas reproduire.
 *
 * `sshRelayReturnBytes` — octets descendants comptés par le relais SOCKS5/SSH du
 * service lui-même. Même nature de preuve, mais lisible même quand
 * `/sys/class/net` est restreint par le constructeur.
 *
 * `engineHandshakeProof` — poignée de main d'un outbound proxy confirmée dans le
 * journal du moteur. Conservée, mais jamais présumée : le moteur tourne en
 * niveau `warn` et n'émet alors pas « connection established ».
 *
 * ── Ce qui n'en est pas ──────────────────────────────────────────────────────
 *
 * Un moteur démarré, un TUN ouvert, une session SSH authentifiée : ce sont des
 * étapes de transport. Elles autorisent l'attente, pas l'annonce.
 */
object SxbHandshakeProofPolicy {

    /**
     * Délai maximal d'attente d'une preuve après l'ouverture du TUN.
     *
     * Volontairement plus long que l'échelle de présentation du client
     * JavaScript (20 s) et que son chien de garde (45 s) : la couche haute
     * garde l'initiative de changer de stratégie, le natif n'est qu'un filet.
     */
    const val DEFAULT_TIMEOUT_MS = 60_000L

    /** Intervalle de scrutation des compteurs. */
    const val POLL_INTERVAL_MS = 500L

    enum class Verdict {
        /** Aucune preuve encore, le délai n'est pas écoulé : continuer d'attendre. */
        WAIT,

        /** Preuve d'acheminement obtenue : « connected » est mérité. */
        PROMOTE_MEASURED,

        /**
         * Délai écoulé ET aucune mesure possible sur cet appareil.
         *
         * L'absence de trafic n'est pas démontrée : refuser la connexion
         * casserait un tunnel peut-être sain. L'état est donc présumé — et
         * l'appelant DOIT l'annoncer comme tel, jamais comme une mesure.
         */
        PROMOTE_PRESUMED,

        /**
         * Délai écoulé, la mesure était possible, et elle n'a rien vu.
         * Le transport est monté mais le tunnel n'achemine pas : c'est un échec.
         */
        FAIL_NO_TRAFFIC,
    }

    data class Evidence(
        val tunReturnBytes: Long = 0L,
        val sshRelayReturnBytes: Long = 0L,
        val isSshRelay: Boolean = false,
        val hasTunCounters: Boolean = false,
        val engineHandshakeProof: Boolean = false,
        val elapsedMs: Long = 0L,
        val timeoutMs: Long = DEFAULT_TIMEOUT_MS,
    )

    /**
     * L'absence de trafic est-elle DÉMONTRABLE sur cet appareil ?
     *
     * Le relais SSH compte ses propres octets : la mesure y est toujours
     * possible. Pour les autres protocoles, tout dépend de la lisibilité des
     * compteurs noyau, que certains constructeurs restreignent.
     */
    fun measurable(evidence: Evidence): Boolean =
        evidence.isSshRelay || evidence.hasTunCounters

    fun evaluate(evidence: Evidence): Verdict {
        // Une preuve positive prime toujours sur le délai : un tunnel qui a
        // acheminé reste acheminant même si la preuve arrive tardivement.
        if (evidence.tunReturnBytes > 0L) return Verdict.PROMOTE_MEASURED
        if (evidence.isSshRelay && evidence.sshRelayReturnBytes > 0L) return Verdict.PROMOTE_MEASURED
        if (evidence.engineHandshakeProof) return Verdict.PROMOTE_MEASURED

        // Les octets du relais SSH ne valent que pour le chemin SSH : sur un
        // autre protocole, ce compteur appartient à une session antérieure.
        if (evidence.elapsedMs < evidence.timeoutMs) return Verdict.WAIT

        return if (measurable(evidence)) Verdict.FAIL_NO_TRAFFIC else Verdict.PROMOTE_PRESUMED
    }
}

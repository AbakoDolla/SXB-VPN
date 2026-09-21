package com.sxbvpn.vpnmodule

private typealias Evidence = SxbHandshakeProofPolicy.Evidence
private typealias Verdict = SxbHandshakeProofPolicy.Verdict

private var failures = 0

private fun check(name: String, expected: Verdict, evidence: Evidence) {
    val actual = SxbHandshakeProofPolicy.evaluate(evidence)
    if (actual == expected) {
        println("  ok   $name")
    } else {
        failures++
        println("  FAIL $name — attendu=$expected obtenu=$actual")
    }
}

fun main() {
    println("Politique de preuve d'acheminement")

    // ── Le cœur du reproche client : un moteur démarré n'est pas une connexion.
    check(
        "un TUN ouvert sans aucun octet n'autorise pas « connected »",
        Verdict.WAIT,
        Evidence(hasTunCounters = true, elapsedMs = 0L),
    )
    check(
        "une session SSH authentifiée mais muette n'autorise pas « connected »",
        Verdict.WAIT,
        Evidence(isSshRelay = true, elapsedMs = 1_000L),
    )

    // ── Preuves positives.
    check(
        "des octets revenus par le TUN prouvent l'acheminement",
        Verdict.PROMOTE_MEASURED,
        Evidence(tunReturnBytes = 1L, hasTunCounters = true),
    )
    check(
        "des octets revenus par le relais SSH prouvent l'acheminement",
        Verdict.PROMOTE_MEASURED,
        Evidence(sshRelayReturnBytes = 512L, isSshRelay = true),
    )
    check(
        "une poignée de main d'outbound proxy journalisée suffit",
        Verdict.PROMOTE_MEASURED,
        Evidence(engineHandshakeProof = true),
    )
    check(
        "une preuve tardive reste une preuve",
        Verdict.PROMOTE_MEASURED,
        Evidence(tunReturnBytes = 4_096L, hasTunCounters = true, elapsedMs = 600_000L),
    )

    // ── Le compteur du relais SSH n'appartient qu'au chemin SSH.
    check(
        "les octets du relais SSH ne valent pas pour un autre protocole",
        Verdict.WAIT,
        Evidence(sshRelayReturnBytes = 9_999L, isSshRelay = false, hasTunCounters = true),
    )

    // ── Échéance : les deux issues doivent être distinguées.
    check(
        "mesure possible et rien vu à l'échéance : échec franc",
        Verdict.FAIL_NO_TRAFFIC,
        Evidence(hasTunCounters = true, elapsedMs = SxbHandshakeProofPolicy.DEFAULT_TIMEOUT_MS),
    )
    check(
        "chemin SSH muet à l'échéance : échec franc, la mesure y est toujours possible",
        Verdict.FAIL_NO_TRAFFIC,
        Evidence(isSshRelay = true, elapsedMs = SxbHandshakeProofPolicy.DEFAULT_TIMEOUT_MS),
    )
    check(
        "compteurs illisibles à l'échéance : état présumé, jamais un échec inventé",
        Verdict.PROMOTE_PRESUMED,
        Evidence(hasTunCounters = false, elapsedMs = SxbHandshakeProofPolicy.DEFAULT_TIMEOUT_MS),
    )

    // ── Bornes.
    check(
        "une milliseconde avant l'échéance, on attend encore",
        Verdict.WAIT,
        Evidence(hasTunCounters = true, elapsedMs = SxbHandshakeProofPolicy.DEFAULT_TIMEOUT_MS - 1L),
    )

    if (failures > 0) {
        println("$failures test(s) en échec")
        kotlin.system.exitProcess(1)
    }
    println("Tous les cas passent")
}

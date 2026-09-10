package com.sxbvpn.vpnmodule

/** No endpoints or raw log lines are retained in diagnostic state. */
object SxbEngineLogPolicy {
    enum class OperationalError { HTTP_404, HTTP_429, PACKET_DENIED, PACKET_FAILURE }
    enum class Failure { HTTP, DNS, OUTBOUND }
    private val osc = Regex("\u001B\\][^\u0007\u001B]*(?:\u0007|\u001B\\\\)")
    private val csi = Regex("(?:\u001B\\[|\u009B)[0-?]*[ -/]*[@-~]")
    private val sgrWithoutEscape = Regex("\\[(?:\\d{1,3}(?:;\\d{0,3})*)?m")
    private val controls = Regex("[\\p{Cc}&&[^\\n\\t]]")
    private val httpStatus = Regex("(?:unexpected (?:http response )?status|http(?:/\\d(?:\\.\\d)?)?(?: response)?(?: status)?)\\s*[:=]?\\s*(404|429)\\b")

    fun clean(message: String): String =
        controls.replace(sgrWithoutEscape.replace(csi.replace(osc.replace(message, ""), ""), ""), "")

    fun operationalError(lower: String): OperationalError? {
        val status = httpStatus.find(lower)?.groupValues?.get(1)
        if (status == "404") return OperationalError.HTTP_404
        if (status == "429") return OperationalError.HTTP_429
        if (lower.contains("listen outbound packet connection")) {
            return if (lower.contains("operation not permitted")) OperationalError.PACKET_DENIED else OperationalError.PACKET_FAILURE
        }
        return null
    }

    fun failure(lower: String): Failure? {
        if (lower.contains("context canceled") || lower.contains("use of closed network connection")) return null
        return when (operationalError(lower)) {
            OperationalError.HTTP_404, OperationalError.HTTP_429 -> Failure.HTTP
            // sing-box's intentional block outbound returns EPERM for packets.
            // This context is not evidence that DNS/bootstrap or Android permissions failed.
            OperationalError.PACKET_DENIED -> null
            else -> when {
                lower.contains("dns: exchange failed") ||
                    (lower.contains("lookup ") && (lower.contains("i/o timeout") || lower.contains("no such host"))) -> Failure.DNS
                lower.contains("open outbound connection") || lower.contains("listen outbound packet connection") -> Failure.OUTBOUND
                else -> null
            }
        }
    }

    /**
     * One actionable line per operational error. `alternateUpstreams` is the
     * number of OTHER declared HTTP upstreams the engine can switch to, so the
     * message says what is happening instead of listing every possible origin.
     * It never claims a carrier, permission or provider verdict, and no tunnel
     * is ever torn down or re-established from here.
     */
    fun operationalLabel(error: OperationalError, alternateUpstreams: Int): String = when (error) {
        OperationalError.HTTP_404 -> if (alternateUpstreams > 0) {
            "HTTP_404_UPSTREAM — l'amont HTTP en cours a refusé d'ouvrir la connexion (404). " +
                "Bascule automatique vers les $alternateUpstreams autres amonts déclarés dans votre profil ; " +
                "le tunnel reste actif et n'est pas redémarré."
        } else {
            "HTTP_404_UPSTREAM — l'amont HTTP a refusé d'ouvrir la connexion (404). " +
                "Aucun autre amont interchangeable n'est déclaré dans votre profil : refus côté fournisseur."
        }
        OperationalError.HTTP_429 -> if (alternateUpstreams > 0) {
            "HTTP_429_RATE_LIMIT — une étape HTTP limite les requêtes ; origine non confirmée. " +
                "Les $alternateUpstreams autres amonts déclarés restent disponibles ; ne pas multiplier les reconnexions."
        } else {
            "HTTP_429_RATE_LIMIT — une étape HTTP limite les requêtes ; origine non confirmée. " +
                "Ne pas multiplier les reconnexions."
        }
        OperationalError.PACKET_DENIED ->
            "UDP_PACKET_DENIED — paquet UDP refusé. Une règle de blocage (p. ex. UDP/443) " +
                "peut l'expliquer ; cette ligne seule ne prouve pas un défaut de permission Android."
        OperationalError.PACKET_FAILURE ->
            "UDP_PACKET_FAILURE — échec d'un échange UDP ; les autres connexions peuvent continuer."
    }
}

class SxbEngineLogThrottle(
    private val clock: () -> Long,
    private val cooldownMs: Long = 30_000L,
) {
    data class Summary(val error: SxbEngineLogPolicy.OperationalError, val suppressed: Long)
    private data class Window(var emittedAt: Long, var suppressed: Long = 0L)
    private val windows = LinkedHashMap<SxbEngineLogPolicy.OperationalError, Window>()

    init { require(cooldownMs > 0L) }

    /** Null means coalesced; a non-null result admits this line and any summary. */
    @Synchronized fun record(error: SxbEngineLogPolicy.OperationalError): Summary? {
        val now = clock()
        val window = windows[error]
        if (window == null) {
            windows[error] = Window(now)
            return Summary(error, 0L)
        }
        if (now - window.emittedAt < cooldownMs) {
            if (window.suppressed < Long.MAX_VALUE) window.suppressed++
            return null
        }
        val summary = Summary(error, window.suppressed)
        window.emittedAt = now
        window.suppressed = 0L
        return summary
    }

    @Synchronized fun flushDue(): List<Summary> {
        val now = clock()
        return windows.mapNotNull { (error, window) ->
            if (window.suppressed == 0L || now - window.emittedAt < cooldownMs) null else {
                Summary(error, window.suppressed).also {
                    window.suppressed = 0L
                    window.emittedAt = now
                }
            }
        }
    }

    @Synchronized fun reset(): List<Summary> {
        val pending = windows.filterValues { it.suppressed > 0L }.map { Summary(it.key, it.value.suppressed) }
        windows.clear()
        return pending
    }
}

class SxbOutboundDiagnostics(
    private val clock: () -> Long,
    private val windowMs: Long = 15_000L,
    private val threshold: Int = 5,
    private val cooldownMs: Long = 60_000L,
    private val observationMs: Long = 5_000L,
) {
    data class Diagnosis(val failure: SxbEngineLogPolicy.Failure, val trafficMeasurable: Boolean)
    private var windowStartedAt: Long? = null
    private var lastDiagnosisAt: Long? = null
    private var count = 0
    private var trafficAtWindowStart = 0L
    private var trafficSeen = false
    private var trafficMeasurable = false
    private var dnsFailureSeen = false
    private var httpFailureSeen = false

    init { require(windowMs >= observationMs && observationMs > 0 && threshold > 0 && cooldownMs > 0) }

    @Synchronized fun note(failure: SxbEngineLogPolicy.Failure?, bytes: Long, countersAvailable: Boolean): Diagnosis? {
        if (failure == null) return null
        val now = clock()
        val start = windowStartedAt
        if (start == null || now - start >= windowMs) {
            windowStartedAt = now
            count = 0
            trafficAtWindowStart = bytes
            trafficSeen = false
            trafficMeasurable = countersAvailable
            dnsFailureSeen = false
            httpFailureSeen = false
        }
        trafficMeasurable = trafficMeasurable && countersAvailable
        if (bytes != trafficAtWindowStart) trafficSeen = true
        if (failure == SxbEngineLogPolicy.Failure.DNS) dnsFailureSeen = true
        if (failure == SxbEngineLogPolicy.Failure.HTTP) httpFailureSeen = true
        if (count < threshold) count++
        if (count < threshold || now - (windowStartedAt ?: now) < observationMs || trafficSeen) return null
        if (lastDiagnosisAt?.let { now - it < cooldownMs } == true) return null
        lastDiagnosisAt = now
        val cause = when {
            httpFailureSeen -> SxbEngineLogPolicy.Failure.HTTP
            dnsFailureSeen -> SxbEngineLogPolicy.Failure.DNS
            else -> SxbEngineLogPolicy.Failure.OUTBOUND
        }
        return Diagnosis(cause, trafficMeasurable)
    }

    @Synchronized fun reset() {
        windowStartedAt = null
        lastDiagnosisAt = null
        count = 0
        trafficAtWindowStart = 0L
        trafficSeen = false
        trafficMeasurable = false
        dnsFailureSeen = false
        httpFailureSeen = false
    }
}

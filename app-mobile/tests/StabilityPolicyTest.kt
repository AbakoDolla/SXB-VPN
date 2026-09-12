package com.sxbvpn.vpnmodule

import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

private var cases = 0
private fun checkCase(name: String, action: () -> Unit) {
    action()
    cases++
    println("PASS $name")
}
private fun rejected(code: String, action: () -> Unit) {
    try { action() } catch (error: IllegalArgumentException) {
        check(error.message?.endsWith(code) == true) { "Wrong rejection: ${error.message}" }
        return
    }
    error("Accepted invalid policy: $code")
}
private fun chain() = JSONArray("""[
  {"type":"http","tag":"http1","server":"gateway.example.test","server_port":8080,"headers":{"Host":"front.example.test"}},
  {"type":"vless","tag":"proxy1","server":"vless.example.test","server_port":443,
   "uuid":"00000000-0000-4000-8000-000000000001","detour":"http1",
   "transport":{"type":"ws","path":"/vless","headers":{"Host":"tls.example.test"}},
   "tls":{"enabled":true,"insecure":true,"server_name":"tls.example.test"}},
  {"type":"vless","tag":"proxy2","server":"backup.example.test","server_port":443,
   "uuid":"00000000-0000-4000-8000-000000000002","transport":{"type":"ws"},"detour":"http2"},
  {"type":"http","tag":"http2","server":"backup-gateway.example.test","server_port":8080},
  {"type":"direct","tag":"direct"},{"type":"block","tag":"block"},{"type":"dns","tag":"dns-out"}
]""").apply {
    repeat(9) { put(JSONObject().put("type", "http").put("tag", "unused$it").put("server", "unused$it.example.test").put("server_port", 8080)) }
}
private fun route(finalTag: String = "proxy1") = JSONObject("""{
  "final":"$finalTag",
  "rules":[{"network":["udp"],"port":[443],"outbound":"block"},
           {"ip_is_private":true,"outbound":"direct"}]
}""")
private const val CARRIER_UUID = "3f2b0c14-9a7d-4e51-b8c3-0d6a15e47f92"
/** Shape of a zero-rated carrier profile: interchangeable heads and upstreams. */
private fun carrierChain(upstreams: Int = 4, heads: Int = 2) = JSONArray().apply {
    for (h in 1..heads) put(JSONObject("""{
      "type":"vless","tag":"proxy$h","server":"edge.example.test","server_port":443,
      "uuid":"$CARRIER_UUID","detour":"up$h",
      "transport":{"type":"ws","path":"/ws","headers":{"Host":"edge.example.test"}},
      "tls":{"enabled":true,"insecure":true,"server_name":"edge.example.test",
             "utls":{"enabled":true,"fingerprint":"chrome"}}}"""))
    for (i in 1..upstreams) put(JSONObject("""{
      "type":"http","tag":"up$i","server":"198.51.100.$i","server_port":8080,
      "headers":{"Host":"edge.example.test:443","X-Op-Bsid":"synthetic",
                 "User-Agent":"Mozilla/5.0 (Linux; Android 13)"}}"""))
    put(JSONObject().put("type", "direct").put("tag", "direct"))
    put(JSONObject().put("type", "block").put("tag", "block"))
    put(JSONObject().put("type", "dns").put("tag", "dns-out"))
}
private fun carrierRoute(finalTag: String = "proxy1") = JSONObject("""{
  "final":"$finalTag",
  "rules":[{"network":["udp"],"port":[443],"outbound":"block"},
           {"ip_is_private":true,"outbound":"direct"},
           {"type":"logical","mode":"or","rules":[{"port_range":["0:65535"],"outbound":"$finalTag"}]}]
}""")
private fun installFailover(outbounds: JSONArray, finalTag: String = "proxy1") =
    SxbTunnelPolicy.installHttpChainFailover(outbounds, SxbTunnelPolicy.OutboundGraph(outbounds), finalTag)
private fun tagged(outbounds: JSONArray): Map<String, JSONObject> =
    (0 until outbounds.length()).mapNotNull { outbounds.optJSONObject(it) }.associateBy { it.optString("tag", "") }
private fun servers(outbounds: JSONArray): Set<String> =
    (0 until outbounds.length()).mapNotNull { outbounds.optJSONObject(it) }
        .map { it.optString("server", "") }.filter { it.isNotEmpty() }.toSet()
private fun dns(address: String, detour: String = "proxy1") = JSONObject()
    .put("servers", JSONArray().put(JSONObject().put("tag", "remote").put("address", address).put("detour", detour)))
    .put("final", "remote")
private fun server(dns: JSONObject, index: Int = 0): JSONObject = dns.getJSONArray("servers").getJSONObject(index)
private fun lower(message: String) = SxbEngineLogPolicy.clean(message).lowercase(Locale.ROOT)

// ═══════════════════════════════════════════════════════════════════════════
// REPRISE RÉSEAU — outils de test
// ═══════════════════════════════════════════════════════════════════════════

/** État « nominal » : VPN demandé, réseau présent, rien d'armé, tunnel à terre. */
private fun reconnectState(
    enabled: Boolean = true,
    stopped: Boolean = false,
    networkAvailable: Boolean = true,
    attemptScheduled: Boolean = false,
    dispatchInFlight: Boolean = false,
    connected: Boolean = false,
    awaitingNetwork: Boolean = false,
    failedAttempts: Int = 0,
    sinceLastEventMs: Long = Long.MAX_VALUE / 4,
) = SxbReconnectPolicy.State(
    enabled = enabled,
    stopped = stopped,
    networkAvailable = networkAvailable,
    attemptScheduled = attemptScheduled,
    dispatchInFlight = dispatchInFlight,
    connected = connected,
    awaitingNetwork = awaitingNetwork,
    failedAttempts = failedAttempts,
    sinceLastEventMs = sinceLastEventMs,
)

/**
 * Simulateur de scénarios réseau.
 *
 * Il reproduit l'ordonnancement d'`AutoReconnectManager` : une décision arme
 * une minuterie datée, et la tentative n'est COMPTÉE qu'à son échéance,
 * uniquement si un réseau est présent. Comme dans le gestionnaire, la minuterie
 * est désarmée AVANT l'appel au service — `onReconnect()` ne rend la main qu'à
 * la mort du tunnel, et laisser la minuterie active ferait passer l'échec
 * suivant pour un doublon.
 */
private class ReconnectSim(var connected: Boolean = true) {
    var enabled = true
    var stopped = false
    var networkAvailable = true
    var attemptScheduled = false
    var dispatchInFlight = false
    var awaitingNetwork = false
    var failedAttempts = 0
    var resumeStreak = 0
    var attempts = 0
    var pendingDelayMs = 0L
    private var dueAtMs = Long.MAX_VALUE
    private var clockMs = 0L
    private var lastEventAtMs = -3_600_000L
    val decisions = mutableListOf<SxbReconnectPolicy.Decision>()

    fun advance(ms: Long) { clockMs += ms }

    private fun state() = SxbReconnectPolicy.State(
        enabled = enabled,
        stopped = stopped,
        networkAvailable = networkAvailable,
        attemptScheduled = attemptScheduled,
        dispatchInFlight = dispatchInFlight,
        connected = connected,
        awaitingNetwork = awaitingNetwork,
        failedAttempts = failedAttempts,
        sinceLastEventMs = clockMs - lastEventAtMs,
    )

    private fun event(trigger: SxbReconnectPolicy.Trigger): SxbReconnectPolicy.Decision {
        val decision = SxbReconnectPolicy.decide(trigger, state())
        decisions += decision
        when (decision) {
            SxbReconnectPolicy.Decision.RETRY -> arm(SxbReconnectPolicy.retryDelayMs(failedAttempts + 1))
            SxbReconnectPolicy.Decision.RESUME -> {
                failedAttempts = 0
                arm(SxbReconnectPolicy.resumeDelayMs(resumeStreak++))
            }
            SxbReconnectPolicy.Decision.WAIT_FOR_NETWORK -> { disarm(); awaitingNetwork = true }
            SxbReconnectPolicy.Decision.GIVE_UP -> disarm()
            else -> Unit
        }
        return decision
    }

    private fun arm(delayMs: Long) {
        attemptScheduled = true
        pendingDelayMs = delayMs
        lastEventAtMs = clockMs
        dueAtMs = clockMs + delayMs
    }

    private fun disarm() {
        attemptScheduled = false
        pendingDelayMs = 0
        dueAtMs = Long.MAX_VALUE
    }

    /** La minuterie arrive à échéance. */
    fun fireScheduled(succeeds: Boolean) {
        check(attemptScheduled) { "Aucune tentative armée" }
        check(clockMs >= dueAtMs) { "Tentative déclenchée avant son échéance" }
        if (!networkAvailable) {
            // Réseau reperdu pendant l'attente : compteur intact.
            disarm()
            awaitingNetwork = true
            return
        }
        disarm()
        awaitingNetwork = false
        attempts++
        failedAttempts++
        dispatchInFlight = true
        if (succeeds) {
            connected = true
            failedAttempts = 0
            resumeStreak = 0
            dispatchInFlight = false
        } else {
            connected = false
            // `failVpn()` notifie la chute pendant que le dispatch tourne encore.
            event(SxbReconnectPolicy.Trigger.TUNNEL_LOST)
            dispatchInFlight = false
        }
    }

    fun airplaneModeOn() {
        networkAvailable = false
        // `onNetworkLost(false)` annule toute minuterie : elle ne pourrait
        // qu'échouer à vide, et passe en attente pure.
        disarm()
        awaitingNetwork = true
        connected = false
        event(SxbReconnectPolicy.Trigger.TUNNEL_LOST)
    }

    fun airplaneModeOff() {
        networkAvailable = true
        event(SxbReconnectPolicy.Trigger.NETWORK_AVAILABLE)
    }

    fun networkAppeared() {
        networkAvailable = true
        event(SxbReconnectPolicy.Trigger.NETWORK_AVAILABLE)
    }

    fun networkDisappeared(stillAvailable: Boolean) {
        networkAvailable = stillAvailable
        connected = false
        event(SxbReconnectPolicy.Trigger.TUNNEL_LOST)
    }

    /** Filet de sécurité du service : le dispatch périmé vient de se terminer. */
    fun reevaluate() { event(SxbReconnectPolicy.Trigger.NETWORK_AVAILABLE) }
}

fun main() {
    checkCase("only the selected HTTP-chained VLESS/WS path gets a non-jumbo MTU") {
        val outbounds = chain()
        val before = outbounds.toString()
        val graph = SxbTunnelPolicy.OutboundGraph(outbounds)
        val selected = route()
        val routesBefore = selected.toString()
        check(SxbTunnelPolicy.tunMtu(JSONObject(), graph, selected) == 1400)
        check(SxbTunnelPolicy.defaultProxyTag(outbounds, null) == "proxy1")
        check(SxbTunnelPolicy.defaultProxyTag(outbounds, route("proxy2")) == "proxy2")
        check(graph.chainEndServer("proxy1") == "gateway.example.test")
        check(outbounds.toString() == before && selected.toString() == routesBefore)
        for (type in listOf("wireguard", "ssh", "hysteria2", "tuic", "socks", "http", "vmess")) {
            val other = chain().put(JSONObject().put("type", type).put("tag", "other").put("mtu", 1420))
            check(SxbTunnelPolicy.tunMtu(JSONObject(), SxbTunnelPolicy.OutboundGraph(other), route("other")) == 9000)
            check(other.getJSONObject(other.length() - 1).getInt("mtu") == 1420)
        }
        val directVless = chain().apply { getJSONObject(1).remove("detour") }
        check(SxbTunnelPolicy.tunMtu(JSONObject(), SxbTunnelPolicy.OutboundGraph(directVless), route()) == 9000)
        val grpc = chain().apply { getJSONObject(1).getJSONObject("transport").put("type", "grpc") }
        check(SxbTunnelPolicy.tunMtu(JSONObject(), SxbTunnelPolicy.OutboundGraph(grpc), route()) == 9000)
    }
    checkCase("explicit valid per-profile MTU is retained, not imported routes/listeners") {
        val graph = SxbTunnelPolicy.OutboundGraph(chain())
        for (mtu in listOf(1280, 1400, 1500, 9000, 65535)) {
            check(SxbTunnelPolicy.tunMtu(JSONObject().put("mtu", mtu), graph, route()) == mtu)
            check(SxbTunnelPolicy.tunMtu(JSONObject().put("mtu", mtu.toString()), graph, route()) == mtu)
        }
        val profile = JSONObject("""{"inbounds":[{"type":"tun","mtu":1420,"listen":"127.0.0.1","auto_route":false}]}""")
        check(SxbTunnelPolicy.tunMtu(profile, graph, route()) == 1420)
        for (invalid in listOf(0, -1, 1279, 65536, 1400.5, "bad")) {
            rejected("TUN_MTU_INVALID") { SxbTunnelPolicy.tunMtu(JSONObject().put("mtu", invalid), graph, route()) }
        }
        rejected("TUN_MTU_AMBIGUOUS") {
            SxbTunnelPolicy.tunMtu(JSONObject("""{"inbounds":[{"type":"tun","mtu":1400},{"type":"tun","mtu":1500}]}"""), graph, route())
        }
    }
    checkCase("route rules and declared groups are traversed without using idle HTTP definitions") {
        val outbounds = chain().put(JSONObject("""{"type":"selector","tag":"select","outbounds":["proxy1","direct"],"default":"proxy1"}"""))
        val graph = SxbTunnelPolicy.OutboundGraph(outbounds)
        check(SxbTunnelPolicy.tunMtu(JSONObject(), graph, route("select")) == 1400)
        check(graph.chainEndServer("select").isEmpty())
        val mixedDns = dns("198.51.100.53", "select")
        check(server(SxbTunnelPolicy.reliableDns(mixedDns, graph)).getString("address") == "198.51.100.53")
        val rules = route("direct").apply {
            getJSONArray("rules").put(JSONObject("""{"type":"logical","mode":"and","rules":[{"domain_suffix":["example.test"],"outbound":"proxy1"}]}"""))
        }
        check(SxbTunnelPolicy.tunMtu(JSONObject(), graph, rules) == 1400)
        check(SxbTunnelPolicy.tunMtu(JSONObject(), graph, route("direct")) == 9000)
    }
    checkCase("cycles and unknown tags fail closed, including unused groups and long chains") {
        rejected("TUNNEL_ROUTE_CYCLE") {
            SxbTunnelPolicy.OutboundGraph(chain().apply { getJSONObject(0).put("detour", "proxy1") })
        }
        rejected("TUNNEL_OUTBOUND_MISSING") {
            SxbTunnelPolicy.OutboundGraph(chain().apply { getJSONObject(0).put("detour", "missing") })
        }
        rejected("TUNNEL_ROUTE_CYCLE") {
            SxbTunnelPolicy.OutboundGraph(chain().put(JSONObject("""{"type":"selector","tag":"loop","outbounds":["loop"]}""")))
        }
        rejected("TUNNEL_DUPLICATE_TAG") {
            SxbTunnelPolicy.OutboundGraph(chain().put(JSONObject("""{"type":"http","tag":"http1"}""")))
        }
        rejected("TUNNEL_OUTBOUND_MISSING") {
            SxbTunnelPolicy.tunMtu(JSONObject(), SxbTunnelPolicy.OutboundGraph(chain()), route("missing"))
        }
        val longChain = chain()
        var previous = longChain.getJSONObject(0)
        repeat(12) {
            previous.put("detour", "hop$it")
            previous = JSONObject().put("type", "http").put("tag", "hop$it").put("server", "hop$it.example.test")
            longChain.put(previous)
        }
        check(SxbTunnelPolicy.OutboundGraph(longChain).chainEndServer("proxy1") == "hop11.example.test")
    }
    checkCase("bare DNS uses TCP with the same resolver, port and VLESS detour") {
        val graph = SxbTunnelPolicy.OutboundGraph(chain())
        for ((address, expected) in listOf(
            "198.51.100.53" to "tcp://198.51.100.53",
            "198.51.100.53:5353" to "tcp://198.51.100.53:5353",
            "[2001:db8::53]:5300" to "tcp://[2001:db8::53]:5300",
            "2001:db8::53" to "tcp://[2001:db8::53]",
            "resolver.example.test:5300" to "tcp://resolver.example.test:5300",
        )) {
            val original = dns(address)
            server(original).put("address_resolver", "bootstrap")
            val before = original.toString()
            val adapted = SxbTunnelPolicy.reliableDns(original, graph)
            check(server(adapted).getString("address") == expected)
            check(server(adapted).getString("detour") == "proxy1")
            check(server(adapted).getString("address_resolver") == "bootstrap")
            check(original.toString() == before)
            check(SxbTunnelPolicy.reliableDns(adapted, graph).similar(adapted))
            check(!adapted.has("strategy"))
        }
    }
    checkCase("explicit encrypted DNS, native rules, bootstrap, fakeip and UDP-capable routes are preserved") {
        val graph = SxbTunnelPolicy.OutboundGraph(chain())
        for (address in listOf("udp://198.51.100.53:5300", "UDP://198.51.100.53:53",
            "https://resolver.example.test/dns-query", "tls://resolver.example.test:853",
            "tcp://198.51.100.53:5353", "quic://resolver.example.test", "local", "fakeip", "rcode://success", "dhcp://auto")) {
            val adapted = SxbTunnelPolicy.reliableDns(dns(address), graph)
            check(server(adapted).getString("address") == address)
            check(!adapted.has("strategy"))
        }
        for (detour in listOf("direct", "http1")) {
            check(server(SxbTunnelPolicy.reliableDns(dns("udp://198.51.100.53:5353", detour), graph))
                .getString("address") == "udp://198.51.100.53:5353")
        }
        val plain = SxbTunnelPolicy.OutboundGraph(chain().apply { getJSONObject(1).remove("detour") })
        val nonChained = SxbTunnelPolicy.reliableDns(dns("198.51.100.53"), plain)
        check(server(nonChained).getString("address") == "198.51.100.53")
        check(!nonChained.has("strategy"))
        val native = dns("198.51.100.53").put("independent_cache", false).put("strategy", "ipv6_only")
            .put("rules", JSONArray("""[{"domain_suffix":["example.test"],"server":"remote","disable_cache":true}]"""))
        server(native).put("strategy", "prefer_ipv6")
        val adapted = SxbTunnelPolicy.reliableDns(native, graph)
        check(!adapted.getBoolean("independent_cache") && adapted.getString("strategy") == "ipv6_only")
        check(server(adapted).getString("strategy") == "prefer_ipv6")
        check(adapted.getJSONArray("rules").similar(native.getJSONArray("rules")))
        val defaults = SxbTunnelPolicy.reliableDns(dns("198.51.100.53"), graph)
        check(defaults.getBoolean("independent_cache") && !defaults.has("strategy"))
    }
    checkCase("an IPv4-only TUN answers AAAA locally instead of paying a chain round trip") {
        val graph = SxbTunnelPolicy.OutboundGraph(chain())
        // sing-dns répond NOERROR vide sans solliciter le transport : la requête
        // AAAA ne traverse plus la chaîne, et l'application ne tente plus une
        // adresse v6 que ce TUN ne sait pas router.
        val tunnelled = SxbTunnelPolicy.reliableDns(dns("198.51.100.53"), graph)
        check(server(tunnelled).getString("strategy") == "ipv4_only")
        check(server(tunnelled).getString("address") == "tcp://198.51.100.53")
        // Jamais de stratégie globale : elle contraindrait aussi l'amorçage.
        check(!tunnelled.has("strategy"))
        check(SxbTunnelPolicy.reliableDns(tunnelled, graph).similar(tunnelled))

        val dualStack = SxbTunnelPolicy.reliableDns(dns("198.51.100.53"), graph, tunnelHasIpv6 = true)
        check(!server(dualStack).has("strategy")) { "An IPv6-capable TUN must keep AAAA answers" }
        check(server(dualStack).getString("address") == "tcp://198.51.100.53")

        val explicit = dns("198.51.100.53").also { server(it).put("strategy", "prefer_ipv6") }
        check(server(SxbTunnelPolicy.reliableDns(explicit, graph)).getString("strategy") == "prefer_ipv6")

        for (detour in listOf("direct", "block", "dns-out")) {
            check(!server(SxbTunnelPolicy.reliableDns(dns("198.51.100.53", detour), graph)).has("strategy"))
        }
        val noDetour = dns("198.51.100.53").also { server(it).remove("detour") }
        check(!server(SxbTunnelPolicy.reliableDns(noDetour, graph)).has("strategy"))
        check(server(SxbTunnelPolicy.reliableDns(dns("udp://198.51.100.53:53", "http1"), graph))
            .getString("strategy") == "ipv4_only")

        val grouped = chain().put(JSONObject("""{"type":"selector","tag":"only-direct","outbounds":["direct","block"]}"""))
        val groupedGraph = SxbTunnelPolicy.OutboundGraph(grouped)
        check(!server(SxbTunnelPolicy.reliableDns(dns("198.51.100.53", "only-direct"), groupedGraph)).has("strategy"))
        check(groupedGraph.isTunnelled("proxy1") && !groupedGraph.isTunnelled("direct"))
        check(!groupedGraph.isTunnelled("absent") && !groupedGraph.isTunnelled(""))
    }
    checkCase("the probe cadence bounds how long a refusing upstream keeps being dialled") {
        // `URLTest.DialContext` réutilise l'amont sélectionné et ne le réévalue
        // qu'au cycle de sondes suivant : l'intervalle EST la fenêtre de 404.
        fun seconds(value: String): Int {
            val amount = value.dropLast(1).toInt()
            return when (value.last()) {
                's' -> amount
                'm' -> amount * 60
                'h' -> amount * 3600
                else -> error("Unsupported duration: $value")
            }
        }
        val interval = seconds(SxbTunnelPolicy.CHAIN_PROBE_INTERVAL)
        val idle = seconds(SxbTunnelPolicy.CHAIN_PROBE_IDLE_TIMEOUT)
        check(interval in 1..30) { "A refusing upstream must not stay selected for a whole minute" }
        check(interval <= idle) { "sing-box rejects interval > idle_timeout" }
        check(idle <= 15 * 60) { "Probing an idle tunnel burns data and battery" }
        val outbounds = carrierChain()
        val plan = installFailover(outbounds) ?: error("No failover")
        val group = tagged(outbounds).getValue(plan.groupTag)
        check(group.getString("interval") == SxbTunnelPolicy.CHAIN_PROBE_INTERVAL)
        check(group.getString("idle_timeout") == SxbTunnelPolicy.CHAIN_PROBE_IDLE_TIMEOUT)
    }
    checkCase("bootstrap and HTTPS/SVCB rules are idempotent and preserve distinct native policies") {
        val guarded = dns("198.51.100.53").put("rules", JSONArray("""[
          {"domain":["native.example.test"],"server":"remote","disable_cache":true},
          {"query_type":["A","AAAA"],"server":"fake"}
        ]"""))
        val domains = listOf("vless.example.test", "gateway.example.test")
        SxbTunnelPolicy.prependDnsGuardRules(guarded, domains, "bootstrap", "block")
        val once = JSONObject(guarded.toString())
        repeat(10) { SxbTunnelPolicy.prependDnsGuardRules(guarded, domains.reversed(), "bootstrap", "block") }
        check(guarded.getJSONArray("rules").length() == 4)
        check(guarded.getJSONArray("rules").getJSONObject(0).getJSONArray("query_type").toString() == """["HTTPS","SVCB"]""")
        check(guarded.getJSONArray("rules").getJSONObject(2).similar(once.getJSONArray("rules").getJSONObject(2)))
        check(guarded.getJSONArray("rules").getJSONObject(3).similar(once.getJSONArray("rules").getJSONObject(3)))
    }
    checkCase("ANSI/control sequences are removed before error classification or masking") {
        val source = "\u001B[31mERROR[0m dns: exchange failed: unexpected http response status: 404\u001B[0m"
        val clean = SxbEngineLogPolicy.clean(source)
        check(clean == "ERROR dns: exchange failed: unexpected http response status: 404")
        check(SxbEngineLogPolicy.operationalError(lower(source)) == SxbEngineLogPolicy.OperationalError.HTTP_404)
        check(SxbEngineLogPolicy.clean("\u001B]8;;https://example.test\u0007label\u001B]8;;\u0007") == "label")
        check(SxbEngineLogPolicy.clean("to\u001B[31mken=synthetic\u001B[0m\r") == "token=synthetic")
        check(SxbEngineLogPolicy.clean("[SXB] HTTP_404_UPSTREAM") == "[SXB] HTTP_404_UPSTREAM")
    }
    checkCase("admitted raw engine lines still use the production endpoint and credential masks") {
        val message = "\u001B[31mERROR open outbound connection: unexpected http response status: 404 " +
            "https://gateway.example.test/path?token=synthetic-token uuid=00000000-0000-4000-8000-000000000001 " +
            "to\u001B[0mken=synthetic-token password=synthetic-password"
        val safe = SecurityMaskHarness.maskSensitive(SecurityMaskHarness.maskCredentialsOnly(SxbEngineLogPolicy.clean(message)))
        for (secret in listOf("gateway.example.test", "synthetic-token", "synthetic-password", "00000000-0000-4000-8000-000000000001", "\u001B", "[31m")) {
            check(!safe.contains(secret)) { "Raw engine log leaked sensitive content" }
        }
        check(safe.contains("unexpected http response status: 404"))
    }
    checkCase("HTTP failures inside DNS exchange are not bootstrap failures; packet EPERM is not global") {
        check(SxbEngineLogPolicy.failure(lower("dns: exchange failed: unexpected http response status: 404")) == SxbEngineLogPolicy.Failure.HTTP)
        check(SxbEngineLogPolicy.failure(lower("dns: exchange failed: websocket: unexpected status: 429")) == SxbEngineLogPolicy.Failure.HTTP)
        check(SxbEngineLogPolicy.failure(lower("dns: exchange failed: context deadline exceeded")) == SxbEngineLogPolicy.Failure.DNS)
        val packet = "listen outbound packet connection: operation not permitted"
        check(SxbEngineLogPolicy.operationalError(packet) == SxbEngineLogPolicy.OperationalError.PACKET_DENIED)
        check(SxbEngineLogPolicy.failure(packet) == null)
        check(SxbEngineLogPolicy.failure("open outbound connection: operation not permitted") == SxbEngineLogPolicy.Failure.OUTBOUND)
        check(SxbEngineLogPolicy.operationalError("start service: operation not permitted") == null)
        check(SxbEngineLogPolicy.failure("dns: exchange failed: context canceled") == null)
    }
    checkCase("twenty operational errors emit first, coalesce nineteen, then admit after monotonic cooldown") {
        var now = 0L
        val throttle = SxbEngineLogThrottle({ now })
        for (kind in SxbEngineLogPolicy.OperationalError.entries) {
            check(throttle.record(kind)?.suppressed == 0L)
            repeat(19) { check(throttle.record(kind) == null) }
        }
        now = 29_999L
        check(throttle.flushDue().isEmpty())
        now = 30_000L
        for (kind in SxbEngineLogPolicy.OperationalError.entries) check(throttle.record(kind)?.suppressed == 19L)
        check(throttle.reset().isEmpty())
        check(throttle.record(SxbEngineLogPolicy.OperationalError.HTTP_404)?.suppressed == 0L)
        repeat(3) { check(throttle.record(SxbEngineLogPolicy.OperationalError.HTTP_404) == null) }
        check(throttle.reset().single().suppressed == 3L)
        check(throttle.record(SxbEngineLogPolicy.OperationalError.HTTP_404)?.suppressed == 0L)
    }
    checkCase("a burst that ends still gets a suppressed-count summary without keeping raw lines") {
        var now = 0L
        val throttle = SxbEngineLogThrottle({ now })
        val kind = SxbEngineLogPolicy.OperationalError.PACKET_DENIED
        throttle.record(kind)
        repeat(20_000) { throttle.record(kind) }
        now = 30_000L
        check(throttle.flushDue().single() == SxbEngineLogThrottle.Summary(kind, 20_000L))
        check(throttle.flushDue().isEmpty() && throttle.reset().isEmpty())
    }
    checkCase("unavailable counters never become proof of a traffic-free tunnel") {
        var now = 0L
        val diagnostics = SxbOutboundDiagnostics({ now })
        val http = SxbEngineLogPolicy.Failure.HTTP
        repeat(5) { check(diagnostics.note(http, 0L, false) == null) }
        now = 5_000L
        val diagnosis = diagnostics.note(http, 0L, false)
        check(diagnosis == SxbOutboundDiagnostics.Diagnosis(http, false))
        now = 6_000L
        check(diagnostics.note(http, 0L, false) == null)
        diagnostics.reset()
        repeat(5) { check(diagnostics.note(http, 0L, true) == null) }
        now = 11_000L
        check(diagnostics.note(http, 0L, true) == SxbOutboundDiagnostics.Diagnosis(http, true))
    }
    checkCase("real traffic progress, counter reset or loss of observability prevents a false failure verdict") {
        var now = 0L
        val diagnostics = SxbOutboundDiagnostics({ now })
        val dns = SxbEngineLogPolicy.Failure.DNS
        repeat(5) { diagnostics.note(dns, 100L, true) }
        now = 5_000L
        check(diagnostics.note(dns, 101L, true) == null)
        now = 8_000L
        check(diagnostics.note(dns, 101L, true) == null)
        diagnostics.reset()
        repeat(5) { diagnostics.note(dns, 100L, true) }
        now = 13_000L
        check(diagnostics.note(dns, 0L, true) == null)
        diagnostics.reset()
        repeat(5) { diagnostics.note(dns, 100L, true) }
        now = 18_000L
        check(diagnostics.note(dns, 100L, false) == SxbOutboundDiagnostics.Diagnosis(dns, false))
    }
    checkCase("expected packet denials do not accumulate DNS/outbound verdicts; HTTP cause has precedence") {
        var now = 0L
        val diagnostics = SxbOutboundDiagnostics({ now })
        repeat(100) {
            now += 1_000L
            check(diagnostics.note(SxbEngineLogPolicy.failure("listen outbound packet connection: operation not permitted"), 0L, true) == null)
        }
        repeat(4) { diagnostics.note(SxbEngineLogPolicy.Failure.DNS, 0L, true) }
        now += 5_000L
        check(diagnostics.note(SxbEngineLogPolicy.Failure.HTTP, 0L, true)?.failure == SxbEngineLogPolicy.Failure.HTTP)
    }
    checkCase("declared HTTP upstreams become one bounded engine group without inventing an endpoint") {
        val outbounds = carrierChain()
        val before = servers(outbounds)
        val plan = installFailover(outbounds) ?: error("No failover for a multi-upstream carrier chain")
        check(plan.groupTag == SxbTunnelPolicy.CHAIN_GROUP_TAG)
        check(plan.headTag == "proxy1")
        check(plan.upstreamTags == listOf("up1", "up2", "up3", "up4"))
        // proxy2 est DÉCLARÉ et identique à la tête : il est réutilisé tel quel
        // plutôt que dupliqué ; seuls les amonts orphelins reçoivent une branche.
        check(plan.branchTags == listOf("proxy1", "proxy2", "sxb-chain-up3", "sxb-chain-up4"))
        check(plan.generatedTags == listOf("sxb-chain-up3", "sxb-chain-up4"))
        val byTag = tagged(outbounds)
        check(servers(outbounds) == before) { "A branch introduced an endpoint the profile never declared" }
        val head = byTag.getValue("proxy1")
        for ((index, tag) in plan.branchTags.withIndex()) {
            val branch = byTag.getValue(tag)
            check(branch.getString("type") == "vless")
            check(branch.getString("server") == head.getString("server"))
            check(branch.getInt("server_port") == head.getInt("server_port"))
            check(branch.getString("uuid") == head.getString("uuid"))
            check(branch.getJSONObject("tls").similar(head.getJSONObject("tls")))
            check(branch.getJSONObject("transport").similar(head.getJSONObject("transport")))
            check(branch.getString("detour") == plan.upstreamTags[index])
            check(!branch.has("domain_strategy"))
        }
        val group = byTag.getValue(plan.groupTag)
        check(group.getString("type") == "urltest")
        check(group.getString("url") == SxbTunnelPolicy.CHAIN_PROBE_URL)
        check(group.getString("interval") == SxbTunnelPolicy.CHAIN_PROBE_INTERVAL)
        check(group.getString("idle_timeout") == SxbTunnelPolicy.CHAIN_PROBE_IDLE_TIMEOUT)
        check(group.getInt("tolerance") == SxbTunnelPolicy.CHAIN_PROBE_TOLERANCE)
        check(!group.getBoolean("interrupt_exist_connections"))
        val members = group.getJSONArray("outbounds")
        check((0 until members.length()).map { members.getString(it) } == plan.branchTags)
        // Sans historique de sonde le moteur retombe sur le PREMIER membre : la
        // tête déclarée par l'utilisateur, donc le comportement d'aujourd'hui.
        check(members.getString(0) == plan.headTag)
        val graph = SxbTunnelPolicy.OutboundGraph(outbounds)
        for (tag in plan.branchTags) check(graph.isHttpChainedVlessWs(tag))
        check(graph.isHttpChainedVlessWs(plan.groupTag, everyPath = true))
        val bounded = carrierChain(upstreams = 20)
        val boundedPlan = installFailover(bounded) ?: error("No failover for twenty declared upstreams")
        check(boundedPlan.branchTags.size == SxbTunnelPolicy.MAX_CHAIN_BRANCHES)
        check(boundedPlan.branchTags.toSet().size == boundedPlan.branchTags.size)
    }
    checkCase("single-upstream, non-chained, already-grouped and mismatched profiles stay byte-identical") {
        fun untouched(finalTag: String, mutate: (JSONArray) -> Unit = {}) {
            val outbounds = carrierChain().also(mutate)
            val before = outbounds.toString()
            check(installFailover(outbounds, finalTag) == null) { "Unexpected failover for $finalTag" }
            check(outbounds.toString() == before) { "Profile mutated while opting out for $finalTag" }
        }
        // Un seul amont déclaré : rien à quoi basculer.
        val single = carrierChain(upstreams = 1, heads = 1)
        val singleBefore = single.toString()
        check(installFailover(single) == null && single.toString() == singleBefore)
        // Profil non chaîné : chemin Play/direct strictement inchangé.
        untouched("proxy1") { for (i in 0 until it.length()) it.optJSONObject(i)?.remove("detour") }
        // Tête sortant par autre chose qu'un amont HTTP déclaré.
        untouched("proxy1") {
            it.put(JSONObject("""{"type":"socks","tag":"relay","server":"relay.example.test","server_port":1080}"""))
            it.getJSONObject(0).put("detour", "relay")
            it.getJSONObject(1).put("detour", "relay")
        }
        // Groupe déjà déclaré par l'utilisateur : sa politique prime.
        untouched("select") {
            it.put(JSONObject("""{"type":"selector","tag":"select","outbounds":["proxy1","proxy2"],"default":"proxy1"}"""))
        }
        // Amonts non interchangeables : en-têtes différents, aucune bascule.
        untouched("proxy1") {
            for (tag in listOf("up2", "up3", "up4")) {
                tagged(it).getValue(tag).getJSONObject("headers").put("X-Op-Bsid", "other-$tag")
            }
        }
        untouched("proxy1") { it.getJSONObject(0).remove("transport") }
        untouched("absent")
    }
    checkCase("the generated group is deterministic and a rebuild never accumulates branches") {
        val first = carrierChain()
        val firstPlan = installFailover(first) ?: error("No failover")
        val second = carrierChain()
        val secondPlan = installFailover(second) ?: error("No failover")
        check(first.toString() == second.toString())
        check(firstPlan == secondPlan)
        // Rejouer sur la config DÉJÀ construite (reconnexion) : aucun ajout.
        val built = first.length()
        check(installFailover(first, firstPlan.groupTag) == null)
        check(first.length() == built)
        // Même en repartant de la tête, aucune branche n'est dupliquée : les
        // branches déjà présentes sont reconnues comme des têtes déclarées.
        val again = installFailover(first, "proxy1") ?: error("No failover")
        check(again.branchTags == firstPlan.branchTags && again.generatedTags.isEmpty())
        val tags = (0 until first.length()).mapNotNull { first.optJSONObject(it) }.map { it.optString("tag", "") }
        check(tags.size == tags.toSet().size) { "Rebuilding duplicated an outbound tag" }
    }
    checkCase("a chained outbound never carries a domain_strategy, so CONNECT keeps the domain") {
        val declared = carrierChain()
        declared.getJSONObject(0).put("domain_strategy", "prefer_ipv4")
        declared.getJSONObject(2).put("domain_strategy", "ipv4_only")
        check(SxbTunnelPolicy.enforceChainedDomainFidelity(declared) == 1)
        check(!declared.getJSONObject(0).has("domain_strategy"))
        // Un amont sans detour compose lui-même : sa stratégie lui appartient.
        check(declared.getJSONObject(2).getString("domain_strategy") == "ipv4_only")
        check(SxbTunnelPolicy.enforceChainedDomainFidelity(declared) == 0)
        val outbounds = carrierChain()
        val plan = installFailover(outbounds) ?: error("No failover")
        val byTag = tagged(outbounds)
        for (tag in plan.branchTags) {
            check(byTag.getValue(tag).getString("server") == "edge.example.test")
            check(!byTag.getValue(tag).has("domain_strategy"))
        }
        // Même clonée depuis une tête encore polluée, une branche reste propre.
        val dirty = carrierChain()
        dirty.getJSONObject(0).put("domain_strategy", "prefer_ipv4")
        val dirtyPlan = installFailover(dirty) ?: error("No failover")
        val dirtyByTag = tagged(dirty)
        for (tag in dirtyPlan.generatedTags) check(!dirtyByTag.getValue(tag).has("domain_strategy"))
        check(dirtyPlan.generatedTags.size == 3) { "A head carrying a strategy must not be reused as a branch" }
        // Chaque branche sort par une adresse différente : toutes doivent être
        // exclues du TUN, pas seulement celle du premier amont.
        val graph = SxbTunnelPolicy.OutboundGraph(outbounds)
        check(graph.chainEndServers(plan.groupTag) ==
            setOf("198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4"))
        check(graph.chainEndServers("proxy1") == setOf("198.51.100.1"))
        check(graph.chainEndServer("proxy1") == "198.51.100.1")
        check(graph.chainEndServer(plan.groupTag).isEmpty())
    }
    checkCase("provider headers are copied verbatim: nothing renamed, dropped or invented") {
        val source = JSONObject("""{"Host":"edge.example.test:443","x-op-bsid":"synthetic",
          "User-Agent":"Mozilla/5.0 (Linux; Android 13)","X-Multi":["first","second"]}""")
        val before = source.toString()
        val copy = SxbTunnelPolicy.copyHeaders(source) ?: error("Header set dropped")
        check(copy.similar(source) && source.toString() == before)
        copy.put("X-Injected", "never")
        check(!source.has("X-Injected"))
        check(SxbTunnelPolicy.copyHeaders(null) == null)
        check(SxbTunnelPolicy.copyHeaders(JSONObject()) == null)
        rejected("HTTP_HEADER_INVALID") { SxbTunnelPolicy.copyHeaders(JSONObject().put("X-Op-Bsid", 1)) }
        rejected("HTTP_HEADER_INVALID") { SxbTunnelPolicy.copyHeaders(JSONObject().put("X-Op-Bsid", JSONArray().put(1))) }
        // Aucun Host fabriqué quand le fournisseur n'en déclare pas : le moteur
        // utilise alors l'autorité réelle de la destination, ce qu'il faut.
        val hostless = SxbTunnelPolicy.copyHeaders(JSONObject().put("X-Op-Bsid", "synthetic")) ?: error("dropped")
        check(hostless.length() == 1 && !hostless.has("Host") && !hostless.has("host"))
        val outbounds = carrierChain()
        val plan = installFailover(outbounds) ?: error("No failover")
        val byTag = tagged(outbounds)
        val reference = byTag.getValue("up1").getJSONObject("headers")
        for (tag in plan.upstreamTags) check(byTag.getValue(tag).getJSONObject("headers").similar(reference))
        val wsHeaders = byTag.getValue("proxy1").getJSONObject("transport").getJSONObject("headers")
        for (tag in plan.branchTags) {
            check(byTag.getValue(tag).getJSONObject("transport").getJSONObject("headers").similar(wsHeaders))
        }
    }
    checkCase("route, DNS and MTU follow the group while outbound detours stay untouched") {
        val outbounds = carrierChain()
        val plan = installFailover(outbounds) ?: error("No failover")
        val graph = SxbTunnelPolicy.OutboundGraph(outbounds)
        val rules = carrierRoute().getJSONArray("rules")
        check(SxbTunnelPolicy.retargetRouteOutbound(rules, plan.headTag, plan.groupTag) == 1)
        check(rules.getJSONObject(0).getString("outbound") == "block")
        check(rules.getJSONObject(0).getJSONArray("port").getInt(0) == 443)
        check(rules.getJSONObject(1).getString("outbound") == "direct")
        check(rules.getJSONObject(2).getJSONArray("rules").getJSONObject(0).getString("outbound") == plan.groupTag)
        check(SxbTunnelPolicy.retargetRouteOutbound(rules, plan.headTag, plan.groupTag) == 0)
        // Retargeter un `detour` d'outbound créerait groupe → branche → groupe.
        val byTag = tagged(outbounds)
        check(byTag.getValue("proxy1").getString("detour") == "up1")
        check(byTag.getValue("proxy2").getString("detour") == "up2")
        val dnsObj = dns("198.51.100.53", "proxy1")
        check(SxbTunnelPolicy.retargetDnsDetour(dnsObj, plan.headTag, plan.groupTag) == 1)
        check(server(dnsObj).getString("detour") == plan.groupTag)
        check(SxbTunnelPolicy.retargetDnsDetour(dnsObj, plan.headTag, plan.groupTag) == 0)
        val adapted = SxbTunnelPolicy.reliableDns(dnsObj, graph)
        check(server(adapted).getString("address") == "tcp://198.51.100.53")
        check(server(adapted).getString("detour") == plan.groupTag)
        val selected = JSONObject().put("final", plan.groupTag).put("rules", rules)
        check(SxbTunnelPolicy.tunMtu(JSONObject(), graph, selected) == SxbTunnelPolicy.HTTP_CHAIN_MTU)
        // Un membre non chaîné dans le groupe : plus de repli TCP silencieux.
        val mixed = carrierChain()
        installFailover(mixed)
        tagged(mixed).getValue(SxbTunnelPolicy.CHAIN_GROUP_TAG).getJSONArray("outbounds").put("direct")
        val mixedGraph = SxbTunnelPolicy.OutboundGraph(mixed)
        check(server(SxbTunnelPolicy.reliableDns(dns("198.51.100.53", SxbTunnelPolicy.CHAIN_GROUP_TAG), mixedGraph))
            .getString("address") == "198.51.100.53")
    }
    checkCase("a generated group still fails closed on unknown members or cycles") {
        rejected("TUNNEL_OUTBOUND_MISSING") {
            val outbounds = carrierChain()
            val plan = installFailover(outbounds) ?: error("No failover")
            tagged(outbounds).getValue(plan.groupTag).getJSONArray("outbounds").put("ghost")
            SxbTunnelPolicy.OutboundGraph(outbounds)
        }
        rejected("TUNNEL_ROUTE_CYCLE") {
            val outbounds = carrierChain()
            val plan = installFailover(outbounds) ?: error("No failover")
            tagged(outbounds).getValue("up1").put("detour", plan.groupTag)
            SxbTunnelPolicy.OutboundGraph(outbounds)
        }
        rejected("TUNNEL_GROUP_TAG_INVALID") {
            val outbounds = carrierChain()
            val plan = installFailover(outbounds) ?: error("No failover")
            tagged(outbounds).getValue(plan.groupTag).getJSONArray("outbounds").put(42)
            SxbTunnelPolicy.OutboundGraph(outbounds)
        }
    }
    checkCase("the 404 line names the upstream refusal and the declared alternates, without new verdicts") {
        val withAlternates = SxbEngineLogPolicy.operationalLabel(SxbEngineLogPolicy.OperationalError.HTTP_404, 3)
        check(withAlternates.startsWith("HTTP_404_UPSTREAM"))
        check(withAlternates.contains("3 autres amonts déclarés"))
        check(withAlternates.contains("n'est pas redémarré"))
        val alone = SxbEngineLogPolicy.operationalLabel(SxbEngineLogPolicy.OperationalError.HTTP_404, 0)
        check(alone.startsWith("HTTP_404_UPSTREAM") && alone.contains("Aucun autre amont"))
        check(SxbEngineLogPolicy.operationalLabel(SxbEngineLogPolicy.OperationalError.PACKET_DENIED, 4)
            .contains("ne prouve pas un défaut de permission Android"))
        for (alternates in listOf(0, 1, 9)) {
            for (kind in SxbEngineLogPolicy.OperationalError.entries) {
                val label = SxbEngineLogPolicy.operationalLabel(kind, alternates)
                check(label.isNotBlank() && label == SxbEngineLogPolicy.clean(label))
                for (verdict in listOf("APN", "opérateur bloque", "permission Android manquante", "forfait")) {
                    check(!label.contains(verdict)) { "The label states an unproven verdict: $verdict" }
                }
            }
        }
        // Le compteur vient de la configuration construite : aucune adresse.
        SxbTunnelPolicy.noteChainFailover(null)
        check(SxbTunnelPolicy.declaredAlternateUpstreams() == 0)
        val outbounds = carrierChain()
        val plan = installFailover(outbounds) ?: error("No failover")
        SxbTunnelPolicy.noteChainFailover(plan)
        check(SxbTunnelPolicy.declaredAlternateUpstreams() == plan.branchTags.size - 1)
        SxbTunnelPolicy.noteChainFailover(null)
        check(SxbTunnelPolicy.declaredAlternateUpstreams() == 0)
    }

    // ═══════════════════════════════════════════════════════════════════════
    // REPRISE RÉSEAU — SxbReconnectPolicy
    // ═══════════════════════════════════════════════════════════════════════
    checkCase("le retour du réseau relance le tunnel, y compris après un abandon") {
        // Le défaut corrigé : `onAvailable` ne faisait que journaliser, donc un
        // aller-retour en mode avion laissait le tunnel définitivement à terre.
        check(SxbReconnectPolicy.decide(SxbReconnectPolicy.Trigger.NETWORK_AVAILABLE, reconnectState())
            == SxbReconnectPolicy.Decision.RESUME)
        // Même après épuisement des tentatives réelles : tant que le service
        // vit et que la reconnexion est armée, une ligne qui revient est une
        // nouvelle chance, pas la suite d'une série d'échecs périmés.
        check(SxbReconnectPolicy.decide(
            SxbReconnectPolicy.Trigger.NETWORK_AVAILABLE,
            reconnectState(failedAttempts = SxbReconnectPolicy.MAX_RETRIES + 3),
        ) == SxbReconnectPolicy.Decision.RESUME)
    }

    checkCase("sans réseau, aucune tentative n'est consommée et rien n'est abandonné") {
        for (consumed in 0..(SxbReconnectPolicy.MAX_RETRIES + 5)) {
            val decision = SxbReconnectPolicy.decide(
                SxbReconnectPolicy.Trigger.TUNNEL_LOST,
                reconnectState(networkAvailable = false, failedAttempts = consumed),
            )
            check(decision == SxbReconnectPolicy.Decision.WAIT_FOR_NETWORK) {
                "Une coupure réseau ne doit ni retenter ni abandonner: $decision"
            }
        }
    }

    checkCase("le compteur reste réservé aux échecs réels, serveur joignable") {
        for (consumed in 0 until SxbReconnectPolicy.MAX_RETRIES) {
            check(SxbReconnectPolicy.decide(
                SxbReconnectPolicy.Trigger.TUNNEL_LOST,
                reconnectState(failedAttempts = consumed),
            ) == SxbReconnectPolicy.Decision.RETRY)
        }
        check(SxbReconnectPolicy.decide(
            SxbReconnectPolicy.Trigger.TUNNEL_LOST,
            reconnectState(failedAttempts = SxbReconnectPolicy.MAX_RETRIES),
        ) == SxbReconnectPolicy.Decision.GIVE_UP)
    }

    checkCase("une rafale d'événements Android n'arme qu'une seule tentative") {
        // Une bascule Wi-Fi ↔ données mobiles produit plusieurs rappels.
        for (trigger in SxbReconnectPolicy.Trigger.entries) {
            check(SxbReconnectPolicy.decide(trigger, reconnectState(attemptScheduled = true))
                == SxbReconnectPolicy.Decision.DEBOUNCE)
        }
        check(SxbReconnectPolicy.decide(
            SxbReconnectPolicy.Trigger.NETWORK_AVAILABLE,
            reconnectState(dispatchInFlight = true),
        ) == SxbReconnectPolicy.Decision.DEBOUNCE)
        check(SxbReconnectPolicy.decide(
            SxbReconnectPolicy.Trigger.NETWORK_AVAILABLE,
            reconnectState(sinceLastEventMs = SxbReconnectPolicy.MIN_EVENT_INTERVAL_MS - 1),
        ) == SxbReconnectPolicy.Decision.DEBOUNCE)
        check(SxbReconnectPolicy.decide(
            SxbReconnectPolicy.Trigger.NETWORK_AVAILABLE,
            reconnectState(sinceLastEventMs = SxbReconnectPolicy.MIN_EVENT_INTERVAL_MS),
        ) == SxbReconnectPolicy.Decision.RESUME)
    }

    checkCase("un arrêt volontaire ou une erreur permanente ne relance jamais rien") {
        for (trigger in SxbReconnectPolicy.Trigger.entries) {
            check(SxbReconnectPolicy.decide(trigger, reconnectState(enabled = false))
                == SxbReconnectPolicy.Decision.IGNORE)
            check(SxbReconnectPolicy.decide(trigger, reconnectState(stopped = true))
                == SxbReconnectPolicy.Decision.IGNORE)
            // Le refus prime même sur un réseau qui revient et un compteur vierge.
            check(SxbReconnectPolicy.decide(
                trigger,
                reconnectState(stopped = true, networkAvailable = true, failedAttempts = 0),
            ) == SxbReconnectPolicy.Decision.IGNORE)
        }
    }

    checkCase("un tunnel debout n'est jamais coupé par l'arrivée d'un réseau") {
        // Règle 6 : on ne bascule pas de transport, Android garde sa sélection.
        check(SxbReconnectPolicy.decide(
            SxbReconnectPolicy.Trigger.NETWORK_AVAILABLE,
            reconnectState(connected = true),
        ) == SxbReconnectPolicy.Decision.IGNORE)
        // En revanche un « connected » PÉRIMÉ — le tunnel a été perdu avec le
        // réseau, le moteur n'a simplement pas encore été démonté — ne doit pas
        // absorber le seul événement de retour du réseau.
        check(SxbReconnectPolicy.decide(
            SxbReconnectPolicy.Trigger.NETWORK_AVAILABLE,
            reconnectState(connected = true, awaitingNetwork = true),
        ) == SxbReconnectPolicy.Decision.RESUME)
    }

    checkCase("un échec réel programme la tentative suivante, jusqu'à l'abandon") {
        // Régression : la garde anti-doublon ne doit pas confondre « une
        // tentative est armée » avec « une tentative est en cours ». Sinon le
        // premier échec paraît être un doublon et plus aucune tentative n'est
        // jamais programmée — l'abandon ne survient plus, mais la reconnexion
        // non plus.
        val sim = ReconnectSim(connected = false)
        sim.networkDisappeared(stillAvailable = true)
        var armed = 0
        while (sim.attemptScheduled) {
            armed++
            sim.advance(sim.pendingDelayMs)
            sim.fireScheduled(succeeds = false)
        }
        check(armed == SxbReconnectPolicy.MAX_RETRIES) { "Tentatives réellement tentées: $armed" }
        check(sim.attempts == SxbReconnectPolicy.MAX_RETRIES)
        check(sim.decisions.last() == SxbReconnectPolicy.Decision.GIVE_UP)
    }

    checkCase("un retour du réseau absorbé par un moteur périmé n'est pas perdu") {
        val sim = ReconnectSim()
        sim.airplaneModeOn()
        // Le moteur précédent n'a pas encore fini de se démonter.
        sim.dispatchInFlight = true
        sim.advance(60_000)
        sim.airplaneModeOff()
        check(sim.decisions.last() == SxbReconnectPolicy.Decision.DEBOUNCE) {
            "Jamais deux tentatives simultanées sur le même TUN"
        }
        check(sim.awaitingNetwork) { "La reprise reste due tant qu'elle n'a pas démarré" }
        // Filet de sécurité du service : le dispatch périmé se termine.
        sim.dispatchInFlight = false
        sim.reevaluate()
        check(sim.decisions.last() == SxbReconnectPolicy.Decision.RESUME)
        sim.advance(sim.pendingDelayMs)
        sim.fireScheduled(succeeds = true)
        check(sim.connected && !sim.awaitingNetwork)
    }

    checkCase("mode avion de 10 secondes : le tunnel repart, compteur intact") {
        val sim = ReconnectSim()
        sim.airplaneModeOn()
        check(sim.failedAttempts == 0) { "Une coupure ne doit rien consommer" }
        check(!sim.attemptScheduled) { "Aucune minuterie ne doit être armée sans réseau" }
        sim.advance(10_000)
        sim.airplaneModeOff()
        check(sim.decisions.last() == SxbReconnectPolicy.Decision.RESUME)
        sim.advance(sim.pendingDelayMs)
        sim.fireScheduled(succeeds = true)
        check(sim.connected)
        check(sim.failedAttempts == 0)
    }

    checkCase("mode avion de 10 minutes : aucun réveil, reprise au retour") {
        val sim = ReconnectSim()
        sim.airplaneModeOn()
        // Dix minutes d'attente PURE : pas une seule minuterie, pas une seule
        // tentative. C'est ce que l'ancienne politique ne savait pas faire —
        // elle abandonnait définitivement au bout d'une cinquantaine de secondes.
        for (minute in 1..10) {
            sim.advance(60_000)
            check(!sim.attemptScheduled) { "Aucun réveil radio pendant l'attente" }
            check(sim.failedAttempts == 0) { "Aucune tentative consommée à la minute $minute" }
            check(SxbReconnectPolicy.Decision.GIVE_UP !in sim.decisions) { "Une coupure longue ne doit pas abandonner" }
        }
        sim.airplaneModeOff()
        check(sim.decisions.last() == SxbReconnectPolicy.Decision.RESUME)
        sim.advance(sim.pendingDelayMs)
        sim.fireScheduled(succeeds = true)
        check(sim.connected && sim.failedAttempts == 0)
    }

    checkCase("bascule Wi-Fi → données mobiles : une seule reprise, pas deux") {
        val sim = ReconnectSim()
        // Android annonce d'abord la nouvelle interface, puis retire l'ancienne.
        sim.networkAppeared()
        check(sim.decisions.last() == SxbReconnectPolicy.Decision.IGNORE) { "Le tunnel debout n'est pas coupé" }
        sim.networkDisappeared(stillAvailable = true)
        check(sim.attemptScheduled && sim.decisions.last() == SxbReconnectPolicy.Decision.RETRY)
        // Les rappels suivants de la même bascule sont absorbés.
        sim.networkAppeared()
        check(sim.decisions.last() == SxbReconnectPolicy.Decision.DEBOUNCE)
        sim.advance(sim.pendingDelayMs)
        sim.fireScheduled(succeeds = true)
        check(sim.connected)
        check(sim.attempts == 1) { "Une bascule ne doit produire qu'une tentative: ${sim.attempts}" }
    }

    checkCase("le recul est progressif, borné, et jamais une boucle serrée") {
        val retries = (1..SxbReconnectPolicy.MAX_RETRIES).map { SxbReconnectPolicy.retryDelayMs(it) }
        check(retries == listOf(5_000L, 10_000L, 20_000L, 40_000L, 60_000L)) { "Échelle inattendue: $retries" }
        check(retries.sum() >= 120_000L) { "Une panne serveur d'une minute ne doit pas suffire à abandonner" }
        for (attempt in 1..40) {
            val delay = SxbReconnectPolicy.retryDelayMs(attempt)
            check(delay >= SxbReconnectPolicy.BASE_RETRY_DELAY_MS) { "Pas de martèlement" }
            check(delay <= SxbReconnectPolicy.MAX_RETRY_DELAY_MS) { "Le recul doit rester borné" }
        }
        val resumes = (0..4).map { SxbReconnectPolicy.resumeDelayMs(it) }
        check(resumes == listOf(2_000L, 4_000L, 8_000L, 16_000L, 30_000L)) { "Échelle inattendue: $resumes" }
        // La première reprise doit rester imperceptible pour l'utilisateur qui
        // vient de quitter le mode avion, tout en laissant la pile Android finir
        // son association (DHCP, DNS, validation).
        check(SxbReconnectPolicy.resumeDelayMs(0) in 1_000L..3_000L)
        for (streak in 0..40) {
            val delay = SxbReconnectPolicy.resumeDelayMs(streak)
            check(delay >= SxbReconnectPolicy.BASE_RESUME_DELAY_MS)
            check(delay <= SxbReconnectPolicy.MAX_RESUME_DELAY_MS)
        }
    }

    checkCase("mode avion de 10 secondes : le tunnel repart, compteur intact") {
        val sim = ReconnectSim()
        sim.airplaneModeOn()
        check(sim.failedAttempts == 0) { "Une coupure ne doit rien consommer" }
        check(!sim.attemptScheduled) { "Aucune minuterie ne doit être armée sans réseau" }
        sim.advance(10_000)
        sim.airplaneModeOff()
        check(sim.decisions.last() == SxbReconnectPolicy.Decision.RESUME)
        sim.fireScheduled(succeeds = true)
        check(sim.connected)
        check(sim.failedAttempts == 0)
    }

    checkCase("mode avion de 10 minutes : aucun réveil, reprise au retour") {
        val sim = ReconnectSim()
        sim.airplaneModeOn()
        // Dix minutes d'attente PURE : pas une seule minuterie, pas une seule
        // tentative. C'est ce que l'ancienne politique ne savait pas faire —
        // elle abandonnait définitivement au bout d'une cinquantaine de secondes.
        for (minute in 1..10) {
            sim.advance(60_000)
            check(!sim.attemptScheduled) { "Aucun réveil radio pendant l'attente" }
            check(sim.failedAttempts == 0) { "Aucune tentative consommée à la minute $minute" }
            check(SxbReconnectPolicy.Decision.GIVE_UP !in sim.decisions) { "Une coupure longue ne doit pas abandonner" }
        }
        sim.airplaneModeOff()
        check(sim.decisions.last() == SxbReconnectPolicy.Decision.RESUME)
        sim.fireScheduled(succeeds = true)
        check(sim.connected && sim.failedAttempts == 0)
    }

    checkCase("bascule Wi-Fi → données mobiles : une seule reprise, pas deux") {
        val sim = ReconnectSim()
        // Android annonce d'abord la nouvelle interface, puis retire l'ancienne.
        sim.networkAppeared()
        check(sim.decisions.last() == SxbReconnectPolicy.Decision.IGNORE) { "Le tunnel debout n'est pas coupé" }
        sim.networkDisappeared(stillAvailable = true)
        check(sim.attemptScheduled && sim.decisions.last() == SxbReconnectPolicy.Decision.RETRY)
        // Les rappels suivants de la même bascule sont absorbés.
        sim.networkAppeared()
        check(sim.decisions.last() == SxbReconnectPolicy.Decision.DEBOUNCE)
        sim.advance(SxbReconnectPolicy.retryDelayMs(1))
        sim.fireScheduled(succeeds = true)
        check(sim.connected)
        check(sim.attempts == 1) { "Une bascule ne doit produire qu'une tentative: ${sim.attempts}" }
    }

    checkCase("un réseau qui oscille reste borné et ne martèle pas") {
        val sim = ReconnectSim()
        sim.airplaneModeOn()
        var previous = 0L
        for (flap in 0 until 6) {
            sim.advance(SxbReconnectPolicy.MIN_EVENT_INTERVAL_MS)
            sim.airplaneModeOff()
            check(sim.decisions.last() == SxbReconnectPolicy.Decision.RESUME)
            check(sim.pendingDelayMs >= previous) { "Le recul des reprises doit croître" }
            previous = sim.pendingDelayMs
            check(sim.pendingDelayMs <= SxbReconnectPolicy.MAX_RESUME_DELAY_MS)
            sim.advance(sim.pendingDelayMs)
            sim.fireScheduled(succeeds = false)
            sim.airplaneModeOn()
        }
        // Chaque reprise remet le compteur d'échecs réels à zéro : l'abandon ne
        // peut pas venir d'une ligne instable, seulement d'un serveur qui refuse.
        check(SxbReconnectPolicy.Decision.GIVE_UP !in sim.decisions)
    }

    println("PASS $cases stability policy cases")
}

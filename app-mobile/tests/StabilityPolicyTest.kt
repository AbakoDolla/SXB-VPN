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
private fun dns(address: String, detour: String = "proxy1") = JSONObject()
    .put("servers", JSONArray().put(JSONObject().put("tag", "remote").put("address", address).put("detour", detour)))
    .put("final", "remote")
private fun server(dns: JSONObject, index: Int = 0): JSONObject = dns.getJSONArray("servers").getJSONObject(index)
private fun lower(message: String) = SxbEngineLogPolicy.clean(message).lowercase(Locale.ROOT)

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
    println("PASS $cases stability policy cases")
}

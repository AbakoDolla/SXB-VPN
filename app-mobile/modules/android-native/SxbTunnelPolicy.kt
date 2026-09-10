package com.sxbvpn.vpnmodule

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.net.URISyntaxException

/** Runtime-only adaptations. Never persist them over the imported profile. */
object SxbTunnelPolicy {
    const val DEFAULT_MTU = 9000
    const val HTTP_CHAIN_MTU = 1400
    private val specialTypes = setOf("direct", "dns", "block")
    private val groupTypes = setOf("selector", "urltest")

    fun defaultProxyTag(outbounds: JSONArray, route: JSONObject?): String? {
        val items = (0 until outbounds.length()).mapNotNull { outbounds.optJSONObject(it) }
        val finalTag = route?.optString("final", "").orEmpty()
        if (finalTag.isNotBlank() && items.any { it.optString("tag", "") == finalTag }) return finalTag
        val targets = items.flatMap { references(it) }.toSet()
        val proxies = items.filter { it.optString("type", "") !in specialTypes && it.optString("tag", "").isNotBlank() }
        return (proxies.firstOrNull { it.optString("tag") !in targets } ?: proxies.firstOrNull())?.optString("tag")
    }

    private fun references(outbound: JSONObject): List<String> {
        val result = mutableListOf<String>()
        outbound.optString("detour", "").takeIf { it.isNotBlank() }?.let { result.add(it) }
        if (outbound.optString("type", "") in groupTypes) {
            val members = outbound.optJSONArray("outbounds")
                ?: throw IllegalArgumentException("Configuration refusee : TUNNEL_GROUP_EMPTY")
            require(members.length() > 0) { "Configuration refusee : TUNNEL_GROUP_EMPTY" }
            for (i in 0 until members.length()) {
                val tag = members.opt(i)
                require(tag is String && tag.isNotBlank()) { "Configuration refusee : TUNNEL_GROUP_TAG_INVALID" }
                result.add(tag)
            }
        }
        return result
    }

    class OutboundGraph(outbounds: JSONArray) {
        private val byTag = LinkedHashMap<String, JSONObject>()

        init {
            for (i in 0 until outbounds.length()) {
                val outbound = outbounds.optJSONObject(i)
                    ?: throw IllegalArgumentException("Configuration refusee : TUNNEL_OUTBOUND_INVALID")
                val tag = outbound.optString("tag", "")
                if (tag.isNotBlank()) {
                    require(byTag.put(tag, outbound) == null) { "Configuration refusee : TUNNEL_DUPLICATE_TAG" }
                }
            }
            val complete = HashSet<String>()
            val visiting = HashSet<String>()
            fun visit(tag: String) {
                if (tag in complete) return
                val outbound = requireTag(tag)
                require(visiting.add(tag)) { "Configuration refusee : TUNNEL_ROUTE_CYCLE" }
                for (target in references(outbound)) visit(target)
                val selected = outbound.optString("default", "")
                if (outbound.optString("type", "") == "selector" && selected.isNotBlank()) {
                    require(selected in references(outbound)) { "Configuration refusee : TUNNEL_GROUP_DEFAULT_INVALID" }
                }
                visiting.remove(tag)
                complete.add(tag)
            }
            for (tag in byTag.keys) visit(tag)
        }

        private fun requireTag(tag: String): JSONObject = byTag[tag]
            ?: throw IllegalArgumentException("Configuration refusee : TUNNEL_OUTBOUND_MISSING")

        private fun combine(values: List<Boolean>, everyPath: Boolean): Boolean =
            values.isNotEmpty() && if (everyPath) values.all { it } else values.any { it }

        private fun hasHttpTransport(tag: String, everyPath: Boolean): Boolean {
            val outbound = requireTag(tag)
            if (outbound.optString("type", "") == "http") return true
            return combine(references(outbound).map { hasHttpTransport(it, everyPath) }, everyPath)
        }

        fun isHttpChainedVlessWs(tag: String, everyPath: Boolean = false): Boolean {
            val outbound = requireTag(tag)
            if (outbound.optString("type", "") in groupTypes) {
                return combine(references(outbound).map { isHttpChainedVlessWs(it, everyPath) }, everyPath)
            }
            if (outbound.optString("type", "") != "vless" ||
                outbound.optJSONObject("transport")?.optString("type", "") != "ws") return false
            val detour = outbound.optString("detour", "")
            return detour.isNotBlank() && hasHttpTransport(detour, everyPath)
        }

        fun routeUsesHttpChain(route: JSONObject): Boolean {
            val tags = LinkedHashSet<String>()
            route.optString("final", "").takeIf { it.isNotBlank() }?.let { tags.add(it) }
            fun collect(rules: JSONArray?) {
                if (rules == null) return
                for (i in 0 until rules.length()) {
                    val rule = rules.optJSONObject(i) ?: continue
                    rule.optString("outbound", "").takeIf { it.isNotBlank() }?.let { tags.add(it) }
                    collect(rule.optJSONArray("rules"))
                }
            }
            collect(route.optJSONArray("rules"))
            // Validate every referenced tag even if an earlier path matched.
            val policies = tags.map { isHttpChainedVlessWs(it) }
            return policies.any { it }
        }

        fun chainEndServer(start: String): String {
            var outbound = requireTag(start)
            var server = ""
            while (true) {
                // A selector/urltest may switch at runtime; do not guess a physical endpoint.
                if (outbound.optString("type", "") in groupTypes) return ""
                outbound.optString("server", "").takeIf { it.isNotBlank() }?.let { server = it }
                val detour = outbound.optString("detour", "")
                if (detour.isBlank()) return server
                outbound = requireTag(detour)
            }
        }
    }

    fun tunMtu(profile: JSONObject, graph: OutboundGraph, route: JSONObject): Int {
        val httpChain = graph.routeUsesHttpChain(route)
        fun mtu(value: Any?): Int {
            val parsed = when (value) {
                is Number, is String -> value.toString().toIntOrNull()
                else -> null
            }
            require(parsed != null && parsed in 1280..65535) { "Configuration refusee : TUN_MTU_INVALID" }
            return parsed
        }
        if (profile.has("mtu")) return mtu(profile.opt("mtu"))
        // Only the scalar MTU is imported, never routes, addresses or listeners.
        val inbounds = profile.optJSONArray("inbounds")
        val explicit = LinkedHashSet<Int>()
        if (inbounds != null) for (i in 0 until inbounds.length()) {
            val inbound = inbounds.optJSONObject(i) ?: continue
            if (inbound.optString("type", "") == "tun" && inbound.has("mtu")) explicit.add(mtu(inbound.opt("mtu")))
        }
        require(explicit.size <= 1) { "Configuration refusee : TUN_MTU_AMBIGUOUS" }
        return explicit.firstOrNull() ?: if (httpChain) HTTP_CHAIN_MTU else DEFAULT_MTU
    }

    fun reliableDns(dns: JSONObject, graph: OutboundGraph, strategy: String): JSONObject {
        val result = JSONObject(dns.toString())
        if (!result.has("independent_cache")) result.put("independent_cache", true)
        if (!result.has("strategy")) result.put("strategy", strategy)
        val servers = result.optJSONArray("servers") ?: return result
        for (i in 0 until servers.length()) {
            val server = servers.optJSONObject(i) ?: continue
            val detour = server.optString("detour", "")
            if (detour.isBlank() || !graph.isHttpChainedVlessWs(detour, everyPath = true)) continue
            tcpDnsAddress(server.optString("address", ""))?.let { server.put("address", it) }
        }
        return result
    }

    private fun tcpDnsAddress(address: String): String? {
        val value = address.trim()
        if (value.isEmpty() || value.equals("local", true) || value.equals("fakeip", true)) return null
        // A scheme, including udp://, is an explicit transport choice.
        if (value.contains("://")) return null
        val endpoint = value
        val authority = if (!endpoint.startsWith("[") && endpoint.count { it == ':' } > 1) "[$endpoint]" else endpoint
        val uri = try { URI("tcp://$authority") } catch (_: URISyntaxException) {
            throw IllegalArgumentException("Configuration refusee : DNS_ADDRESS_INVALID")
        }
        require(!uri.host.isNullOrBlank() && uri.rawUserInfo == null && uri.rawQuery == null &&
            uri.rawFragment == null && uri.rawPath.isNullOrEmpty() && (uri.port == -1 || uri.port in 1..65535)) {
            "Configuration refusee : DNS_ADDRESS_INVALID"
        }
        return uri.toString()
    }

    fun prependDnsGuardRules(dns: JSONObject, domains: Collection<String>, directTag: String, blockTag: String) {
        val previous = dns.optJSONArray("rules") ?: JSONArray()
        val rules = JSONArray().put(JSONObject()
            .put("query_type", JSONArray().put("HTTPS").put("SVCB")).put("server", blockTag))
        if (domains.isNotEmpty()) rules.put(JSONObject().put("domain", JSONArray(domains)).put("server", directTag))
        fun stringSet(values: JSONArray?): Set<String>? = values?.let {
            (0 until it.length()).map { index -> it.optString(index) }.toSet()
        }
        for (i in 0 until previous.length()) {
            val rule = previous.optJSONObject(i)
            val sameBlock = rule?.length() == 2 && rule.optString("server", "") == blockTag &&
                stringSet(rule.optJSONArray("query_type")) == setOf("HTTPS", "SVCB")
            val sameBootstrap = rule?.length() == 2 && rule.optString("server", "") == directTag &&
                stringSet(rule.optJSONArray("domain")) == domains.toSet()
            if (!sameBlock && !sameBootstrap) rules.put(previous.opt(i))
        }
        dns.put("rules", rules)
    }
}

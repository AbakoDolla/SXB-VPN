package com.sxbvpn.vpnmodule

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.net.URISyntaxException

/** Runtime-only adaptations. Never persist them over the imported profile. */
object SxbTunnelPolicy {
    const val DEFAULT_MTU = 9000
    const val HTTP_CHAIN_MTU = 1400

    // ── Bascule bornée entre les amonts HTTP DÉCLARÉS par l'utilisateur ──────
    //
    // Un profil « zero-rated » déclare souvent une dizaine d'amonts HTTP
    // interchangeables mais n'en câble qu'un seul. Quand cet amont répond 404,
    // TOUT échoue, y compris le DNS qui emprunte la même chaîne. Le moteur sait
    // basculer seul : un groupe `urltest` sur une branche par amont déclaré lui
    // rend cette capacité, sans boucle de reconnexion artificielle côté app.
    const val CHAIN_GROUP_TAG = "sxb-chain-auto"
    const val CHAIN_BRANCH_PREFIX = "sxb-chain-"
    // Même hôte et même chemin que le défaut du moteur (C.DefaultURLTestURL),
    // mais en clair : la sonde circule DÉJÀ dans le tunnel VLESS chiffré, et le
    // schéma http reste vérifiable hors ligne, sans certificat public.
    // `urltest` ne regarde pas le code de retour : seule l'ouverture compte,
    // donc un 404 de l'amont disqualifie la branche, ce que l'on veut ici.
    const val CHAIN_PROBE_URL = "http://www.gstatic.com/generate_204"
    // `URLTest.DialContext` réutilise l'amont DÉJÀ sélectionné et ne le
    // réévalue qu'à la fin d'un cycle de sondes (`performUpdateCheck`). Un
    // amont qui se met à refuser reste donc appelé pendant tout l'intervalle :
    // celui-ci borne directement la durée des rafales de 404 observées.
    const val CHAIN_PROBE_INTERVAL = "30s"
    // Le moteur refuse interval > idle_timeout. Dix minutes couvrent une pause
    // de navigation sans continuer à sonder un tunnel réellement inactif.
    const val CHAIN_PROBE_IDLE_TIMEOUT = "10m"
    // 50 ms (défaut moteur) fait osciller la sélection sur un lien opérateur.
    const val CHAIN_PROBE_TOLERANCE = 300
    // Le moteur borne déjà ses sondes à 10 en parallèle ; on borne le nombre de
    // branches pour qu'aucun profil ne puisse en générer un nombre arbitraire.
    const val MAX_CHAIN_BRANCHES = 12

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

        /**
         * Vrai quand le tag sort par le tunnel. Un outbound spécial (`direct`,
         * `block`, `dns`) reste sur le réseau local ; un groupe suit ses
         * membres. Sert à distinguer un DNS résolu DANS le tunnel d'un
         * amorçage volontairement direct, qu'il ne faut pas contraindre.
         */
        fun isTunnelled(tag: String): Boolean {
            if (tag.isBlank() || byTag[tag] == null) return false
            val outbound = requireTag(tag)
            val type = outbound.optString("type", "")
            if (type in specialTypes) return false
            if (type in groupTypes) return references(outbound).any { isTunnelled(it) }
            return true
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

        /**
         * Every physical endpoint a chain can end on, groups included. A group
         * switches at runtime, so each member's own end server must be excluded
         * from the tunnel: excluding only the first one leaves the alternates
         * dialling through the tunnel they are supposed to feed.
         */
        fun chainEndServers(start: String): Set<String> {
            val result = LinkedHashSet<String>()
            val seen = HashSet<String>()
            fun walk(tag: String, inherited: String) {
                if (!seen.add(tag)) return
                val outbound = requireTag(tag)
                if (outbound.optString("type", "") in groupTypes) {
                    for (member in references(outbound)) walk(member, inherited)
                    return
                }
                val server = outbound.optString("server", "").takeIf { it.isNotBlank() } ?: inherited
                val detour = outbound.optString("detour", "")
                if (detour.isBlank()) {
                    if (server.isNotBlank()) result.add(server)
                    return
                }
                walk(detour, server)
            }
            walk(start, "")
            return result
        }
    }

    /**
     * Stable serialisation used only to compare declared outbounds with each
     * other. Keys are sorted so two equivalent objects written in a different
     * order still compare equal.
     */
    private fun canonical(value: Any?): String = when {
        value == null || value === JSONObject.NULL -> "null"
        value is JSONObject -> value.keys().asSequence().sorted()
            .joinToString(",", "{", "}") { "${JSONObject.quote(it)}:${canonical(value.opt(it))}" }
        value is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.opt(it)) }
        value is String -> JSONObject.quote(value)
        else -> value.toString()
    }

    private fun signature(outbound: JSONObject, ignored: Set<String>): String {
        val copy = JSONObject(outbound.toString())
        for (key in ignored) copy.remove(key)
        return canonical(copy)
    }

    /**
     * Verbatim copy of a provider header set. Names keep their exact spelling
     * and no header is added, renamed or removed: a zero-rated upstream only
     * accepts the CONNECT it was given. Values are a string or a list of
     * strings, exactly what sing-box 1.11 accepts.
     */
    fun copyHeaders(source: JSONObject?): JSONObject? {
        if (source == null) return null
        val result = JSONObject()
        val keys = source.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            when (val value = source.opt(key)) {
                is String -> result.put(key, value)
                is JSONArray -> {
                    val values = JSONArray()
                    for (i in 0 until value.length()) {
                        val item = value.opt(i)
                        require(item is String) { "Configuration refusee : HTTP_HEADER_INVALID" }
                        values.put(item)
                    }
                    result.put(key, values)
                }
                else -> throw IllegalArgumentException("Configuration refusee : HTTP_HEADER_INVALID")
            }
        }
        return if (result.length() == 0) null else result
    }

    /**
     * A chained outbound must hand the LITERAL destination to its upstream.
     * `domain_strategy` makes the engine resolve the next hop locally first, so
     * the upstream receives `CONNECT <ip>:443` instead of the whitelisted
     * domain — which a zero-rated HTTP proxy answers with 404. The DNS loop
     * guard still resolves those domains out of tunnel, for DNS purposes only.
     */
    fun enforceChainedDomainFidelity(outbounds: JSONArray): Int {
        var stripped = 0
        for (i in 0 until outbounds.length()) {
            val outbound = outbounds.optJSONObject(i) ?: continue
            if (outbound.optString("detour", "").isBlank() || !outbound.has("domain_strategy")) continue
            outbound.remove("domain_strategy")
            stripped++
        }
        return stripped
    }

    data class ChainFailover(
        val groupTag: String,
        val headTag: String,
        val upstreamTags: List<String>,
        val branchTags: List<String>,
        val generatedTags: List<String>,
    )

    /**
     * Nombre d'amonts déclarés utilisables EN PLUS de celui en cours. Sert
     * uniquement au diagnostic : aucune adresse ni aucun tag n'est conservé.
     */
    @Volatile private var alternateUpstreams = 0

    fun noteChainFailover(failover: ChainFailover?) {
        alternateUpstreams = failover?.let { it.branchTags.size - 1 } ?: 0
    }

    fun declaredAlternateUpstreams(): Int = alternateUpstreams

    /**
     * Gives the engine the alternates the profile ALREADY declares.
     *
     * Appends one chain branch per declared, interchangeable HTTP upstream then
     * a `urltest` group over them, and returns the plan. Returns null — leaving
     * `outbounds` untouched — when the profile is not an HTTP-chained head, when
     * the head is already a group (re-running on a built config is a no-op, so
     * a reconnect never accumulates branches) or when a single upstream is
     * declared. Nothing is invented: a branch is the head cloned onto a detour
     * the user declared, and a declared head already wired to an upstream is
     * reused as-is instead of being duplicated.
     */
    fun installHttpChainFailover(outbounds: JSONArray, graph: OutboundGraph, finalTag: String): ChainFailover? {
        val items = (0 until outbounds.length()).mapNotNull { outbounds.optJSONObject(it) }
        val byTag = LinkedHashMap<String, JSONObject>()
        for (item in items) item.optString("tag", "").takeIf { it.isNotBlank() }?.let { byTag[it] = item }
        val head = byTag[finalTag] ?: return null
        // A declared group is the user's own failover policy: never second-guess it.
        if (head.optString("type", "") in groupTypes) return null
        if (!graph.isHttpChainedVlessWs(finalTag)) return null
        val activeUpstream = head.optString("detour", "")
        val upstream = byTag[activeUpstream] ?: return null
        if (upstream.optString("type", "") != "http") return null

        // Interchangeable = identical once the endpoint identity is removed, so
        // headers, credentials and transport must already match byte for byte.
        val endpointKeys = setOf("tag", "server", "server_port")
        val upstreamShape = signature(upstream, endpointKeys)
        val upstreamTags = mutableListOf(activeUpstream)
        for (item in items) {
            if (upstreamTags.size >= MAX_CHAIN_BRANCHES) break
            val tag = item.optString("tag", "")
            if (tag.isBlank() || tag == activeUpstream || item.optString("type", "") != "http") continue
            if (signature(item, endpointKeys) != upstreamShape) continue
            upstreamTags.add(tag)
        }
        if (upstreamTags.size < 2) return null

        val headShape = signature(head, setOf("tag", "detour"))
        val declaredByUpstream = LinkedHashMap<String, String>()
        declaredByUpstream[activeUpstream] = finalTag
        for (item in items) {
            val tag = item.optString("tag", "")
            val detour = item.optString("detour", "")
            if (tag.isBlank() || detour.isBlank() || declaredByUpstream.containsKey(detour)) continue
            if (signature(item, setOf("tag", "detour")) == headShape) declaredByUpstream[detour] = tag
        }

        val used = HashSet(byTag.keys)
        val branchTags = mutableListOf<String>()
        val generatedTags = mutableListOf<String>()
        val created = mutableListOf<JSONObject>()
        for (upstreamTag in upstreamTags) {
            val declared = declaredByUpstream[upstreamTag]
            if (declared != null) {
                branchTags.add(declared)
                continue
            }
            var tag = CHAIN_BRANCH_PREFIX + upstreamTag
            var suffix = 1
            while (!used.add(tag)) tag = "$CHAIN_BRANCH_PREFIX$upstreamTag-${++suffix}"
            created.add(JSONObject(head.toString()).put("tag", tag).put("detour", upstreamTag)
                .also { it.remove("domain_strategy") })
            branchTags.add(tag)
            generatedTags.add(tag)
        }

        var groupTag = CHAIN_GROUP_TAG
        var groupSuffix = 1
        while (!used.add(groupTag)) groupTag = "$CHAIN_GROUP_TAG-${++groupSuffix}"
        for (branch in created) outbounds.put(branch)
        outbounds.put(JSONObject()
            .put("type", "urltest")
            .put("tag", groupTag)
            // The user's own head stays first: with no probe history the engine
            // falls back to the first member, i.e. exactly today's behaviour.
            .put("outbounds", JSONArray(branchTags))
            .put("url", CHAIN_PROBE_URL)
            .put("interval", CHAIN_PROBE_INTERVAL)
            .put("tolerance", CHAIN_PROBE_TOLERANCE)
            .put("idle_timeout", CHAIN_PROBE_IDLE_TIMEOUT)
            .put("interrupt_exist_connections", false))
        return ChainFailover(groupTag, finalTag, upstreamTags.toList(), branchTags.toList(), generatedTags.toList())
    }

    /** Route rules only: an outbound `detour` is never retargeted (cycle safety). */
    fun retargetRouteOutbound(rules: JSONArray, fromTag: String, toTag: String): Int {
        if (fromTag.isBlank() || toTag.isBlank() || fromTag == toTag) return 0
        var changed = 0
        for (i in 0 until rules.length()) {
            val rule = rules.optJSONObject(i) ?: continue
            if (rule.optString("outbound", "") == fromTag) {
                rule.put("outbound", toTag)
                changed++
            }
            rule.optJSONArray("rules")?.let { changed += retargetRouteOutbound(it, fromTag, toTag) }
        }
        return changed
    }

    /** DNS must follow the same failover, otherwise one dead upstream kills resolution. */
    fun retargetDnsDetour(dns: JSONObject, fromTag: String, toTag: String): Int {
        if (fromTag.isBlank() || toTag.isBlank() || fromTag == toTag) return 0
        val servers = dns.optJSONArray("servers") ?: return 0
        var changed = 0
        for (i in 0 until servers.length()) {
            val server = servers.optJSONObject(i) ?: continue
            if (server.optString("detour", "") == fromTag) {
                server.put("detour", toTag)
                changed++
            }
        }
        return changed
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

    /**
     * @param tunnelHasIpv6 le TUN transporte-t-il de l'IPv6 ? Quand il n'en
     *   transporte pas, une réponse AAAA ne mène à aucune route utilisable :
     *   l'application tente l'adresse v6 en premier (Happy Eyeballs) puis
     *   attend son échec, et la requête AAAA a EN PLUS coûté un aller-retour
     *   complet dans la chaîne. Avec `strategy: ipv4_only`, `sing-dns` répond
     *   localement (NOERROR vide) sans solliciter le transport : les deux coûts
     *   disparaissent. Appliqué au seul DNS résolu dans le tunnel, jamais à
     *   l'amorçage direct, et jamais par-dessus un choix explicite du profil.
     */
    fun reliableDns(dns: JSONObject, graph: OutboundGraph, tunnelHasIpv6: Boolean = false): JSONObject {
        val result = JSONObject(dns.toString())
        if (!result.has("independent_cache")) result.put("independent_cache", true)
        val servers = result.optJSONArray("servers") ?: return result
        for (i in 0 until servers.length()) {
            val server = servers.optJSONObject(i) ?: continue
            val detour = server.optString("detour", "")
            if (detour.isBlank()) continue
            if (!tunnelHasIpv6 && !server.has("strategy") && graph.isTunnelled(detour)) {
                server.put("strategy", "ipv4_only")
            }
            if (!graph.isHttpChainedVlessWs(detour, everyPath = true)) continue
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

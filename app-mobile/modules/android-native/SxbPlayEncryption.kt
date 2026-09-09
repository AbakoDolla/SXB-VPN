package com.sxbvpn.vpnmodule

import org.json.JSONObject

/**
 * Validates the FINAL sing-box graph, after Xray conversion and app routing.
 * No outer "tls" flag or imported loopback SOCKS can vouch for an outbound.
 * Chained/unknown profiles are deliberately unsupported in the Play build.
 */
object SxbPlayEncryption {
    const val ERROR = "PLAY_ENCRYPTION_REQUIRED"
    private val aead = setOf(
        "aes-128-gcm", "aes-256-gcm", "chacha20-ietf-poly1305", "xchacha20-ietf-poly1305",
        "2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm", "2022-blake3-chacha20-poly1305",
    )

    fun validate(config: JSONObject, trustedSshRelay: Boolean = false, sshPort: Int = 0) {
        fun reject(): Nothing = throw IllegalArgumentException(ERROR)
        val list = config.optJSONArray("outbounds") ?: reject()
        val byTag = LinkedHashMap<String, JSONObject>()
        for (i in 0 until list.length()) {
            val outbound = list.optJSONObject(i) ?: reject()
            val tag = outbound.optString("tag")
            if (tag.isBlank() || byTag.put(tag, outbound) != null) reject()
        }
        val visiting = HashSet<String>()
        fun encrypted(tag: String): Boolean {
            val outbound = byTag[tag] ?: return false
            if (!visiting.add(tag)) return false
            try {
                if (outbound.has("detour") || outbound.has("proxySettings")) return false
                val tls = outbound.optJSONObject("tls")
                val secureTls = tls != null && tls.opt("enabled") == true &&
                    (!tls.has("insecure") || tls.opt("insecure") == false)
                val type = outbound.optString("type")
                return when (type) {
                    "vless", "trojan", "hysteria2", "tuic", "hysteria" -> secureTls
                    "vmess" -> secureTls || outbound.optString("security") in setOf("auto", "aes-128-gcm", "chacha20-poly1305")
                    "shadowsocks" -> outbound.optString("method") in aead
                    "wireguard" -> outbound.optString("private_key").isNotBlank() &&
                        (outbound.optString("peer_public_key").isNotBlank() ||
                            outbound.optJSONArray("peers")?.let { peers ->
                                peers.length() > 0 && (0 until peers.length()).all {
                                    peers.optJSONObject(it)?.optString("public_key")?.isNotBlank() == true
                                }
                            } == true)
                    "selector", "urltest" -> outbound.optJSONArray("outbounds")?.let { choices ->
                        choices.length() > 0 && (0 until choices.length()).all { encrypted(choices.optString(it)) }
                    } == true
                    "socks" -> trustedSshRelay && outbound.optString("server") == "127.0.0.1" &&
                        outbound.optInt("server_port") == sshPort && sshPort > 0
                    else -> false
                }
            } finally { visiting.remove(tag) }
        }
        for ((tag, outbound) in byTag) {
            if (outbound.optString("type") == "direct" &&
                listOf("override_address", "override_port", "detour", "proxySettings").any { outbound.has(it) }) reject()
            if (outbound.optString("type") !in setOf("direct", "block", "dns") && !encrypted(tag)) reject()
        }
        val route = config.optJSONObject("route") ?: reject()
        if (!encrypted(route.optString("final"))) reject()
        val rules = route.optJSONArray("rules")
        if (rules != null) for (i in 0 until rules.length()) {
            val rule = rules.optJSONObject(i) ?: reject()
            if (rule.has("rules") || rule.optString("action", "route") != "route") reject()
            val target = rule.optString("outbound")
            val type = byTag[target]?.optString("type") ?: reject()
            if (type == "direct") {
                // Only app-local LAN bypass, never arbitrary public IP/domain rules.
                if (rule.opt("ip_is_private") != true ||
                    rule.keys().asSequence().any { it !in setOf("outbound", "ip_is_private") }) reject()
            } else if (type == "dns") {
                if (rule.opt("protocol") != "dns" ||
                    rule.keys().asSequence().any { it !in setOf("outbound", "protocol") }) reject()
            } else if (type != "block" && !encrypted(target)) reject()
        }
    }
}

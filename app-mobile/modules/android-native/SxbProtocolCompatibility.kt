package com.sxbvpn.vpnmodule

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom

/** Pure protocol mappings; no Android service, filesystem or network access. */
object SxbProtocolCompatibility {
    class LegacyPayloadSequence {
        private var profile: ByteArray? = null
        private var rotation = 0

        @Synchronized
        fun expand(cfg: JSONObject, raw: String): String {
            val technical = JSONArray()
            for (field in listOf("configId", "id", "configHash", "configVersion", "host", "port", "username",
                "password", "privateKeyBase64", "privateKeyPassphrase", "sshTransport", "tls", "sni", "fingerprint",
                "proxyHost", "proxyPort", "payloadTargetPort")) technical.put(cfg.opt(field))
            technical.put(raw)
            val identity = MessageDigest.getInstance("SHA-256").digest(technical.toString().toByteArray(Charsets.UTF_8))
            if (profile?.contentEquals(identity) != true) {
                profile = identity
                rotation = 0
            }
            return legacyPayload(raw, rotation++)
        }
    }

    fun legacyPayload(raw: String, rotation: Int): String {
        val random = SecureRandom()
        val result = Regex("\\[(rotate|random)=([^\\r\\n\\]]*)\\]", RegexOption.IGNORE_CASE).replace(raw) {
            val values = it.groupValues[2].split(';')
            require(values.isNotEmpty() && values.none { value -> value.isEmpty() }) { "PAYLOAD_TOKEN_INVALID" }
            val index = if (it.groupValues[1].equals("rotate", true)) Math.floorMod(rotation, values.size) else random.nextInt(values.size)
            values[index]
        }
        require(!Regex("\\[(?:rotate|random)", RegexOption.IGNORE_CASE).containsMatchIn(result)) { "PAYLOAD_TOKEN_INVALID" }
        return result.replace("\\r", "\r").replace("\\n", "\n")
    }

    private fun port(value: Int): Int {
        require(value in 1..65535) { "PROTOCOL_PORT_INVALID" }
        return value
    }

    fun endpoint(raw: String): Pair<String, Int> {
        val match = Regex("^(?:\\[([0-9a-fA-F:.]+)\\]|([^:\\s/]+)):(\\d+)$").matchEntire(raw)
            ?: throw IllegalArgumentException("PROTOCOL_ENDPOINT_INVALID")
        if (match.groupValues[1].isNotEmpty()) prefix(match.groupValues[1])
        return (match.groupValues[1].ifBlank { match.groupValues[2] }) to port(match.groupValues[3].toIntOrNull() ?: 0)
    }

    private fun key(raw: String): String {
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
        require(Regex("^[A-Za-z0-9+/]{43}=$").matches(raw) &&
            alphabet.indexOf(raw[42]) % 4 == 0) { "WIREGUARD_KEY_INVALID" }
        return raw
    }

    private fun integer(value: Any?, min: Long, max: Long, error: String): Long {
        val text = value?.toString().orEmpty()
        require(Regex("^\\d+$").matches(text)) { error }
        val number = text.toLongOrNull() ?: throw IllegalArgumentException(error)
        require(number in min..max) { error }
        return number
    }

    private fun prefix(raw: String): String {
        val parts = raw.split('/')
        require(parts.size in 1..2) { "WIREGUARD_ADDRESS_INVALID" }
        val address = parts[0]
        val ipv6 = ':' in address
        fun validV4(value: String): Boolean = Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(value) &&
            value.split('.').all { it.toInt() in 0..255 && (it == "0" || !it.startsWith('0')) }
        if (ipv6) {
            val v4 = address.substringAfterLast(':')
            val normalized = if ('.' in address && validV4(v4)) address.dropLast(v4.length) + "0:0" else address
            val groups = normalized.split(':').filter { it.isNotEmpty() }
            require(":::" !in normalized && (!normalized.startsWith(':') || normalized.startsWith("::")) &&
                (!normalized.endsWith(':') || normalized.endsWith("::")) && normalized.split("::").size <= 2 &&
                groups.all { Regex("^[0-9a-fA-F]{1,4}$").matches(it) } &&
                (if ("::" in normalized) groups.size < 8 else groups.size == 8)) { "WIREGUARD_ADDRESS_INVALID" }
        } else {
            require(validV4(address)) { "WIREGUARD_ADDRESS_INVALID" }
        }
        val max = if (ipv6) 128L else 32L
        return "$address/${integer(parts.getOrNull(1) ?: max, 0, max, "WIREGUARD_ADDRESS_INVALID")}"
    }

    fun wireguard(settings: JSONObject, tag: String): JSONObject {
        val addresses = settings.optJSONArray("address")
            ?: throw IllegalArgumentException("WIREGUARD_ADDRESS_REQUIRED")
        require(addresses.length() > 0) { "WIREGUARD_ADDRESS_REQUIRED" }
        val peers = settings.optJSONArray("peers")
            ?: throw IllegalArgumentException("WIREGUARD_PEERS_REQUIRED")
        require(peers.length() > 0) { "WIREGUARD_PEERS_REQUIRED" }
        val converted = JSONArray()
        for (i in 0 until peers.length()) {
            val peer = peers.getJSONObject(i)
            val (host, remotePort) = endpoint(peer.getString("endpoint"))
            val allowed = peer.getJSONArray("allowedIPs")
            require(allowed.length() > 0) { "WIREGUARD_ALLOWED_IPS_REQUIRED" }
            val keepalive = integer(peer.opt("keepAlive") ?: 0, 0, 65535, "WIREGUARD_KEEPALIVE_INVALID")
            converted.put(JSONObject().apply {
                put("address", host)
                put("port", remotePort)
                put("public_key", key(peer.getString("publicKey")))
                put("allowed_ips", JSONArray().apply {
                    for (n in 0 until allowed.length()) put(prefix(allowed.getString(n)))
                })
                put("persistent_keepalive_interval", keepalive)
                peer.optString("preSharedKey", "").takeIf { it.isNotEmpty() }?.let { put("pre_shared_key", key(it)) }
                val reserved = peer.optJSONArray("reserved") ?: settings.optJSONArray("reserved")
                if (reserved != null) {
                    require(reserved.length() == 3) { "WIREGUARD_RESERVED_INVALID" }
                    put("reserved", JSONArray((0..2).map { integer(reserved.get(it), 0, 255, "WIREGUARD_RESERVED_INVALID") }))
                }
            })
        }
        val mtu = integer(settings.opt("mtu") ?: 1420, 576, 65535, "WIREGUARD_MTU_INVALID")
        return JSONObject().apply {
            put("type", "wireguard")
            put("tag", tag)
            put("system", false)
            put("private_key", key(settings.getString("secretKey")))
            put("address", JSONArray().apply {
                for (i in 0 until addresses.length()) put(prefix(addresses.getString(i)))
            })
            put("mtu", mtu)
            put("peers", converted)
        }
    }

    fun canonicalWireguard(cfg: JSONObject): JSONObject {
        val destination = cfg.optString("endpoint", "").ifBlank {
            val host = cfg.optString("host", "")
            "${if (':' in host) "[$host]" else host}:${cfg.optInt("port", 0)}"
        }
        val rawAddresses = cfg.opt("address") ?: cfg.opt("localAddress") ?: "10.0.0.2/32"
        val addresses = if (rawAddresses is JSONArray) rawAddresses else JSONArray(
            rawAddresses.toString().split(',').map { it.trim() }
        )
        val rawAllowed = cfg.opt("allowedIPs") ?: cfg.opt("allowedIps")
        val allowed = when (rawAllowed) {
            null -> JSONArray().put("0.0.0.0/0").put("::/0")
            is JSONArray -> rawAllowed
            is String -> JSONArray(rawAllowed.split(',').map { it.trim() })
            else -> throw IllegalArgumentException("WIREGUARD_ALLOWED_IPS_INVALID")
        }
        val peer = JSONObject().apply {
            put("endpoint", destination)
            put("publicKey", cfg.optString("publicKey", cfg.optString("peerPublicKey", "")))
            put("allowedIPs", allowed)
            put("keepAlive", cfg.opt("persistentKeepalive") ?: cfg.opt("keepAlive") ?: 0)
            put("preSharedKey", cfg.optString("presharedKey", cfg.optString("preSharedKey", "")))
        }
        return wireguard(JSONObject().apply {
            put("secretKey", cfg.getString("privateKey"))
            put("address", addresses)
            put("peers", JSONArray().put(peer))
            put("mtu", cfg.opt("mtu") ?: 1420)
            cfg.opt("reserved")?.let {
                require(it is JSONArray) { "WIREGUARD_RESERVED_INVALID" }
                put("reserved", it)
            }
        }, "proxy")
    }

    fun hysteria(cfg: JSONObject, version: Int): JSONObject {
        require(version == 1 || version == 2) { "HYSTERIA_VERSION_INVALID" }
        require(!cfg.has("tls") || cfg.getBoolean("tls")) { "HYSTERIA_TLS_REQUIRED" }
        val host = cfg.getString("host")
        val password = cfg.getString("password")
        require(host.isNotBlank() && password.isNotEmpty()) { "HYSTERIA_CREDENTIALS_REQUIRED" }
        return JSONObject().apply {
            put("type", if (version == 1) "hysteria" else "hysteria2")
            put("tag", "proxy")
            put("server", host)
            put("server_port", integer(cfg.get("port"), 1, 65535, "PROTOCOL_PORT_INVALID"))
            put(if (version == 1) "auth_str" else "password", password)
            for ((source, target) in listOf("upMbps" to "up_mbps", "downMbps" to "down_mbps")) {
                if (cfg.has(source) || version == 1) {
                    val value = integer(cfg.get(source), 1, 1_000_000, "HYSTERIA_BANDWIDTH_INVALID")
                    put(target, value)
                }
            }
            if (version == 1) {
                cfg.optString("obfs", "").takeIf { it.isNotEmpty() }?.let { put("obfs", it) }
                for ((source, target) in listOf("recvWindowConn" to "recv_window_conn", "recvWindow" to "recv_window")) {
                    if (cfg.has(source) && !cfg.isNull(source)) {
                        val value = integer(cfg.get(source), 1, 9_007_199_254_740_991, "HYSTERIA_WINDOW_INVALID")
                        put(target, value)
                    }
                }
            } else {
                val obfs = cfg.optString("obfs", "")
                if (obfs.isNotEmpty()) {
                    require(obfs == "salamander" && cfg.optString("obfsPassword", "").isNotEmpty()) { "HYSTERIA2_OBFS_INVALID" }
                    put("obfs", JSONObject().put("type", obfs).put("password", cfg.getString("obfsPassword")))
                }
            }
            put("tls", JSONObject().apply {
                put("enabled", true)
                put("server_name", cfg.optString("sni", host).ifBlank { host })
                put("insecure", cfg.optBoolean("insecure", false))
                cfg.optString("certificate", "").takeIf { it.isNotBlank() }?.let { put("certificate", it) }
                cfg.optString("alpn", "").takeIf { it.isNotBlank() }?.let {
                    put("alpn", JSONArray(it.split(',').map { value -> value.trim() }))
                }
            })
        }
    }

    fun dnsHosts(dns: JSONObject, hosts: JSONObject, onWarning: (String) -> Unit = { throw IllegalArgumentException(it) }): JSONObject {
        if (hosts.length() == 0) return dns
        val predefined = JSONObject()
        for (domain in hosts.keys()) {
            try {
            require(Regex("^[a-zA-Z0-9_-]+(?:\\.[a-zA-Z0-9_-]+)*\\.?$").matches(domain)) { "XRAY_DNS_HOSTS_MATCHER_UNSUPPORTED" }
            val raw = hosts.get(domain)
            val values = if (raw is JSONArray) raw else JSONArray().put(raw)
            require(values.length() > 0) { "XRAY_DNS_HOSTS_EMPTY" }
            predefined.put(domain, JSONArray().apply {
                for (i in 0 until values.length()) {
                    val value = values.getString(i)
                    require('/' !in value) { "XRAY_DNS_HOSTS_ALIAS_UNSUPPORTED" }
                    prefix(value)
                    put(value)
                }
            })
            } catch (error: IllegalArgumentException) {
                onWarning("XRAY_DNS_HOSTS_NOT_TRANSLATED")
            }
        }
        if (predefined.length() == 0) return dns
        val servers = dns.optJSONArray("servers") ?: JSONArray().also { dns.put("servers", it) }
        var tag = "dns-hosts"
        while ((0 until servers.length()).any { servers.optJSONObject(it)?.optString("tag") == tag }) tag += "-local"
        servers.put(JSONObject().put("type", "hosts").put("tag", tag).put("predefined", predefined))
        val rules = JSONArray().put(JSONObject().put("domain", JSONArray(predefined.keys().asSequence().toList())).put("server", tag))
        dns.optJSONArray("rules")?.let { for (i in 0 until it.length()) rules.put(it.get(i)) }
        dns.put("rules", rules)
        return dns
    }
}

package com.sxbvpn.vpnmodule

import org.json.JSONArray
import org.json.JSONObject

/** JVM harness: real production validator and org.json, no Android stubs. */
fun main() {
    var passed = 0
    fun graph(outbound: JSONObject): JSONObject = JSONObject().apply {
        put("outbounds", JSONArray().put(outbound.put("tag", "proxy"))
            .put(JSONObject("""{"type":"direct","tag":"direct"}"""))
            .put(JSONObject("""{"type":"dns","tag":"dns-out"}"""))
            .put(JSONObject("""{"type":"block","tag":"block"}""")))
        put("route", JSONObject("""{"final":"proxy","rules":[
            {"protocol":"dns","outbound":"dns-out"},
            {"ip_is_private":true,"outbound":"direct"}
        ]}"""))
    }
    fun accepts(name: String, config: JSONObject, ssh: Boolean = false) {
        SxbPlayEncryption.validate(config, ssh, 10808)
        println("PASS $name")
        passed++
    }
    fun rejects(name: String, config: JSONObject, ssh: Boolean = false) {
        try {
            SxbPlayEncryption.validate(config, ssh, 10808)
        } catch (error: IllegalArgumentException) {
            check(error.message == SxbPlayEncryption.ERROR) { "Unexpected failure: $name" }
            println("PASS $name")
            passed++
            return
        }
        error("Accepted unsafe/ambiguous graph: $name")
    }
    for (type in listOf("vless", "trojan", "hysteria", "hysteria2", "tuic")) {
        accepts("$type TLS", graph(JSONObject("""{"type":"$type","tls":{"enabled":true}}""")))
        rejects("$type no TLS", graph(JSONObject("""{"type":"$type","tls":{"enabled":false}}""")))
        rejects("$type unverifiable TLS", graph(JSONObject("""{"type":"$type","tls":{"enabled":true,"insecure":true}}""")))
        rejects("$type missing TLS", graph(JSONObject("""{"type":"$type"}""")))
    }
    for (method in listOf("aes-128-gcm", "aes-256-gcm", "chacha20-ietf-poly1305", "2022-blake3-aes-256-gcm")) {
        accepts("Shadowsocks $method", graph(JSONObject("""{"type":"shadowsocks","method":"$method"}""")))
    }
    for (method in listOf("none", "plain", "unknown", "")) {
        rejects("Shadowsocks $method", graph(JSONObject("""{"type":"shadowsocks","method":"$method"}""")))
    }
    for (method in listOf("auto", "aes-128-gcm", "chacha20-poly1305")) {
        accepts("VMess $method without TLS", graph(JSONObject("""{"type":"vmess","security":"$method"}""")))
    }
    for (method in listOf("none", "zero", "unknown", "")) {
        rejects("VMess $method without TLS", graph(JSONObject("""{"type":"vmess","security":"$method"}""")))
    }
    accepts("VMess none inside TLS", graph(JSONObject("""{"type":"vmess","security":"none","tls":{"enabled":true}}""")))
    accepts("VLESS Reality", graph(JSONObject("""{"type":"vless","tls":{"enabled":true,"reality":{"enabled":true,"public_key":"test"}}}""")))
    rejects("Outer TLS cannot secure plaintext", graph(JSONObject("""{"type":"vless","tls":{"enabled":false}}""")).put("tls", true))
    rejects("String flags fail closed", graph(JSONObject("""{"type":"vless","tls":{"enabled":"true"}}""")))
    rejects("String insecure fails closed", graph(JSONObject("""{"type":"vless","tls":{"enabled":true,"insecure":"true"}}""")))
    accepts("WireGuard keyed endpoint", graph(JSONObject("""{"type":"wireguard","private_key":"test","peer_public_key":"test"}""")))
    accepts("WireGuard peers", graph(JSONObject("""{"type":"wireguard","private_key":"test","peers":[{"public_key":"test"}]}""")))
    rejects("WireGuard missing peer", graph(JSONObject("""{"type":"wireguard","private_key":"test"}""")))
    accepts("JSch authenticated local relay", graph(JSONObject("""{"type":"socks","server":"127.0.0.1","server_port":10808}""")), true)
    rejects("Imported loopback is not authenticated SSH", graph(JSONObject("""{"type":"socks","server":"127.0.0.1","server_port":10808}""")))
    rejects("SSH relay cannot attest remote SOCKS", graph(JSONObject("""{"type":"socks","server":"remote.test","server_port":10808}""")), true)
    for (type in listOf("http", "socks", "mystery", "direct", "dns", "block")) {
        rejects("No $type data fallback", graph(JSONObject("""{"type":"$type"}""")))
    }
    rejects("Raw Xray must be converted first", graph(JSONObject("""{"protocol":"vless","streamSettings":{"security":"tls"}}""")))
    val chained = graph(JSONObject("""{"type":"vless","tls":{"enabled":true},"detour":"upstream"}"""))
    chained.getJSONArray("outbounds").put(JSONObject("""{"type":"http","tag":"upstream","server":"proxy.test"}"""))
    rejects("Ambiguous plaintext chain", chained)
    val routed = graph(JSONObject("""{"type":"vless","tls":{"enabled":true}}"""))
    routed.getJSONObject("route").getJSONArray("rules").put(JSONObject("""{"domain":["public.test"],"outbound":"direct"}"""))
    rejects("Public traffic cannot bypass", routed)
    val inverted = graph(JSONObject("""{"type":"vless","tls":{"enabled":true}}"""))
    inverted.getJSONObject("route").getJSONArray("rules").put(JSONObject("""{"ip_is_private":true,"invert":true,"outbound":"direct"}"""))
    rejects("Inverted LAN rule cannot bypass", inverted)
    val redirectedLan = graph(JSONObject("""{"type":"vless","tls":{"enabled":true}}"""))
    redirectedLan.getJSONArray("outbounds").getJSONObject(1).put("override_address", "public.test")
    rejects("LAN direct cannot redirect outside the tunnel", redirectedLan)
    val badDns = graph(JSONObject("""{"type":"vless","tls":{"enabled":true}}"""))
    badDns.getJSONObject("route").getJSONArray("rules").put(JSONObject("""{"outbound":"dns-out"}"""))
    rejects("DNS tag cannot carry arbitrary traffic", badDns)
    val group = graph(JSONObject("""{"type":"selector","outbounds":["encrypted"]}"""))
    group.getJSONArray("outbounds").put(JSONObject("""{"type":"vless","tag":"encrypted","tls":{"enabled":true}}"""))
    accepts("Encrypted selector", group)
    group.getJSONArray("outbounds").getJSONObject(0).getJSONArray("outbounds").put("direct")
    rejects("Selector includes plaintext fallback", group)
    rejects("Selector cycle", graph(JSONObject("""{"type":"urltest","outbounds":["proxy"]}""")))
    rejects("Unknown selector target", graph(JSONObject("""{"type":"selector","outbounds":["missing"]}""")))
    val duplicate = graph(JSONObject("""{"type":"vless","tls":{"enabled":true}}"""))
    duplicate.getJSONArray("outbounds").put(JSONObject("""{"type":"direct","tag":"proxy"}"""))
    rejects("Duplicate tag ambiguity", duplicate)
    println("$passed Play encryption cases passed")
}

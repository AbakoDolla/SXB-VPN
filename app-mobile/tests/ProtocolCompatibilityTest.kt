package com.sxbvpn.vpnmodule

import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64

private fun rejected(block: () -> Unit) {
    try { block() } catch (_: IllegalArgumentException) { return }
    error("Expected invalid configuration to be rejected")
}

fun main() {
    val key = Base64.getEncoder().encodeToString(ByteArray(32) { 1 })
    val cfg = JSONObject().put("privateKey", key).put("publicKey", key)
        .put("endpoint", "[::1]:23456").put("address", "10.99.0.2/32,fd99::2/128")
        .put("allowedIps", "0.0.0.0/0,::/0").put("persistentKeepalive", 25)
        .put("presharedKey", key).put("reserved", JSONArray("[0,127,255]"))
    val endpoint = SxbProtocolCompatibility.canonicalWireguard(cfg)
    check(!endpoint.getBoolean("system"))
    check(endpoint.getString("private_key") == key)
    val peer = endpoint.getJSONArray("peers").getJSONObject(0)
    check(peer.getInt("persistent_keepalive_interval") == 25)
    check(peer.getString("pre_shared_key") == key)
    check(peer.getJSONArray("reserved").getInt(2) == 255)
    for (address in listOf("::", "::1", "::ffff:192.0.2.1", "1:2:3:4:5:6:7:8")) {
        check(SxbProtocolCompatibility.endpoint("[$address]:443").first == address)
        SxbProtocolCompatibility.canonicalWireguard(JSONObject(cfg.toString()).put("address", "$address/128"))
    }
    for (address in listOf(":::1", ":1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8:", "1::2::3", "::ffff:999.0.0.1")) {
        rejected { SxbProtocolCompatibility.endpoint("[$address]:443") }
        rejected { SxbProtocolCompatibility.canonicalWireguard(JSONObject(cfg.toString()).put("address", "$address/64")) }
        rejected { SxbProtocolCompatibility.dnsHosts(JSONObject(), JSONObject().put("invalid.example.test", address)) }
    }
    for ((field, value) in listOf("persistentKeepalive" to 0.5, "mtu" to "1420.5", "reserved" to JSONArray("[0,1,256]"),
        "privateKey" to "not-a-key", "address" to "::1/129")) {
        rejected { SxbProtocolCompatibility.canonicalWireguard(JSONObject(cfg.toString()).put(field, value)) }
    }
    val hy = JSONObject().put("host", "127.0.0.1").put("port", 23456).put("password", "synthetic")
        .put("upMbps", 10).put("downMbps", 20).put("obfs", "synthetic-secret")
        .put("recvWindowConn", 196608).put("recvWindow", 786432)
    val v1 = SxbProtocolCompatibility.hysteria(hy, 1)
    check(v1.getString("type") == "hysteria")
    check(v1.getString("auth_str") == "synthetic")
    check(v1.getString("obfs") == "synthetic-secret")
    check(v1.getInt("recv_window_conn") == 196608)
    check(!v1.getJSONObject("tls").getBoolean("insecure"))
    val v2cfg = JSONObject(hy.toString()).put("obfs", "salamander").put("obfsPassword", "synthetic-secret")
    val v2 = SxbProtocolCompatibility.hysteria(v2cfg, 2)
    check(v2.getString("type") == "hysteria2")
    check(v2.getJSONObject("obfs").getString("password") == "synthetic-secret")
    check(v2.getInt("up_mbps") == 10)
    for ((field, value) in listOf("port" to 443.5, "upMbps" to 0, "downMbps" to "1.2", "tls" to false)) {
        rejected { SxbProtocolCompatibility.hysteria(JSONObject(hy.toString()).put(field, value), 1) }
    }
    rejected { SxbProtocolCompatibility.hysteria(JSONObject(v2cfg.toString()).put("obfs", "unknown"), 2) }
    val payload = "[rotate=a;b] [rotate=1;2;3] [random=x;y]\\r\\n"
    check(SxbProtocolCompatibility.legacyPayload(payload, 0).startsWith("a 1 "))
    check(SxbProtocolCompatibility.legacyPayload(payload, 1).startsWith("b 2 "))
    check(SxbProtocolCompatibility.legacyPayload(payload, 2).startsWith("a 3 "))
    check(SxbProtocolCompatibility.legacyPayload(payload, 3).endsWith("\r\n"))
    rejected { SxbProtocolCompatibility.legacyPayload("[rotate=a;]", 0) }
    rejected { SxbProtocolCompatibility.legacyPayload("[random=]", 0) }
    val sequence = SxbProtocolCompatibility.LegacyPayloadSequence()
    val profile = JSONObject().put("configId", "synthetic-profile").put("host", "ssh.example.test")
        .put("port", 22).put("username", "synthetic").put("accessAttempt", "first-attempt")
    check(sequence.expand(profile, "[rotate=a;b]") == "a")
    profile.put("accessAttempt", "second-attempt").put("accessGeneration", 2)
    check(sequence.expand(profile, "[rotate=a;b]") == "b")
    check(sequence.expand(profile.put("configId", "different-profile"), "[rotate=a;b]") == "a")
    check(sequence.expand(profile, "[rotate=x;y]") == "x")
    check(sequence.expand(profile, "[rotate=x;y]") == "y")
    check(sequence.expand(profile.put("host", "changed.example.test"), "[rotate=x;y]") == "x")
    val dns = SxbProtocolCompatibility.dnsHosts(JSONObject().put("servers", JSONArray()),
        JSONObject().put("exact.example.test", JSONArray("[\"192.0.2.1\",\"::ffff:192.0.2.1\"]")))
    check(dns.getJSONArray("servers").getJSONObject(0).getString("type") == "hosts")
    check(dns.getJSONArray("rules").getJSONObject(0).getJSONArray("domain").getString(0) == "exact.example.test")
    val graph = JSONObject("""
        {"outbounds":[{"type":"socks","tag":"proxy","server":"vpn.example.test","server_port":1080},{"type":"direct","tag":"direct"}],
         "dns":{"servers":[{"type":"hosts","tag":"dns-hosts","predefined":{"exact.example.test":["192.0.2.1"]}},
           {"type":"udp","tag":"dns-bootstrap","server":"127.0.0.1"}]},
         "route":{"final":"proxy"}}
    """)
    check(SxbEngineSchema.moderniser(graph).getJSONObject("route").getString("default_domain_resolver") == "dns-bootstrap")
    graph.getJSONObject("route").put("default_domain_resolver", "explicit-resolver")
    check(SxbEngineSchema.moderniser(graph).getJSONObject("route").getString("default_domain_resolver") == "explicit-resolver")
    println("Protocol compatibility JVM: H1/H2, WireGuard, IPv6, DNS hosts, payload and rejection cases passed")
}

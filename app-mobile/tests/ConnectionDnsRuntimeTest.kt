package com.sxbvpn.vpnmodule

import org.json.JSONArray
import org.json.JSONObject

fun main() {
    val harness = ConnectionDnsHarness()
    for (value in listOf("", "8.8.8.8", "1.1.1.1", "tcp://8.8.4.4:5353", "tls://dns.google")) {
        val runtime = harness.ssh(value)
        val remote = runtime.getJSONObject("dns").getJSONArray("servers").getJSONObject(0)
        val expected = when {
            value.isBlank() -> "tcp://8.8.8.8"
            value.contains("://") -> value
            else -> "tcp://$value"
        }
        check(remote.getString("address") == expected)
        check(remote.getString("detour") == "proxy")
    }
    val local = harness.ssh("local").getJSONObject("dns").getJSONArray("servers").getJSONObject(0)
    check(local.getString("address") == "192.0.2.1" && local.getString("detour") == "direct")
    check(runCatching { harness.ssh("udp://8.8.8.8") }.exceptionOrNull()?.message == "SSH_DNS_UDP_UNSUPPORTED")
    val cfg = JSONObject().put("dns", "1.1.1.1").put("connectionDns", "8.8.8.8")
    check(harness.choice(cfg) == "8.8.8.8" && cfg.getString("dns") == "1.1.1.1")
    val source = JSONObject().put("servers", JSONArray()
        .put(JSONObject().put("tag", "remote").put("address", "tcp://192.0.2.53").put("detour", "vendor-head"))
        .put(JSONObject().put("tag", "special").put("address", "tcp://192.0.2.54").put("detour", "vendor-head")))
        .put("final", "remote").put("rules", JSONArray().put(
            JSONObject().put("domain_suffix", JSONArray().put("special.example.test")).put("server", "special")))
    val before = source.toString()
    val overridden = harness.overrideDns(source, "8.8.8.8", "actual-chain-group")
    check(source.toString() == before)
    val servers = overridden.getJSONArray("servers")
    check(servers.getJSONObject(0).getString("tag") == "remote")
    check(servers.getJSONObject(0).getString("address") == "tcp://8.8.8.8")
    check(servers.getJSONObject(0).getString("detour") == "actual-chain-group")
    check(servers.getJSONObject(1).toString() == source.getJSONArray("servers").getJSONObject(1).toString())
    check(overridden.getJSONArray("rules").toString() == source.getJSONArray("rules").toString())
    println("PASS connection DNS: exact SSH default/Google/custom/TLS/system settings, UDP refusal, source preservation and VLESS default-resolver override without rewriting DNS split rules")
}

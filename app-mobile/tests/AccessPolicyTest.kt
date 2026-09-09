package com.sxbvpn.vpnmodule

import org.json.JSONArray
import org.json.JSONObject

private var cases = 0
private fun checkCase(name: String, action: () -> Unit) {
    action()
    cases++
    println("PASS $name")
}
private fun rejected(action: () -> Unit) {
    var rejected = false
    try { action() } catch (_: IllegalArgumentException) { rejected = true }
    check(rejected) { "Invalid authority was accepted" }
}
private fun authority() = JSONObject("""{
  "userId":"u1","deviceId":"hardware","session":"session","sequence":0,
  "snapshot":null,"deviceIssue":null,"restrictions":[]
}""")
private fun snapshot(revision: String, device: String = "active", a: String = "active", b: String = "active") = JSONObject("""{
  "revision":"$revision","serverTime":"2026-09-09T00:00:00.000Z",
  "device":{"id":"client1","status":"$device","code":"DEVICE_${device.uppercase()}","expireAt":null,"activationRequired":false},
  "subscriptions":[
    {"id":"a","name":"Profile A","status":"$a","quotaTotalBytes":100,"quotaUsedBytes":5,"expireAt":null,"configVersion":1,"configHash":"shared-hash"},
    {"id":"b","name":"Profile B","status":"$b","quotaTotalBytes":100,"quotaUsedBytes":5,"expireAt":null,"configVersion":1,"configHash":"shared-hash"}
  ]
}""")
private val a = JSONObject("""{"configId":"a","subscriptionId":"a","source":"backend","configHash":"shared-hash"}""")
private val b = JSONObject("""{"configId":"b","subscriptionId":"b","source":"backend","configHash":"shared-hash"}""")
private val local = JSONObject("""{"configId":"manual","source":"manual","configHash":"manual-hash"}""")

fun main() {
    checkCase("first-bind migration and changed identities require a drained service, not stable sessions") {
        check(SxbAccessPolicy.bindingRequired(null, "u1", "hardware"))
        check(!SxbAccessPolicy.bindingRequired(authority(), "u1", "hardware"))
        check(SxbAccessPolicy.bindingRequired(authority(), "u2", "hardware"))
        check(SxbAccessPolicy.bindingRequired(authority(), "u1", "new-hardware"))
        rejected { SxbAccessPolicy.bindingRequired(null, "", "hardware") }
    }
    checkCase("active A revoked leaves active B and independent manual configuration") {
        val next = SxbAccessPolicy.applySnapshot(authority(), snapshot("r1", a = "revoked"), JSONArray().put(a).put(b).put(local))
        check(SxbAccessPolicy.block(next, a) == "CONFIG_REVOKED")
        check(SxbAccessPolicy.block(next, b) == null)
        check(SxbAccessPolicy.block(next, local) == null)
        check(SxbAccessPolicy.deviceBlock(next) == null)
    }
    checkCase("inactive B revoked never matches A even with the same payload hash") {
        val next = SxbAccessPolicy.applySnapshot(authority(), snapshot("r1", b = "revoked"), JSONArray().put(a).put(b))
        check(SxbAccessPolicy.block(next, a) == null)
        check(SxbAccessPolicy.block(next, b) == "CONFIG_REVOKED")
    }
    checkCase("unknown renamed reimport with known revoked hash remains blocked") {
        val next = SxbAccessPolicy.applySnapshot(authority(), snapshot("r1", a = "revoked"), JSONArray().put(a).put(b))
        check(SxbAccessPolicy.block(next, JSONObject("""{"configId":"reimport","source":"manual","configHash":"shared-hash"}""")) == "CONFIG_REVOKED")
    }
    for (status in listOf("suspended", "disabled", "expired", "revoked", "deleted")) {
        checkCase("device $status remains an identity-preserving block, then restores") {
            val blocked = SxbAccessPolicy.applySnapshot(authority(), snapshot("blocked", device = status), JSONArray().put(a).put(b))
            check(SxbAccessPolicy.block(blocked, a) == "DEVICE_${status.uppercase()}")
            val next = SxbAccessPolicy.applySnapshot(blocked, snapshot("restore"), JSONArray().put(a).put(b))
            check(SxbAccessPolicy.block(next, a) == null)
            check(next.getString("session") == "session" && next.getString("userId") == "u1")
        }
    }
    checkCase("config suspension retained and restored with exact subscription id") {
        val blocked = SxbAccessPolicy.applySnapshot(authority(), snapshot("r1", a = "suspended"), JSONArray().put(a).put(b))
        check(SxbAccessPolicy.profileBlock(blocked, a) == "CONFIG_SUSPENDED")
        check(SxbAccessPolicy.profileBlock(blocked, b) == null)
        val restored = SxbAccessPolicy.applySnapshot(blocked, snapshot("r2"), JSONArray().put(a).put(b))
        check(restored.getJSONArray("restrictions").length() == 0)
    }
    checkCase("expiry and quota remain advisory and extensions preserve identity") {
        val next = SxbAccessPolicy.applySnapshot(authority(), snapshot("r1", a = "expired", b = "exhausted"), JSONArray().put(a).put(b))
        check(SxbAccessPolicy.block(next, a) == null && SxbAccessPolicy.block(next, b) == null)
        val renewed = SxbAccessPolicy.applySnapshot(next, snapshot("r2"), JSONArray().put(a).put(b))
        check(renewed.getString("session") == "session")
    }
    checkCase("complete absence removes only backend entries") {
        val empty = snapshot("empty").put("subscriptions", JSONArray())
        val next = SxbAccessPolicy.applySnapshot(authority(), empty, JSONArray().put(a).put(local))
        check(SxbAccessPolicy.profileBlock(next, a) == "CONFIG_DELETED")
        check(SxbAccessPolicy.profileBlock(next, local) == null)
    }
    for (status in listOf("deleted", "revoked")) {
        checkCase("minimal device $status does not imply deletion of cached configurations") {
            val minimal = snapshot("minimal", device = status).put("subscriptions", JSONArray())
            minimal.getJSONObject("device").put("activationRequired", true)
            val next = SxbAccessPolicy.applySnapshot(authority(), minimal, JSONArray().put(a).put(b).put(local))
            check(SxbAccessPolicy.deviceBlock(next) == "DEVICE_${status.uppercase()}")
            check(next.getJSONArray("restrictions").length() == 0)
        }
    }
    checkCase("CAS sequence rejects stale HTTP and a previous identity session") {
        val next = SxbAccessPolicy.applySnapshot(authority(), snapshot("r1", a = "revoked"), JSONArray().put(a))
        check(!SxbAccessPolicy.accepts(next, "session", 0))
        check(!SxbAccessPolicy.accepts(next, "old-session", 1))
        check(SxbAccessPolicy.accepts(next, "session", 1))
    }
    checkCase("client id is distinct from identity user id and cannot silently change") {
        val first = SxbAccessPolicy.applySnapshot(authority(), snapshot("r1"), JSONArray())
        val foreign = snapshot("r2")
        foreign.getJSONObject("device").put("id", "other-client")
        rejected { SxbAccessPolicy.applySnapshot(first, foreign, JSONArray()) }
    }
    checkCase("unknown states, duplicate IDs, invalid dates and negative quota reject atomically") {
        for (invalid in listOf(
            snapshot("r1", a = "random"),
            snapshot("r1").apply { getJSONArray("subscriptions").getJSONObject(0).put("quotaUsedBytes", -1) },
            snapshot("r1").apply { getJSONArray("subscriptions").getJSONObject(1).put("id", "a") },
            snapshot("r1").apply { getJSONObject("device").put("expireAt", "2026-99-99T00:00:00Z") },
        )) rejected { SxbAccessPolicy.snapshot(invalid) }
    }
    checkCase("origin pin rejects HTTP, credentials, redirects and a different API path") {
        val base = "https://vpnsxb.afrihall.com/api"
        check(SxbAccessPolicy.controlBase(base, base) == base)
        for (value in listOf("http://vpnsxb.afrihall.com/api", "https://evil.test/api",
            "https://u:secret@vpnsxb.afrihall.com/api", "$base?url=evil", "$base/../elsewhere")) {
            rejected { SxbAccessPolicy.controlBase(value, base) }
        }
    }
    checkCase("retry delay honors 429 and is bounded") {
        check(SxbAccessPolicy.retryDelay(0, "120", 0) == 120_000L)
        check(SxbAccessPolicy.retryDelay(100, "999999999", 0) == 300_000L)
        check(SxbAccessPolicy.retryDelay(0, "-1", 0) == 1000L)
    }
    checkCase("domain failures require scope and target; session ticket rejection is not a device block") {
        val ticket = JSONObject("""{"code":"SESSION_INVALID","scope":"session","temporary":false}""")
        val next = SxbAccessPolicy.applyIssue(authority(), ticket, JSONArray())
        check(SxbAccessPolicy.deviceBlock(next) == null)
        val block = JSONObject("""{"code":"CONFIG_SUSPENDED","scope":"subscription","temporary":true,"subscriptionId":"a"}""")
        check(SxbAccessPolicy.profileBlock(SxbAccessPolicy.applyIssue(next, block, JSONArray().put(a).put(b)), b) == null)
        rejected { SxbAccessPolicy.issue(JSONObject("""{"code":"DEVICE_DISABLED","scope":"subscription","temporary":true}""")) }
    }
    println("$cases access policy cases passed")
}

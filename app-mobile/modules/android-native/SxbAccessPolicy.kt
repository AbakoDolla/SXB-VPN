package com.sxbvpn.vpnmodule

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.text.ParsePosition
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/** Pure policy shared by the Android service and the JVM regression harness. */
object SxbAccessPolicy {
    private val deviceStatuses = setOf("active", "suspended", "disabled", "expired", "revoked", "deleted")
    private val profileStatuses = setOf("active", "suspended", "revoked", "deleted", "expired", "exhausted")
    private val blockedProfiles = setOf("suspended", "revoked", "deleted")

    fun dateMillis(value: String): Long {
        for (pattern in listOf("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", "yyyy-MM-dd'T'HH:mm:ssXXX")) {
            val format = SimpleDateFormat(pattern, Locale.US).apply {
                isLenient = false
                timeZone = TimeZone.getTimeZone("UTC")
            }
            val position = ParsePosition(0)
            val date = format.parse(value, position)
            if (date != null && position.index == value.length) return date.time
        }
        throw IllegalArgumentException("ACCESS_DATE_INVALID")
    }

    private fun identifier(value: Any?): String {
        require(value is String && value.isNotEmpty() && value.length <= 200 &&
            value.none { it <= ' ' || it == '\u007f' }) { "ACCESS_ID_INVALID" }
        return value
    }

    private fun date(value: Any?): Any {
        if (value === JSONObject.NULL) return JSONObject.NULL
        require(value is String) { "ACCESS_DATE_INVALID" }
        dateMillis(value)
        return value
    }

    private fun bytes(value: Any?): Long {
        require(value is Number && value.toDouble().isFinite() &&
            value.toDouble() >= 0 && value.toDouble() <= 9_007_199_254_740_991.0 &&
            value.toLong().toDouble() == value.toDouble()) { "ACCESS_QUOTA_INVALID" }
        return value.toLong()
    }

    fun safeName(value: String): String = value
        .replace(Regex("SXB-(?:USER|DATA)-[\\w-]+", RegexOption.IGNORE_CASE), "[...]")
        .replace(Regex("[\\x00-\\x1f\\x7f]"), " ").take(120)

    fun snapshot(raw: JSONObject): JSONObject {
        val revision = identifier(raw.get("revision"))
        val serverTime = raw.getString("serverTime")
        dateMillis(serverTime)
        val d = raw.getJSONObject("device")
        val status = d.get("status")
        require(status is String && status in deviceStatuses) { "ACCESS_DEVICE_INVALID" }
        require(d.get("code") == "DEVICE_${status.uppercase(Locale.ROOT)}" &&
            d.get("activationRequired") is Boolean) { "ACCESS_DEVICE_INVALID" }
        val device = JSONObject().put("id", identifier(d.get("id"))).put("status", status)
            .put("code", d.getString("code")).put("expireAt", date(d.get("expireAt")))
            .put("activationRequired", d.getBoolean("activationRequired"))
        val entries = raw.getJSONArray("subscriptions")
        require(entries.length() <= 10_000) { "ACCESS_SNAPSHOT_TOO_LARGE" }
        val ids = HashSet<String>()
        val profiles = JSONArray()
        for (index in 0 until entries.length()) {
            val entry = entries.getJSONObject(index)
            val id = identifier(entry.get("id"))
            val profileStatus = entry.get("status")
            require(ids.add(id) && profileStatus is String && profileStatus in profileStatuses &&
                entry.get("name") is String) { "ACCESS_PROFILE_INVALID" }
            val profile = JSONObject().put("id", id).put("name", safeName(entry.getString("name")))
                .put("status", profileStatus).put("quotaTotalBytes", bytes(entry.get("quotaTotalBytes")))
                .put("quotaUsedBytes", bytes(entry.get("quotaUsedBytes"))).put("expireAt", date(entry.get("expireAt")))
            if (entry.has("configVersion")) profile.put("configVersion", bytes(entry.get("configVersion")))
            if (entry.has("configHash")) profile.put("configHash", identifier(entry.get("configHash")))
            profiles.put(profile)
        }
        return JSONObject().put("revision", revision).put("serverTime", serverTime)
            .put("device", device).put("subscriptions", profiles)
    }

    fun issue(raw: JSONObject): JSONObject {
        val code = raw.getString("code")
        val scope = raw.getString("scope")
        val valid = when (scope) {
            "device" -> code.startsWith("DEVICE_") && code.removePrefix("DEVICE_").lowercase(Locale.ROOT) in deviceStatuses - "active"
            "subscription" -> code.startsWith("CONFIG_") && code.removePrefix("CONFIG_").lowercase(Locale.ROOT) in profileStatuses - "active"
            "session" -> code == "SESSION_INVALID"
            else -> false
        }
        require(valid && raw.get("temporary") is Boolean) { "ACCESS_ISSUE_INVALID" }
        return JSONObject().put("code", code).put("scope", scope).put("temporary", raw.getBoolean("temporary")).apply {
            if (scope == "subscription") put("subscriptionId", identifier(raw.get("subscriptionId")))
        }
    }

    fun profile(raw: JSONObject): JSONObject = JSONObject().apply {
        put("configId", identifier(raw.get("configId")))
        for (field in listOf("subscriptionId", "configHash")) {
            if (raw.has(field) && !raw.isNull(field) && raw.optString(field).isNotEmpty()) put(field, identifier(raw.get(field)))
        }
        put("source", if (raw.optString("source") == "backend" || raw.optBoolean("managedConfig")) "backend" else "manual")
        put("name", safeName(raw.optString("name", "")))
    }

    fun authority(raw: JSONObject): JSONObject {
        identifier(raw.get("userId"))
        identifier(raw.get("deviceId"))
        identifier(raw.get("session"))
        bytes(raw.get("sequence"))
        if (!raw.isNull("snapshot")) snapshot(raw.getJSONObject("snapshot"))
        if (!raw.isNull("deviceIssue")) require(issue(raw.getJSONObject("deviceIssue")).getString("scope") == "device")
        val restrictions = raw.getJSONArray("restrictions")
        for (index in 0 until restrictions.length()) {
            val entry = restrictions.getJSONObject(index)
            identifier(entry.get("id"))
            require(entry.getString("status") in blockedProfiles && entry.get("name") is String) { "ACCESS_CACHE_INVALID" }
            val hashes = entry.getJSONArray("hashes")
            for (hash in 0 until hashes.length()) identifier(hashes.get(hash))
        }
        return JSONObject(raw.toString())
    }

    fun accepts(authority: JSONObject, session: String, sequence: Long) =
        authority.getString("session") == session && authority.getLong("sequence") == sequence

    fun bindingRequired(current: JSONObject?, userId: String, deviceId: String): Boolean {
        identifier(userId)
        identifier(deviceId)
        return current == null || current.optString("userId") != userId || current.optString("deviceId") != deviceId
    }

    private fun restrictions(authority: JSONObject): LinkedHashMap<String, JSONObject> {
        val result = linkedMapOf<String, JSONObject>()
        val array = authority.getJSONArray("restrictions")
        for (index in 0 until array.length()) {
            val entry = array.getJSONObject(index)
            result[entry.getString("id")] = JSONObject(entry.toString())
        }
        return result
    }

    private fun addRestriction(
        map: MutableMap<String, JSONObject>, id: String, status: String, name: String, hashes: Collection<String>,
    ) {
        val allHashes = linkedSetOf<String>()
        map[id]?.getJSONArray("hashes")?.let { old ->
            for (index in 0 until old.length()) allHashes.add(old.getString(index))
        }
        allHashes.addAll(hashes.filter { it.isNotEmpty() })
        map[id] = JSONObject().put("id", id).put("status", status)
            .put("name", safeName(name)).put("hashes", JSONArray(allHashes.toList()))
    }

    fun applySnapshot(authority: JSONObject, incoming: JSONObject, local: JSONArray): JSONObject {
        val snapshot = snapshot(incoming)
        val previous = authority.optJSONObject("snapshot")
        require(previous == null || previous.getJSONObject("device").getString("id") ==
            snapshot.getJSONObject("device").getString("id")) { "ACCESS_CLIENT_MISMATCH" }
        val map = restrictions(authority)
        val candidates = linkedMapOf<String, Pair<String, String>>()
        previous?.getJSONArray("subscriptions")?.let { old ->
            for (index in 0 until old.length()) {
                val entry = old.getJSONObject(index)
                candidates[entry.getString("id")] = Pair(entry.getString("name"), entry.optString("configHash", ""))
            }
        }
        for (index in 0 until local.length()) {
            val raw = local.getJSONObject(index)
            val entry = profile(raw)
            if (raw.optString("source") == "backend" || (raw.optString("source") != "manual" && entry.has("subscriptionId"))) {
                val id = entry.optString("subscriptionId", entry.getString("configId"))
                candidates[id] = Pair(entry.optString("name", ""), entry.optString("configHash", ""))
            }
        }
        val entries = snapshot.getJSONArray("subscriptions")
        val remote = HashSet<String>()
        for (index in 0 until entries.length()) {
            val entry = entries.getJSONObject(index)
            val id = entry.getString("id")
            remote.add(id)
            if (entry.getString("status") !in blockedProfiles) map.remove(id)
            else addRestriction(map, id, entry.getString("status"), entry.getString("name"),
                listOf(entry.optString("configHash", ""), candidates[id]?.second ?: ""))
        }
        val device = snapshot.getJSONObject("device")
        val minimalDeviceSnapshot = entries.length() == 0 &&
            (device.getString("status") == "deleted" ||
                (device.getString("status") == "revoked" && device.getBoolean("activationRequired")))
        for ((id, candidate) in candidates) if (!minimalDeviceSnapshot && id !in remote) {
            addRestriction(map, id, "deleted", candidate.first, listOf(candidate.second))
        }
        return JSONObject(authority.toString()).put("snapshot", snapshot).put("deviceIssue", JSONObject.NULL)
            .put("sequence", authority.getLong("sequence") + 1).put("restrictions", JSONArray(map.values.toList()))
    }

    fun applyIssue(authority: JSONObject, incoming: JSONObject, local: JSONArray): JSONObject {
        val issue = issue(incoming)
        val next = JSONObject(authority.toString())
        if (issue.getString("scope") == "device") {
            return next.put("deviceIssue", issue).put("sequence", authority.getLong("sequence") + 1)
        }
        if (issue.getString("scope") != "subscription") return next
        val status = issue.getString("code").removePrefix("CONFIG_").lowercase(Locale.ROOT)
        if (status !in blockedProfiles) return next
        val id = issue.getString("subscriptionId")
        val map = restrictions(authority)
        val hashes = mutableListOf<String>()
        var name = ""
        val profiles = authority.optJSONObject("snapshot")?.getJSONArray("subscriptions")
        if (profiles != null) for (index in 0 until profiles.length()) {
            val entry = profiles.getJSONObject(index)
            if (entry.getString("id") == id) { name = entry.getString("name"); hashes.add(entry.optString("configHash", "")) }
        }
        for (index in 0 until local.length()) {
            val entry = profile(local.getJSONObject(index))
            if (entry.getString("configId") == id || entry.optString("subscriptionId") == id) {
                hashes.add(entry.optString("configHash", ""))
                if (name.isEmpty()) name = entry.optString("name", "")
            }
        }
        addRestriction(map, id, status, name, hashes)
        return next.put("sequence", authority.getLong("sequence") + 1).put("restrictions", JSONArray(map.values.toList()))
    }

    fun deviceBlock(authority: JSONObject): String? {
        authority.optJSONObject("deviceIssue")?.let { return it.getString("code") }
        val device = authority.optJSONObject("snapshot")?.getJSONObject("device") ?: return null
        return if (device.getString("status") != "active") device.getString("code")
            else if (device.getBoolean("activationRequired")) "DEVICE_DISABLED" else null
    }

    fun profileBlock(authority: JSONObject, config: JSONObject): String? {
        val configId = config.optString("configId", "")
        val subscriptionId = config.optString("subscriptionId", "")
        val hash = config.optString("configHash", "")
        val entries = authority.getJSONArray("restrictions")
        for (index in 0 until entries.length()) {
            val entry = entries.getJSONObject(index)
            val id = entry.getString("id")
            // Hash matching closes reimport bypasses only for unidentified/manual files.
            // Two separately managed subscriptions may intentionally use the same payload.
            var match = configId == id || (subscriptionId.isNotEmpty() && subscriptionId == id)
            if (!match && subscriptionId.isEmpty() && config.optString("source") != "backend" && !config.optBoolean("managedConfig") && hash.isNotEmpty()) {
                val hashes = entry.getJSONArray("hashes")
                for (j in 0 until hashes.length()) if (hashes.getString(j) == hash) match = true
            }
            if (match) return "CONFIG_${entry.getString("status").uppercase(Locale.ROOT)}"
        }
        return null
    }

    fun block(authority: JSONObject, config: JSONObject): String? = deviceBlock(authority) ?: profileBlock(authority, config)

    fun controlBase(requested: String, allowed: String): String {
        val uri = URI(requested)
        require(uri.scheme == "https" && uri.host != null && uri.userInfo == null && uri.query == null &&
            uri.fragment == null && requested.trimEnd('/') == allowed.trimEnd('/') &&
            uri.normalize() == uri) { "ACCESS_ORIGIN_INVALID" }
        return requested.trimEnd('/')
    }

    fun retryDelay(attempt: Int, retryAfter: String?, now: Long): Long {
        val seconds = retryAfter?.toLongOrNull()
        val header = if (seconds != null) seconds.coerceIn(0, 300) * 1000 else {
            val position = ParsePosition(0)
            val date = retryAfter?.let { SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss z", Locale.US).parse(it, position) }
            if (date == null) 0L else date.time - now
        }
        return maxOf(1000L shl attempt.coerceIn(0, 6), header).coerceIn(1000, 300_000)
    }
}

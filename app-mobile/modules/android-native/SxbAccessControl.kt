package com.sxbvpn.vpnmodule

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** Owns the CAS sequence for both JS and native HTTP responses. No business JWT is accepted here. */
object SxbAccessControl {
    const val BROADCAST = "com.sxbvpn.ACCESS_STATE"
    private const val PREFS = "sxb_access_control_v1"
    private var loaded = false
    private var authority: JSONObject? = null
    private var ticket: JSONObject? = null
    private var signedOut = false
    private var storageFailed = false
    private var observing = false
    private var observerOwner: String? = null
    private var ticketStatus = "missing"
    private var activeProfile: JSONObject? = null
    private var allowedAttempt: String? = null

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Synchronized
    private fun load(context: Context) {
        if (loaded) {
            check(!storageFailed) { "ACCESS_STORAGE_ERROR" }
            return
        }
        try {
            val storage = prefs(context)
            signedOut = storage.getBoolean("signedOut", false)
            authority = storage.getString("authority", null)?.let { SxbAccessPolicy.authority(JSONObject(KeystoreManager.decrypt(it))) }
            ticket = storage.getString("ticket", null)?.let { JSONObject(KeystoreManager.decrypt(it)) }
            allowedAttempt = storage.getString("attempt", null)
            loaded = true
            ticketStatus = if (ticket == null) "missing" else "ready"
        } catch (error: Exception) {
            storageFailed = true
            throw IllegalStateException("ACCESS_STORAGE_ERROR", error)
        }
    }

    private fun persist(context: Context, next: JSONObject) {
        // The in-memory guard also fails closed when Keystore/disk refuses a write.
        authority = next
        try {
            check(prefs(context).edit().putString("authority", KeystoreManager.encrypt(next.toString()))
                .putBoolean("signedOut", false).commit()) { "ACCESS_STORAGE_ERROR" }
        } catch (error: Exception) {
            storageFailed = true
            SxbVpnService.instance?.interruptForAccess()
            throw IllegalStateException("ACCESS_STORAGE_ERROR", error)
        }
    }

    @Synchronized
    fun bind(context: Context, userId: String, deviceId: String): String {
        check(SxbPrivacyPolicy.vpnAllowed(context)) { "PRIVACY_CONSENT_REQUIRED" }
        load(context)
        val old = authority
        if (SxbAccessPolicy.bindingRequired(old, userId, deviceId)) {
            check(SxbVpnService.getCurrentState() == "disconnected") { "ACCESS_STOP_REQUIRED" }
            val next = JSONObject().put("userId", userId).put("deviceId", deviceId)
                .put("session", UUID.randomUUID().toString()).put("sequence", 0)
                .put("snapshot", JSONObject.NULL).put("deviceIssue", JSONObject.NULL).put("restrictions", JSONArray())
            persist(context, next)
            ticket = null
            ticketStatus = "missing"
            check(prefs(context).edit().remove("ticket").commit()) { "ACCESS_STORAGE_ERROR" }
            signedOut = false
        }
        return runtime(context)
    }

    @Synchronized
    fun runtime(context: Context): String {
        load(context)
        return JSONObject().put("authority", authority ?: JSONObject.NULL)
            .put("observing", observing).put("ticketStatus", ticketStatus)
            .put("ticketExpiresAt", ticket?.opt("expiresAt") ?: JSONObject.NULL)
            .put("activeProfile", activeProfile ?: JSONObject.NULL).toString()
    }

    @Synchronized
    fun requestStamp(context: Context): Pair<String, Long>? {
        load(context)
        return authority?.let { Pair(it.getString("session"), it.getLong("sequence")) }
    }

    fun applySnapshot(context: Context, raw: JSONObject, local: JSONArray, session: String, sequence: Long): String {
        synchronized(this) {
            check(SxbPrivacyPolicy.vpnAllowed(context)) { "PRIVACY_CONSENT_REQUIRED" }
            load(context)
            val current = authority ?: return runtime(context)
            if (!SxbAccessPolicy.accepts(current, session, sequence)) return runtime(context)
            val profiles = JSONArray(local.toString())
            activeProfile?.let { profiles.put(it) }
            persist(context, SxbAccessPolicy.applySnapshot(current, raw, profiles))
        }
        enforce(context)
        signal(context)
        return runtime(context)
    }

    fun applyIssue(context: Context, raw: JSONObject, local: JSONArray, session: String, sequence: Long): String {
        synchronized(this) {
            check(SxbPrivacyPolicy.vpnAllowed(context)) { "PRIVACY_CONSENT_REQUIRED" }
            load(context)
            val current = authority ?: return runtime(context)
            if (!SxbAccessPolicy.accepts(current, session, sequence)) return runtime(context)
            val profiles = JSONArray(local.toString())
            activeProfile?.let { profiles.put(it) }
            persist(context, SxbAccessPolicy.applyIssue(current, raw, profiles))
        }
        enforce(context)
        signal(context)
        return runtime(context)
    }

    private fun enforce(context: Context) {
        val blocked = synchronized(this) {
            val current = authority
            current != null && (SxbAccessPolicy.deviceBlock(current) != null ||
                activeProfile?.let { SxbAccessPolicy.profileBlock(current, it) != null } == true)
        }
        if (blocked) SxbVpnService.instance?.stopForAccess()
        // The encrypted native restart file is a separate copy of the last profile.
        // Never erase B just because inactive A was revoked.
        val vault = File(context.filesDir, "sxb_creds.enc")
        if (vault.exists()) {
            val config = JSONObject(KeystoreManager.decrypt(vault.readText(Charsets.UTF_8)))
            val code = synchronized(this) { authority?.let { SxbAccessPolicy.profileBlock(it, config) } }
            if (code == "CONFIG_REVOKED" || code == "CONFIG_DELETED") {
                check(vault.delete() || !vault.exists()) { "ACCESS_CONFIG_PURGE_FAILED" }
            }
        }
    }

    @Synchronized
    fun checkStart(context: Context, config: JSONObject, checkAttempt: Boolean = true) {
        check(SxbPrivacyPolicy.vpnAllowed(context)) { "PRIVACY_CONSENT_REQUIRED" }
        load(context)
        check(!signedOut && !storageFailed) { "ACCESS_SESSION_REQUIRED" }
        val current = authority
        if (current != null) {
            check(config.optString("accessSession") == current.getString("session")) { "ACCESS_SESSION_CHANGED" }
            SxbAccessPolicy.block(current, config)?.let { throw IllegalStateException(it) }
            if (checkAttempt) check(allowedAttempt != null && config.optString("accessAttempt") == allowedAttempt) { "ACCESS_ATTEMPT_CANCELLED" }
        } else {
            // Pre-upgrade encrypted configs may exist before the first UI bind.
            check(!config.has("accessSession")) { "ACCESS_SESSION_REQUIRED" }
        }
    }

    @Synchronized
    fun prepareStart(context: Context, config: JSONObject): String {
        checkStart(context, config, checkAttempt = false)
        allowedAttempt = UUID.randomUUID().toString()
        check(prefs(context).edit().putString("attempt", allowedAttempt).commit()) { "ACCESS_STORAGE_ERROR" }
        return config.put("accessAttempt", allowedAttempt).toString()
    }

    @Synchronized
    fun cancelStarts(context: Context) {
        allowedAttempt = null
        check(prefs(context).edit().remove("attempt").commit()) { "ACCESS_STORAGE_ERROR" }
    }

    @Synchronized
    fun <T> guardedStart(context: Context, config: JSONObject, action: () -> T): T {
        checkStart(context, config)
        return action()
    }

    @Synchronized
    fun setActive(context: Context, config: JSONObject) {
        checkStart(context, config)
        activeProfile = if (config.optString("configId").isNotEmpty()) SxbAccessPolicy.profile(config) else null
    }

    @Synchronized
    fun setObserving(context: Context, value: Boolean, status: String? = null, owner: String? = null) {
        if (value && owner != null) observerOwner = owner
        if (owner != null && owner != observerOwner) return
        observing = value
        if (status != null) ticketStatus = status
        signal(context)
    }

    private fun allowedBase(context: Context): String = context.packageManager.getApplicationInfo(
        context.packageName, PackageManager.GET_META_DATA,
    ).metaData?.getString("com.sxbvpn.api_base_url") ?: "https://vpnsxb.afrihall.com/api"

    @Synchronized
    fun setTicket(context: Context, base: String, value: String, expiresAt: String, session: String) {
        check(SxbPrivacyPolicy.vpnAllowed(context)) { "PRIVACY_CONSENT_REQUIRED" }
        load(context)
        val current = authority ?: throw IllegalStateException("ACCESS_SESSION_REQUIRED")
        check(current.getString("session") == session) { "ACCESS_SESSION_CHANGED" }
        val endpoint = SxbAccessPolicy.controlBase(base, allowedBase(context))
        val deadline = SxbAccessPolicy.dateMillis(expiresAt)
        require(value.isNotEmpty() && value.length <= 8192 && !value.any { it <= ' ' } &&
            deadline > System.currentTimeMillis() && deadline <= System.currentTimeMillis() + 7 * 86_400_000L + 60_000L) { "ACCESS_TICKET_INVALID" }
        val next = JSONObject().put("base", endpoint).put("ticket", value).put("expiresAt", expiresAt)
            .put("session", session).put("userId", current.getString("userId")).put("deviceId", current.getString("deviceId"))
        check(prefs(context).edit().putString("ticket", KeystoreManager.encrypt(next.toString())).commit()) { "ACCESS_STORAGE_ERROR" }
        ticket = next
        ticketStatus = "ready"
    }

    @Synchronized
    fun readTicket(context: Context): JSONObject? {
        load(context)
        if (!SxbPrivacyPolicy.vpnAllowed(context) || signedOut) return null
        val current = authority ?: return null
        val value = ticket ?: return null
        if (value.getString("session") != current.getString("session") ||
            value.getString("userId") != current.getString("userId") || value.getString("deviceId") != current.getString("deviceId")) {
            invalidateTicket(context, "invalid")
            return null
        }
        SxbAccessPolicy.controlBase(value.getString("base"), allowedBase(context))
        if (SxbAccessPolicy.dateMillis(value.getString("expiresAt")) <= System.currentTimeMillis()) {
            invalidateTicket(context, "expired")
            return null
        }
        return JSONObject(value.toString())
    }

    @Synchronized
    fun invalidateTicket(context: Context, status: String) {
        ticket = null
        ticketStatus = status
        check(prefs(context).edit().remove("ticket").commit()) { "ACCESS_STORAGE_ERROR" }
        signal(context)
    }

    fun clear(context: Context) {
        synchronized(this) {
            signedOut = true
            authority = null
            ticket = null
            ticketStatus = "missing"
            loaded = true
            allowedAttempt = null
            check(prefs(context).edit().remove("authority").remove("ticket").remove("attempt").putBoolean("signedOut", true).commit()) { "ACCESS_STORAGE_ERROR" }
        }
        SxbVpnService.instance?.stopForAccess()
        signal(context)
    }

    fun withdraw(context: Context) {
        SxbVpnService.instance?.stopAccessObserver()
        synchronized(this) { load(context); invalidateTicket(context, "missing") }
    }

    @Synchronized
    fun stopped(context: Context) {
        observing = false
        observerOwner = null
        activeProfile = null
        signal(context)
    }

    private fun signal(context: Context) {
        context.sendBroadcast(Intent(BROADCAST).setPackage(context.packageName).apply {
            putExtra("session", authority?.optString("session", "") ?: "")
            putExtra("sequence", authority?.optLong("sequence", 0) ?: 0)
        })
    }
}

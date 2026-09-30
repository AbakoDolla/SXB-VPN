package com.sxbvpn.vpnmodule

import android.content.Context
import android.net.VpnService
import org.json.JSONObject

/** A permission loss survives process death; only an explicit UI grant can clear it. */
object SxbVpnPermission {
    private const val PREFS = "sxb_vpn_permission_v1"
    private const val GENERATION = "vpnPermissionGeneration"
    private var storageFailed = false
    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Synchronized
    fun acknowledge(context: Context) {
        check(VpnService.prepare(context) == null) { "VPN_PERMISSION_REQUIRED" }
        check(!storageFailed) { "VPN_PERMISSION_STORAGE_FAILED" }
        val storage = prefs(context)
        val generation = storage.getLong(GENERATION, 0)
        check(generation in 0 until Long.MAX_VALUE) { "VPN_PERMISSION_STORAGE_FAILED" }
        if (!storage.edit().putLong(GENERATION, generation + 1).putBoolean("blocked", false).commit()) {
            storageFailed = true
            throw IllegalStateException("VPN_PERMISSION_STORAGE_FAILED")
        }
    }

    @Synchronized
    fun stamp(context: Context, config: JSONObject) {
        check(!storageFailed) { "VPN_PERMISSION_STORAGE_FAILED" }
        val storage = prefs(context)
        check(!storage.getBoolean("blocked", false) && VpnService.prepare(context) == null) {
            "VPN_PERMISSION_REQUIRED"
        }
        config.put(GENERATION, storage.getLong(GENERATION, 0))
    }

    @Synchronized
    fun checkStart(context: Context, config: JSONObject) {
        check(!storageFailed) { "VPN_PERMISSION_STORAGE_FAILED" }
        val storage = prefs(context)
        check(!storage.getBoolean("blocked", false) && VpnService.prepare(context) == null &&
            config.optLong(GENERATION, 0) == storage.getLong(GENERATION, 0)) {
            "VPN_PERMISSION_REQUIRED"
        }
    }

    @Synchronized
    fun revoke(context: Context, config: JSONObject?): Boolean {
        check(!storageFailed) { "VPN_PERMISSION_STORAGE_FAILED" }
        if (VpnService.prepare(context) == null) return false
        val storage = prefs(context)
        if (config != null && config.optLong(GENERATION, 0) != storage.getLong(GENERATION, 0)) return false
        if (!storage.edit().putBoolean("blocked", true).commit()) {
            storageFailed = true
            throw IllegalStateException("VPN_PERMISSION_STORAGE_FAILED")
        }
        return true
    }
}

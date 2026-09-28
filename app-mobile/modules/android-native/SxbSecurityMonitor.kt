package com.sxbvpn.vpnmodule

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Minimal durable events. No credentials, profiles, packet contents or package inventory. */
object SxbSecurityMonitor {
    private const val PREFS = "sxb_security_events_v1"
    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    @Synchronized fun pending(context: Context): String {
        val raw = prefs(context).getString("events", null) ?: return "[]"
        return KeystoreManager.decrypt(raw)
    }
    private fun write(context: Context, events: JSONArray) {
        check(prefs(context).edit().putString("events", KeystoreManager.encrypt(events.toString())).commit()) {
            "SECURITY_EVENT_STORAGE_FAILED"
        }
    }
    @Synchronized fun record(context: Context, type: String, config: String?) {
        try {
            val profile = if (config.isNullOrBlank()) JSONObject() else JSONObject(config)
            val events = JSONArray(pending(context))
            if (events.length() >= 100) {
                Log.w("SXB-Security", "SECURITY_EVENT_QUEUE_FULL")
                if (type != "VPN_REVOKED") return
                val disposable = (0 until events.length()).firstOrNull {
                    events.getJSONObject(it).optString("eventType") != "VPN_REVOKED"
                } ?: 0
                events.remove(disposable)
            }
            val event = JSONObject().put("id", UUID.randomUUID().toString()).put("eventType", type)
                .put("timestamp", System.currentTimeMillis())
            for (key in listOf("securitySessionId", "securityGeneration", "securityClientId", "connectionId", "usageSessionId", "accessAttempt")) {
                if (profile.has(key)) event.put(key, profile.get(key))
            }
            events.put(event)
            write(context, events)
        } catch (error: Exception) {
            Log.e("SXB-Security", "SECURITY_EVENT_STORAGE_FAILED")
        }
    }
    @Synchronized fun acknowledge(context: Context, ids: JSONArray) {
        val accepted = (0 until ids.length()).map { ids.getString(it) }.toSet()
        val events = JSONArray(pending(context))
        val remaining = JSONArray()
        for (i in 0 until events.length()) {
            val event = events.getJSONObject(i)
            if (event.getString("id") !in accepted) remaining.put(event)
        }
        write(context, remaining)
    }
}

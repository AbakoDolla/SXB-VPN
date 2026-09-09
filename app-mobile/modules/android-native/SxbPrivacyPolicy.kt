package com.sxbvpn.vpnmodule

import android.content.Context
import android.content.ComponentName
import android.content.pm.PackageManager
import org.json.JSONObject

object SxbPrivacyPolicy {
    const val VERSION = 1
    private const val PREFS = "sxb_privacy_consent"
    private var stoppingService: SxbVpnService? = null
    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun distribution(context: Context): String {
        val marker = context.packageManager.getApplicationInfo(
            context.packageName, PackageManager.GET_META_DATA,
        ).metaData?.getString("com.sxbvpn.distribution") ?: "direct"
        return if (marker == "direct") "direct" else "play"
    }

    fun isPlay(context: Context) = distribution(context) == "play"
    fun vpnAllowed(context: Context): Boolean = !isPlay(context) || prefs(context).let {
        it.getInt("version", 0) == VERSION && it.getBoolean("vpn", false) && !it.getBoolean("revoking", false)
    }
    fun diagnosticsAllowed(context: Context) = !isPlay(context) ||
        (vpnAllowed(context) && prefs(context).getBoolean("diagnostics", false))
    fun notificationsAllowed(context: Context) = !isPlay(context) ||
        (vpnAllowed(context) && prefs(context).getBoolean("notifications", false))
    fun syncPushComponents(context: Context) {
        val play = isPlay(context)
        val enabled = notificationsAllowed(context)
        val components = listOf(
            "com.sxbvpn.vpnmodule.SxbFirebaseMessagingService",
            "com.google.firebase.messaging.FirebaseMessagingService",
            "com.google.firebase.iid.FirebaseInstanceIdReceiver",
        )
        // Open the receiver last; close it first. The manifest starts disabled.
        for (name in if (enabled) components else components.reversed()) {
            context.packageManager.setComponentEnabledSetting(
                ComponentName(context.packageName, name),
                if (!play) PackageManager.COMPONENT_ENABLED_STATE_DEFAULT
                else if (enabled) PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                else PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                PackageManager.DONT_KILL_APP,
            )
        }
    }
    fun read(context: Context): String = JSONObject().apply {
        put("version", VERSION)
        put("vpn", vpnAllowed(context))
        put("diagnostics", diagnosticsAllowed(context))
        put("notifications", notificationsAllowed(context))
    }.toString()

    @Synchronized
    fun stopVpnForPrivacy() {
        val service = stoppingService ?: SxbVpnService.instance ?: return
        // Retain the service across retries even if Android calls onDestroy.
        stoppingService = service
        service.stopForPrivacy()
        stoppingService = null
    }

    @Synchronized
    fun save(context: Context, vpn: Boolean, diagnostics: Boolean, notifications: Boolean): String {
        check(isPlay(context)) { "PRIVACY_PLAY_ONLY" }
        val storage = prefs(context)
        // Durable start barrier survives process death during withdrawal.
        // The recorded consent is changed only after the tunnel really stops.
        if (!vpn || storage.getBoolean("revoking", false) || stoppingService != null) {
            check(storage.edit().putBoolean("revoking", true).commit()) { "PRIVACY_STORAGE_ERROR" }
            stopVpnForPrivacy()
        }
        check(storage.edit()
            .putInt("version", VERSION).putBoolean("vpn", vpn)
            .putBoolean("diagnostics", vpn && diagnostics)
            .putBoolean("notifications", vpn && notifications)
            .putBoolean("revoking", false).commit()) { "PRIVACY_STORAGE_ERROR" }
        if (!vpn || !diagnostics) SxbSecureLogger.setDiagnosticEnabled(context, false)
        syncPushComponents(context)
        return read(context)
    }
}

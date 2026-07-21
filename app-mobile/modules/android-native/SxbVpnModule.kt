package com.sxbvpn.vpnmodule

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.VpnService
import android.os.Build
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * SxbVpnModule — Bridge React Native ↔ SxbVpnService v4
 *
 * Méthodes exposées à JavaScript :
 *  - requestVpnPermission()  → Promise<boolean>
 *  - isVpnPermissionGranted()→ boolean (sync)
 *  - startVpn(json)          → Promise<void>
 *  - stopVpn()               → Promise<void>
 *  - getVpnState()           → Promise<string>
 *  - getTrafficStats()       → Promise<object>
 *  - setKillSwitch(bool)     → void
 *  - setAutoReconnect(bool)  → void
 *  - checkSecurity()         → Promise<object>
 */
class SxbVpnModule(reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext), ActivityEventListener {

    companion object {
        private const val VPN_REQUEST_CODE = 0x0F4C
    }

    private var vpnPermissionPromise: Promise? = null
    private var statusReceiver: BroadcastReceiver? = null
    private var logReceiver: BroadcastReceiver? = null

    init { reactContext.addActivityEventListener(this) }

    override fun getName() = "SxbVpnNative"

    override fun initialize() { super.initialize(); registerReceivers() }
    override fun invalidate()  { super.invalidate();  unregisterReceivers() }

    // ── JS EventEmitter boilerplate ───────────────────────────────────────────
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}

    // ── requestVpnPermission ──────────────────────────────────────────────────
    @ReactMethod
    fun requestVpnPermission(promise: Promise) {
        try {
            val ctx = reactApplicationContext
            val vpnIntent = VpnService.prepare(ctx)
            if (vpnIntent == null) { promise.resolve(true); return }

            val activity = reactApplicationContext.currentActivity
            if (activity == null) { promise.resolve(false); return }

            vpnPermissionPromise = promise
            activity.startActivityForResult(vpnIntent, VPN_REQUEST_CODE)
        } catch (e: Exception) {
            promise.reject("PERMISSION_ERROR", e.message ?: "Erreur permission VPN", e)
        }
    }

    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == VPN_REQUEST_CODE) {
            vpnPermissionPromise?.resolve(resultCode == Activity.RESULT_OK)
            vpnPermissionPromise = null
        }
    }

    override fun onNewIntent(intent: Intent) {}

    // ── isVpnPermissionGranted (synchrone) ────────────────────────────────────
    @ReactMethod(isBlockingSynchronousMethod = true)
    fun isVpnPermissionGranted(): Boolean {
        return try {
            VpnService.prepare(reactApplicationContext) == null
        } catch (_: Exception) { false }
    }

    // ── startVpn ─────────────────────────────────────────────────────────────
    /**
     * Démarre le service VPN.
     * @param optionsJson JSON.stringify({ protocol, host, port, ... , killSwitch, autoReconnect })
     */
    @ReactMethod
    fun startVpn(optionsJson: String, promise: Promise) {
        try {
            val ctx  = reactApplicationContext
            val opts = org.json.JSONObject(optionsJson)
            val proto = opts.optString("protocol", "").lowercase()

            // Vérification permission
            if (VpnService.prepare(ctx) != null) {
                promise.reject("NO_PERMISSION", "Permission VPN non accordée")
                return
            }

            val intent = Intent(ctx, SxbVpnService::class.java).apply {
                action = SxbVpnService.ACTION_START
                putExtra("configJson", optionsJson)
                putExtra("protocol",   proto)
                putExtra("killSwitch", opts.optBoolean("killSwitch", false))
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent)
            } else {
                ctx.startService(intent)
            }

            // Activer auto-reconnect si demandé
            if (opts.optBoolean("autoReconnect", false)) {
                SxbVpnService.instance?.autoReconnect?.enable()
            }

            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("START_ERROR", e.message ?: "Erreur démarrage VPN", e)
        }
    }

    // ── stopVpn ───────────────────────────────────────────────────────────────
    @ReactMethod
    fun stopVpn(promise: Promise) {
        try {
            val ctx = reactApplicationContext

            // Désactiver auto-reconnect d'abord
            SxbVpnService.instance?.autoReconnect?.disable()

            val intent = Intent(ctx, SxbVpnService::class.java).apply {
                action = SxbVpnService.ACTION_STOP
            }
            ctx.startService(intent)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("STOP_ERROR", e.message ?: "Erreur arrêt VPN", e)
        }
    }

    // ── getVpnState ───────────────────────────────────────────────────────────
    @ReactMethod
    fun getVpnState(promise: Promise) {
        promise.resolve(SxbVpnService.getCurrentState())
    }

    // ── getTrafficStats ───────────────────────────────────────────────────────
    @ReactMethod
    fun getTrafficStats(promise: Promise) {
        try {
            val service = SxbVpnService.instance
            val stats: Map<String, Long> = service?.getTrafficStats()
                ?: mapOf("uploadBytes" to 0L, "downloadBytes" to 0L,
                         "uploadSpeed" to 0L, "downloadSpeed" to 0L)

            val map = Arguments.createMap().apply {
                putDouble("uploadBytes",   stats["uploadBytes"]!!.toDouble())
                putDouble("downloadBytes", stats["downloadBytes"]!!.toDouble())
                putDouble("uploadSpeed",   stats["uploadSpeed"]!!.toDouble())
                putDouble("downloadSpeed", stats["downloadSpeed"]!!.toDouble())
            }
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("TRAFFIC_ERROR", e.message, e)
        }
    }

    // ── setKillSwitch ─────────────────────────────────────────────────────────
    @ReactMethod
    fun setKillSwitch(enabled: Boolean) {
        SxbVpnService.instance?.setKillSwitch(enabled)
    }

    // ── setAutoReconnect ──────────────────────────────────────────────────────
    @ReactMethod
    fun setAutoReconnect(enabled: Boolean) {
        val svc = SxbVpnService.instance
        if (enabled) svc?.autoReconnect?.enable()
        else         svc?.autoReconnect?.disable()
    }

    // ── checkSecurity ─────────────────────────────────────────────────────────
    @ReactMethod
    fun checkSecurity(promise: Promise) {
        try {
            val report = SecurityModule.audit(reactApplicationContext)
            val map = Arguments.createMap().apply {
                putBoolean("isRooted",   report.isRooted)
                putBoolean("hasFrida",   report.hasFrida)
                putBoolean("hasXposed",  report.hasXposed)
                putBoolean("isEmulator", report.isEmulator)
                putBoolean("isSafe",     report.isSafe)
            }
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("SECURITY_ERROR", e.message, e)
        }
    }

    // ── Helpers émission d'événements ────────────────────────────────────────
    private fun sendEvent(name: String, params: WritableMap?) {
        try {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(name, params)
        } catch (_: Exception) {}
    }

    // ── Broadcast receivers ───────────────────────────────────────────────────
    private fun registerReceivers() {
        val ctx = reactApplicationContext

        statusReceiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, i: Intent?) {
                val status = i?.getStringExtra("status") ?: return
                val p = Arguments.createMap().apply { putString("status", status) }
                sendEvent("onVpnStateChange", p)
            }
        }

        logReceiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, i: Intent?) {
                val log = i?.getStringExtra("log") ?: return
                val p = Arguments.createMap().apply { putString("message", log) }
                sendEvent("onVpnLog", p)
            }
        }

        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Context.RECEIVER_NOT_EXPORTED
        } else 0

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ctx.registerReceiver(statusReceiver, IntentFilter(SxbVpnService.BROADCAST_STATUS), flags)
            ctx.registerReceiver(logReceiver,    IntentFilter(SxbVpnService.BROADCAST_LOG),    flags)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            ctx.registerReceiver(statusReceiver, IntentFilter(SxbVpnService.BROADCAST_STATUS))
            @Suppress("UnspecifiedRegisterReceiverFlag")
            ctx.registerReceiver(logReceiver,    IntentFilter(SxbVpnService.BROADCAST_LOG))
        }
    }

    private fun unregisterReceivers() {
        try { reactApplicationContext.unregisterReceiver(statusReceiver) } catch (_: Exception) {}
        try { reactApplicationContext.unregisterReceiver(logReceiver)    } catch (_: Exception) {}
        statusReceiver = null
        logReceiver    = null
    }
}

package com.sxbvpn.vpnmodule

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.VpnService
import android.os.Build
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule

class SxbVpnModule(reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    private var statusReceiver: BroadcastReceiver? = null
    private var logReceiver: BroadcastReceiver? = null

    override fun getName() = "SxbVpnNative"

    override fun initialize() {
        super.initialize()
        registerReceivers()
    }

    override fun invalidate() {
        super.invalidate()
        unregisterReceivers()
    }

    // ── Required for JS EventEmitter ───────────────────────────────────────────
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}

    // ── startVpn(configJson, promise) ─────────────────────────────────────────
    @ReactMethod
    fun startVpn(configJson: String, promise: Promise) {
        try {
            val ctx = reactApplicationContext
            val vpnIntent = VpnService.prepare(ctx)
            if (vpnIntent != null) {
                promise.reject("VPN_PERMISSION_REQUIRED",
                    "L'autorisation VPN est requise. Accordez-la via les paramètres Android.")
                return
            }
            val intent = Intent(ctx, SxbVpnService::class.java).apply {
                action = SxbVpnService.ACTION_START
                putExtra(SxbVpnService.EXTRA_CONFIG, configJson)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent)
            } else {
                ctx.startService(intent)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("START_FAILED", e.message, e)
        }
    }

    // ── stopVpn(promise) ──────────────────────────────────────────────────────
    @ReactMethod
    fun stopVpn(promise: Promise) {
        try {
            val intent = Intent(reactApplicationContext, SxbVpnService::class.java).apply {
                action = SxbVpnService.ACTION_STOP
            }
            reactApplicationContext.startService(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("STOP_FAILED", e.message, e)
        }
    }

    // ── isVpnPermissionGranted() ──────────────────────────────────────────────
    @ReactMethod(isBlockingSynchronousMethod = true)
    fun isVpnPermissionGranted(): Boolean {
        return try {
            VpnService.prepare(reactApplicationContext) == null
        } catch (e: Exception) { false }
    }

    // ── getStatus() ───────────────────────────────────────────────────────────
    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getStatus(): String {
        return if (SxbVpnService.instance != null) "connected" else "disconnected"
    }

    // ── Event helpers ─────────────────────────────────────────────────────────
    private fun sendEvent(name: String, params: WritableMap) {
        if (reactApplicationContext.hasActiveReactInstance()) {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(name, params)
        }
    }

    // ── Broadcast receivers ───────────────────────────────────────────────────
    private fun registerReceivers() {
        val ctx = reactApplicationContext

        statusReceiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, i: Intent?) {
                val status = i?.getStringExtra("status") ?: return
                val p = Arguments.createMap(); p.putString("status", status)
                sendEvent("onVpnStatusChange", p)
            }
        }

        logReceiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, i: Intent?) {
                val log = i?.getStringExtra("log") ?: return
                val p = Arguments.createMap(); p.putString("message", log)
                sendEvent("onVpnLog", p)
            }
        }

        val sf = IntentFilter(SxbVpnService.BROADCAST_STATUS)
        val lf = IntentFilter(SxbVpnService.BROADCAST_LOG)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ctx.registerReceiver(statusReceiver, sf, Context.RECEIVER_NOT_EXPORTED)
            ctx.registerReceiver(logReceiver,   lf, Context.RECEIVER_NOT_EXPORTED)
        } else {
            ctx.registerReceiver(statusReceiver, sf)
            ctx.registerReceiver(logReceiver,   lf)
        }
    }

    private fun unregisterReceivers() {
        val ctx = reactApplicationContext
        try { statusReceiver?.let { ctx.unregisterReceiver(it) } } catch (_: Exception) {}
        try { logReceiver?.let   { ctx.unregisterReceiver(it) } } catch (_: Exception) {}
    }
}

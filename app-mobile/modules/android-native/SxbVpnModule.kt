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
 * SxbVpnModule — Bridge React Native ↔ SxbVpnService
 *
 * CORRECTIF CRITIQUE : requestVpnPermission utilise désormais startActivityForResult
 * via l'Activity courante au lieu de simplement rejeter la promise.
 * L'ActivityEventListener capte le résultat et résout la promise.
 */
class SxbVpnModule(reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext), ActivityEventListener {

    companion object {
        private const val VPN_REQUEST_CODE = 0x0F4C  // code arbitraire unique
    }

    /** Promise en attente de résolution lors de la demande de permission VPN */
    private var vpnPermissionPromise: Promise? = null

    private var statusReceiver: BroadcastReceiver? = null
    private var logReceiver: BroadcastReceiver? = null

    init {
        // S'enregistrer pour recevoir le résultat de la demande VPN
        reactContext.addActivityEventListener(this)
    }

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

    // ── requestVpnPermission(promise) — CORRECTIF PRINCIPAL ───────────────────
    /**
     * Demande la permission VPN Android en affichant la popup système.
     * Résout true si accordée, false si refusée.
     *
     * AVANT : rejetait avec une erreur sans jamais montrer la popup.
     * APRÈS : utilise startActivityForResult pour déclencher le dialog Android.
     */
    @ReactMethod
    fun requestVpnPermission(promise: Promise) {
        try {
            val ctx = reactApplicationContext

            // Vérifier si déjà accordée
            val vpnIntent = VpnService.prepare(ctx)
            if (vpnIntent == null) {
                // Permission déjà accordée
                promise.resolve(true)
                return
            }

            // Besoin de demander la permission via l'Activity
            val activity = reactApplicationContext.currentActivity
            if (activity == null) {
                // Pas d'Activity disponible — cas rare mais possible en background
                promise.resolve(false)
                return
            }

            // Stocker la promise pour la résoudre dans onActivityResult
            vpnPermissionPromise = promise

            // ▶ Affiche la popup VPN Android
            activity.startActivityForResult(vpnIntent, VPN_REQUEST_CODE)

        } catch (e: Exception) {
            promise.reject("PERMISSION_ERROR", e.message ?: "Erreur lors de la demande de permission VPN", e)
        }
    }

    // ── ActivityEventListener : capture le résultat de la popup VPN ───────────
    override fun onActivityResult(
        activity: Activity,
        requestCode: Int,
        resultCode: Int,
        data: Intent?
    ) {
        if (requestCode == VPN_REQUEST_CODE) {
            val granted = resultCode == Activity.RESULT_OK
            vpnPermissionPromise?.resolve(granted)
            vpnPermissionPromise = null
        }
    }

    override fun onNewIntent(intent: Intent) {
        // Non utilisé
    }

    // ── isVpnPermissionGranted() — vérification synchrone ─────────────────────
    @ReactMethod(isBlockingSynchronousMethod = true)
    fun isVpnPermissionGranted(): Boolean {
        return try {
            VpnService.prepare(reactApplicationContext) == null
        } catch (e: Exception) { false }
    }

    // ── startVpn(configJson, promise) ─────────────────────────────────────────
    @ReactMethod
    fun startVpn(configJson: String, promise: Promise) {
        try {
            val ctx = reactApplicationContext

            // Vérifier la permission AVANT de démarrer
            val vpnIntent = VpnService.prepare(ctx)
            if (vpnIntent != null) {
                // Permission non accordée — indiquer à JS de la demander d'abord
                promise.reject(
                    "VPN_PERMISSION_REQUIRED",
                    "La permission VPN Android est requise. Appelez requestVpnPermission() d'abord."
                )
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
            promise.reject("START_FAILED", e.message ?: "Échec du démarrage VPN", e)
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
            promise.reject("STOP_FAILED", e.message ?: "Échec de l'arrêt VPN", e)
        }
    }

    // ── getStatus() ───────────────────────────────────────────────────────────
    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getStatus(): String {
        return when {
            SxbVpnService.instance?.isRunning() == true -> "connected"
            else -> "disconnected"
        }
    }

    // ── getVpnState() ─────────────────────────────────────────────────────────
    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getVpnState(): String {
        return SxbVpnService.instance?.getCurrentState() ?: "disconnected"
    }

    // ── getTrafficStats() ─────────────────────────────────────────────────────
    @ReactMethod
    fun getTrafficStats(promise: Promise) {
        try {
            val map = Arguments.createMap()
            map.putDouble("uploadBytes",   SxbVpnService.uploadBytes.get().toDouble())
            map.putDouble("downloadBytes", SxbVpnService.downloadBytes.get().toDouble())
            map.putDouble("uploadSpeed",   0.0)
            map.putDouble("downloadSpeed", 0.0)
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("STATS_ERROR", e.message, e)
        }
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
                val p = Arguments.createMap()
                p.putString("status", status)
                sendEvent("onVpnStateChange", p)
            }
        }

        logReceiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, i: Intent?) {
                val log = i?.getStringExtra("log") ?: return
                val p = Arguments.createMap()
                p.putString("message", log)
                sendEvent("onVpnLog", p)
            }
        }

        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Context.RECEIVER_NOT_EXPORTED
        } else {
            0
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ctx.registerReceiver(statusReceiver, IntentFilter(SxbVpnService.BROADCAST_STATUS), flags)
            ctx.registerReceiver(logReceiver, IntentFilter(SxbVpnService.BROADCAST_LOG), flags)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            ctx.registerReceiver(statusReceiver, IntentFilter(SxbVpnService.BROADCAST_STATUS))
            @Suppress("UnspecifiedRegisterReceiverFlag")
            ctx.registerReceiver(logReceiver, IntentFilter(SxbVpnService.BROADCAST_LOG))
        }
    }

    private fun unregisterReceivers() {
        try { reactApplicationContext.unregisterReceiver(statusReceiver) } catch (_: Exception) {}
        try { reactApplicationContext.unregisterReceiver(logReceiver) } catch (_: Exception) {}
        statusReceiver = null
        logReceiver = null
    }
}

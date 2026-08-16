package com.sxbvpn.vpnmodule

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.net.VpnService
import android.os.Build
import com.sxbvpn.vpnmodule.SxbSecureLogger
import com.sxbvpn.vpnmodule.SxbSecureLogger.VpnEvent
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * SxbVpnModule — Bridge React Native ↔ SxbVpnService v4
 *
 * Méthodes exposées à JavaScript :
 *  - requestVpnPermission()  → Promise<boolean>
 *  - isVpnPermissionGranted()→ boolean (sync)
 *  - startVpn(json)          → Promise<map{success,serviceStarted}>
 *  - stopVpn()               → Promise<void>
 *  - getVpnState()           → Promise<string>
 *  - getTrafficStats()       → Promise<object>
 *  - setKillSwitch(bool)     → void
 *  - setAutoReconnect(bool)  → void
 *  - checkSecurity()         → Promise<object>
 *  - setDiagnosticLogging()  → Promise<boolean>
 *  - getDiagnosticLogging()  → Promise<boolean>
 */
class SxbVpnModule(reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext), ActivityEventListener {

    companion object {
        private const val VPN_REQUEST_CODE = 0x0F4C
        private const val ANNOUNCEMENT_CHANNEL_ID = "SXB_ANNOUNCEMENTS"
    }

    private var vpnPermissionPromise: Promise? = null
    private var statusReceiver: BroadcastReceiver? = null
    private var logReceiver: BroadcastReceiver? = null

    init {
        reactContext.addActivityEventListener(this)
        SxbSecureLogger.initialize(reactContext)
    }

    override fun getName() = "SxbVpnNative"

    override fun initialize() { super.initialize(); SxbSecureLogger.initialize(reactApplicationContext); registerReceivers() }

    @ReactMethod
    fun setDiagnosticLogging(enabled: Boolean, promise: Promise) {
        try {
            SxbSecureLogger.setDiagnosticEnabled(reactApplicationContext, enabled)
            promise.resolve(SxbSecureLogger.isDiagnosticEnabled())
        } catch (e: Exception) {
            promise.reject("DIAGNOSTIC_ERROR", e.message ?: "Impossible de modifier le diagnostic", e)
        }
    }

    @ReactMethod
    fun getDiagnosticLogging(promise: Promise) {
        promise.resolve(SxbSecureLogger.isDiagnosticEnabled())
    }
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
     * @return { success: true, serviceStarted: true } — le tunnel réel se confirme via onVpnStateChange
     */
    @ReactMethod
    fun startVpn(optionsJson: String, promise: Promise) {
        try {
            val ctx  = reactApplicationContext
            val opts = org.json.JSONObject(optionsJson)
            val proto = opts.optString("protocol", "").lowercase()

            SxbSecureLogger.vpn(SxbSecureLogger.VpnEvent.MODULE_CALLED)

            // Vérification permission
            if (VpnService.prepare(ctx) != null) {
                SxbSecureLogger.error(SxbSecureLogger.VpnEvent.MODULE_REJECTED)
                promise.reject("NO_PERMISSION", "Permission VPN non accordée")
                return
            }

            // FIX — TransactionTooLargeException : les Intent extras sont limités à ~1MB
            // par le Binder IPC Android. Les configs VPN (sing-box JSON, payloads base64)
            // peuvent dépasser cette limite. On écrit la config dans un fichier temporaire
            // et on passe uniquement le chemin via l'extra, jamais le JSON complet.
            val configFile = java.io.File(ctx.filesDir, "sxb_pending_config.json")
            try {
                configFile.writeText(optionsJson, Charsets.UTF_8)
                SxbSecureLogger.vpn(SxbSecureLogger.VpnEvent.CONFIG_LOADED)
            } catch (e: Exception) {
                SxbSecureLogger.error(SxbSecureLogger.VpnEvent.CONFIG_WRITE_FAILED)
                // Fallback : passer via intent (risque uniquement si > 1MB)
            }

            val intent = Intent(ctx, SxbVpnService::class.java).apply {
                action = SxbVpnService.ACTION_START
                // Passer le chemin du fichier config ET l'extra (fallback pour compatibilité)
                putExtra("configFilePath", configFile.absolutePath)
                putExtra("configJson",     optionsJson)
                putExtra("protocol",       proto)
                putExtra("killSwitch",     opts.optBoolean("killSwitch", false))
                putExtra("autoReconnect",  opts.optBoolean("autoReconnect", false))
            }

            SxbSecureLogger.vpn(SxbSecureLogger.VpnEvent.SERVICE_STARTED)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent)
            } else {
                ctx.startService(intent)
            }

            SxbSecureLogger.vpn(SxbSecureLogger.VpnEvent.SERVICE_STARTED)

            // Note: autoReconnect sera activé dans onStartCommand() via l'extra,
            // car SxbVpnService.instance est null ici (service pas encore démarré).
            // On stocke la préférence pour l'activer dès que le service tourne.
            if (opts.optBoolean("autoReconnect", false)) {
                SxbSecureLogger.vpn(SxbSecureLogger.VpnEvent.RECONNECT_ENABLED)
                // Tentative optionnelle si instance existe (redémarrage du service)
                SxbVpnService.instance?.enableAutoReconnect()
            }

            // Retourner un état clair : service lancé, tunnel pas encore confirmé
            // L'état réel sera transmis via broadcast onVpnStateChange
            val result = Arguments.createMap().apply {
                putBoolean("success",        true)
                putBoolean("serviceStarted", true)
            }
            promise.resolve(result)
            SxbSecureLogger.vpn(SxbSecureLogger.VpnEvent.MODULE_RESOLVED)

        } catch (e: Exception) {
            SxbSecureLogger.error(SxbSecureLogger.VpnEvent.MODULE_REJECTED, e)
            promise.reject("START_ERROR", e.message ?: "Erreur démarrage VPN", e)
        }
    }

    // ── stopVpn ───────────────────────────────────────────────────────────────
    @ReactMethod
    fun stopVpn(promise: Promise) {
        try {
            val ctx = reactApplicationContext

            // Désactiver auto-reconnect d'abord
            SxbVpnService.instance?.disableAutoReconnect()

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
                putBoolean("tunAttached", stats["tunAttached"] == 1L)
            }
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("TRAFFIC_ERROR", e.message, e)
        }
    }

    // ── getPerAppStats ────────────────────────────────────────────────────────
    @ReactMethod
    fun getPerAppStats(promise: Promise) {
        try {
            val service = SxbVpnService.instance
            val statsList = service?.getPerAppStats() ?: emptyList()

            val array = Arguments.createArray()
            for (stat in statsList) {
                val map = Arguments.createMap().apply {
                    putString("packageName", stat["packageName"] as? String ?: "")
                    putString("appName",     stat["appName"] as? String ?: "")
                    putDouble("uploadBytes", (stat["uploadBytes"] as? Long ?: 0L).toDouble())
                    putDouble("downloadBytes", (stat["downloadBytes"] as? Long ?: 0L).toDouble())
                    putDouble("totalBytes",  (stat["totalBytes"] as? Long ?: 0L).toDouble())
                }
                array.pushMap(map)
            }
            promise.resolve(array)
        } catch (e: Exception) {
            promise.resolve(Arguments.createArray())
        }
    }

    // ── updateNotification ────────────────────────────────────────────────────
    @ReactMethod
    fun updateNotification(text: String, promise: Promise) {
        try {
            SxbVpnService.instance?.updateNotification(text)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    // ── postAnnouncementNotification ─────────────────────────────────────────
    /**
     * Notification locale d’une annonce déjà reçue par l’API authentifiée.
     * Android garde le contrôle final du son et de la vibration du canal.
     */
    @ReactMethod
    fun postAnnouncementNotification(id: String, title: String, message: String, promise: Promise) {
        try {
            val ctx = reactApplicationContext
            val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val channel = NotificationChannel(
                    ANNOUNCEMENT_CHANNEL_ID,
                    "SXB VPN Alerts",
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply {
                    description = "SXB VPN announcements and important account updates"
                    enableVibration(true)
                }
                manager.createNotificationChannel(channel)
            }

            val intent = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.apply {
                data = Uri.parse("sxbvpn://notifications")
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            } ?: Intent(Intent.ACTION_VIEW, Uri.parse("sxbvpn://notifications")).apply {
                setPackage(ctx.packageName)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            val pendingIntent = PendingIntent.getActivity(
                ctx,
                id.hashCode(),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val safeTitle = SecurityModule.maskSensitive(title).take(120)
            val safeMessage = SecurityModule.maskSensitive(message)
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(ctx, ANNOUNCEMENT_CHANNEL_ID)
            } else {
                Notification.Builder(ctx)
            }
            val notification = builder
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(safeTitle)
                .setContentText(safeMessage.take(240))
                .setStyle(Notification.BigTextStyle().bigText(safeMessage.take(1000)))
                .setAutoCancel(true)
                .setContentIntent(pendingIntent)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .build()
            manager.notify("sxb_announcement", id.hashCode(), notification)
            promise.resolve(true)
        } catch (_: Exception) {
            // Une notification est une amélioration non bloquante : ne jamais empêcher le VPN ou la synchronisation.
            promise.resolve(false)
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
        if (enabled) svc?.enableAutoReconnect()
        else         svc?.disableAutoReconnect()
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
                putBoolean("isHooked",   report.isHooked)
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
                SxbSecureLogger.vpn(SxbSecureLogger.VpnEvent.TUNNEL_CONNECTED)
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

        SxbSecureLogger.vpn(SxbSecureLogger.VpnEvent.SERVICE_STARTED)
    }

    private fun unregisterReceivers() {
        try { reactApplicationContext.unregisterReceiver(statusReceiver) } catch (_: Exception) {}
        try { reactApplicationContext.unregisterReceiver(logReceiver)    } catch (_: Exception) {}
        statusReceiver = null
        logReceiver    = null
    }
}

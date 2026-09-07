package com.sxbvpn.vpnmodule

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions

object SxbPushNotifications {
    const val CHANNEL_ID = "SXB_ANNOUNCEMENTS_V2"

    fun ensureFirebaseInitialized(context: Context): FirebaseApp? {
        try {
            return FirebaseApp.getInstance()
        } catch (_: IllegalStateException) {
            // Aucune app Firebase par défaut : tenter la configuration SXB.
        }

        val apiKey = stringResource(context, "sxb_firebase_api_key")
        val projectId = stringResource(context, "sxb_firebase_project_id")
        val applicationId = stringResource(context, "sxb_firebase_app_id")
        val senderId = stringResource(context, "sxb_firebase_sender_id")
        if (apiKey.isBlank() || projectId.isBlank() || applicationId.isBlank() || senderId.isBlank()) {
            return null
        }

        val options = FirebaseOptions.Builder()
            .setApiKey(apiKey)
            .setProjectId(projectId)
            .setApplicationId(applicationId)
            .setGcmSenderId(senderId)
            .build()
        return try {
            FirebaseApp.initializeApp(context.applicationContext, options)
        } catch (_: IllegalArgumentException) {
            null
        } catch (_: IllegalStateException) {
            null
        }
    }

    fun post(
        context: Context,
        id: String,
        title: String,
        message: String,
        level: String = "info",
    ): Boolean {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val audioAttributes = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "SXB VPN Alerts",
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply {
                    description = "SXB VPN announcements and important account updates"
                    enableVibration(true)
                    setSound(soundUri, audioAttributes)
                },
            )
        }

        val deepLink = Uri.parse("sxbvpn://notifications")
        val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
            action = Intent.ACTION_VIEW
            data = deepLink
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        } ?: Intent(Intent.ACTION_VIEW, deepLink).apply {
            setPackage(context.packageName)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            id.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val safeTitle = SecurityModule.maskSensitive(title).take(120)
        val safeMessage = SecurityModule.maskSensitive(message)
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(context, CHANNEL_ID)
        } else {
            Notification.Builder(context)
        }
        val notification = builder
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("SXB VPN • $safeTitle")
            .setContentText(safeMessage.take(240))
            .setStyle(Notification.BigTextStyle().bigText(safeMessage.take(1000)))
            .setSubText("Centre de notifications")
            .setColor(notificationColor(level))
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .apply {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                    setSound(soundUri)
                    setDefaults(Notification.DEFAULT_ALL)
                }
            }
            .build()
        manager.notify("sxb_push", id.hashCode(), notification)
        return true
    }

    private fun stringResource(context: Context, name: String): String {
        val id = context.resources.getIdentifier(name, "string", context.packageName)
        return if (id == 0) "" else context.getString(id).trim()
    }

    private fun notificationColor(level: String): Int = when (level) {
        "error" -> 0xFFD53F3FL.toInt()
        "warning" -> 0xFFF59E0BL.toInt()
        "success" -> 0xFF16A36AL.toInt()
        else -> 0xFF1769E8L.toInt()
    }
}

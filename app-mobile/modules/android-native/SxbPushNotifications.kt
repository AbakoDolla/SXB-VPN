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
    /**
     * Canal des nouvelles du tableau de bord.
     *
     * ═══════════════════════════════════════════════════════════════════════
     * POURQUOI L'IDENTIFIANT EST VERSIONNÉ
     * ═══════════════════════════════════════════════════════════════════════
     * Android REFUSE de relever l'importance d'un canal déjà créé : c'est un
     * réglage qui appartient à l'utilisateur, et `createNotificationChannel`
     * sur un identifiant existant n'a aucun effet sur ce point.
     *
     * Le canal V2 était en `IMPORTANCE_DEFAULT` : la notification sonnait et
     * se rangeait dans le volet, mais ne s'affichait JAMAIS par-dessus
     * l'écran. Se contenter de changer l'importance dans le code aurait donc
     * corrigé la prochaine installation — et personne d'autre.
     */
    const val CHANNEL_ID = "SXB_ANNOUNCEMENTS_V3"

    /** Supprimé au premier envoi : sinon il resterait dans les réglages, vide. */
    private const val LEGACY_CHANNEL_ID = "SXB_ANNOUNCEMENTS_V2"

    /**
     * Étiquette commune aux deux chemins de livraison.
     *
     * Une nouvelle peut arriver poussée par le serveur, ou relevée par
     * l'application au premier plan. Avec deux étiquettes distinctes, la même
     * nouvelle apportée par les deux apparaissait EN DOUBLE dans le volet.
     */
    private const val NOTIFICATION_TAG = "sxb_alerte"

    fun ensureFirebaseInitialized(context: Context): FirebaseApp? {
        if (!SxbPrivacyPolicy.notificationsAllowed(context)) return null
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
        if (!SxbPrivacyPolicy.notificationsAllowed(context)) return false
        // Les avis de MISE À JOUR passent désormais : le canal Play les
        // taisait, la boutique s'en chargeant. Sans elle, c'est le seul
        // message qui apprend à l'appareil qu'une version existe.
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
                    // `IMPORTANCE_HIGH` déclenche le bandeau flottant : le
                    // message s'affiche PAR-DESSUS l'écran et se balaie pour
                    // être écarté. En `DEFAULT`, il n'apparaissait que dans le
                    // volet — donc seulement si l'utilisateur pensait à le
                    // dérouler.
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply {
                    description = "SXB VPN announcements and important account updates"
                    enableVibration(true)
                    setSound(soundUri, audioAttributes)
                },
            )
            runCatching { manager.deleteNotificationChannel(LEGACY_CHANNEL_ID) }
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
                    // Avant Oreo, les canaux n'existent pas : c'est la priorité
                    // de la notification elle-même qui décide du bandeau.
                    setPriority(Notification.PRIORITY_HIGH)
                    setSound(soundUri)
                    setDefaults(Notification.DEFAULT_ALL)
                }
            }
            .build()
        // Étiquette COMMUNE aux deux chemins de livraison — poussée par le
        // serveur, ou relevée par l'application au premier plan. Avec deux
        // étiquettes distinctes, une même nouvelle apportée par les deux
        // apparaissait EN DOUBLE dans le volet.
        manager.notify(NOTIFICATION_TAG, id.hashCode(), notification)
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

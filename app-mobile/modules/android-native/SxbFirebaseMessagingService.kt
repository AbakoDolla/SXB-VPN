package com.sxbvpn.vpnmodule

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class SxbFirebaseMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        super.onNewToken(token)
        // Le jeton n'est ni journalisé ni envoyé sans JWT. Le prochain passage
        // au premier plan le transmettra via l'API mobile authentifiée.
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        if (data["screen"] != "notifications") return
        val id = data["notificationId"]?.takeIf { it.isNotBlank() } ?: message.messageId ?: return
        val title = data["title"]?.takeIf { it.isNotBlank() } ?: "Notification"
        val body = data["body"]?.takeIf { it.isNotBlank() } ?: return
        SxbPushNotifications.post(
            applicationContext,
            id,
            title,
            body,
            data["level"] ?: "info",
        )
    }
}

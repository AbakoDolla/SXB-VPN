package com.sxbvpn.vpnmodule

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            // Ne pas démarrer le VPN automatiquement au boot.
            // L'utilisateur doit initier la connexion manuellement depuis l'app.
            Log.i("SXB-BootReceiver", "Boot completed — VPN auto-start disabled (manual connect only)")
        }
    }
}

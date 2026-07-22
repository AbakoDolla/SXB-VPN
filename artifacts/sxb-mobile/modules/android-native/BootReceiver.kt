package com.sxbvpn.vpnmodule

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            Log.i("SXB-BootReceiver", "Boot completed detected. Attempting to restart VPN...")
            val serviceIntent = Intent(context, SxbVpnService::class.java).apply {
                action = SxbVpnService.ACTION_START
            }
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(serviceIntent)
                } else {
                    context.startService(serviceIntent)
                }
            } catch (e: Exception) {
                Log.e("SXB-BootReceiver", "Failed to start VPN service on boot", e)
            }
        }
    }
}

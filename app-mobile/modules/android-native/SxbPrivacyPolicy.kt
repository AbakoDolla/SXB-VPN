package com.sxbvpn.vpnmodule

import android.content.Context
import android.content.ComponentName
import android.content.pm.PackageManager
import org.json.JSONObject

/**
 * SxbPrivacyPolicy — autorisations de l'application, canal direct uniquement.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CE QUI A ÉTÉ RETIRÉ, ET POURQUOI
 * ═══════════════════════════════════════════════════════════════════════════
 * Ce module distinguait auparavant deux canaux de distribution, lus dans un
 * marqueur du manifeste : « direct » et « play ». Le second imposait un
 * consentement explicite avant toute connexion, et surtout il commandait une
 * PORTE DE CHIFFREMENT (`SxbPlayEncryption`) qui refusait en bloc toute
 * configuration VLESS, Trojan, Hysteria2 ou TUIC sans TLS vérifié, VMess sans
 * chiffrement reconnu, Shadowsocks sans AEAD, et toute configuration chaînée.
 *
 * C'est précisément ce qui faisait qu'une même configuration V2Ray marchait
 * chez un utilisateur et pas chez un autre : non pas la personne, mais le
 * BUILD qu'elle avait installé.
 *
 * SXB ne publie plus sur Google Play. Le canal a donc été retiré plutôt que
 * désactivé : laisser un interrupteur aurait laissé la possibilité qu'un build
 * le réactive par accident, et le défaut reviendrait sans prévenir.
 *
 * Les trois fonctions d'autorisation subsistent, et rendent toujours `true`.
 * C'est délibéré : leurs appelants — service VPN, notifications, journaux —
 * gardent ainsi leur point de contrôle en place, prêt à porter une règle
 * future, sans qu'il faille les retrouver un par un.
 */
object SxbPrivacyPolicy {
    const val VERSION = 1

    /** Canal unique. Le marqueur de manifeste n'est plus lu. */
    fun distribution(context: Context): String = "direct"

    fun vpnAllowed(context: Context): Boolean = true
    fun diagnosticsAllowed(context: Context): Boolean = true
    fun notificationsAllowed(context: Context): Boolean = true

    /**
     * Rétablit les composants de notification dans leur état par défaut.
     *
     * Le manifeste les déclare désactivés — héritage de Play, où rien ne
     * devait s'initialiser avant le consentement. Sans consentement à
     * attendre, ils sont remis à l'état que le manifeste prévoit, ce que le
     * canal direct faisait déjà.
     */
    fun syncPushComponents(context: Context) {
        val components = listOf(
            "com.sxbvpn.vpnmodule.SxbFirebaseMessagingService",
            "com.google.firebase.messaging.FirebaseMessagingService",
            "com.google.firebase.iid.FirebaseInstanceIdReceiver",
        )
        for (name in components) {
            context.packageManager.setComponentEnabledSetting(
                ComponentName(context.packageName, name),
                PackageManager.COMPONENT_ENABLED_STATE_DEFAULT,
                PackageManager.DONT_KILL_APP,
            )
        }
    }

    fun read(context: Context): String = JSONObject().apply {
        put("version", VERSION)
        put("vpn", true)
        put("diagnostics", true)
        put("notifications", true)
    }.toString()

    /**
     * Le tunnel ne s'arrête plus pour un retrait de consentement — il n'y a
     * plus de consentement à retirer. Conservée pour les appelants existants.
     */
    @Synchronized
    fun stopVpnForPrivacy() {
        SxbVpnService.instance?.stopForPrivacy()
    }

    /**
     * Enregistrer un consentement n'a plus de sens : il est acquis.
     *
     * L'appel ÉCHOUE au lieu de ne rien faire — un écran qui tenterait encore
     * de retirer l'accord doit le découvrir bruyamment, plutôt que de laisser
     * croire à un retrait sans effet.
     */
    @Synchronized
    fun save(context: Context, vpn: Boolean, diagnostics: Boolean, notifications: Boolean): String {
        throw IllegalStateException("PRIVACY_CONSENT_IMMUTABLE")
    }
}

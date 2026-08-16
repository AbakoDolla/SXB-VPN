package com.sxbvpn.vpnmodule

/**
 * SxbSecureLogger — Logger sécurisé pour SXB VPN
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * RÈGLES DE SÉCURITÉ
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * PAR DÉFAUT (release) :
 *   — Les logs structurés sont silencieux et les diagnostics UI masquent les
 *     endpoints, hôtes, IP, UUID et payloads.
 *
 * EN DEBUG ou après activation explicite du mode diagnostic local :
 *   — Les événements et exceptions sont écrits dans Logcat.
 *   — Les diagnostics réseau peuvent afficher les endpoints et le payload pour
 *     isoler un échec de handshake ; les mots de passe/tokens restent masqués.
 *   — Le mode est persistant sur l’appareil et doit être désactivé après test.
 *
 * UTILISATION :
 *   SxbSecureLogger.vpn(VpnEvent.CONNECTED)
 *   SxbSecureLogger.debug("message interne") // no-op en release
 *   SxbSecureLogger.error(VpnEvent.TUNNEL_FAILED, throwable)
 *
 * NE JAMAIS appeler android.util.Log directement dans les modules SXB VPN.
 * NE JAMAIS passer host, port, uuid, password, ou token comme argument.
 */

import android.content.Context
import android.util.Log
import com.sxbvpn.mobile.BuildConfig

object SxbSecureLogger {

    // ── Tag logcat — court, non explicite en prod ─────────────────────────────
    private const val TAG = "SXB"
    private const val PREFS = "sxb_diagnostics"
    private const val KEY_VERBOSE = "verbose_logging"
    private const val KEY_VERBOSE_UNTIL = "verbose_logging_until"
    private const val DIAGNOSTIC_TTL_MS = 30 * 60 * 1000L

    @Volatile private var diagnosticEnabled: Boolean = BuildConfig.DEBUG
    @Volatile private var diagnosticUntilMs: Long = if (BuildConfig.DEBUG) Long.MAX_VALUE else 0L

    /** Recharge le mode local au démarrage du bridge et du service. */
    fun initialize(context: Context) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val until = prefs.getLong(KEY_VERBOSE_UNTIL, 0L)
        diagnosticUntilMs = until
        diagnosticEnabled = BuildConfig.DEBUG || (prefs.getBoolean(KEY_VERBOSE, false) && until > System.currentTimeMillis())
    }

    /** Active les traces détaillées pendant 30 minutes pour ce seul appareil. */
    fun setDiagnosticEnabled(context: Context, enabled: Boolean) {
        val until = if (enabled) System.currentTimeMillis() + DIAGNOSTIC_TTL_MS else 0L
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_VERBOSE, enabled)
            .putLong(KEY_VERBOSE_UNTIL, until)
            .apply()
        diagnosticUntilMs = until
        diagnosticEnabled = BuildConfig.DEBUG || enabled
    }

    fun isDiagnosticEnabled(): Boolean {
        if (BuildConfig.DEBUG) return true
        if (diagnosticEnabled && System.currentTimeMillis() >= diagnosticUntilMs) {
            diagnosticEnabled = false
        }
        return diagnosticEnabled
    }

    // ── Regex de masquage — appliquées au logger structuré ─────────────────────
    private val SENSITIVE_PATTERNS = listOf(
        // IPv4
        Regex("""(\d{1,3}\.){3}\d{1,3}(:\d+)?""") to "[ip:****]",
        // IPv6
        Regex("""[0-9a-fA-F]{0,4}(:[0-9a-fA-F]{0,4}){2,7}""") to "[ipv6:****]",
        // UUID / clé VLESS
        Regex("""[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}""") to "[uuid:****]",
        // password= / key= / token= / secret=
        Regex("""(password|passwd|key|token|secret|uuid|user|username)[=:\s]+\S+""", RegexOption.IGNORE_CASE) to "$1=[****]",
        // Base64 longue (> 20 chars) — souvent une clé ou un blob chiffré
        Regex("""[A-Za-z0-9+/]{20,}={0,2}""") to "[b64:****]",
        // Hostname apparents (domain.tld)
        Regex("""[a-zA-Z0-9-]{2,63}\.[a-zA-Z]{2,6}(:\d+)?""") to "[host:****]",
    )

    // ════════════════════════════════════════════════════════════════════════
    // API publique
    // ════════════════════════════════════════════════════════════════════════

    /** Événement VPN structuré — visible en DEBUG, silencieux en RELEASE. */
    fun vpn(event: VpnEvent) {
        if (!isDiagnosticEnabled()) return
        Log.i(TAG, event.code)
    }

    /** Événement VPN avec contexte additionnel (non-sensible). */
    fun vpn(event: VpnEvent, detail: String) {
        if (!isDiagnosticEnabled()) return
        Log.i(TAG, "${event.code} — ${mask(detail)}")
    }

    /** Log de débogage libre — no-op en release. */
    fun debug(message: String) {
        if (!isDiagnosticEnabled()) return
        Log.d(TAG, mask(message))
    }

    /** Avertissement — no-op en release. */
    fun warn(message: String) {
        if (!isDiagnosticEnabled()) return
        Log.w(TAG, mask(message))
    }

    /**
     * Erreur avec throwable.
     * En release : silencieux (ne pas envoyer stack trace vers logcat).
     * Pour les erreurs fatales, utiliser un service de crash (Sentry) séparé.
     */
    fun error(event: VpnEvent, throwable: Throwable? = null) {
        if (!isDiagnosticEnabled()) return
        if (throwable != null) {
            // Ne pas logger le message de throwable s'il contient des données réseau
            Log.e(TAG, "${event.code} — ${maskThrowable(throwable)}")
        } else {
            Log.e(TAG, event.code)
        }
    }

    fun error(message: String, throwable: Throwable? = null) {
        if (!isDiagnosticEnabled()) return
        Log.e(TAG, mask(message), throwable)
    }

    // ════════════════════════════════════════════════════════════════════════
    // Masquage interne
    // ════════════════════════════════════════════════════════════════════════

    private fun mask(input: String): String {
        var result = input
        for ((pattern, replacement) in SENSITIVE_PATTERNS) {
            result = pattern.replace(result, replacement)
        }
        return result
    }

    /** Masque les données sensibles dans le message d'exception. */
    private fun maskThrowable(t: Throwable): String {
        val msg = t.message ?: t.javaClass.simpleName
        return mask(msg)
    }

    // ════════════════════════════════════════════════════════════════════════
    // Codes d'événements opaques
    // ════════════════════════════════════════════════════════════════════════

    enum class VpnEvent(val code: String) {
        // Cycle de vie service
        SERVICE_STARTED         ("E01"),
        SERVICE_STOPPED         ("E02"),
        SERVICE_DESTROYED       ("E03"),
        SERVICE_PERMISSION_REQ  ("E04"),
        // Tunnel
        TUNNEL_CONNECTING       ("E10"),
        TUNNEL_CONNECTED        ("E11"),
        TUNNEL_DISCONNECTED     ("E12"),
        TUNNEL_FAILED           ("E13"),
        TUNNEL_TIMEOUT          ("E14"),
        // Auto-reconnect
        RECONNECT_ENABLED       ("E20"),
        RECONNECT_DISABLED      ("E21"),
        RECONNECT_SCHEDULED     ("E22"),
        RECONNECT_FIRED         ("E23"),
        RECONNECT_GIVEUP        ("E24"),
        RECONNECT_RESET         ("E25"),
        RECONNECT_SKIP          ("E26"),
        // Config
        CONFIG_LOADED           ("E30"),
        CONFIG_WRITE_FAILED     ("E31"),
        CONFIG_CLEARED          ("E32"),
        // Kill switch
        KILLSWITCH_ON           ("E40"),
        KILLSWITCH_OFF          ("E41"),
        // Keystore
        KEYSTORE_KEY_CREATED    ("E50"),
        KEYSTORE_ENCRYPT_FAILED ("E51"),
        KEYSTORE_DECRYPT_FAILED ("E52"),
        KEYSTORE_KEY_DELETED    ("E53"),
        // Module RN bridge
        MODULE_CALLED           ("E60"),
        MODULE_RESOLVED         ("E61"),
        MODULE_REJECTED         ("E62"),
        // Sécurité
        SECURITY_AUDIT_OK       ("E70"),
        SECURITY_AUDIT_WARN     ("E71"),
        BOOT_COMPLETED          ("E80"),
        // Traffic
        TRAFFIC_UPDATE          ("E90"),
    }
}

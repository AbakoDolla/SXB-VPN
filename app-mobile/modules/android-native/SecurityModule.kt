package com.sxbvpn.vpnmodule

/**
 * SecurityModule — Détections de sécurité SXB VPN
 *
 * Vérifie :
 *  - Root (su binary, Superuser/Magisk apps, RootBeer paths)
 *  - Frida (ports 27042/27043, libs frida-agent, /proc/maps)
 *  - Xposed (XposedBridge class, IXposedHookLoadPackage)
 *  - Emulateur (Build.FINGERPRINT, Build.MODEL, QEMU props)
 *
 * Les configurations VPN ne sont jamais envoyées si une menace est détectée.
 */

import android.content.Context
import android.os.Build
import android.util.Log
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.InetSocketAddress
import java.net.Socket

object SecurityModule {

    private const val TAG = "SXB-Security"

    /** Empreinte SHA-256 attendue de la signature APK, injectée au build. */
    private const val META_EXPECTED_SIGNATURE = "com.sxbvpn.EXPECTED_SIGNATURE_SHA256"

    /**
     * Les sondes réseau tournent sur le thread appelant : un délai court évite
     * de figer l'interface au démarrage du service.
     */
    private const val PROBE_TIMEOUT_MS = 100

    // ── Résultat de l'audit de sécurité ──────────────────────────────────────
    data class SecurityReport(
        val isRooted: Boolean,
        val hasFrida: Boolean,
        val hasXposed: Boolean,
        val isEmulator: Boolean,
        val isHooked: Boolean,
        val isSafe: Boolean = !isRooted && !hasFrida && !hasXposed && !isHooked,
    )

    // ── Audit complet ─────────────────────────────────────────────────────────
    /**
     * @param deep exécute également les sondes coûteuses (détection d'émulateur via
     *        `getprop`, qui lance un processus). L'audit est invoqué depuis
     *        `onStartCommand()`, donc sur le thread principal : les sondes lentes
     *        sont désactivées par défaut pour ne pas provoquer d'ANR.
     */
    fun audit(ctx: Context, deep: Boolean = false): SecurityReport {
        val rooted  = isRooted(ctx)
        val frida   = hasFrida()
        val xposed  = hasXposed()
        val emulator = if (deep) isEmulator() else false
        val hooked   = isHooked()

        if (rooted)  Log.w(TAG, "⚠️ Appareil rooté détecté")
        if (frida)   Log.w(TAG, "⚠️ Frida détecté")
        if (xposed)  Log.w(TAG, "⚠️ Xposed détecté")
        if (emulator) Log.i(TAG, "ℹ️ Émulateur détecté")
        if (hooked)   Log.w(TAG, "⚠️ Hooking détecté")

        return SecurityReport(rooted, frida, xposed, emulator, hooked)
    }

    /**
     * Politique d'application des détections, explicite et unique.
     *
     * Instrumentation active (Frida, Xposed, Substrate) : blocage. Ces outils
     * permettent d'extraire en direct les identifiants VPN du processus.
     *
     * Root seul : avertissement. Un appareil rooté n'implique pas une
     * compromission et bloquer ces utilisateurs constituerait une régression
     * fonctionnelle pour une partie du parc installé.
     */
    fun shouldBlock(report: SecurityReport): Boolean =
        report.hasFrida || report.hasXposed || report.isHooked

    // ── Détection de hook (analyse de la stack trace) ─────────────────────────
    fun isHooked(): Boolean {
        try {
            throw Exception("Hook detection check")
        } catch (e: Exception) {
            for (element in e.stackTrace) {
                val className = element.className.lowercase()
                if (className.contains("com.saurik.substrate") ||
                    className.contains("de.robv.android.xposed") ||
                    className.contains("frida") ||
                    className.contains("club.ccorange")) {
                    return true
                }
            }
        }
        return false
    }

    // ── Vérification de signature ────────────────────────────────────────────
    /**
     * Compare la signature APK courante au condensat SHA-256 attendu.
     *
     * L'empreinte attendue est lue depuis la `<meta-data>` de manifeste
     * `com.sxbvpn.EXPECTED_SIGNATURE_SHA256`. Tant qu'elle n'est pas renseignée,
     * la vérification est explicitement « non configurée » : elle ne bloque rien
     * et le fait est journalisé, plutôt que de renvoyer silencieusement un
     * succès trompeur comme auparavant.
     */
    enum class SignatureStatus { VALID, INVALID, NOT_CONFIGURED, UNAVAILABLE }

    fun expectedSignatureHash(ctx: Context): String = try {
        val flags = android.content.pm.PackageManager.GET_META_DATA
        val appInfo = ctx.packageManager.getApplicationInfo(ctx.packageName, flags)
        appInfo.metaData?.getString(META_EXPECTED_SIGNATURE)?.trim().orEmpty()
    } catch (_: Exception) { "" }

    fun checkSignature(ctx: Context): SignatureStatus {
        val expected = expectedSignatureHash(ctx)
        if (expected.isEmpty()) return SignatureStatus.NOT_CONFIGURED
        return try {
            if (verifySignature(ctx, expected)) SignatureStatus.VALID else SignatureStatus.INVALID
        } catch (_: Exception) {
            SignatureStatus.UNAVAILABLE
        }
    }

    fun verifySignature(ctx: Context, expectedSignatureHash: String): Boolean {
        // Une empreinte vide ne peut pas valider quoi que ce soit : ne jamais
        // renvoyer `true` par défaut (échec ouvert).
        if (expectedSignatureHash.isBlank()) return false
        try {
            val pm = ctx.packageManager
            val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES
            } else {
                @Suppress("DEPRECATION")
                android.content.pm.PackageManager.GET_SIGNATURES
            }

            val info = pm.getPackageInfo(ctx.packageName, flags)
            val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                info.signingInfo?.apkContentsSigners
            } else {
                @Suppress("DEPRECATION")
                info.signatures
            }

            if (signatures != null) {
                val normalizedExpected = expectedSignatureHash.replace(":", "").trim()
                for (sig in signatures) {
                    val md = java.security.MessageDigest.getInstance("SHA-256")
                    md.update(sig.toByteArray())
                    val hash = md.digest().joinToString("") { "%02x".format(it) }
                    if (hash.equals(normalizedExpected, ignoreCase = true)) {
                        return true
                    }
                }
            }
        } catch (_: Exception) {}
        return false
    }

    // ── Détection Root ────────────────────────────────────────────────────────
    fun isRooted(ctx: Context): Boolean {
        return checkSuBinary() || checkRootApps(ctx) || checkRootPaths() || checkBuildTags()
    }

    private fun checkSuBinary(): Boolean {
        val paths = arrayOf(
            "/system/bin/su", "/system/xbin/su",
            "/sbin/su", "/data/local/su",
            "/data/local/bin/su", "/data/local/xbin/su",
            "/system/sd/xbin/su", "/system/bin/failsafe/su",
        )
        return paths.any { File(it).exists() }
    }

    private fun checkRootApps(ctx: Context): Boolean {
        val rootPkgs = arrayOf(
            "com.noshufou.android.su",
            "com.noshufou.android.su.elite",
            "eu.chainfire.supersu",
            "com.koushikdutta.superuser",
            "com.thirdparty.superuser",
            "com.yellowes.su",
            "com.topjohnwu.magisk",
            "com.kingroot.kinguser",
            "com.kingo.root",
        )
        return try {
            val pm = ctx.packageManager
            rootPkgs.any { pkg ->
                try { pm.getPackageInfo(pkg, 0); true } catch (_: Exception) { false }
            }
        } catch (_: Exception) { false }
    }

    private fun checkRootPaths(): Boolean {
        val paths = arrayOf(
            "/system/app/Superuser.apk",
            "/system/etc/init.d/99SuperSUDaemon",
            "/dev/com.koushikdutta.superuser.daemon/",
            "/system/xbin/daemonsu",
            "/sbin/.magisk", "/data/adb/magisk",
        )
        return paths.any { File(it).exists() }
    }

    private fun checkBuildTags(): Boolean {
        val tags = Build.TAGS ?: ""
        return tags.contains("test-keys")
    }

    // ── Détection Frida ───────────────────────────────────────────────────────
    fun hasFrida(): Boolean {
        return checkFridaPorts() || checkFridaMaps() || checkFridaFiles()
    }

    private fun checkFridaPorts(): Boolean {
        val ports = intArrayOf(27042, 27043)
        return ports.any { port ->
            try {
                Socket().use { s ->
                    s.connect(InetSocketAddress("127.0.0.1", port), PROBE_TIMEOUT_MS)
                    true
                }
            } catch (_: Exception) { false }
        }
    }

    private fun checkFridaMaps(): Boolean {
        return try {
            val maps = File("/proc/self/maps").readText()
            maps.contains("frida") || maps.contains("gum-js-loop") || maps.contains("gmain")
        } catch (_: Exception) { false }
    }

    private fun checkFridaFiles(): Boolean {
        val paths = arrayOf(
            "/data/local/tmp/frida-server",
            "/data/local/tmp/re.frida.server",
            "/usr/lib/frida",
        )
        return paths.any { File(it).exists() }
    }

    // ── Détection Xposed ──────────────────────────────────────────────────────
    fun hasXposed(): Boolean {
        return try {
            Class.forName("de.robv.android.xposed.XposedBridge")
            true
        } catch (_: ClassNotFoundException) {
            try {
                Class.forName("de.robv.android.xposed.XC_MethodHook")
                true
            } catch (_: ClassNotFoundException) { false }
        }
    }

    // ── Détection Émulateur ───────────────────────────────────────────────────
    fun isEmulator(): Boolean {
        val fingerprint = Build.FINGERPRINT?.lowercase() ?: ""
        val model       = Build.MODEL?.lowercase() ?: ""
        val manufacturer = Build.MANUFACTURER?.lowercase() ?: ""

        return fingerprint.contains("generic") ||
               fingerprint.contains("unknown") ||
               model.contains("google_sdk") ||
               model.contains("emulator") ||
               model.contains("android sdk") ||
               manufacturer.contains("genymotion") ||
               Build.BRAND?.startsWith("generic") == true ||
               Build.DEVICE?.startsWith("generic") == true ||
               checkQemuProps()
    }

    private fun checkQemuProps(): Boolean {
        return try {
            val p = Runtime.getRuntime().exec("getprop ro.kernel.qemu")
            val result = BufferedReader(InputStreamReader(p.inputStream)).readLine() ?: ""
            result.trim() == "1"
        } catch (_: Exception) { false }
    }

    // ── Masquage de données sensibles dans les logs ───────────────────────────
    // Couvre TOUS les champs listés dans la mission :
    //   IP, host, serveur, payload, password, username, token, UUID, URL, JWT,
    //   deviceId, SXB-USER-*, secrets
    fun maskSensitive(text: String): String {
        var result = text
        // IPv4 + port optionnel
        result = result.replace(Regex("""(\d{1,3}\.){3}\d{1,3}(:\d+)?"""), "[ip:****]")
        // IPv6
        result = result.replace(Regex("""[0-9a-fA-F]{0,4}(:[0-9a-fA-F]{0,4}){2,7}"""), "[ipv6:****]")
        // UUID (clé VLESS, etc.)
        result = result.replace(Regex("""[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"""), "[uuid:****]")
        // SXB-USER-XXXX-XXXX-XXXX tokens
        result = result.replace(Regex("""SXB-[A-Z]+-[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+""", RegexOption.IGNORE_CASE), "[token:****]")
        // JWT (Bearer ou brut)
        result = result.replace(Regex("""Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+""", RegexOption.IGNORE_CASE), "Bearer [jwt:****]")
        result = result.replace(Regex("""eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"""), "[jwt:****]")
        // URL complète
        result = result.replace(Regex("""https?://[^\s"']+"""), "[url:****]")
        // Domaines hostname.tld
        result = result.replace(Regex("""[a-zA-Z0-9-]{2,63}\.[a-zA-Z]{2,6}(:\d+)?"""), "[host:****]")
        // password=, key=, token=, secret=, uuid=, username=, deviceId=, payload=
        result = result.replace(Regex("""(password|passwd|key|token|secret|uuid|user|username|deviceId|payload|host|server)[=:]\s*\S+""", RegexOption.IGNORE_CASE), "$1=[****]")
        // Base64 longue (> 20 chars)
        result = result.replace(Regex("""[A-Za-z0-9+/]{20,}={0,2}"""), "[b64:****]")
        return result
    }

    /**
     * Diagnostic local : conserve les endpoints, IP, Host et payload pour le
     * diagnostic réseau, mais protège toujours les valeurs d’authentification.
     */
    fun maskCredentialsOnly(text: String): String {
        val keys = listOf("password", "passwd", "token", "secret", "authorization", "cookie", "api-key", "api_key")
        var result = text
        for (key in keys) {
            val pattern = Regex("(?i)(\\\"?$key\\\"?\\s*[:=]\\s*)(\\\"[^\\\"]*\\\"|'[^']*'|[^\\s,;}]+)")
            result = pattern.replace(result) { match ->
                "${match.groupValues[1]}[redacted]"
            }
        }
        return result
    }

    // ── Leurres anti-rétro-ingénierie ────────────────────────────────────────
    /**
     * Serveurs factices présentés lorsqu'une instrumentation active est
     * détectée.
     *
     * Refuser la connexion en annonçant « environnement compromis » apprend à
     * l'attaquant que sa sonde a été repérée : il la déplace et recommence.
     * Lui livrer un point de terminaison crédible mais faux le laisse au
     * contraire investir sur une infrastructure inexistante, pendant que le
     * vrai serveur n'a jamais été lu ni transmis au moteur.
     */
    private val LEURRE_HOTES = arrayOf(
        "edge-fra1.cdn-relay.net",
        "gw-ams3.netlink-core.com",
        "sg2.tunnelbridge.io",
        "node07.fastpath-eu.net",
        "relay-lon4.streamgate.org",
        "ix-par2.transitpoint.net"
    )
    private val LEURRE_PORTS = intArrayOf(443, 8443, 2083, 2087, 22, 2222)

    /** Point de terminaison factice, stable pour une même graine. */
    fun leurreEndpoint(graine: String = "sxb"): String {
        var h = 2166136261L
        for (c in graine) {
            h = h xor c.code.toLong()
            h = (h * 16777619L) and 0xFFFFFFFFL
        }
        val hote = LEURRE_HOTES[((h shr 8) % LEURRE_HOTES.size).toInt()]
        val port = LEURRE_PORTS[((h shr 16) % LEURRE_PORTS.size).toInt()]
        return "$hote:$port"
    }

    /** Identifiant factice, de forme identique à un vrai UUID VLESS. */
    fun leurreUuid(graine: String = "sxb"): String {
        var h = 0x9E3779B97F4A7C15uL
        for (c in graine) {
            h = h xor c.code.toULong()
            h *= 0x100000001B3uL
        }
        val hex = StringBuilder()
        var v = h
        repeat(32) {
            hex.append("0123456789abcdef"[(v and 0xFuL).toInt()])
            v = (v shr 3) xor (v * 31uL)
        }
        val s = hex.toString()
        return "${s.substring(0, 8)}-${s.substring(8, 12)}-${s.substring(12, 16)}-${s.substring(16, 20)}-${s.substring(20, 32)}"
    }
}

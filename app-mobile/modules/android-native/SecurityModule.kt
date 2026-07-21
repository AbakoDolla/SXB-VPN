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

    // ── Résultat de l'audit de sécurité ──────────────────────────────────────
    data class SecurityReport(
        val isRooted: Boolean,
        val hasFrida: Boolean,
        val hasXposed: Boolean,
        val isEmulator: Boolean,
        val isSafe: Boolean = !isRooted && !hasFrida && !hasXposed,
    )

    // ── Audit complet ─────────────────────────────────────────────────────────
    fun audit(ctx: Context): SecurityReport {
        val rooted  = isRooted(ctx)
        val frida   = hasFrida()
        val xposed  = hasXposed()
        val emulator = isEmulator()

        if (rooted)  Log.w(TAG, "⚠️ Appareil rooté détecté")
        if (frida)   Log.w(TAG, "⚠️ Frida détecté")
        if (xposed)  Log.w(TAG, "⚠️ Xposed détecté")
        if (emulator) Log.i(TAG, "ℹ️ Émulateur détecté")

        return SecurityReport(rooted, frida, xposed, emulator)
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
                    s.connect(InetSocketAddress("127.0.0.1", port), 200)
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
    fun maskSensitive(text: String): String {
        var result = text
        // Masquer les IPs/hosts dans les logs
        result = result.replace(Regex("""(\d{1,3}\.){3}\d{1,3}"""), "*.*.*.* ")
        result = result.replace(Regex("""password[=:]\s*\S+""", RegexOption.IGNORE_CASE), "password=********")
        result = result.replace(Regex("""username[=:]\s*\S+""", RegexOption.IGNORE_CASE), "username=********")
        result = result.replace(Regex("""key[=:]\s*[A-Za-z0-9+/=]{10,}""", RegexOption.IGNORE_CASE), "key=********")
        result = result.replace(Regex("""uuid[=:]\s*[\w-]+""", RegexOption.IGNORE_CASE), "uuid=********")
        return result
    }
}

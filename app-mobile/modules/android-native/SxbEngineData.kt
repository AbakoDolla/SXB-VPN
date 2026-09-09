package com.sxbvpn.vpnmodule

import android.content.Context
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

/** Packaged, pinned geosite data avoids a network download during VPN startup. */
object SxbEngineData {
    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    fun prepare(context: Context, directory: File) {
        val expected = context.assets.open("sxb-engine/geosite.sha256").bufferedReader().use { it.readText().trim() }
        check(Regex("[a-f0-9]{64}").matches(expected)) { "GEOSITE_CHECKSUM_INVALID" }
        val target = File(directory, "geosite.db")
        if (target.exists() && sha256(target) == expected) return
        val temporary = File.createTempFile("sxb-geosite-", ".tmp", directory)
        try {
            context.assets.open("sxb-engine/geosite.db").use { input ->
                FileOutputStream(temporary).use { output ->
                    input.copyTo(output)
                    output.fd.sync()
                }
            }
            check(sha256(temporary) == expected) { "GEOSITE_CHECKSUM_MISMATCH" }
            check(temporary.renameTo(target)) { "GEOSITE_INSTALL_FAILED" }
        } finally {
            if (temporary.exists()) check(temporary.delete()) { "GEOSITE_TEMP_CLEANUP_FAILED" }
        }
    }
}

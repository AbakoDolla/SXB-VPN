package com.sxbvpn.vpnmodule

import android.util.Base64
import org.json.JSONArray
import java.security.MessageDigest
import java.security.PublicKey
import java.security.cert.CertificateException

/** Trust restriction after normal chain and hostname verification, never a replacement for them. */
object SxbTlsPinPolicy {
    fun parse(raw: String, required: Boolean): List<String> {
        val values = JSONArray(raw)
        require(values.length() <= 8) { "BACKEND_PINS_INVALID" }
        val pins = (0 until values.length()).map { values.getString(it) }
        require(pins.all { Regex("sha256/[A-Za-z0-9+/]{43}=").matches(it) } &&
            pins.distinct().size == pins.size) { "BACKEND_PINS_INVALID" }
        require(!required || pins.size >= 2) { "BACKEND_PINS_REQUIRED" }
        return pins
    }

    fun check(pins: List<String>, keys: List<PublicKey>) {
        if (pins.isEmpty()) return
        val accepted = keys.any { key ->
            val digest = MessageDigest.getInstance("SHA-256").digest(key.encoded)
            "sha256/" + Base64.encodeToString(digest, Base64.NO_WRAP) in pins
        }
        if (!accepted) throw CertificateException("BACKEND_PIN_MISMATCH")
    }
}

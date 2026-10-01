package com.sxbvpn.vpnmodule

import android.util.Base64
import org.json.JSONObject
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/** A lease grants only the root exception, never a VPN/account entitlement. */
object SxbRootLeasePolicy {
    const val CREDENTIAL = "SXB-ROOT-ACCESS-1"
    const val MAX_AGE_MS = 24 * 60 * 60 * 1000L

    fun verify(receipt: JSONObject, keyId: String, trustedKey: String, now: Long): JSONObject {
        val payload = receipt.getString("payload")
        val signature = receipt.getString("signature")
        require(payload.length <= 2048 && signature.length <= 112 &&
            receipt.getString("publicKey") == trustedKey && trustedKey.length in 100..256) { "ROOT_RECEIPT_INVALID" }
        val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.decode(trustedKey, Base64.DEFAULT)))
        val valid = Signature.getInstance("SHA256withECDSA").apply {
            initVerify(key); update(payload.toByteArray(Charsets.UTF_8))
        }.verify(Base64.decode(signature, Base64.DEFAULT))
        require(valid) { "ROOT_RECEIPT_INVALID" }
        val lease = JSONObject(payload)
        val issued = lease.getLong("issuedAt")
        val expires = lease.getLong("expiresAt")
        require(lease.getString("scope") == CREDENTIAL && lease.getInt("version") == 1 &&
            lease.getString("keyId") == keyId && lease.getInt("revision") > 0 &&
            lease.getString("status") in setOf("pending", "approved", "denied") &&
            issued in 0..(now + 90000) && expires > issued &&
            expires - issued in 1..MAX_AGE_MS) { "ROOT_RECEIPT_INVALID" }
        return lease
    }

    fun allowed(lease: JSONObject, now: Long): Boolean =
        lease.getString("status") == "approved" && now >= lease.getLong("issuedAt") - 90000 &&
            now < lease.getLong("expiresAt")

    fun accepts(previous: JSONObject?, next: JSONObject): Boolean = previous == null ||
        next.getInt("revision") > previous.getInt("revision") ||
        next.getInt("revision") == previous.getInt("revision") &&
            next.getLong("issuedAt") >= previous.getLong("issuedAt")
}

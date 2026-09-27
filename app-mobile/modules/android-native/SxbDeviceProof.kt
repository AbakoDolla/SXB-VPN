package com.sxbvpn.vpnmodule

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.net.URI
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/** Nonexportable installation key. No root, StrongBox or Google Play prerequisite. */
object SxbDeviceProof {
    private const val ALIAS = "sxb_device_proof_v1"
    private fun store() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    fun hash(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    @Synchronized
    fun identity(): JSONObject {
        val keys = store()
        if (!keys.containsAlias(ALIAS)) {
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
                initialize(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .setUserAuthenticationRequired(false).build())
            }.generateKeyPair()
        }
        val publicKey = store().getCertificate(ALIAS).publicKey.encoded
        return JSONObject().put("publicKey", Base64.encodeToString(publicKey, Base64.NO_WRAP))
            .put("keyId", hash(publicKey))
    }

    fun headers(context: Context, method: String, url: String, body: String, credential: String): JSONObject {
        val target = URI(url)
        val base = URI(SxbBackendTls.base(context))
        require(target.scheme == base.scheme && target.rawAuthority == base.rawAuthority &&
            target.rawPath.startsWith(base.rawPath.trimEnd('/') + "/") && target.rawFragment == null) {
            "SECURITY_BACKEND_ORIGIN_MISMATCH"
        }
        val claims = if (credential.count { it == '.' } == 2) {
            JSONObject(String(Base64.decode(credential.split('.')[1], Base64.URL_SAFE or Base64.NO_WRAP), Charsets.UTF_8))
        } else JSONObject()
        val nonce = ByteArray(24).also { SecureRandom().nextBytes(it) }
        val encoded = Base64.encodeToString(nonce, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        val time = System.currentTimeMillis().toString()
        val path = target.rawPath + (target.rawQuery?.let { "?$it" } ?: "")
        val canonical = listOf("SXB-PROOF-1", method.uppercase(), path,
            hash(body.toByteArray(Charsets.UTF_8)), claims.optString("sid", "-"),
            claims.optInt("sg", 0).toString(), hash(credential.toByteArray(Charsets.UTF_8)), time, encoded).joinToString("\n")
        identity()
        val signature = Signature.getInstance("SHA256withECDSA").apply {
            initSign(store().getKey(ALIAS, null) as java.security.PrivateKey)
            update(canonical.toByteArray(Charsets.UTF_8))
        }.sign()
        return JSONObject().put("X-SXB-Time", time).put("X-SXB-Nonce", encoded)
            .put("X-SXB-Proof", Base64.encodeToString(signature, Base64.NO_WRAP))
    }
}

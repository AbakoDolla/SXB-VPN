package com.sxbvpn.vpnmodule

/**
 * KeystoreManager — Chiffrement AES-256-GCM avec Android Keystore
 *
 * Toutes les configurations VPN sont chiffrées avec une clé matérielle
 * stockée dans l'Android Keystore. La clé ne quitte jamais le hardware.
 *
 * Algorithme : AES-256-GCM (AEAD — authentifié + chiffré)
 * Clé        : 256 bits dans Android Keystore (TEE ou StrongBox si disponible)
 * Format     : IV(12 bytes) || CipherText || AuthTag(16 bytes) — encodé base64
 */

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

object KeystoreManager {

    private const val TAG              = "SXB-Keystore"
    private const val KEYSTORE_ALIAS   = "SXB_VPN_CFG_KEY_v1"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val CIPHER_ALGO      = "AES/GCM/NoPadding"
    private const val GCM_TAG_BITS     = 128
    private const val GCM_IV_BYTES     = 12

    // ── Obtenir ou créer la clé secrète dans l'Android Keystore ───────────────
    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).also { it.load(null) }

        if (keyStore.containsAlias(KEYSTORE_ALIAS)) {
            val entry = keyStore.getEntry(KEYSTORE_ALIAS, null) as? KeyStore.SecretKeyEntry
            if (entry != null) return entry.secretKey
        }

        // Créer une nouvelle clé AES-256 dans le Keystore
        val keyGen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(
            KEYSTORE_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setKeySize(256)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)   // IV aléatoire obligatoire
            .setUserAuthenticationRequired(false)    // pas de biométrie requise
            .build()

        keyGen.init(spec)
        val key = keyGen.generateKey()
        Log.i(TAG, "Nouvelle clé AES-256-GCM créée dans l'Android Keystore")
        return key
    }

    /**
     * Chiffre le texte en clair avec AES-256-GCM.
     * Retourne : "v1:" + base64(IV || CipherText+AuthTag)
     */
    fun encrypt(plaintext: String): String {
        return try {
            val key    = getOrCreateKey()
            val cipher = Cipher.getInstance(CIPHER_ALGO)
            cipher.init(Cipher.ENCRYPT_MODE, key)

            val iv         = cipher.iv                              // 12 bytes (GCM)
            val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))

            // Concaténer IV + CipherText+AuthTag
            val blob = ByteArray(iv.size + ciphertext.size)
            System.arraycopy(iv,         0, blob, 0,       iv.size)
            System.arraycopy(ciphertext, 0, blob, iv.size, ciphertext.size)

            "v1:" + Base64.encodeToString(blob, Base64.NO_WRAP)
        } catch (e: Exception) {
            Log.e(TAG, "Échec du chiffrement", e)
            throw RuntimeException("KeystoreManager.encrypt failed: ${e.message}", e)
        }
    }

    /**
     * Déchiffre un blob "v1:base64..." produit par encrypt().
     */
    fun decrypt(encoded: String): String {
        return try {
            if (!encoded.startsWith("v1:")) throw IllegalArgumentException("Format invalide")
            val blob = Base64.decode(encoded.removePrefix("v1:"), Base64.NO_WRAP)

            val iv         = blob.copyOfRange(0, GCM_IV_BYTES)
            val ciphertext = blob.copyOfRange(GCM_IV_BYTES, blob.size)

            val key    = getOrCreateKey()
            val spec   = GCMParameterSpec(GCM_TAG_BITS, iv)
            val cipher = Cipher.getInstance(CIPHER_ALGO)
            cipher.init(Cipher.DECRYPT_MODE, key, spec)

            String(cipher.doFinal(ciphertext), Charsets.UTF_8)
        } catch (e: Exception) {
            Log.e(TAG, "Échec du déchiffrement", e)
            throw RuntimeException("KeystoreManager.decrypt failed: ${e.message}", e)
        }
    }

    /**
     * Supprime la clé du Keystore (réinitialisation complète).
     */
    fun deleteKey() {
        try {
            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).also { it.load(null) }
            if (keyStore.containsAlias(KEYSTORE_ALIAS)) {
                keyStore.deleteEntry(KEYSTORE_ALIAS)
                Log.i(TAG, "Clé supprimée du Keystore")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Erreur suppression clé", e)
        }
    }

    /** Vérifie si une clé existe déjà dans le Keystore. */
    fun hasKey(): Boolean {
        return try {
            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).also { it.load(null) }
            keyStore.containsAlias(KEYSTORE_ALIAS)
        } catch (_: Exception) { false }
    }
}

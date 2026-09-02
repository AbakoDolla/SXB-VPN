package com.sxbvpn.vpnmodule

import android.content.Context
import android.util.Base64
import android.util.Log
import com.jcraft.jsch.HostKey
import com.jcraft.jsch.HostKeyRepository
import com.jcraft.jsch.UserInfo
import java.security.MessageDigest

/**
 * C5 — Vérification de la clé d'hôte SSH **avant** l'authentification.
 *
 * Historiquement le service posait `StrictHostKeyChecking=no` puis comparait
 * l'empreinte *après* `session.connect()`. À ce stade JSch a déjà transmis le
 * mot de passe du compte VPN : un attaquant en position de MITM récupérait les
 * identifiants avant même que la comparaison n'échoue.
 *
 * JSch interroge un [HostKeyRepository] pendant l'échange de clés, donc avant
 * toute authentification. En branchant cette implémentation et en passant
 * `StrictHostKeyChecking=yes`, une empreinte non conforme interrompt la session
 * avant l'envoi du secret.
 *
 * Compatibilité production : le mode strict n'est activé que lorsque le backend
 * fournit réellement une empreinte. Sans empreinte, on conserve le comportement
 * actuel (connexion autorisée) en mémorisant simplement la clé pour signaler un
 * changement ultérieur — les serveurs à plusieurs nœuds derrière un même nom
 * d'hôte ne sont donc jamais bloqués par une rotation légitime.
 */
class SxbHostKeyVerifier(
    context: Context,
    expectedFingerprint: String,
    private val onEvent: (String) -> Unit,
) : HostKeyRepository {

    private val store = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private val normalizedExpected: String = normalize(expectedFingerprint)

    /** true dès qu'une empreinte attendue exploitable est fournie : la vérification devient bloquante. */
    val strict: Boolean = isPlausibleFingerprint(normalizedExpected)

    /**
     * true lorsqu'une valeur a été fournie mais qu'elle ne peut pas être une
     * empreinte de clé (cas du champ `fingerprint` renseigné avec un profil uTLS
     * « chrome » / « firefox », partagé avec le moteur sing-box).
     */
    val ignoredFingerprint: Boolean = normalizedExpected.isNotEmpty() && !strict

    override fun check(host: String?, key: ByteArray?): Int {
        if (key == null || key.isEmpty()) return HostKeyRepository.NOT_INCLUDED
        val presented = fingerprints(key)

        if (strict) {
            return if (presented.contains(normalizedExpected)) {
                onEvent("[SXB] ✅ Empreinte SSH vérifiée avant authentification")
                HostKeyRepository.OK
            } else {
                // Aucun secret n'a encore été transmis : JSch va interrompre la session.
                Log.w(
                    TAG,
                    "Host key mismatch attendu=${redact(normalizedExpected)} " +
                        "recu=${redact(presented.firstOrNull() ?: "")}",
                )
                onEvent("[SXB] ❌ Empreinte SSH invalide — authentification annulée")
                HostKeyRepository.CHANGED
            }
        }

        // Mode tolérant : mémorisation « trust on first use » à visée d'alerte seulement.
        //
        // ATTENTION : ne JAMAIS renvoyer CHANGED ici. JSch lève une JSchException
        // sur CHANGED dès que `UserInfo` est absent — ce qui est notre cas — quelle
        // que soit la valeur de StrictHostKeyChecking. Une rotation de clé légitime
        // (serveur multi-nœuds derrière un même nom d'hôte) casserait alors toutes
        // les connexions. On se contente donc de journaliser et de renvoyer
        // NOT_INCLUDED, que JSch accepte avec StrictHostKeyChecking=no.
        val slot = slotKey(host)
        val known = store.getString(slot, null)
        if (known != null && !presented.contains(known)) {
            onEvent("[SXB] ⚠️ La clé d'hôte SSH a changé depuis la dernière connexion")
            Log.w(TAG, "Host key changed for slot=$slot")
        }
        if (known == null || !presented.contains(known)) {
            store.edit().putString(slot, presented.first()).apply()
            return HostKeyRepository.NOT_INCLUDED
        }
        return HostKeyRepository.OK
    }

    override fun add(hostkey: HostKey?, ui: UserInfo?) {
        val host = hostkey?.host ?: return
        val key = runCatching { Base64.decode(hostkey.key, Base64.DEFAULT) }.getOrNull() ?: return
        if (!strict) store.edit().putString(slotKey(host), fingerprints(key).first()).apply()
    }

    override fun remove(host: String?, type: String?) {
        store.edit().remove(slotKey(host)).apply()
    }

    override fun remove(host: String?, type: String?, key: ByteArray?) = remove(host, type)

    override fun getKnownHostsRepositoryID(): String = PREFS

    override fun getHostKey(): Array<HostKey> = emptyArray()

    override fun getHostKey(host: String?, type: String?): Array<HostKey> = emptyArray()

    private fun slotKey(host: String?): String = "hk_" + (host ?: "unknown").lowercase()

    companion object {
        private const val TAG = "SXB-HostKey"
        private const val PREFS = "sxb_known_hosts"

        /**
         * Empreintes équivalentes d'une même clé publique. Le backend peut envoyer
         * l'un ou l'autre des formats usuels (`SHA256:base64`, MD5 hexadécimal avec
         * ou sans séparateurs, SHA-256 hexadécimal) : toutes les représentations
         * sont calculées puis comparées sous forme normalisée.
         */
        fun fingerprints(key: ByteArray): List<String> {
            val md5 = digest("MD5", key)
            val sha256 = digest("SHA-256", key)
            val sha1 = digest("SHA-1", key)
            return listOf(
                hex(md5),
                hex(sha256),
                hex(sha1),
                normalize(Base64.encodeToString(sha256, Base64.NO_WRAP or Base64.NO_PADDING)),
            ).filter { it.isNotEmpty() }.distinct()
        }

        /**
         * Réduit une empreinte à une forme comparable : préfixe d'algorithme,
         * séparateurs, espaces et casse sont retirés. Le base64 conserve sa casse
         * d'origine sous une forme dédiée gérée par [fingerprints].
         */
        fun normalize(raw: String?): String {
            if (raw.isNullOrBlank()) return ""
            var value = raw.trim()
            listOf("sha256:", "sha-256:", "sha1:", "sha-1:", "md5:").forEach { prefix ->
                if (value.lowercase().startsWith(prefix)) value = value.substring(prefix.length)
            }
            value = value.replace(":", "").replace(" ", "").replace("=", "")
            // Une empreinte hexadécimale est insensible à la casse, contrairement au base64.
            return if (value.matches(Regex("^[0-9a-fA-F]+$"))) value.lowercase() else value
        }

        private fun digest(algorithm: String, data: ByteArray): ByteArray =
            MessageDigest.getInstance(algorithm).digest(data)

        /**
         * Le champ `fingerprint` de la configuration est partagé avec le moteur
         * sing-box, où il désigne un profil uTLS (« chrome », « firefox », …) et
         * non une empreinte de clé d'hôte. Activer la vérification stricte sur une
         * telle valeur rendrait toute connexion SSH impossible : on n'accepte donc
         * que les formes réellement produites par un condensat de clé publique.
         *
         * Formes reconnues : MD5 (32 hex), SHA-1 (40 hex), SHA-256 (64 hex) et
         * SHA-256 en base64 non paddé (43 caractères).
         */
        fun isPlausibleFingerprint(normalized: String): Boolean = when {
            normalized.isEmpty() -> false
            normalized.matches(Regex("^[0-9a-f]{32}$")) -> true
            normalized.matches(Regex("^[0-9a-f]{40}$")) -> true
            normalized.matches(Regex("^[0-9a-f]{64}$")) -> true
            normalized.matches(Regex("^[A-Za-z0-9+/]{43}$")) -> true
            else -> false
        }

        private fun hex(bytes: ByteArray): String =
            bytes.joinToString("") { "%02x".format(it) }

        /** Une empreinte n'est pas un secret, mais sa journalisation intégrale est inutile. */
        private fun redact(value: String): String =
            if (value.length <= 12) value else value.take(12) + "…"
    }
}

package com.sxbvpn.vpnmodule

import android.content.Context
import android.content.pm.PackageManager
import android.net.http.X509TrustManagerExtensions
import android.util.Base64
import android.util.Log
import com.facebook.react.modules.network.OkHttpClientFactory
import com.facebook.react.modules.network.OkHttpClientProvider
import com.facebook.react.modules.network.NetworkingModule
import com.facebook.react.modules.network.CustomClientBuilder
import okhttp3.CertificatePinner
import okhttp3.OkHttpClient
import org.json.JSONArray
import java.net.URI
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/** Optional public SPKI pins, compiled from reviewed rotation material. Normal TLS always applies. */
object SxbBackendTls {
    private fun metadata(context: Context) = context.packageManager.getApplicationInfo(
        context.packageName, PackageManager.GET_META_DATA).metaData
    fun base(context: Context): String = metadata(context)?.getString("com.sxbvpn.api_base_url")
        ?: "https://vpnsxb.afrihall.com/api"
    private fun pins(context: Context): List<String> {
        val values = JSONArray(metadata(context)?.getString("com.sxbvpn.BACKEND_SPKI_PINS") ?: "[]")
        return (0 until values.length()).map { values.getString(it) }.also { result ->
            require(result.all { Regex("sha256/[A-Za-z0-9+/]{43}=").matches(it) }) { "BACKEND_PINS_INVALID" }
        }
    }

    fun install(context: Context) {
        val configured = pins(context)
        if (configured.isEmpty()) Log.i("SXB-Security", "BACKEND_PINNING_NOT_CONFIGURED")
        if (configured.isNotEmpty()) {
            // Also cover a NetworkingModule created before this package initialized.
            NetworkingModule.setCustomClientBuilder(CustomClientBuilder { builder ->
                builder.certificatePinner(CertificatePinner.Builder()
                    .add(URI(base(context)).host, *configured.toTypedArray()).build())
            })
        }
        OkHttpClientProvider.setOkHttpClientFactory(object : OkHttpClientFactory {
            override fun createNewNetworkModuleClient(): OkHttpClient {
                val builder = OkHttpClientProvider.createClientBuilder()
                if (configured.isNotEmpty()) {
                    builder.certificatePinner(CertificatePinner.Builder()
                        .add(URI(base(context)).host, *configured.toTypedArray()).build())
                }
                return builder.build()
            }
        })
    }

    fun protect(context: Context, connection: HttpsURLConnection) {
        require(connection.url.host == URI(base(context)).host) { "SECURITY_BACKEND_ORIGIN_MISMATCH" }
        val configured = pins(context)
        if (configured.isEmpty()) return
        val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply {
            init(null as KeyStore?)
        }
        val standard = factory.trustManagers.filterIsInstance<X509TrustManager>().single()
        val trust = object : X509TrustManager {
            override fun getAcceptedIssuers(): Array<X509Certificate> = standard.acceptedIssuers
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) =
                standard.checkClientTrusted(chain, authType)
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                val verifiedChain = X509TrustManagerExtensions(standard)
                    .checkServerTrusted(chain, authType, connection.url.host)
                if (verifiedChain.none { cert ->
                    val digest = MessageDigest.getInstance("SHA-256").digest(cert.publicKey.encoded)
                    "sha256/" + Base64.encodeToString(digest, Base64.NO_WRAP) in configured
                }) throw CertificateException("BACKEND_PIN_MISMATCH")
            }
        }
        connection.sslSocketFactory = SSLContext.getInstance("TLS").apply {
            init(null, arrayOf(trust), null)
        }.socketFactory
    }
}

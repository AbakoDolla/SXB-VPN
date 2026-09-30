package com.sxbvpn.vpnmodule

import android.content.Context
import android.content.pm.PackageManager
import java.net.URI
import javax.net.ssl.HttpsURLConnection

/** Use normal platform TLS trust, without an additional public-key allowlist. */
object SxbBackendTls {
    private fun metadata(context: Context) = context.packageManager.getApplicationInfo(
        context.packageName, PackageManager.GET_META_DATA).metaData
    fun base(context: Context): String = metadata(context)?.getString("com.sxbvpn.api_base_url")
        ?: "https://vpnsxb.afrihall.com/api"

    fun protect(context: Context, connection: HttpsURLConnection) {
        require(connection.url.host == URI(base(context)).host) { "SECURITY_BACKEND_ORIGIN_MISMATCH" }
    }
}

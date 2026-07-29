package com.sxbvpn.vpnmodule

/**
 * SxbLibboxSupport — Ponts utilitaires entre Android et l'API libbox (sing-box).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE FICHIER EXISTE
 * ═══════════════════════════════════════════════════════════════════════════
 * L'ancien moteur écrivait un JSON sing-box contenant un inbound :
 *
 *     { "type": "tun", "file_descriptor": <fd> }
 *
 * ...puis lançait le binaire `sing-box run -c config.json` via ProcessBuilder.
 *
 * Ce montage ne peut PAS fonctionner sur Android, pour deux raisons :
 *
 *  1. `file_descriptor` n'existe pas dans le schéma JSON de sing-box.
 *     Ce champ n'est peuplé QUE par l'API Go `libbox`, via
 *     `PlatformInterface.OpenTun()` → `tun.Options.FileDescriptor`.
 *     En CLI, sing-box rejette la config (`json: unknown field`) et meurt.
 *
 *  2. Depuis Android 10 (API 29), l'exécution d'un binaire situé dans le
 *     répertoire privé de l'app est interdite (violation W^X) → `error=13`.
 *
 * La seule architecture correcte — celle utilisée par sing-box for Android,
 * NPV Tunnel, HTTP Custom, SocksIP — est d'embarquer le moteur **in-process**
 * et de lui fournir le descripteur du TUN par l'API native. C'est ce que
 * permettent les classes de ce fichier.
 *
 * Elles implémentent les types « itérateurs » que gomobile exige, ainsi que
 * l'énumération des interfaces réseau et le moniteur de réseau par défaut,
 * tous requis par `io.nekohasekai.libbox.PlatformInterface`.
 */

import android.annotation.SuppressLint
import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.system.OsConstants
import android.util.Log
import io.nekohasekai.libbox.InterfaceUpdateListener
import io.nekohasekai.libbox.Libbox
import io.nekohasekai.libbox.NetworkInterfaceIterator
import io.nekohasekai.libbox.StringIterator
import java.net.Inet6Address
import java.net.InterfaceAddress
import io.nekohasekai.libbox.NetworkInterface as LibboxNetworkInterface

// ═════════════════════════════════════════════════════════════════════════════
// ITÉRATEURS — gomobile ne sait pas exposer List<T>, il faut des itérateurs
// ═════════════════════════════════════════════════════════════════════════════

/** Itérateur de chaînes conforme à `libbox.StringIterator`. */
class SxbStringIterator(values: List<String>) : StringIterator {
    private val items = values.toMutableList()
    override fun len(): Int = items.size
    override fun hasNext(): Boolean = items.isNotEmpty()
    override fun next(): String = items.removeAt(0)
}

/** Itérateur d'interfaces réseau conforme à `libbox.NetworkInterfaceIterator`. */
class SxbInterfaceIterator(values: List<LibboxNetworkInterface>) : NetworkInterfaceIterator {
    private val items = values.toMutableList()
    override fun hasNext(): Boolean = items.isNotEmpty()
    override fun next(): LibboxNetworkInterface = items.removeAt(0)
}

fun List<String>.toStringIterator(): StringIterator = SxbStringIterator(this)

/** Convertit une `InterfaceAddress` Java en notation CIDR attendue par libbox. */
fun InterfaceAddress.toCidr(): String {
    val addr = address
    val host = addr.hostAddress?.substringBefore('%') ?: ""
    return if (addr is Inet6Address) "$host/$networkPrefixLength" else "$host/$networkPrefixLength"
}

// ═════════════════════════════════════════════════════════════════════════════
// MONITEUR DE RÉSEAU PAR DÉFAUT
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Suit le réseau physique par défaut (Wi-Fi / cellulaire) et le communique à
 * sing-box. Sans ce moniteur, `auto_detect_interface` ne peut pas savoir sur
 * quelle interface sortir, et tout le trafic du tunnel boucle dans le TUN.
 */
object SxbDefaultNetworkMonitor {

    private const val DBG = "SXB_DEBUG"

    @Volatile private var listener: InterfaceUpdateListener? = null
    @Volatile private var connectivity: ConnectivityManager? = null
    @Volatile var defaultNetwork: Network? = null
        private set

    private var callback: ConnectivityManager.NetworkCallback? = null

    fun start(context: Context) {
        if (callback != null) return
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return
        connectivity = cm

        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                defaultNetwork = network
                notifyListener()
            }

            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                defaultNetwork = network
                notifyListener()
            }

            override fun onLost(network: Network) {
                if (defaultNetwork == network) defaultNetwork = null
                notifyListener()
            }
        }

        runCatching {
            val request = NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()
            cm.registerNetworkCallback(request, cb)
            callback = cb
        }.onFailure {
            Log.w(DBG, "[SXB_DEBUG] DEFAULT_NETWORK_MONITOR_FAILED: ${it.message}")
        }
    }

    fun stop() {
        val cm = connectivity
        val cb = callback
        if (cm != null && cb != null) runCatching { cm.unregisterNetworkCallback(cb) }
        callback = null
        listener = null
        defaultNetwork = null
    }

    fun setListener(newListener: InterfaceUpdateListener?) {
        listener = newListener
        if (newListener != null) notifyListener()
    }

    /**
     * Pousse l'interface par défaut courante vers sing-box.
     * `interfaceIndex = -1` signifie « aucune connectivité ».
     */
    private fun notifyListener() {
        val target = listener ?: return
        val cm = connectivity
        val network = defaultNetwork

        if (cm == null || network == null) {
            runCatching { target.updateDefaultInterface("", -1, false, false) }
            return
        }

        val linkProperties: LinkProperties? = runCatching { cm.getLinkProperties(network) }.getOrNull()
        val capabilities: NetworkCapabilities? = runCatching { cm.getNetworkCapabilities(network) }.getOrNull()
        val name = linkProperties?.interfaceName
        if (name.isNullOrEmpty()) {
            runCatching { target.updateDefaultInterface("", -1, false, false) }
            return
        }

        val index = runCatching { java.net.NetworkInterface.getByName(name)?.index ?: -1 }.getOrDefault(-1)
        val metered = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == false
        val constrained = if (Build.VERSION.SDK_INT >= 34) {
            capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_CONGESTED) == false
        } else false

        Log.i(DBG, "[SXB_DEBUG] DEFAULT_INTERFACE name=$name index=$index metered=$metered")
        runCatching { target.updateDefaultInterface(name, index, metered, constrained) }
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// ÉNUMÉRATION DES INTERFACES RÉSEAU
// ═════════════════════════════════════════════════════════════════════════════

object SxbNetworkInterfaces {

    /**
     * Construit la liste des interfaces réseau du système au format libbox.
     * sing-box s'en sert pour résoudre `auto_detect_interface` et pour lier
     * ses sockets sortants au bon lien physique.
     */
    @SuppressLint("MissingPermission")
    fun enumerate(context: Context, excludeName: String?): List<LibboxNetworkInterface> {
        val result = mutableListOf<LibboxNetworkInterface>()
        val cm = context.getSystemService(ConnectivityManager::class.java)
        val javaInterfaces = runCatching {
            java.net.NetworkInterface.getNetworkInterfaces().toList()
        }.getOrDefault(emptyList())

        for (javaInterface in javaInterfaces) {
            val name = javaInterface.name ?: continue
            // Ne jamais annoncer notre propre TUN : cela créerait une boucle.
            if (excludeName != null && name == excludeName) continue

            val boxInterface = LibboxNetworkInterface()
            boxInterface.name = name
            boxInterface.index = runCatching { javaInterface.index }.getOrDefault(-1)
            boxInterface.mtu = runCatching { javaInterface.mtu }.getOrDefault(1500)
            boxInterface.addresses = runCatching {
                javaInterface.interfaceAddresses.map { it.toCidr() }
            }.getOrDefault(emptyList()).toStringIterator()

            var flags = 0
            runCatching {
                if (javaInterface.isUp) flags = flags or OsConstants.IFF_UP or OsConstants.IFF_RUNNING
                if (javaInterface.isLoopback) flags = flags or OsConstants.IFF_LOOPBACK
                if (javaInterface.isPointToPoint) flags = flags or OsConstants.IFF_POINTOPOINT
                if (javaInterface.supportsMulticast()) flags = flags or OsConstants.IFF_MULTICAST
            }
            boxInterface.flags = flags

            // Type + statut « facturé » depuis ConnectivityManager quand disponible
            var type = Libbox.InterfaceTypeOther
            var metered = false
            if (cm != null) {
                val matched = findNetworkFor(cm, name)
                if (matched != null) {
                    val caps = runCatching { cm.getNetworkCapabilities(matched) }.getOrNull()
                    if (caps != null) {
                        type = when {
                            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> Libbox.InterfaceTypeWIFI
                            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> Libbox.InterfaceTypeCellular
                            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> Libbox.InterfaceTypeEthernet
                            else -> Libbox.InterfaceTypeOther
                        }
                        metered = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
                    }
                    val linkProperties = runCatching { cm.getLinkProperties(matched) }.getOrNull()
                    if (linkProperties != null) {
                        boxInterface.dnsServer = linkProperties.dnsServers
                            .mapNotNull { it.hostAddress }
                            .toStringIterator()
                    }
                }
            }
            boxInterface.type = type
            boxInterface.metered = metered

            if (boxInterface.dnsServer == null) {
                boxInterface.dnsServer = emptyList<String>().toStringIterator()
            }

            result.add(boxInterface)
        }
        return result
    }

    @SuppressLint("MissingPermission")
    private fun findNetworkFor(cm: ConnectivityManager, interfaceName: String): Network? {
        return runCatching {
            @Suppress("DEPRECATION")
            cm.allNetworks.firstOrNull { network ->
                cm.getLinkProperties(network)?.interfaceName == interfaceName
            }
        }.getOrNull()
    }
}

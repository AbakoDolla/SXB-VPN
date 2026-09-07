package com.sxbvpn.vpnmodule

import com.jcraft.jsch.ChannelDirectTCPIP
import com.jcraft.jsch.Session
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.LinkedHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Relais SOCKS5 UDP ASSOCIATE vers le protocole BadVPN udpgw transporté dans
 * un canal SSH direct-tcpip.
 */
internal class SxbUdpGateway(
    private val session: Session,
    private val gatewayHost: String,
    private val gatewayPort: Int,
    private val onUpload: (Int) -> Unit,
    private val onDownload: (Int) -> Unit,
) {
    companion object {
        private const val MAX_DATAGRAM = 32768
        private const val FLAG_KEEPALIVE = 0x01
        private const val FLAG_REBIND = 0x02
        private const val FLAG_DNS = 0x04
        private const val FLAG_IPV6 = 0x08
        private const val MAX_CONNECTIONS = 256
    }

    fun associate(control: Socket, requestInput: DataInputStream, responseOutput: OutputStream, requestAtyp: Int) {
        discardSocksAddress(requestInput, requestAtyp)
        readU16Be(requestInput)

        val udp = DatagramSocket(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0))
        udp.soTimeout = 20_000
        val local = udp.localSocketAddress as InetSocketAddress

        val channel = session.openChannel("direct-tcpip") as ChannelDirectTCPIP
        channel.setHost(gatewayHost)
        channel.setPort(gatewayPort)
        channel.setOrgIPAddress("127.0.0.1")
        channel.setOrgPort(udp.localPort)
        try {
            channel.connect(15_000)
        } catch (error: Exception) {
            runCatching {
                responseOutput.write(byteArrayOf(5, 1, 0, 1, 0, 0, 0, 0, 0, 0))
                responseOutput.flush()
            }
            udp.close()
            runCatching { channel.disconnect() }
            throw error
        }
        writeAssociateReply(responseOutput, local)

        val open = AtomicBoolean(true)
        val gatewayInput = DataInputStream(channel.inputStream)
        val gatewayOutput = channel.outputStream
        val udpPeer = AtomicReference<InetSocketAddress?>(null)
        val connections = ConnectionTable()
        val writerLock = Any()

        fun closeAssociation() {
            if (!open.getAndSet(false)) return
            runCatching { udp.close() }
            runCatching { channel.disconnect() }
            runCatching { control.close() }
        }

        val controlThread = Thread({
            try {
                while (open.get() && control.inputStream.read() != -1) Unit
            } catch (_: Exception) {
            } finally {
                closeAssociation()
            }
        }, "Socks5UdpControl").apply { isDaemon = true; start() }

        val upstreamThread = Thread({
            val buffer = ByteArray(MAX_DATAGRAM + 512)
            try {
                while (open.get() && channel.isConnected) {
                    val packet = DatagramPacket(buffer, buffer.size)
                    try {
                        udp.receive(packet)
                    } catch (_: SocketTimeoutException) {
                        val keepaliveId = connections.anyId() ?: continue
                        synchronized(writerLock) {
                            writePacketProto(gatewayOutput, byteArrayOf(
                                FLAG_KEEPALIVE.toByte(),
                                (keepaliveId and 0xff).toByte(),
                                ((keepaliveId ushr 8) and 0xff).toByte(),
                            ))
                        }
                        continue
                    }
                    val packetPeer = packet.socketAddress as? InetSocketAddress ?: continue
                    val knownPeer = udpPeer.get()
                    if (knownPeer != null && knownPeer != packetPeer) continue
                    udpPeer.compareAndSet(null, packetPeer)
                    val socks = parseSocksUdp(packet.data, packet.offset, packet.length) ?: continue
                    val destination = DestinationKey(socks.address, socks.port)
                    val (connectionId, needsRebind) = connections.getOrAllocate(destination)
                    val flags = (if (needsRebind) FLAG_REBIND else 0) or
                        (if (socks.port == 53) FLAG_DNS else 0) or
                        (if (socks.address is Inet6Address) FLAG_IPV6 else 0)
                    val frame = ByteArrayOutputStream(socks.payload.size + 24).apply {
                        write(flags)
                        writeLe16(connectionId)
                        write(socks.address.address)
                        // Les en-têtes packetproto et conid sont little-endian,
                        // mais le port de l'adresse UDPGW reste en ordre réseau.
                        writeBe16(socks.port)
                        write(socks.payload)
                    }.toByteArray()
                    if (frame.size > MAX_DATAGRAM) continue
                    synchronized(writerLock) { writePacketProto(gatewayOutput, frame) }
                    onUpload(socks.payload.size)
                }
            } catch (_: Exception) {
            } finally {
                closeAssociation()
            }
        }, "Socks5UdpUp").apply { isDaemon = true; start() }

        val downstreamThread = Thread({
            try {
                while (open.get() && channel.isConnected) {
                    val frameLength = readU16Le(gatewayInput)
                    if (frameLength < 3 || frameLength > MAX_DATAGRAM) throw EOFException("invalid udpgw frame")
                    val frame = ByteArray(frameLength)
                    gatewayInput.readFully(frame)
                    val flags = frame[0].toInt() and 0xff
                    if ((flags and FLAG_KEEPALIVE) != 0 && frameLength == 3) continue
                    val connectionId = (frame[1].toInt() and 0xff) or
                        ((frame[2].toInt() and 0xff) shl 8)
                    val destination = connections.getById(connectionId) ?: continue
                    val addressLength = if ((flags and FLAG_IPV6) != 0) 16 else 4
                    if (frameLength < 3 + addressLength + 2) continue
                    val responseAddress = InetAddress.getByAddress(frame.copyOfRange(3, 3 + addressLength))
                    val portOffset = 3 + addressLength
                    val responsePort = ((frame[portOffset].toInt() and 0xff) shl 8) or
                        (frame[portOffset + 1].toInt() and 0xff)
                    // Un conid réutilisé peut encore avoir une réponse en vol
                    // pour son ancienne destination. Ne jamais l'étiqueter comme
                    // provenant de la nouvelle : comparer le tuple transporté.
                    if (responseAddress != destination.address || responsePort != destination.port) continue
                    val payload = frame.copyOfRange(portOffset + 2, frame.size)
                    val peer = udpPeer.get() ?: continue
                    val response = ByteArrayOutputStream(payload.size + 24).apply {
                        write(0); write(0); write(0) // RSV + FRAG=0
                        write(if (responseAddress is Inet6Address) 4 else 1)
                        write(responseAddress.address)
                        write((responsePort ushr 8) and 0xff)
                        write(responsePort and 0xff)
                        write(payload)
                    }.toByteArray()
                    udp.send(DatagramPacket(response, response.size, peer))
                    onDownload(payload.size)
                }
            } catch (_: Exception) {
            } finally {
                closeAssociation()
            }
        }, "Socks5UdpDown").apply { isDaemon = true; start() }

        controlThread.join()
        upstreamThread.join(2_000)
        downstreamThread.join(2_000)
        closeAssociation()
    }

    private data class SocksDatagram(val address: InetAddress, val port: Int, val payload: ByteArray)
    private data class DestinationKey(val address: InetAddress, val port: Int)

    /**
     * BadVPN identifie chaque destination UDP par un conid distinct. Le nombre
     * est borné ; la plus ancienne destination est réutilisée avec REBIND afin
     * d'éviter une croissance sans limite sur une longue session.
     */
    private class ConnectionTable {
        private val lock = Any()
        private val byDestination = LinkedHashMap<DestinationKey, Int>(16, 0.75f, true)
        private val byId = HashMap<Int, DestinationKey>()
        private var nextId = 1

        fun getOrAllocate(destination: DestinationKey): Pair<Int, Boolean> = synchronized(lock) {
            byDestination[destination]?.let { return@synchronized it to false }

            val id = if (byDestination.size >= MAX_CONNECTIONS) {
                val oldest = byDestination.entries.iterator().next()
                byDestination.remove(oldest.key)
                byId.remove(oldest.value)
                oldest.value
            } else {
                var candidate = nextId
                var attempts = 0
                while (byId.containsKey(candidate) && attempts < 65535) {
                    candidate = if (candidate == 65535) 1 else candidate + 1
                    attempts += 1
                }
                check(attempts < 65535) { "No UDPGW connection identifiers available" }
                nextId = if (candidate == 65535) 1 else candidate + 1
                candidate
            }
            byDestination[destination] = id
            byId[id] = destination
            id to true
        }

        fun getById(id: Int): DestinationKey? = synchronized(lock) { byId[id] }

        fun anyId(): Int? = synchronized(lock) { byId.keys.firstOrNull() }
    }

    private fun parseSocksUdp(bytes: ByteArray, offset: Int, length: Int): SocksDatagram? {
        if (length < 7) return null
        var pos = offset
        if (bytes[pos++].toInt() != 0 || bytes[pos++].toInt() != 0) return null
        if ((bytes[pos++].toInt() and 0xff) != 0) return null // FRAG doit rester 0
        val atyp = bytes[pos++].toInt() and 0xff
        val address = when (atyp) {
            1 -> {
                if (pos + 4 > offset + length) return null
                InetAddress.getByAddress(bytes.copyOfRange(pos, pos + 4)).also { pos += 4 }
            }
            3 -> {
                if (pos >= offset + length) return null
                val size = bytes[pos++].toInt() and 0xff
                if (size == 0 || pos + size > offset + length) return null
                val host = String(bytes, pos, size, Charsets.US_ASCII)
                pos += size
                InetAddress.getByName(host)
            }
            4 -> {
                if (pos + 16 > offset + length) return null
                InetAddress.getByAddress(bytes.copyOfRange(pos, pos + 16)).also { pos += 16 }
            }
            else -> return null
        }
        if (pos + 2 > offset + length) return null
        val port = ((bytes[pos].toInt() and 0xff) shl 8) or (bytes[pos + 1].toInt() and 0xff)
        pos += 2
        val payloadSize = offset + length - pos
        if (payloadSize < 0 || payloadSize > MAX_DATAGRAM) return null
        return SocksDatagram(address, port, bytes.copyOfRange(pos, offset + length))
    }

    private fun discardSocksAddress(input: DataInputStream, atyp: Int) {
        val size = when (atyp) {
            1 -> 4
            3 -> input.readUnsignedByte()
            4 -> 16
            else -> throw IllegalArgumentException("SOCKS5 ATYP unsupported")
        }
        input.readFully(ByteArray(size))
    }

    private fun writeAssociateReply(output: OutputStream, address: InetSocketAddress) {
        val rawAddress = (address.address as? Inet4Address)?.address ?: byteArrayOf(127, 0, 0, 1)
        output.write(byteArrayOf(5, 0, 0, 1))
        output.write(rawAddress)
        output.write(byteArrayOf(
            ((address.port ushr 8) and 0xff).toByte(),
            (address.port and 0xff).toByte(),
        ))
        output.flush()
    }

    private fun writePacketProto(output: OutputStream, frame: ByteArray) {
        require(frame.size <= MAX_DATAGRAM)
        output.write(frame.size and 0xff)
        output.write((frame.size ushr 8) and 0xff) // packetproto uint16 little-endian
        output.write(frame)
        output.flush()
    }

    private fun ByteArrayOutputStream.writeLe16(value: Int) {
        write(value and 0xff)
        write((value ushr 8) and 0xff)
    }

    private fun ByteArrayOutputStream.writeBe16(value: Int) {
        write((value ushr 8) and 0xff)
        write(value and 0xff)
    }

    private fun readU16Le(input: InputStream): Int {
        val low = input.read()
        val high = input.read()
        if (low < 0 || high < 0) throw EOFException()
        return low or (high shl 8)
    }

    private fun readU16Be(input: InputStream): Int {
        val high = input.read()
        val low = input.read()
        if (low < 0 || high < 0) throw EOFException()
        return (high shl 8) or low
    }
}

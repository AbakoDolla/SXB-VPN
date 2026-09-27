package com.sxbvpn.vpnmodule

import android.system.Os
import android.util.Log
import io.nekohasekai.libbox.*
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** libbox 1.12.9 totals, independent of Android's restricted sysfs/UID counters. */
internal class SxbEngineTraffic(private val service: BoxService, private val internalFiles: File) {
    @Volatile private var totals: Pair<Long, Long>? = null
    @Volatile private var closed = false
    private var client: CommandClient? = null
    private val server = Libbox.newCommandServer(object : CommandServerHandler {
        override fun serviceReload() { error("USAGE_COMMAND_UNSUPPORTED") }
        override fun postServiceClose() { error("USAGE_COMMAND_UNSUPPORTED") }
        override fun getSystemProxyStatus(): SystemProxyStatus = SystemProxyStatus()
        override fun setSystemProxyEnabled(enabled: Boolean) { error("USAGE_COMMAND_UNSUPPORTED") }
    }, 1)

    fun start() {
        // Libbox.setup uses filesDir as basePath. No TCP/HTTP controller and no
        // external-files socket: other Android applications cannot reach it.
        server.setService(service)
        server.start()
        Os.chmod(File(internalFiles, "command.sock").absolutePath, 384) // 0600
        client = newClient().also { it.connect() }
    }

    fun snapshot(): Pair<Long, Long>? = totals

    private fun newClient(received: CountDownLatch? = null): CommandClient =
        Libbox.newCommandClient(object : CommandClientHandler {
            override fun connected() {}
            override fun disconnected(message: String?) {
                if (!closed) Log.w("SXB-Traffic", "ENGINE_USAGE_STREAM_UNAVAILABLE")
            }
            override fun writeStatus(message: StatusMessage?) {
                if (!closed && message?.trafficAvailable == true) {
                    val up = message.uplinkTotal
                    val down = message.downlinkTotal
                    if (up >= 0 && down >= 0) {
                        synchronized(this@SxbEngineTraffic) {
                            val previous = totals
                            totals = maxOf(previous?.first ?: 0, up) to maxOf(previous?.second ?: 0, down)
                        }
                        received?.countDown()
                    }
                }
            }
            override fun clearLogs() {}
            override fun writeLogs(messages: StringIterator?) {}
            override fun writeGroups(groups: OutboundGroupIterator?) {}
            override fun initializeClashMode(modes: StringIterator?, currentMode: String?) {}
            override fun updateClashMode(mode: String?) {}
            override fun writeConnections(connections: Connections?) {}
        }, CommandClientOptions().apply {
            command = Libbox.CommandStatus
            statusInterval = TimeUnit.SECONDS.toNanos(1)
        })

    /** Called after engine close: the last sub-second tail is still in its totals. */
    fun captureFinal() {
        val received = CountDownLatch(1)
        val finalClient = newClient(received)
        try {
            finalClient.connect()
            check(received.await(2, TimeUnit.SECONDS)) { "ENGINE_USAGE_FINAL_UNAVAILABLE" }
        } finally {
            finalClient.disconnect()
        }
    }

    fun close() {
        closed = true
        try { client?.disconnect() } finally { server.close() }
        client = null
    }
}

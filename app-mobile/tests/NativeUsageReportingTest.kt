@file:Suppress("UNUSED_PARAMETER")
package com.sxbvpn.usagefixture

// Only the Android/React boundaries are simulated; the bridge fields,
// initialization, receivers and teardown are extracted unchanged from production.
abstract class BroadcastReceiver {
    abstract fun onReceive(c: Context?, i: Intent?)
}
class Intent(val action: String, private val state: String? = null) {
    fun getStringExtra(key: String): String? = if (key == "state") state else null
    fun getLongExtra(key: String, fallback: Long): Long = fallback
}
class IntentFilter(val action: String)
class Context {
    companion object { const val RECEIVER_NOT_EXPORTED = 4 }
    val receivers = linkedMapOf<BroadcastReceiver, String>()
    val flags = mutableListOf<Int>()
    var nullRegistrations = 0
    var unregistered = 0
    var allowed = true
    val tasks = HeadlessJsTaskContext()
    fun registerReceiver(receiver: BroadcastReceiver?, filter: IntentFilter, flag: Int = 0) {
        flags.add(flag)
        if (receiver == null) { nullRegistrations++; return }
        check(receivers.put(receiver, filter.action) == null)
    }
    fun unregisterReceiver(receiver: BroadcastReceiver?) {
        check(receivers.remove(receiver) != null) { "Receiver was not registered" }
        unregistered++
    }
    fun broadcast(action: String, state: String? = null) {
        receivers.toMap().filterValues { it == action }.keys.forEach { it.onReceive(this, Intent(action, state)) }
    }
}
object Build {
    object VERSION { var SDK_INT = 33 }
    object VERSION_CODES { const val TIRAMISU = 33 }
}
class WritableMap {
    fun putString(key: String, value: String) = Unit
    fun putDouble(key: String, value: Double) = Unit
}
object Arguments { fun createMap() = WritableMap() }
object SxbSecureLogger {
    enum class VpnEvent { TUNNEL_CONNECTED, SERVICE_STARTED }
    fun vpn(event: VpnEvent) = Unit
    fun initialize(context: Context) = Unit
}
object SxbVpnService {
    const val BROADCAST_STATUS = "status"
    const val BROADCAST_LOG = "log"
}
object SxbAccessControl { const val BROADCAST = "access" }
object SxbRootAccess { const val BROADCAST = "root-access" }
object SxbPrivacyPolicy { fun vpnAllowed(context: Context) = context.allowed }
class HeadlessJsTaskConfig(val name: String, val data: WritableMap, val timeout: Long, val foreground: Boolean)
class HeadlessJsTaskContext {
    companion object { fun getInstance(context: Context) = context.tasks }
    val started = mutableListOf<HeadlessJsTaskConfig>()
    val running = mutableSetOf<Int>()
    fun isTaskRunning(id: Int) = id in running
    fun startTask(config: HeadlessJsTaskConfig): Int {
        started.add(config)
        return started.size.also { running.add(it) }
    }
}
open class Lifecycle {
    open fun initialize() = Unit
    open fun invalidate() = Unit
}
class Executor {
    var stopped = false
    fun shutdown() { stopped = true }
}

fun main() {
    for (api in listOf(32, 33)) {
        Build.VERSION.SDK_INT = api
        val ctx = Context()
        val bridge = UsageReceiverHarness(ctx)
        bridge.initialize()
        check(ctx.nullRegistrations == 0) { "A null receiver only queries sticky broadcasts" }
        check(ctx.receivers.size == 5)
        check(ctx.flags.all { it == if (api >= 33) Context.RECEIVER_NOT_EXPORTED else 0 })
        val registered = ctx.receivers.keys.toList()
        ctx.broadcast("com.sxbvpn.USAGE_TICK")
        check(ctx.tasks.started.isEmpty())
        bridge.setUsageReportingEnabled(true)
        ctx.broadcast("com.sxbvpn.USAGE_TICK")
        check(ctx.tasks.started.size == 1) { "First tick must work without an access broadcast" }
        check(ctx.tasks.started.single().let {
            it.name == "SxbUsageReport" && it.timeout == 180_000L && it.foreground
        })
        ctx.broadcast("com.sxbvpn.USAGE_TICK")
        check(ctx.tasks.started.size == 1) { "An active report must not overlap another" }
        println("PASS native usage reporting: API $api initial tick and overlap")

        ctx.broadcast(SxbAccessControl.BROADCAST)
        ctx.broadcast(SxbAccessControl.BROADCAST)
        check(bridge.events == listOf("onAccessStateChange", "onAccessStateChange"))
        check(ctx.receivers.keys.toList() == registered)
        ctx.broadcast(SxbRootAccess.BROADCAST)
        check(bridge.events.size == 2) { "An empty root broadcast cannot change startup authority" }
        ctx.broadcast(SxbRootAccess.BROADCAST, """{"allowed":false,"rooted":true}""")
        check(bridge.events.last() == "onRootAppAccessChange")
        check(ctx.receivers.keys.toList() == registered)
        ctx.tasks.running.clear()
        ctx.allowed = false
        ctx.broadcast("com.sxbvpn.USAGE_TICK")
        check(ctx.tasks.started.size == 1)
        ctx.allowed = true
        ctx.broadcast("com.sxbvpn.USAGE_TICK")
        check(ctx.tasks.started.size == 2)
        bridge.setUsageReportingEnabled(false)
        ctx.tasks.running.clear()
        ctx.broadcast("com.sxbvpn.USAGE_TICK")
        check(ctx.tasks.started.size == 2)
        println("PASS native usage reporting: API $api stable receiver and consent")

        bridge.invalidate()
        check(ctx.unregistered == 5 && ctx.receivers.isEmpty())
        check(bridge.accessExecutor.stopped)
        ctx.broadcast("com.sxbvpn.USAGE_TICK")
        check(ctx.tasks.started.size == 2)
        println("PASS native usage reporting: API $api exact receiver teardown")
    }
}

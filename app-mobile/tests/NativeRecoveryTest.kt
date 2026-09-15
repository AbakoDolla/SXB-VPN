package com.sxbvpn.vpnmodule

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

// Inline continuations let a second deadline reach the real mutex while the
// first callback is deliberately held open, without wall-clock sleeps.
private object RecoveryDispatcher : CoroutineDispatcher() {
    override fun dispatch(context: CoroutineContext, block: Runnable) = block.run()
}

private class RecoveryClock(private val ignoreCancellation: Boolean = false) {
    var nowMs = 1_000L
        private set
    private data class Wait(val dueMs: Long, val active: () -> Boolean, val resume: () -> Unit)
    private val waits = mutableListOf<Wait>()

    suspend fun wait(ms: Long) {
        if (ignoreCancellation) {
            suspendCoroutine<Unit> { continuation ->
                waits += Wait(nowMs + ms, { true }) { continuation.resume(Unit) }
            }
        } else {
            suspendCancellableCoroutine<Unit> { continuation ->
                waits += Wait(nowMs + ms, { continuation.isActive }) { continuation.resume(Unit) }
            }
        }
    }

    fun nextDelayMs(): Long? = waits.filter { it.active() }.minOfOrNull { it.dueMs - nowMs }
    fun pending() = waits.count { it.active() }

    fun advanceBy(ms: Long) {
        require(ms >= 0)
        val target = nowMs + ms
        while (true) {
            val next = waits.filter { it.active() && it.dueMs <= target }.minByOrNull { it.dueMs } ?: break
            waits.remove(next)
            nowMs = maxOf(nowMs, next.dueMs)
            next.resume()
        }
        nowMs = maxOf(nowMs, target)
    }
}

private class RecoveryFixture(ignoreCancellation: Boolean = false) : java.io.Closeable {
    val clock = RecoveryClock(ignoreCancellation)
    var network = true
    var networkQueryFails = false
    var connected = false
    var dispatching = false
    var attempts = 0
    var giveUps = 0
    var action: () -> Unit = {}
    val logs = mutableListOf<String>()
    val manager = AutoReconnectManager(
        onReconnect = {
            attempts++
            dispatching = true
            try { action() } finally { dispatching = false }
        },
        onGiveUp = { giveUps++ },
        onLog = { logs += it },
        hasNetwork = {
            if (networkQueryFails) error("Network query unavailable")
            network
        },
        isTunnelUp = { connected },
        isDispatchInFlight = { dispatching },
        elapsedMs = { clock.nowMs },
        dispatcher = RecoveryDispatcher,
        waitForRetry = { clock.wait(it) },
    ).also { it.enable() }

    fun connectFor(ms: Long = 0) {
        connected = true
        manager.onConnected()
        clock.advanceBy(ms)
    }

    fun drop() {
        connected = false
        manager.onDisconnected()
    }

    override fun close() = manager.destroy()
}

private fun recoveryCase(name: String, body: () -> Unit) {
    body()
    println("PASS $name")
}

fun main() {
    recoveryCase("healthy retry is 250 ms, threshold is 30 s, ordinary backoff is unchanged") {
        check(SxbReconnectPolicy.retryDelayMs(1, 29_999) == 5_000L)
        check(SxbReconnectPolicy.retryDelayMs(1, 30_000) == 250L)
        check(SxbReconnectPolicy.retryDelayMs(2, 600_000) == 10_000L)
        check((1..5).map { SxbReconnectPolicy.retryDelayMs(it) } == listOf(5_000L, 10_000L, 20_000L, 40_000L, 60_000L))
        check(SxbReconnectPolicy.retryDelayMs(Int.MAX_VALUE) == 60_000L)
        check(SxbReconnectPolicy.resumeDelayMs(Int.MAX_VALUE) == 30_000L)
    }

    recoveryCase("a detected healthy drop fires once at 250 ms, never earlier") {
        RecoveryFixture().use { f ->
            f.connectFor(600_000)
            f.drop()
            repeat(20) {
                f.manager.onDisconnected()
                f.manager.onNetworkAvailable()
            }
            check(f.clock.pending() == 1)
            check(f.clock.nextDelayMs() == 250L)
            f.clock.advanceBy(249)
            check(f.attempts == 0)
            f.clock.advanceBy(1)
            check(f.attempts == 1 && f.clock.pending() == 0)
            check(f.logs.any { it.contains("250 ms") })
        }
    }

    recoveryCase("successive ten-minute front-proxy closures each earn one fast retry") {
        RecoveryFixture().use { f ->
            f.action = { f.connectFor() }
            repeat(12) {
                f.connectFor(600_000)
                f.drop()
                check(f.clock.nextDelayMs() == 250L)
                f.clock.advanceBy(250)
            }
            check(f.attempts == 12 && f.giveUps == 0)
        }
    }

    recoveryCase("an explicit loss can recover a stale connected status during network handoff") {
        RecoveryFixture().use { f ->
            f.connectFor(600_000)
            f.manager.onDisconnected()
            f.clock.advanceBy(250)
            check(f.attempts == 1)
        }
    }

    recoveryCase("a healthy fast retry followed by flapping still stops after five attempts") {
        RecoveryFixture().use { f ->
            f.action = { f.connectFor() }
            f.connectFor(600_000)
            f.drop()
            for (delay in listOf(250L, 10_000L, 20_000L, 40_000L, 60_000L)) {
                check(f.clock.nextDelayMs() == delay)
                f.clock.advanceBy(delay)
                f.clock.advanceBy(1_000)
                f.drop()
            }
            check(f.attempts == 5 && f.giveUps == 1 && f.clock.pending() == 0)
        }
    }

    recoveryCase("an unreachable server consumes five attempts over exactly 135 seconds") {
        RecoveryFixture().use { f ->
            f.action = { f.drop() }
            val start = f.clock.nowMs
            f.drop()
            f.clock.advanceBy(135_000)
            check(f.attempts == 5 && f.giveUps == 1 && f.clock.pending() == 0)
            check(f.clock.nowMs - start == 135_000L)
            f.clock.advanceBy(600_000)
            check(f.attempts == 5)
        }
    }

    recoveryCase("ten minutes offline costs no attempts or timers; resume keeps its 2 s settling delay") {
        RecoveryFixture().use { f ->
            f.connectFor(600_000)
            f.network = false
            f.manager.onNetworkLost(false)
            f.drop()
            f.clock.advanceBy(600_000)
            check(f.attempts == 0 && f.giveUps == 0 && f.clock.pending() == 0)
            f.network = true
            f.manager.onNetworkAvailable()
            check(f.clock.nextDelayMs() == 2_000L)
            f.clock.advanceBy(2_000)
            check(f.attempts == 1)
        }
    }

    recoveryCase("a lone network return inside the 3 s debounce window is not lost") {
        RecoveryFixture().use { f ->
            f.connectFor(30_000)
            f.drop()
            f.clock.advanceBy(50)
            f.network = false
            f.manager.onNetworkLost(false)
            f.clock.advanceBy(50)
            f.network = true
            f.manager.onNetworkAvailable()
            check(f.clock.nextDelayMs() == 2_000L)
            f.clock.advanceBy(2_000)
            check(f.attempts == 1)
        }
    }

    recoveryCase("radio loss at the deadline or a failed network query never dispatches") {
        for (queryFailure in listOf(false, true)) {
            RecoveryFixture().use { f ->
                f.connectFor(30_000)
                f.drop()
                if (queryFailure) f.networkQueryFails = true else f.network = false
                f.clock.advanceBy(250)
                check(f.attempts == 0 && f.clock.pending() == 0 && f.manager.isAwaitingNetwork())
                f.networkQueryFails = false
                f.network = true
                f.manager.onNetworkAvailable()
                f.clock.advanceBy(2_000)
                check(f.attempts == 1)
            }
        }
    }

    recoveryCase("a cancelled old timer cannot consume or clear a newer timer") {
        RecoveryFixture(ignoreCancellation = true).use { f ->
            f.connectFor(30_000)
            f.drop()
            f.network = false
            f.manager.onNetworkLost(false)
            f.network = true
            f.manager.onNetworkAvailable()
            f.clock.advanceBy(250)
            check(f.attempts == 0 && f.clock.nextDelayMs() == 1_750L)
            f.manager.onNetworkAvailable()
            check(f.clock.pending() == 1)
            f.clock.advanceBy(1_750)
            check(f.attempts == 1 && f.clock.pending() == 0)
        }
    }

    recoveryCase("a due second callback waits for the first callback to release the tunnel") {
        RecoveryFixture().use { f ->
            var depth = 0
            var maximumDepth = 0
            f.action = {
                depth++
                maximumDepth = maxOf(maximumDepth, depth)
                if (f.attempts == 1) {
                    f.drop()
                    f.clock.advanceBy(10_000)
                    check(f.attempts == 1)
                } else {
                    f.connectFor()
                }
                depth--
            }
            f.drop()
            f.clock.advanceBy(5_000)
            check(f.attempts == 2 && maximumDepth == 1 && f.clock.pending() == 0)
        }
    }

    recoveryCase("a queued retry is cancelled if the active callback establishes a tunnel") {
        RecoveryFixture().use { f ->
            f.action = {
                f.drop()
                f.clock.advanceBy(10_000)
                check(f.attempts == 1)
                f.connectFor()
            }
            f.drop()
            f.clock.advanceBy(5_000)
            check(f.attempts == 1 && f.clock.pending() == 0)
        }
    }

    recoveryCase("a network return during dispatch is replayed after the callback unlocks") {
        RecoveryFixture().use { f ->
            f.action = {
                f.network = false
                f.manager.onNetworkLost(false)
                f.network = true
                f.manager.onNetworkAvailable()
                f.manager.reevaluate()
                check(f.clock.pending() == 0)
            }
            f.drop()
            f.clock.advanceBy(5_000)
            check(f.attempts == 1 && f.clock.nextDelayMs() == 2_000L)
            f.action = { f.connectFor() }
            f.clock.advanceBy(2_000)
            check(f.attempts == 2 && f.clock.pending() == 0)
        }
    }

    recoveryCase("network flapping backs off until a session actually stays healthy") {
        RecoveryFixture().use { f ->
            f.action = { f.connectFor() }
            for (delay in listOf(2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L)) {
                f.network = false
                f.manager.onNetworkLost(false)
                f.drop()
                f.network = true
                f.manager.onNetworkAvailable()
                check(f.clock.nextDelayMs() == delay)
                f.clock.advanceBy(delay)
                f.clock.advanceBy(1_000)
            }
            f.clock.advanceBy(30_000)
            f.network = false
            f.manager.onNetworkLost(false)
            f.drop()
            f.network = true
            f.manager.onNetworkAvailable()
            check(f.clock.nextDelayMs() == 2_000L)
        }
    }

    recoveryCase("stop, permanent authentication failure and revocation cancel fast recovery") {
        for (reason in listOf("user_stop", "AUTH_FAILED", "device_revoked", "CONFIG_INVALID")) {
            RecoveryFixture().use { f ->
                f.connectFor(30_000)
                f.drop()
                f.manager.markStopped(reason)
                f.manager.onNetworkAvailable()
                f.manager.onDisconnected()
                f.clock.advanceBy(600_000)
                check(!f.manager.isEnabled() && f.attempts == 0 && f.clock.pending() == 0)
                f.manager.reset()
                f.manager.onNetworkAvailable()
                check(f.clock.pending() == 0)
                f.manager.enable()
                f.drop()
                f.clock.advanceBy(5_000)
                check(f.attempts == 1)
            }
        }
    }

    recoveryCase("duplicate connected callbacks do not restart the healthy-session clock") {
        RecoveryFixture().use { f ->
            f.connectFor(29_000)
            f.connectFor(1_000)
            f.drop()
            check(f.clock.nextDelayMs() == 250L)
        }
    }

    recoveryCase("SSH observes a closed session quickly without extra network probes") {
        check(SxbSshKeepAlive.INTERVAL_MS == 10_000)
        check(SxbSshKeepAlive.COUNT_MAX == 3)
        check(SxbSshKeepAlive.POLL_INTERVAL_MS == 500L)
        check(SxbSshKeepAlive.POLL_INTERVAL_MS + SxbReconnectPolicy.retryDelayMs(1, 600_000) == 750L)
        check(SxbSshKeepAlive.detectionWindowMs() == 40_500L)
        check(SxbSshKeepAlive.detectionWindowMs() + SxbReconnectPolicy.retryDelayMs(1, 600_000) == 40_750L)
    }
}

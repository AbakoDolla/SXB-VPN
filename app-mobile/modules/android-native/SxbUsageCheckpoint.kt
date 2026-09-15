package com.sxbvpn.vpnmodule

import java.io.IOException

/** A published lifetime counter must already survive a process restart. */
internal class SxbUsageCheckpoint(
    private val load: () -> Pair<Long, Long>,
    private val commit: (Pair<Long, Long>) -> Boolean,
) {
    private var durable: Pair<Long, Long>? = null
    private var pending: Pair<Long, Long>? = null

    @Synchronized
    fun read(): Pair<Long, Long> {
        pending?.let { return write(it) }
        return durable ?: load().also {
            check(it.first >= 0L && it.second >= 0L) { "USAGE_CHECKPOINT_INVALID" }
            durable = it
        }
    }

    @Synchronized
    fun write(snapshot: Pair<Long, Long>): Pair<Long, Long> {
        val floor = pending ?: durable ?: read()
        check(snapshot.first >= floor.first && snapshot.second >= floor.second) {
            "USAGE_CHECKPOINT_REGRESSION"
        }
        if (pending == null && snapshot == durable) return snapshot

        // SharedPreferences updates its memory cache even when commit fails.
        // Keep the unconfirmed value private until a successful retry.
        pending = snapshot
        if (!commit(snapshot)) throw IOException("USAGE_CHECKPOINT_WRITE_FAILED")
        durable = snapshot
        pending = null
        return snapshot
    }
}

package com.sxbvpn.vpnmodule

import android.content.Context
import android.content.SharedPreferences
import android.net.TrafficStats
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicInteger

private fun rejects(code: String, action: () -> Unit) {
    var failure: Exception? = null
    try { action() } catch (error: Exception) { failure = error }
    check(failure?.message == code) { "Expected $code, got $failure" }
}

private class MemoryPreferences(initial: Pair<Long, Long>) : SharedPreferences {
    @Volatile var disk = initial
    @Volatile var memory = initial
    @Volatile var failWrites = false
    @Volatile var onCommit: (() -> Unit)? = null
    val writes = AtomicInteger()

    override fun getLong(key: String, fallback: Long): Long = when (key) {
        "lifetime_upload_bytes" -> memory.first
        "lifetime_download_bytes" -> memory.second
        else -> fallback
    }

    override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
        var up = memory.first
        var down = memory.second
        override fun putLong(key: String, value: Long): SharedPreferences.Editor {
            when (key) {
                "lifetime_upload_bytes" -> up = value
                "lifetime_download_bytes" -> down = value
                else -> error("Unknown preference: $key")
            }
            return this
        }
        override fun commit(): Boolean {
            val captured = up to down
            memory = captured
            writes.incrementAndGet()
            onCommit?.invoke()
            if (failWrites) return false
            disk = captured
            return true
        }
    }
}

fun main() {
    var passed = 0
    fun scenario(name: String, action: () -> Unit) {
        action()
        passed++
        println("PASS native usage: $name")
    }

    scenario("failed reads never become a zero checkpoint") {
        var available = false
        val checkpoint = SxbUsageCheckpoint(
            load = { if (!available) throw IOException("READ_FAILED") else 9L to 13L },
            commit = { true },
        )
        rejects("READ_FAILED") { checkpoint.read() }
        available = true
        check(checkpoint.read() == 9L to 13L)
        rejects("USAGE_CHECKPOINT_INVALID") {
            SxbUsageCheckpoint({ -1L to 0L }, { true }).read()
        }
    }

    scenario("a pending write cannot be replaced by an older counter") {
        var disk = 99L to 199L
        var writable = false
        val checkpoint = SxbUsageCheckpoint({ disk }, {
            if (writable) { disk = it; true } else false
        })
        rejects("USAGE_CHECKPOINT_WRITE_FAILED") { checkpoint.write(100L to 200L) }
        rejects("USAGE_CHECKPOINT_REGRESSION") { checkpoint.write(99L to 201L) }
        rejects("USAGE_CHECKPOINT_REGRESSION") { checkpoint.write(101L to 199L) }
        check(disk == 99L to 199L)
        writable = true
        check(checkpoint.write(103L to 207L) == 103L to 207L)
        check(SxbUsageCheckpoint({ disk }, { true }).read() == 103L to 207L)
    }

    val mib = 1024L * 1024L
    val initial = 99L * mib to 199L * mib
    val store = MemoryPreferences(initial)
    val context = object : Context() {
        override fun getSharedPreferences(name: String, mode: Int): SharedPreferences {
            check(name == "sxb_usage_odometer")
            return store
        }
    }
    val manager = TrafficStatsManager()
    fun sample(up: Long, down: Long) {
        val read = CountDownLatch(1)
        TrafficStats.tx += up
        TrafficStats.rx += down
        TrafficStats.afterTxRead = { read.countDown() }
        try {
            check(read.await(4, TimeUnit.SECONDS)) { "Native poll did not run" }
            manager.getSessionStats()
        } finally {
            TrafficStats.afterTxRead = null
        }
    }

    manager.start(context)
    try {
        scenario("unchanged reads and startup do not write flash") {
            repeat(3) {
                check(manager.getStats(context).lifetimeUploadBytes == initial.first)
                check(TrafficStatsManager.persistedLifetime(context) == initial)
            }
            check(store.writes.get() == 0)
        }

        scenario("100 MiB cannot be exported while disk still contains 99 MiB") {
            store.failWrites = true
            sample(mib, 2 * mib)
            check(manager.getSessionStats().uploadBytes == mib)
            rejects("USAGE_CHECKPOINT_WRITE_FAILED") { manager.getStats(context) }
            rejects("USAGE_CHECKPOINT_WRITE_FAILED") { TrafficStatsManager.persistedLifetime(context) }
            check(store.disk == initial)
            check(store.memory == 100L * mib to 201L * mib)
            store.failWrites = false
            val exported = manager.getStats(context)
            check(exported.lifetimeUploadBytes == store.disk.first)
            check(exported.lifetimeDownloadBytes == store.disk.second)
            check(exported.uploadBytes == mib) { "A failed write must not sample the same delta twice" }
            check(SxbUsageCheckpoint({ store.disk }, { true }).read() == 100L * mib to 201L * mib)
        }

        scenario("concurrent polls and exports cannot publish an uncommitted snapshot") {
            sample(11, 13)
            val captured = initial.first + TrafficStats.tx to initial.second + TrafficStats.rx
            val entered = CountDownLatch(1)
            val release = CountDownLatch(1)
            val readers = Executors.newFixedThreadPool(2)
            store.onCommit = {
                entered.countDown()
                check(release.await(5, TimeUnit.SECONDS)) { "Commit gate timed out" }
            }
            try {
                val first = readers.submit<TrafficStatsManager.TrafficSnapshot> { manager.getStats(context) }
                check(entered.await(3, TimeUnit.SECONDS))
                TrafficStats.tx += 7
                TrafficStats.rx += 5
                val started = CountDownLatch(1)
                val second = readers.submit<TrafficStatsManager.TrafficSnapshot> {
                    started.countDown()
                    manager.getStats(context)
                }
                check(started.await(1, TimeUnit.SECONDS))
                try {
                    second.get(50, TimeUnit.MILLISECONDS)
                    error("A concurrent export escaped the commit gate")
                } catch (_: TimeoutException) {
                    // Expected: neither a cache value nor a newer sample is published.
                }
                release.countDown()
                val exported = first.get(3, TimeUnit.SECONDS)
                check(exported.lifetimeUploadBytes == captured.first)
                check(exported.lifetimeDownloadBytes == captured.second)
                second.get(3, TimeUnit.SECONDS)
                check(store.disk.first >= exported.lifetimeUploadBytes)
                check(store.disk.second >= exported.lifetimeDownloadBytes)
            } finally {
                release.countDown()
                store.onCommit = null
                readers.shutdownNow()
            }
        }

        scenario("shutdown samples the tail, persists it, and is idempotent") {
            TrafficStats.tx += 17
            TrafficStats.rx += 19
            manager.sampleBeforeStop()
            TrafficStats.tx += 3
            TrafficStats.rx += 5
            val expected = initial.first + TrafficStats.tx to initial.second + TrafficStats.rx
            manager.stop()
            check(store.disk == expected)
            val exported = manager.getStats(context)
            check(exported.lifetimeUploadBytes == expected.first)
            check(exported.lifetimeDownloadBytes == expected.second)
            val writes = store.writes.get()
            TrafficStats.tx += 123
            manager.stop()
            check(store.disk == expected)
            check(store.writes.get() == writes)
        }

        scenario("automatic recovery restarts sampling on the same manager") {
            val expected = store.disk
            manager.start(context)
            sample(5, 7)
            val resumed = manager.getStats(context)
            check(resumed.uploadBytes == 5L)
            check(resumed.downloadBytes == 7L)
            check(resumed.lifetimeUploadBytes == expected.first + 5)
            check(resumed.lifetimeDownloadBytes == expected.second + 7)
            manager.stop()
        }

        scenario("a new service resumes the durable lifetime without repeating the old session") {
            val restarted = TrafficStatsManager()
            val expected = store.disk
            check(restarted.getStats(context).lifetimeUploadBytes == expected.first)
            restarted.start(context)
            try {
                check(restarted.getStats(context).uploadBytes == 0L)
                check(restarted.getStats(context).downloadBytes == 0L)
                check(restarted.getStats(context).lifetimeDownloadBytes == expected.second)
            } finally {
                restarted.stop()
            }
        }
    } finally {
        store.onCommit = null
        store.failWrites = false
        manager.stop()
    }
    println("$passed native usage scenarios passed")
}

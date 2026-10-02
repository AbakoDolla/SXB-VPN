import java.lang.management.ManagementFactory

private class FrameSink : OutputStream() {
    var bytes = 0L
    var writes = 0L
    override fun write(value: Int) { bytes++; writes++ }
    override fun write(value: ByteArray, offset: Int, length: Int) { bytes += length; writes++ }
}

private fun allocationBytes(): Long {
    val bean = ManagementFactory.getThreadMXBean() as? com.sun.management.ThreadMXBean ?: return -1
    if (!bean.isThreadAllocatedMemorySupported) return -1
    if (!bean.isThreadAllocatedMemoryEnabled) bean.isThreadAllocatedMemoryEnabled = true
    return bean.getThreadAllocatedBytes(Thread.currentThread().id)
}

private fun bulkFrames(round: Int) {
    val payload = ByteArray(32 * 1024) { (it * 31).toByte() }
    val sink = FrameSink()
    var events = 0L
    val output = WsOutputStream(sink) { events++ }
    repeat(64) { output.write(payload) }
    events = 0
    val beforeWrites = sink.writes
    val beforeBytes = sink.bytes
    val allocationBefore = allocationBytes()
    val started = System.nanoTime()
    repeat(2048) { output.write(payload) }
    val elapsed = System.nanoTime() - started
    val allocated = allocationBytes().let { if (it < 0 || allocationBefore < 0) -1 else it - allocationBefore }
    check(sink.writes - beforeWrites == 2048L)
    check(sink.bytes - beforeBytes == 2048L * (payload.size + 8))
    println("FRAME_BENCH round=$round payload_bytes=${2048L * payload.size} elapsed_ns=$elapsed allocated_bytes=$allocated event_calls=$events")
}

fun main() {
    repeat(4) { bulkFrames(it) }
}

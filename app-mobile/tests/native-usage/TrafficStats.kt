package android.net

object TrafficStats {
    const val UNSUPPORTED = -1
    @Volatile var tx = 0L
    @Volatile var rx = 0L
    @Volatile var afterTxRead: (() -> Unit)? = null
    fun getUidTxBytes(uid: Int): Long {
        val value = tx
        afterTxRead?.invoke()
        return value
    }
    fun getUidRxBytes(uid: Int): Long = rx
}

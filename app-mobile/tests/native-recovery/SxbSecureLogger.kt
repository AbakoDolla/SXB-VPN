package com.sxbvpn.vpnmodule

// Only the Android logging sink is replaced. The policy, manager and coroutines
// are production implementations compiled unchanged by the recovery gate.
object SxbSecureLogger {
    enum class VpnEvent {
        RECONNECT_ENABLED, RECONNECT_DISABLED, RECONNECT_SCHEDULED,
        RECONNECT_FIRED, RECONNECT_GIVEUP, RECONNECT_RESET, RECONNECT_SKIP,
        RECONNECT_WAIT_NETWORK, RECONNECT_NETWORK_BACK,
    }

    @Suppress("UNUSED_PARAMETER")
    fun vpn(event: VpnEvent) = Unit
}

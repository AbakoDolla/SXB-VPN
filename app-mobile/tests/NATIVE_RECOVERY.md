# Native automatic recovery

## Timing contract

- A tunnel established for **at least 30 seconds** earns **one 250 ms retry**,
  instead of the previous 5,000 ms wait, when a usable network is present.
- The fast attempt counts toward the existing five-attempt budget. Consecutive
  failures then wait **10, 20, 40 and 60 seconds**. A fresh, unproven connection
  retains **5, 10, 20, 40 and 60 seconds**. Merely completing a handshake does
  not reset either budget; a briefly connected, flapping tunnel cannot retry
  forever. Another healthy session restores the fast first attempt.
- No network means no timer and no attempt. Network return retains the
  **2, 4, 8, 16, 30 second** settling backoff; a healthy session resets it.
  A sole return event within the three-second debounce window is not lost.
- Timer generations reject cancelled callbacks. A coroutine mutex serializes
  the entire synchronous reconnect callback, including draining the old tunnel.
  Stop and connectivity are checked again after draining. Manual stop,
  authentication rejection, access/device revocation and privacy withdrawal
  still disarm recovery. Every new dispatch retains the native access checks.

These are **policy waits**, not measured end-to-end Android recovery times:
SSH observes an explicit close at the next 500 ms local-state poll, without
sending additional network probes. Its
unchanged 10-second keepalive interval and three tolerated unanswered probes
give a nominal silent-peer detection budget of **40.5 seconds** including polling.
Thus the policy-plus-detection budgets become up to **750 ms** for an
observed transport close and **40.75 seconds** for a silent peer, versus 8 and
48 seconds previously. Android scheduling, socket teardown, DNS, transport/TLS
negotiation, authentication and TUN creation add variable time. Drain waits
remain bounded by the existing release-thread join and dispatch-idle deadlines;
they are not shortened at the cost of overlapping tunnels.

No keepalive tolerance, SSH/payload transport, sing-box, TLS validation, access
decision, traffic counter or quota enforcement is changed by this policy.

## Focused checks

From `app-mobile`, with existing Node dependencies:

```powershell
node .\node_modules\tsx\dist\cli.mjs --test .\tests\native-recovery.test.ts
```

This source-contract gate exposes the old **5,000 ms** delay, verifies wiring
and protects the unchanged liveness/access boundaries. It is not a substitute
for execution of Kotlin.

On a worker with an **already provisioned JDK and Kotlin 2.1.20**, set `KOTLINC`
to the compiler executable and run:

```powershell
node .\tests\run-reconnect-recovery.cjs
```

`JAVA` can select the existing Java executable. The coroutine jar is taken from
the Kotlin distribution's `lib` directory; `SXB_COROUTINES_JAR` can override it.
There are **no toolchain or package downloads** in this focused gate. Build
outputs stay inside the checkout and are removed when the gate exits.

The JVM gate executes the **actual production manager and policy**, replacing
only the Android logging sink and injecting a virtual clock, wait boundary and
deterministic coroutine dispatcher.
It covers deadline accuracy, twelve successive ten-minute sessions, flapping,
offline/no-callback loss, late cancelled timers, callback serialization, network
return during drain, stop/revocation and duplicate connection events.

The existing `node tests/run-stability-policy.cjs` gate also invokes this focused
JVM gate after its original checks, using its already provisioned compiler.
No workflow, device, host setting or production service needs changing.

## Durable traffic snapshots

The same JVM entry point also compiles the production `TrafficStatsManager`
and `SxbUsageCheckpoint`, with small Android API fixtures under `native-usage`.
`NativeUsageTest.kt` checks rejected reads, failed commits whose memory cache
is already ahead of disk, concurrent exports, final sampling, repeated stop,
service restart and skipped writes for unchanged values. The 99 MiB on disk /
100 MiB measured case must never export 100 MiB until its commit succeeds.

This is a deterministic storage/lifecycle check, not an emulator, a test of
the device's TUN statistics, or a measurement of Internet recovery time.

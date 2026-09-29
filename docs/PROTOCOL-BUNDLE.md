# Protocol bundle compatibility

Reference: password-protected user archive, SHA256
`ebc681185835798af6b0ee9002a59da1eac2b1f10d4d528650c673eec40ac291`.
The archive is reference data, not a dependency or installation source.
This layer starts at `2c07535ec2932f7a470ff90ef8c6a54f44a9d803`.

## Coverage matrix

| Supplied capability | SXB integration | Evidence and limits |
|---|---|---|
| Settings integer/string `tunnelType` 1-7 | Pure `server/services/protocol-bundle.ts`, used by mobile/server | `scripts/tests/protocol-bundle.test.mjs`; explicit mode, no heuristic reinterpretation |
| SSH 1, direct and Dropbear payload | Existing JSch protected socket; explicit no-HTTP-response option | Source-derived JVM socket test; old payload profiles retain their response handling |
| SSH 2, remote proxy and payload | Existing logical target versus physical proxy separation | Source-derived CONNECT/banner and HTTP 403 tests; never fabricate 200 |
| SSH 3/4, TLS/SNI then optional payload | Existing TLS socket and payload proxy; physical sslPort distinct from payload sshPort | Verified loopback TLS, wrong-hostname rejection before payload; no trust-all factory |
| SSH private key | Load `privateKeyBase64` into existing JSch; optional passphrase; clear temporary byte arrays | Actual plain/encrypted memory-key import; `keyPath` never opened; unsupported keys fail through JSch |
| Payload dialect | method/protocol/ssh/random and legacy cyclic rotate; preserve CRLF/splits | Opt-in dialect, real split timing; rotation uses stable technical identity, not per-start accessAttempt; state lasts for the service instance |
| DNSTT 5 | Map dnsKey/chaveKey/serverNameKey to existing DNSTT+SSH | Existing pinned Mygod source and SCM_RIGHTS socket protection; never package bypass |
| UDP 6 / udp.json | Explicit `hysteria1`, sing-box `type:hysteria` | This is Hysteria V1, despite folder/guide title; no bundled executable |
| Genuine Hysteria2 | Retain `hysteria2`/`hy2` and historical detector alias `hysteria` | Preserve bandwidth, obfs/password, SNI/TLS; never reinterpret old alias as V1 |
| V2Ray JSON / v2rayjson | Unwrap plaintext JSON and translate complete graph | Encrypted ConfigCrypto wrapper is unavailable: request plaintext export, never guess decryption |
| VMess recipe / URI | Existing transport; retain security/alterId and legacy share-object aliases | Shared pure URI reader; field-by-field mobile/server parity; native graph and loopback engine evidence |
| VLESS recipe / URI | Existing transport/TLS/SNI/WS/gRPC | Preserve existing limitations on unrelated Xray-only transports |
| Trojan recipe / URI | Existing engine; explicit TLS/Reality, password, SNI, transport and share fields | Reality fields retained; missing Reality key rejected; no implicit insecure flag |
| Shadowsocks recipe / URI | Complete server conversion, SS2022 key validation | Validate algorithm and each base64 key length, not just JSON shape |
| Remote SOCKS recipe | Complete auth/no-auth conversion and final route selection | Remote proxy stays inside libbox and under existing access controls |
| WireGuard recipe / INI | Modern libbox endpoint for keepAlive; address/peers/PSK/reserved/MTU/remoteDNS | Multiple peers supported in complete JSON; multi-peer INI rejected explicitly, not truncated; no second kernel TUN |
| Recipe replacement | Preserve complete chosen outbound, never merge incompatible settings | Reject ambiguous/multiple incompatible definitions, no shipped demo address/UUID |
| Routing/DNS/stats | Existing SXB graph, DNS loop guard and real counters; exact host-to-IP DNS mappings | Native graph tests ensure a hosts table cannot become endpoint bootstrap DNS; no reference-template bypass defaults |
| Catalog example | Reject the incomplete catalog with instructions to select a host/mode and supply complete settings | No arbitrary first host/protocol, invented resolver, reinterpretation of pubkey, or demo provisioning |
| DNS and UDPGW settings | Existing tunneled DNS and SSH UDPGW | Do not enable direct DNS/UDP fallback; unsupported preferences reported |
| Keepalive/TCPNoDelay/maxThreads | Existing bounded SXB keepalive/relay ownership | Do not import foreign thread/reconnect policy |
| App filters/bypass/tethering | Preserve existing SXB controls, do not import exclusions | A subnet flag does not provide Android tethered VPN support |
| Lifecycle / access / storage | Keep single SxbVpnService, SxbAccessControl, generation guards, durable ledger | No foreign timeLeft countdown, DES store, encrypted-store replacement or getIsRunning-as-connected |
| ABI / native packaging | Keep pinned libbox1.12.9 + DNSTT, existing ARM64/ARM32 gates | No imported ELF/JAR/AAR execution; ARM32 BadVPN vs ARM64 Go is intentional; candidate Android APK remains a separately coordinated gate |
| Foreign app code | No Trilead/jsocks/spongycastle vendoring, ads/maps/Cronet, missing Activity/R/telemetry classes | Not protocol functionality; no permissions or business-logic additions |

Parent provenance review identifies 533 files, 260 unique contents and 273
byte-identical copies. Vendored libraries were classified/hashed, not claimed
to have been reviewed line by line. Binary metadata identifies the supplied AAR
as Xray v1.8.1; geoip/geosite assets are inside it (contrary to the guide).
That does not authorize replacing SXB's engine or copying the assets.

## Import contract

Recognized legacy settings may be previewed before import. Ambiguous SSH formats
remain blocked in the dashboard. Imported technical fields stay in the existing
encrypted canonical configuration. Foreign access, application bypass, local
path and UI settings are not authoritative and produce explicit diagnostics.
Imported `insecure=true` from the bundle is not automatically honored.

The shared readers live in `server/services/protocol-bundle.ts`,
`protocol-uri.ts` and `xray-translate.ts`. They contain no Node filesystem,
network or crypto imports. Metro watches this source directory; Android's push
path filter includes these exact embedded files. The established VLESS URI
parser remains unchanged.

Unsupported external encryption requires a plaintext export. Settings mode 7
rejects DNS aliases/matchers that cannot be faithfully translated; historical
raw Xray imports retain their previous omission with an explicit warning.
Xray mux is diagnosed, not silently enabled as an incompatible sing-box mux.
Secondary DNS preferences and foreign app/thread policies are not promises of
new runtime behavior. The separate server-account provisioning managers are
unchanged: complete profiles, not new production account/server provisioning,
are the compatibility surface.

## Executable evidence

The committed checks cover parsing, encrypted storage, and the actual native
builders separately:

- `scripts/tests/protocol-bundle.test.mjs`: modes 1-7, all six recipes,
  mobile/server parity, URI aliases/Reality/encoding/IPv6, cipher/key checks and
  explicit rejection of ambiguous or unsupported input.
- `scripts/tests/profile-import-dns.test.mjs`: real authenticated routers with
  an isolated Prisma-shaped store; six mode-7 graphs plus SSH/Hysteria V1
  survive encrypted persistence without exposing credentials.
- `app-mobile/tests/ProtocolCompatibilityTest.kt`: production H1/H2/WireGuard,
  DNS bootstrap/hosts and payload helpers, including two accessAttempt values
  advancing rotation and actual profile/payload changes resetting it.
- `app-mobile/tests/run-ssh-compatibility.cjs`: extracts the production socket,
  TLS, payload and inline JSch key-loading code; verifies protected-before-dial
  sockets, CONNECT/403, Dropbear, TLS identity/order, split timing and keys.
- `scripts/tests/xray-runtime-fixture.mjs`: generates 14 canonical/legacy recipe
  graphs through extracted production Kotlin and `SxbEngineSchema`, with
  structural DNS/endpoint assertions. `scripts/run-android-policy-gates.sh`
  sends each resulting graph to pinned `libbox.CheckConfig` in native CI.

Local closure passed the complete mobile regression (788 tests), mobile and
dashboard typechecks, dashboard/server builds, the native stability/access/
recovery/usage gates, source-derived SSH checks and all 14 graph assertions.
An actual Android Metro/Hermes export also passed; this is not an APK build.
Desktop sing-box 1.12.9 loopback probes additionally exercised the six recipe
families, SS2022, H1 and H2; source-hashed helper probes exercised H1/H2/WireGuard
with verified local certificates, PSK/keepalive and exact byte counters.

Network evidence uses synthetic loopback peers only. Engine configuration
acceptance is not a successful VPN connection, and desktop loopback traffic is
not Android device validation. No ADB, phone access, production calls, deployment,
or account/quota traffic is part of this work.

## SSH data-path and local configuration hardening

The SSH regression runner now uses an authenticated, loopback-only `ssh2` peer
with random credentials and ports. It exercises the production JSch/SOCKS relay:
channel refusal, immediate binary data, 256 KiB transfers, TCP half-close in
both directions, byte counters and disconnection of an idle client. A refused
channel must never receive a SOCKS success reply. JSch streams must exist before
opening the channel, and an upload EOF must not truncate the download.

Explicitly chained HTTP payloads can consume intermediate redirects without
following their Location. A final redirect alone is still refused. The parser
bounds time, response count (16), headers (8 KiB), each body (64 KiB) and total
input (128 KiB), rejects ambiguous framing/captive portals, and preserves SSH
bytes. A short idle period after an accepted tunnel allows client-first SSH
banners. An explicit WebSocket handshake on the final request remains framed.
Failed socket protection aborts before dialing; TLS failures close the physical
socket, with no downgrade to cleartext.

On Android binaries exposing `encryptVpnConfig`/`decryptVpnConfig`, profile
encryption happens in Android Keystore without exporting its AES key to JS.
Existing `gcm:` profiles migrate lazily under the configuration mutation queue;
failed migrations retain the previous copy, and deletion/update wins over a
stale migration. Web, iOS and older native binaries retain their existing
storage path. A `v1:` profile cannot fall back to that older decryption path.
Hardware-backed protection depends on the device, not just the API used.

Each native start now receives the path to its own encrypted handoff file, not
the full configuration as an Intent extra. Native restart storage uses atomic,
verified encrypted writes. Legacy plaintext is accepted for migration only
when there is no encrypted restart vault; a damaged vault fails explicitly.
Revocation deletes only the encrypted version it actually checked, preserving
a concurrently replaced profile. Transport-cache fingerprints no longer
contain plaintext SNI/configuration fields.

Native reconnect already reuses the authorized in-memory configuration.
Access checks/session proofs are separate from full provisioning. DNS stays
tunneled and UDPGW remains an explicit profile option.

**Limits:** storage encryption does not hide the IP of a directly contacted
SSH server or a plaintext HTTP payload. Nor can these changes guarantee
secrecy on a fully compromised/rooted device.
The software bridge fixtures and loopback transfers are not proof of Android
Keystore hardware isolation or successful traffic on a carrier network.

## Opt-in SSH gateway

The gateway keeps provider credentials, destination, payload and host-key
fingerprint on the backend. A capable Android binary advertises
`X-SXB-SSH-Relay: 1`; only profiles explicitly listed in
`SXB_SSH_RELAY_PROFILE_IDS` (comma-separated profile IDs) receive the relay
configuration. Empty/unset means disabled. Other protocols, profiles and
older binaries retain the direct path. Migrating an existing direct cache
requires one successful provisioning; failed provisioning does not prove that
the old destination has disappeared from that device.

Requirements before opting in a profile:

- Authenticated device session and enrolled proof key, current subscription.
- Encrypted canonical profile with verified hash and a supplier-confirmed
  OpenSSH SHA256 host-key fingerprint; never learn the fingerprint blindly.
- SSH destination reachable from the VPS, not merely from the mobile carrier.
  Direct SSH, TLS and supported HTTP payloads are accepted. SlowDNS,
  insecure TLS, real WebSocket framing, split/rotating templates and conflicting
  port overrides are refused rather than silently reinterpreted.
- TLS ingress at the fixed backend URL. The deployment adds only an exact
  `/api/mobile/ssh-relay` location to the site's TLS vhost, using the backend
  port from `.env`. Other sites and API routes are preserved. The candidate
  configuration is backed up, checked with `nginx -t` and restored on rejection.
  An ambiguous/conflicting vhost requires manual review; it is not guessed.

The mobile opens a protected, hostname-verified TLS socket with optional
compiled backend pins, then requests an authenticated HTTP Upgrade. Its
ticket has a distinct signing key derivation/audience and is unusable without
a fresh device proof and an immutable connection binding. Internal SSH offers
only forwarding, never shell, exec or SFTP. Supplier fingerprint verification
precedes password authentication. Private/local upstream addresses are refused.
The gateway itself remains visible to network observers.

Tickets last at most seven days, bounded by the activation session and initial
configuration validity. Before starting a new connection, the app renews a
near-expired ticket at `POST /api/provision/ssh-relay/refresh`; the response
contains only `ticket` and `expiresAt`, not the provider configuration.
Refresh requires the same valid session, device, subscription and profile hash.
Native reconnect reuses its current ticket; it does not extend an expired
activation session or renew an expired credential independently of JS.

The server meters forwarded plaintext channel bytes transactionally before
delivery, applies backpressure and prevents concurrent quota overspend. Mobile
usage receipts do not debit them again. Connections are revalidated every
30 seconds and close on expiry/revocation. Limits are 128 connections, two per
client, 32 pending handshakes per ingress peer and 64 channels per connection.
Accounting currently uses a transaction per chunk; no high-load throughput
claim is made. The nullable `mobile_connections.relayConfigHash` migration is
additive and runs through the existing backup/migration gate.

Roll out only after a candidate APK, real device traffic and the chosen
supplier have been verified. Removing a profile from the allowlist and
restarting the backend disables its relay access; existing relay caches do
not silently downgrade to direct connections. Retain the database column on
rollback. Reprovisioning a direct profile is an explicit operational decision
that exposes the provider destination again.

Before authenticating to a supplier, the manual `vps-audit.yml` mode
`ssh-relay-preflight` can test the deployed direct/plain HTTP-payload transport
from the VPS without changing profiles. Supply a temporary production
environment secret named `SXB_SSH_RELAY_PREFLIGHT_CONFIG`: base64-encoded JSON
with only `host`, numeric `port`, `payload` and `expectedFingerprint`.
The fingerprint must come from a trusted source (`SHA256:...`, or a legacy
`MD5:xx:...` for comparison only). Passwords and usernames are rejected.
The probe stops at host-key verification, even on a match, and logs only
safe result categories. It does not prove authentication or data transfer
works. Remove the temporary secret after the run. An unreachable result from
the VPS does not disprove operation on a particular mobile operator's network.

Coverage includes real loopback SSH transfers, TLS hostname rejection,
cancellation, provider fingerprint refusal, half-closes, proof replay,
configuration replacement and quota concurrency. The PostgreSQL integration
runner also exercises encrypted provisioning, immutable registration,
credential renewal and anti-double-accounting through real HTTP handlers.
JVM fixtures stub Android Keystore/proof APIs; they are not a substitute for
an APK/device/carrier acceptance test.

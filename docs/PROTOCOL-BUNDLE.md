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

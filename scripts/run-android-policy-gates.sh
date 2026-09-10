#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/sxb-kotlin.XXXXXX")"
trap 'rm -rf "$HARNESS"' EXIT

curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
  https://github.com/JetBrains/kotlin/releases/download/v2.1.20/kotlin-compiler-2.1.20.zip \
  --output "$HARNESS/kotlin.zip"
echo "a118197b0de55ffab2bc8d5cd03a5e39033cfb53383d6931bc761dec0784891a  $HARNESS/kotlin.zip" | sha256sum --check --strict
curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
  https://repo.maven.apache.org/maven2/org/json/json/20240303/json-20240303.jar \
  --output "$HARNESS/json.jar"
echo "3cf6cd6892e32e2b4c1c39e0f52f5248a2f5b37646fdfbb79a66b46b618414ed  $HARNESS/json.jar" | sha256sum --check --strict
unzip -q "$HARNESS/kotlin.zip" -d "$HARNESS"
export KOTLINC="$HARNESS/kotlinc/bin/kotlinc"
export SXB_JSON_JAR="$HARNESS/json.jar"
chmod +x "$KOTLINC"

cd "$ROOT/app-mobile"
node tests/run-play-encryption.cjs
node tests/run-access-policy.cjs
node tests/run-stability-policy.cjs
node scripts/prepare-geosite.cjs
node --experimental-strip-types ../scripts/tests/xray-runtime-fixture.mjs "$HARNESS/xray"
"$KOTLINC" "$HARNESS/xray/XrayRuntimeHarness.kt" modules/android-native/SxbTunnelPolicy.kt -classpath "$SXB_JSON_JAR" \
  -include-runtime -d "$HARNESS/xray/harness.jar"
java -cp "$HARNESS/xray/harness.jar:$SXB_JSON_JAR" XrayRuntimeHarnessKt \
  "$HARNESS/xray/canonical.json" "$HARNESS/xray/runtime.json"
go -C ../scripts/tests/singbox-engine-check run -mod=mod \
  -tags with_gvisor,with_quic,with_wireguard,with_ech,with_utls,with_clash_api \
  . "$HARNESS/xray/runtime.json" "$ROOT/app-mobile/build/engine-data"
go -C ../scripts/tests/singbox-engine-check build -mod=mod \
  -tags with_gvisor,with_quic,with_wireguard,with_ech,with_utls,with_clash_api \
  -o "$HARNESS/sing-box" github.com/sagernet/sing-box/cmd/sing-box
SXB_SINGBOX_TEST_BIN="$HARNESS/sing-box" \
  SXB_ENGINE_RUNTIME="$HARNESS/xray/runtime.json" \
  SXB_ENGINE_DATA="$ROOT/app-mobile/build/engine-data" \
  node --test ../scripts/tests/tcp-dns-chain.mjs

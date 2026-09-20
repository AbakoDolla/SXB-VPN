#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/sxb-kotlin.XXXXXX")"
trap 'rm -rf "$HARNESS"' EXIT

# ── Outils épinglés, téléchargés une seule fois ─────────────────────────────
#
# Le compilateur Kotlin pèse environ 80 Mo, et il était retéléchargé puis
# dézippé à CHAQUE build : mesuré sur la chaîne d'intégration, ces deux
# fichiers représentaient l'essentiel des 95 secondes de cette étape.
#
# Ils sont pourtant immuables — une version figée, vérifiée par empreinte. Les
# conserver entre deux builds ne peut donc rien changer au résultat : le
# contrôle d'empreinte s'exécute de la même façon sur un fichier restauré que
# sur un fichier fraîchement téléchargé, et refuse le même contenu altéré.
#
# `SXB_OUTILS_CACHE` désigne où les garder. Sans cette variable, le
# comportement d'origine est conservé : téléchargement dans un dossier
# temporaire, effacé à la sortie.
CACHE="${SXB_OUTILS_CACHE:-$HARNESS}"
mkdir -p "$CACHE"

KOTLIN_ZIP="$CACHE/kotlin-compiler-2.1.20.zip"
KOTLIN_SHA="a118197b0de55ffab2bc8d5cd03a5e39033cfb53383d6931bc761dec0784891a"
JSON_JAR="$CACHE/json-20240303.jar"
JSON_SHA="3cf6cd6892e32e2b4c1c39e0f52f5248a2f5b37646fdfbb79a66b46b618414ed"

# Rend vrai quand le fichier existe ET porte l'empreinte attendue. Un fichier
# tronqué par un build interrompu est ainsi retéléchargé plutôt que réutilisé.
empreinte_ok() {
  [ -f "$1" ] && echo "$2  $1" | sha256sum --check --status
}

if empreinte_ok "$KOTLIN_ZIP" "$KOTLIN_SHA"; then
  echo "[outils] compilateur Kotlin réutilisé depuis le cache"
else
  curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
    https://github.com/JetBrains/kotlin/releases/download/v2.1.20/kotlin-compiler-2.1.20.zip \
    --output "$KOTLIN_ZIP"
  echo "$KOTLIN_SHA  $KOTLIN_ZIP" | sha256sum --check --strict
fi

if empreinte_ok "$JSON_JAR" "$JSON_SHA"; then
  echo "[outils] bibliothèque JSON réutilisée depuis le cache"
else
  curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
    https://repo.maven.apache.org/maven2/org/json/json/20240303/json-20240303.jar \
    --output "$JSON_JAR"
  echo "$JSON_SHA  $JSON_JAR" | sha256sum --check --strict
fi

unzip -q "$KOTLIN_ZIP" -d "$HARNESS"
export KOTLINC="$HARNESS/kotlinc/bin/kotlinc"
export SXB_JSON_JAR="$JSON_JAR"
chmod +x "$KOTLINC"

cd "$ROOT/app-mobile"
# `run-play-encryption.cjs` a disparu avec la chaîne Google Play : la porte de
# chiffrement qu'il vérifiait n'existe plus.
node tests/run-access-policy.cjs
node tests/run-stability-policy.cjs
node scripts/prepare-geosite.cjs
node --experimental-strip-types ../scripts/tests/xray-runtime-fixture.mjs "$HARNESS/xray"
"$KOTLINC" "$HARNESS/xray/XrayRuntimeHarness.kt" modules/android-native/SxbTunnelPolicy.kt \
  modules/android-native/SxbEngineSchema.kt -classpath "$SXB_JSON_JAR" \
  -include-runtime -d "$HARNESS/xray/harness.jar"
java -cp "$HARNESS/xray/harness.jar:$SXB_JSON_JAR" XrayRuntimeHarnessKt \
  "$HARNESS/xray/canonical.json" "$HARNESS/xray/runtime.json"
go -C ../scripts/tests/singbox-engine-check run -mod=mod \
  -tags with_gvisor,with_quic,with_wireguard,with_utls,with_clash_api,with_conntrack \
  . "$HARNESS/xray/runtime.json" "$ROOT/app-mobile/build/engine-data"
go -C ../scripts/tests/singbox-engine-check build -mod=mod \
  -tags with_gvisor,with_quic,with_wireguard,with_utls,with_clash_api,with_conntrack \
  -o "$HARNESS/sing-box" github.com/sagernet/sing-box/cmd/sing-box
SXB_SINGBOX_TEST_BIN="$HARNESS/sing-box" \
  SXB_ENGINE_RUNTIME="$HARNESS/xray/runtime.json" \
  SXB_ENGINE_DATA="$ROOT/app-mobile/build/engine-data" \
  node --test ../scripts/tests/tcp-dns-chain.mjs

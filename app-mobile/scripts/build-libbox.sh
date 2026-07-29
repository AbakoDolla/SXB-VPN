#!/usr/bin/env bash
#
# build-libbox.sh — Construit le moteur sing-box embarqué (libbox.aar)
#
# ═══════════════════════════════════════════════════════════════════════════
# POURQUOI
# ═══════════════════════════════════════════════════════════════════════════
# L'app embarquait auparavant le binaire CLI `sing-box` dans ses assets, puis
# l'exécutait via ProcessBuilder. Ce montage ne peut pas fonctionner :
#
#   • Android 10+ (API 29) interdit d'exécuter un binaire depuis le répertoire
#     privé de l'app (W^X) → « error=13, Permission denied ».
#   • Le CLI ne sait pas recevoir le descripteur du TUN : le champ JSON
#     `file_descriptor` n'existe pas dans le schéma sing-box, il n'est peuplé
#     que par l'API Go `libbox` (PlatformInterface.OpenTun).
#
# Ce script produit `libbox.aar`, la même bibliothèque que celle utilisée par
# sing-box for Android. Le moteur tourne alors DANS le process de l'app et
# reçoit le TUN directement — c'est ce qui fait apparaître la clé VPN dans la
# barre d'état Android.
#
# ═══════════════════════════════════════════════════════════════════════════
# PRÉREQUIS
# ═══════════════════════════════════════════════════════════════════════════
#   • Go >= 1.23
#   • JDK 17
#   • Android SDK + NDK (ANDROID_HOME / ANDROID_NDK_HOME)
#
# USAGE
#   ./scripts/build-libbox.sh                 # version par défaut
#   SING_BOX_VERSION=v1.11.15 ./scripts/build-libbox.sh
#
set -euo pipefail

# Version de sing-box à compiler. Épinglée pour des builds reproductibles.
SING_BOX_VERSION="${SING_BOX_VERSION:-v1.11.15}"
GOMOBILE_VERSION="${GOMOBILE_VERSION:-v0.1.4}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$APP_MOBILE_DIR/libs"
OUT_AAR="$OUT_DIR/libbox.aar"

echo "═══════════════════════════════════════════════════════════"
echo " SXB VPN — build libbox (sing-box $SING_BOX_VERSION)"
echo "═══════════════════════════════════════════════════════════"

# ── Localisation de Go ────────────────────────────────────────────────────────
# Sur les runners GitHub Ubuntu 24.04, Go n'est pas sur le PATH par défaut :
# il est fourni comme « cached tool » sous le hostedtoolcache. On le récupère
# donc explicitement si `go` est introuvable, ce qui évite d'imposer une étape
# actions/setup-go dans le workflow.
if ! command -v go >/dev/null 2>&1; then
  TOOLCACHE="${AGENT_TOOLSDIRECTORY:-${RUNNER_TOOL_CACHE:-/opt/hostedtoolcache}}"
  if [ -d "$TOOLCACHE/go" ]; then
    GO_DIR="$(find "$TOOLCACHE/go" -maxdepth 2 -mindepth 2 -type d -name 'x64' | sort -V | tail -1)"
    if [ -n "$GO_DIR" ] && [ -x "$GO_DIR/bin/go" ]; then
      export PATH="$GO_DIR/bin:$PATH"
    fi
  fi
fi
if ! command -v go >/dev/null 2>&1 && [ -x /usr/local/go/bin/go ]; then
  export PATH="/usr/local/go/bin:$PATH"
fi

command -v go >/dev/null 2>&1 || {
  echo "❌ Go introuvable. Installez Go >= 1.20 (sing-box $SING_BOX_VERSION exige go 1.20+)"
  echo "   En CI, ajoutez : - uses: actions/setup-go@v5"
  exit 1
}
echo "→ Go : $(go version)"

# gomobile place ses binaires dans GOPATH/bin — s'assurer qu'ils sont trouvables.
export PATH="$(go env GOPATH)/bin:$PATH"

# ── Localisation du SDK / NDK Android ────────────────────────────────────────
# Sur les runners GitHub ubuntu-latest, le SDK est préinstallé sous
# /usr/local/lib/android/sdk et contient un ou plusieurs NDK.
if [ -z "${ANDROID_HOME:-}" ]; then
  for candidate in \
    "/usr/local/lib/android/sdk" \
    "$HOME/Android/Sdk" \
    "$HOME/Library/Android/sdk"; do
    if [ -d "$candidate" ]; then
      export ANDROID_HOME="$candidate"
      break
    fi
  done
fi
[ -n "${ANDROID_HOME:-}" ] && echo "→ SDK Android : $ANDROID_HOME"

if [ -z "${ANDROID_NDK_HOME:-}" ] && [ -n "${ANDROID_NDK_ROOT:-}" ]; then
  ANDROID_NDK_HOME="$ANDROID_NDK_ROOT"
  export ANDROID_NDK_HOME
fi

if [ -z "${ANDROID_NDK_HOME:-}" ]; then
  # Tenter de localiser un NDK dans le SDK Android (le plus récent).
  if [ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME/ndk" ]; then
    ANDROID_NDK_HOME="$(find "$ANDROID_HOME/ndk" -maxdepth 1 -mindepth 1 -type d | sort -V | tail -1)"
    export ANDROID_NDK_HOME
  elif [ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME/ndk-bundle" ]; then
    export ANDROID_NDK_HOME="$ANDROID_HOME/ndk-bundle"
  fi
fi

if [ -z "${ANDROID_NDK_HOME:-}" ] || [ ! -d "$ANDROID_NDK_HOME" ]; then
  echo "❌ NDK Android introuvable."
  echo "   Définissez ANDROID_NDK_HOME, ou installez-le :"
  echo "   sdkmanager --install 'ndk;26.1.10909125'"
  exit 1
fi
echo "→ NDK : $ANDROID_NDK_HOME"

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

echo "→ Clonage de sing-box $SING_BOX_VERSION..."
git clone --depth 1 --branch "$SING_BOX_VERSION" \
  https://github.com/SagerNet/sing-box.git "$WORK_DIR/sing-box" 2>&1 | tail -2

cd "$WORK_DIR/sing-box"

echo "→ Installation de gomobile $GOMOBILE_VERSION..."
go install -v "github.com/sagernet/gomobile/cmd/gomobile@$GOMOBILE_VERSION"
go install -v "github.com/sagernet/gomobile/cmd/gobind@$GOMOBILE_VERSION"
export PATH="$(go env GOPATH)/bin:$PATH"

echo "→ gomobile init..."
gomobile init

# Tags alignés sur le build officiel du client Android sing-box.
# with_gvisor est indispensable : il fournit la pile TCP/IP du TUN.
TAGS="with_gvisor,with_quic,with_wireguard,with_ech,with_utls,with_clash_api"

echo "→ gomobile bind (tags: $TAGS)..."
gomobile bind -v \
  -target android \
  -androidapi 21 \
  -javapkg=io.nekohasekai \
  -libname=box \
  -trimpath \
  -buildvcs=false \
  -ldflags "-X github.com/sagernet/sing-box/constant.Version=${SING_BOX_VERSION#v} -s -w -buildid=" \
  -tags "$TAGS" \
  ./experimental/libbox

mkdir -p "$OUT_DIR"
cp libbox.aar "$OUT_AAR"

echo ""
echo "✅ libbox.aar généré : $OUT_AAR"
echo "   Taille : $(du -h "$OUT_AAR" | cut -f1)"
echo "   SHA256 : $(sha256sum "$OUT_AAR" | cut -d' ' -f1)"

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

command -v go >/dev/null 2>&1 || { echo "❌ Go introuvable"; exit 1; }
echo "→ Go : $(go version)"

if [ -z "${ANDROID_NDK_HOME:-}" ] && [ -z "${ANDROID_NDK_ROOT:-}" ]; then
  # Tenter de localiser un NDK dans le SDK Android.
  if [ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME/ndk" ]; then
    ANDROID_NDK_HOME="$(find "$ANDROID_HOME/ndk" -maxdepth 1 -mindepth 1 -type d | sort -V | tail -1)"
    export ANDROID_NDK_HOME
    echo "→ NDK détecté : $ANDROID_NDK_HOME"
  else
    echo "❌ ANDROID_NDK_HOME non défini et aucun NDK trouvé dans ANDROID_HOME"
    exit 1
  fi
fi

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

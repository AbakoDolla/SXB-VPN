#!/usr/bin/env bash
set -euo pipefail

DNSTT_REPOSITORY="https://github.com/Mygod/dnstt.git"
# Branche upstream `plugin` : expose le contrat Shadowsocks Android
# SS_PLUGIN_OPTIONS + `__android_vpn=1` + ./protect_path. Le commit du fork
# Tor-PT ne l'expose pas et serait incompatible avec SxbVpnService.
DNSTT_COMMIT="17aa1fed864cd5493e3d09a14df1b8b5cc1df123"
ANDROID_API=21

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
OUTPUT_DIR="${DNSTT_OUTPUT_DIR:-${APP_DIR}/native-libs}"
SOURCE_DIR="${DNSTT_SOURCE_DIR:-${APP_DIR}/.dnstt-build/source}"

case "$(go env GOVERSION)" in
  go1.24*) ;;
  *) echo "Go 1.24 est requis (trouvé: $(go env GOVERSION))" >&2; exit 1 ;;
esac

NDK_ROOT="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-${NDK_HOME:-}}}"
if [[ -z "${NDK_ROOT}" && -n "${ANDROID_HOME:-}" ]]; then
  NDK_ROOT="$(find "${ANDROID_HOME}/ndk" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -1)"
fi
[[ -d "${NDK_ROOT}" ]] || { echo "Android NDK introuvable" >&2; exit 1; }

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) HOST_TAG="linux-x86_64" ;;
  Darwin-x86_64) HOST_TAG="darwin-x86_64" ;;
  Darwin-arm64) HOST_TAG="darwin-x86_64" ;;
  *) echo "Hôte NDK non pris en charge" >&2; exit 1 ;;
esac
TOOLCHAIN="${NDK_ROOT}/toolchains/llvm/prebuilt/${HOST_TAG}/bin"
[[ -d "${TOOLCHAIN}" ]] || { echo "Toolchain NDK absent: ${TOOLCHAIN}" >&2; exit 1; }

rm -rf "${SOURCE_DIR}"
mkdir -p "$(dirname "${SOURCE_DIR}")" "${OUTPUT_DIR}"
trap 'rm -rf "${SOURCE_DIR}"' EXIT
git clone --filter=blob:none --no-checkout "${DNSTT_REPOSITORY}" "${SOURCE_DIR}"
git -C "${SOURCE_DIR}" fetch --depth=1 origin "${DNSTT_COMMIT}"
git -C "${SOURCE_DIR}" checkout --detach "${DNSTT_COMMIT}"
[[ "$(git -C "${SOURCE_DIR}" rev-parse HEAD)" == "${DNSTT_COMMIT}" ]]
[[ -s "${SOURCE_DIR}/COPYING" ]] || { echo "Licence CC0 DNSTT absente" >&2; exit 1; }

build_abi() {
  local abi="$1" goarch="$2" compiler="$3"
  local destination="${OUTPUT_DIR}/${abi}/libdnstt.so"
  local goarm=()
  local built=0
  [[ "${goarch}" == "arm" ]] && goarm=(GOARM=7)
  mkdir -p "$(dirname "${destination}")"
  for attempt in 1 2 3; do
    echo "[dnstt] Compilation ${abi}, tentative ${attempt}/3"
    rm -f "${destination}"
    if (
      cd "${SOURCE_DIR}"
      env CGO_ENABLED=1 GOOS=android GOARCH="${goarch}" "${goarm[@]}" \
        CC="${TOOLCHAIN}/${compiler}${ANDROID_API}-clang" \
        CXX="${TOOLCHAIN}/${compiler}${ANDROID_API}-clang++" \
        go build -v -trimpath -buildvcs=false -buildmode=pie \
          -ldflags="-s -w -linkmode external -extldflags '-pie -Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384'" \
          -o "${destination}" ./dnstt-client
    ); then
      built=1
      break
    fi
    sleep $((attempt * 10))
  done
  (( built == 1 )) || { echo "Échec compilation DNSTT ${abi} après 3 tentatives" >&2; exit 1; }
  [[ -s "${destination}" ]]
  echo "[dnstt] ${abi} construit : $(stat -c %s "${destination}") octets"
  "${TOOLCHAIN}/llvm-readelf" -h "${destination}" | grep -q 'Type:.*DYN'
  local align found=0
  while read -r align; do
    found=1
    (( align >= 0x4000 )) || {
      echo "Segment LOAD non aligné à 16 KiB dans ${destination}: ${align}" >&2
      exit 1
    }
  done < <("${TOOLCHAIN}/llvm-readelf" -lW "${destination}" | awk '$1 == "LOAD" { print $NF }')
  (( found == 1 ))
}

build_abi "arm64-v8a" "arm64" "aarch64-linux-android"
build_abi "armeabi-v7a" "arm" "armv7a-linux-androideabi"

echo "DNSTT Android construit dans ${OUTPUT_DIR}"

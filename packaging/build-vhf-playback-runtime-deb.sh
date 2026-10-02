#!/bin/sh
set -eu

if test "$#" -ne 1; then
  echo "usage: $0 /output/directory" >&2
  exit 2
fi

output_dir=$1
architecture=$(dpkg --print-architecture)
version=1.13.8-1
package=vhf-playback-runtime
runtime_sha256=4e3734f82bc1379fd91f219f5869c7e9d03b7a4f7561907d8abca4849c51a789
model_sha256=e77603ac0c23dac3227dd2d7135b3a585cbee2679048aecfa886657d3ae1b534
runtime_url=https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-linux-aarch64-shared-cpu.tar.bz2
model_url=https://github.com/k2-fsa/sherpa-onnx/releases/download/speech-enhancement-models/gtcrn_simple.onnx
sherpa_license_url=https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v1.13.8/LICENSE
sherpa_license_sha256=cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30
ort_license_url=https://raw.githubusercontent.com/microsoft/onnxruntime/v1.28.2/LICENSE
ort_license_sha256=2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c
ort_notices_url=https://raw.githubusercontent.com/microsoft/onnxruntime/v1.28.2/ThirdPartyNotices.txt
ort_notices_sha256=0e07b95f3a8d6230037707c5c4a2b554d12c4cb67369669ac255635528ffcee2
gtcrn_commit=502ebfab64da7c4a9af78dcb9c6ceef1ebb01c73
gtcrn_source_url=https://raw.githubusercontent.com/Xiaobin-Rong/gtcrn/$gtcrn_commit/stream/onnx_models/gtcrn_simple.onnx
gtcrn_source_sha256=b4718df6228e7bdf1a8a435cf98f838636eb2fd331acabf86ba87c5192ebcb87
gtcrn_license_url=https://raw.githubusercontent.com/Xiaobin-Rong/gtcrn/$gtcrn_commit/LICENSE
gtcrn_license_sha256=c467165e5860b4a7494ef4a6e2788e4115d95b5b8989bb5f86287089adddf794
source_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
archive=$work/runtime.tar.bz2
model=$work/gtcrn_simple.onnx
notices=$work/notices
root=$work/root

test "$architecture" = arm64 || { echo "vhf-playback-runtime currently supports Debian arm64 only" >&2; exit 2; }
command -v curl >/dev/null
command -v sha256sum >/dev/null
command -v g++ >/dev/null
command -v dpkg-deb >/dev/null
curl -fsSL --retry 2 "$runtime_url" -o "$archive"
curl -fsSL --retry 2 "$model_url" -o "$model"
mkdir -p "$notices"
curl -fsSL --retry 2 "$sherpa_license_url" -o "$notices/sherpa-onnx-LICENSE"
curl -fsSL --retry 2 "$ort_license_url" -o "$notices/onnxruntime-LICENSE"
curl -fsSL --retry 2 "$ort_notices_url" -o "$notices/onnxruntime-ThirdPartyNotices.txt"
curl -fsSL --retry 2 "$gtcrn_license_url" -o "$notices/gtcrn-LICENSE"
curl -fsSL --retry 2 "$gtcrn_source_url" -o "$notices/gtcrn-source.onnx"
printf '%s  %s\n' "$runtime_sha256" "$archive" | sha256sum -c -
printf '%s  %s\n' "$model_sha256" "$model" | sha256sum -c -
printf '%s  %s\n' \
  "$sherpa_license_sha256" "$notices/sherpa-onnx-LICENSE" \
  "$ort_license_sha256" "$notices/onnxruntime-LICENSE" \
  "$ort_notices_sha256" "$notices/onnxruntime-ThirdPartyNotices.txt" \
  "$gtcrn_license_sha256" "$notices/gtcrn-LICENSE" \
  "$gtcrn_source_sha256" "$notices/gtcrn-source.onnx" | sha256sum -c -
mkdir -p "$work/runtime"
tar -xjf "$archive" -C "$work/runtime"
runtime_root=$(find "$work/runtime" -mindepth 1 -maxdepth 1 -type d -name 'sherpa-onnx-v1.13.8-linux-aarch64-shared-cpu' -print -quit)
test -n "$runtime_root" && test -d "$runtime_root/lib"
test -f "$runtime_root/lib/libsherpa-onnx-c-api.so"
test -f "$runtime_root/lib/libonnxruntime.so"

mkdir -p "$root/DEBIAN" "$root/usr/lib/vhf-playback/lib" \
  "$root/usr/share/vhf-playback" "$root/usr/share/doc/vhf-playback-runtime" "$output_dir"
cp -a "$runtime_root/lib/"*.so* "$root/usr/lib/vhf-playback/lib/"
install -m 0644 "$model" "$root/usr/share/vhf-playback/gtcrn_simple.onnx"
g++ -std=c++17 -O2 -Wall -Wextra -Werror \
  "$source_root/native/vhf-playback/denoiser.cpp" \
  "$source_root/native/vhf-playback/playback-core.cpp" \
  -I"$source_root/native/vhf-playback" \
  -L"$runtime_root/lib" -lsherpa-onnx-c-api \
  -Wl,-rpath,'$ORIGIN/lib' \
  -o "$root/usr/lib/vhf-playback/vhf-playback-denoiser"
chmod 0755 "$root/usr/lib/vhf-playback/vhf-playback-denoiser"
chmod 0644 "$root/usr/lib/vhf-playback/lib/"*.so*

install -m 0644 "$notices/sherpa-onnx-LICENSE" "$root/usr/share/doc/vhf-playback-runtime/sherpa-onnx-LICENSE"
install -m 0644 "$notices/onnxruntime-LICENSE" "$root/usr/share/doc/vhf-playback-runtime/onnxruntime-LICENSE"
install -m 0644 "$notices/onnxruntime-ThirdPartyNotices.txt" "$root/usr/share/doc/vhf-playback-runtime/onnxruntime-ThirdPartyNotices.txt"
install -m 0644 "$notices/gtcrn-LICENSE" "$root/usr/share/doc/vhf-playback-runtime/gtcrn-LICENSE"
cat > "$root/usr/share/doc/vhf-playback-runtime/SOURCES" <<EOF
Sherpa-ONNX 1.13.8 source: https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.8
Sherpa-ONNX Linux aarch64 shared CPU runtime:
  $runtime_url
  SHA-256: $runtime_sha256
GTCRN model source: $model_url
  SHA-256: $model_sha256
GTCRN upstream source repository: https://github.com/Xiaobin-Rong/gtcrn/tree/$gtcrn_commit
GTCRN committed streaming ONNX source: $gtcrn_source_url
  SHA-256: $gtcrn_source_sha256
GTCRN authors' MIT license is preserved as gtcrn-LICENSE.
The source-repository ONNX and Sherpa release ONNX have different SHA-256 hashes;
the packaged Sherpa artifact is the streaming-converted model. The release asset has
no separate weight-specific license file or embedded license metadata, so this
provenance does not assert independently verified licensing for that converted asset.
Notice sources and pinned SHA-256 hashes:
  $sherpa_license_url
  $sherpa_license_sha256
  $ort_license_url
  $ort_license_sha256
  $ort_notices_url
  $ort_notices_sha256
  $gtcrn_license_url
  $gtcrn_license_sha256
EOF
cat > "$root/usr/share/doc/vhf-playback-runtime/copyright" <<'EOF'
Sherpa-ONNX is licensed under the Apache License 2.0.
ONNX Runtime is licensed under the MIT License; see the installed license and third-party notices.
The upstream GTCRN implementation repository is copyright 2024 Rong Xiaobin and MIT licensed;
its full notice is installed as gtcrn-LICENSE. The separately converted Sherpa model release
has no separate weight-specific license file or embedded license metadata; no independent
license for that converted artifact is asserted here.
EOF
installed_size=$(du -sk "$root" | awk '{print $1}')
printf '%s\n' \
  "Package: $package" \
  "Version: $version" \
  'Section: sound' \
  'Priority: optional' \
  "Architecture: $architecture" \
  'Depends: libc6, libgcc-s1, libgomp1, libstdc++6' \
  "Installed-Size: $installed_size" \
  'Maintainer: VHF Watch' \
  'Description: Optional streaming GTCRN Modified playback runtime for Signal K VHF Watch' \
  > "$root/DEBIAN/control"
dpkg-deb --build --root-owner-group "$root" "$output_dir/${package}_${version}_${architecture}.deb"

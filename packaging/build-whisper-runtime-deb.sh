#!/bin/sh
set -eu

if test "$#" -ne 3; then
  echo "usage: $0 /path/to/whisper-build/bin /path/to/ggml-tiny.en-q5_1.bin /output/directory" >&2
  exit 2
fi

binary_dir=$1
model=$2
output_dir=$3
architecture=$(dpkg --print-architecture)
version=1.9.4-1
package=vhf-whisper-runtime
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
root=$work/root

test "$architecture" = arm64
test -x "$binary_dir/whisper-cli"
test -f "$model"
mkdir -p "$root/DEBIAN" "$root/usr/bin" "$root/usr/lib/vhf-whisper" "$root/usr/share/vhf-whisper" \
  "$root/usr/share/doc/vhf-whisper-runtime" "$output_dir"
install -m 0755 "$binary_dir/whisper-cli" "$root/usr/lib/vhf-whisper/whisper-cli"
cp -a "$binary_dir"/lib*.so* "$root/usr/lib/vhf-whisper/"
install -m 0644 "$model" "$root/usr/share/vhf-whisper/ggml-tiny.en-q5_1.bin"
if test -f "$binary_dir/../../LICENSE"; then
  install -m 0644 "$binary_dir/../../LICENSE" "$root/usr/share/doc/vhf-whisper-runtime/copyright"
fi
printf '%s\n' \
  'whisper.cpp source: https://github.com/ggml-org/whisper.cpp/tree/v1.9.4' \
  'Model source: https://huggingface.co/ggerganov/whisper.cpp/blob/main/ggml-tiny.en-q5_1.bin' \
  > "$root/usr/share/doc/vhf-whisper-runtime/SOURCES"
printf '%s\n' \
  '#!/bin/sh' \
  'export LD_LIBRARY_PATH=/usr/lib/vhf-whisper${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}' \
  'exec /usr/lib/vhf-whisper/whisper-cli -m /usr/share/vhf-whisper/ggml-tiny.en-q5_1.bin -l en -t 2 -ac 768 -sns -np -nt -f "$1"' \
  > "$root/usr/bin/vhf-whisper"
chmod 0755 "$root/usr/bin/vhf-whisper"
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
  'Description: Optional offline Whisper runtime for Signal K VHF Watch' \
  > "$root/DEBIAN/control"
dpkg-deb --build --root-owner-group "$root" "$output_dir/${package}_${version}_${architecture}.deb"

#!/bin/sh
set -eu

if test "$#" -ne 3; then
  echo "usage: $0 /path/to/sherpa-onnx/bin /path/to/kokoro-en-v0_19 /output/directory" >&2
  exit 2
fi

binary_dir=$1
model_dir=$2
output_dir=$3
architecture=$(dpkg --print-architecture)
version=1.12.1-2
package=vhf-tts-runtime
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
root=$work/root

case "$architecture" in
  arm64|amd64) ;;
  *) echo "unsupported Debian architecture: $architecture" >&2; exit 2 ;;
esac

test -x "$binary_dir/sherpa-onnx-offline-tts"
for file in model.onnx voices.bin tokens.txt; do test -f "$model_dir/$file"; done
test -d "$model_dir/espeak-ng-data"
mkdir -p "$root/DEBIAN" "$root/usr/bin" "$root/usr/lib/vhf-tts" \
  "$root/usr/share/vhf-tts/kokoro-en-v0_19" "$root/usr/share/doc/vhf-tts-runtime" "$output_dir"
install -m 0755 "$binary_dir/sherpa-onnx-offline-tts" "$root/usr/lib/vhf-tts/sherpa-onnx-offline-tts"
if ls "$binary_dir"/lib*.so* >/dev/null 2>&1; then cp -a "$binary_dir"/lib*.so* "$root/usr/lib/vhf-tts/"; fi
cp -a "$model_dir/espeak-ng-data" "$root/usr/share/vhf-tts/kokoro-en-v0_19/"
install -m 0644 "$model_dir/model.onnx" "$model_dir/voices.bin" "$model_dir/tokens.txt" \
  "$root/usr/share/vhf-tts/kokoro-en-v0_19/"
if test -f "$model_dir/LICENSE"; then
  install -m 0644 "$model_dir/LICENSE" "$root/usr/share/doc/vhf-tts-runtime/copyright"
fi
printf '%s\n' \
  'sherpa-onnx source: https://github.com/k2-fsa/sherpa-onnx/tree/v1.12.1' \
  'Kokoro model: https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2' \
  'Kokoro voice: af_sarah (speaker ID 3)' \
  > "$root/usr/share/doc/vhf-tts-runtime/SOURCES"
printf '%s\n' \
  '#!/bin/sh' \
  'set -eu' \
  'export LD_LIBRARY_PATH=/usr/lib/vhf-tts${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}' \
  'text_file=${1:?text file required}' \
  'opus_file=${2:?Opus output path required}' \
  'voice=${3:-af_sarah}' \
  'threads=${4:-2}' \
  'test "$voice" = af_sarah || { echo "Only af_sarah is installed" >&2; exit 2; }' \
  'case "$threads" in *[!0-9]*|"") echo "invalid TTS thread count" >&2; exit 2;; esac' \
  'test "$threads" -ge 1 && test "$threads" -le 4 || { echo "TTS thread count must be 1-4" >&2; exit 2; }' \
  'test -r "$text_file" || { echo "TTS input is not readable" >&2; exit 2; }' \
  'model=/usr/share/vhf-tts/kokoro-en-v0_19' \
  'wav=${opus_file}.wav' \
  'trap '\''rm -f "$wav"'\'' EXIT HUP INT TERM' \
  'text=$(cat "$text_file")' \
  'nice -n 10 /usr/lib/vhf-tts/sherpa-onnx-offline-tts --kokoro-model="$model/model.onnx" --kokoro-voices="$model/voices.bin" --kokoro-tokens="$model/tokens.txt" --kokoro-data-dir="$model/espeak-ng-data" --num-threads="$threads" --sid=3 --kokoro-length-scale=1.06 --output-filename="$wav" "$text"' \
  'nice -n 10 /usr/bin/ffmpeg -nostdin -hide_banner -loglevel error -y -i "$wav" -map 0:a:0 -c:a libopus -b:a 24k -vbr on -compression_level 10 -application voip -f opus "$opus_file"' \
  > "$root/usr/bin/vhf-tts"
chmod 0755 "$root/usr/bin/vhf-tts"
installed_size=$(du -sk "$root" | awk '{print $1}')
printf '%s\n' \
  "Package: $package" \
  "Version: $version" \
  'Section: sound' \
  'Priority: optional' \
  "Architecture: $architecture" \
  'Depends: ffmpeg, libc6, libgcc-s1, libgomp1, libstdc++6' \
  "Installed-Size: $installed_size" \
  'Maintainer: VHF Watch' \
  'Description: Optional offline Kokoro af_sarah TTS runtime for Signal K VHF Watch' \
  > "$root/DEBIAN/control"
dpkg-deb --build --root-owner-group "$root" "$output_dir/${package}_${version}_${architecture}.deb"

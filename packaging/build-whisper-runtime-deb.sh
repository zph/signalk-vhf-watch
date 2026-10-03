#!/bin/sh
set -eu

if test "$#" -lt 5; then
  echo "usage: $0 /path/to/whisper-build/bin /output/directory /path/to/ggml-base.en-q5_1.bin [/path/to/ggml-other.bin ...] --whisper-license /path/to/whisper.cpp/LICENSE --vad-model /path/to/ggml-silero-v6.2.0.bin" >&2
  exit 2
fi

binary_dir=$1
output_dir=$2
shift 2
architecture=$(dpkg --print-architecture)
version=1.9.4-5
package=vhf-whisper-runtime
vad_model_sha256=2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
root=$work/root

case "$architecture" in
  arm64|amd64) ;;
  *) echo "unsupported Debian architecture: $architecture" >&2; exit 2 ;;
esac
test -x "$binary_dir/whisper-cli"
test -x "$binary_dir/whisper-vad-speech-segments"
command -v sha256sum >/dev/null
mkdir -p "$root/DEBIAN" "$root/usr/bin" "$root/usr/lib/vhf-whisper" "$root/usr/share/vhf-whisper/vad" \
  "$root/usr/share/doc/vhf-whisper-runtime" "$output_dir"
install -m 0755 "$binary_dir/whisper-cli" "$root/usr/lib/vhf-whisper/whisper-cli"
install -m 0755 "$binary_dir/whisper-vad-speech-segments" "$root/usr/lib/vhf-whisper/whisper-vad-speech-segments"
cp -a "$binary_dir"/lib*.so* "$root/usr/lib/vhf-whisper/"
model_sources=''
has_default=false
vad_model=''
whisper_license=''
while test "$#" -gt 0; do
  case "$1" in
    --whisper-license)
      test "$#" -ge 2 || { echo "--whisper-license requires a file path" >&2; exit 2; }
      whisper_license=$2
      shift 2
      ;;
    --vad-model)
      test "$#" -ge 2 || { echo "--vad-model requires a model path" >&2; exit 2; }
      vad_model=$2
      shift 2
      ;;
    *)
      model=$1
      test -f "$model"
      filename=$(basename "$model")
      case "$filename" in
        ggml-*.bin) ;;
        *) echo "unsupported model filename: $filename" >&2; exit 2 ;;
      esac
      install -m 0644 "$model" "$root/usr/share/vhf-whisper/$filename"
      test "$filename" != ggml-base.en-q5_1.bin || has_default=true
      model_sources="$model_sources
Model source: https://huggingface.co/ggerganov/whisper.cpp/blob/main/$filename"
      shift
      ;;
  esac
done
test "$has_default" = true
test -n "$vad_model"
test -n "$whisper_license"
test -f "$whisper_license"
test -f "$vad_model"
test "$(basename "$vad_model")" = ggml-silero-v6.2.0.bin
printf '%s  %s\n' "$vad_model_sha256" "$vad_model" | sha256sum -c -
install -m 0644 "$vad_model" "$root/usr/share/vhf-whisper/vad/ggml-silero-v6.2.0.bin"
install -m 0644 "$whisper_license" "$root/usr/share/doc/vhf-whisper-runtime/copyright"
install -m 0644 "$(dirname "$0")/licenses/silero-vad-LICENSE" "$root/usr/share/doc/vhf-whisper-runtime/silero-vad-LICENSE"
vad_model_source=https://huggingface.co/ggml-org/whisper-vad/blob/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin
printf '%s\n' \
  'whisper.cpp source: https://github.com/ggml-org/whisper.cpp/tree/v1.9.4' \
  "$model_sources" \
  "Silero VAD model source: $vad_model_source" \
  'Silero VAD license: MIT; see silero-vad-LICENSE' \
  "Silero VAD model SHA-256: $vad_model_sha256" \
  > "$root/usr/share/doc/vhf-whisper-runtime/SOURCES"
printf '%s\n' \
  '#!/bin/sh' \
  'export LD_LIBRARY_PATH=/usr/lib/vhf-whisper${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}' \
  'audio=${1:?audio path required}' \
  'model=${2:-base.en-q5_1}' \
  'threads=${3:-2}' \
  'case "$model" in *[!a-zA-Z0-9._-]*|"") echo "invalid Whisper model" >&2; exit 2;; esac' \
  'case "$threads" in *[!0-9]*|"") echo "invalid Whisper thread count" >&2; exit 2;; esac' \
  'test "$threads" -ge 1 && test "$threads" -le 16 || { echo "Whisper thread count must be 1-16" >&2; exit 2; }' \
  'model_path=/usr/share/vhf-whisper/ggml-${model}.bin' \
  'test -r "$model_path" || { echo "Whisper model is not installed: $model" >&2; exit 2; }' \
  'exec /usr/lib/vhf-whisper/whisper-cli -m "$model_path" -l en -t "$threads" -np -f "$audio"' \
  > "$root/usr/bin/vhf-whisper"
chmod 0755 "$root/usr/bin/vhf-whisper"
printf '%s\n' \
  '#!/bin/sh' \
  'set -eu' \
  'audio=${1:?audio WAV path required}' \
  'test -r "$audio" || { echo "audio input is not readable" >&2; exit 2; }' \
  'export LD_LIBRARY_PATH=/usr/lib/vhf-whisper${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}' \
  'exec /usr/lib/vhf-whisper/whisper-vad-speech-segments --vad-model /usr/share/vhf-whisper/vad/ggml-silero-v6.2.0.bin --file "$audio" --threads 1 --vad-threshold 0.35 --vad-min-speech-duration-ms 80 --vad-min-silence-duration-ms 100 --vad-speech-pad-ms 200 --no-prints' \
  > "$root/usr/bin/vhf-vad"
chmod 0755 "$root/usr/bin/vhf-vad"
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
  'Description: Optional selectable offline Whisper models for Signal K VHF Watch' \
  > "$root/DEBIAN/control"
dpkg-deb --build --root-owner-group "$root" "$output_dir/${package}_${version}_${architecture}.deb"

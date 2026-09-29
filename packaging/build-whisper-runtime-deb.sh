#!/bin/sh
set -eu

if test "$#" -lt 3; then
  echo "usage: $0 /path/to/whisper-build/bin /output/directory /path/to/ggml-base.en-q5_1.bin [/path/to/ggml-other.bin ...]" >&2
  exit 2
fi

binary_dir=$1
output_dir=$2
shift 2
architecture=$(dpkg --print-architecture)
version=1.9.4-4
package=vhf-whisper-runtime
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
root=$work/root

case "$architecture" in
  arm64|amd64) ;;
  *) echo "unsupported Debian architecture: $architecture" >&2; exit 2 ;;
esac
test -x "$binary_dir/whisper-cli"
mkdir -p "$root/DEBIAN" "$root/usr/bin" "$root/usr/lib/vhf-whisper" "$root/usr/share/vhf-whisper" \
  "$root/usr/share/doc/vhf-whisper-runtime" "$output_dir"
install -m 0755 "$binary_dir/whisper-cli" "$root/usr/lib/vhf-whisper/whisper-cli"
cp -a "$binary_dir"/lib*.so* "$root/usr/lib/vhf-whisper/"
model_sources=''
has_default=false
for model do
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
done
test "$has_default" = true
if test -f "$binary_dir/../../LICENSE"; then
  install -m 0644 "$binary_dir/../../LICENSE" "$root/usr/share/doc/vhf-whisper-runtime/copyright"
fi
printf '%s\n' \
  'whisper.cpp source: https://github.com/ggml-org/whisper.cpp/tree/v1.9.4' \
  "$model_sources" \
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

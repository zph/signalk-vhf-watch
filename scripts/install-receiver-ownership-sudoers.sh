#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with sudo so it can install a root-owned sudoers rule." >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_file=$script_dir/signalk-vhf-watch-ais-catcher.sudoers
target=/etc/sudoers.d/signalk-vhf-watch-ais-catcher
temporary=$(mktemp /etc/sudoers.d/signalk-vhf-watch-ais-catcher.XXXXXX)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup=${target}.before-${stamp}
trap 'rm -f "$temporary"' EXIT HUP INT TERM

install -o root -g root -m 0440 "$source_file" "$temporary"
visudo -cf "$temporary"
if [ -e "$target" ]; then
  cp -p "$target" "$backup"
  chmod 0600 "$backup"
fi
mv -f "$temporary" "$target"
chown root:root "$target"
chmod 0440 "$target"
visudo -cf "$target"
trap - EXIT HUP INT TERM
echo "Installed $target"

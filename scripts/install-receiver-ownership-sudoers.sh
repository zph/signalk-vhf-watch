#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with sudo so it can install a root-owned sudoers rule." >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_file=$script_dir/signalk-vhf-watch-ais-catcher.sudoers
helper_source=$script_dir/receiver-identity-helper.py
helper_target=/usr/local/libexec/signalk-vhf-watch-receiver-identity
target=/etc/sudoers.d/signalk-vhf-watch-ais-catcher
for directory in /usr /usr/local /usr/local/libexec; do
  parent=${directory%/*}
  if [ ! -d "$directory" ]; then
    if [ "$directory" = /usr ] || [ ! -d "$parent" ] || [ "$(stat -c %u "$parent")" -ne 0 ] || ! python3 -I -c 'import os,sys; sys.exit(0 if not (os.stat(sys.argv[1]).st_mode & 0o022) else 1)' "$parent"; then
      echo "Cannot safely create helper directory: $directory" >&2
      exit 1
    fi
    install -d -o root -g root -m 0755 "$directory"
  fi
  if [ -L "$directory" ] || [ ! -d "$directory" ] || [ "$(stat -c %u "$directory")" -ne 0 ]; then
    echo "Expected root-owned helper directory: $directory" >&2
    exit 1
  fi
  if ! python3 -I -c 'import os,sys; sys.exit(0 if not (os.stat(sys.argv[1]).st_mode & 0o022) else 1)' "$directory"; then
    echo "Refusing group/world-writable helper directory: $directory" >&2
    exit 1
  fi
done
for destination in "$helper_target" "$target"; do
  if [ -L "$destination" ] || { [ -e "$destination" ] && [ ! -f "$destination" ]; }; then
    echo "Refusing non-regular installation destination: $destination" >&2
    exit 1
  fi
done
temporary=$(mktemp /etc/sudoers.d/signalk-vhf-watch-ais-catcher.XXXXXX)
helper_temporary=$(mktemp /usr/local/libexec/signalk-vhf-watch-receiver-identity.XXXXXX)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup=${target}.before-${stamp}
helper_backup=${helper_target}.before-${stamp}
trap 'rm -f "$temporary" "$helper_temporary"' EXIT HUP INT TERM

install -o root -g root -m 0755 "$helper_source" "$helper_temporary"
python3 -I -c 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())' "$helper_temporary"
if ! head -n 1 "$helper_temporary" | grep -Fx '#!/usr/bin/python3 -I' >/dev/null; then
  echo "Receiver identity helper must use the fixed isolated Python interpreter" >&2
  exit 1
fi
install -o root -g root -m 0440 "$source_file" "$temporary"
visudo -cf "$temporary"

if [ -e "$helper_target" ]; then
  cp -p "$helper_target" "$helper_backup"
  chmod 0600 "$helper_backup"
fi
mv -f "$helper_temporary" "$helper_target"
chown root:root "$helper_target"
chmod 0755 "$helper_target"
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

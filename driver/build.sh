#!/usr/bin/env bash
# Builds player.gbc and player.sym from the pinned driver, the Fxx patch and player.asm, with rgbds 0.7.0 (pinned,
# since --check compares bytes). Uses rgbasm, rgblink and rgbfix from PATH, or from the directory RGBDS names.
# With --check, builds into a temporary directory and fails if the committed files differ.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
bin=${RGBDS:+$RGBDS/} # empty, to use PATH
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

"${bin}rgbasm" --version | grep -qx 'rgbasm v0.7.0' || { echo "need rgbasm v0.7.0 in ${RGBDS:-PATH} (or set RGBDS)" >&2; exit 1; }
cp -r "$here/hUGEDriver.asm" "$here/include" "$here/player.asm" "$work/"
cd "$work"
patch -s -p1 < "$here/fxx.patch"
"${bin}rgbasm" -o hUGEDriver.o hUGEDriver.asm
"${bin}rgbasm" -o player.o player.asm
"${bin}rgblink" -t -n player.sym -o player.gbc player.o hUGEDriver.o
"${bin}rgbfix" -C -v -p 0 -t GBSCORE player.gbc

if [[ ${1:-} == --check ]]; then
  cmp player.gbc "$here/player.gbc" && cmp player.sym "$here/player.sym" || {
    echo "driver/player.gbc or player.sym is out of date: run driver/build.sh" >&2
    exit 1
  }
else
  cp player.gbc player.sym "$here/"
fi

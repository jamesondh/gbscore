#!/usr/bin/env bash
# Builds binjgb.wasm: binjgb's emulator core with halt.patch, plus wrapper.c, as one WebAssembly module that the
# browser and Node both load (src/play/emulator.ts). The patch lets a halted CPU skip its idle cycles, which
# changes nothing the emulator outputs and makes it two to three times faster at playing songs. Uses zig 0.17.0 as
# the C compiler: zig from PATH, or the binary ZIG names. Clones binjgb at the pinned commit unless BINJGB names a
# clean checkout of it.
# With --check, builds into a temporary directory and fails if the committed binjgb.wasm differs.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
commit=16621111ed0ee73bcc45c912a823bcebedcffc0f # binjgb master, 2026-09-25
zig=${ZIG:-zig}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

[[ $("$zig" version) == 0.17.0 ]] || { echo "need zig 0.17.0 at $zig (or set ZIG)" >&2; exit 1; }
src=${BINJGB:-}
if [[ -n $src ]]; then
  [[ $(git -C "$src" rev-parse HEAD) == "$commit" && -z $(git -C "$src" status --porcelain) ]] || {
    echo "BINJGB must be a clean checkout of $commit" >&2
    exit 1
  }
else
  git clone --quiet https://github.com/binji/binjgb.git "$work/binjgb"
  src=$work/binjgb
  git -C "$src" checkout --quiet "$commit"
fi

mkdir "$work/patched"
cp -r "$src/src" "$work/patched/"
patch -s -d "$work/patched" -p1 < "$here/halt.patch"

# binjgb's error messages name their source file, so map paths to keep the output the same on any machine.
"$zig" cc -target wasm32-wasi -mexec-model=reactor -O2 -DNDEBUG -Wl,--strip-all -I"$work/patched/src" \
  -ffile-prefix-map="$work/patched"=binjgb -ffile-prefix-map="$here"=emu \
  "$work/patched/src/emulator.c" "$work/patched/src/common.c" "$here/wrapper.c" -o "$work/binjgb.wasm"

if [[ ${1:-} == --check ]]; then
  cmp "$work/binjgb.wasm" "$here/binjgb.wasm" || { echo "emu/binjgb.wasm is out of date: run emu/build.sh" >&2; exit 1; }
else
  cp "$work/binjgb.wasm" "$here/"
fi

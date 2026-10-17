#!/bin/sh
# Regenerates the *.uge2source.c next to each test song, in test/fixtures/ and, when it's there, test/private/
# (test/fixtures/README.md). The tests compare our compiler against these files; see docs/editor/ ("Reference").
# UGE2SOURCE is uge2source built from hUGETracker aa259a49, which reads V6 and V7.
set -eu
if [ -z "${UGE2SOURCE:-}" ] || [ ! -x "$UGE2SOURCE" ]; then
  echo "Set UGE2SOURCE to the uge2source binary built from hUGETracker aa259a49." >&2
  exit 1
fi
cd "$(dirname "$0")/../test"
for uge in fixtures/*.uge private/*.uge; do
  [ -e "$uge" ] || continue # no test/private/
  "$UGE2SOURCE" "$uge" -b 255 song "${uge%.uge}.uge2source.c"
done

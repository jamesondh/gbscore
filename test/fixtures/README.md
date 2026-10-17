# Test songs

- `halt_bug.uge`: the editor's demo song, `src/app/demo/halt_bug.gbscore.json` (*HALT Bug*), as a V7 `.uge`,
  written by `node scripts/song-to-uge.ts src/app/demo/halt_bug.gbscore.json test/fixtures/halt_bug.uge`. It was
  made by gbscore, not hUGETracker, so it checks import and the compiler against uge2source, not against files the
  tracker writes. The demo song's golden log is `test/golden/halt_bug.apu.gz`.

`*.uge2source.c` is what uge2source writes for each `.uge`. `scripts/make-references.sh` regenerates them with
`UGE2SOURCE` set to uge2source built from hUGETracker `aa259a49`; they're committed because CI has no uge2source.
`test/golden/*.apu.gz` are the sound-register logs `test/play.test.ts` records; `GOLDEN=update npm test`
rewrites them.

## Private songs

Tests on songs that can't be redistributed live with those songs in `test/private/`, which git ignores. Vitest runs
them when the folder is there; without it, the public tests run alone.

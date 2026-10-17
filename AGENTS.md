# gbscore

A web-based Game Boy music editor and command-line tool that compiles songs for hUGEDriver. The README covers the
rest.

## Working here

- Do what was asked, the simplest way that meets it. Experiments, new tooling and paid runs nobody asked for are
  proposals: say what they cost and what decision their result would change, and wait. If the work grows well past
  what you first expected, stop and tell the user: what you expected, where it is now, and a smaller way to finish.
- When you're repeating something the project has done before, reversing an earlier decision, or changing code
  whose purpose isn't clear, look at its history (`git log -- <path>`, `git log -S<symbol>`, `git blame`) and
  open the commits that explain it.
- The checks below are the minimum for what you touched. Run them again after any merge, rebase or conflict
  resolution.
- Commit small: one change per commit, each passing its checks. The subject says what changed, and the trap if
  there was one, in words a search would find. Unless the diff says it, the body gives the why, what you ruled
  out, what you ran (with numbers) and what you didn't test.
- Leave each fixed bug's reproduction behind as a test or a script.
- A step that's hard to reverse (schema, auth, money, external API) or several sessions long: design it in
  `docs/<topic>/` first. Judge each step on its own, not by the riskiest part of the project. Measure with the
  checks below or existing tools before writing new ones. Get an independent review of risky changes (the design
  first, when that could save rework), and ask it what to cut or do more simply, not only what's missing.
- Code and the running system outrank this file and every doc. When they disagree, fix the file in the same
  commit. When the project's code breaks unnoticed, add a rule here, with a check if one can be written; tooling
  built for one task doesn't get rules. Delete rules whose code is gone.

## Map

- `docs/editor/`: the design for the editor, compiler, playback and GBDK export, with status.
- `docs/patterns/`: the design for patterns, reusable runs of notes placed on the timeline, with status.
- `README.md`: what gbscore is, its commands, and the song format.
- `src/core/`: the song schema, compiler, pattern expansion (`patterns.ts`), `.uge` reader and import, canonical
  formatter and text views. No Node or browser APIs, so the CLI and the app share it.
- `src/play/`: plays compiled songs on the emulator, tick by tick, and turns the audio into WAV. No Node or browser
  APIs either.
- `src/cli/`: the `gbscore` command.
- `src/app/`: the editor (Vite, React, Tailwind, shadcn/ui in `components/ui/`). `audio/` plays songs: the emulator
  in a Worker, output through an AudioWorklet. `roll/` draws the piano roll on a canvas.
- `driver/`: the pinned hUGEDriver, the `Fxx` patch and `player.asm`, built into the committed `player.gbc` and
  `player.sym` by `driver/build.sh` (rgbds 0.7.0, from PATH or the directory `RGBDS` names).
- `emu/`: binjgb, with `halt.patch`, built to `binjgb.wasm` by `emu/build.sh` (zig 0.17.0, from PATH or `ZIG`),
  committed.
- `schema/gbscore.schema.json`: generated from `src/core/schema.ts` by `npm run schema`.
- `test/`: tests; `test/fixtures/` holds the public test songs and uge2source's C for each
  (`scripts/make-references.sh`), and `test/golden/` the sound-register logs the emulator records for them. Tests
  on songs that can't be redistributed live with those songs in the gitignored `test/private/`, and run only where
  it exists; see `test/fixtures/README.md`. `test/app/` holds the browser tests (Playwright), run by `npm run test:app` rather
  than `npm test`.

## Rules

- **Songs compile for one pinned driver: hUGEDriver `a3c69884` plus `latest-stuff`'s `Fxx` fix.** The driver's
  data format changes between unreleased commits (`latest-stuff` added pattern compression and a new song header
  in Aug 2026), and unpatched `a3c69884` sets only groove step 0 on `Fxx`. The bytes the compiler writes must match
  the driver a game links, the one in `driver/`. Check: `test/reference.test.ts` compares the compiler with the C
  uge2source writes from the same hUGETracker pin, and `test/play.test.ts` plays the songs on the patched driver
  and checks their timing and sound-register logs. If you have `test/private/`, its tests check more songs the
  same way.
- **The editor's toolbar fits on one row from 1024 px wide up.** It outgrew a 1280 px screen, and at 1024 px
  pushed Save and the list of keys off the edge, before anyone noticed. Add to it by the rules in
  `docs/editor/README.md` ("Toolbar"). Check: `test/app/toolbar.e2e.ts`.

## Checks

| When you touch | Run |
|---|---|
| anything in `src/`, `test/` or `scripts/` | `npm run typecheck && npm test` |
| `src/core/schema.ts` | `npm run schema`, then the above (a test fails while the schema file is stale) |
| `src/cli/` | `npm run build:cli` |
| `driver/` | `driver/build.sh`, then `driver/build.sh --check` and `npm test` |
| `emu/` | `emu/build.sh`, then `emu/build.sh --check` and `npm test` |
| `src/app/`, or `src/play/` or `emu/` as the app uses them | `npm run test:app` |

A change to the driver, the player, the emulator or the compiler's output can change the golden sound-register
logs. If it's meant to, rewrite them with `GOLDEN=update npm test` and say in the commit what changed and why.

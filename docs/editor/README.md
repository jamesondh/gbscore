# Editor, compiler and playback

The design for gbscore v1: a song format, a compiler to hUGEDriver data, playback that runs the real driver, a
command line, a browser editor, and export to GBDK C. Status is first, then what the design rests on, then the
design.

## Status

| Pass | What | State |
|---|---|---|
| 1 | Core: song model, V6/V7 `.uge` import, compiler, `check`/`show`/`fmt`/`import` | done |
| 2 | Playback core and `gbscore render` | done |
| 3 | GBDK export | done |
| 4 | Web app and hosting | in progress |

Later, not v1: MIDI file import and export, edits heard during playback, `.uge` files older than V6, writing
`.uge`.

## Background

### hUGEDriver at `a3c69884`

gbscore compiles for one driver: hUGEDriver at commit `a3c69884` (2023-09-08), plus the `Fxx` fix described under
"Rules". These facts about it shape the format:

- **Rows and patterns.** A pattern row is 3 bytes: note, instrument and effect, then the effect parameter. Each
  channel gets one effect per row. Patterns are 64 rows. Each channel has its own order list, and all four
  advance together.
- **Order limit.** `order_cnt` is a byte that holds the order count × 2, so a song has at most 127 orders. When the
  orders run out, playback wraps to order 0.
- **Jumps and breaks count from 1** (`fx_pos_jump`, `fx_pattern_break`, `tick_time`):
  - `Dxx` makes the next order start at row xx−1, so `D01` means row 0, and `D00` does nothing.
  - `Bxx` jumps to order xx−1 at the end of the row, so `B01` means order 0, and `B00` just moves to the next order.
- **Groove.** `ticks_per_row` is a 4-step groove indexed by the row within the pattern (`row & 3`, in `tick_time`).
  It's the same for every channel. A pattern break resets the groove's phase.
- **`Fxx` (set speed)** writes only the first groove step (`fx_set_speed`) on unpatched `a3c69884`. The
  `latest-stuff` branch writes all four. V6 drivers had one speed, so on the unpatched driver `Fxx` in a V6 song
  plays wrong: it changes every fourth row's length instead of every row's.
- **`Cxy` (set volume)** restarts the note on the pulse and noise channels. The wave channel has 4 volume levels.
- **Instrument tables.** Each instrument can have a table of 32 rows, one per tick. Each row has a note offset, an
  effect and a jump.
- **Limits.** Up to 15 instruments per channel type, and 16 waves.

**Upstream is moving.** hUGEDriver's `latest-stuff` branch (Aug 2026, untagged) adds compressed patterns,
adjustable pattern length and single-stepping, and changes the `hUGESong_t` header. Songs compiled for one can't
play on the other. The last tagged release is v6.1.3 (July 2024).

### Timing

gbscore plays songs at the tick rate a CrossZGB game on the Game Boy Color gets. CrossZGB calls `hUGE_dosound` from
the timer interrupt, with the CPU in double speed, TAC at 4096 Hz and TMA at `0x78`. That works out to
2 × 4096 / 136 = **60.24 Hz**, whatever the song's own timer setting says. hUGETracker previews at the frame rate,
59.73 Hz, and GB Studio at 64 Hz, so the same song plays at slightly different speeds in each.

### GB Studio's music editor

GB Studio (MIT) has a web music editor (`src/apps/gbs-music-web`) that plays hUGEDriver songs in the browser.
gbscore's playback borrows its approach:

- **Emulator:** binjgb (MIT) compiled to WebAssembly, 99 KB.
- **Player ROM:** assembled once at startup with rgbds compiled to WebAssembly.
- **Each play:** the song's bytes get written into the ROM at `$1000` (`patchRom()` in
  `src/components/music/helpers/player.ts`).
- **Ticks:** the driver runs from a fixed 64 Hz timer.
- **Audio:** scheduled from the main thread as `AudioBufferSourceNode`s. Edits take effect on the next play.
- **Song files:** its `.uge` code reads V0–V6. It doesn't handle grooves, and it drops routines. Effects are hex
  codes in a strip under the piano roll.

## Design

### Goals

- **A piano roll, not a tracker.** Someone used to FL Studio or Ableton can write a Game Boy song in a browser,
  with a piano roll per channel, the usual DAW keys, note entry from a computer or MIDI keyboard, and transposition
  of selections.
- **A plain, readable file.** A song is one JSON file that any tool can read and edit: a text editor, a script, an
  agent. A command line checks, views and renders songs without the editor.
- **What you hear is what ships.** One compiler makes the bytes for preview, rendering and the game. Playback runs
  the pinned driver on an emulator, at the game's tick rate.
- **A static site.** Built with Vite. No server.

### Not in v1

- Writing `.uge` files, and importing `.uge` files older than V6.
- Other drivers, and features the driver can't play.
- Sound effects, and the routine effect (`6xx`).
- MIDI files. A MIDI keyboard for note entry is in.
- Hearing edits while a song plays. Edits take effect on the next play.
- Two people editing at once.
- Folders in browsers without the File System Access API. They can open one song from a file and download it.

### Rules

1. **One compiler.** Preview, `gbscore render` and `gbscore export` all call the same `compile()`.
2. **One pinned driver.** The compiler targets exactly one driver, vendored in `driver/`: hUGEDriver `a3c69884`
   plus `latest-stuff`'s four-line `Fxx` fix (`driver/fxx.patch`), so that `Fxx` sets all four groove steps. A game
   that plays gbscore's songs has to link that same driver: the data format differs between hUGEDriver commits.
   The compiler also targets the 60.24 Hz tick rate. Changing either one is its own commit, with the checks from
   passes 1 and 2.
   - **What the fix changes:** songs with `Fxx` play the way V6 drivers played them, and the way `latest-stuff`
     does, not the way the unpatched driver (and a hUGETracker built on it) plays them.
3. **The file is the interface.** Anything the editor can do can be done by editing the file, and the reverse.
   The editor keeps nothing in the song that isn't in the file. View state (scroll, zoom, selection) lives
   elsewhere.
4. **One canonical form.** The editor and `gbscore fmt` write byte-identical output for the same song, so a diff
   shows only real changes.
5. **The compiler never guesses.** If something can't be encoded, compilation fails with an error that names the
   bar, beat and channel, and says what to change. The editor keeps playing the last version that compiled and
   marks the problem.
6. **Display settings never change the sound.** The grid (`rowsPerBeat`, `beatsPerBar`) affects only drawing,
   messages and MIDI. It never affects the compiled bytes.

### Code layout

One TypeScript package.

- `src/core/`: the song model and its schema, the `.uge` reader, the compiler, import and export. Pure
  TypeScript, with no browser or Node APIs, so the app and the command line share it.
- `src/play/`: runs the emulator. It loads the player ROM, writes the song into it, steps it, and returns audio and
  the playhead position.
- `src/cli/`: the `gbscore` command (Node 20+), bundled into one file.
- `src/app/`: the editor (Vite, React). Playback runs `src/play/` in a Worker, with an AudioWorklet for output.
- `driver/`: the pinned driver, the `Fxx` patch, `player.asm`, and a build script. The script makes `player.gbc` and
  a symbol file, and both are committed, so neither the web build nor users need rgbds. A check rebuilds them and
  compares hashes.
- `emu/`: a build script for binjgb as WebAssembly, for both the browser and Node, plus the committed output. It
  compiles with zig's C compiler (a 57 MB download, against Emscripten's 1 GB or so), to a WASI module the host
  loads with a few stub imports.

### Song model and file

A song is one JSON file, `<name>.gbscore.json`. The schema lives in `src/core/schema.ts`. A JSON Schema generated
from it lives in `schema/gbscore.schema.json`, so any tool can validate a file. The fields:

- **`grid`:** `rowsPerBeat` and `beatsPerBar`, for display only (rule 6). A row is the smallest step on the grid.
- **`groove`:** four tick counts per row, such as `[6,6,6,6]` or `[5,5,5,7]`. This is the driver's
  `ticks_per_row`. Real time comes from the tick rate, 60.24 Hz.
- **`length` and `loop`:** the song's length in rows, and the row it loops back to (0 by default). If the groove
  isn't uniform, `loop` must be a multiple of 4, so the groove keeps its phase. Tracker patterns, orders and jumps
  aren't in the file. The compiler makes them.
- **`patterns`:** reusable runs of notes for one lane, placed in lanes by items with `pattern`. The compiler writes
  them out into the flat timeline before anything else; see [`docs/patterns/`](../patterns/README.md).
- **`instruments`:** `duty`, `wave` and `noise`, up to 15 of each, with fields that mirror the driver.
  - Duty instruments: duty, volume, envelope direction and pace, sweep, length.
  - Wave instruments: wave, level, length.
  - Noise instruments: volume, envelope, 15- or 7-bit mode, length.
  - `length` is kept even while `lengthEnabled` is off, because the driver writes it anyway, and imported
    instruments then compile to the same bytes.
  - Each can have a table of up to 32 rows. A table row has a note offset, an effect and a jump.
  - Tables can't use glide, delay or cut. The driver runs a table's effect from the second byte of its handler,
    skipping a one-byte tick check: glide and delay start with a two-byte jump, so they'd run garbage, and cut would
    fire on tick 0 whatever its tick says.
- **`waves`:** up to 16 waves, each 32 hex digits.
- **`lanes`:** `pulse1`, `pulse2`, `wave` and `noise`. Each lane holds notes and effects, sorted by row.
  - A note looks like `{ "row": 16, "len": 4, "note": "E5", "inst": 3 }`.
    - Instead of `inst` it can have `legato: true`. Then the driver changes the pitch without restarting the note
      (no instrument load, no retrigger), as it does for a tracker row with a note and no instrument. Every note
      needs one or the other, so a forgotten `inst` is an error rather than a silent legato.
    - `legato` is an error on the wave lane: `play_ch3_note` turns the channel off and only a retrigger restarts
      it, so the note is silent. On noise it works, but returns the channel to 15-bit mode.
    - `fx`: one effect on the note's row. Volume and delay are effects (`{ "volume": 9 }`, `{ "delay": 2 }`), not
      note fields, so there's one way to write each.
    - `cutTick`: see below.
  - An effect with no note looks like `{ "row": 30, "fx": { "vibrato": [4, 2] } }`.
  - Effects have names: `arp`, `slideUp`, `slideDown`, `glide`, `vibrato`, `duty` (pulse lanes), `wave` (the wave
    lane), `volume`, `volSlide`, `cut`, `delay`.
  - `raw` holds tracker hex for values no name can express, such as a duty byte with length bits (`9D0`). `check`
    rejects a `raw` that has a name.
  - Note names are hUGETracker's, which are also FL Studio's: C3 to B8, with A5 at 440 Hz.
- **`global`:** effects for the whole song, each a row plus one of:
  - `tempo` sets all four groove steps to one value. That's `Fxx` on the patched driver. A non-uniform groove
    becomes uniform from that point.
  - `pan`, as `"LR"`, `"L"`, `"R"` or `"off"` for each lane, and `masterVolume`, as `[left, right]`.
  - The compiler puts each one on a channel that has a free effect slot on that row.

Positions in messages and in `gbscore show` read `bar.beat.row`, counting from 1, as Ableton counts sixteenths.

How long notes last:

- A note covers `len` rows, at least 1. It ends when row `row + len` starts. At that point the compiler adds a cut,
  unless the lane's next note starts there, or that's the end of the song (the loop continues the music).
- With `cutTick: t` (0 up to the row's tick count minus 1), the note instead ends at tick `t` of its last row. The
  compiler writes `E0t` on that row and adds no other cut. This exists for imported tracker cuts within a note's
  own row: a tracker row with a note and `E02` imports as `len: 1, cutTick: 2`, and one with `E00` as
  `len: 1, cutTick: 0`. The note still loads its instrument and pitch, so the driver's state stays the same.
- Notes in a lane can't overlap. The editor prevents it, and `check` rejects it.

How the compiler turns the timeline into patterns:

- The timeline is cut into 64-row patterns starting from row 0, and again starting from `loop`.
- If the pattern just before `loop` is shorter than 64 rows, its last row gets `D01`.
- The song's last row needs a jump unless it's row 63 of its pattern and `loop` is 0 (then the driver wraps on its
  own). With `loop` at 0 the jump is `D01`. Otherwise it's `B` to the loop's order.
- That way the song plays exactly `length` rows, then continues from `loop`.
- Identical patterns are stored once, across channels too.
- Because patterns don't depend on the grid, changing the grid can't make a song fail to compile.
- Like uge2source, the compiler emits instruments up to the highest number a note uses, with a silent placeholder
  for unused numbers below it, and waves up to the highest one the song plays. Tables are padded to 32 rows, and
  the last row jumps back to row 0 unless it jumps elsewhere, as hUGETracker writes them.

Compiler errors include:

- **A full effect slot.** Two things need the same slot, such as a note's cut and an effect, or a break or jump on
  a row where every channel's slot is taken. For volume, the suggested fix is an instrument with that starting
  volume.
- **Out of range.** A note out of range, a delay or `cutTick` past the end of its row, or a non-uniform groove with
  `loop` not a multiple of 4.
- **Pitches past the note table.** A table's note offsets or an arpeggio that take a note below C3 or above B8. The
  driver would read a period from whatever bytes follow its note table, which differ between preview and game.
  Only table rows the table's jumps can reach count. The driver keeps a channel's last note and running table when
  the song loops, so each lane is checked once from the start and again from the loop.
- **Waves.** A wave the song plays that isn't defined. A raw `9xx` above `90F` reads 16 bytes that straddle two
  waves; both must exist and be within the 16.
- **Over the driver's limits.** More than 15 instruments of a type or more than 127 orders. There is no size limit
  by default, as in hUGETracker: where a song lives is the linker's business. `gbscore check` reports the size,
  notes a song over one 16 KB bank, and fails over a `--budget N` the caller gives it. The player ROM holds 28 KB,
  so preview and `render` refuse a bigger song.

### Importing `.uge`

v1 imports V6 and V7 only, which covers anything made in a current hUGETracker. Older versions need hUGETracker's
upgrades on load (noise pitches, noise macros turned into tables), which can be ported when a real song needs them.

The reader (`src/core/uge.ts`) reads hUGETracker's FreePascal records for V6/V7. Import works like this:

1. Follow the orders in the order they play, applying `B` and `D` as the driver does (see "hUGEDriver at
   `a3c69884`"). The first time an `(order, row)` pair repeats is the loop point. The driver's position is just that
   pair, so every song comes out as a straight line plus a loop. `B` and `D` themselves don't go into the song,
   because the compiler makes its own.
2. Turn each row with a note into a note:
   - `len` runs to the lane's next note.
   - A cut at tick 0 on a later row `k` ends the note at `k`.
   - A cut on the note's own row, or a later-tick cut on a later row, sets `len` to include that row and sets
     `cutTick`.

   This way import adds no cuts that weren't in the original. A row with a note and no instrument becomes a
   `legato` note. A row with an instrument and no note is dropped, since the driver ignores it.
3. Turn every other effect into a lane effect. `Fxx`, `8xx` and `5xx` go to `global`. When two channels set the same
   one on a row, the last channel wins, as in the driver.
4. Copy instruments up to the highest one the song plays, and the waves it plays. Tables that are enabled but
   empty are dropped.

Import rejects these, with a message:

- songs that use `6xx`
- jumps the driver would follow into garbage: a `D` past row 63, a `B` past the last order, or a `D00` that cancels
  a `B` on the same row
- songs with a non-uniform groove and a break that would shift the groove's phase
- `F00`, `5xx` with the cartridge audio (VIN) bits set, and table rows the format can't hold
- anything that then fails the schema

A song that imports but doesn't compile is still written, with the compiler's errors, so it can be fixed in the
file: for example, one whose instrument table takes its low notes below C3, off the bottom of the note table.

`import --patterns` keeps the `.uge`'s own patterns as gbscore patterns; see [`docs/patterns/`](../patterns/README.md).

**Reference.** The reference for every `.uge` test song is the C that uge2source writes (from hUGETracker
`aa259a49`, which pins the same driver commit), committed next to the song and regenerated by
`scripts/make-references.sh`. uge2source is hUGETracker's own Pascal reader, so it's independent of ours.
Comparing two paths through our own reader would hide a bug in the reader.

### Playback

**Emulator: binjgb**, built as WebAssembly for both Node and the browser.

- It's MIT licensed and 99 KB, and GB Studio uses it for this same job.
- Its API is made for WebAssembly: run until a time, read and write memory, take the audio buffer.
- It can log every write to the sound registers, which gives deterministic tests.

SameBoy (MIT) was ruled out. It's more accurate, but it has no WebAssembly build and its API is harder to use for
this. If binjgb and SameBoy ever sound different, compare their sound-register logs.

**Player ROM:** a small `player.asm`, modelled on GB Studio's.

- It's a Color-only ROM in double speed, with the same timer settings as CrossZGB, so ticks come at 60.24 Hz.
- The ROM has no banks (`rgblink -t`). The player and driver take `$0000` to about `$0900`, and the song goes at
  `$1000`, with 28 KB to `$7FFF`. A bigger song doesn't fit and can't be previewed.
- It starts playing at power-on. The host stops by not running the emulator any more, and starts a new one for
  each play, so the ROM needs no controls. It counts ticks in WRAM, so the host can step one tick at a time and
  read the driver's position after each. The driver's `PREVIEW_MODE` isn't used, because its `$F4` opcode traps
  only work in hUGETracker's emulator.

**Each play:**

1. Compile.
2. Write the bytes into a copy of the ROM.
3. Start the emulator at the beginning of the song.

To play from a later point, the emulator runs silently from the start up to that point. That's the only way to get
the driver's state (envelopes, tables, panning, tempo) right. Edits made while a song plays are heard on the next
play.

Running silently that far takes seconds for a long song, against a goal of half a second. Two things make it fast:

- **`emu/halt.patch`** lets binjgb skip the cycles a halted CPU spends waiting for the next interrupt, which is
  most of them in the player ROM. Its audio and sound-register logs stay byte-identical; it plays songs two to
  three times faster.
- **Saved states.** The worker keeps the emulator's state every 64 rows of the song's first pass (about 200 KB
  each). It makes them in the background when a song opens or reloads, and as it plays, and starts from the
  nearest one. A state is only good for the compiled song and sample rate it came from, so an edit that changes
  the compiled bytes starts them again. A restored state plays on exactly as the song did the first time, audio
  included; `test/play.test.ts` checks this.

**Audio in the browser.** The emulator runs in a Worker. It sends chunks of audio to an AudioWorklet over a
MessagePort, along with the playhead read from the driver's `current_order` and `row`.

- Nothing runs on the main thread, so redrawing the piano roll can't cause dropouts.
- There's no `SharedArrayBuffer`, so hosting needs no special headers.
- **Buffering.** The worker keeps about 0.2 s of audio queued ahead of what the worklet has played. The worklet
  reports what it has played, and the worker makes more only when the queue is short. If the queue runs dry, the
  worklet plays silence and counts it.
- **Stopping.** Each play has a number. Play and Stop tell the worklet to drop what's queued, and it ignores
  chunks from older plays. Running silently to a start point happens in short slices, so Stop is handled at once,
  and the audio from it is thrown away.
- **Sound.** The emulator runs at the AudioContext's sample rate. The worker converts its 8-bit output with the
  same DC filter as the WAV export, keeping the filter's state from chunk to chunk.
- **Playhead.** The worker sends one chunk per tick, with the tick's position. The worklet reports when it starts
  each chunk, in the AudioContext's clock, and the app draws the position the speakers are playing
  (`getOutputTimestamp`), so the playhead doesn't run ahead of the sound.

**Trying an instrument:** compile a one-note song and play it on a second emulator, as GB Studio does.

**Headless:** `gbscore render` runs the same code in Node and writes a WAV file.

### Command line

- `gbscore check <song>... [--budget N]`: validate and compile. Prints errors with locations and exits non-zero on
  failure.
- `gbscore render <song> -o out.wav [--loops N | --seconds N]`
- `gbscore show <song> [--bars 9-16] [--rows | --patterns]`: a short text view of a passage, with notes by bar and
  beat, the compiled tracker rows with `--rows`, or each pattern and where it's placed with `--patterns`. It reads
  part of a song without scanning the JSON.
- `gbscore fmt <song>... [--check]`: write the song in its canonical form.
- `gbscore import <file.uge> [-o <song>] [--force] [--patterns]`, which won't replace an existing file without
  `--force`
- `gbscore export <song> --gbdk out.c [--bank N] [--name NAME] [--check]`

The README explains the format. The JSON Schema has a description for every field.

### Export

`gbscore export --gbdk` writes the C that uge2source writes: `#pragma bank`, `DN()` rows and a `hUGESong_t`
initializer, using the pinned driver's header. CrossZGB's `DECLARE_MUSIC(song)` and `PlayMusic(song, 0)` work with
it unchanged. `--check` reports when the C on disk is out of date, so a game can commit both the song and its C
and build without Node.

The driver reads song data while it runs, so a game has to keep the driver's code and the current song mapped at
the same time. Where songs go is up to the game's banking; `--bank` sets the song's bank, and 255 lets bankpack
choose.

### Web app

- **Stack:** Vite, React, TypeScript, Tailwind and shadcn/ui, with a dark, compact theme.
  - The piano roll is drawn on a canvas, with its own mouse and key handling. React only hosts it.
  - Panels, menus and dialogs are shadcn components, which handle focus and keys properly.
  - No router (it's one screen), and no piano-roll or audio libraries: none knows the driver's rows and ticks.
- **State:** one small store (Zustand) holds the song, its undo history and the view.
  - Every edit is a function from a song to a new song, in plain TypeScript, tested with vitest without a browser.
  - Undo and redo keep earlier versions of the song. Songs are tens of KB, so this is cheap, and it covers every
    edit without each one needing an inverse. A gesture, such as a whole drag, is one entry. History is bounded,
    a new edit clears redo, and reloading a file changed from outside clears history, so undo can't bring back
    the old version over someone else's edit.
  - The view (scroll, zoom, selection, which lane is expanded) is kept apart from the song (rule 3).
- **Layout:** the four lanes stacked, with one expanded. Below them, a global lane for tempo and panning, then
  instrument and wave editors. The playhead follows playback.
  - **Ghost notes**, as in FL Studio: the expanded pulse or wave lane shows the other pulse and wave lanes' notes
    faintly behind its own, at the pitch they're named, for writing one lane against another. They can't be
    clicked. The noise lane's pitches aren't notes, so it neither shows ghosts nor is one. The View menu hides
    them, and the app remembers.
  - **Scale shading**, as FL Studio's scale highlighting: the View menu's Scale picks a scale (major, minor,
    harmonic minor, Dorian, Mixolydian, and the two pentatonics) and a root. The expanded pulse or wave lane then
    shades the notes outside it, in place of the black keys, and tints the root. Turning a scale on picks the root
    that puts most of the song's pulse and wave notes, by rows held, in the scale; of roots that tie, the one held
    longest. It's a view setting: the app remembers it for each song by name, and the song file doesn't hold it.
    It only shades: notes can still go anywhere.
  - **Mute and solo:** M and S buttons under each lane's name. With any lane soloed, only soloed lanes play;
    otherwise every lane not muted does. They take effect while playing, after the audio already queued (about
    0.2 s). The emulator leaves the channels out of its mix (binjgb's `disable_sound`), so the driver still plays
    them, the snapshots stay good, and the song doesn't recompile. Notes heard while editing always sound. A view
    setting, not saved.
- **Toolbar:** one row above the roll. These rules keep it from growing into a mess as controls are added.
  - **It fits.** From 1024 px wide up, with long song and instrument names, every control is on the screen, on
    one row. `test/app/toolbar.e2e.ts` checks this at 1024, 1280 and 1920 px.
  - **Groups, in order:** the logo (it opens About: what gbscore is, who made it, the source on GitHub and the
    commit the build is from), file (the song menu), transport (Play, Loop, position), pen (instrument, note
    length, patterns: what a click or key adds), input (note entry, Play keys, hearing), view (a menu), then
    the list of keys at the far right. A divider sits between groups. A new control joins a group; one that fits
    none probably belongs in a menu, or beside what it acts on (a lane header, the panel), not the bar.
  - **Earn the space.** A button in the bar is one used several times a session. Settings set once a session go
    in a menu: the View menu for the view (ghost notes, the instrument panel, the scale), especially when the
    roll already shows them, and the song menu for the song (its settings). Save is used often, but Cmd-S and the
    unsaved dot on the song's name cover it, so it's in the song menu too.
  - **Controls and their state, nothing else.** Messages, errors and playback diagnostics go in the status line
    under everything, always there so the roll doesn't jump. Explanations go in tooltips or the list of keys.
    What the computer keyboard plays shows on the roll's keyboard, not as text.
  - **One look for each kind of control.** An action shows an icon and a verb (Play). A toggle shows an icon
    only, filled when on, and its icon doesn't change. A picker shows its value and a chevron, with no prefix
    ("1 lead", "1 beat"); a swatch or icon says what it is. A menu with no value shows a noun (Pattern, View). A
    readout is just the value (`1.1.1`).
  - **The song menu** is the song's name: it saves the song (Download, with no folder open), copies a share link,
    opens its settings, starts a new song, opens a song file, a folder or the demo song, and with a folder open
    lists its songs and checks folder access. A new song (`untitled`: four bars of 4/4, an instrument for each
    lane) and the demo song open as if from a file, as a share link does, closing the folder. There's no folder button: a song opened from a file has no folder, and the folder's name is in the
    menu and the tooltip, while Save or Download says which kind is open.
  - **Tooltips** are a name and a shortcut on one line: "Note entry (M)". Every control without words has an
    `aria-label`.
  - **Narrow screens** lose words before controls: names truncate, then below 1280 px the words on Pattern
    and View drop to their icons. Nothing goes off the screen or wraps.
- **Editing:**
  - Draw, select, move and resize notes. Copy, paste and duplicate.
  - Transpose a selection by a semitone or an octave.
  - Undo and redo cover every edit to the song.
  - Effects have names and appear on the note or the lane, not as hex.
  - Notes are edited in the expanded lane. Clicking empty space draws a note with the instrument and length of the
    note last drawn or clicked in that lane (the toolbar picks them too), and dragging sets its length.
    Dragging a note moves the selection by rows and semitones; dragging its end resizes it. Shift-click adds or
    removes a note, Shift-drag selects what it covers, and right-click deletes. Right-drag deletes every note it
    passes over, as in FL Studio, as one step of undo.
  - **Painting**, from FL Studio's paint tool: Alt-drag (Option on a Mac) from empty space lays a note of the pen's
    length every note length along the drag, either way, each at the pitch under the pointer when it was last
    there, so a drag back over a note repaints it. Notes painted win over what's there, as drawn ones do, and take
    the effect on their row, as a drawn note does. Points off the notes, as on the effect strip, paint nothing.
    The whole drag is one step of undo. Alt-drag on a note moves it as a plain drag does, for now: it's left for
    copying, as in other DAWs.
  - **A note carries the effects inside it:** the items without a note between its start and its end. Moving,
    copying or deleting a note does the same to them, and when a note gets shorter the effects past its new end
    go. Imported songs have many effects inside notes; without this, edits would leave them behind, often on the
    row where a note's end needs the slot for its cut. An effect outside every note can still sit where a moved
    note's end needs its cut; the compile error names the row and suggests a different length.
  - Paste goes at the start flag and moves the flag past what was pasted, so pastes follow one another.
    Duplicate pastes a copy a whole number of beats after the selection.
  - **Legato.** L makes the selected notes legato, or when every one already is, normal again, as one step of
    undo. A mixed selection becomes all legato. A note made normal gets the instrument it was playing with: the
    last note before it with one, as the song plays it, patterns and a placement's `inst` included, or the pen's
    when there's none. Refused on the wave lane, where the driver stops the channel and a legato note is silent. L
    is a note with note entry or Play keys on, so it's this only with both off. The status line says that hearing
    a legato note on its own can't include the note before it (see "Hearing a note"), and on noise that legato
    returns the channel to 15-bit mode. A key rather than a menu: the roll has no context menu, right-click
    deletes. The instrument panel's "Give to the selected notes" still leaves legato notes legato.
  - **Length and loop.** A right-click on the ruler opens a popover at the nearest beat: "End the song here",
    "Loop back to here", and fields for the length in bars and rows and the loop's row, set together with Enter or
    Set (field by field, a length typed a digit at a time would cut the song short on the way). Hovering the
    ruler says where the song ends and loops; the green bracket along its bottom shows it.
    - A shorter song cuts what's past its new end, as one step of undo, rather than refusing until it's cleared
      by hand: items that start past it go (notes, lane effects, song-lane items, placements), and notes and
      placements that run past it are shortened to end there, as dragging a placement's edge does. The status line
      says what went. Patterns themselves stay, placed or not.
    - A loop at or past the new end goes back to row 0 and says so, unless the fields give one.
    - Changes the compiler would reject are refused with its message: a loop at or past the end, a loop that isn't a
      multiple of 4 with a non-uniform groove, or more than the driver's 127 orders. `rangeErrors` in
      `src/core/compile.ts` is the one place those are checked.
  - **Song settings.** The song menu's "Song settings…" opens a dialog with the title, artist and comment, and the
    grid's rows per beat and beats per bar, set together with Enter or Set as one step of undo. Blank text leaves
    its key out of the file. The grid is display only (rule 6), so a change can't make the song fail to compile:
    the roll, the ruler, positions and the note lengths follow it, and a pen's length picked from the toolbar's
    list stays the same choice (a beat stays a beat), on undo too. A length that's none of them stays as many
    rows. Where a grid makes two choices the same length (on 1 row a beat and 1 beat a bar, a beat is a bar), the
    pen becomes the one the picker names it by, so going back may not bring the old choice back; the picker shows
    what it is. Undo doesn't keep the pens' history for this: they're view state, and such grids are rare. It's in
    the song menu, not the toolbar, since it's set once a session at most. The length and loop stay on the ruler,
    beside what they act on.
    - The dialog also sets the groove, the four ticks a row the song plays at until its first tempo change, in the
      same step of undo. Under it, the BPM the four steps average to at the grid's rows per beat, as tempo shows,
      and where the first tempo change is. A groove that isn't uniform, with the loop on a row that isn't a
      multiple of 4, is refused with the compiler's message (`rangeErrors`), shown as the steps are typed: move
      the loop on the ruler first. A groove that makes a delay or cut tick too late for its row is made, like
      other edits, and the error list says so.
  - A song whose file on disk isn't valid is shown as it last was, and can't be edited until the file is fixed.
- **Keys** follow DAW habits. The full list appears in the app (?, or the toolbar's keyboard button). Keys go to
  the piano roll unless a text field, menu or dialog has focus.
  - Space plays and stops.
  - Cmd/Ctrl with Z, Shift-Z, C, V, D and A.
  - Arrows move. Up and Down transpose, with Shift for an octave. Left and Right move a row, with Shift a bar.
  - Delete deletes. Escape selects nothing.
- **Note entry:** draw with the mouse, or turn note entry on (M, or the toolbar) and play two rows of the computer
  keyboard like a piano, as in Ableton (A to K white notes, W E T Y U black, Z and X an octave), or a MIDI
  keyboard through Web MIDI. Letters don't enter notes with it off, so a stray key can't add one.
  - Each note goes in at the flag with the lane's instrument and note length, and the flag moves to its end. The
    number keys or the toolbar set the length (a row, half a beat, a beat, two beats, a bar), and ← → move the flag
    a length, for rests.
  - Notes are heard as they're entered, drawn or clicked, and at each pitch they're dragged to: the app compiles a
    song of just that note in its lane, with the song's instruments, and plays it on the emulator, so it sounds as
    it will in the song. It starts within about 20 ms. It isn't heard while the song plays. A toolbar button turns
    hearing off, and the app remembers.
  - Notes pressed within 40 ms of each other, while the first is held, are a chord. Fast playing overlaps notes
    too, but by more than that.
  - MIDI middle C (60) is C5, since note names here are an octave above scientific pitch.
  - Note entry ignores key repeat. Keys and MIDI notes still held when the window loses focus are released.
  - **Lanes play one note at a time.** Notes that are placed, moved, pasted or entered win: a note they start
    inside is shortened to end where they begin, and notes that start inside them are removed. Of notes entered
    together, as a MIDI chord, the last wins.
  - Transposing past C3 or B8 does nothing and says why.
- **Play keys** (Shift-M, or the toolbar), for working on instruments: the same keys and MIDI keyboard play notes
  without entering them, as FL Studio's typing keyboard does. The app remembers it.
  - A note sounds while its key is held, up to 30 s, with the instrument the expanded lane's new notes get, as it
    is now. Letting go stops it at once, as the cut at a note's end does in the song.
  - One note at a time, as on a channel: a new key takes over, and letting go of an older one still held does
    nothing.
  - It sounds even with hearing off, but not while the song plays: keys do nothing then. Playing along with the
    song would need a second emulator.
  - With note entry on too, keys enter notes as before.
- **The roll's keyboard**, left of the expanded lane, plays a key while it's clicked and held, as Play keys does,
  whether either is on, and dragging along it plays each key passed. It never enters a note. The keys held down,
  there or on the computer or MIDI keyboard, are lit in the colour of the instrument they play. With note entry or
  Play keys on, a blue bar beside it marks the keys the computer keyboard plays, from A up, so Z and X move it.
- **Instruments and waves:** a panel under the roll (I, or the View menu) shows the instruments of the expanded
  lane's kind, with how many notes use each, and edits the one new notes get. Picking one there or clicking a note
  picks it for new notes, so there's no separate "instrument being edited".
  - Each field has a control: duty, level and noise mode as buttons; volume, envelope, sweep and length as
    sliders, with what they mean in time beside them ("fades out over 609 ms"). The length slider runs the other
    way from the driver's value, so right is longer.
  - New, duplicate and delete. Delete refuses while notes use the instrument; "Give to the selected notes" moves
    them to another first. A new wave instrument plays the first wave, made if the song has none. The toolbar's
    instrument picker has New instrument too, which opens the panel, so a lane whose kind has no instruments
    isn't a dead end with the panel closed.
  - Waves are drawn with the mouse on a 32-by-16 grid, or set from presets (sine, triangle, saw, square). Editing
    a wave changes every instrument that plays it, and the panel says which. A new wave is a copy of the
    instrument's current one. A wave's name is edited above its drawing. A wave other than the instrument's own
    can be deleted from the × on its button, shown on hover; the delete is refused while a wave instrument plays it
    or a wave effect switches to it (on the wave lane, in a wave pattern or in a wave instrument's table), as
    instrument deletion is while notes use the instrument. The others keep their numbers. With no wave
    instruments, the panel lists the waves left in the song so they can still be deleted.
  - Tables are edited on the panel's Table tab (see "Tables").
  - A drag on a slider or across the wave is one step of undo, and the song compiles when it ends: compiling a
    large song takes tens of milliseconds, too slow for every pointer move. Clicks and keys are a step each.
  - Each change is heard 150 ms after the changes stop, with hearing on: the first selected note, or the last
    note played with Play keys (C5 until one is) for two beats. Try plays it even with hearing off, stopping the
    song if it's playing.
- **Tables:** an instrument's table runs one row per tick from the start of each note it plays (`do_table`: a
  note with an instrument resets the row to 0 and runs it on that same tick). A row can set the pitch, as
  semitones from the note (not from the row before); an empty pitch leaves it as it was. A row can have one
  effect, and can jump. After row 31 the table goes back to row 0. A chord, for example, is a few rows of offsets
  whose last row jumps back to row 0.
  - **Shape:** a strip of 32 columns, one per table row, rather than a tracker grid: it fits the panel's height,
    and shows an arpeggio or a pitch drop as a shape. Columns are rows, not ticks: jumps decide which row plays
    on each tick. It has three lanes:
    - **Pitch:** a bar per row from the zero line, with its number under it, drawn with the mouse as waves are.
      Right-click clears a row's pitch. A row without one shows nothing: what it holds depends on the row that
      played before it, which jumps decide. The range is ±12 semitones, and can be widened to ±24 or ±36.
    - **Effect:** each row's effect, short ("vol 0", "duty 25%", "arp 4,7"), edited in a popover with the named
      effects tables can use on that kind of instrument (no glide, delay or cut; see "Song model and file"; duty
      only on duty instruments, wave only on wave ones), and a field for raw hex. A raw effect, such as an
      imported duty byte with length bits (`9D0`), shows as its hex. The same editor serves lane effects.
    - **Jump:** "→ 0" on a row that jumps. A popover sets or clears it (rows 0 to 30; the driver can't jump to
      31). Row 31's jump back to row 0 shows, dim, unless row 31 jumps elsewhere. There are no row-boundary lines
      or held-pitch hints, which jumps would make wrong.
  - Rows past the last one used are dim. An edit keeps the table's rows up to the last one with anything in it,
    and removes a table left with nothing in it, as import does; both play the same as before. Tables that aren't
    edited stay as they are in the file.
  - **Presets:** major and minor arpeggios, octave, pluck (an octave up for one tick, then the note, held), and
    a fall (down an octave over 12 ticks, held), plus clear. "Held" is a row that jumps to itself.
  - Drawing a stroke is one step of undo; each popover change is one. Changes are heard as other instrument
    changes are.
  - The tab sits beside the instrument's name ("Sound | Table"), since the panel can't fit both.
  - The compiler's errors for tables (pitches past the note table) show in the error list.
- **Effects on the timeline.** A lane has one effect slot per row, whether the effect is a note's `fx` or an item
  without a note. So the editor shows and edits effects by row, and where one is stored follows from the row: on a
  row where a note starts, in that note's `fx`; on any other row, in an item without a note.
  - **Effect strip:** the bottom 24 px of the expanded lane, one effect per row.
    - Volume is a bar from 0 to 15, as DAWs draw velocity, over a baseline so that volume 0 still shows. It's the
      effect songs use most. Other effects are a mark, with a short label ("vib 4,2", "down 8") when it fits
      before the next effect. Hovering shows the effect in full and its position.
    - **Rows a note's end needs.** The compiler cuts a note on the row where it ends, unless the next note starts
      there, and with `cutTick` on its last row; either takes that row's slot. The strip shows these rows as a dim
      "end", and won't put an effect there: the popover says which note ends there and to change its length. A
      `cutTick` can be changed or removed there, so one a tempo change made invalid can be fixed. A note without
      one gets one from the popover on its last row, at the row's middle tick to start; it's refused while an
      effect holds that row's slot, and the popover names the effect.
    - Click a row to edit its effect in a popover: the effect editor from tables, offering the effects the lane's
      kind can use. Cut is offered only outside notes, since a cut inside a note is an error and a note's own
      ending is its `len`. Delay and cut can't go past the row's ticks. ‹ and › step to the row before or after,
      for rows too narrow to click at the zoom. Right-click deletes the effect. Each change is a step of undo.
    - After a change, the note the effect is in is heard, with hearing on.
    - **Drawing a note** on a row with an effect and no note keeps the effect, as the new note's `fx`, unless it's
      a cut. Other effects the new note covers go: placed notes win.
    - **Drawing volume**, as DAWs draw velocity: drag along the strip, and each row passed gets the volume the
      pointer's height gives, the strip's bottom 0 and its top 15, as the bars are drawn. It draws only on rows
      where a note starts or a volume already is. Rows with another effect keep it, since a row has one slot, and
      so do rows a note's end needs. A volume on an empty row inside a note retriggers it (`C0v`), so it's put
      there one at a time with a click. The drag is one step of undo, and the note whose volume changed last is
      heard. A click that doesn't move opens the popover when it's let go.
    - **Selecting effects** apart from their notes: Shift-click a row's effect to add it or take it out, and
      Shift-drag along the strip to add the effects it covers. Selected effects are drawn white, and are kept as
      rows, whether a note or an item without one holds each. Notes or effects are selected, not both: selecting
      one clears the other, so the keys act on whichever it is. With effects selected, Delete deletes them, ← →
      move them a row (a bar with Shift), and Cmd-C and Cmd-X copy and cut them, effects only, never their
      notes. Cmd-V pastes what was copied last, notes or effects, at the flag, and moves the flag past it. Esc
      selects nothing, and Cmd-A selects the notes. Keys for notes alone (↑ ↓, L, Cmd-D, Cmd-G) have no notes to
      act on. Pasted and moved effects go into a note's `fx` where a note starts, and an item without a note
      elsewhere, replacing the effect there.
    - **Dragging effects:** drag a selected effect to move the selection by rows. A drag that starts anywhere
      else on the strip draws volume, so redrawing over volume bars, the common case, isn't taken for a move.
      With Shift, a press selects and never moves or draws; right-click deletes the row's effect. A press is a
      click until it moves 3 px. The effects move together, from where they were when the drag began, so
      neighbours don't overwrite each other, and the drag is one step of undo. A move or paste is refused whole,
      with the reason, if any effect would land on a row a note's end needs, be a cut inside a note, be a delay
      or cut past the ticks of its new row, or not suit the lane (duty pasted on the wave lane); a drag stays
      where it last could be.
    - Effects selected or moved stay in the target of edits, as notes do: the loose notes, or the place a
      pattern plays (docs/patterns/). Shift-drag selects only the target's effects.
    - Not done: right-drag deleting the effects passed, ↑ ↓ changing a volume, and drawing volume on empty
      rows.
  - Collapsed lanes keep their marks for effects.
  - **Song lane:** a strip 30 px tall under the four lanes, for `global`.
    - Three tracks, one each for tempo, pan and master volume, so kinds on one row don't hide each other. Each item
      is a mark, labelled when the label fits before the next: tempo as ticks per row ("6"), pan as "pan", master
      volume as "7,7". A song that swings with `Fxx` can have a tempo on every row, so at most zooms it's a run of
      marks; hovering a row shows everything on it.
    - Click a row to edit, in one popover, its tempo, pan and master volume. Each can be on or off, since a row
      can have one of each, and each is its own item in the file. ‹ and › step a row. Right-click clears the row.
    - Tempo also shows the BPM it makes at the grid's rows per beat: 6 ticks a row at 4 rows a beat is 150 BPM.
      Pan is a left and a right toggle per lane, and master volume a choice of 0 to 7 per side.
    - The groove before the first tempo change is edited in the song settings, not here.
  - **Errors on the roll:** a compile error with a lane and row tints that row's column red in its lane, or in
    the song lane for `global` errors, collapsed or not. Hovering shows the message, and the error list still
    jumps to it. A `global` error can be about the compiler's own jump at the loop finding no free slot, with no
    item in the song lane; its message says so and which lane effects to move. Errors without a row (instruments,
    waves, the song's size) stay in the list only.
  - **Hearing a note** (as it's drawn, clicked or entered, and after an effect change) includes the effects
    inside it, at the tempo and groove it has in the song, through its whole length. It's still the note on its
    own: what came before it (pan, master volume, a glide's starting pitch, a legato note's instrument) isn't
    there. Playing the song is how to hear those.
- **Opening files:** the app opens a folder with the File System Access API and lists its `.gbscore.json` files,
  skipping the `._` files macOS can leave on network shares. It remembers the folder between visits; Chrome asks
  again for permission with one click.
- **Without a folder:** a song can be opened from a file on its own, the only way in browsers without the File
  System Access API (Brave turns it off unless `brave://flags/#file-system-access-api` is on; Firefox and Safari
  lack it). The browser hands over the file's contents, not the file, so saving downloads the song, and the app
  doesn't see changes to the file or check for them before saving. The song stays marked unsaved after a download,
  since the app can't tell whether it finished, so closing the tab still asks first. Opening a file closes the
  folder. The app keeps the song's text, as opened or last downloaded, in local storage and reopens it on the next
  visit; opening a folder forgets it.
- **Share links:** the song menu's Copy share link copies a link with the song in it, as it is, unsaved edits
  and all, so sharing needs no server or storage (`src/app/share.ts`).
  - The song's JSON, minified, deflated (zlib, with the browser's `CompressionStream`, so its checksum catches a
    garbled link) and in base64url, goes in the address's fragment with the file's name:
    `#v=1&name=halt_bug&song=…`. Browsers don't send the fragment, so the host's limit on addresses doesn't apply.
    The JSON compresses 12–20×: the demo song's 85 KB file is a link of about 7,000 characters, a 160-bar song
    imported from hUGETracker about 40,000 (20,000 imported with `--patterns`). Browsers open links that long; chat
    apps may not (Discord cuts at 2,000), so the status line says how long the link is, and warns when it's over
    2,000 characters.
  - `v` is the link's format. A link is a snapshot that can't be taken back, so every `v` the app has written
    must stay readable; a new encoding gets a new `v`. The song inside has its own `version`.
  - Opening a link opens the song as if from a file, before any other song or folder would reopen, and takes the
    link out of the address, so a reload reopens the song as for a file. A link pasted into a tab already open opens
    too, after asking about unsaved edits. A link cut short or garbled says it's damaged, and one whose song isn't
    valid says why, without replacing the open song. Declining to throw away edits for a pasted link takes it out of
    the address.
  - Not done: short links. They'd need storage, such as a gist or a blob store, for what would be a short code.
- **First visit:** with no song or folder to reopen, the app opens a demo song, *HALT Bug*
  (`src/app/demo/halt_bug.gbscore.json`), as if from a file.
- **Saving:**
  - Saving is explicit (Cmd-S), with a marker for unsaved changes. It writes the canonical form (rule 4).
  - Before writing, the app reads the file again and compares it with the text it loaded or last saved. If they
    differ, it doesn't overwrite the file. It writes this version next to it as `<name>.mine-<time>.gbscore.json`
    and says so.
  - Saving doesn't write GBDK C; `gbscore export` does.
  - This is best effort: a write can still land between the check and the save. For one person handing a song
    back and forth with another tool, that's enough.
- **Changes from outside:** the app reads the open file about once a second and compares it with the text it
  loaded. Polling works the same on a network share, so `FileSystemObserver` isn't used.
  - If there are no unsaved edits, it reloads and keeps the view.
  - If there are unsaved edits, it says the file changed and offers both versions. Neither choice loses one:
    loading theirs writes yours next to it as a `mine` copy, and keeping yours writes theirs as a `theirs` copy.
- **File rules.** These keep the app from losing edits to its own timing:
  - File operations run one at a time.
  - The app keeps the text last read from or written to disk apart from the song being edited. A save writes a
    copy of the song as it was, and updates that text only once the write has closed. Edits made during the save
    stay unsaved.
  - A read is thrown away if the song was edited, or another file opened, while it ran.
  - A failed read, parse, permission check or write leaves the song as it is and says what failed. If the folder
    is unmounted or permission lapses, the app asks to reopen it.
- **Folder access check.** A folder on a network share may not show changes both ways at once: Samba, for one,
  caches files for the client in ways that depend on its settings. "Check folder access", in the song menu, writes
  a probe file (`gbscore-probe.txt`) for the other machine to see, then shows what the app reads there as the file is
  changed from outside, in place or by replacing it. If the app sees stale contents, the fix is in the share's
  settings, not the app.
- **Hosting:** a static build (`npm run build:app`, into `dist/web`), deployed to Vercel on each push to `main`,
  at https://www.gbscore.com. The site holds no songs. Chrome only allows folder access and audio worklets over
  HTTPS or on localhost.

### Alternatives considered

- **Fork GB Studio's music editor.** Its model is tracker rows with hex effects. It lives inside GB Studio's app
  state, ticks at 64 Hz, has no grooves and doesn't reload files from disk. Our model, file workflow and tick rate
  would mean rewriting most of it. Instead we borrow its playback approach and use `patchRom()` and `exportToC` as
  references.
- **Store tracker rows under the piano roll.** The file would hold driver rows, and the editor would work out note
  lengths for display. Import would be trivially lossless, but people, scripts and MIDI think in notes with
  lengths, and every edit to the file would need to manage cuts by hand. With import limited to V6/V7 and
  `cutTick` for mid-row cuts, notes with lengths cover the songs we need.
- **MIDI as the file format.** It has no place for instruments, tables, waves or effect slots. Midi2Uge reports
  25–80% success converting MIDI.
- **fortISSimO.** It can't link into GBDK yet, and it has no groove.
- **Move to `latest-stuff`.** It's untagged and its format changed in Aug 2026. We take only its `Fxx` fix, and
  look again once it gets a tag.

## Passes

Every pass ships something usable and ends with its checks passing.

1. **Core.** Song model and schema, V6/V7 reader, compiler, import, and `check`, `show`, `fmt` and `import`.
   Accepted when, for every `.uge` test song (`test/reference.test.ts` for the public V7 one; the V6 songs are
   third-party and can't be redistributed, so their tests live in the gitignored `test/private/`):
   - It imports.
   - **A V7 song keeps its layout**, so its compiled orders, patterns, instruments and waves match the ones
     decoded from uge2source's C exactly.
   - **V6 songs get re-cut into new patterns.** For them, compare what plays: walk both our data and uge2source's
     data the way the driver does (orders, `B`, `D`). Each channel must play the same sequence of rows, ignoring
     the `B` and `D` effects themselves, plus the same instruments and waves.
   - Every compiler error and import rejection has a test.
   - The comparison walks both sides with the same `walk()` that import uses, so a mistake in following `B` and
     `D` could hide on both sides. `test/driver.test.ts` checks `walk()` against the driver's code, and pass 2's
     register logs check it again.
2. **Playback.** binjgb build, player ROM with the patched driver, `gbscore render`. Accepted when
   (`test/play.test.ts`):
   - The test songs render to WAV in Node. On the emulator each plays every row of the timeline in order, then the
     loop, with the same rows and ticks per row as the driver model the pass-1 comparison uses.
   - **`Fxx`, by timing:** a song that swings with alternating `Fxx` is checked against V6 behavior, not against
     the unpatched tracker: its ticks per row, measured from the sound-register log, follow its `Fxx`.
   - A song with `Fxx` and a non-uniform groove plays with a uniform groove from the `Fxx` onward, and after the
     loop.
   - Built without the `Fxx` patch, these tests fail.
   - Sound-register logs are saved as golden files under `test/golden/`, checked by `npm test`.
   - binjgb's output stays 8-bit: renders checked by ear weren't noisy.
3. **GBDK export.** `gbscore export --gbdk` writes the same C as uge2source apart from pattern numbers and the
   header comment, and GBDK compiled both to the same bytes. Exported songs read back as what they compile to
   (`test/export.test.ts`).
4. **Web app and hosting.** Open a folder, piano roll, instruments, waves, playback with a playhead, saving with
   the conflict check, reloading on outside changes, keyboard and MIDI note entry, and a deploy. Done when, in
   Chrome at the hosted URL, someone can enter notes quickly and reliably, transpose a selection, use the keys
   without looking them up, and see an outside edit appear without losing unsaved work. It's built in four steps,
   each ending deployed:
   1. **View and play.** App shell, opening a folder, a read-only piano roll of all four lanes, play and stop from
      any row with a playhead, compile errors listed, reloading on outside changes, and the folder check. Done.
   2. **Edit notes.** Draw, select, move and resize; copy, paste and duplicate; transpose; undo and redo; the
      keys; saving with the conflict check; length and loop. Opening one song from a file, for browsers that
      can't open folders. Done. Not in it: Alt-drag to copy, and dragging past the edge to scroll.
   3. **Note entry.** The computer keyboard as a piano, a MIDI keyboard, and step entry, each note heard as it
      goes in. Built and tested in headless Chromium with a stand-in MIDI keyboard; not yet tried with a real
      one.
   4. **Sound design:** instruments and waves, tables, and effects on the timeline with the song lane and errors
      on the roll. Built and tested in headless Chromium.

## Open questions

- **binjgb's Color-mode sound.** Does it match closely enough in double speed? It passed a by-ear check against
  hUGETracker in pass 2. It hasn't been compared with SameBoy or hardware.
- **Cut at the end of a note.** Short `len` values sound staccato, which surprises people writing the file by
  hand. The README says so; a "let it ring" flag may be needed.

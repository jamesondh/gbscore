# <img src="src/app/logo.svg" width="32" height="32" alt=""> gbscore

A Game Boy music editor for people who'd rather use a piano roll than a tracker. It runs in the browser and plays
songs on an emulator as you write them. Songs are plain JSON files, one per song, that diff well and that you can
also edit by hand. One compiler turns them into hUGEDriver data, both for playback and for your game.

There's the song format, the compiler, `.uge` import, playback on an emulator, a command line, GBDK export, and
an editor that opens a folder of songs, plays them, and edits their notes, effects, patterns, instruments and
waves, with note entry from a computer or MIDI keyboard. The design and its status are in
[`docs/editor/`](docs/editor/README.md).

## Commands

```sh
npm install
npm run gbscore -- check song.gbscore.json             # validate and compile; errors give bar.beat.row and lane (--budget N: fail over N bytes)
npm run gbscore -- render song.gbscore.json -o song.wav  # play it on the emulator (--loops N or --seconds N)
npm run gbscore -- show song.gbscore.json --bars 9-16  # notes by bar and beat
npm run gbscore -- show song.gbscore.json --rows       # the compiled tracker rows
npm run gbscore -- show song.gbscore.json --patterns   # each pattern's notes, and where it's placed
npm run gbscore -- fmt song.gbscore.json               # rewrite in canonical form (--check to only report)
npm run gbscore -- import song.uge -o song.gbscore.json  # hUGETracker V6/V7 songs (--patterns to keep its patterns)
npm run gbscore -- export song.gbscore.json --gbdk song.c  # GBDK C for a game (--bank N, --check)
```

`npm run build:cli` bundles the command into `dist/gbscore.js`.

The editor is at **https://www.gbscore.com**, deployed from `main` on every push. It works best in Chrome or Edge,
which can open folders on your computer. Other browsers, and Brave unless
`brave://flags/#file-system-access-api` is on, can open one song from a file; saving downloads it, and the
song stays marked unsaved, since the app can't tell whether the download finished. To work on it:

```sh
npm run dev        # a dev server on localhost
npm run build:app  # the static site, in dist/web
npm run test:app   # builds it and runs the browser tests in headless Chromium
```

Open a folder of `.gbscore.json` files, pick a song, and press Space to play from the flag (click the ruler to move
it). Right-click the ruler to end the song there or loop back to there, or to set its length and loop by number.
Scroll with two fingers or the wheel, Shift for sideways, and pinch or Ctrl-wheel to zoom. Click a lane to
expand it. In the expanded lane, click to draw a note and drag to set its length; drag notes to move them, or their
ends to resize them. Press M for note entry: then the keys from A to K, and a MIDI keyboard, play notes in at the
flag. Notes are heard as you enter, draw or click them (the speaker button turns that off). The strip along the
bottom of the expanded lane holds each row's effect, and the Song lane under the lanes holds tempo, pan and master
volume: click a row in either to edit it, right-click to clear it. Drag along the effects to draw volume on the
notes, as velocity; Shift-click or Shift-drag selects effects apart from their notes, to move, copy or delete them.
Compile errors are tinted red on their row.
Placed patterns are tinted bands. Their notes edit like any others, and every place the pattern plays changes with
them. The strip along the top of the expanded lane handles them like clips: click one to select it, drag to move
it, Alt-drag to copy it, drag its right edge to repeat it or cut it short, and click empty strip to place the
current pattern there. The bar above the roll sets a selected one's transpose, repeat and instrument, and has Make
unique and Unpack. **Pattern** in the toolbar makes a pattern of the beats the selected notes span (Cmd-G), or picks
the current pattern. **Keys** in the toolbar lists the rest. Cmd-S saves.

When the open song changes on disk (another editor, a script, a git pull), the app reloads it within a second. If
you have unsaved edits, it asks which version to keep and writes the other next to the song as a `.mine-` or
`.theirs-` copy; a save never overwrites a file that changed on disk since it was loaded. **Check folder access**,
in the song menu at the top left, tests that writes and outside changes both get through, such as on a network
share.

`export` writes the C uge2source writes, so CrossZGB's `DECLARE_MUSIC(song)` and `PlayMusic(song, 0)` work
unchanged: the song is `song_uge`, in the bank `--bank` gives (255, the default, lets bankpack choose).

`render` plays the song once through by default, stopping where it would loop. It runs the same driver a game
links, on the binjgb emulator, at CrossZGB's 60.24 ticks a second, and writes 16-bit stereo at 44.1 kHz. binjgb
mixes to 8 bits; a 20 Hz high-pass takes out the Game Boy's DC offset, as the hardware's capacitor does.

## The song file

A song is one `<name>.gbscore.json` file. [`schema/gbscore.schema.json`](schema/gbscore.schema.json) describes every
field. `gbscore fmt` writes the canonical form, the same bytes the editor writes, so diffs show only real changes.

```json
{
  "version": 1,
  "grid": { "rowsPerBeat": 4, "beatsPerBar": 4 },
  "groove": [6, 6, 6, 6],
  "length": 64,
  "loop": 0,
  "instruments": {
    "duty": [{ "id": 1, "name": "lead", "duty": "50%", "volume": 12, "envDir": "down", "envPace": 3 }],
    "wave": [],
    "noise": [{ "id": 1, "name": "hat", "volume": 8, "envDir": "down", "envPace": 1 }]
  },
  "waves": [],
  "lanes": {
    "pulse1": [
      { "row": 0, "len": 4, "note": "E5", "inst": 1 },
      { "row": 4, "len": 4, "note": "G5", "inst": 1, "fx": { "vibrato": [4, 2] } },
      { "row": 8, "len": 2, "note": "A5", "legato": true }
    ],
    "pulse2": [],
    "wave": [],
    "noise": [{ "row": 0, "len": 1, "note": "C7", "inst": 1, "cutTick": 2 }]
  },
  "global": [{ "row": 32, "tempo": 5 }]
}
```

### Time

- Everything sits on one timeline of **rows**, counted from 0. `length` is the song's length in rows, and the song
  plays them all, then continues from row `loop`.
- **`grid`** is for display only. Positions in messages read `bar.beat.row`, counting from 1, so with 4 rows per
  beat, `3.2.2` means the same as it does in Ableton.
- **`groove`** gives each row's length in ticks, cycling every 4 rows. A CrossZGB game ticks 60.24 times a second, so
  `[6, 6, 6, 6]` with 4 rows per beat is 60.24 × 60 / 24 ≈ 151 BPM, and `[5, 5, 5, 7]` swings. If the groove isn't
  uniform, `loop` must be a multiple of 4.
- **`tempo`** in `global` changes speed mid-song. It sets all four groove steps to one value.

### Notes

- **`note`** names run from C3 to B8 and use sharps (`C#5`, not `Db5`). They're hUGETracker's names, which are also
  FL Studio's: **A5 is 440 Hz**. Scientific pitch, where middle C is C4, numbers every octave one lower (A4 is 440 Hz
  there).
- **`len`** is in rows. When a note's rows run out, the compiler cuts it, unless the lane's next note starts right
  there or the song ends. Short `len` values sound staccato; to let a note ring, extend `len` to the next note.
- **`cutTick`** ends the note partway through its last row instead, at that tick.
- **`inst`** picks an instrument of the lane's kind: duty for `pulse1` and `pulse2`, wave for `wave`, noise for
  `noise`. Every note needs `inst`, or **`legato: true`**, which changes the pitch without restarting the note: no
  new attack, and the previous note's instrument, envelope and table carry on. A legato note after silence is
  silent. It works on the pulse and noise lanes (on noise it also returns to 15-bit mode), not on `wave`, where
  the driver stops the channel.
- Notes in a lane can't overlap.

### Effects

Each lane has one effect slot per row. A note's `fx` uses its row's slot, and an item with just `row` and `fx`
puts an effect on a row without a note. Song-wide effects and the compiler's own loop jumps also need a free slot
on some lane in their row.

| Effect | Tracker | What it does |
|---|---|---|
| `{ "arp": [x, y] }` | `0xy` | arpeggio: the note, +x and +y semitones, cycling every tick |
| `{ "slideUp": n }`, `{ "slideDown": n }` | `1xx`, `2xx` | slide the pitch by n units per tick |
| `{ "glide": n }` | `3xx` | glide toward this row's note (tone portamento) |
| `{ "vibrato": [speed, depth] }` | `4xy` | vibrato |
| `{ "delay": n }` | `7xx` | start this row's note n ticks late |
| `{ "duty": "25%" }` | `9xx` | pulse lanes and duty tables: change the duty cycle |
| `{ "wave": n }` | `9xx` | wave lane and wave tables: switch to wave n |
| `{ "volSlide": [up, down] }` | `Axy` | retrigger the note louder or quieter |
| `{ "volume": v }` | `C0v` | set the volume (0–15) and restart the note; the wave channel has 4 levels |
| `{ "cut": t }` | `Exx` | cut at tick t (lane items only; notes use `len` and `cutTick`) |
| `{ "raw": "9D0" }` | any | an effect the names can't express, as tracker hex; only where no name fits |

`global` items each hold a row and one of `tempo` (`Fxx`), `pan` (`8xx`: `"LR"`, `"L"`, `"R"` or `"off"` for
each of pulse1, pulse2, wave and noise) and `masterVolume` (`5xy`: left and right, 0–7).

### Patterns

A pattern is a run of notes for one lane, written once and placed wherever it plays. Change it, and every place
changes. Use them for anything that repeats: a bass line, a drum loop, a riff moved up a fourth for the chorus.

```json
"patterns": [
  { "id": "bass", "kind": "duty", "length": 16, "items": [
    { "row": 0, "len": 4, "note": "C4", "inst": 1 },
    { "row": 8, "len": 4, "note": "G4", "inst": 1 }
  ] }
],
"lanes": {
  "pulse1": [
    { "row": 0, "pattern": "bass", "repeat": 2 },
    { "row": 32, "pattern": "bass", "transpose": 5 },
    { "row": 48, "len": 16, "note": "C5", "inst": 1 }
  ],
  "pulse2": [
    { "row": 2, "pattern": "bass", "repeat": 2, "inst": 2, "len": 30 }
  ]
}
```

- **`kind`** is the instruments its notes use: a `duty` pattern goes on either pulse lane, `wave` and `noise` on
  their own. **`length`** is in rows. **`items`** are notes and effects as in a lane, with rows counted from the
  pattern's start; each must start before `length`, and each note end by it.
- **A placement** is a lane item with `row` and `pattern`, plus optionally **`transpose`** (semitones added to its
  notes, not its effects), **`repeat`** (how many times it plays back to back), **`inst`** (the instrument its
  notes play with, in place of their own; legato notes stay legato) and **`len`** (the rows it plays, cutting its
  last repeat short: notes starting after the cut are left out, and one running past it ends there). It has its
  rows to itself: nothing else in that lane can start in them, and no note can run into them.
- An echo on the other pulse lane is the same pattern a few rows later on a quieter instrument:
  `{ "row": 3, "pattern": "lead", "inst": 4 }`.
- It plays exactly as its notes would written out at those rows. A note ending where the next one starts gets no
  cut, a legato note at a pattern's start carries on the one before it, and so on.
- Errors inside a pattern give the timeline position and the pattern's own: `3.1.1 (row 32), pulse1, pattern bass
  at 1.1.1 (its row 0): …`. A pattern nothing places is checked as if placed at row 0 of a song of its own.
- `gbscore show` shows notes as they play, each lane line starting with the patterns there; `show --patterns` lists
  each pattern and where it's placed. Patterns don't change the compiled bytes: the compiler writes them out first.
- `gbscore import --patterns` turns each hUGE pattern into a pattern named for its number (`p07`), placed where the
  orders play it. A note that sounds on past its hUGE pattern's end stays a loose note, and the patterns either
  side stop short of it; a pattern holding only some of a hUGE pattern's rows is named for them (`p07 rows 4-63`).

### Instruments and waves

Up to 15 instruments of each kind, numbered 1–15, and up to 16 waves, numbered 0–15. The fields mirror the
hardware, and the schema describes each one:

- **duty:** `duty`, `volume`, envelope (`envDir`, `envPace`), pitch sweep (`sweepTime`, `sweepDir`,
  `sweepShift`; pulse 1 only), `length` and `lengthEnabled`.
- **wave:** `wave`, `level` (`"100%"`, `"50%"`, `"25%"`, `"0%"`), `length` and `lengthEnabled`.
- **noise:** `volume`, `envDir`, `envPace`, `bits` (15 or 7), `length` and `lengthEnabled`.
- **waves:** `data` is 32 samples, one hex digit (0–F) each.

Any instrument can have a **`table`** of up to 32 rows that runs one row per tick from the start of each note. A
row can shift the pitch (`note`, in semitones), apply an effect (`fx`) and jump to another row (`jump`). After row
31 the table goes back to row 0 unless a row jumps. Tables can't use `glide`, `delay` or `cut`, which the driver
can't run from a table, and every pitch a table or arpeggio reaches must stay within C3–B8.

### Limits

The compiler stops with an error, giving the position and lane, when a song breaks one of these:

- one effect per lane per row
- up to 127 orders of 64 rows, about 8,100 rows

## Scripts and agents

The format and the command line suit scripts and coding agents as well as people: `check` gives errors by bar,
beat and lane, `show` prints the notes as text, `fmt` keeps diffs to real changes, and the schema describes every
field. [`AGENTS.md`](AGENTS.md) is the guide to working on gbscore itself.

## License

gbscore is MIT licensed; see [`LICENSE`](LICENSE). It includes code from others under their own terms:

- [`driver/`](driver/README.md): hUGEDriver, by SuperDisk and contributors, which is public domain, with the
  `hardware.inc` it ships (gbdev's, CC0).
- [`emu/`](emu/): binjgb, by Ben Smith, built into `emu/binjgb.wasm`. Its MIT license is in
  [`emu/LICENSE.binjgb`](emu/LICENSE.binjgb).

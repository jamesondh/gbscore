# Patterns

Reusable runs of notes for one lane, placed on the timeline as many times as a song needs them, like FL Studio's
patterns or Ableton's clips. Status is at the end.

## Why

A song is one flat timeline per lane. Long songs repeat themselves heavily: cut a large imported song into 16-row
chunks, and most chunks are copies of a few. Written out flat, its file runs to thousands of lines. Anyone editing
the file, by hand or with a script, has to read and rewrite every repeat, and a person changing a riff in the
editor has to change each copy.

With patterns, a riff is written once and placed where it plays. Changing it changes every place. A file reads as
an arrangement ("verse bass four times, then up a fourth for the chorus") instead of thousands of notes.

## Not hUGE's patterns

hUGETracker also has patterns, but they're a different thing: always 64 rows, and the four channels move through
their order lists together, so a pattern break or jump on one moves them all. A pattern here is any length, on one
lane, and placed at any row. They can't map onto hUGE's patterns one to one, and they don't try to.

Patterns are written in the song file only. Before compiling, `expand()` replaces each placement with the
pattern's notes at that row, giving the flat timeline the compiler already takes. So:

- The compiler, the driver, the golden sound-register logs and the reference tests don't change.
- A song compiles to the same bytes whether its notes are in patterns or written out.
- Patterns don't make songs smaller once compiled. The compiler already cuts each lane into 64-row tracker patterns
  and stores identical ones once, so repeats that line up with 64 rows share bytes, with or without patterns here.

In messages and docs, "pattern" means these. The compiled ones are "tracker patterns" (`gbscore check` reports
"3 orders, 7 tracker patterns").

## The file

```json
"patterns": [
  {
    "id": "bass-a",
    "kind": "duty",
    "length": 32,
    "items": [
      { "row": 0, "len": 4, "note": "C4", "inst": 1 },
      { "row": 8, "len": 4, "note": "G4", "inst": 1, "fx": { "vibrato": [4, 2] } }
    ]
  }
],
"lanes": {
  "pulse1": [
    { "row": 0, "pattern": "bass-a", "repeat": 4 },
    { "row": 128, "pattern": "bass-a", "transpose": 5 },
    { "row": 160, "len": 4, "note": "G4", "inst": 2 }
  ]
}
```

- **`patterns`** is a list, sorted by `id` in the canonical form (by UTF-16 code units, not by locale). A song
  without patterns leaves it out, so flat files don't change.
  - `id`: a name of 1 to 32 characters, without spaces at either end, unique in the song. Placements use it, and
    match it exactly.
  - `kind`: `duty`, `wave` or `noise`, the instruments its notes use. A `duty` pattern can go on either pulse lane,
    so a riff can be echoed or harmonised on the other. `wave` and `noise` patterns go on their own lane.
  - `length`: in rows, at least 1.
  - `items`: notes and effects as in a lane, with rows counted from the pattern's start. They follow the lane rules
    (no overlaps, one effect per row) and must fit: every item starts before `length`, and every note ends by it. A
    note can't carry on past its pattern's end.
  - Patterns can't contain placements.
- **A placement** is a lane item with `row` and `pattern`, and optionally:
  - `transpose`: semitones added to every note, −71 to 71. Effects are unchanged, so an arpeggio keeps its
    intervals. A transposed note outside C3–B8 is an error at that note.
  - `repeat`: how many times it plays back to back, at least 1. The canonical form leaves out `repeat: 1` and
    `transpose: 0`.
  - `inst`: the instrument every note of the pattern that names one plays with here, in place of its own. Legato
    notes, which name none, stay legato. This is how the other pulse lane echoes a riff: the same pattern, a few
    rows later, on a quieter instrument.
  - `len`: the rows it plays, cutting its last repeat short: more than `length × (repeat − 1)` and less than
    `length × repeat`, or it's an error saying which `repeat` to use. Items that start at or after the cut are left
    out, and a note that runs past it is shortened to end there (losing its `cutTick`), as if written out that way.
    Left out, it plays every repeat whole.
  - A placement has no other fields: an item with `pattern` and a note or effect is an error.
  - It covers rows `row` to `row + len` (`row + length × repeat` without `len`). Nothing else in that lane may start
    in those rows, and no note before it may run into them: the placement owns them.
- **The boundaries are the flat timeline's.** A placement plays exactly as its notes would if they were written
  out at its rows, and nothing resets where it starts or ends. A note that ends where the next note starts, in a
  pattern or not, gets no cut; one that ends on an empty row gets a cut on that row, which needs the row's effect
  slot. A legato note at the start of a pattern carries on the note before it. A loop point inside a placement
  loops to that row, not to the placement's start.
- Lanes hold placements and loose notes and effects together, sorted by row. A song with no patterns is the same
  file as before; `version` stays 1.
- A pattern nothing places is kept. It may be on its way into the song.

Things left out until a song needs them: starting a placement partway into its pattern, patterns inside patterns,
and `global` items in patterns. Tempo, pan and master volume
stay song-wide.

### Groove

With a non-uniform groove, the swing a row gets depends on its row number (`row & 3` from the start of each
tracker pattern). A pattern placed 2 rows off a multiple of 4, or one whose length isn't a multiple of 4 and that
repeats, swings differently in different places. That's allowed: it's the same as pasting notes at that offset,
and the editor and `show` play and show it as it sounds. (`loop` has to be a multiple of 4 for a different reason:
the driver's jump resets the groove's phase, which the file couldn't otherwise describe.)

## The compiler

`expand(song)` in `src/core/patterns.ts` returns the flat song and, for each lane, where its placements are. It
checks:

- the pattern exists, and its kind matches the lane (`duty` on `pulse1`/`pulse2`);
- ids are unique;
- the placement doesn't run past the song's end, worked out before anything is written out, after the checks on
  `length`, `loop` and the order limit, so a huge `repeat` can't make it allocate;
- nothing else in the lane starts inside a placement, and no loose note runs into one;
- the pattern's own items start before `length` and notes end by it.

Everything else (overlaps inside a pattern, effect slots, instruments, pitch ranges, delays against the row's
ticks) is found by the existing checks on the flat song, where the timeline row decides the answer: a delay that
fits a row's ticks in one place may not in another. A pattern that no place plays whole with its own instruments
(nothing places it, or every placement cuts it short with `len` or swaps its instruments with `inst`) is checked
the same way on its own, as a song of its length with only that pattern at row 0, so a draft can't hide an
undefined instrument or two notes on a row.

`compile()` calls `expand()` first. Errors on a lane row inside a placement also say which pattern and which of its
rows: `3.1.1 (row 32), pulse1, bass-a row 0: overlaps the note at …`. Each place reports its own error, so the
editor marks every row; `gbscore check` prints an error that repeats at the same pattern row once, with how many
places it's in. Errors on a row just outside a placement, such as the cut after a pattern's last note, keep the
timeline position only; their message names the note.

`parseSong()` errors inside a pattern's items give the path (`patterns[2].items[5].len`), as schema errors without
a row do now.

## The command line

- `gbscore show` shows the notes as they play, so reading a bar shows what sounds there. A lane line that a
  placement covers starts with that placement, as `[bass-a +5 ×2 inst 4 len 40 from 3.1.1]`, and the notes
  follow.
- `gbscore show --patterns` lists each pattern's notes by its own bars and beats, and where it's placed.
- `fmt` sorts patterns by `id` and items by row. `import` writes flat songs, as now; `import --patterns` places
  the `.uge`'s own patterns (see Status).

## The editor

The editor needs to open, play and save songs with patterns from the start, and to edit them, for rule 3 ("the file
is the interface"). The roll keeps working in timeline rows throughout.

**Showing them.** In each lane, a placement is a tinted band over its rows with the pattern's name at the top, and
the pattern's notes inside it, drawn like other notes. Repeats are marked with a thin line. Ghost notes use the
expanded song, so they include patterns.

**Instruments.** Everything that counts or changes the notes using an instrument (the counts in the panel, and
removing an instrument only when no note uses it) counts the notes in patterns too, placed or not. This is step 1.

**Editing notes, in patterns or not.** Nothing has to be opened. The roll edits either the loose notes or one place
a pattern plays (an occurrence: a lane, a pattern, and the row that repeat starts at), and which one is the
**target** follows the pointer: pressing in the notes area below the strip, in a band or outside one, makes what's
under the pointer the target before the press does anything else. So clicking a note in a band selects it, dragging
moves it, and drawing in a band adds a note to the pattern; every other place it plays changes with it. The target
stays until a press somewhere else, or Escape with nothing selected, so keys, paste and the effect strip act on it
too. There's no mode to leave: no Done, no dimming. The band that's the target is outlined, and its label says how
many places the pattern plays in ("riff · 3 places"), so an edit's reach shows before it's made.

The target is never more than one occurrence, which keeps writing edits back exact:

- Loose notes as target: edits work as before. An edit that would put anything in a placement's rows, or run a note
  into one, is refused ("pattern bass-a plays there"). Edit functions get the lane without its placements, and the
  store checks the result against them.
- An occurrence as target: the roll edits the pattern's notes where that occurrence is, as they sound: a view of the
  song whose expanded lane holds the pattern's items moved by the occurrence's row and transposed, so drawing,
  moving, resizing, effects, copy and paste work unchanged. Each edit writes the items back to the pattern, moved
  back and transposed back. An edit that would put an item outside the occurrence's rows (into the next repeat, out
  of the band, or across its end) is refused, as is one that transposes a note out of C3–B8 in the pattern, and any
  edit where the placement's transpose already takes one of the pattern's notes out of C3–B8: that note can't be
  shown as it plays, so the view couldn't be turned back into the pattern.
- A box selection starting in a band selects in that occurrence; one starting outside selects loose notes. Select
  all selects the target's notes.
- In a place with `inst`, the view shows the pattern's own instruments while it's the target, and the band's label
  says which one plays (`inst 4`). Edits then write back exactly; the alternative, showing `inst` and guessing which
  instrument an edited note had, can't be undone reliably.
- A repeat cut short by `len` can't be edited ("this repeat of pattern p2 is cut short; edit it where it plays
  whole"), since what the cut hides would have to be guessed at. Its notes still show as they play.

Notes keep their identity across edits (the selection is kept by reference), so the view is memoised by the source
song object and the occurrence together, and each edit stores its result's view against the new source song, so
the selected notes are the ones the roll draws. A gesture works from the view of its base song, which the memo
returns unchanged throughout. Whole-song edits, such as to instruments, run on the source song and carry the view.
Views never reach the undo history, saving or the compiler. Changing the target clears the selection, and so does
any change that removes the target occurrence (undo, a reload, a deletion), which also drops the target.

Step 2 had patterns opened for editing and closed again; step 3 took that out and kept step 2's view and
write-back, which are tested. Editing every place at once from the written-out lane was considered and not taken:
an edited note's source can't be told from object identity alone once edit functions copy it, a selection across
places would need the places' versions reconciled, and the selection would have to be remapped onto a new
expansion. One place at a time avoids all of that.

**Arranging.** Above the expanded lane's notes is a strip as tall as a band's label, where placements are handled
like clips; inside a band, below the strip, is for notes. In the strip:

- click a band to select it; drag to move it (by beats), Alt-drag to place a copy; ← → move it a row (a bar with
  Shift), ↑ ↓ transpose it;
- drag a band's right edge to make it play longer or shorter: past the pattern's end it repeats, and an end
  between repeats sets `len`. It snaps to beats, and to the song's end;
- click an empty part of the strip to place the current pattern there, at the beat;
- right-click a band, or Delete, removes the placement, not the pattern; Ctrl-D places it again right after itself.

The bar above the roll shows the selected placement: the pattern's name (which renames it everywhere), how many
places it plays in, transpose, repeat, instrument ("pattern's own" or a duty, wave or noise instrument of its kind),
and **Make unique** (a copy of the pattern for this placement only), **Unpack** (turn it into loose notes) and
**Remove**.

**The current pattern** is the one the strip places: the last one selected, made, or picked from the toolbar's
Pattern menu, which lists the expanded lane kind's patterns. With none, clicking the strip does nothing and its hint
says to make or pick one.

**Making them.** With notes selected, **Make pattern** (Ctrl-G) takes the beats the selection spans, from the beat
its first note starts in to the beat its last note ends in, with everything in them in that lane, into a new pattern
of that length, and places it there. It's refused, before anything changes, if a note runs across either end or a
placement is in those rows. The new pattern becomes the current one, so clicking the strip elsewhere places it
again. A pattern made in the editor is named `p1`, `p2` and so on, and can be renamed in the bar.

Left for later: making a pattern also link the other places that play the same notes. Exact matches can overlap and
can be chance (a one-beat pattern matches identical notes all over the song, and the surprise comes only when a
later edit changes them all), so it would be its own explicit action, not part of Make pattern.

Undo covers all of it: each is one edit of the song.

## Steps

1. **Format, expansion, compiler, command line.** Schema, `expand()`, error mapping, `fmt`, `show`, the README's
   song format. The file can use patterns from here. The editor plays and shows songs with patterns, keeps them on
   save, and refuses edits inside placements, but can't edit patterns yet.
2. **Editing patterns in the editor.** Opening a pattern, arranging, making patterns, unpack and make unique.
3. **Patterns like clips:**
   1. a placement's `inst` and `len`: schema, `expand()`, `show`, the README, and the fields in the bar;
   2. editing notes in placements without opening them: the target follows the pointer, and Done and dimming go;
   3. the strip: selecting, moving, the right edge, placing the current pattern; and Make pattern by beats.

Each step is its own commits, with the checks AGENTS.md lists and a review.

## Status

All three steps are done, and so is `import --patterns`.

- Step 1: `expand()` in `src/core/patterns.ts`; the editor draws placements as bands and refuses edits in their
  rows (`src/app/placements.ts`). Factoring the imported test songs into 16-row patterns, with no other change,
  compiles to the same bytes (`test/patterns.test.ts`).
- Step 2: `src/app/arrange.ts` (arranging, pure), `openView` and `editView` in `src/app/placements.ts` (the view of
  an occurrence and writing edits back), `src/app/Patterns.tsx` (the menu and the bar).
- Step 3: `targetRow` in `src/app/store.ts` (the target follows the pointer), the strip in `src/app/roll/draw.ts`
  (`drawClips`) and `Roll.tsx` (`clipAt`), `resizePlacement` in `src/app/arrange.ts`. A drag is measured from where
  the canvas was when it began, since the bar above the roll appearing or vanishing on a press moves the canvas.
- `import --patterns`: `placeUgePatterns` in `src/core/import.ts` cuts each lane where its hUGE patterns start and
  end. A note sounding past a hUGE pattern's end stays loose, since a pattern's notes can't run past it, and the
  patterns either side stop short of it. A song imported with its patterns expands to the same lanes as one
  imported flat, and compiles to the same bytes, or the same errors (`test/patterns.test.ts`).

Why step 3 changed the design: on an imported song, patterns had to be opened to edit, and making and placing them
took menus and whole bars, where hUGETracker's are quick. The song it was tried on is a phrase on pulse1 played
twice, and on pulse2 the same phrase a few rows later on a quieter instrument, an echo. hUGE's 64-row patterns
don't line up with the phrase, so copying them gave more patterns and loose notes than the music has. `inst` and `len` let one pattern
serve both lanes, and the strip makes placing it a click.

Not done:

- Finding repeats when importing, instead of copying hUGE's patterns. An importer that guesses needs tuning against
  more songs.
- Letting a pattern's last note carry on into the next placement, which would remove the loose notes import
  leaves. That's a format change.
- A roll of its own for editing a pattern: the roll edits in timeline rows.

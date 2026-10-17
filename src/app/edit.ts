import { noteName, NOTE_COUNT } from '../core/notes.ts';
import type { LaneItem, LaneName, Song } from '../core/schema.ts';
import { noteIndex } from './song.ts';

// Edits to the notes in a lane, each a function from a song to a new song. Items an edit doesn't touch keep their
// identity, so the view can keep its selection by reference.
//
// A note carries the items without a note that fall inside it (its effects): moving, copying or deleting the note
// does the same to them, and when it gets shorter the effects past its new end go. That way no edit leaves an effect
// on a row where a note's end needs the slot for its cut. Notes that are placed, moved or pasted win (docs/editor/,
// "Note entry"): a note they start inside is shortened to end where they begin, and anything that starts inside them
// is removed.

export interface Edit {
  song: Song;
  selection: LaneItem[]; // notes, in the lane edited
  effects?: number[]; // or the rows of the effects selected apart from their notes
}

/** An edit, or why it can't be made. */
export type Result = Edit | string;

/** Notes and their effects, with rows counted from the clip's start. */
export interface Clip {
  items: LaneItem[];
  span: number; // rows from the first note's start to the last note's end
}

export const isNote = (i: LaneItem) => i.note !== undefined;
export const noteEnd = (n: LaneItem) => n.row + (n.len ?? 1);
const byRow = (a: LaneItem, b: LaneItem) => a.row - b.row;

function withLane(song: Song, lane: LaneName, items: LaneItem[]): Song {
  return { ...song, lanes: { ...song.lanes, [lane]: items } };
}

/** The notes, and the effects inside them, in row order. Notes in a lane don't overlap, so an effect belongs to
 * the last note before it if it starts before that note ends. */
function withEffects(items: LaneItem[], notes: Set<LaneItem>): LaneItem[] {
  const out: LaneItem[] = [];
  let owner: LaneItem | undefined;
  for (const item of items) {
    if (isNote(item)) {
      owner = item;
      if (notes.has(item)) out.push(item);
    } else if (owner && notes.has(owner) && item.row < noteEnd(owner)) out.push(item);
  }
  return out;
}

/** A note `len` rows long. Its own cut within its last row goes, since its last row has changed. */
export function shorten(n: LaneItem, len: number): LaneItem {
  if (len === (n.len ?? 1)) return n;
  const { cutTick: _, ...rest } = n;
  return { ...rest, len };
}

/** Puts items into a lane's items, the placed notes winning over what's there. */
export function place(items: LaneItem[], placed: LaneItem[]): LaneItem[] {
  const spans = placed.filter(isNote).sort(byRow);
  const kept: LaneItem[] = [];
  let i = 0; // the first span that doesn't end at or before the current row
  let owner: { end: number; keepBefore: number } | undefined; // the last note, and where its effects now stop
  for (const item of items) {
    while (i < spans.length && noteEnd(spans[i]!) <= item.row) i++;
    const span = spans[i];
    const inside = !!span && span.row <= item.row; // starts inside a placed note
    if (isNote(item)) {
      const cut = !inside && span && span.row < noteEnd(item) ? span.row - item.row : undefined;
      owner = { end: noteEnd(item), keepBefore: inside ? item.row : item.row + (cut ?? item.len ?? 1) };
      if (!inside) kept.push(cut === undefined ? item : shorten(item, cut));
    } else if (!inside && !(owner && item.row < owner.end && item.row >= owner.keepBefore)) kept.push(item);
  }
  return [...kept, ...placed].sort(byRow);
}

/** Adds a note. It becomes the selection. An effect on its row, other than a cut, becomes its fx, unless it has
 * one: otherwise drawing a note where an effect was just put would lose it. */
export function draw(song: Song, lane: LaneName, note: LaneItem): Edit {
  return drawAll(song, lane, [note]);
}

/** Adds notes that don't overlap, each as `draw` adds one. They become the selection. */
export function drawAll(song: Song, lane: LaneName, notes: LaneItem[]): Edit {
  const placed = notes.map((note) => {
    const there = song.lanes[lane].find((i) => i.row === note.row && !isNote(i));
    return !note.fx && there?.fx && there.fx.cut === undefined ? { ...note, fx: there.fx } : note;
  });
  return { song: withLane(song, lane, place(song.lanes[lane], placed)), selection: placed };
}

/** The notes a paint drag lays: one every `len` rows from `row`, a slot each, at the pitch the slot was last
 * painted. Slots run either way from the first; ones outside the song are left out, and the last is cut short at
 * its end. */
export function paintRun(song: Song, from: { row: number; len: number; inst: number }, pitches: Map<number, number>): LaneItem[] {
  const notes: LaneItem[] = [];
  for (const [slot, pitch] of [...pitches].sort((a, b) => a[0] - b[0])) {
    const row = from.row + slot * from.len;
    if (row < 0 || row >= song.length) continue;
    notes.push({ row, len: Math.min(from.len, song.length - row), note: noteName(pitch), inst: from.inst });
  }
  return notes;
}

/** Deletes notes and their effects. */
export function remove(song: Song, lane: LaneName, notes: LaneItem[]): Edit {
  const gone = new Set(withEffects(song.lanes[lane], new Set(notes)));
  return { song: withLane(song, lane, song.lanes[lane].filter((i) => !gone.has(i))), selection: [] };
}

/** How far notes can move and stay in the song and in the note range. */
export function moveLimits(song: Song, notes: LaneItem[]) {
  const pitches = notes.map((n) => noteIndex(n.note!));
  return {
    rows: [-Math.min(...notes.map((n) => n.row)), song.length - Math.max(...notes.map(noteEnd))] as const,
    semitones: [-Math.min(...pitches), NOTE_COUNT - 1 - Math.max(...pitches)] as const,
  };
}

/** Moves notes, with their effects, by rows and semitones. */
export function move(song: Song, lane: LaneName, notes: LaneItem[], rows: number, semitones: number): Result {
  if (!notes.length) return 'select some notes first';
  const limits = moveLimits(song, notes);
  if (semitones > limits.semitones[1]) return `${highest(notes)} is as high as it can go: notes end at B8`;
  if (semitones < limits.semitones[0]) return `${lowest(notes)} is as low as it can go: notes start at C3`;
  if (rows < limits.rows[0]) return 'the notes are at the start of the song';
  if (rows > limits.rows[1]) return `the notes are at the end of the song; it's ${song.length} rows long, and a right-click on the ruler makes it longer`;
  const moving = withEffects(song.lanes[lane], new Set(notes));
  const gone = new Set(moving);
  const moved = moving.map((i) =>
    isNote(i) ? { ...i, row: i.row + rows, note: noteName(noteIndex(i.note!) + semitones) } : { ...i, row: i.row + rows },
  );
  const items = place(song.lanes[lane].filter((i) => !gone.has(i)), moved);
  return { song: withLane(song, lane, items), selection: moved.filter(isNote) };
}

const highest = (notes: LaneItem[]) => noteName(Math.max(...notes.map((n) => noteIndex(n.note!))));
const lowest = (notes: LaneItem[]) => noteName(Math.min(...notes.map((n) => noteIndex(n.note!))));

/** Lengthens or shortens notes by rows: each stays at least a row long, inside the song, and short of the next
 * note resized with it. A note's own cut within its last row goes, since its last row has changed. */
export function resize(song: Song, lane: LaneName, notes: LaneItem[], rows: number): Edit {
  const moving = withEffects(song.lanes[lane], new Set(notes));
  const gone = new Set(moving);
  const placed: LaneItem[] = [];
  const starts = moving.filter(isNote).map((n) => n.row);
  let end = 0; // where the last note now ends
  let k = 0;
  for (const i of moving) {
    if (isNote(i)) {
      // Each stops at the next one, as the later of two notes wins.
      const room = (starts[++k] ?? song.length) - i.row;
      const n = shorten(i, Math.max(1, Math.min(room, (i.len ?? 1) + rows)));
      placed.push(n);
      end = noteEnd(n);
    } else if (i.row < end) placed.push(i);
  }
  const items = place(song.lanes[lane].filter((i) => !gone.has(i)), placed);
  return { song: withLane(song, lane, items), selection: placed.filter(isNote) };
}

export function copy(song: Song, lane: LaneName, notes: LaneItem[]): Clip | undefined {
  if (!notes.length) return undefined;
  const items = withEffects(song.lanes[lane], new Set(notes));
  const start = Math.min(...notes.map((n) => n.row));
  return {
    items: items.map((i) => ({ ...i, row: i.row - start })),
    span: Math.max(...notes.map(noteEnd)) - start,
  };
}

/** Puts a clip's notes in a lane, starting at a row. */
export function paste(song: Song, lane: LaneName, clip: Clip, at: number): Result {
  if (at + clip.span > song.length) {
    return `there isn't room: the notes need ${clip.span} rows, and the song ends ${song.length - at} rows after the start flag (a right-click on the ruler makes it longer)`;
  }
  const placed = clip.items.map((i) => ({ ...i, row: i.row + at }));
  return { song: withLane(song, lane, place(song.lanes[lane], placed)), selection: placed.filter(isNote) };
}

/** Pastes a copy of notes just after them, a whole number of beats on. */
export function duplicate(song: Song, lane: LaneName, notes: LaneItem[]): Result {
  const clip = copy(song, lane, notes);
  if (!clip) return 'select some notes first';
  const beat = song.grid.rowsPerBeat;
  const start = Math.min(...notes.map((n) => n.row));
  return paste(song, lane, clip, start + Math.ceil(clip.span / beat) * beat);
}

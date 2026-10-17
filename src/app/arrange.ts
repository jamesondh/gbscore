import { position } from '../core/location.ts';
import { NOTE_COUNT, noteName, parseNote } from '../core/notes.ts';
import { lenError, occurrenceItems, placementSpan } from '../core/patterns.ts';
import { LANE_KIND, type LaneItem, type LaneName, type Pattern, type PatternItem, type Song } from '../core/schema.ts';
import { isNote, noteEnd } from './edit.ts';

// Edits to where patterns are placed, and to patterns as a whole (docs/patterns/, "Arranging" and "Making them"),
// each a function from a song to a new song. A placed pattern has its rows to itself, so each one checks that.

/** An arrangement edit: the song, and the placement or notes to select after it. Or why it can't be made. */
export type Arranged = { song: Song; placement?: LaneItem; selection?: LaneItem[] } | string;

const byRow = (a: { row: number }, b: { row: number }) => a.row - b.row;
const ID = /^\S(?:.{0,30}\S)?$/;

export function patternOf(song: Song, id: string): Pattern | undefined {
  return song.patterns?.find((p) => p.id === id);
}

function withLane(song: Song, lane: LaneName, items: LaneItem[]): Song {
  return { ...song, lanes: { ...song.lanes, [lane]: [...items].sort(byRow) } };
}

/** The rows a placement covers. A placement of a pattern that's gone covers its first row. */
export function span(song: Song, item: LaneItem): { start: number; end: number } {
  const p = patternOf(song, item.pattern!);
  return { start: item.row, end: item.row + (p ? placementSpan(item, p) : 1) };
}

/** Why a placement can't be where it is in the lane, if it can't: past the song's end, over another placement, or
 * over notes and effects. `ignore` is left out of the lane, as when it's the placement's old place. */
export function checkPlacement(song: Song, lane: LaneName, placement: LaneItem, ignore?: LaneItem): string | undefined {
  const p = patternOf(song, placement.pattern!);
  if (!p) return `there's no pattern ${placement.pattern}`;
  if (p.kind !== LANE_KIND[lane]) return `pattern ${p.id} is for ${p.kind} instruments, not ${lane}`;
  const { start, end } = span(song, placement);
  if (start < 0) return 'that would be before the start of the song';
  if (end > song.length) return `that would run past the end of the song, at ${position(song.grid, song.length)}`;
  for (const item of song.lanes[lane]) {
    if (item === ignore || item === placement) continue;
    const at = position(song.grid, item.row);
    if (item.pattern !== undefined) {
      const other = span(song, item);
      if (other.start < end && other.end > start) return `pattern ${item.pattern} is at ${at}`;
    } else if (item.row >= start && item.row < end) {
      return `${item.note ?? 'an effect'} at ${at} is in the way`;
    } else if (isNote(item) && item.row < start && noteEnd(item) > start) {
      return `${item.note} at ${at} runs into it`;
    }
  }
  return undefined;
}

function put(song: Song, lane: LaneName, placement: LaneItem, old?: LaneItem): Arranged {
  const items = song.lanes[lane].filter((i) => i !== old);
  const next = withLane(song, lane, [...items, placement]);
  const why = checkPlacement(next, lane, placement);
  return why ?? { song: next, placement };
}

/** Moves a placement by rows, or places a copy there. */
export function movePlacement(song: Song, lane: LaneName, item: LaneItem, rows: number, copy: boolean): Arranged {
  return put(song, lane, { ...item, row: item.row + rows }, copy ? undefined : item);
}

/** Places a pattern again right after a placement. */
export function duplicatePlacement(song: Song, lane: LaneName, item: LaneItem): Arranged {
  return put(song, lane, { ...item, row: span(song, item).end });
}

/** Makes a placement play for a number of rows, as dragging its right edge does: past its pattern's end it repeats,
 * and an end between repeats cuts the last one short with len. */
export function resizePlacement(song: Song, lane: LaneName, item: LaneItem, rows: number): Arranged {
  const p = patternOf(song, item.pattern!);
  if (!p) return `there's no pattern ${item.pattern}`;
  if (rows < 1) return 'a placement plays for a row at least';
  const repeat = Math.ceil(rows / p.length);
  return setPlacement(song, lane, item, { repeat, len: rows % p.length ? rows : undefined });
}

export function removePlacement(song: Song, lane: LaneName, item: LaneItem): Arranged {
  return { song: withLane(song, lane, song.lanes[lane].filter((i) => i !== item)), placement: undefined };
}

export type PlacementChange = Partial<Pick<LaneItem, 'transpose' | 'repeat' | 'inst' | 'len'>>;

/** Changes a placement's transpose, repeat, instrument or len. 0 and 1 are left out, as the file leaves them out, and
 * so is an undefined inst or len. A new repeat without a len plays every repeat whole. */
export function setPlacement(song: Song, lane: LaneName, item: LaneItem, change: PlacementChange): Arranged {
  const next: LaneItem = { ...item, ...change };
  if ('repeat' in change && !('len' in change)) delete next.len;
  if (!next.transpose) delete next.transpose;
  if (next.repeat === 1) delete next.repeat;
  if (next.inst === undefined) delete next.inst;
  if (next.len === undefined) delete next.len;
  const p = patternOf(song, item.pattern!);
  const cut = p && lenError(next, p);
  if (cut) return cut;
  if (next.transpose !== undefined && (next.transpose < -71 || next.transpose > 71 || !Number.isInteger(next.transpose))) {
    return 'transpose runs from -71 to 71 semitones';
  }
  if (next.repeat !== undefined && (next.repeat < 1 || !Number.isInteger(next.repeat))) return 'repeat is a whole number from 1';
  return put(song, lane, next, item);
}

/** Whether a transpose keeps an item's note in C3–B8. Items without a note, or with a name that isn't one, are
 * left alone by it. */
export function transposable(item: PatternItem, transpose: number): boolean {
  const index = item.note === undefined ? undefined : parseNote(item.note);
  return typeof index !== 'number' || (index + transpose >= 0 && index + transpose < NOTE_COUNT);
}

/** A pattern's item as it plays at a row, transposed: what the roll edits when the pattern is open. A note that
 * would go out of range stays as it is; compiling says so. */
export function project(item: PatternItem, start: number, transpose: number): LaneItem {
  const index = item.note === undefined || !transpose ? undefined : parseNote(item.note);
  return typeof index === 'number' && transposable(item, transpose)
    ? { ...item, row: item.row + start, note: noteName(index + transpose) }
    : { ...item, row: item.row + start };
}

/** The pattern item a projected one stands for, or why it can't be one: its note transposed back is out of range. */
export function unproject(item: LaneItem, start: number, transpose: number): PatternItem | string {
  const out: PatternItem = { ...item, row: item.row - start };
  if (item.note === undefined || !transpose) return out;
  const index = parseNote(item.note);
  if (typeof index !== 'number') return out;
  const back = index - transpose;
  if (back < 0 || back >= NOTE_COUNT) {
    return `${item.note} would be ${back < 0 ? 'below C3' : 'above B8'} in the pattern, which this place transposes by ${transpose > 0 ? '+' : ''}${transpose}`;
  }
  return { ...out, note: noteName(back) };
}

/** Turns a placement into the notes and effects it plays. They become the selection. */
export function unpack(song: Song, lane: LaneName, item: LaneItem): Arranged {
  const p = patternOf(song, item.pattern!);
  if (!p) return `there's no pattern ${item.pattern}`;
  const items: LaneItem[] = [];
  const span = placementSpan(item, p);
  for (let r = 0; r * p.length < span; r++) {
    const o = { lane, placement: item, pattern: p, start: item.row + r * p.length, repeat: r, length: Math.min(p.length, span - r * p.length) };
    items.push(...occurrenceItems(o).map((i) => i.played));
  }
  const next = withLane(song, lane, [...song.lanes[lane].filter((i) => i !== item), ...items]);
  return { song: next, placement: undefined, selection: items.filter(isNote) };
}

/** An id no pattern has, from a base: the base itself, or with -2, -3 and so on after it. */
export function freeId(song: Song, base: string): string {
  const taken = new Set((song.patterns ?? []).map((p) => p.id));
  const stem = base.slice(0, 28).trimEnd() || 'p';
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
}

/** Copies a placement's pattern under a new id and points the placement at the copy, so it can change alone. */
export function makeUnique(song: Song, lane: LaneName, item: LaneItem): Arranged {
  const p = patternOf(song, item.pattern!);
  if (!p) return `there's no pattern ${item.pattern}`;
  const id = freeId(song, p.id);
  const placement = { ...item, pattern: id };
  const next = { ...song, patterns: [...song.patterns!, { ...p, id, items: p.items.map((i) => ({ ...i })) }] };
  return { song: withLane(next, lane, next.lanes[lane].map((i) => (i === item ? placement : i))), placement };
}

/** Renames a pattern and every placement of it. */
export function renamePattern(song: Song, from: string, to: string): Arranged {
  if (to === from) return { song };
  if (!ID.test(to)) return 'a pattern name is 1 to 32 characters, without spaces at either end';
  if (patternOf(song, to)) return `there's a pattern called ${to} already`;
  const lanes = Object.fromEntries(
    Object.entries(song.lanes).map(([lane, items]) => [lane, items.map((i) => (i.pattern === from ? { ...i, pattern: to } : i))]),
  ) as Song['lanes'];
  return { song: { ...song, lanes, patterns: song.patterns!.map((p) => (p.id === from ? { ...p, id: to } : p)) } };
}

/** Places a pattern at a row. */
export function placePattern(song: Song, lane: LaneName, id: string, row: number): Arranged {
  return put(song, lane, { row, pattern: id });
}

/** Makes a pattern of the beats the notes span, from the beat the first starts in to the beat the last ends in, with
 * everything in them in the lane, and places it there. It's refused if a note runs across either end, or a pattern
 * is placed in those rows. */
export function makePattern(song: Song, lane: LaneName, notes: LaneItem[]): Arranged {
  if (!notes.length) return 'select some notes first';
  const beat = song.grid.rowsPerBeat;
  const start = Math.floor(Math.min(...notes.map((n) => n.row)) / beat) * beat;
  const end = Math.min(song.length, Math.ceil(Math.max(...notes.map(noteEnd)) / beat) * beat);
  const items = song.lanes[lane];
  for (const i of items) {
    if (i.pattern !== undefined) {
      const s = span(song, i);
      if (s.start < end && s.end > start) return `pattern ${i.pattern} is placed in those beats`;
    } else if (isNote(i) && ((i.row < start && noteEnd(i) > start) || (i.row < end && noteEnd(i) > end))) {
      return `${i.note} at ${position(song.grid, i.row)} runs across the edge of those beats`;
    }
  }
  const inside = items.filter((i) => i.pattern === undefined && i.row >= start && i.row < end);
  const id = freeId(song, `p${(song.patterns?.length ?? 0) + 1}`);
  const pattern: Pattern = { id, kind: LANE_KIND[lane], length: end - start, items: inside.map((i) => ({ ...i, row: i.row - start })) };
  const placement: LaneItem = { row: start, pattern: id };
  const next = { ...song, patterns: [...(song.patterns ?? []), pattern] };
  return { song: withLane(next, lane, [...items.filter((i) => !inside.includes(i)), placement]), placement };
}

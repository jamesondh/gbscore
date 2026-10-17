import { MAX_ORDERS, PATTERN_ROWS } from './driver.ts';
import { position, type SongError } from './location.ts';
import { NOTE_COUNT, noteName, parseNote } from './notes.ts';
import { LANE_KIND, LANES, type LaneItem, type LaneName, type Pattern, type PatternItem, type Song } from './schema.ts';

// Patterns (docs/patterns/) live in the song file only. expand() writes each placement out as the pattern's notes
// at its rows, giving the flat timeline the compiler takes, so a song compiles to the same bytes either way.

/** One place a pattern plays: a placement, or one of its repeats. */
export interface Occurrence {
  lane: LaneName;
  placement: LaneItem; // the lane item that places it
  pattern: Pattern;
  start: number; // the timeline row it starts at
  repeat: number; // which repeat of the placement, from 0
  length: number; // rows of the pattern it plays: all of them, or fewer where the placement's len cuts it short
}

export interface Expansion {
  song: Song; // lanes hold notes and effects only, and there are no patterns
  occurrences: Occurrence[]; // by lane, then row
  errors: SongError[];
}

/** No song the driver can play is longer, so expand() writes out nothing past it. */
const MAX_ROWS = MAX_ORDERS * PATTERN_ROWS;

const NOTE_FIELDS = ['note', 'legato', 'fx', 'cutTick'] as const;

/** Where an occurrence ends, after its last row. */
export const occurrenceEnd = (o: Occurrence) => o.start + o.length;

/** The rows a placement covers, all its repeats together, cut short by its len. */
export const placementSpan = (item: LaneItem, pattern: Pattern) => item.len ?? pattern.length * (item.repeat ?? 1);

/** What a placement changes, for showing after its pattern's name: `+5 ×2 inst 4 len 40`. */
export function placementExtras(item: LaneItem): string[] {
  const { transpose, repeat, inst, len } = item;
  return [
    transpose ? `${transpose > 0 ? '+' : ''}${transpose}` : '',
    (repeat ?? 1) > 1 ? `×${repeat}` : '',
    inst !== undefined ? `inst ${inst}` : '',
    len !== undefined ? `len ${len}` : '',
  ].filter(Boolean);
}

/** Why a placement's len doesn't cut its last repeat short, if it doesn't. */
export function lenError(item: LaneItem, pattern: Pattern): string | undefined {
  if (item.len === undefined) return undefined;
  const repeat = item.repeat ?? 1;
  if (item.len > pattern.length * (repeat - 1) && item.len < pattern.length * repeat) return undefined;
  const fits = Math.ceil(item.len / pattern.length);
  if (item.len === pattern.length * fits) return `len ${item.len} plays pattern ${pattern.id} whole ${fits === 1 ? 'once' : `${fits} times`}; leave len out${fits === repeat ? '' : ` and use repeat ${fits}`}`;
  return `len ${item.len} cuts short repeat ${fits} of pattern ${pattern.id} (length ${pattern.length}); use repeat ${fits}, not ${repeat}`;
}

/** An occurrence's items as they play: at its rows, transposed, with its placement's instrument, and cut short where
 * it is. A note a transpose takes out of C3–B8 keeps its name, for the caller to report. */
export function occurrenceItems(o: Occurrence): { item: PatternItem; played: LaneItem }[] {
  const { transpose = 0, inst } = o.placement;
  const out: { item: PatternItem; played: LaneItem }[] = [];
  for (const item of fittingItems(o.pattern)) {
    if (item.row >= o.length) continue;
    const played: LaneItem = { ...item, row: o.start + item.row };
    const index = item.note === undefined || !transpose ? undefined : parseNote(item.note);
    if (typeof index === 'number' && index + transpose >= 0 && index + transpose < NOTE_COUNT) played.note = noteName(index + transpose);
    if (inst !== undefined && item.inst !== undefined) played.inst = inst;
    if (item.note !== undefined && item.row + (item.len ?? 1) > o.length) {
      played.len = o.length - item.row;
      delete played.cutTick;
    }
    out.push({ item, played });
  }
  return out;
}

/** A pattern's items that fit in it. The ones that don't are errors, and are left out of every place it plays. */
export function fittingItems(p: Pattern): PatternItem[] {
  return p.items.filter((i) => i.row < p.length && (i.note === undefined || i.len === undefined || i.row + i.len <= p.length));
}

/** The occurrence in a lane that holds a row, if any. */
export function occurrenceAt(occurrences: Occurrence[], lane: LaneName, row: number): Occurrence | undefined {
  return occurrences.find((o) => o.lane === lane && row >= o.start && row < occurrenceEnd(o));
}

const expansions = new WeakMap<Song, Expansion>();

/** The song with its patterns written out, worked out once per version of it. Placements that can't be written
 * out, and loose items in the rows a placement owns, are errors and are left out, so later checks don't repeat
 * them. */
export function expand(song: Song): Expansion {
  let e = expansions.get(song);
  if (!e) {
    e = expandUncached(song);
    expansions.set(song, e);
  }
  return e;
}

function expandUncached(song: Song): Expansion {
  const patterns = song.patterns ?? [];
  const plain = (i: LaneItem) => i.pattern === undefined && i.transpose === undefined && i.repeat === undefined;
  const placementOnly = (i: LaneItem) => i.transpose !== undefined || i.repeat !== undefined;
  if (!patterns.length && LANES.every((lane) => song.lanes[lane].every(plain))) {
    return { song, occurrences: [], errors: [] };
  }
  const errors: SongError[] = [];
  const at = (row: number) => position(song.grid, row);

  const byId = new Map<string, Pattern>();
  for (const [i, p] of patterns.entries()) {
    if (byId.has(p.id)) errors.push({ message: `pattern ${p.id} is defined twice`, path: `patterns[${i}]` });
    else byId.set(p.id, p);
    if (p.length > MAX_ROWS) {
      errors.push({ message: `${p.length} rows is longer than any song the driver can play (${MAX_ROWS})`, pattern: p.id });
    }
    for (const item of p.items) {
      const err = (message: string) => errors.push({ message, pattern: p.id, patternRow: item.row });
      if (item.row >= p.length) err(`past the pattern's end (length ${p.length})`);
      else if (item.note !== undefined && item.len !== undefined && item.row + item.len > p.length) {
        err(`the note runs past the pattern's end (length ${p.length}); shorten it to ${p.length - item.row} rows`);
      }
    }
  }

  const occurrences: Occurrence[] = [];
  const lanes = {} as Song['lanes'];
  for (const lane of LANES) {
    const out: LaneItem[] = [];
    const spans: { start: number; end: number; id: string }[] = [];
    // By row, as the file needn't be: a placement owns its rows whichever comes first in the list.
    for (const item of [...song.lanes[lane]].sort((a, b) => a.row - b.row)) {
      const err = (message: string) => errors.push({ message, lane, row: item.row });
      if (item.pattern === undefined) {
        if (placementOnly(item)) err('transpose and repeat are for placements; add a pattern or remove them');
        continue;
      }
      const extra = NOTE_FIELDS.filter((k) => item[k] !== undefined);
      if (extra.length) {
        err(`a placement has only row, pattern, transpose, repeat, inst and len; put ${extra.join(', ')} in the pattern or another item`);
        continue;
      }
      const p = byId.get(item.pattern);
      if (!p) {
        err(`there's no pattern ${item.pattern}`);
        continue;
      }
      if (p.kind !== LANE_KIND[lane]) {
        err(`pattern ${p.id} is for ${p.kind} instruments, and ${lane} plays ${LANE_KIND[lane]} instruments`);
        continue;
      }
      const cut = lenError(item, p);
      if (cut) {
        err(cut);
        continue;
      }
      const end = item.row + placementSpan(item, p);
      if (end > Math.min(song.length, MAX_ROWS)) {
        const times = (item.repeat ?? 1) > 1 ? `, played ${item.repeat} times,` : '';
        err(`pattern ${p.id}${times} runs past the song's end (length ${song.length}): it ends at row ${end}`);
        continue;
      }
      const before = spans[spans.length - 1];
      if (before && item.row < before.end) {
        err(`starts inside pattern ${before.id}, placed at ${at(before.start)}`);
        continue;
      }
      spans.push({ start: item.row, end, id: p.id });
      for (let r = 0; r < (item.repeat ?? 1); r++) {
        const start = item.row + r * p.length;
        occurrences.push({ lane, placement: item, pattern: p, start, repeat: r, length: Math.min(p.length, end - start) });
      }
    }

    for (const item of song.lanes[lane]) {
      if (item.pattern !== undefined || placementOnly(item)) continue;
      const inside = spans.find((s) => item.row >= s.start && item.row < s.end);
      if (inside) {
        errors.push({
          message: `inside pattern ${inside.id}, placed at ${at(inside.start)}: a placement has its rows to itself; put this in the pattern, or move it`,
          lane,
          row: item.row,
        });
        continue;
      }
      const end = item.row + (item.len ?? 1);
      const into = item.note === undefined ? undefined : spans.find((s) => s.start > item.row && s.start < end);
      if (into) {
        errors.push({
          message: `the note runs into pattern ${into.id}, placed at ${at(into.start)}; shorten it to ${into.start - item.row} rows`,
          lane,
          row: item.row,
        });
        continue;
      }
      out.push(item);
    }

    for (const o of occurrences) {
      if (o.lane !== lane) continue;
      const transpose = o.placement.transpose ?? 0;
      for (const { item, played } of occurrenceItems(o)) {
        const index = item.note === undefined || !transpose ? undefined : parseNote(item.note);
        if (typeof index === 'number' && (index + transpose < 0 || index + transpose >= NOTE_COUNT)) {
          errors.push({
            message: `${item.note} transposed by ${transpose > 0 ? '+' : ''}${transpose} is ${index + transpose < 0 ? 'below C3' : 'above B8'}, outside the driver's notes`,
            lane,
            row: played.row,
            pattern: o.pattern.id,
            patternRow: item.row,
          });
        }
        out.push(played);
      }
    }
    lanes[lane] = out.sort((a, b) => a.row - b.row);
  }
  const { patterns: _, ...flat } = song;
  return { song: { ...flat, lanes }, occurrences, errors };
}

/** Each pattern that no place plays whole with its own instruments, as a song of its own: the pattern at row 0 of
 * its kind's first lane, and the song's instruments, waves and groove. Checking these finds what placing them would,
 * short of what depends on where they're placed; `len` and `inst` could otherwise hide its errors. */
export function unplacedSongs(song: Song, occurrences: Occurrence[]): { pattern: Pattern; song: Song }[] {
  const placed = new Set(occurrences.filter((o) => o.length === o.pattern.length && o.placement.inst === undefined).map((o) => o.pattern));
  const first = { duty: 'pulse1', wave: 'wave', noise: 'noise' } as const;
  return (song.patterns ?? [])
    .filter((p) => !placed.has(p) && p.length <= MAX_ROWS)
    .map((p) => {
      const { patterns: _, ...rest } = song;
      const lanes = { pulse1: [], pulse2: [], wave: [], noise: [], [first[p.kind]]: fittingItems(p) };
      return { pattern: p, song: { ...rest, length: p.length, loop: 0, global: [], lanes } };
    });
}

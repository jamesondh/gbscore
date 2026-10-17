import { rowTicks } from '../core/compile.ts';
import { effectKey, encodeEffect } from '../core/effects.ts';
import { position } from '../core/location.ts';
import { type Effect, type GlobalItem, LANE_KIND, type LaneItem, type LaneName, type Song } from '../core/schema.ts';
import { type Edit, isNote, noteEnd, type Result } from './edit.ts';

// Edits to the effects on the timeline (docs/editor/, "Effects on the timeline"), each a function from a song to a
// new song. A lane has one effect slot per row, so effects are edited by row: on a row where a note starts the
// effect is the note's fx, and on any other row an item without a note.

/** What holds a lane's effect on a row: the note starting there, or else the item without a note there. `inside`
 * is the note the row is in, starting there or before. */
export function effectAt(song: Song, lane: LaneName, row: number): { fx?: Effect; note?: LaneItem; inside?: LaneItem } {
  let inside: LaneItem | undefined;
  let fx: Effect | undefined;
  let note: LaneItem | undefined;
  for (const item of song.lanes[lane]) {
    if (item.row > row) break;
    if (isNote(item)) {
      inside = noteEnd(item) > row ? item : undefined;
      if (item.row === row) [note, fx] = [item, item.fx];
    } else if (item.row === row && !note) fx = item.fx;
  }
  return { fx, note, inside };
}

/** The rows whose effect slot a note's end takes, and the note: its last row with a cutTick, or else the row it
 * ends on, unless the next note starts there or the song ends. */
export function endRows(song: Song, lane: LaneName): Map<number, LaneItem> {
  const notes = song.lanes[lane].filter(isNote);
  const ends = new Map<number, LaneItem>();
  for (const [i, n] of notes.entries()) {
    const end = Math.min(noteEnd(n), song.length);
    if (n.cutTick !== undefined) ends.set(end - 1, n);
    else if (end < song.length && notes[i + 1]?.row !== end) ends.set(end, n);
  }
  return ends;
}

/** Ticks on a row as the song first plays it: the fewest, if the loop plays it differently. */
export function ticksAt(song: Song, row: number): number {
  return Math.min(...(rowTicks(song, tempos(song))[row] ?? song.groove));
}

export function tempos(song: Song): Map<number, number> {
  return new Map(song.global.flatMap((g) => (g.tempo === undefined ? [] : [[g.row, g.tempo] as const])));
}

const replacing = (items: LaneItem[], old: LaneItem, next: LaneItem) => items.map((i) => (i === old ? next : i));

/** An effect on a lane's row, wherever it's kept. */
export interface RowEffect {
  row: number;
  fx: Effect;
}

/** Effects copied apart from their notes, with rows counted from the first. */
export interface EffectClip {
  effects: RowEffect[];
  span: number; // rows from the first effect to just after the last
}

/** The effects on rows of a lane, in row order. Rows without one are left out. */
export function effectsOn(song: Song, lane: LaneName, rows: Iterable<number>): RowEffect[] {
  const wanted = new Set(rows);
  const out = new Map<number, Effect>();
  for (const item of song.lanes[lane]) {
    if (!item.fx || !wanted.has(item.row)) continue;
    if (isNote(item) || !out.has(item.row)) out.set(item.row, item.fx); // a note's fx is the slot's
  }
  return [...out].sort((a, b) => a[0] - b[0]).map(([row, fx]) => ({ row, fx }));
}

/** Clears the effects on rows, then puts effects on rows, each in the note starting there, or else an item without
 * a note. All at once, so effects moved a row don't overwrite each other. Refused whole past the song, on a row a
 * note's end needs, for a cut inside a note, and for an effect the row's lane or ticks can't play. The selected
 * notes that change stay selected. */
function putEffects(song: Song, lane: LaneName, clear: Iterable<number>, put: RowEffect[], selection: LaneItem[]): Result {
  const putting = new Map(put.map((e) => [e.row, e.fx]));
  const ends = putting.size ? endRows(song, lane) : new Map<number, LaneItem>();
  const notes = song.lanes[lane].filter(isNote);
  for (const { row, fx } of put) {
    if (row < 0 || row >= song.length) return `row ${row} isn't in the song`;
    const ender = ends.get(row);
    if (ender) {
      const what = ender.cutTick === undefined ? 'its cut needs' : 'its cutTick needs';
      return `the note at ${position(song.grid, ender.row)} ends here and ${what} this row's effect slot; change its length`;
    }
    if (fx.cut !== undefined && notes.some((n) => n.row <= row && noteEnd(n) > row)) {
      return 'a cut inside a note would end it early; shorten the note instead';
    }
    // As the compiler checks them: the lane's kind, and a delay or cut within the row's ticks.
    const enc = encodeEffect(fx, LANE_KIND[lane]);
    if (typeof enc === 'string') return enc;
    if (enc.code === 0x7 || enc.code === 0xe) {
      const ticks = ticksAt(song, row);
      if (enc.param >= ticks) {
        return `${enc.code === 0x7 ? 'delay' : 'cut'} ${enc.param} doesn't fit at ${position(song.grid, row)}, which has ${ticks} tick${ticks === 1 ? '' : 's'}`;
      }
    }
  }
  const cleared = new Set([...clear, ...putting.keys()]);
  const changed = new Map<LaneItem, LaneItem>();
  const items: LaneItem[] = [];
  for (const item of song.lanes[lane]) {
    if (!cleared.has(item.row)) items.push(item);
    else if (isNote(item)) {
      const { fx: _, ...rest } = item;
      const fx = putting.get(item.row);
      const next = fx ? { ...rest, fx } : rest;
      changed.set(item, next);
      items.push(next);
      putting.delete(item.row);
    }
  }
  for (const [row, fx] of putting) items.push({ row, fx });
  items.sort((a, b) => a.row - b.row);
  return {
    song: { ...song, lanes: { ...song.lanes, [lane]: items } },
    selection: selection.map((i) => changed.get(i) ?? i),
  };
}

/** Sets or removes the effect on a lane's row. A changed note stays selected. */
export function setEffect(song: Song, lane: LaneName, row: number, fx: Effect | undefined, selection: LaneItem[]): Result {
  if (row < 0 || row >= song.length) return `row ${row} isn't in the song`;
  return putEffects(song, lane, [row], fx ? [{ row, fx }] : [], selection);
}

/** Deletes the effects on rows, leaving their notes. */
export function removeEffects(song: Song, lane: LaneName, rows: number[]): Result {
  const r = putEffects(song, lane, rows, [], []);
  return typeof r === 'string' ? r : { ...r, effects: [] };
}

/** Moves the effects on rows by a number of rows, apart from their notes. They replace the effects where they land,
 * and stay selected. */
export function moveEffects(song: Song, lane: LaneName, rows: number[], by: number): Result {
  const moving = effectsOn(song, lane, rows);
  if (!moving.length) return 'select some effects first';
  if (moving[0]!.row + by < 0) return 'the effects are at the start of the song';
  if (moving.at(-1)!.row + by >= song.length) return `the effects are at the end of the song; it's ${song.length} rows long`;
  const moved = moving.map((e) => ({ row: e.row + by, fx: e.fx }));
  const r = putEffects(song, lane, rows, moved, []);
  return typeof r === 'string' ? r : { ...r, effects: moved.map((e) => e.row) };
}

export function copyEffects(song: Song, lane: LaneName, rows: number[]): EffectClip | undefined {
  const effects = effectsOn(song, lane, rows);
  if (!effects.length) return undefined;
  const start = effects[0]!.row;
  return { effects: effects.map((e) => ({ row: e.row - start, fx: e.fx })), span: effects.at(-1)!.row - start + 1 };
}

/** Puts copied effects in a lane from a row, replacing the effects there. They become the selection. */
export function pasteEffects(song: Song, lane: LaneName, clip: EffectClip, at: number): Result {
  if (at + clip.span > song.length) {
    return `there isn't room: the effects need ${clip.span} rows, and the song ends ${song.length - at} rows after the start flag (a right-click on the ruler makes it longer)`;
  }
  const placed = clip.effects.map((e) => ({ row: e.row + at, fx: e.fx }));
  const r = putEffects(song, lane, [], placed, []);
  return typeof r === 'string' ? r : { ...r, effects: placed.map((e) => e.row) };
}

/** Sets the volume on rows, as a drag along the strip draws it, but only where a note starts or a volume already
 * is: other effects keep their slot, and so do rows a note's end needs. A volume on an empty row would retrigger
 * the note it's in. */
export function drawVolume(song: Song, lane: LaneName, volumes: Map<number, number>, selection: LaneItem[]): Edit {
  const ends = endRows(song, lane);
  const drawable = new Set<number>();
  const taken = new Set<number>(); // a row with another effect
  for (const item of song.lanes[lane]) {
    if (!volumes.has(item.row)) continue;
    if (item.fx && item.fx.volume === undefined) taken.add(item.row);
    else if (isNote(item) || item.fx) drawable.add(item.row);
  }
  const now = new Map(effectsOn(song, lane, drawable).map((e) => [e.row, e.fx.volume]));
  const put = [...volumes]
    .filter(([row, volume]) => drawable.has(row) && !taken.has(row) && !ends.has(row) && row < song.length && now.get(row) !== volume)
    .map(([row, volume]) => ({ row, fx: { volume } }));
  if (!put.length) return { song, selection }; // the same song, so a stroke that changes nothing isn't an edit
  const r = putEffects(song, lane, [], put, selection);
  return typeof r === 'string' ? { song, selection } : r; // nothing it puts can be refused
}

/** Sets or removes the tick of its last row a note ends at. A cutTick takes its last row's effect slot, so adding
 * one is refused where an effect is, and the tick must be within the row's ticks. */
export function setCutTick(song: Song, lane: LaneName, note: LaneItem, cutTick: number | undefined, selection: LaneItem[]): Result {
  if (!song.lanes[lane].includes(note)) return 'the note has changed meanwhile';
  if (cutTick !== undefined) {
    const last = Math.min(noteEnd(note), song.length) - 1;
    const { fx } = effectAt(song, lane, last);
    if (note.cutTick === undefined && fx) {
      return `${longEffect(fx)} is on the note's last row, at ${position(song.grid, last)}, and a cut there needs its effect slot; remove it first`;
    }
    const ticks = ticksAt(song, last);
    if (!Number.isInteger(cutTick) || cutTick < 0 || cutTick >= ticks) {
      return `cut tick ${cutTick} doesn't fit at ${position(song.grid, last)}, which has ${ticks} tick${ticks === 1 ? '' : 's'}`;
    }
  }
  const { cutTick: _, ...rest } = note;
  const changed: LaneItem = cutTick === undefined ? rest : { ...rest, cutTick };
  return {
    song: { ...song, lanes: { ...song.lanes, [lane]: replacing(song.lanes[lane], note, changed) } },
    selection: selection.map((i) => (i === note ? changed : i)),
  };
}

export type GlobalKind = 'tempo' | 'pan' | 'masterVolume';
export const GLOBAL_KINDS: GlobalKind[] = ['tempo', 'pan', 'masterVolume'];
export type GlobalRow = { [K in GlobalKind]?: NonNullable<GlobalItem[K]> };

export const globalKind = (g: GlobalItem) => GLOBAL_KINDS.find((k) => g[k] !== undefined)!;

/** The song-wide effects on a row, at most one of each kind. */
export function globalAt(song: Song, row: number): GlobalRow {
  const out: GlobalRow = {};
  for (const g of song.global) if (g.row === row) Object.assign(out, { [globalKind(g)]: g[globalKind(g)] });
  return out;
}

/** Replaces the song-wide effects on a row, each kind its own item. */
export function setGlobal(song: Song, row: number, change: GlobalRow): Song | string {
  if (row < 0 || row >= song.length) return `row ${row} isn't in the song`;
  const added = GLOBAL_KINDS.flatMap((k) => (change[k] === undefined ? [] : [{ row, [k]: change[k] } as GlobalItem]));
  const kept = song.global.filter((g) => g.row !== row);
  const at = kept.findIndex((g) => g.row > row);
  kept.splice(at < 0 ? kept.length : at, 0, ...added);
  return { ...song, global: kept };
}

/** Beats a minute at a number of ticks a row. */
export function bpm(ticks: number, rowsPerBeat: number, tickRate: number): number {
  return (tickRate * 60) / (ticks * rowsPerBeat);
}

// ---- labels

export const EFFECT_NAMES: Record<keyof Effect, string> = {
  arp: 'Arpeggio',
  slideUp: 'Slide up',
  slideDown: 'Slide down',
  glide: 'Glide',
  vibrato: 'Vibrato',
  duty: 'Duty',
  wave: 'Wave',
  volSlide: 'Volume slide',
  volume: 'Volume',
  cut: 'Cut',
  delay: 'Delay',
  raw: 'Hex',
};

const SHORT: Record<keyof Effect, string> = {
  arp: 'arp',
  slideUp: 'up',
  slideDown: 'down',
  glide: 'glide',
  vibrato: 'vib',
  duty: 'duty',
  wave: 'wave',
  volSlide: 'vsl',
  volume: 'vol',
  cut: 'cut',
  delay: 'dly',
  raw: 'hex',
};

/** An effect in two short parts, for a narrow cell: its name and its value. */
export function shortEffect(fx: Effect): [string, string] {
  const key = effectKey(fx);
  if (!key) return ['?', ''];
  const v = fx[key]!;
  return [SHORT[key], Array.isArray(v) ? v.join(',') : String(v)];
}

/** An effect in words, for a tooltip: "Vibrato: speed 4, depth 2". */
export function longEffect(fx: Effect): string {
  const key = effectKey(fx);
  if (!key) return 'an effect with no name';
  const v = fx[key]!;
  const parts: Partial<Record<keyof Effect, [string, string]>> = {
    arp: ['+', '+'],
    vibrato: ['speed ', 'depth '],
    volSlide: ['up ', 'down '],
  };
  const p = parts[key];
  const value = Array.isArray(v) ? (p ? `${p[0]}${v[0]}, ${p[1]}${v[1]}` : v.join(', ')) : String(v);
  return `${EFFECT_NAMES[key]} ${value}`;
}

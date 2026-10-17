import { encodeEffect, waveReadStart } from '../core/effects.ts';
import { position } from '../core/location.ts';
import {
  DUTY_NAMES,
  LANE_KIND,
  LANES,
  type DutyInstrument,
  type Effect,
  type InstrumentKind,
  type LaneItem,
  type LaneName,
  type NoiseInstrument,
  type Song,
  type TableRow,
  type WaveInstrument,
} from '../core/schema.ts';
import type { AnyInstrument } from '../core/instruments.ts';

// Edits to instruments and waves, each a function from a song to a new song, or why it can't be made. The notes in
// the lanes keep their identity, so the view keeps its selection.

export const MAX_INSTRUMENTS = 15; // ids 1–15, per kind
export const MAX_WAVES = 16; // ids 0–15

export const WAVE_PRESETS: Record<string, string> = {
  Sine: samples((i) => Math.round(7.5 + 7.5 * Math.sin((2 * Math.PI * (i + 0.5)) / 32))),
  Triangle: samples((i) => (i < 16 ? i : 31 - i)),
  Saw: samples((i) => i >> 1),
  Square: samples((i) => (i < 16 ? 15 : 0)),
};

function samples(f: (i: number) => number): string {
  return Array.from({ length: 32 }, (_, i) => f(i).toString(16).toUpperCase()).join('');
}

export function instrumentsOf(song: Song, kind: InstrumentKind): AnyInstrument[] {
  return song.instruments[kind];
}

function withInstruments(song: Song, kind: InstrumentKind, list: AnyInstrument[]): Song {
  return { ...song, instruments: { ...song.instruments, [kind]: [...list].sort((a, b) => a.id - b.id) } };
}

/** The lowest id from `first` up that isn't taken, if one is left below `first + count`. */
function freeId(taken: number[], first: number, count: number): number | undefined {
  for (let id = first; id < first + count; id++) if (!taken.includes(id)) return id;
  return undefined;
}

/** How many notes use each instrument of a kind, counting a pattern's notes once however often it's placed, and
 * whether it's placed or not. */
export function noteCounts(song: Song, kind: InstrumentKind): Map<number, number> {
  const counts = new Map<number, number>();
  const count = (items: { inst?: number }[]) => {
    for (const item of items) if (item.inst !== undefined) counts.set(item.inst, (counts.get(item.inst) ?? 0) + 1);
  };
  for (const lane of LANES) if (LANE_KIND[lane] === kind) count(song.lanes[lane]);
  for (const p of song.patterns ?? []) if (p.kind === kind) count(p.items);
  return counts;
}

/** Adds an instrument at full volume, with no sweep or length: duty instruments hold the note, noise ones fade
 * over about half a second, like a drum. A wave instrument plays the first wave, which is made if the song has
 * none. */
export function addInstrument(song: Song, kind: InstrumentKind): { song: Song; id: number } | string {
  const id = freeId(instrumentsOf(song, kind).map((i) => i.id), 1, MAX_INSTRUMENTS);
  if (id === undefined) return `the song has ${MAX_INSTRUMENTS} ${kind} instruments, as many as the driver allows`;
  let inst: AnyInstrument;
  if (kind === 'duty') {
    inst = {
      id,
      duty: '50%',
      volume: 15,
      envDir: 'down',
      envPace: 0,
      sweepTime: 0,
      sweepDir: 'down',
      sweepShift: 0,
      length: 0,
      lengthEnabled: false,
    } satisfies DutyInstrument;
  } else if (kind === 'noise') {
    inst = { id, volume: 15, envDir: 'down', envPace: 2, bits: 15, length: 0, lengthEnabled: false } satisfies NoiseInstrument;
  } else {
    if (!song.waves.length) song = { ...song, waves: [{ id: 0, data: WAVE_PRESETS.Triangle! }] };
    inst = { id, wave: song.waves[0]!.id, level: '100%', length: 0, lengthEnabled: false } satisfies WaveInstrument;
  }
  return { song: withInstruments(song, kind, [...instrumentsOf(song, kind), inst]), id };
}

/** Adds a copy of an instrument, table and all. */
export function duplicateInstrument(song: Song, kind: InstrumentKind, from: number): { song: Song; id: number } | string {
  const list = instrumentsOf(song, kind);
  const source = list.find((i) => i.id === from);
  if (!source) return `there's no ${kind} instrument ${from}`;
  const id = freeId(list.map((i) => i.id), 1, MAX_INSTRUMENTS);
  if (id === undefined) return `the song has ${MAX_INSTRUMENTS} ${kind} instruments, as many as the driver allows`;
  const copy = { ...structuredClone(source), id, ...(source.name && { name: `${source.name} copy` }) };
  return { song: withInstruments(song, kind, [...list, copy]), id };
}

/** Removes an instrument no note uses. */
export function removeInstrument(song: Song, kind: InstrumentKind, id: number): Song | string {
  const used = noteCounts(song, kind).get(id) ?? 0;
  if (used) {
    const notes = used === 1 ? '1 note uses it' : `${used} notes use it`;
    return `${notes}: select them and give them another instrument first`;
  }
  return withInstruments(song, kind, instrumentsOf(song, kind).filter((i) => i.id !== id));
}

/** Changes some of an instrument's fields. An empty name is removed. */
export function updateInstrument(song: Song, kind: InstrumentKind, id: number, change: Partial<AnyInstrument>): Song {
  const list = instrumentsOf(song, kind).map((i) => {
    if (i.id !== id) return i;
    const next = { ...i, ...change } as AnyInstrument;
    if (!next.name) delete next.name;
    return next;
  });
  return withInstruments(song, kind, list);
}

/** Gives notes in a lane an instrument. Legato notes have none, and keep it so. */
export function setNoteInstrument(
  song: Song,
  lane: LaneName,
  notes: LaneItem[],
  id: number,
): { song: Song; selection: LaneItem[] } {
  const chosen = new Set(notes);
  const selection: LaneItem[] = [];
  const items = song.lanes[lane].map((item) => {
    if (!chosen.has(item)) return item;
    const next = item.inst === undefined || item.inst === id ? item : { ...item, inst: id };
    selection.push(next);
    return next;
  });
  return { song: { ...song, lanes: { ...song.lanes, [lane]: items } }, selection };
}

/** Makes notes in a lane legato, so each changes pitch without a new attack and carries on the instrument before
 * it, or, when every one already is, makes them normal again with the instrument `instFor` gives each. Not on the
 * wave lane, where the driver stops the channel and a legato note is silent. */
export function toggleLegato(
  song: Song,
  lane: LaneName,
  notes: LaneItem[],
  instFor: (note: LaneItem) => number | undefined,
): { song: Song; selection: LaneItem[]; on: boolean; changed: number } | string {
  if (lane === 'wave') return "notes on the wave lane can't be legato: the driver stops the wave channel and doesn't restart it";
  const chosen = new Set(notes.filter((n) => n.note !== undefined));
  if (!chosen.size) return 'select the notes to make legato first';
  const on = [...chosen].some((n) => !n.legato);
  const selection: LaneItem[] = [];
  let changed = 0;
  const items: LaneItem[] = [];
  for (const item of song.lanes[lane]) {
    let next = item;
    if (chosen.has(item) && (on ? !item.legato : item.legato)) {
      const { inst: _, legato: __, ...rest } = item;
      const inst = on ? undefined : instFor(item);
      if (!on && inst === undefined) return `there's no ${LANE_KIND[lane]} instrument to give the notes; add one first`;
      next = on ? { ...rest, legato: true } : { ...rest, inst };
      changed++;
    }
    if (chosen.has(item)) selection.push(next);
    items.push(next);
  }
  return { song: { ...song, lanes: { ...song.lanes, [lane]: items } }, selection, on, changed };
}

/** Adds a wave, a copy of `data`. */
export function addWave(song: Song, data: string): { song: Song; id: number } | string {
  const id = freeId(song.waves.map((w) => w.id), 0, MAX_WAVES);
  if (id === undefined) return `the song has ${MAX_WAVES} waves, as many as the driver allows`;
  return { song: { ...song, waves: [...song.waves, { id, data }].sort((a, b) => a.id - b.id) }, id };
}

/** Replaces a wave's samples: 32 hex digits. */
export function setWave(song: Song, id: number, data: string): Song {
  return { ...song, waves: song.waves.map((w) => (w.id === id ? { ...w, data } : w)) };
}

/** Changes a wave's name. An empty name is removed. */
export function renameWave(song: Song, id: number, name: string | undefined): Song {
  return {
    ...song,
    waves: song.waves.map((w) => {
      if (w.id !== id) return w;
      const { name: _, ...rest } = w;
      return name ? { ...rest, name } : rest;
    }),
  };
}

/** What uses a wave: the wave instruments that play it, and wave effects (9xx) that switch to it in their tables,
 * on the wave lane and in wave patterns, placed or not. */
export function waveUsers(song: Song, id: number): string[] {
  const reads = (fx: Effect | undefined, inTable = false) => {
    const enc = fx && encodeEffect(fx, 'wave', inTable);
    if (!enc || typeof enc === 'string' || enc.code !== 0x9) return false;
    const start = waveReadStart(enc.param);
    return start >> 4 === id || (start + 15) >> 4 === id;
  };
  const users: string[] = [];
  for (const i of song.instruments.wave) {
    if (i.wave === id) users.push(`wave instrument ${i.id}`);
    else if (i.table?.some((r) => reads(r.fx, true))) users.push(`wave instrument ${i.id}'s table`);
  }
  const rows = song.lanes.wave.filter((item) => reads(item.fx)).map((item) => position(song.grid, item.row));
  if (rows.length === 1) users.push(`the wave effect at ${rows[0]}`);
  else if (rows.length) users.push(`${rows.length} wave effects on the wave lane, the first at ${rows[0]}`);
  for (const p of song.patterns ?? []) {
    if (p.kind === 'wave' && p.items.some((item) => reads(item.fx))) users.push(`a wave effect in pattern ${p.id}`);
  }
  return users;
}

/** Removes a wave nothing uses. The other waves keep their numbers. */
export function removeWave(song: Song, id: number): Song | string {
  const users = waveUsers(song, id);
  if (users.length) {
    const who = users.length === 1 ? users[0] : `${users.slice(0, -1).join(', ')} and ${users[users.length - 1]}`;
    return `wave ${id} is used by ${who}`;
  }
  return { ...song, waves: song.waves.filter((w) => w.id !== id) };
}

/** A wave's samples, 0–15 each. */
export function waveSamples(data: string): number[] {
  return Array.from(data, (c) => parseInt(c, 16));
}

export function waveData(samples: number[]): string {
  return samples.map((s) => s.toString(16).toUpperCase()).join('');
}

// ---- tables

export const TABLE_ROWS = 32;
export const MAX_JUMP = 30; // the driver stores a jump as row + 1 in five bits

/** A table as all its rows, the ones the file leaves out empty. */
export function tableRows(table: TableRow[] | undefined): TableRow[] {
  return Array.from({ length: TABLE_ROWS }, (_, i) => table?.[i] ?? {});
}

const isEmpty = (r: TableRow) => r.note === undefined && r.jump === undefined && r.fx === undefined;

/** A row without keys set to undefined, so the file and comparisons see only what's there. */
function cleanRow(r: TableRow): TableRow {
  const out: TableRow = {};
  if (r.note !== undefined) out.note = r.note;
  if (r.jump !== undefined) out.jump = r.jump;
  if (r.fx !== undefined) out.fx = r.fx;
  return out;
}

/** Rows up to the last one with anything in it, or none: an empty table plays the same as no table. */
export function trimTable(rows: TableRow[]): TableRow[] | undefined {
  const out = rows.map(cleanRow);
  while (out.length && isEmpty(out[out.length - 1]!)) out.pop();
  return out.length ? out : undefined;
}

/** Replaces an instrument's table, or removes it. */
export function setTable(song: Song, kind: InstrumentKind, id: number, rows: TableRow[] | undefined): Song {
  const table = rows && trimTable(rows);
  const list = instrumentsOf(song, kind).map((i) => {
    if (i.id !== id) return i;
    const { table: _, ...rest } = i;
    return (table ? { ...rest, table } : rest) as AnyInstrument;
  });
  return withInstruments(song, kind, list);
}

/** Changes one row of an instrument's table, making the table if there's none. */
export function setTableRow(song: Song, kind: InstrumentKind, id: number, index: number, row: TableRow): Song {
  const inst = instrumentsOf(song, kind).find((i) => i.id === id);
  if (!inst) return song;
  const rows = tableRows(inst.table);
  rows[index] = row;
  return setTable(song, kind, id, rows);
}

const held = (rows: TableRow[]) => rows.map((r, i) => (i === rows.length - 1 ? { ...r, jump: i } : r));
const looped = (rows: TableRow[]) => rows.map((r, i) => (i === rows.length - 1 ? { ...r, jump: 0 } : r));

/** Common tables. A held one ends on a row that jumps to itself; a looped one jumps back to row 0. */
export const TABLE_PRESETS: Record<string, TableRow[]> = {
  Major: looped([{ note: 0 }, { note: 4 }, { note: 7 }]),
  Minor: looped([{ note: 0 }, { note: 3 }, { note: 7 }]),
  Octave: looped([{ note: 0 }, { note: 12 }]),
  Pluck: held([{ note: 12 }, { note: 0 }]),
  Fall: held(Array.from({ length: 13 }, (_, i) => ({ note: -i }))),
  'Duty sweep': held(
    Array.from({ length: 10 }, (_, i) => (i % 3 ? {} : { fx: { duty: DUTY_NAMES[i / 3]! } })),
  ),
};

/** The presets an instrument kind can use: the duty sweep only on duty instruments. */
export function tablePresets(kind: InstrumentKind): [string, TableRow[]][] {
  return Object.entries(TABLE_PRESETS).filter(([, rows]) =>
    rows.every((r) => !r.fx || typeof encodeEffect(r.fx, kind, true) !== 'string'),
  );
}

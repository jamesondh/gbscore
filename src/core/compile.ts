import { encodeEffect, waveReadStart, type Fx } from './effects.ts';
import {
  EMPTY_ROW,
  MAX_ORDERS,
  PATTERN_ROWS,
  rowBytes,
  songSize,
  type DriverSong,
  type Instrument,
  type Row,
} from './driver.ts';
import { encodeInstrument, SILENT_INSTRUMENT, type AnyInstrument } from './instruments.ts';
import { position, type SongError } from './location.ts';
import { NO_NOTE, NOTE_COUNT, noteName, parseNote } from './notes.ts';
import { normalize } from './format.ts';
import { expand, occurrenceAt, unplacedSongs, type Occurrence } from './patterns.ts';
import {
  LANE_KIND,
  LANES,
  PAN_NAMES,
  songSchema,
  type GlobalItem,
  type InstrumentKind,
  type LaneName,
  type Song,
} from './schema.ts';

/** One Game Boy ROM bank. A song bigger than this can't be played from a single bank. */
export const BANK_SIZE = 0x4000;

export type ParseResult = { song: Song; errors?: undefined } | { song?: undefined; errors: SongError[] };

/** Validates a parsed JSON value against the schema. Rules that span fields are compile()'s job. */
export function parseSong(input: unknown): ParseResult {
  const r = songSchema.safeParse(input);
  if (r.success) return { song: r.data };
  return { errors: r.error.issues.map((issue) => schemaError(input, issue.path, issue.message)) };
}

function schemaError(input: unknown, path: PropertyKey[], message: string): SongError {
  const text = path.map((p, i) => (typeof p === 'number' ? `[${p}]` : i ? `.${String(p)}` : String(p))).join('');
  // Errors inside a lane or global item report that item's row, so they read like compile errors.
  const [top, laneOrIndex, index] = path;
  const get = (o: unknown, k: PropertyKey) => (o && typeof o === 'object' ? (o as never)[k] : undefined);
  let item: unknown;
  let lane: string | undefined;
  if (top === 'lanes' && typeof index === 'number') {
    item = get(get(get(input, 'lanes'), laneOrIndex!), index);
    lane = String(laneOrIndex);
  } else if (top === 'global' && typeof laneOrIndex === 'number') {
    item = get(get(input, 'global'), laneOrIndex);
    lane = 'global';
  }
  const row = get(item, 'row');
  if (typeof row === 'number' && Number.isInteger(row) && row >= 0) {
    const field = path.slice(lane === 'global' ? 2 : 3).join('.');
    return { message: field ? `${field}: ${message}` : message, lane, row };
  }
  return { message, path: text };
}

export interface Layout {
  /** The timeline row each order starts at. */
  orderStarts: number[];
}

export type CompileResult =
  | { ok: true; data: DriverSong; layout: Layout; size: number }
  | { ok: false; errors: SongError[] };

interface Slot {
  note: number;
  inst: number;
  fx?: Fx;
  by?: string; // what put the effect there, for conflict messages
}

interface PlacedNote {
  row: number;
  end: number;
  cutTick?: number;
}

const CHANNEL_ORDER_FOR_GLOBALS = [3, 2, 1, 0]; // noise first: it usually has the most free slots

/** What's wrong with a song's length and loop, if anything: the editor checks a change with this before making it. */
export function rangeErrors(song: Pick<Song, 'length' | 'loop' | 'groove'>): SongError[] {
  const errors: SongError[] = [];
  const { length: L, loop } = song;
  const uniform = song.groove.every((t) => t === song.groove[0]);
  if (loop >= L) errors.push({ message: `loop (${loop}) must be less than length (${L})`, path: 'loop' });
  if (!uniform && loop % 4 !== 0) {
    errors.push({
      message: `loop (${loop}) must be a multiple of 4 when the groove isn't uniform, so the groove keeps its phase`,
      path: 'loop',
    });
  }
  const orderCount = Math.ceil(loop / PATTERN_ROWS) + Math.ceil((L - loop) / PATTERN_ROWS);
  if (orderCount > MAX_ORDERS) {
    errors.push({
      message: `the song needs ${orderCount} orders of 64 rows, but the driver allows ${MAX_ORDERS}`,
      path: 'length',
    });
  }
  return errors;
}

export function compile(input: Song, options: { budget?: number } = {}): CompileResult {
  const source = normalize(input);
  const L = source.length;
  const loop = source.loop;
  const at = (row: number) => position(source.grid, row);

  // Checked before anything is sized by the length.
  const errors = rangeErrors(source);
  if (errors.length) return { ok: false, errors };

  // Patterns, written out. Only now: the checks above bound how much that can write.
  const expanded = expand(source);
  const song = expanded.song;
  errors.push(...expanded.errors);
  const checked = errors.length; // errors after this are on the written-out lanes, and may be in a pattern

  // Instruments and waves.
  const defined: Record<InstrumentKind, Map<number, Instrument>> = { duty: new Map(), wave: new Map(), noise: new Map() };
  for (const kind of ['duty', 'wave', 'noise'] as const) {
    for (const [i, inst] of (song.instruments[kind] as AnyInstrument[]).entries()) {
      const path = `instruments.${kind}[${i}]`;
      if (defined[kind].has(inst.id)) errors.push({ message: `${kind} instrument ${inst.id} is defined twice`, path });
      const enc = encodeInstrument(kind, inst);
      if (typeof enc === 'string') errors.push({ message: `${kind} instrument ${inst.id}: ${enc}`, path });
      else defined[kind].set(inst.id, enc);
    }
  }
  const waveData = new Map<number, number[]>();
  for (const [i, w] of song.waves.entries()) {
    if (waveData.has(w.id)) errors.push({ message: `wave ${w.id} is defined twice`, path: `waves[${i}]` });
    const samples = [...w.data].map((c) => parseInt(c, 16));
    waveData.set(w.id, Array.from({ length: 16 }, (_, j) => (samples[2 * j]! << 4) | samples[2 * j + 1]!));
  }

  // Song-wide effects, and the tick counts they give each row.
  const globals = new Map<number, { fx: Fx; by: string }[]>();
  const tempoAt = new Map<number, number>();
  for (const g of song.global) {
    const kinds = (['tempo', 'pan', 'masterVolume'] as const).filter((k) => g[k] !== undefined);
    const err = (message: string) => errors.push({ message, lane: 'global', row: g.row });
    if (kinds.length !== 1) {
      err(`a global item needs exactly one of tempo, pan or masterVolume`);
      continue;
    }
    if (g.row >= L) {
      err(`past the song's end (length ${L})`);
      continue;
    }
    const kind = kinds[0]!;
    const list = globals.get(g.row) ?? [];
    if (list.some((x) => x.by === kind)) {
      err(`two ${kind} changes on one row`);
      continue;
    }
    list.push({ fx: encodeGlobal(g), by: kind });
    globals.set(g.row, list);
    if (g.tempo !== undefined) tempoAt.set(g.row, g.tempo);
  }
  const ticks = rowTicks(song, tempoAt);
  const minTicks = (row: number) => Math.min(...ticks[row]!);

  // Lanes.
  const slots: Slot[][] = LANES.map(() => Array.from({ length: L }, () => ({ note: NO_NOTE, inst: 0 })));
  const usedInst: Record<InstrumentKind, Set<number>> = { duty: new Set(), wave: new Set(), noise: new Set() };
  const usedWaves = new Map<number, string>(); // wave id -> who uses it

  // 9xx on the wave channel copies 16 bytes of the waves (`waveReadStart`).
  const readWave = (param: number, who: string, err: (message: string) => void) => {
    if (param <= 15) {
      usedWaves.set(param, who);
      return;
    }
    const start = waveReadStart(param);
    if (start + 15 > 0xff) {
      err(`9${hex(param)} reads 16 bytes from byte ${start} of the waves, past the end of wave 15`);
      return;
    }
    for (let id = start >> 4; id <= (start + 15) >> 4; id++) usedWaves.set(id, who);
  };

  for (const [ch, lane] of LANES.entries()) {
    const kind = LANE_KIND[lane];
    const lane_slots = slots[ch]!;
    const notes: PlacedNote[] = [];
    const cuts: { row: number }[] = [];
    let prev: (typeof song.lanes)[LaneName][number] | undefined;
    const pitches: PitchEvent[] = [];
    for (const item of song.lanes[lane]) {
      const err = (message: string) => errors.push({ message, lane, row: item.row });
      if (item.row >= L) {
        err(`past the song's end (length ${L})`);
        continue;
      }
      if (item.row === prev?.row) {
        const notes = [item, prev].filter((i) => i.note !== undefined).length;
        err(
          notes === 2
            ? 'two notes on one row'
            : notes === 1
              ? "a note and an effect on one row; put the effect in the note's fx"
              : 'two effects on one row; a lane has one effect slot per row',
        );
        continue;
      }
      prev = item;
      const tickHint = (n: number) => `this row has ${n} tick${n === 1 ? '' : 's'}`;
      let fx: Fx | undefined;
      if (item.fx) {
        const enc = encodeEffect(item.fx, kind);
        if (typeof enc === 'string') {
          err(enc);
          continue;
        }
        fx = enc;
        if (fx.code === 0xe && item.note !== undefined) {
          err("a note can't have a cut fx; set len, and cutTick for a cut within the last row");
          continue;
        }
        if (fx.code === 0x7 && (fx.param === 0 || fx.param >= minTicks(item.row))) {
          err(`delay ${fx.param} never plays: it must be at least 1 and less than ${minTicks(item.row)} (${tickHint(minTicks(item.row))})`);
        }
        if (fx.code === 0xe && fx.param >= minTicks(item.row)) {
          err(`cut ${fx.param} never happens: ${tickHint(minTicks(item.row))}`);
        }
        if (fx.code === 0x0 && item.note === undefined) {
          pitches.push({ row: item.row, arp: Math.max(fx.param >> 4, fx.param & 15) });
        }
      }

      if (item.note === undefined) {
        const extra = (['len', 'inst', 'legato', 'cutTick'] as const).filter((k) => item[k] !== undefined);
        if (extra.length) err(`${extra.join(', ')} without a note; add a note or remove ${extra.join(', ')}`);
        else if (!fx) err('an item needs a note or an fx');
        else {
          lane_slots[item.row]!.fx = fx;
          lane_slots[item.row]!.by = 'an effect';
          if (fx.code === 0xe) cuts.push({ row: item.row });
          if (kind === 'wave' && fx.code === 0x9) readWave(fx.param, `the wave lane at ${at(item.row)}`, err);
        }
        continue;
      }

      const note = parseNote(item.note);
      if (typeof note === 'string') err(note);
      if (item.len === undefined) err('a note needs len, in rows');
      if ((item.inst === undefined) === (item.legato === undefined)) {
        err(item.inst === undefined ? 'a note needs inst, or legato: true' : 'a note has inst or legato, not both');
      }
      if (item.legato && lane === 'wave') {
        err("legato doesn't work on the wave lane: the driver stops the wave channel and doesn't restart it");
      }
      if (item.inst !== undefined) {
        if (!defined[kind].has(item.inst)) err(`${kind} instrument ${item.inst} isn't defined`);
        usedInst[kind].add(item.inst);
      }
      if (typeof note === 'string' || item.len === undefined) continue;
      const end = item.row + item.len;
      if (end > L) err(`the note runs past the song's end (length ${L}); shorten it to ${L - item.row} rows`);
      const before = notes[notes.length - 1];
      if (before && item.row < before.end) {
        err(`overlaps the note at ${at(before.row)}; shorten that one to ${item.row - before.row} rows`);
      }
      if (item.cutTick !== undefined && end <= L && item.cutTick >= minTicks(end - 1)) {
        err(`cutTick ${item.cutTick} never happens: ${tickHint(minTicks(end - 1))} on the note's last row`);
      }
      pitches.push({
        row: item.row,
        note,
        inst: item.inst,
        arp: fx?.code === 0x0 ? Math.max(fx.param >> 4, fx.param & 15) : undefined,
      });
      lane_slots[item.row]!.note = note;
      lane_slots[item.row]!.inst = item.inst ?? 0;
      if (fx) {
        lane_slots[item.row]!.fx = fx;
        lane_slots[item.row]!.by = "the note's fx";
        if (kind === 'wave' && fx.code === 0x9) readWave(fx.param, `the wave lane at ${at(item.row)}`, err);
      }
      notes.push({ row: item.row, end: Math.min(end, L), cutTick: item.cutTick });
    }

    // Standalone cuts can't fall inside a note, since the note would end there.
    for (const c of cuts) {
      const n = notes.find((n) => c.row > n.row && c.row < n.end);
      if (n) {
        errors.push({
          message: `a cut inside the note at ${at(n.row)}; set that note's len to ${c.row - n.row} instead`,
          lane,
          row: c.row,
        });
      }
    }

    for (const e of checkPitches(pitches, kind, loop, (id) => pitchRange(defined[kind].get(id)))) {
      errors.push({ ...e, lane });
    }

    // Note ends.
    for (const [i, n] of notes.entries()) {
      const next = notes[i + 1];
      const conflict = (row: number, what: string) => {
        const s = lane_slots[row]!;
        errors.push({
          lane,
          row,
          message:
            s.fx?.code === 0xe && s.by === 'an effect'
              ? `the note at ${at(n.row)} already ends here; remove this cut`
              : `${what} needs this row's effect slot, but ${s.by} is there; move the effect or change the note's len`,
        });
      };
      if (n.cutTick !== undefined) {
        const last = n.end - 1;
        if (lane_slots[last]!.fx) conflict(last, `the cutTick of the note at ${at(n.row)}`);
        else Object.assign(lane_slots[last]!, { fx: { code: 0xe, param: n.cutTick }, by: `the cutTick of the note at ${at(n.row)}` });
      } else if (n.end < L && next?.row !== n.end) {
        // Notes that overlap (an error already) can end on the same row; one cut ends them both.
        const s = lane_slots[n.end]!;
        if (s.by?.startsWith('the cut that ends') && s.fx?.code === 0xe && s.fx.param === 0) continue;
        if (s.fx) conflict(n.end, `the cut that ends the note at ${at(n.row)}`);
        else Object.assign(s, { fx: { code: 0xe, param: 0 }, by: `the cut that ends the note at ${at(n.row)}` });
      }
    }
  }

  // Waves the song plays.
  for (const id of usedInst.wave) {
    const inst = song.instruments.wave.find((w) => w.id === id);
    if (!inst) continue;
    usedWaves.set(inst.wave, `wave instrument ${id}`);
    const err = (message: string) => errors.push({ message: `wave instrument ${id}'s table: ${message}`, path: 'instruments.wave' });
    for (const r of defined.wave.get(id)?.table ?? []) {
      if (r.code === 0x9) readWave(r.param, `wave instrument ${id}'s table`, err);
    }
  }
  for (const [id, who] of usedWaves) {
    if (!waveData.has(id)) errors.push({ message: `wave ${id} isn't defined, but ${who} uses it`, path: 'waves' });
  }

  // Patterns: the timeline cut into 64-row orders from row 0 and again from the loop.
  const chunks: { start: number; len: number }[] = [];
  for (let s = 0; s < loop; s += PATTERN_ROWS) chunks.push({ start: s, len: Math.min(PATTERN_ROWS, loop - s) });
  const loopOrder = chunks.length;
  for (let s = loop; s < L; s += PATTERN_ROWS) chunks.push({ start: s, len: Math.min(PATTERN_ROWS, L - s) });

  const jumps = new Map<number, { fx: Fx; by: string }>();
  if (loopOrder > 0 && chunks[loopOrder - 1]!.len < PATTERN_ROWS) {
    jumps.set(loop - 1, { fx: { code: 0xd, param: 1 }, by: 'the break into the loop' });
  }
  const last = chunks[chunks.length - 1]!;
  if (loop > 0) jumps.set(L - 1, { fx: { code: 0xb, param: loopOrder + 1 }, by: 'the jump back to the loop' });
  else if (last.len < PATTERN_ROWS) jumps.set(L - 1, { fx: { code: 0xd, param: 1 }, by: 'the jump back to the start' });

  const demandRows = new Set([...globals.keys(), ...jumps.keys()]);
  for (const row of [...demandRows].sort((a, b) => a - b)) {
    const wants = [...(globals.get(row) ?? [])];
    const jump = jumps.get(row);
    if (jump) wants.push(jump);
    const free = CHANNEL_ORDER_FOR_GLOBALS.filter((ch) => !slots[ch]![row]!.fx);
    if (wants.length > free.length) {
      errors.push({
        message:
          `${wants.map((w) => w.by).join(' and ')} need${wants.length === 1 ? 's' : ''} ${wants.length} effect ` +
          `slot${wants.length === 1 ? '' : 's'} on this row, but ${free.length} of 4 lanes have one free; ` +
          `move a lane's effect off this row`,
        lane: 'global',
        row,
      });
      continue;
    }
    for (const [i, w] of wants.entries()) slots[free[i]!]![row]!.fx = w.fx;
  }

  // A pattern no place plays whole with its own instruments is checked on its own, so a draft, or a pattern every
  // placement cuts short or swaps the instruments of, can't hide an error. Errors the song has anyway, such as an
  // instrument defined twice or one a placement shows already, aren't repeated for it.
  const songWide = new Set(errors.filter((e) => e.row === undefined).map((e) => e.message));
  const key = (e: SongError) => `${e.pattern}\0${e.patternRow}\0${e.message}`;
  const shown = new Set(errors.map((e) => key(inPattern(e, expanded.occurrences))));
  for (const u of unplacedSongs(source, expanded.occurrences)) {
    const r = compile(u.song, options);
    if (r.ok) continue;
    for (const e of r.errors) {
      const own = { message: e.message, pattern: u.pattern.id, patternRow: e.row };
      if (e.row !== undefined && e.lane !== 'global') {
        if (!shown.has(key(own))) errors.push(own);
      }
      else if (e.row === undefined && !songWide.has(e.message)) errors.push({ message: e.message, pattern: u.pattern.id });
    }
  }

  if (errors.length) {
    return { ok: false, errors: errors.map((e, i) => (i < checked ? e : inPattern(e, expanded.occurrences))) };
  }

  const patterns: Row[][] = [];
  const patternIndex = new Map<string, number>();
  const orders: number[][] = [[], [], [], []];
  for (const c of chunks) {
    for (let ch = 0; ch < 4; ch++) {
      const pat: Row[] = [];
      for (let i = 0; i < PATTERN_ROWS; i++) {
        const s = i < c.len ? slots[ch]![c.start + i]! : undefined;
        pat.push(s ? { note: s.note, inst: s.inst, code: s.fx?.code ?? 0, param: s.fx?.param ?? 0 } : { ...EMPTY_ROW });
      }
      const key = pat.map((r) => rowBytes(r).join(',')).join(';');
      let index = patternIndex.get(key);
      if (index === undefined) {
        index = patterns.length;
        patterns.push(pat);
        patternIndex.set(key, index);
      }
      orders[ch]!.push(index);
    }
  }

  const emit = (kind: InstrumentKind) => {
    const highest = Math.max(0, ...usedInst[kind]);
    return Array.from({ length: highest }, (_, i) => defined[kind].get(i + 1) ?? SILENT_INSTRUMENT);
  };
  const highestWave = Math.max(-1, ...usedWaves.keys());
  const data: DriverSong = {
    groove: [...song.groove],
    orders,
    patterns,
    duty: emit('duty'),
    wave: emit('wave'),
    noise: emit('noise'),
    waves: Array.from({ length: highestWave + 1 }, (_, i) => waveData.get(i) ?? new Array(16).fill(0)),
  };

  const size = songSize(data);
  const budget = options.budget;
  if (budget !== undefined && size > budget) {
    return {
      ok: false,
      errors: [{ message: `the song compiles to ${size} bytes, over the ${budget}-byte budget`, path: 'length' }],
    };
  }
  return { ok: true, data, layout: { orderStarts: chunks.map((c) => c.start) }, size };
}

/** An error on a row a placement plays, also given as the pattern and its row there. */
function inPattern(e: SongError, occurrences: Occurrence[]): SongError {
  if (e.pattern !== undefined || e.row === undefined || !(LANES as readonly string[]).includes(e.lane ?? '')) return e;
  const o = occurrenceAt(occurrences, e.lane as LaneName, e.row);
  return o ? { ...e, pattern: o.pattern.id, patternRow: e.row - o.start } : e;
}

function encodeGlobal(g: GlobalItem): Fx {
  if (g.tempo !== undefined) return { code: 0xf, param: g.tempo };
  if (g.pan) {
    let nr51 = 0;
    g.pan.forEach((p, ch) => {
      const v = PAN_NAMES.indexOf(p);
      if (v & 1) nr51 |= 1 << ch;
      if (v & 2) nr51 |= 0x10 << ch;
    });
    return { code: 0x8, param: nr51 };
  }
  const [left, right] = g.masterVolume!;
  return { code: 0x5, param: (left << 4) | right };
}

/** The tick counts each row can play with. The groove cycles by the row's place in its 64-row pattern; tempo
 * changes make it uniform, and the state after the first pass carries into the loop, so a looped row can play
 * at a second speed. */
export function rowTicks(song: Song, tempoAt: Map<number, number>): number[][] {
  const result: number[][] = Array.from({ length: song.length }, () => []);
  let groove = [...song.groove];
  const pass = (from: number) => {
    for (let t = from; t < song.length; t++) {
      const tempo = tempoAt.get(t);
      if (tempo !== undefined) groove = [tempo, tempo, tempo, tempo];
      const patternRow = t < song.loop ? t % PATTERN_ROWS : (t - song.loop) % PATTERN_ROWS;
      const n = groove[patternRow & 3]!;
      if (!result[t]!.includes(n)) result[t]!.push(n);
    }
  };
  pass(0);
  pass(song.loop);
  return result;
}

interface PitchEvent {
  row: number;
  note?: number; // a note starts here
  inst?: number; // and loads this instrument (absent for legato)
  arp?: number; // the highest step of an arpeggio on this row
}

interface PitchRange {
  low: number;
  high: number;
  arp: number;
}

/** Checks that no note, with the table that's running and any arpeggio, reads outside the driver's note table.
 * The driver keeps the channel's last note and running table when the song loops, so the lane is checked from row
 * 0 with the driver's starting state (note 0, no table), then again from the loop with the state at the end. */
function checkPitches(
  events: PitchEvent[],
  kind: InstrumentKind,
  loop: number,
  range: (inst: number) => PitchRange | undefined,
): { row: number; message: string }[] {
  const found = new Map<string, { row: number; message: string }>();
  const report = (row: number, message: string) => found.set(`${row}:${message}`, { row, message });
  let base = 0;
  let baseRow = -1;
  let current: number | undefined;
  const pass = (from: number, again: boolean) => {
    for (const e of events) {
      if (e.row < from) continue;
      if (e.note !== undefined) {
        base = e.note;
        baseRow = e.row;
        if (e.inst !== undefined) current = e.inst;
        const r = current === undefined ? undefined : range(current);
        if (r) {
          const low = kind === 'noise' ? 0 : r.low; // noise tables compute pitch instead of looking it up
          const high = Math.max(kind === 'noise' ? 0 : r.high, r.arp);
          if (base + low < 0 || base + high >= NOTE_COUNT) {
            report(
              e.row,
              `${noteName(base)} with ${kind} instrument ${current}'s table reaches ` +
                `${base + low < 0 ? `${low}` : `+${high}`} semitones, outside C3–B8, the driver's note table`,
            );
          }
        }
      }
      if (e.arp !== undefined && base + e.arp >= NOTE_COUNT) {
        const held = again && baseRow > e.row ? ` (still playing when the song loops back here)` : '';
        report(e.row, `arp on ${noteName(base)}${held} goes above B8, the driver's highest note`);
      }
    }
  };
  pass(0, false);
  pass(loop, true);
  return [...found.values()];
}

/** How far an instrument's table moves the pitch, over the rows it can reach by following its jumps: note
 * offsets, and the highest arpeggio step. */
function pitchRange(inst: Instrument | undefined): PitchRange | undefined {
  if (!inst?.table) return undefined;
  let low = 0;
  let high = 0;
  let arp = 0;
  const seen = new Set<number>();
  for (let i = 0; !seen.has(i); ) {
    seen.add(i);
    const r = inst.table[i]!;
    if (r.note !== NO_NOTE) {
      low = Math.min(low, r.note - 36);
      high = Math.max(high, r.note - 36);
    }
    if (r.code === 0x0 && r.param !== 0) arp = Math.max(arp, r.param >> 4, r.param & 15);
    i = r.inst ? r.inst - 1 : i + 1; // do_table: a jump is 1-based; the last row always has one
  }
  return { low, high, arp };
}

function hex(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

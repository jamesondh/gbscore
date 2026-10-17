import { compile, parseSong } from './compile.ts';
import { decodeEffect } from './effects.ts';
import { normalize } from './format.ts';
import { PATTERN_ROWS, walk, type DriverSong, type PlayedRow, type Row } from './driver.ts';
import { decodeTable, type AnyInstrument } from './instruments.ts';
import { formatError, type SongError } from './location.ts';
import { NO_NOTE, NOTE_COUNT, noteName } from './notes.ts';
import {
  DUTY_NAMES,
  LANE_KIND,
  LANES,
  PAN_NAMES,
  WAVE_LEVELS,
  type DutyInstrument,
  type GlobalItem,
  type InstrumentKind,
  type NoiseInstrument,
  type WaveInstrument,
  type LaneItem,
  type LaneName,
  type Pattern,
  type Song,
  type SongInput,
} from './schema.ts';
import { readUge, type UgeInstrument, type UgeSong } from './uge.ts';

// `.uge` (V6/V7) to a song: follow the orders the way the driver plays them, then turn the played rows into notes
// with lengths. B and D aren't kept, since the compiler makes its own.

export class ImportError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(problems.join('\n'));
    this.problems = problems;
  }
}

/** The pattern data uge2source would emit for this song, before it removes duplicate patterns. */
export function ugeToDriver(uge: UgeSong): DriverSong | string {
  const lengths = uge.orderMatrix.map((o) => Math.max(0, o.length - 1)); // the last entry is an unplayed trailer
  if (lengths.some((n) => n !== lengths[0]) || lengths[0] === 0) {
    return `the four channels' order lists have different or zero lengths (${lengths.join(', ')})`;
  }
  const patterns: Row[][] = [];
  const index = new Map<number, number>();
  const orders = uge.orderMatrix.map((list) =>
    list.slice(0, -1).map((key) => {
      let i = index.get(key);
      if (i === undefined) {
        // A missing pattern plays as empty, as in uge2source (OptimizeSong's GetOrCreateNew).
        const cells = uge.patterns.get(key);
        i = patterns.length;
        patterns.push(
          Array.from({ length: PATTERN_ROWS }, (_, r) => {
            const c = cells?.[r];
            if (!c) return { note: NO_NOTE, inst: 0, code: 0, param: 0 };
            return {
              note: c.note >= 0 && c.note < NOTE_COUNT ? c.note : NO_NOTE,
              inst: c.instrument >= 0 && c.instrument <= 15 ? c.instrument : 0,
              code: c.effectCode & 0xf,
              param: c.effectParams & 0xff,
            };
          }),
        );
        index.set(key, i);
      }
      return i;
    }),
  );
  return { groove: uge.ticksPerRow, orders, patterns, duty: [], wave: [], noise: [], waves: [] };
}

export interface Imported {
  song: Song;
  /** Compiler errors: the song imported, but needs fixing before it plays (see gbscore check). */
  errors: SongError[];
}

export interface ImportOptions {
  /** Place each hUGE pattern as a pattern of the song (see placeUgePatterns), instead of writing every note out. */
  patterns?: boolean;
}

/** Throws ImportError for files the format can't represent. A song that imports but doesn't compile comes back
 * with its errors, so it can be fixed in the JSON. */
export function importUge(bytes: Uint8Array, options: ImportOptions = {}): Imported {
  const uge = readUge(bytes);
  const data = ugeToDriver(uge);
  if (typeof data === 'string') throw new ImportError([data]);
  const played = walk(data);
  if (typeof played === 'string') throw new ImportError([played]);

  const problems: string[] = [];
  const L = played.rows.length;
  const loop = played.loop;
  const cell = (ch: number, t: number) => {
    const p = played.rows[t]!;
    return data.patterns[data.orders[ch]![p.order]!]![p.row]!;
  };
  const where = (t: number) => `order ${played.rows[t]!.order} row ${played.rows[t]!.row}`;

  // The groove cycles by pattern row, and the compiler re-cuts the timeline into patterns from row 0 and from the
  // loop. Until a tempo change makes the groove uniform, every row must keep its place in the groove.
  const groove = uge.ticksPerRow;
  if (groove.some((t) => t !== groove[0])) {
    for (let t = 0; t < L; t++) {
      if ([0, 1, 2, 3].some((ch) => cell(ch, t).code === 0xf)) break;
      if ((played.rows[t]!.row & 3) !== (t & 3)) {
        problems.push(
          `${where(t)}: a pattern break shifts the groove (${groove.join(',')}) out of phase; ` +
            'gbscore songs keep the groove aligned to row 0',
        );
        break;
      }
    }
  }

  // Song-wide effects. The driver runs channels 1 to 4, so the last one on a row wins.
  const globals = new Map<string, GlobalItem>();
  const lanes: Record<string, LaneItem[]> = {};
  const highest: Record<InstrumentKind, number> = { duty: 0, wave: 0, noise: 0 };

  for (const [ch, lane] of LANES.entries()) {
    const kind = LANE_KIND[lane];
    const items: LaneItem[] = [];
    let open: LaneItem | undefined;
    for (let t = 0; t < L; t++) {
      const r = cell(ch, t);
      let { code, param } = r;
      if (code === 0x6) {
        problems.push(`${where(t)}, ${lane}: routines (6xx) aren't supported`);
        continue;
      }
      if (code === 0xb || code === 0xd) code = param = 0;
      if (code === 0xf || code === 0x5 || code === 0x8) {
        const g = decodeGlobal(t, code, param);
        if (typeof g === 'string') problems.push(`${where(t)}, ${lane}: ${g}`);
        else globals.set(`${t}:${Object.keys(g)[1]}`, g);
        code = param = 0;
      }
      if (r.note !== NO_NOTE) {
        if (open) open.len = t - open.row;
        const item: LaneItem = { row: t, len: 1, note: noteName(r.note) };
        if (r.inst) {
          item.inst = r.inst;
          highest[kind] = Math.max(highest[kind], r.inst);
        } else item.legato = true;
        items.push(item);
        if (code === 0xe) {
          item.cutTick = param; // a cut on the note's own row
          open = undefined;
        } else {
          const fx = decodeEffect(code, param, kind);
          if (fx) item.fx = fx;
          open = item;
        }
      } else if (code === 0xe && open) {
        // A cut ends the open note: at this row's start, or within this row.
        if (param === 0) open.len = t - open.row;
        else {
          open.len = t - open.row + 1;
          open.cutTick = param;
        }
        open = undefined;
      } else {
        const fx = decodeEffect(code, param, kind);
        if (fx) items.push({ row: t, fx });
      }
    }
    if (open) open.len = L - open.row;
    lanes[lane] = items;
  }
  if (problems.length) throw new ImportError(problems);

  const keep = (kind: InstrumentKind, bank: UgeInstrument[]) =>
    bank.slice(0, highest[kind]).flatMap((inst, i) => {
      const converted = convertInstrument(kind, i + 1, inst);
      if (typeof converted === 'string') {
        problems.push(converted);
        return [];
      }
      return [converted];
    });
  const input: SongInput = {
    version: 1,
    title: uge.name || undefined,
    artist: uge.artist || undefined,
    comment: uge.comment || undefined,
    grid: { rowsPerBeat: 4, beatsPerBar: 4 },
    groove: groove as [number, number, number, number],
    length: L,
    loop,
    instruments: {
      duty: keep('duty', uge.duty) as DutyInstrument[],
      wave: keep('wave', uge.wave) as WaveInstrument[],
      noise: keep('noise', uge.noise) as NoiseInstrument[],
    },
    waves: uge.waves.map((samples, id) => ({ id, data: samples.map((s) => (s & 15).toString(16)).join('').toUpperCase() })),
    lanes,
    global: [...globals.values()],
  };
  if (problems.length) throw new ImportError(problems);

  const parsed = parseSong(input);
  if (parsed.errors) throw new ImportError(parsed.errors.map((e) => formatError(undefined, e)));
  let song = parsed.song;
  let compiled = compile(song, { budget: Infinity });
  // Keep only the waves the song plays (the tracker always stores 16).
  if (compiled.ok) {
    const used = compiled.data.waves.length;
    song.waves = song.waves.filter((w) => w.id < used);
  }
  if (options.patterns) {
    song = placeUgePatterns(song, uge, played.rows);
    // The same errors, now saying which pattern they're in.
    if (!compiled.ok) compiled = compile(song, { budget: Infinity });
  }
  return { song: normalize(song), errors: compiled.ok ? [] : compiled.errors };
}

/** The song's lanes cut where its hUGE patterns start and end, so each stretch of a channel playing a hUGE pattern
 * becomes a placement of a pattern named after it (`p07`), and back-to-back plays of one become a repeat. The notes
 * don't change, only where they're written, so the song compiles to the same bytes.
 *
 * A note that sounds on past its hUGE pattern's end can't be in a pattern here, so it stays a loose note, and the
 * patterns on either side stop short of it. A pattern that holds only some of a hUGE pattern's rows, for that or
 * because a break or jump cut it short, is named for them (`p07 rows 4-63`). */
export function placeUgePatterns(song: Song, uge: UgeSong, played: PlayedRow[]): Song {
  // Runs of timeline rows playing one order, until the pattern's end, a break or a jump.
  const runs: { start: number; end: number; order: number; row: number }[] = [];
  for (let t = 0; t < played.length; ) {
    let e = t + 1;
    while (e < played.length && played[e]!.order === played[t]!.order && played[e]!.row === played[e - 1]!.row + 1) e++;
    runs.push({ start: t, end: e, order: played[t]!.order, row: played[t]!.row });
    t = e;
  }

  interface Found {
    pattern: Pattern;
    key: number; // the hUGE pattern
    from: number; // its first row held here
  }
  const found = new Map<string, Found>(); // by the rows of the hUGE pattern it holds, and its items
  const placements: { item: LaneItem; found: Found }[] = [];
  const lanes = {} as Record<LaneName, LaneItem[]>;
  for (const [ch, lane] of LANES.entries()) {
    const items = song.lanes[lane];
    const out: LaneItem[] = [];
    let last: { item: LaneItem; found: Found } | undefined;
    for (const run of runs) {
      let start = run.start;
      let end = run.end;
      for (const n of items) {
        if (n.note === undefined) continue;
        const ends = n.row + (n.len ?? 1);
        if (n.row < run.start && ends > run.start) start = Math.max(start, ends);
        if (n.row < run.end && ends > run.end) end = Math.min(end, n.row);
      }
      const inRun = items.filter((i) => i.row >= run.start && i.row < run.end);
      const inside = inRun.filter((i) => i.row >= start && i.row < end);
      out.push(...inRun.filter((i) => !inside.includes(i)));
      if (!inside.length) {
        last = undefined;
        continue;
      }
      const kind = LANE_KIND[lane];
      const pattern: Pattern = { id: '', kind, length: end - start, items: inside.map((i) => ({ ...i, row: i.row - start })) };
      // Two hUGE patterns with the same notes stay two, as in the tracker, where editing one leaves the other.
      const key = uge.orderMatrix[ch]![run.order]!;
      const from = run.row + start - run.start;
      const sig = JSON.stringify([key, from, pattern]);
      let f = found.get(sig);
      if (!f) found.set(sig, (f = { pattern, key, from }));
      if (last?.found === f && last.item.row + (last.item.repeat ?? 1) * f.pattern.length === start) {
        last.item.repeat = (last.item.repeat ?? 1) + 1;
      } else {
        last = { item: { row: start, pattern: '' }, found: f };
        placements.push(last);
        out.push(last.item);
      }
    }
    lanes[lane] = out;
  }

  // Named for the hUGE pattern, and the rows of it they hold if not all of them.
  const width = String(Math.max(0, ...[...found.values()].map((f) => f.key))).length;
  const taken = new Set<string>();
  for (const f of found.values()) {
    const base = `p${String(f.key).padStart(width, '0')}`;
    const name = f.pattern.length === PATTERN_ROWS ? base : `${base} rows ${f.from}-${f.from + f.pattern.length - 1}`;
    let id = name;
    for (let n = 2; taken.has(id); n++) id = `${name} (${n})`;
    taken.add(id);
    f.pattern.id = id;
  }
  for (const p of placements) p.item.pattern = p.found.pattern.id;
  return { ...song, patterns: [...found.values()].map((f) => f.pattern), lanes };
}

function decodeGlobal(row: number, code: number, param: number): GlobalItem | string {
  switch (code) {
    case 0xf:
      if (param === 0) return 'F00 (256 ticks per row) isn\'t supported';
      return { row, tempo: param };
    case 0x8:
      return {
        row,
        pan: [0, 1, 2, 3].map((ch) => PAN_NAMES[(((param >> (4 + ch)) & 1) << 1) | ((param >> ch) & 1)]!) as never,
      };
    default:
      if (param & 0x88) return `5${param.toString(16).toUpperCase()} sets the cartridge audio (VIN) bits, which gbscore doesn't support`;
      return { row, masterVolume: [param >> 4, param & 7] };
  }
}

function convertInstrument(kind: InstrumentKind, id: number, u: UgeInstrument): AnyInstrument | string {
  const where = `${kind} instrument ${id}`;
  let table: AnyInstrument['table'];
  if (u.subpatternEnabled) {
    const rows: Row[] = u.subpattern.slice(0, 32).map((c) => ({
      note: c.note,
      inst: c.volume,
      code: c.effectCode & 0xf,
      param: c.effectParams & 0xff,
    }));
    const t = decodeTable(kind, rows);
    if (typeof t === 'string') return `${where}: ${t}`;
    table = t;
  }
  const name = u.name || undefined;
  const env = {
    envDir: u.volSweepDirection === 0 ? ('up' as const) : ('down' as const),
    envPace: u.volSweepAmount,
  };
  switch (kind) {
    case 'duty':
      return {
        id,
        name,
        duty: DUTY_NAMES[u.duty & 3]!,
        volume: u.initialVolume,
        ...env,
        sweepTime: u.sweepTime,
        sweepDir: u.sweepIncDec === 1 ? 'down' : 'up',
        sweepShift: u.sweepShift,
        length: u.length,
        lengthEnabled: u.lengthEnabled,
        table,
      };
    case 'wave':
      return {
        id,
        name,
        wave: u.waveform,
        level: WAVE_LEVELS[u.outputLevel & 3]!,
        length: u.length,
        lengthEnabled: u.lengthEnabled,
        table,
      };
    case 'noise':
      return {
        id,
        name,
        volume: u.initialVolume,
        ...env,
        bits: u.counterStep === 1 ? 7 : 15,
        length: u.length,
        lengthEnabled: u.lengthEnabled,
        table,
      };
  }
}

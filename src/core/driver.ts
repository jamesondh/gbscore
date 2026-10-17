import { NO_NOTE } from './notes.ts';

// The data hUGEDriver plays, in the shape of the pinned driver's `hUGESong_t` (a3c69884): what the compiler
// produces, what import reads `.uge` files into, and what the tests decode uge2source's C into.

export const PATTERN_ROWS = 64;
export const TABLE_ROWS = 32;
export const MAX_ORDERS = 127; // order_cnt is a byte holding orders × 2

export interface Row {
  note: number; // 0–71, or NO_NOTE. In tables: the offset + 36.
  inst: number; // 0 = none. In tables: the jump, 1-based (0 = none).
  code: number;
  param: number;
}

export const EMPTY_ROW: Row = { note: NO_NOTE, inst: 0, code: 0, param: 0 };

export interface Instrument {
  /** The struct's bytes except the table pointer: duty [sweep, len_duty, envelope, highmask],
   * wave [length, volume, waveform, highmask], noise [envelope, highmask, 0, 0]. */
  fields: number[];
  table: Row[] | null; // TABLE_ROWS rows
}

export interface DriverSong {
  groove: number[]; // tempo1..tempo4
  orders: number[][]; // [channel][order] = index into patterns
  patterns: Row[][]; // PATTERN_ROWS rows each
  duty: Instrument[]; // index 0 is instrument 1
  wave: Instrument[];
  noise: Instrument[];
  waves: number[][]; // 16 bytes each
}

/** The three bytes of a row, as hUGEDriver.h's DN() macro packs them. */
export function rowBytes(r: Row): [number, number, number] {
  const c = (r.code << 8) | r.param;
  return [(r.note | ((r.inst & 0x10) << 3)) & 0xff, ((r.inst << 4) & 0xff) | (c >> 8), c & 0xff];
}

/** Size in bytes, laid out the way uge2source lays it out: header, orders, patterns, instruments, tables, waves. */
export function songSize(s: DriverSong): number {
  const header = 4 + 1 + 4 * 2 + 3 * 2 + 2 + 2;
  const orders = s.orders.reduce((n, o) => n + o.length * 2, 0);
  const instruments = [...s.duty, ...s.wave, ...s.noise];
  const tables = instruments.filter((i) => i.table).length * TABLE_ROWS * 3;
  return header + orders + s.patterns.length * PATTERN_ROWS * 3 + instruments.length * 6 + tables + s.waves.length * 16;
}

/** The song as the bytes the driver reads, placed at address `base`: the `hUGESong_t` header, then the parts in
 * the order `songSize` counts them. Pointers are little-endian. Empty instrument banks and missing tables are
 * NULL, as uge2source writes them; the routines pointer is always NULL. */
export function assemble(s: DriverSong, base: number): Uint8Array {
  const out = new Uint8Array(songSize(s));
  let at = 23;
  const take = (n: number) => {
    const start = at;
    at += n;
    return start;
  };
  const word = (offset: number, value: number) => {
    out[offset] = value & 0xff;
    out[offset + 1] = value >> 8;
  };

  out.set(s.groove, 0);
  out[4] = s.orders[0]!.length * 2;
  const orderAt = s.orders.map((o) => take(o.length * 2));
  const patternAt = s.patterns.map(() => take(PATTERN_ROWS * 3));
  const banks = [s.duty, s.wave, s.noise];
  const bankAt = banks.map((b) => take(b.length * 6));
  const tableAt = banks.map((b) => b.map((i) => (i.table ? take(TABLE_ROWS * 3) : -1)));
  const wavesAt = take(s.waves.length * 16);

  s.orders.forEach((o, ch) => {
    word(5 + ch * 2, base + orderAt[ch]!);
    o.forEach((p, i) => word(orderAt[ch]! + i * 2, base + patternAt[p]!));
  });
  s.patterns.forEach((p, i) => p.forEach((r, j) => out.set(rowBytes(r), patternAt[i]! + j * 3)));
  banks.forEach((bank, k) => {
    word(13 + k * 2, bank.length ? base + bankAt[k]! : 0);
    bank.forEach((inst, i) => {
      const t = tableAt[k]![i]!;
      if (inst.table) inst.table.forEach((r, j) => out.set(rowBytes(r), t + j * 3));
      const f = inst.fields;
      const ptr = t < 0 ? 0 : base + t;
      // duty {sweep, len_duty, envelope, table, highmask}, wave {length, volume, waveform, table, highmask},
      // noise {envelope, table, highmask, 0, 0}
      const bytes = k === 2 ? [f[0]!, ptr & 0xff, ptr >> 8, f[1]!, f[2]!, f[3]!] : [f[0]!, f[1]!, f[2]!, ptr & 0xff, ptr >> 8, f[3]!];
      out.set(bytes, bankAt[k]! + i * 6);
    });
  });
  word(21, s.waves.length ? base + wavesAt : 0);
  s.waves.forEach((w, i) => out.set(w, wavesAt + i * 16));
  return out;
}

export interface PlayedRow {
  order: number;
  row: number;
}

export interface Walk {
  rows: PlayedRow[];
  loop: number; // index in `rows` that playback returns to after the last row
}

/** Follows the orders the way the driver's `tick_time` does, applying Bxx and Dxx, until a position repeats.
 * Returns an error message for jumps the driver would follow into garbage. */
export function walk(s: DriverSong): Walk | string {
  const orderCount = s.orders[0]!.length;
  const seen = new Map<number, number>();
  const rows: PlayedRow[] = [];
  let order = 0;
  let row = 0;
  for (;;) {
    const key = order * PATTERN_ROWS + row;
    const again = seen.get(key);
    if (again !== undefined) return { rows, loop: again };
    seen.set(key, rows.length);
    rows.push({ order, row });

    // fx_pos_jump and fx_pattern_break, channel 1 to 4. Both are 1-based so that 0 means "not set".
    let rowBreak = 0;
    let nextOrder = 0;
    for (let ch = 0; ch < 4; ch++) {
      const r = s.patterns[s.orders[ch]![order]!]![row]!;
      if (r.code === 0xb) {
        if (rowBreak === 0) rowBreak = 1;
        nextOrder = r.param;
      } else if (r.code === 0xd) {
        rowBreak = r.param;
      }
    }
    const where = `order ${order} row ${row}`;
    if (nextOrder !== 0 && rowBreak === 0) {
      return `${where}: a D00 cancels a B jump, which leaves the driver's jump pending`;
    }
    if (rowBreak !== 0) {
      if (rowBreak - 1 >= PATTERN_ROWS) return `${where}: D${hex(rowBreak)} breaks to row ${rowBreak - 1}, past row 63`;
      if (nextOrder - 1 >= orderCount) return `${where}: B${hex(nextOrder)} jumps to order ${nextOrder - 1}, which doesn't exist`;
      row = rowBreak - 1;
      order = nextOrder !== 0 ? nextOrder - 1 : (order + 1) % orderCount;
    } else if (++row === PATTERN_ROWS) {
      row = 0;
      order = (order + 1) % orderCount;
    }
  }
}

function hex(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

export function emptyPattern(): Row[] {
  return Array.from({ length: PATTERN_ROWS }, () => ({ ...EMPTY_ROW }));
}

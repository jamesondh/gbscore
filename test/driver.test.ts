import { describe, expect, it } from 'vitest';
import { emptyPattern, walk, type DriverSong } from '../src/core/driver.ts';

// walk() follows B and D the way the driver's tick_time does. Import and the reference tests both rely on it, so
// these cases check it against the driver's code directly (fx_pos_jump, fx_pattern_break, tick_time).

describe('driver jumps', () => {
  // Two orders: each channel has its own pattern in order 0, with `fx` on its rows, and an empty one in order 1.
  function song(fx: { ch: number; row: number; code: number; param: number }[]): DriverSong {
    const patterns = [emptyPattern(), emptyPattern(), emptyPattern(), emptyPattern(), emptyPattern()];
    for (const f of fx) Object.assign(patterns[f.ch]![f.row]!, { code: f.code, param: f.param });
    const orders = [0, 1, 2, 3].map((ch) => [ch, 4]);
    return { groove: [6, 6, 6, 6], orders, patterns, duty: [], wave: [], noise: [], waves: [] };
  }

  it('takes the order from B and the row from an earlier D, as fx_pos_jump does', () => {
    const w = walk(song([{ ch: 0, row: 5, code: 0xd, param: 0x11 }, { ch: 1, row: 5, code: 0xb, param: 0x02 }]));
    if (typeof w === 'string') throw new Error(w);
    expect(w.rows[6]).toEqual({ order: 1, row: 16 });
  });

  it('takes the row from a D after a B, and still the order from the B', () => {
    const w = walk(song([{ ch: 0, row: 5, code: 0xb, param: 0x02 }, { ch: 2, row: 5, code: 0xd, param: 0x09 }]));
    if (typeof w === 'string') throw new Error(w);
    expect(w.rows[6]).toEqual({ order: 1, row: 8 });
  });

  it('wraps from the last order to order 0', () => {
    const w = walk(song([]));
    if (typeof w === 'string') throw new Error(w);
    expect(w.rows.length).toBe(128);
    expect(w.loop).toBe(0);
  });

  it('rejects jumps into garbage', () => {
    expect(walk(song([{ ch: 0, row: 1, code: 0xd, param: 0x41 }]))).toContain('past row 63');
    expect(walk(song([{ ch: 0, row: 1, code: 0xb, param: 0x03 }]))).toContain("order 2, which doesn't exist");
    expect(walk(song([{ ch: 0, row: 1, code: 0xb, param: 0x01 }, { ch: 1, row: 1, code: 0xd, param: 0 }]))).toContain(
      'D00 cancels a B jump',
    );
  });

  it('treats B00 as "next order"', () => {
    const w = walk(song([{ ch: 0, row: 5, code: 0xb, param: 0 }]));
    if (typeof w === 'string') throw new Error(w);
    expect(w.rows[6]).toEqual({ order: 1, row: 0 });
    expect(w.rows.length).toBe(6 + 64);
  });
});

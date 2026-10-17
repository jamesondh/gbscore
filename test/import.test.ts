import { describe, expect, it } from 'vitest';
import { compile } from '../src/core/compile.ts';
import { importUge } from '../src/core/import.ts';
import type { UgeCell, UgeSong } from '../src/core/uge.ts';
import { emptyCell, emptyInstrument, writeUge } from './uge-writer.ts';

/** hUGETracker's empty instruments, with `orders` empty orders per channel at a uniform speed of 6. */
function blank(orders = 2): UgeSong {
  const bank = (type: number) => Array.from({ length: 15 }, (_, i) => emptyInstrument(type, i));
  const s: UgeSong = {
    version: 7,
    name: '',
    artist: '',
    comment: '',
    duty: bank(0),
    wave: bank(1),
    noise: bank(2),
    waves: Array.from({ length: 16 }, () => new Array(32).fill(0)),
    ticksPerRow: [6, 6, 6, 6],
    patterns: new Map(),
    orderMatrix: [],
    routines: new Array(16).fill(''),
  };
  s.orderMatrix = [0, 1, 2, 3].map((ch) => {
    const keys = Array.from({ length: orders }, (_, o) => ch * 16 + o);
    for (const k of keys) s.patterns.set(k, Array.from({ length: 64 }, emptyCell));
    return [...keys, 0]; // the tracker's unplayed trailer entry
  });
  return s;
}

function set(s: UgeSong, ch: number, order: number, row: number, c: Partial<UgeCell>) {
  Object.assign(s.patterns.get(ch * 16 + order)![row]!, c);
}

function run(s: UgeSong) {
  const { song, errors } = importUge(writeUge(s));
  if (errors.length) throw new Error(errors.map((e) => e.message).join('\n'));
  return song;
}

function rejection(s: UgeSong | Uint8Array): string {
  try {
    importUge(s instanceof Uint8Array ? s : writeUge(s));
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('imported without complaint');
}

describe('import', () => {
  it("returns songs that don't compile with their errors, so they can be fixed in the file", () => {
    const s = blank();
    set(s, 0, 0, 0, { note: 24, instrument: 1, effectCode: 0xe, effectParams: 9 });
    set(s, 2, 0, 4, { note: 24, instrument: 0 });
    const { song, errors } = importUge(writeUge(s));
    expect(song.lanes.pulse1[0]).toMatchObject({ row: 0, cutTick: 9 });
    expect(errors.map((e) => `${e.lane} ${e.row}: ${e.message}`)).toEqual([
      "pulse1 0: cutTick 9 never happens: this row has 6 ticks on the note's last row",
      "wave 4: legato doesn't work on the wave lane: the driver stops the wave channel and doesn't restart it",
    ]);
  });

  it('with patterns, keeps two hUGE patterns with the same notes apart, and plays of one back to back as a repeat', () => {
    const s = blank(2);
    for (const order of [0, 1]) set(s, 0, order, 0, { note: 24, instrument: 1, effectCode: 0xe, effectParams: 0 });
    s.orderMatrix[0] = [0, 0, 1, 0];
    for (const ch of [1, 2, 3]) s.orderMatrix[ch] = [ch * 16, ch * 16, ch * 16 + 1, 0];
    const { song } = importUge(writeUge(s), { patterns: true });
    expect(song.lanes.pulse1).toEqual([
      { row: 0, pattern: 'p0', repeat: 2 },
      { row: 128, pattern: 'p1' },
    ]);
    expect(song.patterns!.map((p) => p.id)).toEqual(['p0', 'p1']);
  });

  it('with patterns, stops a pattern short of a note that sounds on into the next', () => {
    const s = blank(2);
    set(s, 1, 0, 0, { note: 24, instrument: 1 });
    set(s, 1, 0, 63, { note: 27, instrument: 1 }); // sounds on into order 1
    set(s, 1, 1, 3, { note: 26, instrument: 1 });
    const { song } = importUge(writeUge(s), { patterns: true });
    // The D#5 is left loose between the two patterns, and the second starts where it ends.
    expect(song.lanes.pulse2).toEqual([
      { row: 0, pattern: 'p16 rows 0-62' },
      { row: 63, len: 4, note: 'D#5', inst: 1 },
      { row: 67, pattern: 'p17 rows 3-63' },
    ]);
  });

  it("with patterns, gives a song that doesn't compile its errors in the patterns", () => {
    const s = blank();
    set(s, 0, 0, 0, { note: 24, instrument: 1, effectCode: 0xe, effectParams: 9 });
    const { errors } = importUge(writeUge(s), { patterns: true });
    expect(errors).toMatchObject([{ lane: 'pulse1', row: 0, pattern: 'p0', patternRow: 0 }]);
  });

  it('turns cuts into note lengths and cutTick', () => {
    const s = blank(1);
    set(s, 0, 0, 0, { note: 24, instrument: 1, effectCode: 0xe, effectParams: 0 }); // note and E00 on one row
    set(s, 0, 0, 4, { note: 26, instrument: 1 });
    set(s, 0, 0, 7, { effectCode: 0xe, effectParams: 2 }); // cut within a later row
    set(s, 0, 0, 8, { note: 28, instrument: 2 });
    set(s, 0, 0, 10, { effectCode: 0x2, effectParams: 0x10 }); // an effect inside the note
    set(s, 0, 0, 12, { effectCode: 0xe, effectParams: 0 }); // cut at the start of a row
    set(s, 0, 0, 14, { effectCode: 0xe, effectParams: 0 }); // a second cut, with no note playing
    set(s, 0, 0, 16, { note: 29 }); // no instrument
    const song = run(s);
    expect(song.lanes.pulse1).toEqual([
      { row: 0, len: 1, note: 'C5', inst: 1, cutTick: 0 },
      { row: 4, len: 4, note: 'D5', inst: 1, cutTick: 2 },
      { row: 8, len: 4, note: 'E5', inst: 2 },
      { row: 10, fx: { slideDown: 16 } },
      { row: 14, fx: { cut: 0 } },
      { row: 16, len: 48, note: 'F5', legato: true },
    ]);
  });

  it('keeps the last channel\'s song-wide effect on a row, as the driver does', () => {
    const s = blank(1);
    set(s, 0, 0, 0, { effectCode: 0x8, effectParams: 0xff });
    set(s, 3, 0, 0, { effectCode: 0x8, effectParams: 0x12 });
    set(s, 1, 0, 0, { effectCode: 0xf, effectParams: 3 });
    expect(run(s).global).toEqual([
      { row: 0, tempo: 3 },
      { row: 0, pan: ['L', 'R', 'off', 'off'] }, // 0x12: pulse1 left (bit 4), pulse2 right (bit 1)
    ]);
  });

  it('follows B and D to a straight timeline and a loop', () => {
    const s = blank(3);
    set(s, 0, 0, 15, { effectCode: 0xd, effectParams: 0x21 }); // order 1 starts at row 32
    set(s, 2, 2, 31, { effectCode: 0xb, effectParams: 0x02 }); // then order 1 from row 0
    const song = run(s);
    // Order 0 rows 0–15, order 1 rows 32–63, order 2 rows 0–31, order 1 rows 0–31, then order 1 row 32 again.
    expect(song.length).toBe(16 + 32 + 32 + 32);
    expect(song.loop).toBe(16);
  });

  it('keeps a groove with four different steps, in order, through to the compiled song', () => {
    const s = blank(1);
    s.ticksPerRow = [3, 4, 5, 6];
    const song = run(s);
    expect(song.groove).toEqual([3, 4, 5, 6]);
    const c = compile(song);
    expect(c.ok && c.data.groove).toEqual([3, 4, 5, 6]);
  });

  it('keeps instruments up to the highest one played, and only the waves the song plays', () => {
    const s = blank(1);
    set(s, 0, 0, 0, { note: 24, instrument: 3 });
    set(s, 0, 0, 1, { instrument: 9 }); // no note: the driver ignores it
    const song = run(s);
    expect(song.instruments.duty.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(song.instruments.wave).toEqual([]);
    expect(song.waves).toEqual([]);
  });
});

// Every import rejection, with the message it gives.
describe('import rejects', () => {
  const v5 = writeUge(blank());
  v5[0] = 5;
  const cases: [string, () => UgeSong | Uint8Array, string][] = [
    ['old versions', () => v5, ".uge version 5 isn't supported"],
    ['truncated files', () => writeUge(blank()).slice(0, 5000), 'file ends early'],
    [
      'uneven order lists',
      () => {
        const s = blank();
        s.orderMatrix[1] = [16, 0];
        return s;
      },
      "order lists have different or zero lengths (2, 1, 2, 2)",
    ],
    [
      'breaks past row 63',
      () => {
        const s = blank();
        set(s, 0, 0, 3, { effectCode: 0xd, effectParams: 0x41 });
        return s;
      },
      'order 0 row 3: D41 breaks to row 64, past row 63',
    ],
    [
      'jumps to missing orders',
      () => {
        const s = blank();
        set(s, 1, 0, 3, { effectCode: 0xb, effectParams: 0x05 });
        return s;
      },
      "B05 jumps to order 4, which doesn't exist",
    ],
    [
      'D00 after B',
      () => {
        const s = blank();
        set(s, 0, 0, 3, { effectCode: 0xb, effectParams: 0x01 });
        set(s, 1, 0, 3, { effectCode: 0xd, effectParams: 0 });
        return s;
      },
      'a D00 cancels a B jump',
    ],
    [
      'routines',
      () => {
        const s = blank();
        set(s, 2, 1, 5, { effectCode: 0x6, effectParams: 1 });
        return s;
      },
      "order 1 row 5, wave: routines (6xx) aren't supported",
    ],
    [
      'breaks that shift a non-uniform groove',
      () => {
        const s = blank();
        s.ticksPerRow = [5, 5, 5, 7];
        set(s, 0, 0, 10, { effectCode: 0xd, effectParams: 0x03 });
        return s;
      },
      'order 1 row 2: a pattern break shifts the groove (5,5,5,7) out of phase',
    ],
    [
      'F00',
      () => {
        const s = blank();
        set(s, 3, 0, 0, { effectCode: 0xf, effectParams: 0 });
        return s;
      },
      "F00 (256 ticks per row) isn't supported",
    ],
    [
      'VIN bits',
      () => {
        const s = blank();
        set(s, 3, 0, 0, { effectCode: 0x5, effectParams: 0xff });
        return s;
      },
      '5FF sets the cartridge audio (VIN) bits',
    ],
    [
      'bad table notes',
      () => {
        const s = blank();
        set(s, 0, 0, 0, { note: 24, instrument: 1 });
        s.duty[0]!.subpatternEnabled = true;
        s.duty[0]!.subpattern[0]!.note = 80;
        return s;
      },
      'duty instrument 1: table row 0 has note value 80',
    ],
    [
      'table jumps past the table',
      () => {
        const s = blank();
        set(s, 0, 0, 0, { note: 24, instrument: 1 });
        s.duty[0]!.subpatternEnabled = true;
        s.duty[0]!.subpattern[4]!.volume = 33;
        return s;
      },
      'table row 4 jumps to 33, past the table',
    ],
    [
      'song-wide effects in tables',
      () => {
        const s = blank();
        set(s, 0, 0, 0, { note: 24, instrument: 1 });
        s.duty[0]!.subpatternEnabled = true;
        s.duty[0]!.subpattern[2]!.effectCode = 0xf;
        s.duty[0]!.subpattern[2]!.effectParams = 2;
        return s;
      },
      "table row 2 uses effect Fxx, which tables don't support",
    ],
    [
      'instrument values out of range',
      () => {
        const s = blank();
        set(s, 0, 0, 0, { note: 24, instrument: 1 });
        s.duty[0]!.initialVolume = 16;
        return s;
      },
      'instruments.duty[0].volume: Too big',
    ],
    [
      'glide, delay and cut in tables',
      () => {
        const s = blank();
        set(s, 0, 0, 0, { note: 24, instrument: 1 });
        s.duty[0]!.subpatternEnabled = true;
        s.duty[0]!.subpattern[1]!.effectCode = 0x7;
        s.duty[0]!.subpattern[1]!.effectParams = 2;
        return s;
      },
      'duty instrument 1: table row 1: delay (7xx) breaks in tables',
    ],
  ];

  it.each(cases)('%s', (_, make, message) => {
    expect(rejection(make())).toContain(message);
  });
});

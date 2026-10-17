import { describe, expect, it } from 'vitest';
import { compile, parseSong } from '../src/core/compile.ts';
import { NO_NOTE } from '../src/core/notes.ts';
import { walk, type DriverSong } from '../src/core/driver.ts';
import { formatError } from '../src/core/location.ts';
import type { SongInput } from '../src/core/schema.ts';

function song(over: Partial<SongInput> = {}): SongInput {
  return {
    version: 1,
    grid: { rowsPerBeat: 4, beatsPerBar: 4 },
    groove: [6, 6, 6, 6],
    length: 64,
    instruments: {
      duty: [{ id: 1, duty: '50%', volume: 15 }],
      wave: [{ id: 1, wave: 0, level: '100%' }],
      noise: [{ id: 1, volume: 15 }],
    },
    waves: [{ id: 0, data: '0123456789ABCDEFFEDCBA9876543210' }],
    lanes: { pulse1: [], pulse2: [], wave: [], noise: [] },
    ...over,
  };
}

const lanes = (l: Partial<NonNullable<SongInput['lanes']>>) => ({ pulse1: [], pulse2: [], wave: [], noise: [], ...l });
const note = (row: number, len: number, extra: object = {}) => ({ row, len, note: 'C5', inst: 1, ...extra });

function build(input: SongInput, budget?: number) {
  const parsed = parseSong(input);
  if (parsed.errors) return { errors: parsed.errors.map((e) => formatError(input.grid, e)) };
  const r = compile(parsed.song, { budget });
  return r.ok ? { data: r.data } : { errors: r.errors.map((e) => formatError(parsed.song.grid, e)) };
}

function ok(input: SongInput): DriverSong {
  const r = build(input);
  if (r.errors) throw new Error(r.errors.join('\n'));
  return r.data!;
}

function errors(input: SongInput, budget?: number): string[] {
  const r = build(input, budget);
  if (!r.errors) throw new Error('compiled without errors');
  return r.errors;
}

/** pulse1's compiled rows along the timeline, as tracker text like "C5 1 E00". */
function timeline(d: DriverSong, ch = 0): string[] {
  const w = walk(d);
  if (typeof w === 'string') throw new Error(w);
  return w.rows.map(({ order, row }) => {
    const r = d.patterns[d.orders[ch]![order]!]![row]!;
    const fx = (r.code << 8) | r.param;
    return [r.note === NO_NOTE ? '' : r.note, r.inst || '', fx ? fx.toString(16).toUpperCase().padStart(3, '0') : '']
      .join(' ')
      .trim();
  });
}

describe('note ends', () => {
  it('cuts a note when its length runs out, unless the next note starts there', () => {
    const d = ok(song({ length: 16, lanes: lanes({ pulse1: [note(0, 4), note(4, 2), note(10, 6)] }) }));
    const t = timeline(d);
    expect(t[0]).toBe('24 1');
    expect(t[4]).toBe('24 1'); // the next note, no cut
    expect(t[6]).toBe('E00'); // the second note ends
    expect(t[10]).toBe('24 1');
    expect(t.length).toBe(16); // the last note runs to the song's end: no cut, the loop continues it
    expect(t.filter((x) => x === 'E00')).toHaveLength(1);
  });

  it('ends a note within its last row with cutTick', () => {
    const t = timeline(ok(song({ length: 16, lanes: lanes({ pulse1: [note(0, 3, { cutTick: 2 }), note(1 + 7, 1, { cutTick: 0 })] }) })));
    expect(t[2]).toBe('E02');
    expect(t[3]).toBe('');
    expect(t[8]).toBe('24 1 E00'); // a one-row note cut at tick 0, as tracker rows with a note and E00 import
  });

  it('writes legato notes with no instrument, and effects by name', () => {
    const t = timeline(
      ok(
        song({
          length: 16,
          lanes: lanes({
            pulse1: [note(0, 2, { fx: { vibrato: [4, 2] } }), { row: 2, len: 2, note: 'D5', legato: true }, { row: 3, fx: { slideUp: 3 } }],
          }),
        }),
      ),
    );
    expect(t.slice(0, 5)).toEqual(['24 1 442', '', '26', '103', 'E00']);
  });
});

describe('patterns and loops', () => {
  const cases: [number, number][] = [
    [64, 0],
    [100, 0],
    [128, 0],
    [200, 40],
    [128, 64],
    [633, 0],
    [130, 129],
  ];
  it.each(cases)('length %i, loop %i plays exactly length rows, then loops', (length, loop) => {
    const items = Array.from({ length }, (_, row) => ({ row, len: 1, note: 'C3', inst: 1 }));
    const d = ok(song({ length, loop, lanes: lanes({ pulse1: items }) }));
    const w = walk(d);
    if (typeof w === 'string') throw new Error(w);
    expect(w.rows.length).toBe(length);
    expect(w.loop).toBe(loop);
  });

  it('adds no jump when the song ends at row 63 and loops to 0', () => {
    const d = ok(song({ length: 128 }));
    expect(d.patterns.flat().some((r) => r.code === 0xb || r.code === 0xd)).toBe(false);
  });

  it('stores identical patterns once, across channels', () => {
    const d = ok(song({ length: 256, lanes: lanes({ pulse1: [note(0, 4), note(64, 4)], pulse2: [note(128, 4)] }) }));
    expect(d.orders[0]).toEqual([0, 0, 1, 1]);
    expect(d.orders[1]).toEqual([1, 1, 0, 1]);
    expect(d.patterns).toHaveLength(2);
  });

  it('puts song-wide effects in a free slot, noise first', () => {
    const d = ok(song({ global: [{ row: 0, tempo: 3 }, { row: 0, pan: ['LR', 'L', 'R', 'off'] }] }));
    const row0 = d.orders.map((o) => d.patterns[o[0]!]![0]!);
    expect(row0[3]).toMatchObject({ code: 0xf, param: 3 });
    expect(row0[2]).toMatchObject({ code: 0x8, param: 0b0011_0101 }); // left bits 4–7, right bits 0–3
  });
});

describe('instruments and waves', () => {
  it('emits instruments up to the highest one notes use, with placeholders for gaps', () => {
    const d = ok(
      song({
        instruments: {
          duty: [
            { id: 3, duty: '25%', volume: 12, envPace: 2, length: 10, lengthEnabled: true },
            { id: 1, duty: '50%', volume: 15 },
            { id: 9, duty: '50%', volume: 15 },
          ],
        },
        lanes: lanes({ pulse1: [note(0, 1, { inst: 3 })] }),
      }),
    );
    expect(d.duty).toHaveLength(3);
    expect(d.duty[0]!.fields).toEqual([8, 0x80, 0xf0, 0x80]);
    expect(d.duty[1]!.fields).toEqual([0, 0, 0, 0]);
    expect(d.duty[2]!.fields).toEqual([8, 0x40 | 10, 0xc2, 0xc0]);
    expect(d.wave).toHaveLength(0);
    expect(d.waves).toHaveLength(0);
  });

  it('pads tables to 32 rows, looping from the last row', () => {
    const d = ok(
      song({
        instruments: { noise: [{ id: 1, volume: 15, bits: 7, table: [{ note: 12 }, { fx: { volume: 3 } }, {}, { note: 0, jump: 2 }] }] },
        lanes: lanes({ noise: [note(0, 1)] }),
      }),
    );
    const t = d.noise[0]!.table!;
    expect(d.noise[0]!.fields).toEqual([0xf0, 0x80, 0, 0]);
    expect(t).toHaveLength(32);
    expect(t[0]).toEqual({ note: 48, inst: 0, code: 0, param: 0 });
    expect(t[1]).toEqual({ note: NO_NOTE, inst: 0, code: 0xc, param: 3 });
    expect(t[3]).toEqual({ note: 36, inst: 3, code: 0, param: 0 });
    expect(t[31]!.inst).toBe(1);
  });

  it('only counts table rows the table can reach', () => {
    const d = ok(
      song({
        instruments: { duty: [{ id: 1, duty: '50%', volume: 15, table: [{ note: 0, jump: 0 }, { note: -1 }] }] },
        lanes: lanes({ pulse1: [note(0, 1, { note: 'C3' })] }),
      }),
    );
    expect(d.duty[0]!.table![1]!.note).toBe(35);
  });

  it('allows a raw wave select that straddles two waves, which imported songs use', () => {
    const d = ok(
      song({
        waves: [
          { id: 0, data: '0'.repeat(32) },
          { id: 1, data: 'F'.repeat(32) },
        ],
        lanes: lanes({ wave: [{ row: 0, fx: { raw: '930' } }] }),
      }),
    );
    expect(d.waves).toHaveLength(2); // bytes 3–18
  });

  it('emits waves up to the highest one the song plays', () => {
    const d = ok(
      song({
        instruments: { wave: [{ id: 1, wave: 2, level: '50%' }] },
        waves: [
          { id: 2, data: 'F'.repeat(32) },
          { id: 0, data: '0'.repeat(32) },
        ],
        lanes: lanes({ wave: [note(0, 1)] }),
      }),
    );
    expect(d.wave[0]!.fields).toEqual([0, 0x40, 2, 0x80]);
    expect(d.waves).toEqual([new Array(16).fill(0), new Array(16).fill(0), new Array(16).fill(0xff)]);
  });
});

// Every compiler error, with the message it gives.
describe('errors', () => {
  const cases: [string, SongInput, string][] = [
    ['loop past the end', song({ loop: 64 }), 'loop (64) must be less than length (64)'],
    ['loop off the groove', song({ groove: [5, 5, 5, 7], loop: 2 }), 'must be a multiple of 4'],
    [
      'instrument defined twice',
      song({ instruments: { duty: [{ id: 1, duty: '50%', volume: 1 }, { id: 1, duty: '50%', volume: 2 }] } }),
      'duty instrument 1 is defined twice',
    ],
    [
      'wrong effect in a table',
      song({ instruments: { wave: [{ id: 1, wave: 0, level: '100%', table: [{ fx: { duty: '25%' } }] }] } }),
      'table row 0: duty only works on pulse lanes',
    ],
    ['wave defined twice', song({ waves: [{ id: 0, data: '0'.repeat(32) }, { id: 0, data: '1'.repeat(32) }] }), 'wave 0 is defined twice'],
    ['global with two kinds', song({ global: [{ row: 0, tempo: 3, masterVolume: [7, 7] }] }), '1.1.1 (row 0), global: a global item needs exactly one'],
    ['global past the end', song({ global: [{ row: 64, tempo: 3 }] }), "past the song's end"],
    ['two tempos on one row', song({ global: [{ row: 4, tempo: 3 }, { row: 4, tempo: 5 }] }), '1.2.1 (row 4), global: two tempo changes on one row'],
    ['item past the end', song({ lanes: lanes({ pulse1: [note(64, 1)] }) }), "pulse1: past the song's end"],
    ['two notes on a row', song({ lanes: lanes({ pulse1: [note(0, 1), note(0, 1)] }) }), 'two notes on one row'],
    ['note and effect on a row', song({ lanes: lanes({ pulse1: [note(0, 1), { row: 0, fx: { volume: 3 } }] }) }), "put the effect in the note's fx"],
    ['two effects on a row', song({ lanes: lanes({ pulse1: [{ row: 0, fx: { volume: 3 } }, { row: 0, fx: { slideUp: 1 } }] }) }), 'two effects on one row'],
    ['effect with two keys', song({ lanes: lanes({ pulse1: [{ row: 0, fx: { volume: 3, slideUp: 1 } }] }) }), 'exactly one key, not 2'],
    ['empty arpeggio', song({ lanes: lanes({ pulse1: [{ row: 0, fx: { arp: [0, 0] } }] }) }), 'arp [0, 0] does nothing'],
    ['duty on the wave lane', song({ lanes: lanes({ wave: [{ row: 0, fx: { duty: '25%' } }] }) }), 'duty only works on pulse lanes'],
    ['wave on a pulse lane', song({ lanes: lanes({ pulse2: [{ row: 0, fx: { wave: 1 } }] }) }), 'wave only works on the wave lane'],
    ['raw jump', song({ lanes: lanes({ pulse1: [{ row: 0, fx: { raw: 'B01' } }] }) }), 'which the compiler adds itself'],
    ['raw with a name', song({ lanes: lanes({ pulse1: [{ row: 0, fx: { raw: 'C05' } }] }) }), 'write {"volume":5} instead of raw C05'],
    ['cut fx on a note', song({ lanes: lanes({ pulse1: [note(0, 1, { fx: { cut: 2 } })] }) }), "a note can't have a cut fx"],
    ['delay 0', song({ lanes: lanes({ pulse1: [note(0, 1, { fx: { delay: 0 } })] }) }), 'delay 0 never plays'],
    ['delay too long', song({ lanes: lanes({ pulse1: [note(0, 1, { fx: { delay: 6 } })] }) }), 'delay 6 never plays'],
    ['cut too late', song({ lanes: lanes({ pulse1: [{ row: 0, fx: { cut: 6 } }] }) }), 'cut 6 never happens: this row has 6 ticks'],
    ['note fields without a note', song({ lanes: lanes({ pulse1: [{ row: 0, len: 2, fx: { volume: 1 } }] }) }), 'len without a note'],
    ['empty item', song({ lanes: lanes({ pulse1: [{ row: 0 }] }) }), 'an item needs a note or an fx'],
    ['flat note', song({ lanes: lanes({ pulse1: [note(0, 1, { note: 'Bb4' })] }) }), 'write A#4 instead of Bb4'],
    ['note too low', song({ lanes: lanes({ pulse1: [note(0, 1, { note: 'B2' })] }) }), 'B2 is out of range'],
    ['not a note', song({ lanes: lanes({ pulse1: [note(0, 1, { note: 'do' })] }) }), '"do" isn\'t a note'],
    ['note without len', song({ lanes: lanes({ pulse1: [{ row: 0, note: 'C5', inst: 1 }] }) }), 'a note needs len'],
    ['note without inst', song({ lanes: lanes({ pulse1: [{ row: 0, len: 1, note: 'C5' }] }) }), 'a note needs inst, or legato: true'],
    ['note with inst and legato', song({ lanes: lanes({ pulse1: [note(0, 1, { legato: true })] }) }), 'inst or legato, not both'],
    ['undefined instrument', song({ lanes: lanes({ noise: [note(0, 1, { inst: 2 })] }) }), "noise instrument 2 isn't defined"],
    ['note past the end', song({ lanes: lanes({ pulse1: [note(60, 8)] }) }), "runs past the song's end (length 64); shorten it to 4 rows"],
    ['overlap', song({ lanes: lanes({ pulse1: [note(0, 8), note(4, 1)] }) }), 'overlaps the note at 1.1.1; shorten that one to 4 rows'],
    ['cutTick too late', song({ lanes: lanes({ pulse1: [note(0, 2, { cutTick: 6 })] }) }), "cutTick 6 never happens: this row has 6 ticks on the note's last row"],
    ['cut inside a note', song({ lanes: lanes({ pulse1: [note(0, 8), { row: 3, fx: { cut: 0 } }] }) }), "a cut inside the note at 1.1.1; set that note's len to 3"],
    ['cut where a note ends', song({ lanes: lanes({ pulse1: [note(0, 4), { row: 4, fx: { cut: 0 } }] }) }), 'already ends here; remove this cut'],
    [
      'effect where a note ends',
      song({ lanes: lanes({ pulse1: [note(0, 4), { row: 4, fx: { volume: 2 } }] }) }),
      "1.2.1 (row 4), pulse1: the cut that ends the note at 1.1.1 needs this row's effect slot, but an effect is there",
    ],
    [
      'cutTick and fx on one row',
      song({ lanes: lanes({ pulse1: [note(0, 1, { cutTick: 2, fx: { volume: 2 } })] }) }),
      "the cutTick of the note at 1.1.1 needs this row's effect slot, but the note's fx is there",
    ],
    [
      'undefined wave',
      song({ instruments: { wave: [{ id: 1, wave: 3, level: '100%' }] }, lanes: lanes({ wave: [note(0, 1)] }) }),
      "wave 3 isn't defined, but wave instrument 1 uses it",
    ],
    ['too many orders', song({ length: 128 * 64 }), 'the song needs 128 orders of 64 rows, but the driver allows 127'],
    ['a huge length', song({ length: 2 ** 32 }), 'the song needs 67108864 orders'],
    ['padded octave', song({ lanes: lanes({ pulse1: [note(0, 1, { note: 'C05' })] }) }), '"C05" isn\'t a note'],
    ['legato on the wave lane', song({ lanes: lanes({ wave: [note(0, 2), { row: 2, len: 1, note: 'D5', legato: true }] }) }), "legato doesn't work on the wave lane"],
    [
      'glide in a table',
      song({ instruments: { duty: [{ id: 1, duty: '50%', volume: 15, table: [{ fx: { glide: 2 } }] }] } }),
      'duty instrument 1: table row 0: glide (3xx) breaks in tables',
    ],
    [
      'cut in a table',
      song({ instruments: { duty: [{ id: 1, duty: '50%', volume: 15, table: [{}, { fx: { cut: 1 } }] }] } }),
      "table row 1: cut (Exx) doesn't work in tables",
    ],
    [
      'raw wave read past the waves',
      song({ waves: [{ id: 15, data: '0'.repeat(32) }], lanes: lanes({ wave: [{ row: 0, fx: { raw: '9FF' } }] }) }),
      '9FF reads 16 bytes from byte 255 of the waves, past the end of wave 15',
    ],
    ['raw wave read of missing waves', song({ waves: [], lanes: lanes({ wave: [{ row: 0, fx: { raw: '910' } }] }) }), "wave 0 isn't defined, but the wave lane at 1.1.1 uses it"],
    [
      'table below C3',
      song({
        instruments: { duty: [{ id: 1, duty: '50%', volume: 15, table: [{ note: -1 }] }] },
        lanes: lanes({ pulse1: [note(0, 1, { note: 'C3' })] }),
      }),
      "C3 with duty instrument 1's table reaches -1 semitones, outside C3–B8",
    ],
    [
      'table above B8, through a legato note',
      song({
        instruments: { duty: [{ id: 1, duty: '50%', volume: 15, table: [{ note: 2 }] }] },
        lanes: lanes({ pulse1: [note(0, 1, { note: 'G8' }), { row: 1, len: 1, note: 'A#8', legato: true }] }),
      }),
      "1.1.2 (row 1), pulse1: A#8 with duty instrument 1's table reaches +2 semitones",
    ],
    ['arp above B8', song({ lanes: lanes({ pulse2: [note(0, 4, { note: 'B8' }), { row: 2, fx: { arp: [1, 0] } }] }) }), "1.1.3 (row 2), pulse2: arp on B8 goes above B8"],
    [
      'arp above B8 when the song loops',
      song({ length: 4, lanes: lanes({ pulse1: [{ row: 0, fx: { arp: [1, 0] } }, note(2, 2, { note: 'B8' })] }) }),
      '1.1.1 (row 0), pulse1: arp on B8 (still playing when the song loops back here) goes above B8',
    ],
    [
      'a table carried into the loop by a legato note',
      song({
        length: 4,
        instruments: {
          duty: [
            { id: 1, duty: '50%', volume: 15 },
            { id: 2, duty: '50%', volume: 15, table: [{ note: 1, jump: 0 }] },
          ],
        },
        lanes: lanes({ pulse1: [{ row: 0, len: 2, note: 'B8', legato: true }, note(2, 2, { note: 'C3', inst: 2 })] }),
      }),
      "1.1.1 (row 0), pulse1: B8 with duty instrument 2's table reaches +1 semitones",
    ],
    [
      'no slot for the loop jump',
      song({
        length: 40,
        lanes: lanes({
          pulse1: [{ row: 39, fx: { volume: 1 } }],
          pulse2: [{ row: 39, fx: { volume: 1 } }],
          wave: [{ row: 39, fx: { volume: 1 } }],
          noise: [{ row: 39, fx: { volume: 1 } }],
        }),
      }),
      '3.2.4 (row 39), global: the jump back to the start needs 1 effect slot on this row, but 0 of 4 lanes have one free',
    ],
    ['schema: volume out of range', song({ lanes: lanes({ pulse1: [{ row: 5, fx: { volume: 16 } }] }) }), '1.2.2 (row 5), pulse1: fx.volume: Too big'],
    ['schema: unknown key', song({ lanes: lanes({ pulse1: [{ row: 0, len: 1, note: 'C5', inst: 1, velocity: 3 } as never] }) }), 'Unrecognized key: "velocity"'],
  ];

  it.each(cases)('%s', (_, input, message) => {
    expect(errors(input).join('\n')).toContain(message);
  });

  it('reports overlapping notes that end on one row once, not their cuts as well', () => {
    expect(errors(song({ lanes: lanes({ pulse1: [note(4, 4), note(6, 2)] }) }))).toEqual([
      '1.2.3 (row 6), pulse1: overlaps the note at 1.2.1; shorten that one to 2 rows',
    ]);
  });

  it('over budget', () => {
    expect(errors(song(), 100).join('\n')).toContain('over the 100-byte budget');
  });
});

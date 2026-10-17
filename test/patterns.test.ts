import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compile, parseSong } from '../src/core/compile.ts';
import { formatSong } from '../src/core/format.ts';
import { importUge } from '../src/core/import.ts';
import { formatError, formatErrors } from '../src/core/location.ts';
import { expand } from '../src/core/patterns.ts';
import { type LaneItem, type Pattern, type Song, type SongInput } from '../src/core/schema.ts';
import { showNotes, showPatterns, summary } from '../src/core/show.ts';
import { demoSong, factorsIntoPatterns, fixture, importsWithPatterns } from './songs.ts';

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
const riff = { id: 'riff', kind: 'duty' as const, length: 8, items: [note(0, 4), note(4, 4, { note: 'E5' })] };

function parse(input: SongInput): Song {
  const parsed = parseSong(input);
  if (parsed.errors) throw new Error(JSON.stringify(parsed.errors));
  return parsed.song;
}

function errors(input: SongInput): string[] {
  const s = parse(input);
  const r = compile(s);
  if (r.ok) throw new Error('compiled without errors');
  return r.errors.map((e) => formatError(s.grid, e));
}

describe('patterns compile to the same bytes as the notes written out', () => {
  const haltBugUge = () => readFileSync(fixture('halt_bug.uge'));

  it("HALT Bug's .uge, factored into 16-row patterns", () => factorsIntoPatterns(importUge(haltBugUge()).song));
  // The demo song has patterns of its own, so it's written out first.
  it('the demo song, factored into 16-row patterns', () => factorsIntoPatterns(expand(demoSong()).song));
  it("HALT Bug's .uge, imported with its hUGE patterns", () => importsWithPatterns(haltBugUge()));

  it('places the hUGE patterns as the orders play them, up to the break that ends the song', () => {
    const { song: s } = importUge(haltBugUge(), { patterns: true });
    const show = (items: LaneItem[]) => items.map((i) => (i.pattern ? `${i.row} ${i.pattern}` : `${i.row} ${i.note}`));
    const full = Array.from({ length: 12 }, (_, o) => `${o * 64} p${String(o * 4 + 1).padStart(2, '0')}`);
    // The song is 784 rows: twelve whole orders, then the compiler's break on row 15 of the last, back to the start.
    expect(show(s.lanes.pulse2)).toEqual([...full, '768 p49 rows 0-15']);
  });

  it('reads placements in any order, as the editor and show get them before fmt', () => {
    const s = parse(song({ patterns: [riff], lanes: lanes({ pulse1: [{ row: 16, pattern: 'riff' }, { row: 0, pattern: 'riff' }] }) }));
    const e = expand(s);
    expect(e.errors).toEqual([]);
    expect(e.occurrences.map((o) => o.start)).toEqual([0, 16]);
    expect(e.song.lanes.pulse1.map((i) => i.row)).toEqual([0, 4, 16, 20]);
  });

  it('transposes notes and leaves effects alone', () => {
    const fx = { arp: [3, 7] as [number, number] };
    const pattern = { ...riff, items: [note(0, 4, { fx }), note(4, 4, { note: 'E5' })] };
    const placed = song({ patterns: [pattern], lanes: lanes({ pulse2: [{ row: 8, pattern: 'riff', transpose: 5, repeat: 2 }] }) });
    const written = song({
      lanes: lanes({
        pulse2: [note(8, 4, { note: 'F5', fx }), note(12, 4, { note: 'A5' }), note(16, 4, { note: 'F5', fx }), note(20, 4, { note: 'A5' })],
      }),
    });
    expect(compile(parse(placed))).toEqual(compile(parse(written)));
  });

  it("plays a placement's notes with its inst, and cuts its last repeat short at len", () => {
    const placed = song({
      instruments: { duty: [{ id: 1, duty: '50%', volume: 15 }, { id: 4, duty: '50%', volume: 5 }] },
      patterns: [{ ...riff, items: [note(0, 4), note(4, 2, { note: 'E5', cutTick: 2 }), { row: 6, len: 2, note: 'G5', legato: true }] }],
      lanes: lanes({ pulse1: [{ row: 0, pattern: 'riff', repeat: 2 }], pulse2: [{ row: 3, pattern: 'riff', repeat: 2, inst: 4, len: 13 }] }),
      length: 16,
    });
    const written = song({
      instruments: { duty: [{ id: 1, duty: '50%', volume: 15 }, { id: 4, duty: '50%', volume: 5 }] },
      lanes: lanes({
        pulse1: [note(0, 4), note(4, 2, { note: 'E5', cutTick: 2 }), { row: 6, len: 2, note: 'G5', legato: true }, note(8, 4), note(12, 2, { note: 'E5', cutTick: 2 }), { row: 14, len: 2, note: 'G5', legato: true }],
        pulse2: [note(3, 4, { inst: 4 }), note(7, 2, { note: 'E5', inst: 4, cutTick: 2 }), { row: 9, len: 2, note: 'G5', legato: true }, note(11, 4, { inst: 4 }), note(15, 1, { note: 'E5', inst: 4 })],
      }),
      length: 16,
    });
    expect(expand(parse(placed)).errors).toEqual([]);
    expect(expand(parse(placed)).song.lanes).toEqual(parse(written).lanes);
    expect(compile(parse(placed))).toEqual(compile(parse(written)));
    expect(showNotes(parse(placed))).toContain('[riff ×2 inst 4 len 13 from 1.1.4]');
  });

  it('keeps the flat timeline across boundaries: no cut between back-to-back notes, legato carries on', () => {
    const legato = { id: 'slide', kind: 'duty' as const, length: 4, items: [{ row: 0, len: 4, note: 'G5', legato: true as const }] };
    const placed = song({
      patterns: [riff, legato],
      lanes: lanes({ pulse1: [{ row: 0, pattern: 'riff' }, { row: 8, pattern: 'slide' }] }),
    });
    const written = song({ lanes: lanes({ pulse1: [note(0, 4), note(4, 4, { note: 'E5' }), { row: 8, len: 4, note: 'G5', legato: true }] }) });
    expect(compile(parse(placed))).toEqual(compile(parse(written)));
  });
});

describe('pattern errors', () => {
  const placed = (pulse1: object[], patterns: object[] = [riff]) =>
    song({ patterns: patterns as never, lanes: lanes({ pulse1: pulse1 as never }) });

  it('names a missing pattern, or one of the wrong kind', () => {
    expect(errors(placed([{ row: 0, pattern: 'nope' }]))).toEqual(['1.1.1 (row 0), pulse1: there\'s no pattern nope']);
    const drums = { id: 'drums', kind: 'noise', length: 4, items: [] };
    expect(errors(placed([{ row: 0, pattern: 'drums' }], [drums]))).toEqual([
      '1.1.1 (row 0), pulse1: pattern drums is for noise instruments, and pulse1 plays duty instruments',
    ]);
  });

  it('keeps a placement inside the song', () => {
    expect(errors(placed([{ row: 32, pattern: 'riff', repeat: 5 }]))).toEqual([
      "3.1.1 (row 32), pulse1: pattern riff, played 5 times, runs past the song's end (length 64): it ends at row 72",
    ]);
  });

  it("doesn't write out a huge repeat before refusing it", () => {
    const big = song({ length: 1e9, patterns: [{ id: 'one', kind: 'duty', length: 1, items: [note(0, 1)] }], lanes: lanes({ pulse1: [{ row: 0, pattern: 'one', repeat: 1e9 }] }) });
    const started = Date.now();
    expect(errors(big)[0]).toMatch(/orders of 64 rows/);
    expect(expand(parse(big)).errors[0]!.message).toMatch(/runs past the song's end/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('gives a placement its rows to itself', () => {
    expect(errors(placed([{ row: 0, pattern: 'riff', repeat: 2 }, { row: 12, pattern: 'riff' }]))).toEqual([
      '1.4.1 (row 12), pulse1: starts inside pattern riff, placed at 1.1.1',
    ]);
    expect(errors(placed([{ row: 0, pattern: 'riff' }, { row: 6, fx: { vibrato: [4, 2] } }]))).toEqual([
      '1.2.3 (row 6), pulse1: inside pattern riff, placed at 1.1.1: a placement has its rows to itself; put this in the pattern, or move it',
    ]);
    expect(errors(placed([note(14, 4), { row: 16, pattern: 'riff' }]))).toEqual([
      '1.4.3 (row 14), pulse1: the note runs into pattern riff, placed at 2.1.1; shorten it to 2 rows',
    ]);
  });

  it('keeps placements to their own fields', () => {
    expect(errors(placed([{ row: 0, pattern: 'riff', note: 'C5' }]))).toEqual([
      '1.1.1 (row 0), pulse1: a placement has only row, pattern, transpose, repeat, inst and len; put note in the pattern or another item',
    ]);
    expect(errors(placed([{ ...note(0, 4), transpose: 2 }]))).toEqual([
      '1.1.1 (row 0), pulse1: transpose and repeat are for placements; add a pattern or remove them',
    ]);
  });

  it('keeps len to cutting the last repeat short', () => {
    expect(errors(placed([{ row: 0, pattern: 'riff', len: 8 }]))).toEqual([
      '1.1.1 (row 0), pulse1: len 8 plays pattern riff whole once; leave len out',
    ]);
    expect(errors(placed([{ row: 0, pattern: 'riff', len: 16 }]))).toEqual([
      '1.1.1 (row 0), pulse1: len 16 plays pattern riff whole 2 times; leave len out and use repeat 2',
    ]);
    expect(errors(placed([{ row: 0, pattern: 'riff', repeat: 3, len: 6 }]))).toEqual([
      '1.1.1 (row 0), pulse1: len 6 cuts short repeat 1 of pattern riff (length 8); use repeat 1, not 3',
    ]);
  });

  it("keeps a pattern's items inside it", () => {
    const bad = { id: 'bad', kind: 'duty', length: 8, items: [note(4, 8), note(9, 1)] };
    expect(errors(placed([{ row: 0, pattern: 'bad' }], [bad]))).toEqual([
      "pattern bad at 1.2.1 (its row 4): the note runs past the pattern's end (length 8); shorten it to 4 rows",
      "pattern bad at 1.3.2 (its row 9): past the pattern's end (length 8)",
    ]);
  });

  it('checks what an unplaced pattern plays that has no row: a missing wave, a length no song can have', () => {
    const wavy = { id: 'wavy', kind: 'wave', length: 4, items: [note(0, 4, { inst: 2 })] };
    const s = song({ instruments: { wave: [{ id: 1, wave: 0, level: '100%' }, { id: 2, wave: 7, level: '100%' }] } });
    expect(errors({ ...s, patterns: [wavy] as never })).toEqual(["pattern wavy: wave 7 isn't defined, but wave instrument 2 uses it"]);
    const long = { id: 'long', kind: 'duty', length: 20000, items: [note(0, 4, { inst: 9 })] };
    expect(errors(placed([], [long]))).toEqual(['pattern long: 20000 rows is longer than any song the driver can play (8128)']);
  });

  it('refuses placement fields on loose items, even in a song without patterns, and even when they mean nothing', () => {
    expect(errors(song({ lanes: lanes({ pulse1: [note(0, 4, { transpose: 5, repeat: 2 })] }) }))).toEqual([
      '1.1.1 (row 0), pulse1: transpose and repeat are for placements; add a pattern or remove them',
    ]);
    expect(formatSong(parse(song({ lanes: lanes({ pulse1: [note(0, 4, { repeat: 1 })] }) })))).toContain('"repeat": 1');
  });

  it('counts an error once in check when its message names each place', () => {
    const overlapping = { ...riff, items: [note(0, 6), note(4, 4)] };
    const s = placed([{ row: 0, pattern: 'riff' }, { row: 32, pattern: 'riff' }], [overlapping]);
    const r = compile(parse(s));
    if (r.ok) throw new Error('compiled');
    expect(formatErrors(parse(s).grid, r.errors)).toEqual([
      '1.2.1 (row 4), pulse1, pattern riff at 1.2.1 (its row 4): overlaps the note at 1.1.1; shorten that one to 4 rows (in 2 places; this is the first)',
    ]);
  });

  it('refuses two patterns with one id', () => {
    expect(errors(placed([], [riff, riff]))).toEqual(['patterns[1]: pattern riff is defined twice']);
  });

  it('says where a transposed note leaves the note range', () => {
    expect(errors(placed([{ row: 0, pattern: 'riff', transpose: 44 }]))).toEqual([
      "1.2.1 (row 4), pulse1, pattern riff at 1.2.1 (its row 4): E5 transposed by +44 is above B8, outside the driver's notes",
    ]);
  });

  it('gives the pattern and its row for errors where a pattern plays, once per place', () => {
    const broken = { ...riff, items: [note(0, 4, { inst: 3 })] };
    const s = placed([{ row: 0, pattern: 'riff' }, { row: 32, pattern: 'riff' }], [broken]);
    const r = compile(parse(s));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => formatError(parse(s).grid, e))).toEqual([
      "1.1.1 (row 0), pulse1, pattern riff at 1.1.1 (its row 0): duty instrument 3 isn't defined",
      "3.1.1 (row 32), pulse1, pattern riff at 1.1.1 (its row 0): duty instrument 3 isn't defined",
    ]);
    expect(formatErrors(parse(s).grid, r.errors)).toEqual([
      "1.1.1 (row 0), pulse1, pattern riff at 1.1.1 (its row 0): duty instrument 3 isn't defined (in 2 places; this is the first)",
    ]);
  });

  it('checks a pattern on its own when every place cuts it short or swaps its instruments', () => {
    const hidden = { id: 'hidden', kind: 'duty', length: 8, items: [note(0, 2, { inst: 3 }), note(4, 4), note(6, 2)] };
    expect(errors(placed([{ row: 0, pattern: 'hidden', inst: 1, len: 4 }], [hidden]))).toEqual([
      "pattern hidden at 1.1.1 (its row 0): duty instrument 3 isn't defined",
      'pattern hidden at 1.2.3 (its row 6): overlaps the note at 1.2.1; shorten that one to 2 rows',
    ]);
    // An error a place shows already isn't repeated by checking the pattern on its own.
    expect(errors(placed([{ row: 0, pattern: 'hidden', inst: 1 }], [hidden]))).toEqual([
      '1.2.3 (row 6), pulse1, pattern hidden at 1.2.3 (its row 6): overlaps the note at 1.2.1; shorten that one to 2 rows',
      "pattern hidden at 1.1.1 (its row 0): duty instrument 3 isn't defined",
    ]);
    // A place that plays it whole with its own instruments shows its errors where it plays, and it isn't checked
    // on its own as well.
    const both = errors(placed([{ row: 0, pattern: 'hidden' }, { row: 16, pattern: 'hidden', inst: 1, len: 4 }], [hidden]));
    expect(both.filter((e) => e.startsWith('pattern hidden'))).toEqual([]);
    expect(both.filter((e) => e.includes('overlaps'))).toEqual([
      '1.2.3 (row 6), pulse1, pattern hidden at 1.2.3 (its row 6): overlaps the note at 1.2.1; shorten that one to 2 rows',
    ]);
  });

  it('checks a pattern nothing places', () => {
    const draft = { id: 'draft', kind: 'wave', length: 8, items: [note(0, 4, { inst: 2 }), note(4, 2), { row: 4, fx: { wave: 1 } }] };
    expect(errors(placed([], [draft]))).toEqual([
      "pattern draft at 1.1.1 (its row 0): wave instrument 2 isn't defined",
      "pattern draft at 1.2.1 (its row 4): a note and an effect on one row; put the effect in the note's fx",
    ]);
  });
});

describe('patterns in the file', () => {
  it('sorts patterns by id and leaves out what means nothing', () => {
    const s = parse(
      song({
        patterns: [
          { ...riff, id: 'b', items: [note(4, 4), note(0, 4)] },
          { ...riff, id: 'B' },
          { ...riff, id: 'a' },
        ],
        lanes: lanes({ pulse1: [{ row: 16, pattern: 'a', transpose: 0, repeat: 1 }, { row: 0, pattern: 'b', repeat: 2 }] }),
      }),
    );
    const text = formatSong(s);
    const back = JSON.parse(text);
    expect(back.patterns.map((p: Pattern) => p.id)).toEqual(['B', 'a', 'b']);
    expect(back.patterns[2].items.map((i: LaneItem) => i.row)).toEqual([0, 4]);
    expect(back.lanes.pulse1).toEqual([{ row: 0, pattern: 'b', repeat: 2 }, { row: 16, pattern: 'a' }]);
    expect(text).toContain('{ "row": 0, "pattern": "b", "repeat": 2 }');
    const echo = formatSong(parse(song({ patterns: [riff], lanes: lanes({ pulse2: [{ len: 4, inst: 1, repeat: 2, pattern: 'riff', row: 3 } as never] }) })));
    expect(echo).toContain('{ "row": 3, "pattern": "riff", "repeat": 2, "inst": 1, "len": 4 }');
  });

  it("leaves songs without patterns as they were", () => {
    expect(formatSong(parse(song({ patterns: [] })))).not.toContain('patterns');
  });

  it('refuses an id with spaces at its ends', () => {
    expect(parseSong(song({ patterns: [{ ...riff, id: ' riff' }] })).errors).toBeDefined();
  });
});

describe('show', () => {
  const s = () =>
    parse(song({ patterns: [riff], lanes: lanes({ pulse1: [{ row: 0, pattern: 'riff', transpose: -2, repeat: 2 }], pulse2: [note(0, 2)] }) }));

  it('shows notes as they play, starting each lane line with the patterns there', () => {
    expect(showNotes(s(), { from: 1, to: 1 })).toBe(
      [
        'bar 1',
        '  pulse1  [riff -2 ×2 from 1.1.1]  1.1 A#4 i1 4  2.1 D5 i1 4  3.1 A#4 i1 4  4.1 D5 i1 4',
        '  pulse2  1.1 C5 i1 2',
      ].join('\n'),
    );
  });

  it('lists patterns and where they are', () => {
    expect(showPatterns(s())).toBe(['pattern riff: duty, 8 rows, placed at pulse1 1.1.1 -2 ×2', '  bar 1  1.1 C5 i1 4  2.1 E5 i1 4'].join('\n'));
  });

  it('counts patterns and places in the summary', () => {
    expect(summary(s(), compile(s()))).toMatch(/3 tracker patterns, 1 pattern in 1 place$/);
  });
});

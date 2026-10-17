import { describe, expect, it } from 'vitest';
import { compile, parseSong } from '../src/core/compile.ts';
import type { Song, SongInput } from '../src/core/schema.ts';
import { describeCut, setRange } from '../src/app/length.ts';

// The song's length and loop (docs/editor/, "Length and loop").

const riff = { id: 'riff', kind: 'duty' as const, length: 8, items: [{ row: 0, len: 4, note: 'C5', inst: 1 }] };

function song(extra: Partial<SongInput> = {}): Song {
  const r = parseSong({
    version: 1,
    grid: { rowsPerBeat: 4, beatsPerBar: 4 },
    groove: [6, 6, 6, 6],
    length: 64,
    loop: 16,
    instruments: { duty: [{ id: 1, duty: '50%', volume: 15 }] },
    patterns: [riff],
    lanes: {
      pulse1: [
        { row: 0, len: 4, note: 'C5', inst: 1 },
        { row: 28, len: 8, note: 'D5', inst: 1, cutTick: 2 }, // runs past row 32
        { row: 30, fx: { vibrato: [4, 2] } }, // inside D5, before row 32
        { row: 33, fx: { volume: 8 } }, // inside D5, past row 32
        { row: 40, len: 4, note: 'E5', inst: 1 },
      ],
      pulse2: [
        { row: 0, pattern: 'riff', repeat: 2 },
        { row: 24, pattern: 'riff', repeat: 2 }, // rows 24 to 40
        { row: 48, pattern: 'riff' },
      ],
    },
    global: [{ row: 0, tempo: 6 }, { row: 32, tempo: 5 }, { row: 50, pan: ['LR', 'L', 'R', 'off'] }],
    ...extra,
  });
  if (r.errors) throw new Error(JSON.stringify(r.errors));
  return r.song;
}

function ok(r: ReturnType<typeof setRange>) {
  if (typeof r === 'string') throw new Error(r);
  return r;
}

describe("the song's length and loop", () => {
  it('grows the song, leaving its lanes as they were', () => {
    const s = song();
    const r = ok(setRange(s, 128));
    expect(r.song).toMatchObject({ length: 128, loop: 16 });
    expect(r.song.lanes).toBe(s.lanes);
    expect(r.song.global).toBe(s.global);
    expect(r.cut).toEqual({ notes: 0, effects: 0, placements: 0, shortened: 0 });
    expect(compile(r.song).ok).toBe(true);
  });

  it('cuts what starts past a new end, and shortens notes and placements that run past it, so it compiles', () => {
    const s = song();
    const r = ok(setRange(s, 32));
    expect(r.song.length).toBe(32);
    expect(r.song.lanes.pulse1).toEqual([
      { row: 0, len: 4, note: 'C5', inst: 1 },
      { row: 28, len: 4, note: 'D5', inst: 1 }, // its cut within its last row goes with the row
      { row: 30, fx: { vibrato: [4, 2] } },
    ]);
    expect(r.song.lanes.pulse1[0]).toBe(s.lanes.pulse1[0]); // untouched items keep their identity
    expect(r.song.lanes.pulse2).toEqual([
      { row: 0, pattern: 'riff', repeat: 2 },
      { row: 24, pattern: 'riff' }, // 8 rows: a whole repeat, so no len
    ]);
    expect(r.song.global).toEqual([{ row: 0, tempo: 6 }]);
    expect(r.cut).toEqual({ notes: 1, effects: 3, placements: 1, shortened: 2 });
    expect(r.loopReset).toBe(false);
    expect(compile(r.song)).toMatchObject({ ok: true });
  });

  it('cuts a placement short with len where the end falls inside a repeat', () => {
    const r = ok(setRange(song(), 36));
    expect(r.song.lanes.pulse2[1]).toEqual({ row: 24, pattern: 'riff', repeat: 2, len: 12 });
    expect(compile(r.song).ok).toBe(true);
  });

  it('takes the loop back to the start when the new end is at or before it, unless given one', () => {
    const r = ok(setRange(song(), 16));
    expect(r.song.loop).toBe(0);
    expect(r.loopReset).toBe(true);
    expect(ok(setRange(song(), 16, 8)).song.loop).toBe(8);
    expect(setRange(song(), 16, 16)).toBe('loop (16) must be less than length (16)');
  });

  it('sets the loop on its own', () => {
    const s = song();
    const r = ok(setRange(s, 64, 32));
    expect(r.song).toMatchObject({ length: 64, loop: 32 });
    expect(r.song.lanes).toBe(s.lanes);
    expect(ok(setRange(s, 64, 16)).song).toBe(s); // no change
  });

  it("refuses what the compiler would: a loop off the groove's phase, or more orders than the driver has", () => {
    const swing = song({ groove: [5, 5, 5, 7] });
    expect(setRange(swing, 64, 6)).toBe(
      "loop (6) must be a multiple of 4 when the groove isn't uniform, so the groove keeps its phase",
    );
    expect(ok(setRange(swing, 64, 8)).song.loop).toBe(8);
    expect(setRange(song({ loop: 0 }), 127 * 64 + 1)).toBe('the song needs 128 orders of 64 rows, but the driver allows 127');
    expect(ok(setRange(song({ loop: 0 }), 127 * 64)).song.length).toBe(127 * 64);
    expect(setRange(song(), 0)).toBe('the length is a whole number of rows, 1 or more');
    expect(setRange(song(), 2.5)).toBe('the length is a whole number of rows, 1 or more');
    expect(setRange(song(), 64, -1)).toBe('the loop is a whole number of rows, 0 or more');
  });

  it("makes a change that leaves the loop's jump no free slot, as other edits may break the compile, and the error says so", () => {
    const busy = { row: 31, fx: { volume: 8 } };
    const s = song({ loop: 0, patterns: [], lanes: { pulse1: [busy], pulse2: [busy], wave: [busy], noise: [busy] }, global: [] });
    expect(compile(s).ok).toBe(true);
    const shorter = ok(setRange(s, 32)).song; // the jump back to row 0 goes on row 31
    expect(compile(shorter)).toMatchObject({ ok: false, errors: [{ lane: 'global', row: 31, message: expect.stringMatching(/the jump/) }] });
  });

  it('says what a cut took', () => {
    expect(describeCut({ notes: 3, effects: 1, placements: 0, shortened: 0 })).toBe('3 notes and an effect cut');
    expect(describeCut({ notes: 1, effects: 2, placements: 1, shortened: 2 })).toBe(
      'a note, 2 effects and a placed pattern cut, 2 shortened to end there',
    );
    expect(describeCut({ notes: 0, effects: 0, placements: 0, shortened: 1 })).toBe('1 shortened to end there');
    expect(describeCut({ notes: 0, effects: 0, placements: 0, shortened: 0 })).toBe('');
  });
});
